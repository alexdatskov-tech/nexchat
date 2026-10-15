/* CloudGate (Wasmer) storage client.

   Storage is split into GROUPS. Each group has a capacity (set by an admin in
   Admin -> Storage endpoints, e.g. "Group 1 = 100 GB") and one or more
   ENDPOINTS: deployments of the same CloudGate app, each with its own username
   and password. All endpoints run the same logic.

   Uploads go to the first group that still has room. Inside a group the
   endpoints are tried in order. When a group is full, the upload moves on to
   the next group, and that group is skipped for the rest of the session.

   Groups, endpoints, category and CDN come from the database
   (supabase/storage_groups.sql). Until an admin sets them up, the endpoints in
   config.js CLOUDGATE are used as one group.

   Everything NexChat stores lives in one category (default "nexchats-us1"):

     <category>/attachments/...   chat files, avatars, icons, wallpapers
     <category>/vault/<user id>/  each user's private, encrypted drive

   Uploads never stream through Wasmer: it hands back a presigned S3 PUT URL
   and the browser sends the bytes straight to S3 (multipart for big files).
   Reads come from the CloudFront URL, which is permanent - nothing to re-sign,
   nothing that expires.

   NOTE: the endpoint logins reach every signed-in browser, because the browser
   signs its own uploads. Private files are therefore encrypted before upload
   (see vault.js); chat attachments are not. */
