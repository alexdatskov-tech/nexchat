/* File storage (iDrive e2 / any S3-compatible bucket).

   WHY THIS EXISTS
   Attachments used to be saved to the database as *presigned* URLs. A
   presigned URL carries its own expiry (SigV4 caps it at 7 days), so every
   file link in the database silently died a week after it was posted.

   The fix is to never persist a signature:
     - the database stores a plain, unsigned object URL
         https://<host>/<bucket>/<key>
       which is just a stable identifier for the object, and
     - a fresh signature is minted at render time, here.

   Old rows still hold an expired presigned URL, but the object key is right
   there in its path, so `sign()` recovers them too: links posted months ago
   come back without touching the database.

   Signatures are minted against the start of the current UTC day and are
   valid for 7 days, so the URL for a file is identical all day long and the
   browser's HTTP cache actually gets hits, while always having >= 6 days of
   validity left.

   SIGNING BACKENDS
   1. `NEXCHAT_CONFIG.STORAGE_ENDPOINT` set -> a Supabase Edge Function signs
      for authenticated users (see supabase/functions/nexchat-storage). The
      bucket secret then never ships to browsers. This is the safe mode.
   2. otherwise -> the legacy in-browser signer (window.__nx_tp), which has
      the bucket credentials embedded in public JavaScript.            */
