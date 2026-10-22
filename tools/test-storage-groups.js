/* Storage groups and endpoints (assets/js/cloudgate.js).

   Pins the routing rules the admin console depends on:
     - uploads fill the first group with room, then overflow to the next group
     - a group answering 507 (or a quota-style message) is skipped for the session
     - an endpoint with no username/password is never called
     - each endpoint is called with its own login (the fake server checks it)
     - a 401 or a dead endpoint moves to the next endpoint in the same group
     - other 4xx answers are returned to the caller, not retried elsewhere
     - delete / rename go to the endpoint that holds the file, then the others
     - browse merges every endpoint (folders de-duplicated, files by key)
     - the config.js fallback is used only when the database has no groups
     - a failed database read keeps the last good group list

   Runs the real cloudgate.js inside a vm context. No browser, no network.
     node tools/test-storage-groups.js
*/
const vm = require('vm');
const fs = require('fs');
const REPO = '/home/user/nexchat';
const SRC = fs.readFileSync(REPO + '/assets/js/cloudgate.js', 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const E1 = 'a1111111-1111-4111-8111-111111111111'; // g1a, has login
const EX = 'a2222222-2222-4222-8222-222222222222'; // g1x, NO login
const E5 = 'a5555555-5555-4555-8555-555555555555'; // g1b, has login
const E3 = 'a3333333-3333-4333-8333-333333333333'; // g2c, has login
const E4 = 'a4444444-4444-4444-8444-444444444444'; // g2d, has login

// origin -> the login the fake server expects (null = must never be called)
const ORIGINS = {
  'https://g1a.test': { label: 'g1a', login: ['ua', 'pa'] },
  'https://g1x.test': { label: 'g1x', login: null },
  'https://g1b.test': { label: 'g1b', login: ['ub', 'pb'] },
  'https://g2c.test': { label: 'g2c', login: ['uc', 'pc'] },
  'https://g2d.test': { label: 'g2d', login: ['ud', 'pd'] },
  'https://wasmer.test': { label: 'wasmer', login: ['admin', 'admin!'] },
  'https://nx-storage.test': { label: 'nx-storage', login: null },
};

function dbConfig(over = {}) {
  return {
    category: 'nexchats-us1',
    cdn: 'd1dncmkdpaif79.cloudfront.net',
    configured: true,
    groups: [
      { id: G1, name: 'Group 1', capacity_bytes: 1 * GB, used_bytes: 0, endpoints: [
        { id: E1, name: 'wasmer-a', base_url: 'https://g1a.test', username: 'ua', password: 'pa' },
        { id: EX, name: 'no-login', base_url: 'https://g1x.test', username: '', password: '' },
        { id: E5, name: 'wasmer-b', base_url: 'https://g1b.test/', username: 'ub', password: 'pb' },
      ] },
      { id: G2, name: 'Group 2', capacity_bytes: 100 * GB, used_bytes: 0, endpoints: [
        { id: E3, name: 'nx-storage', base_url: 'https://g2c.test', username: 'uc', password: 'pc' },
        { id: E4, name: 'spare', base_url: 'https://g2d.test', username: 'ud', password: 'pd' },
      ] },
    ],
    ...over,
  };
}

// Builds a fresh sandbox: real cloudgate.js, fake db, fake fetch, fake XHR.
function makeEnv({ db = dbConfig(), config = null, dbError = false } = {}) {
  const flags = { dbError };
  const calls = [];
  const records = [];
  const forgotten = [];
  const puts = [];
  const lookup = {};
  const srv = {};
  for (const [o, s] of Object.entries(ORIGINS)) {
    srv[o] = { ...s, down: false, full: false, badFile: false, unauth: false, has: false, browse: null, stats: null };
  }

  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(8),
  });

  async function fakeFetch(url, opts = {}) {
    const u = new URL(String(url));
    const headers = opts.headers || {};
    if (u.hostname === 'd1dncmkdpaif79.cloudfront.net') return json(404, { error: 'not in test' });
    if (u.origin === 'https://s3.test') return json(200, {});
    const spec = srv[u.origin];
    if (!spec) throw new TypeError('unknown host ' + u.origin);
    const method = opts.method || 'GET';
    calls.push({ origin: u.origin, label: spec.label, method, path: u.pathname, auth: headers.authorization || null });
    if (!spec.login) return json(500, { error: 'UNEXPECTED: this endpoint has no login and must not be called' });
    if (spec.down) throw new TypeError('fetch failed');
    const want = 'Basic ' + Buffer.from(`${spec.login[0]}:${spec.login[1]}`).toString('base64');
    if (spec.unauth || headers.authorization !== want) return json(401, { error: 'Invalid credentials' });

    const body = opts.body ? JSON.parse(opts.body) : {};
    const p = u.pathname;
    if (method === 'POST' && p === '/api/upload/presign') {
      if (spec.full) return json(507, { error: 'Insufficient storage' });
      if (spec.badFile) return json(400, { error: 'bad filename' });
      const n = calls.length;
      return json(200, {
        key: `public/u/nexchats-us1/attachments/${spec.label}-${n}-${body.filename}`,
        putUrl: `https://s3.test/put/${spec.label}/${n}`,
        contentType: 'application/octet-stream',
        publicUrl: `https://d1dncmkdpaif79.cloudfront.net/public/u/nexchats-us1/attachments/${spec.label}-${n}-${body.filename}`,
      });
    }
    if (method === 'POST' && p === '/api/upload/multipart/create') {
      if (spec.full) return json(507, { error: 'Insufficient storage' });
      const partSize = 512 * MB;
      const count = Math.ceil(body.size / partSize);
      const key = `public/u/nexchats-us1/attachments/${spec.label}-mp-${calls.length}-${body.filename}`;
      return json(200, {
        key, uploadId: 'up-' + spec.label, partSize, contentType: 'application/octet-stream',
        partUrls: Array.from({ length: count }, (_, i) => `https://s3.test/mp/${spec.label}/${i}`),
        publicUrl: `https://d1dncmkdpaif79.cloudfront.net/${key}`,
      });
    }
    if (method === 'POST' && p === '/api/upload/multipart/complete') return json(200, { key: body.key, url: 'https://d1dncmkdpaif79.cloudfront.net/' + body.key });
    if (method === 'POST' && p === '/api/upload/multipart/abort') return json(200, {});
    if (method === 'GET' && p === '/api/files/exists') return json(200, { exists: spec.has, size: spec.has ? 10 : null });
    if (method === 'DELETE' && p === '/api/files') {
      // S3 semantics: deleting a missing key still answers 200.
      if (spec.has) spec.deleted = (spec.deleted || 0) + 1;
      return json(200, { ok: true });
    }
    if (method === 'POST' && p === '/api/files/rename') {
      return json(200, { key: body.key.slice(0, body.key.lastIndexOf('/') + 1) + body.new_name });
    }
    if (method === 'GET' && p === '/api/browse') return json(200, spec.browse || { folders: [], files: [] });
    if (method === 'GET' && p === '/api/stats') return json(200, spec.stats || { folder_stats: {} });
    return json(404, { error: 'no route ' + p });
  }

  class FakeXHR {
    constructor() { this.upload = {}; this.status = 0; }
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    getResponseHeader() { return '"etag"'; }
    send(body) {
      puts.push({ url: this.url, size: body ? body.size : 0 });
      this.status = 200;
      setImmediate(() => this.onload && this.onload());
    }
    abort() {}
  }

  const fakeDb = {
    rpc(name, args = {}) {
      let res;
      if (name === 'storage_client_config') {
        res = flags.dbError ? { data: null, error: { message: 'network down' } } : { data: db, error: null };
      } else if (name === 'storage_record') {
        records.push(args);
        lookup[args.p_key] = { group_id: args.p_group, endpoint_id: args.p_endpoint, size: args.p_size };
        res = { data: null, error: null };
      } else if (name === 'storage_lookup') {
        res = { data: lookup[args.p_key] || null, error: null };
      } else if (name === 'storage_forget') {
        forgotten.push(args.p_key);
        delete lookup[args.p_key];
        res = { data: null, error: null };
      } else {
        res = { data: null, error: { message: 'unknown rpc ' + name } };
      }
      return Promise.resolve(res);
    },
  };

  const sandbox = {
    window: {
      NEXCHAT_CONFIG: { CLOUDGATE: config || { endpoints: [], category: 'nexchats-us1', cdn: 'd1dncmkdpaif79.cloudfront.net' } },
      db: fakeDb,
    },
    fetch: fakeFetch,
    XMLHttpRequest: FakeXHR,
    btoa, unescape, DOMException, URL,
    setTimeout: (fn) => setImmediate(fn), // retry back-offs run instantly
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'cloudgate.js' });
  const CG = sandbox.window.CloudGate;
  return { CG, calls, records, forgotten, puts, lookup, srv, db, flags };
}

