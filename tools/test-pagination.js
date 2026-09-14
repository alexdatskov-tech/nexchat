/* History paging + optimistic send.

   A conversation with a lot of history must open with only the latest PAGE
   messages in the DOM, fetch older ones a page at a time when the user
   scrolls up, and finish on the "beginning of the conversation" card without
   ever duplicating a row. Sending must paint a pending bubble instantly,
   leave it alone while it is in flight (the catch-up reconciler used to have
   nothing protecting it), and swap it for the real row once the insert
   lands — with the insert still going out immediately.

   Runs against the real server.js and dms.js. Needs jsdom on the module
   path:   npm i jsdom && node tools/test-pagination.js
*/
const { JSDOM } = require('jsdom');
const fs = require('fs');
const REPO = '/home/user/nexchat';

let pass = 0, fail = 0;
const ok = (cond, name) => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- a small supabase-ish mock that actually honours order/limit/lt ---- */
function makeMockDb() {
  const base = Date.now() - 10 * 24 * 3600 * 1000;   // seed in the past
  const state = {
    profiles: [
      { id: 'me', username: 'me', display_name: 'Me', avatar_url: null, accent_color: null, is_nitro: false, banner_gif_url: null, theme: null },
      { id: 'them', username: 'them', display_name: 'Them', avatar_url: null, accent_color: null, is_nitro: false, banner_gif_url: null, theme: null },
    ],
    servers: [{ id: 's1', name: 'Test', owner_id: 'me', theme: null, server_members: [{ count: 2 }] }],
    channels: [{ id: 'c1', server_id: 's1', name: 'general', type: 'text', position: 0, parent_id: null, topic: null }],
    messages: [], message_reactions: [], message_attachments: [],
    dm_conversations: [{ id: 'conv1', is_group: false, name: null }],
    dm_participants: [
      { id: 'p1', conversation_id: 'conv1', user_id: 'me' },
      { id: 'p2', conversation_id: 'conv1', user_id: 'them' },
    ],
    dm_messages: [], friendships: [],
  };
  const inserts = [];
  let seq = 0;

  const embed = (name, rows) => rows.map((r) => {
    if (name === 'dm_participants') return { ...r, profiles: state.profiles.find((p) => p.id === r.user_id) || null };
    if (name === 'messages' || name === 'dm_messages') {
      return { ...r, profiles: state.profiles.find((p) => p.id === r.author_id) || null };
    }
    return { ...r };
  });

  function tbl(name) {
    const rows = state[name] || (state[name] = []);
    const st = { f: {}, inF: {}, lt: null, gt: null, or: null, orderKey: null, orderAsc: true, lim: null };
    const num = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);
    const filt = (list) => {
      let out = list.filter((r) => Object.entries(st.f).every(([k, v]) => r[k] === v));
      for (const [c, vs] of Object.entries(st.inF)) out = out.filter((r) => vs.includes(r[c]));
      if (st.lt) out = out.filter((r) => num(r[st.lt[0]]) < num(st.lt[1]));
      if (st.gt) out = out.filter((r) => num(r[st.gt[0]]) > num(st.gt[1]));
      if (st.or) {
        const clauses = st.or.split(',').map((s) => { const [c, , v] = s.split('.'); return [c, v]; });
        out = out.filter((r) => clauses.some(([c, v]) => r[c] === v));
      }
      return out;
    };
    const finish = () => {
      let out = filt(rows);
      if (st.orderKey) out = [...out].sort((a, b) => (num(a[st.orderKey]) - num(b[st.orderKey])) * (st.orderAsc ? 1 : -1));
      if (st.lim != null) out = out.slice(0, st.lim);
      return embed(name, out);
    };
    const doInsert = async (rec) => {
      const arr = Array.isArray(rec) ? rec : [rec];
      if ((name === 'messages' || name === 'dm_messages') && DB.insertDelay) await DB.insertDelay();
      const made = arr.map((row) => ({
        id: name[0] + (++seq),
        created_at: new Date().toISOString(),
        edited_at: null,
        ...row,
      }));
      rows.push(...made);
      inserts.push({ table: name, rows: made });
      return made;
    };
    const api = {
      select() { return api; },
      eq(c, v) { st.f[c] = v; return api; },
      in(c, vs) { st.inF[c] = vs; return api; },
      lt(c, v) { st.lt = [c, v]; return api; },
      gt(c, v) { st.gt = [c, v]; return api; },
      or(s) { st.or = s; return api; },
      order(c, o) { st.orderKey = c; st.orderAsc = !(o && o.ascending === false); return api; },
      limit(n) { st.lim = n; return api; },
      single: async () => ({ data: finish()[0] || null, error: null }),
      insert(rec) {
        const run = async () => ({ data: (await doInsert(rec))[0] || null, error: null });
        return {
          select: () => ({ single: run }),
          then(res, rej) { return run().then(res, rej); },
        };
      },
      update(patch) {
        const u = { _f: {}, eq(c, v) { u._f[c] = v; return u; },
          then(res) {
            rows.forEach((r) => { if (Object.entries(u._f).every(([k, v]) => r[k] === v)) Object.assign(r, patch); });
            return Promise.resolve({ error: null }).then(res);
          } };
        return u;
      },
      delete() {
        const d = { _f: {}, eq(c, v) { d._f[c] = v; return d; },
          then(res) {
            for (let i = rows.length - 1; i >= 0; i--) {
              if (Object.entries(d._f).every(([k, v]) => rows[i][k] === v)) rows.splice(i, 1);
            }
            return Promise.resolve({ error: null }).then(res);
          } };
        return d;
      },
      upsert: async () => ({ error: null }),
      then(res, rej) { return Promise.resolve({ data: finish(), error: null }).then(res, rej); },
    };
    return api;
  }

  const ch = () => {
    const c = {
      on() { return c; },
      subscribe(cb) { setTimeout(() => cb && cb('SUBSCRIBED'), 5); return c; },
      send: async () => {}, track: async () => {}, untrack: async () => {},
    };
    return c;
  };

  const DB = {
    state, inserts,
    insertDelay: null,      // test hook: delay for message inserts (optimistic send)
    from: (t) => tbl(t),
    channel: () => ch(),
    removeChannel() {},
    rpc: async () => ({ data: null, error: null }),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }), signOut: async () => {} },
  };
  return DB;
}