window.Store = (function () {
  const cfg = () => window.NEXCHAT_CONFIG || {};
  const legacy = () => window.__nx_tp;
  const DAY = 86400000;
  const VALID_S = 7 * 86400;          // SigV4 maximum
  const cache = new Map();            // key -> { url, until }

  const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', tif: 'image/tiff',
    tiff: 'image/tiff', heic: 'image/heic', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm',
    mov: 'video/quicktime', mkv: 'video/x-matroska', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
    opus: 'audio/opus', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', txt: 'text/plain',
    md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', css: 'text/css',
    js: 'text/javascript', zip: 'application/zip', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  };
  const mimeOf = (name) => legacy()?.mimeOf?.(name)
    || MIME[(String(name).split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  /* ---------- identity: host, bucket, key ---------- */
  function host() { return cfg().STORAGE_HOST || legacy()?.host || 's3.us-west-4.idrivee2.com'; }
  function bucket() { return cfg().STORAGE_BUCKET || legacy()?.bucket || 'robo-test'; }

  function isManaged(url) {
    if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    try {
      const h = new URL(url).hostname;
      return h === host() || /\.idrivee2\.com$/i.test(h) || /(^|\.)idrivee2-\d+\.com$/i.test(h);
    } catch { return false; }
  }

  // Path-style URL: /<bucket>/<key...>. Query string (an old signature) is ignored.
  function keyOf(url) {
    if (!isManaged(url)) return null;
    try {
      const path = new URL(url).pathname.replace(/^\/[^/]+\//, '');
      return path ? path.split('/').map(decodeURIComponent).join('/') : null;
    } catch { return null; }
  }

  const enc = (k) => k.split('/').map((s) => encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  const permanentUrl = (key) => `https://${host()}/${bucket()}/${enc(key)}`;

  /* ---------- edge function transport ---------- */
  async function edge(body) {
    const c = cfg();
    const { data } = await window.db.auth.getSession();
    const token = data?.session?.access_token;
    const r = await fetch(c.STORAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: c.SUPABASE_ANON_KEY,
        authorization: 'Bearer ' + (token || c.SUPABASE_ANON_KEY),
      },
      body: JSON.stringify(body),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `Storage error (${r.status})`);
    return out;
  }

  // Many attachments render in the same tick; sign them in one round trip.
  let batch = null;
  function edgeSign(key) {
    if (!batch) {
      batch = { keys: new Set(), waiters: [] };
      const b = batch;
      queueMicrotask(async () => {
        batch = null;
        try {
          const { urls } = await edge({ op: 'sign', keys: [...b.keys] });
          b.waiters.forEach((w) => (urls?.[w.key] ? w.ok(urls[w.key]) : w.no(new Error('Not allowed'))));
        } catch (e) { b.waiters.forEach((w) => w.no(e)); }
      });
    }
    batch.keys.add(key);
    return new Promise((ok, no) => batch.waiters.push({ key, ok, no }));
  }

  /* ---------- signing ---------- */
  const dayStart = () => Math.floor(Date.now() / DAY) * DAY;

  function signKey(key, { force = false } = {}) {
    const hit = cache.get(key);
    if (!force && hit && hit.until > Date.now()) return hit.promise;
    const at = dayStart();
    const entry = { until: at + VALID_S * 1000 - 3600000 };
    entry.promise = (cfg().STORAGE_ENDPOINT
      ? edgeSign(key)
      : Promise.resolve().then(() => legacy().presign(key, VALID_S / 60, at)))
      .then((url) => { entry.url = url; return url; })
      .catch((e) => { cache.delete(key); throw e; });
    cache.set(key, entry);
    return entry.promise;
  }

  // Resolves any stored URL to something a browser can load right now.
  function sign(url, opts) {
    const key = keyOf(url);
    return key ? signKey(key, opts) : Promise.resolve(url);
  }

  // Synchronous fast path when a signature is already cached (or not needed).
  function signedNow(url) {
    const key = keyOf(url);
    if (!key) return url;
    const hit = cache.get(key);
    return hit && hit.url && hit.until > Date.now() ? hit.url : null;
  }

  /* ---------- writes ---------- */
  function xhrPut(url, file, headers, onProgress) {
    return new Promise((ok, no) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100)); };
      x.onload = () => (x.status >= 200 && x.status < 300 ? ok() : no(new Error(`Upload failed (${x.status})`)));
      x.onerror = () => no(new Error('Upload failed (network)'));
      x.send(file);
    });
  }

  /* Uploads and returns the PERMANENT url. Persist `url` (or `key`), never a
     signed link. */
  async function put(key, file, onProgress) {
    const type = file.type || mimeOf(file.name);
    if (cfg().STORAGE_ENDPOINT) {
      const { url, headers } = await edge({ op: 'put', key, type });
      await xhrPut(url, file, { 'Content-Type': type, ...(headers || {}) }, onProgress);
    } else {
      if (!legacy()) throw new Error('Storage is not configured.');
      await legacy().put(key, file, onProgress);
    }
    cache.delete(key);
    return { key, url: permanentUrl(key), size: file.size, type };
  }

  async function del(urlOrKey) {
    const key = isManaged(urlOrKey) ? keyOf(urlOrKey) : urlOrKey;
    if (!key) return;
    cache.delete(key);
    if (cfg().STORAGE_ENDPOINT) await edge({ op: 'delete', key });
    else await legacy()?.del(key);
  }

  async function text(url) {
    const r = await fetch(await sign(url));
    if (!r.ok) throw new Error('Could not read that file.');
    return r.text();
  }

  /* ---------- <img data-nx-src> hydration ----------
     Markup built as strings (role icons, avatars, server icons) can't await a
     signature, so it emits <img data-nx-src="stored url"> and this observer
     fills in a signed src wherever such an image appears. */
  function hydrate(img) {
    const raw = img.getAttribute('data-nx-src');
    if (!raw || img.dataset.nxDone === raw) return;
    img.dataset.nxDone = raw;
    const now = signedNow(raw);
    if (now) { img.src = now; return; }
    sign(raw).then((u) => { if (img.getAttribute('data-nx-src') === raw) img.src = u; }).catch(() => {});
  }
  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches?.('img[data-nx-src]')) hydrate(root);
    root.querySelectorAll?.('img[data-nx-src]').forEach(hydrate);
  }
  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    const start = () => {
      scan(document.body);
      new MutationObserver((ms) => ms.forEach((m) => {
        m.addedNodes.forEach(scan);
        if (m.type === 'attributes') hydrate(m.target);
      })).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-nx-src'] });
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  }

  // Renders an <img> for any stored URL: managed URLs get the lazy-sign path.
  function imgAttr(url) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    if (!isManaged(url)) return `src="${esc(url)}"`;
    const now = signedNow(url);
    return now ? `src="${esc(now)}" data-nx-src="${esc(url)}"` : `data-nx-src="${esc(url)}"`;
  }

  return { isManaged, keyOf, permanentUrl, sign, signKey, signedNow, put, del, text, mimeOf, imgAttr, hydrate };
})();
