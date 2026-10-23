/* Files: the upload pipeline and attachment rendering.

   Why uploads were slow before, and what this does instead:
   - Files only started uploading after the message was sent, one at a time.
     Here a file starts uploading the moment it is picked, pasted or dropped,
     up to 3 at once, so by the time you hit Enter it is usually done.
   - Phone photos went up at full size (4-12 MB). Large JPEG/PNG/WebP images
     are resized to 2560 px and re-encoded (WebP, quality .86) in the browser,
     typically 5-10x smaller with no visible difference. GIFs and small images
     are sent untouched. "Send original" in the tray skips this.
   - Image dimensions are stored with the attachment, so the chat reserves
     the right space and doesn't jump when the picture loads.
   - The storage endpoint is woken up when you start composing (it cold-starts
     in ~2 s on Wasmer). */
(function () {
  const { esc, fmt } = NX;
  const MAX_MB = (window.NEXCHAT_CONFIG?.CHAT_MAX_MB) || 250;
  const COMPRESS_OVER = 1.2 * 1024 * 1024;
  const MAX_DIM = 2560;

  const extOf = (n) => (String(n || '').split('?')[0].split('.').pop() || '').toLowerCase();
  const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'apng', 'tif', 'tiff', 'heic', 'heif', 'jfif'];
  const VID = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv'];
  const AUD = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'aac', 'flac', 'm4a', 'weba'];
  const TEXT = ['txt', 'md', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'py', 'rb', 'php', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'sql', 'lua', 'r', 'pl', 'dart', 'scala', 'env', 'gitignore', 'dockerfile', 'makefile', 'vue', 'svelte'];
  function kindOf(name, mime) {
    const e = extOf(name);
    mime = mime || '';
    if (e === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (IMG.includes(e) || /^image\//.test(mime)) return 'image';
    if (VID.includes(e) || /^video\//.test(mime)) return 'video';
    if (AUD.includes(e) || /^audio\//.test(mime)) return 'audio';
    if (TEXT.includes(e) || /^text\//.test(mime)) return 'text';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(e)) return 'zip';
    return 'file';
  }
  const browserImage = (name, mime) => kindOf(name, mime) === 'image' && !['tif', 'tiff', 'heic', 'heif'].includes(extOf(name));

  /* ---------- preparing a file ---------- */
  async function imageSize(blob) {
    try {
      if (window.createImageBitmap) {
        const bmp = await createImageBitmap(blob);
        const out = { width: bmp.width, height: bmp.height, bmp };
        return out;
      }
    } catch {}
    return new Promise((ok) => {
      const url = URL.createObjectURL(blob);
      const im = new Image();
      im.onload = () => { ok({ width: im.naturalWidth, height: im.naturalHeight, img: im }); URL.revokeObjectURL(url); };
      im.onerror = () => { ok(null); URL.revokeObjectURL(url); };
      im.src = url;
    });
  }
  function encode(canvas, type, q) {
    return new Promise((ok) => canvas.toBlob((b) => ok(b), type, q));
  }
  function renameExt(name, ext) {
    const base = String(name || 'image').replace(/\.[^.]+$/, '');
    return `${base}.${ext}`;
  }
  /* Returns { file, width, height, compressed }. */
  async function prepare(file, { original = false, max = MAX_DIM, force = false } = {}) {
    if (window.Tiff?.isTiff(file.name)) {
      try { file = await window.Tiff.toPngFile(file); } catch {}
    }
    if (!browserImage(file.name, file.type)) return { file };
    const isGif = /gif$/i.test(file.type) || extOf(file.name) === 'gif';
    const isSvg = /svg/i.test(file.type) || extOf(file.name) === 'svg';
    const info = isSvg ? null : await imageSize(file);
    if (!info) return { file };
    const { width, height } = info;
    const big = Math.max(width, height) > max;
    if (original || isGif || isSvg || (!force && file.size < COMPRESS_OVER && !big)) {
      info.bmp?.close?.();
      return { file, width, height };
    }
    try {
      const scale = Math.min(1, max / Math.max(width, height));
      const w = Math.round(width * scale), h = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(info.bmp || info.img, 0, 0, w, h);
      info.bmp?.close?.();
      let blob = await encode(canvas, 'image/webp', 0.86);
      let ext = 'webp';
      if (!blob || blob.type !== 'image/webp') { blob = await encode(canvas, 'image/jpeg', 0.88); ext = 'jpg'; }
      if (!blob || (blob.size >= file.size && !big)) return { file, width, height };
      const out = new File([blob], renameExt(file.name, ext), { type: blob.type, lastModified: Date.now() });
      return { file: out, width: w, height: h, compressed: true };
    } catch {
      return { file, width, height };
    }
  }

  function safeName(n) {
    const clean = String(n || 'file').normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').slice(-120);
    return clean || 'file';
  }

  /* ---------- the transfer itself ---------- */
  async function put(path, file, { onProgress, signal } = {}) {
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${safeName(file.name)}`;
    if (window.CloudGate?.enabled()) {
      const up = await window.CloudGate.upload(window.CloudGate.join('attachments', path), name, file, { onProgress, signal });
      return { url: up.url, key: up.key, size: file.size, type: file.type || up.type || window.Store?.mimeOf(file.name) };
    }
    if (window.Store) {
      const up = await window.Store.put(`nexchat/${path}/${name}`, file, (p) => onProgress?.(p / 100));
      return { url: up.url, key: up.key, size: file.size, type: up.type };
    }
    throw new Error('Storage is not configured.');
  }

  /* ---------- upload jobs (composer tray) ---------- */
  const MAX_PARALLEL = 4;
  let running = 0;
  const queue = [];
  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      if (job.state === 'cancelled') continue;
      running++;
      job._run().finally(() => { running--; pump(); });
    }
  }

  /* A job prepares and uploads one file in the background.
     job.state: preparing | queued | uploading | done | error | cancelled */
  class Job {
    constructor(file, path, opts = {}) {
      this.id = NX.uid();
      this.original = file;
      this.file = file;
      this.path = path;
      this.opts = opts;
      this.progress = 0;
      this.state = 'preparing';
      this.spoiler = false;
      this.listeners = new Set();
      this.ctrl = new AbortController();
      this.preview = browserImage(file.name, file.type) || kindOf(file.name, file.type) === 'video' ? URL.createObjectURL(file) : null;
      this.done = new Promise((ok, no) => { this._ok = ok; this._no = no; });
      this.done.catch(() => {});
      this.start();
    }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit() { this.listeners.forEach((f) => f(this)); }
    async start() {
      this.width = this.original.nxDurationMs || null;   // voice messages: their length
      try {
        const p = await prepare(this.original, { original: !!this.opts.original });
        if (this.state === 'cancelled') return;
        this.file = p.file; this.width = p.width || this.width; this.height = p.height; this.compressed = !!p.compressed;
      } catch { /* upload as-is */ }
      this.state = 'queued'; this.emit();
      queue.push(this); pump();
    }
    async _run() {
      if (this.state === 'cancelled') return;
      this.state = 'uploading'; this.emit();
      try {
        const out = await put(this.path, this.file, {
          signal: this.ctrl.signal,
          onProgress: NX.throttle((f) => { this.progress = Math.min(0.99, f); this.emit(); }, 120),
        });
        this.result = { ...out, width: this.width || null, height: this.height || null, name: this.file.name, mime: this.file.type || out.type };
        this.progress = 1; this.state = 'done'; this.emit();
        this._ok(this.result);
      } catch (e) {
        if (this.state === 'cancelled') return;
        this.state = 'error'; this.error = e.name === 'AbortError' ? 'Cancelled' : (e.message || 'Upload failed'); this.emit();
        this._no(e);
      }
    }
    retry() {
      if (this.state !== 'error') return;
      this.ctrl = new AbortController();
      this.done = new Promise((ok, no) => { this._ok = ok; this._no = no; });
      this.done.catch(() => {});
      this.progress = 0; this.state = 'queued'; this.error = null; this.emit();
      queue.push(this); pump();
    }
    cancel() {
      const was = this.state;
      this.state = 'cancelled';
      try { this.ctrl.abort(); } catch {}
      if (this.preview) setTimeout(() => URL.revokeObjectURL(this.preview), 30000);
      // An upload that already finished leaves an orphan; clean it up.
      if (was === 'done' && this.result?.url) window.Store?.del(this.result.url).catch(() => {});
      this._no(new DOMException('Cancelled', 'AbortError'));
      this.emit();
    }
  }
  function startUpload(file, path, opts) {
    window.CloudGate?.warm?.();
    return new Job(file, path, opts);
  }

  /* Avatars, icons, banners: one image, resized, uploaded, URL back. */
  async function uploadImage(file, path, { max = 1024 } = {}) {
    if (!/^image\//.test(file.type) && !window.Tiff?.isTiff(file.name)) throw new Error('That isn’t an image.');
    const p = await prepare(file, { max, force: !/gif/i.test(file.type) });
    return put(path, p.file);
  }

  /* ---------- attachment URLs ----------
     A stored URL is whatever the sender wrote, so only http(s) (and our own
     blob: previews) is ever rendered, fetched or opened. */
  function safeUrl(u, { blob = false } = {}) {
    try {
      const x = new URL(String(u || ''), location.href);
      if (x.protocol === 'https:' || x.protocol === 'http:') return x.href;
      if (blob && x.protocol === 'blob:') return x.href;
    } catch {}
    return null;
  }
  const managed = (url) => !!window.Store?.isManaged(url);
  async function resolved(url) {
    const u = managed(url) ? await window.Store.sign(url) : url;
    const ok = safeUrl(u, { blob: true });
    if (!ok) throw new Error('That link isn\u2019t allowed.');
    return ok;
  }
  async function download(url, name) {
    try {
      const u = await resolved(url);
      const r = await fetch(u);
      if (!r.ok) throw new Error();
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name || 'download';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 20000);
    } catch {
      const u = await resolved(url).catch(() => null);
      if (u) window.open(u, '_blank', 'noopener');
      else NX.toast('That file can\u2019t be opened.', { err: true });
    }
  }

  /* ---------- rendering ---------- */
  const ICONS = { pdf: 'fa-file-pdf', zip: 'fa-file-zipper', text: 'fa-file-code', audio: 'fa-file-audio', video: 'fa-file-video', image: 'fa-file-image', file: 'fa-file' };
  const fmtTime = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
  const fmtLen = (s) => fmtTime(Math.ceil(s));   // a length never reads 0:00

  // A sized box for a single image so the list never jumps when it loads.
  function fitBox(w, h, maxW = 520, maxH = 360) {
    if (!w || !h) return '';
    const s = Math.min(1, maxW / w, maxH / h);
    return `width:${Math.max(40, Math.round(w * s))}px;aspect-ratio:${w} / ${h};`;
  }

  function imgTag(a, cls = '') {
    const src = managed(a.url) ? `data-nx-src="${esc(a.url)}"` : `src="${esc(a.url)}"`;
    return `<img ${src} class="${cls}" alt="${esc(a.file_name)}" loading="lazy" decoding="async"${a.width ? ` width="${a.width}" height="${a.height}"` : ''}>`;
  }

  /* Renders a message's attachments into `host`.
     opts: { canRemove, onRemove(att), table } */
  function renderAll(host, atts, opts = {}) {
    host.innerHTML = '';
    if (!atts?.length) return;
    atts = atts.map((a) => (a._local || safeUrl(a.url) ? a : { ...a, url: '', _bad: true }));
    const media = atts.filter((a) => kindOf(a.file_name, a.mime_type) === 'image' || (a._local && kindOf(a.file_name, a.mime_type) === 'video'));
    const rest = atts.filter((a) => !media.includes(a));
    if (media.length) {
      const n = media.length;
      const grid = document.createElement('div');
      grid.className = 'att-grid ' + (n === 1 ? 'n1' : n === 2 ? 'n2' : n === 3 ? 'n3' : n === 4 ? 'n4' : 'many');
      media.forEach((a, i) => {
        const cell = document.createElement('div');
        cell.className = 'att-media' + (a._local ? ' loading' : '');
        if (n === 1) cell.style.cssText = fitBox(a.width, a.height);
        if (a._local) {
          const pct = Math.round((a._progress || 0) * 100);
          // No bytes on the wire yet (optimizing, queued, warming the endpoint):
          // a sweeping ring, not a frozen empty one. Once uploading, the ring
          // fills to the real percentage and animates smoothly between updates.
          const warming = a._state === 'preparing' || a._state === 'queued' || pct <= 0;
          cell.innerHTML = (kindOf(a.file_name) === 'video' ? `<video class="thumb" src="${esc(a.url)}" muted playsinline></video>` : `<img src="${esc(a.url)}" alt="">`)
            + `<div class="up-over"><div class="up-ring${warming ? ' warming' : ''}" data-up="${esc(a.id)}" style="--p:${pct}">`
            + `<span class="up-pct">${warming ? (a._state === 'preparing' ? '<i class="fa-solid fa-wand-magic-sparkles"></i>' : '') : pct + '%'}</span></div></div>`;
        } else {
          cell.innerHTML = imgTag(a) + (extOf(a.file_name) === 'gif' ? '<span class="gif-tag">GIF</span>' : '')
            + (opts.canRemove ? '<button class="att-x" title="Delete file"><i class="fa-solid fa-xmark"></i></button>' : '');
          const im = cell.querySelector('img');
          if (window.Tiff?.isTiff(a.file_name)) resolved(a.url).then((u) => window.Tiff.hydrate(im, u)).catch(() => {});
          im.addEventListener('error', () => { cell.classList.add('broken'); cell.innerHTML = `<div class="att-file" style="border:0"><div class="af-ico"><i class="fa-solid fa-image"></i></div><div class="af-mid"><b>${esc(a.file_name)}</b><small>Couldn’t load this image</small></div></div>`; }, { once: true });
          cell.addEventListener('click', (e) => {
            if (e.target.closest('.att-x')) { e.stopPropagation(); removeAtt(a, opts); return; }
            lightbox(media.filter((x) => !x._local), media.indexOf(a));
          });
        }
        grid.appendChild(cell);
      });
      host.appendChild(grid);
    }
    rest.forEach((a) => host.appendChild(renderOne(a, opts)));
  }

  function renderOne(a, opts) {
    const kind = kindOf(a.file_name, a.mime_type);
    const wrap = document.createElement('div');
    wrap.className = 'att-wrap';
    if (a._local) {
      wrap.innerHTML = `<div class="att-file"><div class="af-ico"><i class="fa-solid ${ICONS[kind] || ICONS.file}"></i></div>
        <div class="af-mid"><b>${esc(a.file_name)}</b><small>Uploading… ${Math.round((a._progress || 0) * 100)}%</small></div><span class="bar" style="width:${Math.round((a._progress || 0) * 100)}%"></span></div>`;
      return wrap;
    }
    if (kind === 'video') {
      wrap.innerHTML = `<div class="att-video"><video controls preload="metadata" playsinline></video></div>`;
      const v = wrap.querySelector('video');
      resolved(a.url).then((u) => { v.src = u; }).catch(() => {});
      v.addEventListener('play', () => document.querySelectorAll('audio, video').forEach((o) => { if (o !== v && !o.closest('.vtile')) o.pause(); }));
    } else if (kind === 'audio') {
      wrap.appendChild(audioPlayer(a));
    } else {
      const canPreview = kind === 'pdf' || (kind === 'text' && (a.file_size || 0) < 400 * 1024);
      wrap.innerHTML = `<div class="att-file">
        <div class="af-ico ${kind}"><i class="fa-solid ${ICONS[kind] || ICONS.file}"></i></div>
        <div class="af-mid"><b title="${esc(a.file_name)}">${esc(a.file_name)}</b><small>${fmt.bytes(a.file_size)}</small></div>
        <div class="af-acts">
          ${canPreview ? '<button class="icon-btn sm" data-a="view" title="Preview"><i class="fa-solid fa-eye"></i></button>' : ''}
          <button class="icon-btn sm" data-a="dl" title="Download"><i class="fa-solid fa-download"></i></button>
        </div></div>`;
      wrap.querySelector('[data-a="dl"]').onclick = () => download(a.url, a.file_name);
      wrap.querySelector('[data-a="view"]')?.addEventListener('click', (e) => togglePreview(wrap, a, kind, e.currentTarget));
    }
    if (opts.canRemove) {
      const x = NX.h('<button class="att-x" title="Delete file"><i class="fa-solid fa-xmark"></i></button>');
      x.onclick = (e) => { e.stopPropagation(); removeAtt(a, opts); };
      wrap.appendChild(x);
    }
    return wrap;
  }

  async function removeAtt(a, opts) {
    if (!await NX.confirm({ title: 'Delete file?', body: `"${a.file_name}" will be removed from the message for everyone.`, danger: true })) return;
    const { data, error } = await window.db.from(opts.table || 'message_attachments').delete().eq('id', a.id).select('id');
    if (error || !data?.length) return NX.fail(error || { message: 'You don\u2019t have permission to delete that file.' });
    window.Store?.del(a.url).catch(() => {});   // only once the row is really gone
    opts.onRemove?.(a);
  }

  const players = new Set();
  function audioPlayer(a) {
    // Length known up front for voice messages (stored as the width, see Job)
    const saved = /^audio\//.test(a.mime_type || '') && a.width > 0 && !a.height ? a.width / 1000 : null;
    const el = NX.h(`<div class="aplayer">
      <button class="ap-play" title="Play"><i class="fa-solid fa-play"></i></button>
      <div class="ap-mid"><div class="ap-name">${esc(a.file_name)}</div>
        <div class="ap-seek"><div class="trk"><div class="fill"></div></div><input type="range" min="0" max="1000" value="0" aria-label="Seek"></div>
        <div class="ap-times"><span class="cur">0:00</span><span class="dur">${saved ? fmtLen(saved) : a.file_size ? fmt.bytes(a.file_size) : ''}</span></div></div>
      <button class="rate" title="Speed">1×</button>
      <button class="icon-btn" data-a="dl" title="Download"><i class="fa-solid fa-download"></i></button>
    </div>`);
    const au = new Audio();
    au.preload = 'none';
    const play = el.querySelector('.ap-play'), seek = el.querySelector('input'), fill = el.querySelector('.fill');
    const durEl = el.querySelector('.dur'), curEl = el.querySelector('.cur');
    let src = null, measuring = false;
    const dur = () => (Number.isFinite(au.duration) && au.duration > 0 ? au.duration : saved);
    const paint = () => {
      const d = dur();
      if (d) durEl.textContent = fmtLen(d);
      if (measuring) return;
      const p = d ? Math.min(1, au.currentTime / d) : 0;
      seek.value = Math.round(p * 1000); fill.style.width = (p * 100) + '%';
      curEl.textContent = fmtTime(au.currentTime);
    };
    // Recorded WebM files carry no length, so the browser reports Infinity
    // until it has seen the end: jump far past the end once, then come back.
    async function measure() {
      await new Promise((ok) => { if (au.readyState >= 1) ok(); else au.addEventListener('loadedmetadata', ok, { once: true }); });
      if (Number.isFinite(au.duration) && au.duration > 0) return;
      measuring = true;
      await new Promise((ok) => {
        const done = () => { au.removeEventListener('durationchange', check); clearTimeout(t); ok(); };
        const check = () => { if (Number.isFinite(au.duration) && au.duration > 0) done(); };
        const t = setTimeout(done, 4000);
        au.addEventListener('durationchange', check);
        au.currentTime = 1e101;
      });
      au.currentTime = 0;
      measuring = false;
    }
    play.onclick = async () => {
      if (!src) {
        play.classList.add('busy');
        src = await resolved(a.url).catch(() => a.url);
        au.preload = 'auto'; au.src = src;
        await measure().catch(() => {});
        play.classList.remove('busy');
        paint();
      }
      document.querySelectorAll('audio, video').forEach((o) => { if (o !== au && !o.closest('.vtile')) o.pause(); });
      players.forEach((p) => { if (p.au !== au) p.au.pause(); });
      au.paused ? au.play().catch(() => NX.toast('Couldn’t play that file.', { err: true })) : au.pause();
    };
    // Players that left the page are dropped (and stopped) on the next render.
    for (const p of [...players]) if (!p.el.isConnected) { p.au.pause(); players.delete(p); }
    players.add({ au, el });
    au.onplay = () => { play.innerHTML = '<i class="fa-solid fa-pause"></i>'; };
    au.onpause = () => { play.innerHTML = '<i class="fa-solid fa-play"></i>'; };
    au.onended = () => { play.innerHTML = '<i class="fa-solid fa-play"></i>'; au.currentTime = 0; paint(); };
    au.onloadedmetadata = au.ondurationchange = au.ontimeupdate = paint;
    seek.oninput = () => { const d = dur(); if (d && src) au.currentTime = (seek.value / 1000) * d; };
    const rates = [1, 1.25, 1.5, 2, 0.75]; let ri = 0;
    el.querySelector('.rate').onclick = (e) => { ri = (ri + 1) % rates.length; au.playbackRate = rates[ri]; e.currentTarget.textContent = rates[ri] + '×'; };
    el.querySelector('[data-a="dl"]').onclick = () => download(a.url, a.file_name);
    return el;
  }

  /* Inline preview for text files and PDFs, loaded only when asked for. */
  // pdf.js 4.x (ESM). Older 3.x builds run attacker-controlled font code
  // (CVE-2024-4367); eval is also switched off when a document is opened.
  let pdfReady = null;
  function loadPdf() {
    if (pdfReady) return pdfReady;
    const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38';
    pdfReady = import(CDN + '/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = CDN + '/pdf.worker.min.mjs';
      return lib;
    }).catch(() => { pdfReady = null; throw new Error('Could not load the PDF viewer.'); });
    return pdfReady;
  }
  async function togglePreview(wrap, a, kind, btn) {
    const old = wrap.querySelector('.att-embed');
    if (old) { old.remove(); btn.innerHTML = '<i class="fa-solid fa-eye"></i>'; return; }
    btn.innerHTML = '<i class="fa-solid fa-eye-slash"></i>';
    const box = NX.h(`<div class="att-embed" style="margin-top:6px"><div class="ae-body"><div style="padding:20px;text-align:center"><span class="spinner"></span></div></div></div>`);
    wrap.appendChild(box);
    const body = box.querySelector('.ae-body');
    try {
      const url = await resolved(a.url);
      if (kind === 'text') {
        const r = await fetch(url);
        if (!r.ok) throw new Error('Could not load this file.');
        const t = await r.text();
        body.innerHTML = `<pre>${esc(t.slice(0, 200000))}</pre>`;
      } else {
        const pdfjs = await loadPdf();
        const doc = await pdfjs.getDocument({ url, isEvalSupported: false, enableXfa: false }).promise;
        body.innerHTML = '';
        const width = Math.min(540, wrap.clientWidth - 4);
        for (let i = 1; i <= Math.min(doc.numPages, 30); i++) {
          const page = await doc.getPage(i);
          const vp0 = page.getViewport({ scale: 1 });
          const dpr = window.devicePixelRatio || 1;
          const vp = page.getViewport({ scale: (width / vp0.width) * dpr });
          const c = document.createElement('canvas');
          c.width = vp.width; c.height = vp.height; c.style.width = width + 'px';
          c.style.borderBottom = '1px solid var(--line)';
          body.appendChild(c);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
          if (!box.isConnected) return;
        }
        if (doc.numPages > 30) body.insertAdjacentHTML('beforeend', `<p style="padding:10px;color:var(--txt-3);font-size:13px">Showing the first 30 of ${doc.numPages} pages. Download to see the rest.</p>`);
      }
    } catch (e) {
      body.innerHTML = `<p style="padding:14px;color:#ff8a8e;font-size:13px">${esc(e.message || 'Could not preview this file.')}</p>`;
    }
  }

  /* ---------- lightbox (images, with arrows between a message's images) ---------- */
  function lightbox(list, index = 0) {
    if (!list.length) return;
    let i = Math.max(0, Math.min(index, list.length - 1));
    const el = NX.h(`<div class="lightbox" role="dialog" aria-modal="true">
      <div class="lb-stage"><img alt=""></div>
      ${list.length > 1 ? '<button class="lb-nav lb-prev" aria-label="Previous"><i class="fa-solid fa-chevron-left"></i></button><button class="lb-nav lb-next" aria-label="Next"><i class="fa-solid fa-chevron-right"></i></button>' : ''}
      <div class="lb-bar"><span class="grow"></span><span class="n"></span>
        <button class="btn btn-ghost btn-sm" data-a="open"><i class="fa-solid fa-arrow-up-right-from-square"></i>Open</button>
        <button class="btn btn-ghost btn-sm" data-a="dl"><i class="fa-solid fa-download"></i>Download</button>
        <button class="icon-btn" data-a="x" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div></div>`);
    const img = el.querySelector('img');
    const show = () => {
      const a = list[i];
      img.removeAttribute('src');
      resolved(a.url).then((u) => { if (list[i] === a) { img.src = u; if (window.Tiff?.isTiff(a.file_name)) window.Tiff.hydrate(img, u); } });
      el.querySelector('.grow').textContent = `${a.file_name}${a.file_size ? ' · ' + fmt.bytes(a.file_size) : ''}`;
      el.querySelector('.n').textContent = list.length > 1 ? `${i + 1} / ${list.length}` : '';
    };
    const close = () => { el.remove(); document.removeEventListener('keydown', key, true); };
    const step = (d) => { i = (i + d + list.length) % list.length; show(); };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'x') return close();
      if (a === 'dl') return download(list[i].url, list[i].file_name);
      if (a === 'open') return resolved(list[i].url).then((u) => window.open(u, '_blank', 'noopener'), () => NX.toast('That file can\u2019t be opened.', { err: true }));
      if (e.target.closest('.lb-prev')) return step(-1);
      if (e.target.closest('.lb-next')) return step(1);
      if (e.target.classList.contains('lb-stage')) close();
    });
    // swipe on touch
    let sx = null;
    el.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); sx = null; });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(el);
    show();
  }

  // Update the upload rings in place (so the conic fill glides smoothly)
  // without rebuilding the DOM. Returns false if a full repaint is needed —
  // a ring went missing, or a state crossed into/out of the warming phase.
  function updateProgress(host, atts) {
    if (!host) return false;
    let ok = true;
    (atts || []).forEach((a) => {
      if (!a || !a._local) return;
      const ring = host.querySelector(`.up-ring[data-up="${(window.CSS && CSS.escape) ? CSS.escape(a.id) : a.id}"]`);
      if (!ring) { ok = false; return; }
      const pct = Math.round((a._progress || 0) * 100);
      const warming = a._state === 'preparing' || a._state === 'queued' || pct <= 0;
      if (ring.classList.contains('warming') !== warming) { ok = false; return; }
      ring.style.setProperty('--p', pct);
      if (!warming) { const t = ring.querySelector('.up-pct'); if (t) t.textContent = pct + '%'; }
    });
    return ok;
  }

  NX.files = { safeUrl, MAX_MB, kindOf, extOf, prepare, put, startUpload, uploadImage, renderAll, updateProgress, lightbox, download, resolved, fitBox, browserImage };
})();
