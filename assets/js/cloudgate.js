/* CloudGate (Wasmer) storage client.

   The Wasmer app (github.com/alexd-aero/cloudgate-wasmer) fronts a CloudGate
   bucket. Everything NexChat stores lives in one category (CLOUDGATE.category,
   "nexchats-us1"):

     nexchats-us1/attachments/...   chat files, avatars, icons, wallpapers
     nexchats-us1/vault/<user id>/  each user's private, encrypted drive

   Uploads never stream through Wasmer: it hands back a presigned S3 PUT URL
   and the browser sends the bytes straight to S3 (multipart for big files).
   Reads come from the CloudFront URL, which is permanent - nothing to re-sign,
   nothing that expires.

   NOTE: the Basic-auth login in config.js ships to every browser, so anyone
   reading the page source can call this API. Private files are therefore
   encrypted before upload (see vault.js); chat attachments are not. */
window.CloudGate = (function () {
  const cfg = () => (window.NEXCHAT_CONFIG || {}).CLOUDGATE || null;
  const category = () => cfg()?.category || 'nexchats-us1';
  const auth = () => 'Basic ' + btoa(unescape(encodeURIComponent(`${cfg().user}:${cfg().pass}`)));

  /* Endpoints in the order they should be tried. A single `endpoint` string
     still works for older configs. */
  function endpoints() {
    const c = cfg();
    if (!c) return [];
    const list = Array.isArray(c.endpoints) && c.endpoints.length
      ? c.endpoints
      : (c.endpoint ? [{ name: 'primary', endpoint: c.endpoint }] : []);
    return list
      .map((e) => ({ name: e.name || 'endpoint', base: String(e.endpoint || '').replace(/\/+$/, '') }))
      .filter((e) => /^https?:\/\//.test(e.base));
  }
  const enabled = () => endpoints().length > 0;

  // Network blips (mobile, sleeping laptops, Wasmer cold starts) get a couple
  // of quiet retries on the same endpoint before we move on to the next one.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function retry(fn, tries = 3) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= tries - 1 || !e.transient) throw e;
        await sleep(400 * 2 ** i);
      }
    }
  }

  // One request to one endpoint. "Transient" means the endpoint itself is the
  // problem (unreachable, or a 5xx). A 4xx is an answer and is never retried
  // elsewhere.
  function transient(msg) { const e = new Error(msg); e.transient = true; return e; }
  async function callAt(ep, path, { method = 'GET', body, query } = {}) {
    const url = new URL(ep.base + path);
    Object.entries(query || {}).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const r = await retry(async () => {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { authorization: auth(), ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw transient(`Storage unreachable (${ep.name})`);
      }
      if (res.status >= 500 && res.status <= 599) throw transient(`Storage error (${res.status})`);
      return res;
    });
    let out = null;
    try { out = await r.json(); } catch {}
    if (!r.ok) {
      if (out?.error === 'reauth_required') throw new Error('Storage needs to be reconnected by the site owner.');
      throw new Error(out?.error || `Storage error (${r.status})`);
    }
    return out;
  }

  /* Failover: try each endpoint in turn until one answers. Returns the data
     and the endpoint that answered, so multipart uploads can stay pinned to it. */
  async function route(path, opts) {
    const list = endpoints();
    if (!list.length) throw new Error('Storage is not configured.');
    let last = null;
    for (const ep of list) {
      try { return { data: await callAt(ep, path, opts), ep }; }
      catch (e) {
        if (!e.transient) throw e;
        last = e;
      }
    }
    throw new Error(`${last?.message || 'Storage error'} - every storage endpoint failed`);
  }
  const api = async (path, opts) => (await route(path, opts)).data;

  /* ---- paths: everything is relative to our category ---- */
  const clean = (p) => String(p || '').split('/').filter(Boolean).join('/');
  const join = (...parts) => parts.map(clean).filter(Boolean).join('/');

  // CloudFront URL -> object key, for files we own.
  function keyOf(url) {
    try {
      const u = new URL(url);
      if (cfg()?.cdn ? u.hostname !== cfg().cdn : !/\.cloudfront\.net$/i.test(u.hostname)) return null;
      const key = u.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
      return key.split('/')[2] === category() ? key : null;
    } catch { return null; }
  }
  const isOurs = (url) => !!(url && typeof url === 'string' && keyOf(url));

  /* ---- transfers ---- */
  function xhrPut(url, body, contentType, onProgress, signal) {
    return new Promise((ok, no) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      if (contentType) x.setRequestHeader('Content-Type', contentType);
      x.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
      x.onload = () => (x.status >= 200 && x.status < 300 ? ok(x.getResponseHeader('ETag')) : no(new Error(`Upload failed (${x.status})`)));
      x.onerror = () => no(new Error('Upload failed (network)'));
      x.onabort = () => no(new DOMException('Upload cancelled', 'AbortError'));
      signal?.addEventListener('abort', () => x.abort(), { once: true });
      x.send(body);
    });
  }

  const MULTIPART_OVER = 24 * 1024 * 1024;

  /* Upload a Blob to <category>/<path>/<filename>.
     Returns { key, url, size, type }. onProgress(fraction 0..1). */
  async function upload(path, filename, blob, { onProgress, signal } = {}) {
    if (!enabled()) throw new Error('Storage is not configured.');
    const p = clean(path);
    if (blob.size > MULTIPART_OVER) {
      const { data: m, ep } = await route('/api/upload/multipart/create', { method: 'POST', body: { category: category(), path: p, filename, size: blob.size } });
      const loaded = new Array(m.partUrls.length).fill(0);
      const report = () => onProgress?.(loaded.reduce((a, b) => a + b, 0) / blob.size);
      try {
        let next = 0;
        const worker = async () => {
          while (next < m.partUrls.length) {
            const i = next++;
            const part = blob.slice(i * m.partSize, Math.min(blob.size, (i + 1) * m.partSize));
            await retry(() => xhrPut(m.partUrls[i], part, null, (l) => { loaded[i] = l; report(); }, signal));
            loaded[i] = part.size; report();
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        // Pinned to the endpoint that started the upload: its upload id lives there.
        const done = await callAt(ep, '/api/upload/multipart/complete', { method: 'POST', body: { key: m.key, uploadId: m.uploadId } });
        return { key: done.key, url: done.url || m.publicUrl, size: blob.size, type: m.contentType };
      } catch (e) {
        callAt(ep, '/api/upload/multipart/abort', { method: 'POST', body: { key: m.key, uploadId: m.uploadId } }).catch(() => {});
        throw e;
      }
    }
    const pre = await api('/api/upload/presign', { method: 'POST', body: { category: category(), path: p, filename } });
    await retry(() => xhrPut(pre.putUrl, blob, pre.contentType, (l, t) => onProgress?.(l / t), signal));
    onProgress?.(1);
    return { key: pre.key, url: pre.publicUrl, size: blob.size, type: pre.contentType };
  }

  /* ---- reads ---- */
  // CloudFront first (fast, cached); the Wasmer download route as a fallback.
  async function fetchBytes(keyOrUrl) {
    const url = /^https?:/i.test(keyOrUrl) ? keyOrUrl : publicUrl(keyOrUrl);
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.ok) return r.arrayBuffer();
    } catch {}
    const key = /^https?:/i.test(keyOrUrl) ? keyOf(keyOrUrl) : keyOrUrl;
    for (const ep of endpoints()) {
      try {
        const r = await fetch(ep.base + '/api/download?key=' + encodeURIComponent(key), { headers: { authorization: auth() } });
        if (r.ok) return r.arrayBuffer();
      } catch {}
    }
    throw new Error('Could not read that file.');
  }

  function publicUrl(key) {
    const host = cfg()?.cdn || 'd1dncmkdpaif79.cloudfront.net';
    return `https://${host}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  }

  /* ---- listing & management (paths relative to the category) ---- */
  const browse = (path) => api('/api/browse', { query: { category: category(), path: clean(path) } });
  const createFolder = (path, name) => api('/api/folders', { method: 'POST', body: { category: category(), path: clean(path), name } });
  const renameFolder = (path, oldName, newName) => api('/api/folders/rename', { method: 'POST', body: { category: category(), path: clean(path), old_name: oldName, new_name: newName } });
  const deleteFolder = (path, name) => api('/api/folders', { method: 'DELETE', body: { category: category(), path: clean(path), name } });
  const renameFile = (key, newName) => api('/api/files/rename', { method: 'POST', body: { key, new_name: newName } });
  const deleteFile = (key) => api('/api/files', { method: 'DELETE', body: { key } });
  const exists = (key) => api('/api/files/exists', { query: { key } });

  return {
    enabled, endpoints, category, join, keyOf, isOurs, publicUrl,
    upload, fetchBytes, browse, createFolder, renameFolder, deleteFolder, renameFile, deleteFile, exists,
  };
})();