window.CloudGate = (function () {
  const cfgBase = () => (window.NEXCHAT_CONFIG || {}).CLOUDGATE || null;
  const DEFAULT_CATEGORY = 'nexchats-us1';
  const DEFAULT_CDN = 'd1dncmkdpaif79.cloudfront.net';
  const FRESH_MS = 60 * 1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* Runtime state: { category, cdn, configured, groups: [{ id, name, capacity, used, endpoints }] }.
     Credentials live here in memory only (never localStorage). */
  let runtime = null;
  let loadedAt = 0;
  let loading = null;
  let lastFailed = false; // the last database read failed: try again before the next write
  const full = new Set(); // group ids that answered "full" this session

  const normBase = (s) => String(s || '').trim().replace(/\/+$/, '');
  const isUsable = (e) => /^https?:\/\//.test(e.base) && !!e.user && !!e.pass;

  // The endpoints listed in config.js, as one group with no capacity limit.
  function fromConfig() {
    const c = cfgBase();
    if (!c) return null;
    const list = Array.isArray(c.endpoints) && c.endpoints.length
      ? c.endpoints
      : (c.endpoint ? [{ name: 'primary', endpoint: c.endpoint, user: c.user, pass: c.pass }] : []);
    const endpoints = list
      .map((e, i) => ({ id: 'cfg-' + i, name: e.name || 'endpoint', base: normBase(e.endpoint), user: e.user, pass: e.pass }))
      .filter(isUsable);
    if (!endpoints.length) return null;
    return {
      category: c.category || DEFAULT_CATEGORY,
      cdn: c.cdn || null,
      configured: false,
      groups: [{ id: null, name: 'config.js', capacity: Infinity, used: 0, endpoints }],
    };
  }

  function fromDatabase(d) {
    const cfg = d || {};
    return {
      category: cfg.category || DEFAULT_CATEGORY,
      cdn: cfg.cdn || null,
      configured: !!cfg.configured,
      groups: (cfg.groups || []).map((g) => ({
        id: g.id,
        name: g.name,
        capacity: Number(g.capacity_bytes) || 0,
        used: Number(g.used_bytes) || 0,
        endpoints: (g.endpoints || [])
          .map((e) => ({ id: e.id, name: e.name, base: normBase(e.base_url), user: e.username, pass: e.password }))
          .filter(isUsable),
      })).filter((g) => g.endpoints.length),
    };
  }

  /* Load the groups from the database. Concurrent callers share one request.
     If the database has none (or is not reachable), config.js is used. */
  async function refresh() {
    if (!window.db || !cfgBase()) return current();
    if (!loading) {
      loading = (async () => {
        let db = null;
        let dbFailed = false;
        try {
          const { data, error } = await window.db.rpc('storage_client_config');
          if (error) throw error;
          db = fromDatabase(data);
        } catch (e) {
          dbFailed = true; // not set up yet, no session, or offline
        }
        lastFailed = dbFailed;
        // A failed read keeps the last good list instead of falling back mid-session.
        if (dbFailed && runtime) return runtime;

        const fb = fromConfig();
        const next = db && db.groups.length ? db : fb;
        if (!next) return runtime;
        // The category is only used once an admin has confirmed it; until then config.js decides.
        next.category = db?.configured ? db.category : (fb?.category || next.category);
        next.cdn = db?.cdn || fb?.cdn || null;
        next.configured = !!db?.configured;
        runtime = next;
        loadedAt = Date.now();
        full.clear();
        return runtime;
      })().finally(() => { loading = null; });
    }
    return loading;
  }

  // Waits for a fresh-enough group list before a write (or a browse).
  async function ready() {
    if (!runtime || lastFailed || Date.now() - loadedAt > FRESH_MS) await refresh();
    return current();
  }

  const current = () => runtime || fromConfig();
  const category = () => current()?.category || DEFAULT_CATEGORY;
  const cdnHost = () => current()?.cdn || cfgBase()?.cdn || DEFAULT_CDN;
  const groups = () => current()?.groups || [];
  const endpoints = () => groups().flatMap((g) => g.endpoints.map((e) => ({ ...e, groupId: g.id, groupName: g.name })));
  const enabled = () => endpoints().length > 0;

  // Turns one endpoint row (admin list or config) into the shape the client uses.
  const asEndpoint = (row) => ({ name: row.name, base: normBase(row.base_url || row.base), user: row.username || row.user, pass: row.password || row.pass });

  /* ---- one request to one endpoint ---- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function retry(fn, tries = 3) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= tries - 1 || !e.transient) throw e;
        await sleep(400 * 2 ** i);
      }
    }
  }

  // "transient": the endpoint itself is the problem (unreachable or 5xx), so the
  // same request may go to another endpoint. A 4xx is an answer about the file.
  function failure(msg, { transient = false, status = 0 } = {}) {
    const e = new Error(msg);
    e.transient = transient;
    e.status = status;
    return e;
  }

  const auth = (ep) => 'Basic ' + btoa(unescape(encodeURIComponent(`${ep.user}:${ep.pass}`)));

  async function callAt(ep, path, { method = 'GET', body, query } = {}) {
    const url = new URL(ep.base + path);
    Object.entries(query || {}).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const r = await retry(async () => {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers: { authorization: auth(ep), ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw failure(`Storage unreachable (${ep.name})`, { transient: true });
      }
      // 507 (Insufficient Storage) means the group is full, not that the endpoint is down.
      if (res.status >= 500 && res.status <= 599 && res.status !== 507) {
        throw failure(`Storage error (${res.status})`, { transient: true, status: res.status });
      }
      return res;
    });
    let out = null;
    try { out = await r.json(); } catch {}
    if (!r.ok) {
      if (out?.error === 'reauth_required') throw failure('Storage needs to be reconnected by the site owner.', { status: r.status });
      throw failure(out?.error || `Storage error (${r.status})`, { status: r.status });
    }
    return out;
  }

  // Runs the request on every endpoint (folders exist on each one). Resolves with
  // the endpoints that answered; throws only when none did.
  async function each(path, opts) {
    await ready();
    const list = endpoints();
    if (!list.length) throw new Error('Storage is not configured.');
    const results = await Promise.allSettled(list.map((ep) => callAt(ep, path, opts).then((data) => ({ ep, data }))));
    const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length) throw results.find((r) => r.status === 'rejected').reason;
    return ok;
  }

  /* ---- which endpoint holds a file ---- */
  async function lookup(key) {
    if (!window.db) return null;
    try {
      const { data } = await window.db.rpc('storage_lookup', { p_key: key });
      return data || null;
    } catch { return null; }
  }
  function forget(key) {
    if (!window.db) return;
    window.db.rpc('storage_forget', { p_key: key }).then(() => {}, () => {});
  }
  function recordUpload(key, g, ep, size) {
    if (!window.db || !UUID.test(g.id || '') || !UUID.test(ep.id || '')) return;
    window.db.rpc('storage_record', { p_key: key, p_group: g.id, p_endpoint: ep.id, p_size: size })
      .then(({ error }) => { if (error) console.warn('Storage usage not recorded:', error.message); }, () => {});
  }

  /* Runs op(ep) on the endpoint that holds `key`, then on the others if that
     one is unavailable or does not have the file. Stale records are fine. */
  async function onOwner(key, op) {
    await ready();
    const list = endpoints();
    if (!list.length) throw new Error('Storage is not configured.');
    const owner = await lookup(key);
    const first = owner?.endpoint_id ? list.find((e) => e.id === owner.endpoint_id) : null;
    const order = first ? [first, ...list.filter((e) => e.id !== first.id)] : list;
    let last = null;
    for (const ep of order) {
      try { return { out: await op(ep), ep, owner }; }
      catch (e) {
        if (!(e.transient || e.status === 401 || e.status === 404)) throw e;
        last = e;
      }
    }
    throw last || new Error('Storage error');
  }

  /* ---- paths: everything is relative to our category ---- */
  const clean = (p) => String(p || '').split('/').filter(Boolean).join('/');
  const join = (...parts) => parts.map(clean).filter(Boolean).join('/');

  // CloudFront URL -> object key, for files we own (any CloudFront host).
  function keyOf(url) {
    try {
      const u = new URL(url);
      if (!/\.cloudfront\.net$/i.test(u.hostname)) return null;
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
      x.onload = () => (x.status >= 200 && x.status < 300 ? ok(x.getResponseHeader('ETag')) : no(failure(`Upload failed (${x.status})`, { status: x.status })));
      x.onerror = () => no(failure('Upload failed (network)', { transient: true }));
      x.onabort = () => no(new DOMException('Upload cancelled', 'AbortError'));
      signal?.addEventListener('abort', () => x.abort(), { once: true });
      x.send(body);
    });
  }

  const MULTIPART_OVER = 24 * 1024 * 1024;

  // One complete upload to one endpoint. Multipart stays pinned to that endpoint.
  async function uploadTo(ep, p, filename, blob, onProgress, signal) {
    if (blob.size > MULTIPART_OVER) {
      const m = await callAt(ep, '/api/upload/multipart/create', { method: 'POST', body: { category: category(), path: p, filename, size: blob.size } });
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
        // Its upload id lives on this endpoint, so it must complete here.
        const done = await callAt(ep, '/api/upload/multipart/complete', { method: 'POST', body: { key: m.key, uploadId: m.uploadId } });
        return { key: done.key, url: done.url || m.publicUrl, size: blob.size, type: m.contentType };
      } catch (e) {
        callAt(ep, '/api/upload/multipart/abort', { method: 'POST', body: { key: m.key, uploadId: m.uploadId } }).catch(() => {});
        throw e;
      }
    }
    const pre = await callAt(ep, '/api/upload/presign', { method: 'POST', body: { category: category(), path: p, filename } });
    await retry(() => xhrPut(pre.putUrl, blob, pre.contentType, (l, t) => onProgress?.(l / t), signal));
    onProgress?.(1);
    return { key: pre.key, url: pre.publicUrl, size: blob.size, type: pre.contentType };
  }

  // "This group is out of room" - a 507, or a quota-style message from the app.
  // Best effort: the app has no fixed code for it, so tracked usage does the real work.
  const looksFull = (e) => e.status === 507
    || /quota|storage (is )?full|no space|out of space|limit (reached|exceeded)/i.test(e.message || '');

  /* Upload a Blob to <category>/<path>/<filename>.
     Returns { key, url, size, type }. onProgress(fraction 0..1). */
  async function upload(path, filename, blob, { onProgress, signal } = {}) {
    await ready();
    if (!enabled()) throw new Error('Storage is not configured.');
    const p = clean(path);
    const rooms = groups().filter((g) => !full.has(g.id) && g.used + blob.size <= g.capacity);
    if (!rooms.length) throw new Error('Every storage group is full. Ask an admin to add storage.');
    let last = null;
    for (const g of rooms) {
      let fullHere = 0;
      for (const ep of g.endpoints) {
        try {
          const out = await uploadTo(ep, p, filename, blob, onProgress, signal);
          g.used += blob.size;
          recordUpload(out.key, g, ep, blob.size);
          return out;
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          last = e;
          if (looksFull(e)) { fullHere++; continue; }               // this endpoint is full: next endpoint in the group
          if (e.transient || e.status === 401) continue;            // endpoint down or login refused: next endpoint
          throw e;                                                  // a real answer about this file
        }
      }
      // Every endpoint in the group said "full": skip the group for the rest of the session.
      if (fullHere && fullHere === g.endpoints.length) full.add(g.id);
    }
    throw new Error(`${last?.message || 'Upload failed'} - no storage group could take this file.`);
  }

  /* ---- reads ---- */
  // CloudFront first (fast, cached); the Wasmer download route as a fallback.
  async function fetchBytes(keyOrUrl) {
    await ready();
    const url = /^https?:/i.test(keyOrUrl) ? keyOrUrl : publicUrl(keyOrUrl);
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (r.ok) return r.arrayBuffer();
    } catch {}
    const key = /^https?:/i.test(keyOrUrl) ? keyOf(keyOrUrl) : keyOrUrl;
    if (!key) throw new Error('Could not read that file.');
    try {
      const { out } = await onOwner(key, async (ep) => {
        let r;
        try {
          r = await fetch(ep.base + '/api/download?key=' + encodeURIComponent(key), { headers: { authorization: auth(ep) } });
        } catch { throw failure(`Storage unreachable (${ep.name})`, { transient: true }); }
        if (!r.ok) throw failure(`Download failed (${r.status})`, { status: r.status, transient: r.status >= 500 });
        return r.arrayBuffer();
      });
      return out;
    } catch {
      throw new Error('Could not read that file.');
    }
  }

  function publicUrl(key) {
    return `https://${cdnHost()}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  }

  /* ---- listing & management (paths relative to the category) ---- */
  // Lists every endpoint and merges the results, so files in any group show up.
  async function browse(path) {
    const hits = await each('/api/browse', { query: { category: category(), path: clean(path) } });
    const folders = new Set();
    const files = new Map();
    hits.forEach(({ data }) => {
      (data?.folders || []).forEach((f) => folders.add(f));
      (data?.files || []).forEach((f) => { if (f?.key && !files.has(f.key)) files.set(f.key, f); });
    });
    return { folders: [...folders].sort(), files: [...files.values()] };
  }
  // Folders exist on every endpoint, so folder changes go to all of them.
  const onAll = async (path, opts) => (await each(path, opts))[0].data;
  const createFolder = (path, name) => onAll('/api/folders', { method: 'POST', body: { category: category(), path: clean(path), name } });
  const renameFolder = (path, oldName, newName) => onAll('/api/folders/rename', { method: 'POST', body: { category: category(), path: clean(path), old_name: oldName, new_name: newName } });
  const deleteFolder = (path, name) => onAll('/api/folders', { method: 'DELETE', body: { category: category(), path: clean(path), name } });

  async function renameFile(key, newName) {
    const { out, owner, ep } = await onOwner(key, (e) => callAt(e, '/api/files/rename', { method: 'POST', body: { key, new_name: newName } }));
    // The file now has a new key. Move its usage record so the group totals stay right.
    const newKey = key.slice(0, key.lastIndexOf('/') + 1) + newName;
    if (owner?.group_id && owner?.endpoint_id && newKey !== key && window.db) {
      window.db.rpc('storage_record', { p_key: newKey, p_group: owner.group_id, p_endpoint: owner.endpoint_id, p_size: owner.size || 0 })
        .then(() => forget(key), () => {});
    }
    return out || { key: newKey, endpoint: ep?.name };
  }

  // The app's delete is S3's DeleteObject, which "succeeds" for a missing key. So each
  // endpoint is checked first, and a file that is on none of them counts as deleted.
  async function deleteFile(key) {
    let out = null;
    try {
      ({ out } = await onOwner(key, async (ep) => {
        const here = await callAt(ep, '/api/files/exists', { query: { key } });
        if (!here?.exists) throw failure('File not on this endpoint', { status: 404 });
        return callAt(ep, '/api/files', { method: 'DELETE', body: { key } });
      }));
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    forget(key);
    return out || { deleted: true };
  }

  async function exists(key) {
    return (await onOwner(key, (ep) => callAt(ep, '/api/files/exists', { query: { key } }))).out;
  }

  /* ---- admin: checking an endpoint and measuring its real usage ---- */
  // Connects with the given login and returns the app's /api/stats (no secrets echoed).
  const probe = (ep) => callAt(asEndpoint(ep), '/api/stats');
  // Bytes this endpoint holds in our category, as the app reports it.
  async function measure(ep) {
    const stats = await callAt(asEndpoint(ep), '/api/stats');
    return Number(stats?.folder_stats?.[category()]?.size_bytes) || 0;
  }

  if (window.db) refresh();

  return {
    enabled, endpoints, groups, category, join, keyOf, isOurs, publicUrl,
    upload, fetchBytes, browse, createFolder, renameFolder, deleteFolder, renameFile, deleteFile, exists,
    refresh, ready, probe, measure, asEndpoint,
  };
})();