function boot(htmlFile, url, db, extraScripts = []) {
  const dom = new JSDOM(fs.readFileSync(REPO + '/' + htmlFile, 'utf8'),
    { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.Voice = { state: () => ({ active: false, members: new Map() }), join: async () => {}, leave: async () => {} };
  window.Notify = { start() {}, ring() {} };
  window.__nx_tp = { put: async () => ({ url: '', type: '' }), del: async () => {} };
  window.db = db;
  for (const f of ['ui.js', 'md.js', 'viewer.js', ...extraScripts]) {
    window.eval(fs.readFileSync(`${REPO}/assets/js/${f}`, 'utf8'));
  }
  return { dom, window };
}

const ids = (window) => [...window.document.querySelectorAll('#msgs .m[data-id]')].map((el) => el.dataset.id);
const scrollUp = (window) => {
  const box = window.document.getElementById('msgs');
  box.scrollTop = 0;
  box.dispatchEvent(new window.Event('scroll'));
};

/* Seed n messages into a table, alternating authors, one second apart. */
function seed(table, n, cid, key) {
  const base = Date.now() - 10 * 24 * 3600 * 1000;
  for (let i = 0; i < n; i++) {
    table.push({
      id: 'seed' + i,
      [key]: cid,
      author_id: i % 2 ? 'them' : 'me',
      content: 'hello ' + i,
      created_at: new Date(base + i * 1000).toISOString(),
    });
  }
}

(async () => {
  /* ================= server channels ================= */
  console.log('\nserver.html — channel history paging');
  {
    const db = makeMockDb();
    seed(db.state.messages, 60, 'c1', 'channel_id');
    const { window } = boot('server.html', 'https://app.test/server.html?id=s1', db, ['server.js']);
    await sleep(400);

    const all = db.state.messages.map((m) => m.id);
    let shown = ids(window);
    ok(shown.length === 16, `opens with exactly 16 messages (got ${shown.length})`);
    ok(shown[0] === all[44] && shown[15] === all[59], 'shows the LATEST 16, newest at the bottom');
    ok(!window.document.querySelector('#msgs .msgs-top'), 'intro hidden while older pages exist');
    ok(!!window.document.querySelector('#msgs .msgs-older'), 'older-history badge present');

    scrollUp(window); await sleep(200);
    shown = ids(window);
    ok(shown.length === 32, `scroll up prepends one page (got ${shown.length})`);
    ok(shown[0] === all[28], 'older batch lands above, order preserved');
    ok(shown[shown.length - 1] === all[59], 'newest still at the bottom');

    let guard = 0;
    while (ids(window).length < 60 && guard++ < 10) { scrollUp(window); await sleep(200); }
    shown = ids(window);
    ok(shown.length === 60, `pages back to the beginning (got ${shown.length})`);
    ok(shown[0] === all[0], 'oldest message first');
    ok(!!window.document.querySelector('#msgs .msgs-top'), 'intro appears once history is exhausted');
    ok(!window.document.querySelector('#msgs .msgs-older'), 'badge removed at the beginning');

    const before = shown.length;
    scrollUp(window); await sleep(200);
    ok(ids(window).length === before, 'scrolling at the top of history loads nothing more');
    ok(new Set(ids(window)).size === ids(window).length, 'no duplicate rows after all that paging');

    // Optimistic send with a deliberately slow insert so a catch-up poll runs
    // while the pending bubble exists.
    db.insertDelay = () => sleep(1000);
    const input = window.document.getElementById('input');
    input.value = 'a fresh message';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(60);
    const pending = window.document.querySelectorAll('#msgs .m.sending');
    ok(pending.length === 1, 'pending bubble paints before the insert resolves');
    ok(pending[0]?.textContent.includes('a fresh message'), 'pending bubble shows the text');
    ok(input.value === '', 'input cleared immediately');

    await sleep(950);   // cross the 1s insert; a POLL_FAST tick (800ms) ran meanwhile
    const still = window.document.querySelectorAll('#msgs .m.sending');
    ok(still.length === 0, 'pending bubble replaced after insert resolves');
    const sent = db.inserts.filter((x) => x.table === 'messages');
    ok(sent.length === 1, `exactly one insert went out (got ${sent.length})`);
    ok(sent[0]?.rows[0]?.content === 'a fresh message', 'insert carried the message');
    const realId = sent[0]?.rows[0]?.id;
    ok(ids(window).includes(realId), 'real row rendered with its server id');
    ok(ids(window).length === 61, `now 61 rows (got ${ids(window).length})`);
    ok(ids(window)[60] === realId, 'sent message is at the bottom');
  }

  /* ================= direct messages ================= */
  console.log('\ndms.html — conversation history paging');
  {
    const db = makeMockDb();
    seed(db.state.dm_messages, 40, 'conv1', 'conversation_id');
    const { window } = boot('dms.html', 'https://app.test/dms.html?c=conv1', db, ['dms.js']);
    await sleep(500);

    const all = db.state.dm_messages.map((m) => m.id);
    let shown = ids(window);
    ok(shown.length === 16, `opens with exactly 16 messages (got ${shown.length})`);
    ok(shown[15] === all[39], 'latest message at the bottom');
    ok(!window.document.querySelector('#msgs .msgs-top'), 'intro hidden while older pages exist');

    scrollUp(window); await sleep(200);
    shown = ids(window);
    ok(shown.length === 32, `scroll up prepends one page (got ${shown.length})`);
    ok(shown[0] === all[8], 'order preserved above');

    let guard = 0;
    while (ids(window).length < 40 && guard++ < 10) { scrollUp(window); await sleep(200); }
    shown = ids(window);
    ok(shown.length === 40, `all 40 after paging (got ${shown.length})`);
    ok(!!window.document.querySelector('#msgs .msgs-top'), 'intro appears at the beginning');
    ok(new Set(ids(window)).size === 40, 'no duplicates');

    db.insertDelay = () => sleep(400);
    const input = window.document.getElementById('input');
    input.value = 'dm going out';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(50);
    ok(window.document.querySelectorAll('#msgs .m.sending').length === 1, 'pending bubble paints instantly');
    await sleep(600);
    const sent = db.inserts.filter((x) => x.table === 'dm_messages');
    ok(sent.length === 1 && sent[0].rows[0].content === 'dm going out', 'insert went out once, with the text');
    ok(sent[0].rows[0].conversation_id === 'conv1', 'insert targeted the open conversation');
    ok(sent[0].rows[0].author_id === 'me', 'insert authored by me');
    ok(window.document.querySelectorAll('#msgs .m.sending').length === 0, 'pending bubble swapped for the real row');
    ok(ids(window)[40] === sent[0].rows[0].id, 'sent dm rendered at the bottom');
  }

  console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\n*** PASS: ${pass} assertions`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
