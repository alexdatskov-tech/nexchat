/* Admin -> Storage endpoints (assets/js/admin-storage.js + the pane in admin.html).

   Drives the real pane markup and the real admin-storage.js in jsdom, against a
   small stand-in for the functions in supabase/storage_groups.sql and a stub
   CloudGate. Checks what an admin does, end to end:
     - add group 1 (100 GB), add its endpoint with a username and password
     - a missing password is refused before anything is sent
     - saving an endpoint measures what it already holds
     - once an endpoint exists, NexChat asks for the category name
     - the category is saved and every endpoint is measured again
     - editing with a blank password keeps the stored one
     - group order can be changed; deletes ask first
     - only one inline editor is open at a time

   npm i jsdom && node tools/test-admin-storage.js
*/
const { JSDOM } = require('jsdom');
const fs = require('fs');
const REPO = '/home/user/nexchat';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
const GB = 1024 * 1024 * 1024;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5)); };

const html = fs.readFileSync(REPO + '/admin.html', 'utf8');
const pane = html.match(/<section class="set-inner hidden" data-pane="endpoints">[\s\S]*?<\/section>/);
if (!pane) { console.log('  FAIL admin.html has no storage endpoints pane'); process.exit(1); }
const src = fs.readFileSync(REPO + '/assets/js/admin-storage.js', 'utf8');

