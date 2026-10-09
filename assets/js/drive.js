/* My Drive: each user's private, encrypted file manager (Settings -> My Drive).

   Feature set follows cloudgate-wasmer's web UI -- browse with breadcrumbs,
   folders, multi-file and folder upload (multipart for big files) with
   progress and cancel, download, rename, delete, preview (images, video,
   audio, PDF, text), a code editor, search, type views, usage, links -- on
   top of Vault (vault.js): everything is encrypted in the browser, names
   included, before it is uploaded to  nexchats-us1/vault/<user id>/.      */
window.Drive = (function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const GB = 1024 ** 3;
  const CFG = () => window.NEXCHAT_CONFIG?.CLOUDGATE || {};
  const MAX_FILE = (CFG().driveMaxFileGB || 5) * GB;
  // Each user's own quota (profiles.drive_quota_gb, set by staff), falling back
  // to the site default while that column is not there yet.
  const quotaGB = () => Number(me?.drive_quota_gb) || CFG().driveQuotaGB || 5;
  const quotaBytes = () => quotaGB() * GB;

  let me = null, K = null, host = null, mounted = false;
  let path = [];                     // [{ enc, name }]
  let listing = { folders: [], files: [] };
  let view = store.get('nx_drive_view', 'grid'), sort = store.get('nx_drive_sort', 'name');
  let mode = 'files';                // files | recent | image | video | audio | doc | other
  let query = '';
  let index = null, indexP = null;   // every file in the drive, for search/types/usage
  let indexBytes = 0, addedBytes = 0; // bytes in the index, plus uploads finished since it was built
  let storeReq = null;               // latest storage request from this user, if loaded
  const sel = new Set();
  const thumbs = new Map();          // key -> object URL

  /* ---------------- helpers ---------------- */
  const root = () => `vault/${me.id}`;
  const dirOf = (segs) => [root(), ...segs.map((s) => s.enc)].join('/');
  const ext = (n) => (String(n).includes('.') ? String(n).split('.').pop().toLowerCase() : '');
  const KINDS = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'],
    video: ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv'],
    audio: ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac', 'weba'],
    pdf: ['pdf'],
    text: ['txt', 'md', 'markdown', 'json', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'html', 'htm', 'xml', 'csv', 'tsv', 'yml', 'yaml',
      'py', 'rb', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rs', 'go', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'ini', 'toml', 'cfg', 'conf',
      'env', 'log', 'sql', 'lua', 'swift', 'dart', 'vue', 'svelte', 'gitignore'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
  };
  function kindOf(name) {
    const e = ext(name);
    for (const [k, list] of Object.entries(KINDS)) if (list.includes(e)) return k;
    return 'other';
  }
  const group = (name) => ({ image: 'image', video: 'video', audio: 'audio', pdf: 'doc', text: 'doc' }[kindOf(name)] || 'other');
  const ICON = { image: 'fa-image', video: 'fa-film', audio: 'fa-music', pdf: 'fa-file-pdf', text: 'fa-file-code', archive: 'fa-file-zipper', other: 'fa-file', locked: 'fa-lock' };
  const TINT = { image: '#4F9DFF', video: '#F2555A', audio: '#3DDC97', pdf: '#FF7A59', text: '#F5B94A', archive: '#A78BFA', other: '#94A3B8', locked: '#64748B' };
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', mkv: 'video/x-matroska', ogv: 'video/ogg',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/opus', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', weba: 'audio/webm',
    pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', css: 'text/css', js: 'text/javascript' };
  const mimeOf = (n) => MIME[ext(n)] || window.Store?.mimeOf?.(n) || 'application/octet-stream';
  function fmt(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? (n / 1024 ** i < 10 ? 1 : 0) : 0)} ${u[i]}`;
  }
  const when = (d) => {
    const t = new Date(d), now = Date.now(), s = (now - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return t.toLocaleDateString([], { month: 'short', day: 'numeric', year: t.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  };
  const toast = (m, bad) => window.UI?.toast(m, bad);
  const badName = (n) => !n || /[/\\]/.test(n) || n === '.' || n === '..' || n.length > 180;

  /* ---------------- data ---------------- */
  async function decodeListing(raw) {
    const folders = await Promise.all((raw.folders || []).map(async (enc) => ({ enc, name: await Vault.decName(K, enc) })));
    const files = await Promise.all((raw.files || []).map(async (f) => {
      const name = await Vault.decName(K, f.filename);
      return { key: f.key, enc: f.filename, name, locked: !name, size: Vault.plainSize(f.size), stored: f.size, modified: f.last_modified };
    }));
    return { folders, files };
  }

  async function load() {
    const at = path.slice();
    const out = await decodeListing(await CloudGate.browse(dirOf(at)));
    if (at.length !== path.length || at.some((s, i) => s.enc !== path[i].enc)) return; // navigated away meanwhile
    listing = out;
  }

  // Walks the whole drive (breadth-first, a few folders at a time).
  function buildIndex(force) {
    if (index && !force) return Promise.resolve(index);
    if (indexP && !force) return indexP;
    indexP = (async () => {
      const all = [], queue = [[]];
      const work = async () => {
        while (queue.length) {
          const segs = queue.shift();
          const { folders, files } = await decodeListing(await CloudGate.browse(dirOf(segs)));
          folders.forEach((f) => queue.push([...segs, f]));
          files.forEach((f) => all.push({ ...f, segs }));
        }
      };
      await Promise.all([work(), work(), work()]);
      // a worker can idle while another is still discovering folders
      while (queue.length) await work();
      index = all;
      indexBytes = all.reduce((a, f) => a + f.stored, 0); addedBytes = 0;
      indexP = null;
      paintUsage();
      return all;
    })();
    indexP.catch(() => { indexP = null; });
    return indexP;
  }
  const dirty = () => { index = null; };
  // Bytes this drive holds right now, or null while the index is still loading.
  const usedBytes = () => (index ? indexBytes + addedBytes : null);

  /* ---------------- shell ---------------- */
  function shell() {
    host.innerHTML = `
    <div class="drv" id="drv">
      <aside class="drv-side">
        <div class="drv-brand">
          <span class="drv-logo"><i class="fa-solid fa-hard-drive"></i></span>
          <div><b>My Drive</b><small><i class="fa-solid fa-lock"></i> Encrypted on your device</small></div>
        </div>
        <div class="drv-newwrap">
          <button class="drv-new" id="dNew"><i class="fa-solid fa-plus"></i><span>New</span></button>
          <div class="drv-menu hidden" id="dNewMenu">
            <button data-a="upload"><i class="fa-solid fa-file-arrow-up"></i> Upload files</button>
            <button data-a="uploadDir"><i class="fa-solid fa-folder-plus"></i> Upload folder</button>
            <hr>
            <button data-a="folder"><i class="fa-solid fa-folder"></i> New folder</button>
            <button data-a="text"><i class="fa-solid fa-file-pen"></i> New text file</button>
          </div>
        </div>
        <nav class="drv-nav" id="dNav">
          <button data-m="files" class="on"><i class="fa-solid fa-folder-tree"></i><span>My files</span></button>
          <button data-m="recent"><i class="fa-regular fa-clock"></i><span>Recent</span></button>
          <div class="drv-sep">Types</div>
          <button data-m="image"><i class="fa-solid fa-image" style="color:${TINT.image}"></i><span>Photos</span><em></em></button>
          <button data-m="video"><i class="fa-solid fa-film" style="color:${TINT.video}"></i><span>Videos</span><em></em></button>
          <button data-m="audio"><i class="fa-solid fa-music" style="color:${TINT.audio}"></i><span>Music</span><em></em></button>
          <button data-m="doc"><i class="fa-solid fa-file-lines" style="color:${TINT.text}"></i><span>Documents</span><em></em></button>
          <button data-m="other"><i class="fa-solid fa-shapes" style="color:${TINT.other}"></i><span>Other</span><em></em></button>
        </nav>
        <div class="drv-usage" id="dUsage">
          <div class="du-bar"><i style="width:0"></i></div>
          <small>Calculating usage…</small>
          <button class="drv-more-btn" id="dAsk"><i class="fa-solid fa-circle-up"></i> <span>Request more storage</span></button>
        </div>
      </aside>

      <section class="drv-main" id="dMain">
        <header class="drv-top">
          <div class="drv-crumbs" id="dCrumbs"></div>
          <div class="drv-tools">
            <label class="drv-search"><i class="fa-solid fa-magnifying-glass"></i><input id="dSearch" placeholder="Search your drive" autocomplete="off"><kbd>/</kbd></label>
            <select id="dSort" class="drv-sel" title="Sort">
              <option value="name">Name</option><option value="date">Modified</option><option value="size">Size</option><option value="type">Type</option>
            </select>
            <div class="drv-seg" role="group" aria-label="View">
              <button data-view="grid" title="Grid"><i class="fa-solid fa-grip"></i></button>
              <button data-view="list" title="List"><i class="fa-solid fa-list"></i></button>
            </div>
            <button class="drv-ib" id="dRefresh" title="Refresh"><i class="fa-solid fa-rotate"></i></button>
          </div>
        </header>
        <div class="drv-bulk hidden" id="dBulk">
          <button class="drv-ib" data-b="clear" title="Clear selection"><i class="fa-solid fa-xmark"></i></button>
          <b id="dBulkN">0 selected</b>
          <span class="sp"></span>
          <button class="btn btn-ghost btn-sm" data-b="download"><i class="fa-solid fa-download"></i> Download</button>
          <button class="btn btn-danger btn-sm" data-b="delete"><i class="fa-solid fa-trash"></i> Delete</button>
        </div>
        <div class="drv-body" id="dBody" tabindex="0"></div>
        <div class="drv-drop" id="dDrop"><div><i class="fa-solid fa-cloud-arrow-up"></i><b>Drop to upload</b><small>Encrypted before it leaves your device</small></div></div>
      </section>

      <div class="drv-queue hidden" id="dQueue"><header><b id="dQTitle">Uploads</b><button class="drv-ib" id="dQClose"><i class="fa-solid fa-chevron-down"></i></button></header><div id="dQList"></div></div>
      <input type="file" id="dFiles" multiple hidden>
      <input type="file" id="dDir" webkitdirectory multiple hidden>
    </div>`;
    wire();
    paintRequest();
  }

  /* ---- more storage ----
     Users ask here; staff answer in the admin panel. The quota itself is only
     changed by staff (the database refuses anything else). */
  function paintRequest() {
    const b = $('#dAsk'); if (!b) return;
    const pending = storeReq?.status === 'pending';
    b.querySelector('span').textContent = pending ? `Requested ${storeReq.requested_gb} GB · pending` : 'Request more storage';
    b.disabled = pending;
    b.title = pending ? 'Your request is with the admins' : '';
  }

  async function loadRequest() {
    if (!window.db) return;
    const { data, error } = await window.db.from('storage_requests').select('*')
      .eq('user_id', me.id).order('created_at', { ascending: false }).limit(1);
    if (error) return; // table not created yet: the button just stays available
    storeReq = data?.[0] || null;
    paintRequest();
  }

  function askMoreStorage() {
    const cur = quotaGB();
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" style="max-width:420px;">
      <div class="modal-head"><h3>Request more storage</h3><button class="x-btn" data-no><i class="fa-solid fa-xmark"></i></button></div>
      <div class="modal-body">
        <p class="bsub" style="margin:0 0 12px">Your drive is ${cur} GB. Tell the admins how much you need.</p>
        <div class="field"><label for="rqGb">New size (GB)</label>
          <input id="rqGb" class="input" type="number" min="${cur + 1}" max="2048" step="1" value="${cur * 2}" /></div>
        <div class="field" style="margin-top:12px"><label for="rqWhy">Why (optional)</label>
          <textarea id="rqWhy" rows="3" maxlength="1000" placeholder="What are you storing?"></textarea></div>
        <p class="err" id="rqErr"></p>
      </div>
      <div class="modal-foot"><button class="btn btn-quiet" data-no>Cancel</button><button class="btn btn-primary" data-yes><i class="fa-solid fa-paper-plane"></i> Send request</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelectorAll('[data-no]').forEach((x) => { x.onclick = close; });
    ov.onclick = (e) => { if (e.target === ov) close(); };
    ov.querySelector('[data-yes]').onclick = async () => {
      const gb = Math.floor(Number(ov.querySelector('#rqGb').value));
      const err = ov.querySelector('#rqErr');
      if (!(gb > cur && gb <= 2048)) return (err.textContent = `Pick a number from ${cur + 1} to 2048.`);
      const btn = ov.querySelector('[data-yes]'); btn.disabled = true;
      const { error } = await window.db.from('storage_requests').insert({
        user_id: me.id, requested_gb: gb, reason: ov.querySelector('#rqWhy').value.trim() || null,
      });
      if (error) { btn.disabled = false; return (err.textContent = /duplicate|unique|idx_storage/i.test(error.message) ? 'You already have a request open.' : error.message); }
      close();
      toast(`Request for ${gb} GB sent to the admins.`);
      await loadRequest();
    };
    ov.querySelector('#rqGb').focus();
  }

  function wire() {
    $('#dAsk').onclick = askMoreStorage;
    const menu = $('#dNewMenu');
    $('#dNew').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
    document.addEventListener('click', (e) => { if (!e.target.closest('.drv-newwrap')) menu.classList.add('hidden'); closeCtx(e); });
    menu.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a; if (!a) return;
      menu.classList.add('hidden');
      if (a === 'upload') $('#dFiles').click();
      if (a === 'uploadDir') $('#dDir').click();
      if (a === 'folder') newFolder();
      if (a === 'text') newText();
    };
    $('#dFiles').onchange = (e) => { upload([...e.target.files]); e.target.value = ''; };
    $('#dDir').onchange = (e) => { upload([...e.target.files], true); e.target.value = ''; };

    $('#dNav').onclick = (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return;
      mode = b.dataset.m; query = ''; $('#dSearch').value = ''; sel.clear();
      if (mode === 'files') { refresh(); } else { showDerived(); }
      paintNav();
    };
    let st = 0;
    $('#dSearch').oninput = (e) => {
      clearTimeout(st);
      st = setTimeout(() => { query = e.target.value.trim(); sel.clear(); query ? showDerived() : (mode === 'files' ? paint() : showDerived()); }, 160);
    };
    $('#dSort').value = sort;
    $('#dSort').onchange = (e) => { sort = e.target.value; store.set('nx_drive_sort', sort); paint(); };
    host.querySelectorAll('[data-view]').forEach((b) => {
      b.classList.toggle('on', b.dataset.view === view);
      b.onclick = () => { view = b.dataset.view; store.set('nx_drive_view', view); host.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b)); paint(); };
    });
    $('#dRefresh').onclick = () => { dirty(); mode === 'files' && !query ? refresh() : showDerived(true); buildIndex(true).catch(() => {}); };
    $('#dBulk').onclick = (e) => {
      const b = e.target.closest('[data-b]')?.dataset.b; if (!b) return;
      if (b === 'clear') { sel.clear(); paint(); }
      if (b === 'download') selectedFiles().forEach((f, i) => setTimeout(() => download(f), i * 250));
      if (b === 'delete') remove(selectedItems());
    };
    $('#dQClose').onclick = () => $('#dQueue').classList.toggle('min');

    // drag & drop (files and whole folders)
    const main = $('#dMain'), drop = $('#dDrop');
    let depth = 0;
    main.addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files')) return; e.preventDefault(); depth++; drop.classList.add('on'); });
    main.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
    main.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('on'); } });
    main.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; drop.classList.remove('on');
      const items = [...(e.dataTransfer.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
      if (items.some((x) => x.isDirectory)) upload(await readEntries(items), true);
      else upload([...e.dataTransfer.files]);
    });

    // keyboard
    $('#dBody').addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { e.preventDefault(); remove(selectedItems()); }
      if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); visibleItems().forEach((x) => sel.add(itemId(x))); paint(); }
      if (e.key === 'Escape') { sel.clear(); paint(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && host.offsetParent && !/input|textarea|select/i.test(document.activeElement?.tagName)) { e.preventDefault(); $('#dSearch').focus(); }
    });
  }

  // Folder drops: flatten directory entries into File objects with a relative path.
  async function readEntries(entries) {
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const f = await new Promise((ok, no) => entry.file(ok, no));
        Object.defineProperty(f, 'nxPath', { value: prefix + f.name });
        out.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((ok, no) => reader.readEntries(ok, no));
          for (const ch of batch) await walk(ch, prefix + entry.name + '/');
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    return out;
  }

  /* ---------------- rendering ---------------- */
  const itemId = (x) => (x.isFolder ? 'd:' + x.enc : x.key);
  function sorted(folders, files) {
    const by = {
      name: (a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true, sensitivity: 'base' }),
      date: (a, b) => new Date(b.modified || 0) - new Date(a.modified || 0),
      size: (a, b) => (b.size || 0) - (a.size || 0),
      type: (a, b) => ext(a.name).localeCompare(ext(b.name)) || (a.name || '').localeCompare(b.name || ''),
    }[sort];
    return [...folders.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })), ...files.slice().sort(by)];
  }
  let derived = null;                // file list for search / type / recent views
  function visibleItems() {
    if (derived) return sorted([], derived);
    return sorted(listing.folders.map((f) => ({ ...f, isFolder: true })), listing.files);
  }
  const selectedItems = () => visibleItems().filter((x) => sel.has(itemId(x)));
  const selectedFiles = () => selectedItems().filter((x) => !x.isFolder && !x.locked);

  function paintCrumbs() {
    const c = $('#dCrumbs');
    if (derived) {
      const label = query ? `Results for “${esc(query)}”` : { recent: 'Recent', image: 'Photos', video: 'Videos', audio: 'Music', doc: 'Documents', other: 'Other files' }[mode];
      c.innerHTML = `<span class="crumb cur">${label}</span><span class="crumb-n">${derived.length} file${derived.length === 1 ? '' : 's'}</span>`;
      return;
    }
    c.innerHTML = `<button class="crumb" data-i="-1"><i class="fa-solid fa-house"></i> My files</button>`
      + path.map((s, i) => `<i class="fa-solid fa-chevron-right crumb-sep"></i><button class="crumb${i === path.length - 1 ? ' cur' : ''}" data-i="${i}">${esc(s.name || 'Locked folder')}</button>`).join('');
    c.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { path = path.slice(0, +b.dataset.i + 1); sel.clear(); refresh(); }; });
    // drop files onto a crumb to move up? (CloudGate has no move; keep crumbs as navigation)
  }

  function paintNav() {
    host.querySelectorAll('#dNav [data-m]').forEach((b) => b.classList.toggle('on', !query && b.dataset.m === mode));
    if (index) {
      const n = { image: 0, video: 0, audio: 0, doc: 0, other: 0 };
      index.forEach((f) => { if (!f.locked) n[group(f.name)]++; });
      host.querySelectorAll('#dNav [data-m] em').forEach((em) => { const v = n[em.parentElement.dataset.m]; em.textContent = v || ''; });
    }
  }

  function paintUsage() {
    const u = $('#dUsage'); if (!u || !index) return;
    const used = usedBytes(), q = quotaBytes();
    const pct = Math.min(100, used / q * 100);
    u.querySelector('i').style.width = Math.max(pct, used ? 1.5 : 0) + '%';
    u.querySelector('.du-bar').classList.toggle('warn', pct > 85);
    u.querySelector('small').innerHTML = `<b>${fmt(used)}</b> of ${fmt(q)} · ${index.length} file${index.length === 1 ? '' : 's'}`;
    paintRequest();
    paintNav();
  }

  function card(x) {
    const id = itemId(x), on = sel.has(id);
    if (x.isFolder) {
      return `<div class="dv-item folder${on ? ' sel' : ''}" data-id="${esc(id)}" tabindex="-1">
        <button class="dv-check" aria-label="Select"><i class="fa-solid fa-check"></i></button>
        <div class="dv-thumb"><i class="fa-solid fa-folder"></i></div>
        <div class="dv-meta"><b title="${esc(x.name || 'Locked folder')}">${esc(x.name || 'Locked folder')}</b><small>Folder</small></div>
        <span class="dv-size">—</span><span class="dv-date">—</span>
        <button class="dv-more" aria-label="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
      </div>`;
    }
    const k = x.locked ? 'locked' : kindOf(x.name);
    const where = derived && x.segs ? `<small class="dv-where"><i class="fa-regular fa-folder"></i> ${esc(['My files', ...x.segs.map((s) => s.name || '…')].join(' / '))}</small>` : '';
    return `<div class="dv-item file k-${k}${on ? ' sel' : ''}" data-id="${esc(id)}" tabindex="-1" style="--tint:${TINT[k]}">
      <button class="dv-check" aria-label="Select"><i class="fa-solid fa-check"></i></button>
      <div class="dv-thumb">${thumbs.has(x.key) ? `<img src="${thumbs.get(x.key)}" alt="">` : `<i class="fa-solid ${ICON[k]}"></i><span class="dv-ext">${esc(ext(x.name || '').slice(0, 4))}</span>`}</div>
      <div class="dv-meta"><b title="${esc(x.name || 'Unreadable file')}">${esc(x.name || 'Unreadable file')}</b><small>${fmt(x.size)} · ${when(x.modified)}</small>${where}</div>
      <span class="dv-size">${fmt(x.size)}</span><span class="dv-date">${when(x.modified)}</span>
      <button class="dv-more" aria-label="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>
    </div>`;
  }

  function paint() {
    paintCrumbs(); paintNav();
    const items = visibleItems();
    const body = $('#dBody');
    $('#dBulk').classList.toggle('hidden', !sel.size);
    $('#dBulkN').textContent = `${sel.size} selected`;
    if (!items.length) {
      body.innerHTML = derived
        ? `<div class="drv-empty"><i class="fa-solid fa-magnifying-glass"></i><b>Nothing here</b><small>${query ? 'No files match that search.' : 'No files of this type yet.'}</small></div>`
        : `<div class="drv-empty"><i class="fa-solid fa-cloud-arrow-up"></i><b>${path.length ? 'This folder is empty' : 'Your drive is empty'}</b>
           <small>Drop files here or use <b>New</b>. They're encrypted on this device before upload; only you can open them.</small>
           <button class="btn btn-primary btn-sm" id="dEmptyUp"><i class="fa-solid fa-upload"></i> Upload files</button></div>`;
      $('#dEmptyUp')?.addEventListener('click', () => $('#dFiles').click());
      return;
    }
    body.innerHTML = `<div class="dv ${view}">${view === 'list' ? '<div class="dv-head"><span></span><span>Name</span><span>Size</span><span>Modified</span><span></span></div>' : ''}${items.map(card).join('')}</div>`;
    const byId = new Map(items.map((x) => [itemId(x), x]));
    body.querySelectorAll('.dv-item').forEach((el) => {
      const x = byId.get(el.dataset.id);
      el.onclick = (e) => {
        if (e.target.closest('.dv-more')) return openCtx(e, x);
        if (e.target.closest('.dv-check') || e.ctrlKey || e.metaKey || e.shiftKey) {
          sel.has(itemId(x)) ? sel.delete(itemId(x)) : sel.add(itemId(x));
          return paint();
        }
        open(x);
      };
      el.oncontextmenu = (e) => { e.preventDefault(); openCtx(e, x); };
    });
    lazyThumbs(body, byId);
  }

  // Decrypt image thumbnails only as they scroll into view.
  let thumbIO = null, thumbBusy = 0;
  const thumbQ = [];
  function lazyThumbs(body, byId) {
    thumbIO?.disconnect();
    thumbIO = new IntersectionObserver((ents) => ents.forEach((en) => {
      if (!en.isIntersecting) return;
      thumbIO.unobserve(en.target);
      const x = byId.get(en.target.dataset.id);
      if (x && !thumbs.has(x.key)) { thumbQ.push([x, en.target]); pump(); }
    }), { root: body, rootMargin: '200px' });
    body.querySelectorAll('.dv-item.k-image').forEach((el) => { if (byId.get(el.dataset.id)?.size < 15 * 1024 * 1024) thumbIO.observe(el); });
  }
  async function pump() {
    while (thumbBusy < 3 && thumbQ.length) {
      const [x, el] = thumbQ.shift();
      thumbBusy++;
      (async () => {
        try {
          const blob = new Blob([await Vault.decBytes(K, await CloudGate.fetchBytes(x.key))], { type: mimeOf(x.name) });
          thumbs.set(x.key, URL.createObjectURL(blob));
          const t = el.isConnected ? el.querySelector('.dv-thumb') : null;
          if (t) t.innerHTML = `<img src="${thumbs.get(x.key)}" alt="">`;
        } catch {} finally { thumbBusy--; pump(); }
      })();
    }
  }

  async function refresh() {
    derived = null;
    const body = $('#dBody');
    body.innerHTML = '<div class="dv grid">' + '<div class="dv-item skel"></div>'.repeat(8) + '</div>';
    paintCrumbs();
    try { await load(); paint(); }
    catch (e) { body.innerHTML = `<div class="drv-empty"><i class="fa-solid fa-triangle-exclamation"></i><b>Couldn’t open this folder</b><small>${esc(e.message)}</small></div>`; }
  }

  async function showDerived(force) {
    const body = $('#dBody');
    body.innerHTML = '<div class="drv-empty"><i class="fa-solid fa-spinner fa-spin"></i><b>Looking through your drive…</b><small>Names are decrypted on this device, so searching happens here too.</small></div>';
    try {
      const all = await buildIndex(force);
      const q = query.toLowerCase();
      let list = all.filter((f) => !f.locked);
      if (q) list = list.filter((f) => f.name.toLowerCase().includes(q));
      else if (mode === 'recent') list = list.slice().sort((a, b) => new Date(b.modified) - new Date(a.modified)).slice(0, 60);
      else if (mode !== 'files') list = list.filter((f) => group(f.name) === mode);
      derived = list;
      paint();
    } catch (e) {
      body.innerHTML = `<div class="drv-empty"><i class="fa-solid fa-triangle-exclamation"></i><b>Couldn’t read your drive</b><small>${esc(e.message)}</small></div>`;
    }
  }

  /* ---------------- context menu ---------------- */
  function closeCtx(e) { if (!e || !e.target.closest?.('.drv-ctx')) document.querySelector('.drv-ctx')?.remove(); }
  function openCtx(e, x) {
    e.stopPropagation();
    closeCtx();
    const k = x.isFolder ? 'folder' : x.locked ? 'locked' : kindOf(x.name);
    const acts = x.isFolder
      ? [['open', 'fa-folder-open', 'Open'], ['rename', 'fa-pen', 'Rename'], ['-'], ['delete', 'fa-trash', 'Delete', 'danger']]
      : x.locked ? [['delete', 'fa-trash', 'Delete', 'danger']]
        : [['open', 'fa-eye', 'Preview'], ...(k === 'text' ? [['edit', 'fa-code', 'Edit']] : []), ['download', 'fa-download', 'Download'],
          ['share', 'fa-link', 'Copy public link'], ['rename', 'fa-pen', 'Rename'],
          ...(derived && x.segs ? [['reveal', 'fa-folder-open', 'Show in folder']] : []), ['-'], ['delete', 'fa-trash', 'Delete', 'danger']];
    const m = document.createElement('div');
    m.className = 'drv-ctx';
    m.innerHTML = acts.map((a) => a[0] === '-' ? '<hr>' : `<button data-a="${a[0]}" class="${a[3] || ''}"><i class="fa-solid ${a[1]}"></i> ${a[2]}</button>`).join('');
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(e.clientX, innerWidth - r.width - 8) + 'px';
    m.style.top = Math.min(e.clientY, innerHeight - r.height - 8) + 'px';
    m.onclick = (ev) => {
      const a = ev.target.closest('[data-a]')?.dataset.a; if (!a) return;
      m.remove();
      if (a === 'open') open(x);
      if (a === 'edit') edit(x);
      if (a === 'download') download(x);
      if (a === 'share') share(x);
      if (a === 'rename') rename(x);
      if (a === 'delete') remove(sel.has(itemId(x)) && sel.size > 1 ? selectedItems() : [x]);
      if (a === 'reveal') { mode = 'files'; query = ''; $('#dSearch').value = ''; path = x.segs.slice(); refresh(); paintNav(); }
    };
  }

  /* ---------------- modals ---------------- */
  function ask(title, value, okText) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'overlay drv-ov';
      ov.innerHTML = `<div class="modal drv-modal" style="max-width:400px;">
        <div class="modal-head"><h3>${esc(title)}</h3></div>
        <div class="modal-body"><input class="input" id="dAsk" value="${esc(value || '')}" maxlength="180" autocomplete="off" spellcheck="false"><p class="err" id="dAskErr"></p></div>
        <div class="modal-foot"><button class="btn btn-quiet" data-no>Cancel</button><button class="btn btn-primary" data-yes>${esc(okText || 'Save')}</button></div></div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector('#dAsk');
      inp.focus();
      const dot = (value || '').lastIndexOf('.');
      inp.setSelectionRange(0, dot > 0 ? dot : (value || '').length);
      const done = (v) => { ov.remove(); resolve(v); };
      const ok = () => {
        const v = inp.value.trim();
        if (badName(v)) return (ov.querySelector('#dAskErr').textContent = 'Names can’t contain / or \\ and must be under 180 characters.');
        done(v);
      };
      ov.querySelector('[data-no]').onclick = () => done(null);
      ov.querySelector('[data-yes]').onclick = ok;
      inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); if (e.key === 'Escape') done(null); };
      ov.onclick = (e) => { if (e.target === ov) done(null); };
    });
  }

  async function bytesOf(x, onProgress) {
    onProgress?.(0);
    const buf = await CloudGate.fetchBytes(x.key);
    return Vault.decBytes(K, buf);
  }

  /* Preview with previous / next across the current view. */
  async function open(x) {
    if (x.isFolder) { if (derived) return; path = [...path, { enc: x.enc, name: x.name }]; sel.clear(); return refresh(); }
    if (x.locked) return toast('This file wasn’t encrypted with your key, so it can’t be opened.', true);
    const files = visibleItems().filter((f) => !f.isFolder && !f.locked);
    let i = files.findIndex((f) => f.key === x.key);
    const ov = document.createElement('div');
    ov.className = 'drv-pv';
    ov.innerHTML = `<header><div class="pv-t"><i class="fa-solid"></i><div><b></b><small></small></div></div>
      <div class="pv-acts"><button class="drv-ib" data-p="edit" title="Edit"><i class="fa-solid fa-code"></i></button>
      <button class="drv-ib" data-p="share" title="Copy public link"><i class="fa-solid fa-link"></i></button>
      <button class="drv-ib" data-p="download" title="Download"><i class="fa-solid fa-download"></i></button>
      <button class="drv-ib" data-p="close" title="Close"><i class="fa-solid fa-xmark"></i></button></div></header>
      <button class="pv-nav prev" data-p="prev"><i class="fa-solid fa-chevron-left"></i></button>
      <div class="pv-stage"></div>
      <button class="pv-nav next" data-p="next"><i class="fa-solid fa-chevron-right"></i></button>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('in'));
    let url = null, ver = 0;
    const show = async () => {
      const f = files[i], v = ++ver, k = kindOf(f.name);
      ov.querySelector('.pv-t i').className = `fa-solid ${ICON[k]}`;
      ov.querySelector('.pv-t i').style.color = TINT[k];
      ov.querySelector('.pv-t b').textContent = f.name;
      ov.querySelector('.pv-t small').textContent = `${fmt(f.size)} · ${when(f.modified)}`;
      ov.querySelector('[data-p="edit"]').classList.toggle('hidden', k !== 'text');
      ov.querySelector('.prev').classList.toggle('hidden', i <= 0);
      ov.querySelector('.next').classList.toggle('hidden', i >= files.length - 1);
      const stage = ov.querySelector('.pv-stage');
      stage.innerHTML = '<div class="pv-load"><i class="fa-solid fa-lock-open"></i><span>Decrypting…</span></div>';
      try {
        const plain = await bytesOf(f);
        if (v !== ver) return;
        if (url) URL.revokeObjectURL(url);
        url = URL.createObjectURL(new Blob([plain], { type: mimeOf(f.name) }));
        if (k === 'image') stage.innerHTML = `<img src="${url}" alt="">`;
        else if (k === 'video') stage.innerHTML = `<video src="${url}" controls autoplay playsinline></video>`;
        else if (k === 'audio') stage.innerHTML = `<div class="pv-audio"><i class="fa-solid fa-music"></i><b>${esc(f.name)}</b><audio src="${url}" controls autoplay></audio></div>`;
        else if (k === 'pdf') stage.innerHTML = `<iframe src="${url}" title="PDF"></iframe>`;
        else if (k === 'text' || plain.byteLength < 512 * 1024 && /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(new TextDecoder().decode(plain.slice(0, 2048)))) {
          const text = new TextDecoder().decode(plain);
          stage.innerHTML = ext(f.name) === 'md' && window.MD
            ? `<article class="pv-text md m-text">${MD.render(text)}</article>`
            : `<pre class="pv-text"><code>${esc(text.slice(0, 400000))}</code></pre>`;
        } else stage.innerHTML = `<div class="pv-none"><i class="fa-solid ${ICON[k]}"></i><b>No preview for this file type</b><button class="btn btn-primary btn-sm" data-p="download"><i class="fa-solid fa-download"></i> Download</button></div>`;
      } catch (e) {
        if (v === ver) stage.innerHTML = `<div class="pv-none"><i class="fa-solid fa-triangle-exclamation"></i><b>${esc(e.message)}</b></div>`;
      }
    };
    const close = () => { ov.classList.remove('in'); setTimeout(() => { ov.remove(); if (url) URL.revokeObjectURL(url); }, 220); document.removeEventListener('keydown', key); };
    const key = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft' && i > 0) { i--; show(); }
      if (e.key === 'ArrowRight' && i < files.length - 1) { i++; show(); }
    };
    document.addEventListener('keydown', key);
    ov.onclick = (e) => {
      const p = e.target.closest('[data-p]')?.dataset.p;
      if (e.target === ov || e.target.classList.contains('pv-stage') || p === 'close') return close();
      if (p === 'prev') { i--; show(); }
      if (p === 'next') { i++; show(); }
      if (p === 'download') download(files[i]);
      if (p === 'share') share(files[i]);
      if (p === 'edit') { close(); edit(files[i]); }
    };
    show();
  }

  /* ---------------- editor (Ace, loaded on first use) ---------------- */
  let aceP = null;
  function loadAce() {
    if (window.ace) return Promise.resolve(window.ace);
    aceP = aceP || new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/ace.min.js';
      s.onload = () => { window.ace.config.set('basePath', 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/'); ok(window.ace); };
      s.onerror = () => { aceP = null; no(new Error('Editor failed to load')); };
      document.head.appendChild(s);
    });
    return aceP;
  }
  const ACE_MODE = { js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'tsx', json: 'json', css: 'css', scss: 'scss', html: 'html', htm: 'html', xml: 'xml',
    md: 'markdown', markdown: 'markdown', py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', c: 'c_cpp', h: 'c_cpp', cpp: 'c_cpp', hpp: 'c_cpp', cs: 'csharp', rs: 'rust',
    go: 'golang', php: 'php', sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'powershell', bat: 'batchfile', ini: 'ini', toml: 'toml', yml: 'yaml', yaml: 'yaml', sql: 'sql', lua: 'lua',
    swift: 'swift', dart: 'dart', vue: 'html', svelte: 'html', csv: 'text', txt: 'text', log: 'text' };

  async function edit(x, initial) {
    const isNew = !x.key;
    const segs = (x.segs || path).slice();   // save where it was opened, wherever you browse meanwhile
    let text = initial ?? '';
    if (!isNew) {
      try { text = new TextDecoder().decode(await bytesOf(x)); } catch (e) { return toast(e.message, true); }
    }
    const ov = document.createElement('div');
    ov.className = 'drv-pv drv-ed';
    ov.innerHTML = `<header><div class="pv-t"><i class="fa-solid fa-file-code" style="color:${TINT.text}"></i><div><b>${esc(x.name)}</b><small id="edState">${isNew ? 'New file' : 'Saved'}</small></div></div>
      <div class="pv-acts"><button class="btn btn-primary btn-sm" data-e="save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
      <button class="drv-ib" data-e="close" title="Close"><i class="fa-solid fa-xmark"></i></button></div></header>
      <div class="ed-host"><textarea class="ed-fallback" spellcheck="false"></textarea></div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('in'));
    const state = ov.querySelector('#edState');
    let editor = null, changed = false;
    const ta = ov.querySelector('textarea');
    ta.value = text;
    const value = () => (editor ? editor.getValue() : ta.value);
    const mark = () => { if (!changed) { changed = true; state.textContent = 'Unsaved changes'; } };
    ta.oninput = mark;
    loadAce().then((ace) => {
      if (!ov.isConnected) return;
      const div = document.createElement('div');
      div.className = 'ed-ace';
      ov.querySelector('.ed-host').replaceChildren(div);
      editor = ace.edit(div, { value: ta.value, mode: 'ace/mode/' + (ACE_MODE[ext(x.name)] || 'text'), theme: 'ace/theme/one_dark',
        fontSize: 13.5, showPrintMargin: false, useSoftTabs: true, tabSize: 2, wrap: true });
      editor.session.on('change', mark);
      editor.commands.addCommand({ name: 'save', bindKey: { win: 'Ctrl-S', mac: 'Command-S' }, exec: () => save() });
      editor.focus();
    }).catch(() => ta.focus());
    const save = async () => {
      state.textContent = 'Encrypting & saving…';
      try {
        const blob = await Vault.encBlob(K, new Blob([value()], { type: 'text/plain' }));
        const enc = x.enc || await Vault.encName(K, x.name);
        const up = await CloudGate.upload(dirOf(segs), enc, blob);
        Object.assign(x, { key: up.key, enc, size: Vault.plainSize(blob.size), stored: blob.size, modified: new Date().toISOString() });
        changed = false; state.textContent = 'Saved';
        dirty();
        if (!derived) refresh();
      } catch (e) { state.textContent = 'Save failed: ' + e.message; }
    };
    const close = async () => {
      if (changed && !await UI.confirmDialog('Discard changes?', 'Your edits to this file haven’t been saved.', true, 'Discard')) return;
      ov.classList.remove('in'); setTimeout(() => ov.remove(), 220);
    };
    ov.onclick = (e) => {
      const a = e.target.closest('[data-e]')?.dataset.e;
      if (a === 'save') save();
      if (a === 'close') close();
    };
    ov.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
      if (e.key === 'Escape') close();
    });
  }

  /* ---------------- actions ---------------- */
  async function download(x) {
    if (x.isFolder || x.locked) return;
    const t = toastProgress(`Decrypting ${x.name}…`);
    try {
      const plain = await bytesOf(x);
      const url = URL.createObjectURL(new Blob([plain], { type: mimeOf(x.name) }));
      const a = Object.assign(document.createElement('a'), { href: url, download: x.name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      t.done(`Downloaded ${x.name}`);
    } catch (e) { t.fail(e.message); }
  }

  // A public link is a separate, decrypted copy: the drive copy stays private.
  async function share(x) {
    if (!await UI.confirmDialog('Create a public link?', `A decrypted copy of "${x.name}" will be uploaded to a public link anyone can open. The original in your drive stays encrypted.`, false, 'Create link')) return;
    const t = toastProgress('Creating link…');
    try {
      const plain = await bytesOf(x);
      const safe = x.name.replace(/[^\w.\-]/g, '_');
      const up = await CloudGate.upload(`attachments/shared/${me.id}`, `${Date.now()}-${safe}`, new Blob([plain], { type: mimeOf(x.name) }));
      await navigator.clipboard?.writeText(up.url).catch(() => {});
      t.done('Public link copied to clipboard');
    } catch (e) { t.fail(e.message); }
  }

  async function newFolder() {
    const name = await ask('New folder', 'New folder', 'Create');
    if (!name) return;
    if (listing.folders.some((f) => f.name === name)) return toast('There’s already a folder with that name here.', true);
    try {
      await CloudGate.createFolder(dirOf(path), await Vault.encName(K, name));
      dirty(); refresh();
    } catch (e) { toast(e.message, true); }
  }

  async function newText() {
    const name = await ask('New text file', 'notes.txt', 'Create');
    if (!name) return;
    edit({ name, segs: path.slice() }, '');
  }

  async function rename(x) {
    const name = await ask(x.isFolder ? 'Rename folder' : 'Rename file', x.name, 'Rename');
    if (!name || name === x.name) return;
    try {
      const enc = await Vault.encName(K, name);
      if (x.isFolder) await CloudGate.renameFolder(dirOf(path), x.enc, enc);
      else await CloudGate.renameFile(x.key, enc);
      const t = thumbs.get(x.key); if (t) { thumbs.delete(x.key); }
      dirty();
      derived ? showDerived(true) : refresh();
      toast('Renamed.');
    } catch (e) { toast(e.message, true); }
  }

  async function remove(items) {
    if (!items.length) return;
    const folders = items.filter((x) => x.isFolder);
    const label = items.length === 1 ? `"${items[0].name || 'this item'}"` : `${items.length} items`;
    if (!await UI.confirmDialog('Delete ' + (items.length === 1 ? (folders.length ? 'folder' : 'file') : 'items'),
      `${label} will be permanently deleted${folders.length ? ', including everything inside' : ''}. This can’t be undone.`, true)) return;
    const t = toastProgress(`Deleting ${label}…`);
    try {
      for (const x of items) {
        if (x.isFolder) await CloudGate.deleteFolder(dirOf(path), x.enc);
        else { await CloudGate.deleteFile(x.key); const u = thumbs.get(x.key); if (u) { URL.revokeObjectURL(u); thumbs.delete(x.key); } }
        sel.delete(itemId(x));
      }
      t.done(`Deleted ${label}`);
    } catch (e) { t.fail(e.message); }
    dirty();
    derived ? showDerived(true) : refresh();
  }

  /* ---------------- uploads ---------------- */
  const queue = [];
  let running = 0;
  function upload(files, withDirs) {
    files = files.filter((f) => f && f.size !== undefined);
    if (!files.length) return;
    const base = path.slice();
    for (const f of files) {
      if (f.size > MAX_FILE) { toast(`${f.name} is over ${fmt(MAX_FILE)}, which is the per-file limit.`, true); continue; }
      const rel = withDirs ? (f.nxPath || f.webkitRelativePath || f.name) : f.name;
      const dirs = rel.split('/').slice(0, -1).filter(Boolean);
      const job = { f, name: f.name, base, dirs, pct: 0, state: 'queued', ctl: new AbortController() };
      queue.push(job);
      addQueueRow(job);
    }
    pumpUploads();
  }

  // Resolve (creating as needed) a chain of plain folder names under base.
  // Cached as promises so parallel uploads into the same new folder create it
  // once instead of racing to make duplicates.
  const folderCache = new Map();
  async function ensureDirs(base, dirs) {
    let segs = base.slice();
    for (const name of dirs) {
      const parent = segs;
      const keyId = dirOf(parent) + '|' + name;
      if (!folderCache.has(keyId)) {
        const p = (async () => {
          const here = parent.length === path.length && parent.every((s, i) => s.enc === path[i].enc)
            ? listing : await decodeListing(await CloudGate.browse(dirOf(parent)));
          const hit = here.folders.find((f) => f.name === name);
          if (hit) return { enc: hit.enc, name };
          const seg = { enc: await Vault.encName(K, name), name };
          await CloudGate.createFolder(dirOf(parent), seg.enc);
          return seg;
        })();
        folderCache.set(keyId, p);
        p.catch(() => folderCache.delete(keyId));
      }
      segs = [...segs, await folderCache.get(keyId)];
    }
    return segs;
  }

  async function pumpUploads() {
    while (running < 2) {
      const job = queue.find((j) => j.state === 'queued');
      if (!job) break;
      running++;
      job.state = 'encrypting'; paintJob(job);
      (async () => {
        try {
          // Refuse before spending time encrypting if this would overflow the quota.
          // Bytes already in flight count too, so two big files can't both squeeze in.
          if (usedBytes() === null) await buildIndex();
          const inflight = queue.reduce((a, j) => a + (j !== job && ['encrypting', 'uploading'].includes(j.state) ? j.f.size : 0), 0);
          if (usedBytes() + inflight + job.f.size > quotaBytes()) {
            throw new Error(`Over your ${quotaGB()} GB limit. Request more storage in My Drive.`);
          }
          const segs = await ensureDirs(job.base, job.dirs);
          const blob = await Vault.encBlob(K, job.f);
          if (job.ctl.signal.aborted) throw new DOMException('cancelled', 'AbortError');
          job.state = 'uploading'; paintJob(job);
          await CloudGate.upload(dirOf(segs), await Vault.encName(K, job.name), blob, {
            signal: job.ctl.signal, onProgress: (p) => { job.pct = p; paintJob(job); },
          });
          job.state = 'done'; job.pct = 1;
          // The index stays valid; just count the new bytes. It is rebuilt
          // once the whole queue has finished.
          if (index) addedBytes += job.f.size;
        } catch (e) {
          job.state = e.name === 'AbortError' ? 'cancelled' : 'error';
          job.err = e.message;
        } finally {
          running--; paintJob(job);
          if (!queue.some((j) => j.state === 'queued' || j.state === 'encrypting' || j.state === 'uploading')) {
            folderCache.clear();
            if (mode === 'files' && !query) refresh(); else showDerived(true);
            buildIndex(true).catch(() => {});
          }
          pumpUploads();
        }
      })();
    }
  }

  function addQueueRow(job) {
    const q = $('#dQueue');
    q.classList.remove('hidden', 'min');
    const row = document.createElement('div');
    row.className = 'dq-row';
    row.innerHTML = `<i class="fa-solid ${ICON[kindOf(job.name)]}" style="color:${TINT[kindOf(job.name)]}"></i>
      <div class="dq-t"><b>${esc(job.dirs.length ? job.dirs.join('/') + '/' + job.name : job.name)}</b><small>Queued · ${fmt(job.f.size)}</small><div class="dq-bar"><i></i></div></div>
      <button class="drv-ib dq-x" title="Cancel"><i class="fa-solid fa-xmark"></i></button>`;
    row.querySelector('.dq-x').onclick = () => {
      if (job.state === 'queued') { job.state = 'cancelled'; paintJob(job); }
      else if (job.state === 'done' || job.state === 'error' || job.state === 'cancelled') row.remove();
      else job.ctl.abort();
      if (!$('#dQList').children.length) q.classList.add('hidden');
    };
    job.row = row;
    $('#dQList').prepend(row);
    paintQueueTitle();
  }
  function paintJob(job) {
    const r = job.row; if (!r) return;
    const label = { queued: 'Queued', encrypting: 'Encrypting…', uploading: `${Math.round(job.pct * 100)}% · ${fmt(job.f.size * job.pct)} of ${fmt(job.f.size)}`,
      done: `Uploaded · ${fmt(job.f.size)}`, error: `Failed: ${job.err}`, cancelled: 'Cancelled' }[job.state];
    r.querySelector('small').textContent = label;
    r.querySelector('.dq-bar i').style.width = (job.state === 'done' ? 100 : job.pct * 100) + '%';
    r.className = 'dq-row ' + job.state;
    r.querySelector('.dq-x i').className = 'fa-solid ' + (['done', 'error', 'cancelled'].includes(job.state) ? 'fa-check' : 'fa-xmark');
    if (job.state === 'done') r.querySelector('.dq-x i').className = 'fa-solid fa-circle-check';
    paintQueueTitle();
  }
  function paintQueueTitle() {
    const active = queue.filter((j) => ['queued', 'encrypting', 'uploading'].includes(j.state)).length;
    const done = queue.filter((j) => j.state === 'done').length;
    $('#dQTitle').textContent = active ? `Uploading ${active} file${active === 1 ? '' : 's'}…` : `${done} upload${done === 1 ? '' : 's'} complete`;
  }

  function toastProgress(msg) {
    toast(msg);
    return { done: (m) => toast(m), fail: (m) => toast(m, true) };
  }

  /* ---------------- mount ---------------- */
  async function mount(profile, el) {
    me = profile; host = el;
    if (mounted) return;
    if (!window.CloudGate?.enabled()) {
      host.innerHTML = '<div class="drv-empty"><i class="fa-solid fa-plug-circle-xmark"></i><b>Storage isn’t configured</b><small>Set CLOUDGATE in assets/js/config.js.</small></div>';
      return;
    }
    host.innerHTML = '<div class="drv-empty"><i class="fa-solid fa-key"></i><b>Unlocking your drive…</b></div>';
    try { K = await Vault.key(me.id); }
    catch (e) {
      host.innerHTML = `<div class="drv-empty"><i class="fa-solid fa-${e.setup ? 'database' : 'triangle-exclamation'}"></i><b>${e.setup ? 'Drive not set up yet' : 'Couldn’t unlock your drive'}</b><small>${esc(e.message)}</small></div>`;
      return;
    }
    mounted = true;
    shell();
    refresh();
    buildIndex().catch(() => { const u = $('#dUsage small'); if (u) u.textContent = 'Usage unavailable'; });
    loadRequest();
  }

  return { mount };
})();
