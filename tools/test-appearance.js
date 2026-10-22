/* Behavioural regressions: real editors + shared renderer with mocked storage.
   Run: NODE_PATH=<test dependencies>/node_modules node tools/test-appearance.js */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const root = path.resolve(__dirname, '..');
const source = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function page(file) {
  const w = new JSDOM(source(file), { url: `https://nexchat.test/${file}?id=srv`, runScripts: 'outside-only' }).window;
  w.eval(source('assets/js/ui.js'));
  w.eval(source('assets/js/storage.js'));   // signs stored keys at render time
  w.UI.toast = () => {};
  // Wallpapers are now fetched and kept as blob URLs (device cache), so the
  // page needs fetch and createObjectURL. Record what was fetched.
  w.__fetched = [];
  w.fetch = async (url) => { w.__fetched.push(String(url)); return { ok: true, arrayBuffer: async () => new TextEncoder().encode('img').buffer }; };
  w.URL.createObjectURL = () => 'blob:nx/' + Math.random().toString(36).slice(2);
  return w;
}
function check(label, fn) { fn(); console.log('PASS ' + label); }
function mockDb(w, row) {
  const state = { patches: [], fail: false };
  w.UI.requireSession = async () => ({ user: { id: 'me' } });
  w.UI.myProfile = async () => row;
  w.db = { from(table) {
    const query = {
      select() { return query; }, eq() { return query; }, order() { return query; },
      single: async () => ({ data: row }), limit: async () => ({ data: [] }),
      update(patch) {
        state.patches.push(structuredClone(patch));
        return { eq: async () => ({ error: state.fail ? new Error('retry') : null }) };
      },
    };
    return query;
  } };
  return state;
}
(async () => {
  {
    const w = page('server.html');
    try {
      const key = 'nexchat/users/me/wallpaper-photo.png';
      let calls = 0;
      w.__nx_tp = { presign: async (got, mins) => {
        // Signed for the full 7-day SigV4 window, anchored to the start of the day.
        assert.equal(got, key); assert.equal(mins, 7 * 24 * 60); calls++;
        return 'https://storage.test/photo.png?X-Amz-Signature=fresh';
      } };
      const theme = { dash_wallpaper_key: key, dash_bg: `url('https://storage.test/bucket/${key}?X-Amz-Signature=expired')`, chat_blur: 0, chat_dim: 0 };
      await w.UI.applyBackground(theme);
      check('legacy expired wallpaper is signed from its key, not reused', () => {
        assert.equal(calls, 1);
        assert.match(w.__fetched.at(-1), /Signature=fresh/);
        assert.match(w.document.documentElement.style.getPropertyValue('--dash-bg'), /blob:/);
        assert.match(theme.dash_bg, /expired/); // never mutate stored rows with signatures
        assert(w.document.body.classList.contains('has-bg'));
      });
      await w.UI.applyBackground({ dash_wallpaper_key: key });
      check('key-only themes work and cache signatures during slider changes', () => assert.equal(calls, 1));
      check('stale legacy keys do not override presets or external images', () => {
        assert.equal(w.UI.wallpaperKey({ ...theme, dash_bg: 'linear-gradient(red, blue)' }), '');
        assert.equal(w.UI.wallpaperKey({ ...theme, dash_bg: "url('https://other.test/a.png')" }), '');
      });
      let resolve;
      w.__nx_tp.presign = () => new Promise((r) => { resolve = r; });
      const pending = w.UI.applyBackground({ dash_wallpaper_key: 'slow-key' });
      await tick();
      w.UI.applyBackground({});
      resolve('https://storage.test/slow.png');
      await pending;
      check('late signing cannot resurrect a removed wallpaper', () => {
        assert(!w.document.body.classList.contains('has-bg'));
        assert.equal(w.document.documentElement.style.getPropertyValue('--dash-bg'), '');
        assert.equal(w.document.querySelector('.dash-veil'), null);
      });
      w.__nx_tp.presign = async () => { throw new Error('offline'); };
      w.console.warn = () => {};
      await w.UI.applyBackground({ dash_wallpaper_key: 'retry-key' });
      w.__nx_tp.presign = async () => 'https://storage.test/recovered.png';
      await w.UI.applyBackground({ dash_wallpaper_key: 'retry-key' });
      check('failed signing can recover without reuploading', () => { assert.match(w.__fetched.at(-1), /recovered/); assert.match(w.document.documentElement.style.getPropertyValue('--dash-bg'), /blob:/); });
      const css = source('assets/css/theme.css');
      check('server wallpaper layers are isolated above body paint', () => {
        assert.match(css, /body\.has-bg\s*\{\s*isolation:\s*isolate/);
        assert.match(css, /body\.has-bg \.chat\s*\{[^}]*background:\s*transparent/);
        assert.match(source('assets/js/server.js'), /UI\.applyBackground\(me.theme\)/);
      });
    } finally { w.close(); }
  }
  {
    const w = page('server-settings.html');
    try {
      const state = mockDb(w, { id: 'srv', owner_id: 'me', name: 'Styled server', theme: { unrelated: true } });
      w.eval(source('assets/js/server-settings.js'));
      await tick();
      const $ = (id) => w.document.getElementById(id);
      $('sNameFont').value = 'google'; $('sNameFont').onchange({ target: $('sNameFont') });
      $('sNameFontUrl').value = '<link href="https://fonts.googleapis.com/css2?family=Rubik+Glitch&amp;display=swap" rel="stylesheet">';
      $('sNameFontUrl').oninput();
      $('sNameHex').value = '#E8659A';
      await $('btnSave').onclick();
      check('immediate paste-and-save persists custom font and hex colour', () => {
        const t = state.patches.at(-1).theme;
        assert.equal(t.name_font_url, 'https://fonts.googleapis.com/css2?family=Rubik+Glitch&display=swap');
        assert.equal(t.name_color.toLowerCase(), '#e8659a');
        assert.equal(t.unrelated, true);
        assert.match(w.document.documentElement.style.getPropertyValue('--srv-name-font'), /Rubik Glitch/);
      });
      $('sNameFontUrl').value = 'not a font'; $('sNameFontUrl').oninput();
      await $('btnSave').onclick();
      check('invalid edits cannot silently save the previous valid font', () => assert.equal(state.patches.length, 1));
      $('sNameReset').onclick();
      await $('btnSave').onclick();
      check('reset clears saved custom font and colour', () => {
        assert.equal(state.patches.at(-1).theme.name_font, 'display');
        assert.equal(state.patches.at(-1).theme.name_font_url, null);
        assert.equal(state.patches.at(-1).theme.name_color.toLowerCase(), '#ffffff');
      });
      w.URL.createObjectURL = () => 'blob:https://nexchat.test/font-preview';
      w.URL.revokeObjectURL = () => {};
      w.UI.upload = async () => 'https://storage.test/font.woff2';
      $('sNameFont').value = 'upload'; $('sNameFont').onchange({ target: $('sNameFont') });
      $('sNameFontFile').onchange({ target: { files: [new w.File(['font'], 'font.woff2')] } });
      await $('btnSave').onclick();
      check('uploaded font survives save and reset-to-saved hydration', () => {
        assert.equal(state.patches.at(-1).theme.name_font_file, 'https://storage.test/font.woff2');
        $('btnReset').onclick();
        assert.equal($('sNameFont').value, 'upload');
        assert.match(w.document.documentElement.style.getPropertyValue('--srv-name-font'), /NexFont/);
      });
    } finally { w.close(); }
  }
  {
    const w = page('profile.html');
    try {
      const state = mockDb(w, { id: 'me', username: 'tester', created_at: new Date().toISOString(), theme: {} });
      let uploads = 0;
      w.__nx_tp = { put: async () => { uploads++; return { url: 'https://storage.test/temporary?X-Amz-Signature=expired' }; }, presign: async () => 'https://storage.test/fresh.png' };
      w.eval(source('assets/js/profile.js'));
      await tick();
      const $ = (id) => w.document.getElementById(id);
      const upload = () => $('fWallpaper').onchange({ target: { files: [new w.File(['image'], 'photo.png', { type: 'image/png' })] } });
      upload();
      state.fail = true;
      await $('btnSave').onclick();
      state.fail = false;
      await $('btnSave').onclick();
      check('save/retry persists only wallpaper key, not S3 signature or local preview', () => {
        const t = state.patches.at(-1).theme;
        assert.match(t.dash_wallpaper_key, /^nexchat\/users\/me\/wallpaper-/);
        assert.equal(t.dash_bg, null);
        assert.equal(uploads, 1);
      });
      $('btnReset').onclick(); await tick();
      check('key-only profile hydrates wallpaper and does not select None', () => {
        assert.match($('wpPrev').querySelector('img').src, /^blob:/); assert.equal(w.__fetched.at(-1), 'https://storage.test/fresh.png');
        assert.equal(w.document.querySelector('.bg-preset.on'), null);
      });
      upload(); // pending local file must not override a subsequently chosen preset
      w.document.querySelectorAll('.bg-preset')[1].onclick();
      await $('btnSave').onclick();
      check('preset clears stored key and cancels pending upload', () => {
        assert.equal(state.patches.at(-1).theme.dash_wallpaper_key, null);
        assert.match(state.patches.at(-1).theme.dash_bg, /linear-gradient/);
        assert.equal(uploads, 1);
      });
      $('fBgUrl').value = 'https://images.test/external.png'; $('fBgUrl').oninput({ target: $('fBgUrl') });
      await $('btnSave').onclick();
      check('external URL remains supported without a wallpaper key', () => {
        assert.equal(state.patches.at(-1).theme.dash_bg, "url('https://images.test/external.png')");
        assert.equal(state.patches.at(-1).theme.dash_wallpaper_key, null);
      });
      w.document.querySelector('.bg-preset').onclick(); await $('btnSave').onclick();
      check('None clears both wallpaper fields', () => {
        assert.equal(state.patches.at(-1).theme.dash_bg, '');
        assert.equal(state.patches.at(-1).theme.dash_wallpaper_key, null);
      });
    } finally { w.close(); }
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