// ---- stand-in database ----
const model = { category: 'nexchats-us1', cdn: null, configured: false, groups: [] };
let seq = 0;
const newId = (p) => `${p}${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
const calls = [];
const measured = [];
let listError = null;
const shape = () => JSON.parse(JSON.stringify({
  category: model.category, cdn: model.cdn, configured: model.configured,
  groups: model.groups.map((g) => ({
    id: g.id, name: g.name, capacity_gb: g.capacity_gb, capacity_bytes: g.capacity_gb * GB,
    used_bytes: g.baseline_bytes,
    baseline_bytes: g.baseline_bytes,
    measured_at: g.measured_at,
    endpoints: g.endpoints,
  })),
}));
const rpcs = {
  storage_admin_list: () => (listError ? { data: null, error: listError } : { data: shape(), error: null }),
  storage_admin_save_group: (a) => {
    if (a.p_id) { const g = model.groups.find((x) => x.id === a.p_id); g.name = a.p_name; g.capacity_gb = a.p_capacity_gb; return { data: g.id }; }
    const g = { id: newId('10'), name: a.p_name, capacity_gb: a.p_capacity_gb, endpoints: [], baseline_bytes: 0, measured_at: null };
    model.groups.push(g);
    return { data: g.id };
  },
  storage_admin_delete_group: (a) => { model.groups = model.groups.filter((g) => g.id !== a.p_id); return { data: null }; },
  storage_admin_save_endpoint: (a) => {
    if (!a.p_id && !a.p_password) return { error: { message: 'ERROR: enter the password for this endpoint' } };
    const base = a.p_base_url.replace(/\/+$/, '');
    if (a.p_id) {
      for (const g of model.groups) for (const e of g.endpoints) if (e.id === a.p_id) {
        e.name = a.p_name; e.base_url = base; e.username = a.p_username;
        if (a.p_password) e.password = a.p_password;
        return { data: e.id };
      }
      return { error: { message: 'endpoint not found' } };
    }
    const g = model.groups.find((x) => x.id === a.p_group);
    const e = { id: newId('20'), name: a.p_name, base_url: base, username: a.p_username, password: a.p_password, baseline_bytes: 0, tracked_bytes: 0, measured_at: null };
    g.endpoints.push(e);
    return { data: e.id };
  },
  storage_admin_delete_endpoint: (a) => { model.groups.forEach((g) => { g.endpoints = g.endpoints.filter((e) => e.id !== a.p_id); }); return { data: null }; },
  storage_admin_reorder_groups: (a) => { model.groups = a.p_ids.map((id) => model.groups.find((g) => g.id === id)); return { data: null }; },
  storage_admin_reorder_endpoints: (a) => {
    model.groups.forEach((g) => { g.endpoints.sort((x, y) => a.p_ids.indexOf(x.id) - a.p_ids.indexOf(y.id)); });
    return { data: null };
  },
  storage_admin_set_baseline: (a) => {
    // Endpoints are mirrors of one storage: the measurement belongs to the whole group.
    for (const g of model.groups) if (g.endpoints.some((e) => e.id === a.p_endpoint)) {
      g.baseline_bytes = Math.max(0, a.p_measured); g.measured_at = new Date().toISOString();
    }
    return { data: null };
  },
  storage_admin_set_category: (a) => {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(a.p_category)) return { error: { message: 'ERROR: category must be lowercase letters' } };
    model.category = a.p_category; model.cdn = a.p_cdn; model.configured = true;
    return { data: null };
  },
};

const dom = new JSDOM(`<!doctype html><body><div class="set-main">${pane[0]}</div></body>`, { runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.HTMLElement.prototype.scrollIntoView = () => {};
const toasts = [];
let confirmAnswer = true;
const confirms = [];
w.confirm = (m) => { confirms.push(m); return confirmAnswer; };
w.UI = {
  esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  toast: (m, isErr) => toasts.push({ m, isErr: !!isErr }),
};
w.db = { rpc: async (name, args) => { calls.push({ name, args }); const f = rpcs[name]; return f ? f(args || {}) : { data: null, error: { message: 'no stub ' + name } }; } };
w.CloudGate = {
  refresh: async () => { calls.push({ name: 'CloudGate.refresh' }); return null; },
  measure: async (ep) => { measured.push(ep.base_url); return 3.2 * GB; },
  probe: async (ep) => { if (ep.password === 'wrong') { const e = new Error('Invalid credentials'); e.status = 401; throw e; } return {}; },
};
w.eval(src);
const $ = (sel) => w.document.querySelector(sel);
const $$ = (sel) => [...w.document.querySelectorAll(sel)];
const act = (sel) => { const el = $(sel); if (!el) throw new Error('no element ' + sel); el.click(); };
const setVal = (id, v) => { const el = w.document.getElementById(id); if (!el) throw new Error('no field ' + id); el.value = v; };
const lastToast = () => toasts[toasts.length - 1] || {};
const rpcCalls = (name) => calls.filter((c) => c.name === name);

(async () => {
  console.log('admin storage endpoints');
  await w.AdminStorage.load();
  await flush();

  /* 1. empty start */
  ok(/No storage yet/.test($('#seGroups').textContent), 'empty: says there is no storage yet');
  ok(/Add a group and at least one endpoint first/.test($('#seCategory').textContent), 'empty: category step waits for an endpoint');
  ok($('#seCategory [data-act="cat-save"]').disabled, 'empty: category save is disabled');

  /* 2. add group 1 = 100 GB */
  act('[data-act="g-add"]');
  await flush();
  ok(!!$('#seEditor .se-editor') && /New group/.test($('#seEditor').textContent), 'add group: editor opens');
  setVal('sfName', 'Group 1');
  setVal('sfCap', '100');
  act('[data-act="save-group"]');
  await flush();
  ok(model.groups.length === 1 && model.groups[0].capacity_gb === 100 && model.groups[0].name === 'Group 1', 'add group: saved as Group 1, 100 GB');
  ok($('#seEditor').textContent.trim() === '', 'add group: editor closes after saving');
  ok(/0 GB of 100 GB used/.test($('#seGroups').textContent), 'add group: usage reads "0 GB of 100 GB used"');

  /* 3. endpoint without a password is refused before anything is sent */
  const g1 = model.groups[0].id;
  act(`[data-act="e-add"][data-g="${g1}"]`);
  await flush();
  setVal('sfName', 'wasmer');
  setVal('sfUrl', 'https://alexd-us1-s3.wasmer.app/');
  setVal('sfUser', 'alex');
  setVal('sfPass', '');
  const before = rpcCalls('storage_admin_save_endpoint').length;
  act('[data-act="save-endpoint"]');
  await flush();
  ok(/enter the password/i.test($('#seEditErr').textContent), 'no password: refused with a clear message');
  ok(rpcCalls('storage_admin_save_endpoint').length === before, 'no password: nothing sent to the database');

  /* 4. add the endpoint with its login: it is measured, and the category is asked for */
  setVal('sfPass', 'pw-wasmer');
  act('[data-act="save-endpoint"]');
  await flush();
  const ep1 = model.groups[0].endpoints[0];
  ok(!!ep1 && ep1.username === 'alex' && ep1.password === 'pw-wasmer' && ep1.base_url === 'https://alexd-us1-s3.wasmer.app', 'add endpoint: saved with its own login and address (trailing slash removed)');
  ok(measured.length === 1 && measured[0] === 'https://alexd-us1-s3.wasmer.app', 'add endpoint: measured right after saving');
  ok(Math.abs(model.groups[0].baseline_bytes - 3.2 * GB) < 1 && model.groups[0].measured_at, 'add endpoint: the group is measured once with what its storage already holds');
  ok(/already holds 3\.2 GB/.test(lastToast().m), 'add endpoint: toast says how much it holds');
  ok(/Next step/.test($('#seCategory').textContent) && $('#seCategory .se-next') !== null, 'after the first endpoint: NexChat asks for the category name');
  ok(w.document.activeElement && w.document.activeElement.id === 'scName', 'after the first endpoint: category field is focused');
  ok(/wasmer/.test($('#seGroups').textContent) && /login alex/.test($('#seGroups').textContent) && /password set/.test($('#seGroups').textContent), 'endpoint row shows name, login, password set (not the password)');
  ok(!/pw-wasmer/.test($('#seGroups').textContent), 'endpoint row never shows the password');

  /* 4b. a second endpoint in the same group is a mirror: the same storage, counted once */
  act(`[data-act="e-add"][data-g="${g1}"]`);
  await flush();
  setVal('sfName', 'alexaero-top1');
  setVal('sfUrl', 'https://nx-storage.alexaero.top');
  setVal('sfUser', 'alex');
  setVal('sfPass', 'pw-nx');
  act('[data-act="save-endpoint"]');
  await flush();
  ok(model.groups[0].endpoints.length === 2, 'mirror: second endpoint added to group 1');
  ok(Math.abs(model.groups[0].baseline_bytes - 3.2 * GB) < 1, 'mirror: same storage counted once (3.2 GB, not 6.4 GB)');
  ok(/3\.2 GB of 100 GB used/.test($('#seGroups').textContent), 'mirror: group header reads 3.2 GB of 100 GB used');
  ok(/mirror of this group/.test($('#seGroups').textContent), 'mirror: endpoint row says it is a mirror');

  /* 5. category: invalid name refused, valid name saved, all endpoints measured again */
  setVal('scName', 'Bad Name');
  act('[data-act="cat-save"]');
  await flush();
  ok(rpcCalls('storage_admin_set_category').length === 0 && /lowercase/.test(lastToast().m), 'category: invalid name refused before sending');
  setVal('scName', 'nexchats-us1');
  setVal('scCdn', 'd1dncmkdpaif79.cloudfront.net');
  const measuredBefore = measured.length;
  act('[data-act="cat-save"]');
  await flush();
  ok(model.configured && model.category === 'nexchats-us1' && model.cdn === 'd1dncmkdpaif79.cloudfront.net', 'category: saved and confirmed');
  ok(measured.length === measuredBefore + 1, 'category: each group measured once (its mirrors share the storage)');
  ok(!!$('#seCategory .se-cat-view') && /nexchats-us1/.test($('#seCategory').textContent) && !/Next step/.test($('#seCategory').textContent), 'category: shows as set, no longer asking');
  ok(rpcCalls('CloudGate.refresh').length >= 2, 'changes refresh the storage client');

  /* 6. edit: blank password keeps the stored one */
  act(`[data-act="e-edit"][data-id="${ep1.id}"]`);
  await flush();
  ok($('#sfPass').value === '' && /Leave blank to keep/.test($('#sfPass').placeholder), 'edit: password left blank with a hint');
  setVal('sfName', 'wasmer-a');
  setVal('sfUser', 'alex2');
  act('[data-act="save-endpoint"]');
  await flush();
  const ep1b = model.groups[0].endpoints[0];
  ok(ep1b.name === 'wasmer-a' && ep1b.username === 'alex2' && ep1b.password === 'pw-wasmer', 'edit: name and username changed, password kept');

  /* 7. login test from the editor and from a row */
  act(`[data-act="e-edit"][data-id="${ep1.id}"]`);
  await flush();
  setVal('sfPass', 'wrong');
  act('[data-act="test-form"]');
  await flush();
  ok(/Couldn’t connect: Invalid credentials/.test($('#seEditRes').textContent), 'test login in editor: shows the error under the form');
  act('[data-act="cancel"]');
  await flush();
  act(`[data-act="e-test"][data-id="${ep1.id}"]`);
  await flush();
  ok(/works/.test(lastToast().m) && !lastToast().isErr, 'test login from a row: toast on success');

  /* 8. second group, then move it first and back */
  act('[data-act="g-add"]');
  await flush();
  setVal('sfName', 'Group 2');
  setVal('sfCap', '200');
  act('[data-act="save-group"]');
  await flush();
  ok(model.groups.length === 2 && model.groups[1].name === 'Group 2' && model.groups[1].capacity_gb === 200, 'second group added (200 GB), listed after group 1');
  const g2 = model.groups[1].id;
  act(`[data-act="g-move"][data-id="${g2}"][title="Move up"]`);
  await flush();
  ok(model.groups[0].id === g2, 'reorder: group 2 moved up, now fills first');
  act(`[data-act="g-move"][data-id="${g2}"][title="Move down"]`);
  await flush();
  ok(model.groups[0].id === g1, 'reorder: moved back down');

  /* 9. only one inline editor at a time */
  act(`[data-act="e-add"][data-g="${g1}"]`);
  await flush();
  act('[data-act="g-add"]');
  await flush();
  ok($$('#seEditor .se-editor').length === 1 && /New group/.test($('#seEditor').textContent), 'one editor at a time: opening another replaces the first');
  act('[data-act="cancel"]');
  await flush();

  /* 10. delete: asks first; cancel keeps it, yes removes it */
  confirmAnswer = false;
  act(`[data-act="g-del"][data-id="${g2}"]`);
  await flush();
  ok(model.groups.length === 2 && confirms.length === 1, 'delete group: cancelled, nothing removed');
  ok(/Files already stored there stay/.test(confirms[0]), 'delete group: warns that stored files stay where they are');
  confirmAnswer = true;
  act(`[data-act="g-del"][data-id="${g2}"]`);
  await flush();
  ok(model.groups.length === 1 && model.groups[0].id === g1, 'delete group: removed when confirmed');

  act(`[data-act="e-del"][data-id="${ep1.id}"]`);
  await flush();
  ok(model.groups[0].endpoints.length === 1, 'delete endpoint: one mirror removed, the other stays');
  act(`[data-act="e-del"][data-id="${model.groups[0].endpoints[0].id}"]`);
  await flush();
  ok(model.groups[0].endpoints.length === 0 && /No endpoints in this group yet/.test($('#seGroups').textContent), 'delete endpoint: last one removed, empty group says so');

  /* 11. a database that has not been set up yet explains how */
  listError = { code: 'PGRST202', message: 'Could not find the function public.storage_admin_list' };
  await w.AdminStorage.load();
  await flush();
  ok(/storage_groups\.sql/.test($('#seGroups').textContent), 'not set up: points at supabase/storage_groups.sql');
  listError = null;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