const blob = (size) => ({ size, slice: (a, b) => ({ size: b - a }) });
const callsTo = (calls, origin, path) => calls.filter((c) => c.origin === origin && (!path || c.path === path));

(async () => {
  console.log('storage groups');

  /* 1. groups come from the database; endpoints without a login are dropped */
  {
    const { CG } = makeEnv();
    await CG.refresh();
    const groups = CG.groups();
    ok(groups.length === 2, 'two groups loaded from the database');
    ok(groups[0].endpoints.length === 2 && groups[0].endpoints.every((e) => e.user && e.pass), 'endpoint with no login is skipped (group 1 keeps 2 usable)');
    ok(groups[0].endpoints[1].base === 'https://g1b.test', 'trailing slash removed from endpoint address');
    ok(CG.endpoints().length === 4, 'four usable endpoints across both groups');
    ok(CG.category() === 'nexchats-us1', 'category from the database once confirmed');
    ok(CG.groups()[0].capacity === 1 * GB, 'capacity read as bytes');
  }

  /* 2. small file goes to group 1, first endpoint, with that endpoint's login */
  {
    const env = makeEnv();
    const out = await env.CG.upload('attachments/x', 'pic.png', blob(1 * MB));
    const pre = callsTo(env.calls, 'https://g1a.test', '/api/upload/presign');
    ok(pre.length === 1, 'small file hits group 1 endpoint 1');
    ok(pre[0].auth === 'Basic ' + Buffer.from('ua:pa').toString('base64'), 'endpoint 1 called with its own login');
    ok(out.key.includes('g1a'), 'upload result comes from endpoint 1');
    ok(env.records.length === 1 && env.records[0].p_group === G1 && env.records[0].p_endpoint === E1 && env.records[0].p_size === 1 * MB, 'upload recorded against group 1 / endpoint 1');
  }

  /* 3. a file too big for group 1 goes to group 2 (multipart stays on one endpoint) */
  {
    const env = makeEnv();
    await env.CG.upload('attachments/x', 'big.mp4', blob(2 * GB));
    ok(callsTo(env.calls, 'https://g1a.test').length === 0, 'too big for group 1: group 1 never called');
    const create = callsTo(env.calls, 'https://g2c.test', '/api/upload/multipart/create');
    const complete = callsTo(env.calls, 'https://g2c.test', '/api/upload/multipart/complete');
    ok(create.length === 1 && complete.length === 1, 'multipart created and completed on the same group 2 endpoint');
    ok(env.records[0].p_group === G2 && env.records[0].p_endpoint === E3, 'recorded against group 2 / endpoint 3');
  }

  /* 4. capacity is tracked: group 1 nearly full -> file overflows to group 2 */
  {
    const db = dbConfig();
    db.groups[0].used_bytes = 1 * GB - 500 * 1024;
    const env = makeEnv({ db });
    await env.CG.upload('attachments/x', 'pic.png', blob(1 * MB));
    ok(callsTo(env.calls, 'https://g1a.test').length === 0, 'at capacity: group 1 skipped without asking it');
    ok(callsTo(env.calls, 'https://g2c.test', '/api/upload/presign').length === 1, 'at capacity: file lands in group 2');
    ok(env.records[0].p_group === G2, 'at capacity: recorded against group 2');
  }

  /* 5. a 507 from group 1 marks it full; later uploads go straight to group 2 */
  {
    const env = makeEnv();
    env.srv['https://g1a.test'].full = true;
    env.srv['https://g1b.test'].full = true;
    await env.CG.upload('attachments/x', 'a.png', blob(1 * MB));
    await env.CG.upload('attachments/x', 'b.png', blob(1 * MB));
    const g1Calls = callsTo(env.calls, 'https://g1a.test', '/api/upload/presign').length + callsTo(env.calls, 'https://g1b.test', '/api/upload/presign').length;
    ok(g1Calls === 2, '507 on both group 1 endpoints: each tried once, then group 1 is skipped');
    ok(callsTo(env.calls, 'https://g2c.test', '/api/upload/presign').length === 2, 'both uploads overflowed to group 2');
  }

  /* 6. a dead endpoint moves to the next endpoint in the same group */
  {
    const env = makeEnv();
    env.srv['https://g1a.test'].down = true;
    const out = await env.CG.upload('attachments/x', 'a.png', blob(1 * MB));
    ok(callsTo(env.calls, 'https://g1x.test').length === 0, 'endpoint with no login never called, even on failover');
    ok(out.key.includes('g1b'), 'dead endpoint: next endpoint in group 1 takes the file');
    ok(callsTo(env.calls, 'https://g2c.test').length === 0, 'group 1 still had room: group 2 not used');
  }

  /* 7. a 401 moves on to the next endpoint; other 4xx is returned, not retried elsewhere */
  {
    const env = makeEnv();
    env.srv['https://g1a.test'].unauth = true;
    const out = await env.CG.upload('attachments/x', 'a.png', blob(1 * MB));
    ok(out.key.includes('g1b'), '401 from endpoint 1: endpoint 2 takes the file');

    const env2 = makeEnv();
    env2.srv['https://g1a.test'].badFile = true;
    let msg = '';
    try { await env2.CG.upload('attachments/x', 'a.png', blob(1 * MB)); } catch (e) { msg = e.message; }
    ok(msg === 'bad filename', 'other 4xx surfaces to the caller');
    ok(callsTo(env2.calls, 'https://g1b.test').length === 0, 'other 4xx is not retried on another endpoint');
  }

  /* 8. every group full -> a clear error, nothing called */
  {
    const db = dbConfig();
    db.groups[0].used_bytes = 1 * GB;
    db.groups[1].used_bytes = 100 * GB;
    const env = makeEnv({ db });
    let msg = '';
    try { await env.CG.upload('attachments/x', 'a.png', blob(1 * MB)); } catch (e) { msg = e.message; }
    ok(/Every storage group is full/.test(msg), 'all groups full: clear error');
    ok(env.calls.length === 0, 'all groups full: no endpoint called');
  }

  /* 9. delete goes to the endpoint that holds the file, then the record is forgotten */
  {
    const env = makeEnv();
    const key = 'public/u/nexchats-us1/attachments/x.png';
    env.lookup[key] = { group_id: G2, endpoint_id: E4, size: 10 };
    env.srv['https://g2d.test'].has = true;
    await env.CG.deleteFile(key);
    const dels = env.calls.filter((c) => c.method === 'DELETE');
    ok(dels.length === 1 && dels[0].origin === 'https://g2d.test', 'delete routed to the recorded endpoint only');
    ok(env.forgotten.includes(key), 'delete forgets the record');
  }

  /* 10. no record: delete tries the endpoints in order until one has the file */
  {
    const env = makeEnv();
    env.srv['https://g1b.test'].has = true;
    const key = 'public/u/nexchats-us1/attachments/y.png';
    await env.CG.deleteFile(key);
    const dels = env.calls.filter((c) => c.method === 'DELETE').map((c) => c.origin);
    ok(dels.join(',') === 'https://g1b.test', 'no record: checks endpoints in order, deletes only where the file is');
    ok(env.calls.filter((c) => c.path === '/api/files/exists').map((c) => c.origin).join(',') === 'https://g1a.test,https://g1b.test', 'no record: existence checked on each endpoint first');
  }

  /* 11. a stale record falls back to the other endpoints */
  {
    const env = makeEnv();
    const key = 'public/u/nexchats-us1/attachments/z.png';
    env.lookup[key] = { group_id: G2, endpoint_id: E3, size: 10 };
    env.srv['https://g2d.test'].has = true; // the file really lives on group 2 endpoint 2
    await env.CG.deleteFile(key);
    const dels = env.calls.filter((c) => c.method === 'DELETE').map((c) => c.origin);
    ok(dels.join(',') === 'https://g2d.test', 'stale record: the real copy is deleted, not a wrong endpoint');
    ok(env.calls[0].origin === 'https://g2c.test' && env.calls[0].path === '/api/files/exists', 'stale record: owner checked first');
  }

  /* 11b. file on no endpoint: delete resolves as already gone, nothing deleted */
  {
    const env = makeEnv();
    const key = 'public/u/nexchats-us1/attachments/gone.png';
    env.lookup[key] = { group_id: G1, endpoint_id: E1, size: 10 };
    const res = await env.CG.deleteFile(key);
    ok(env.calls.filter((c) => c.method === 'DELETE').length === 0, 'missing file: no delete sent (S3 would say 200 anyway)');
    ok(res && res.deleted === true && env.forgotten.includes(key), 'missing file: treated as deleted, record dropped');
  }

  /* 12. rename moves the usage record to the new key */
  {
    const env = makeEnv();
    const old = 'public/u/nexchats-us1/attachments/old.png';
    env.lookup[old] = { group_id: G1, endpoint_id: E1, size: 1234 };
    await env.CG.renameFile(old, 'new.png');
    const newKey = 'public/u/nexchats-us1/attachments/new.png';
    ok(env.lookup[newKey] && env.lookup[newKey].group_id === G1 && env.lookup[newKey].size === 1234, 'rename: usage record moved to new key, same group and size');
    ok(env.forgotten.includes(old), 'rename: old key forgotten');
  }

  /* 13. browse merges every endpoint */
  {
    const env = makeEnv();
    env.srv['https://g1a.test'].browse = { folders: ['a', 'b'], files: [{ key: 'k1', name: 'one' }] };
    env.srv['https://g1b.test'].browse = { folders: ['b'], files: [{ key: 'k1', name: 'one' }] };
    env.srv['https://g2c.test'].browse = { folders: ['c'], files: [{ key: 'k2', name: 'two' }] };
    env.srv['https://g2d.test'].browse = { folders: [], files: [] };
    const res = await env.CG.browse('');
    ok(res.folders.join(',') === 'a,b,c', 'browse: folders merged and de-duplicated');
    ok(res.files.map((f) => f.key).join(',') === 'k1,k2', 'browse: files merged, de-duplicated by key');
    ok(env.calls.some((c) => c.origin === 'https://g2c.test' && c.path === '/api/browse'), 'browse: group 2 queried too');
    ok(!env.calls.some((c) => c.origin === 'https://g1b.test' && c.path === '/api/browse'), 'browse: mirror in group 1 not queried (same storage as its sibling)');
  }

  /* 14. browse still works when one endpoint is down */
  {
    const env = makeEnv();
    env.srv['https://g1a.test'].down = true;
    env.srv['https://g2c.test'].browse = { folders: ['c'], files: [] };
    const res = await env.CG.browse('');
    ok(res.folders.join(',') === 'c', 'browse: a dead endpoint does not hide the rest');
    ok(env.calls.some((c) => c.origin === 'https://g1b.test' && c.path === '/api/browse'), 'browse: dead first mirror -> the other mirror answers group 1');
  }

  /* 15. keyOf accepts any CloudFront host, and only our category */
  {
    const { CG } = makeEnv();
    await CG.refresh();
    ok(CG.keyOf('https://abc123.cloudfront.net/public/u/nexchats-us1/attachments/x.png') === 'public/u/nexchats-us1/attachments/x.png', 'keyOf: any cloudfront host');
    ok(CG.keyOf('https://example.com/public/u/nexchats-us1/attachments/x.png') === null, 'keyOf: other host rejected');
    ok(CG.keyOf('https://abc123.cloudfront.net/public/u/other/attachments/x.png') === null, 'keyOf: other category rejected');
  }

  /* 16. no database groups -> config.js endpoints (with their own logins) */
  {
    const config = {
      endpoints: [
        { name: 'wasmer', endpoint: 'https://wasmer.test', user: 'admin', pass: 'admin!' },
        { name: 'nx-storage', endpoint: 'https://nx-storage.test' },
      ],
      category: 'nexchats-us1', cdn: 'd1dncmkdpaif79.cloudfront.net',
    };
    const env = makeEnv({ db: { configured: false, groups: [], category: 'nexchats-us1', cdn: null }, config });
    await env.CG.refresh();
    ok(env.CG.endpoints().length === 1 && env.CG.endpoints()[0].name === 'wasmer', 'config fallback: endpoint without login skipped');
    const out = await env.CG.upload('attachments/x', 'a.png', blob(1 * MB));
    ok(out.key.includes('wasmer'), 'config fallback: upload goes to wasmer');
    ok(env.calls.filter((c) => c.origin === 'https://nx-storage.test').length === 0, 'config fallback: nx-storage never called');
  }

  /* 17. database unreachable at start -> config.js fallback */
  {
    const config = { endpoints: [{ name: 'wasmer', endpoint: 'https://wasmer.test', user: 'admin', pass: 'admin!' }], category: 'nexchats-us1' };
    const env = makeEnv({ dbError: true, config });
    await env.CG.refresh();
    ok(env.CG.endpoints().length === 1, 'database error at start: config.js endpoints used');
  }

  /* 18. database read fails later -> keep the last good group list */
  {
    const env = makeEnv();
    await env.CG.refresh();
    ok(env.CG.groups().length === 2, 'loaded groups before the outage');
    env.db.rpc = () => Promise.resolve({ data: null, error: { message: 'timeout' } });
    await env.CG.refresh();
    ok(env.CG.groups().length === 2, 'database outage keeps the last good group list');
  }

  /* 18b. the database was unreachable at page load: the next upload checks again */
  {
    const env = makeEnv({ dbError: true, config: { endpoints: [{ name: 'wasmer', endpoint: 'https://wasmer.test', user: 'admin', pass: 'admin!' }], category: 'nexchats-us1' } });
    await env.CG.refresh();
    env.flags.dbError = false; // the session comes back
    const out = await env.CG.upload('attachments/x', 'a.png', blob(1 * MB));
    ok(out.key.includes('g1a') && env.records[0].p_group === G1, 'database back after a failed read: upload uses the real groups');
  }

  /* 19. admin: measure reads the endpoint's own usage for our category */
  {
    const env = makeEnv();
    env.srv['https://g1a.test'].stats = { folder_stats: { 'nexchats-us1': { size_bytes: 4242 } }, total_size_bytes: 9999 };
    const bytes = await env.CG.measure({ name: 'wasmer-a', base_url: 'https://g1a.test', username: 'ua', password: 'pa' });
    ok(bytes === 4242, 'measure: our category only');
    const last = env.calls[env.calls.length - 1];
    ok(last.auth === 'Basic ' + Buffer.from('ua:pa').toString('base64'), 'measure: uses the endpoint\'s own login');
    let bad = null;
    try { await env.CG.probe({ name: 'wasmer-a', base_url: 'https://g1a.test', username: 'ua', password: 'wrong' }); } catch (e) { bad = e; }
    ok(bad && bad.status === 401, 'probe: wrong login reported as 401');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
