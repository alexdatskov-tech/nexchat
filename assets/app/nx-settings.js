/* User settings (#/settings/<tab>): account, profile, appearance, Nitro,
   Nitro shop, My Drive, notifications, voice & video, advanced. */
(function () {
  const { esc } = NX;
  const P = () => NX.people;
  let host = null, pg = null, tab = 'profile';
  let draft = null, saved = null;
  const uploading = new Map();   // draft key (avatar_url, banner_url) -> its upload, while it runs

  const ACCENTS = ['#5865F2', '#7C6CFF', '#A78BFA', '#E8659A', '#F2555A', '#F0B232', '#2FBF87', '#3B9EF5', '#5AC8D8', '#94A3B8'];
  const BG_PRESETS = [
    { n: 'None', v: '' },
    { n: 'Nebula', v: 'radial-gradient(80% 80% at 80% 10%,#3b1d6e,transparent 60%),radial-gradient(70% 70% at 10% 90%,#0e4d5c,transparent 60%),#07080c' },
    { n: 'Aurora', v: 'radial-gradient(90% 70% at 20% 0%,#0f5c46,transparent 60%),radial-gradient(80% 80% at 100% 100%,#2c1b5e,transparent 60%),#07090c' },
    { n: 'Sunset', v: 'radial-gradient(90% 90% at 0% 100%,#7a2c3e,transparent 60%),radial-gradient(80% 80% at 100% 0%,#3a2a7a,transparent 60%),#0b0910' },
    { n: 'Ember', v: 'linear-gradient(135deg,#3A1D14,#2A1520 60%,#161018)' },
    { n: 'Deep sea', v: 'linear-gradient(135deg,#0A1A2F,#0B1220 60%,#0A0A12)' },
    { n: 'Moss', v: 'linear-gradient(135deg,#16281B,#101E23 60%,#0D1014)' },
    { n: 'Dusk', v: 'radial-gradient(120% 100% at 20% 0%,#2B2246,#141222 55%,#0B0A11)' },
  ];
  const NS_FONTS = [['normal', 'Normal'], ['bold', 'Bold'], ['script', 'Script'], ['double', 'Double'], ['ascii', 'ASCII art']];
  const NS_PRESETS = [
    { n: 'Rainbow', s: { font: 'ascii' } },
    { n: 'Gold', s: { font: 'bold', color: '#F5B94A', color2: '#FF7A59', glow: '#F5B94A', bold: true, shimmer: true } },
    { n: 'Aurora', s: { font: 'normal', color: '#3DDC97', color2: '#4F9DFF', glow: '#3DDC97', shimmer: true, bold: true } },
    { n: 'Neon', s: { font: 'script', color: '#FF4D8D', glow: '#FF4D8D' } },
    { n: 'Ice', s: { font: 'double', color: '#5AC8D8', color2: '#A78BFA', shimmer: true } },
    { n: 'Terminal', s: { font: 'ascii', color: '#3DDC97', glow: '#3DDC97' } },
    { n: 'Sunset', s: { font: 'bold', color: '#FF7A59', color2: '#E8659A', shimmer: true, bold: true } },
    { n: 'Plain', s: { font: 'normal' } },
  ];
  const HALO_EGS = [
    { n: 'Prism', css: 'background: conic-gradient(from 0deg,#F0F,#0FF,#FF0,#F0F); animation: spin 2.4s linear infinite;' },
    { n: 'Ember', css: 'background: conic-gradient(from 90deg,#E8B04B,#FFE9A8,#C98A20,#E8B04B); animation: spin 6s linear infinite;' },
    { n: 'Tide', css: 'background: linear-gradient(135deg,#2FBF87,#3B9EF5); animation: pulse 2s ease-in-out infinite;' },
    { n: 'Neon', css: 'background: #E8659A; box-shadow: 0 0 9px 2px rgba(232,101,154,.8);' },
  ];

  /* ---------- draft handling (profile, appearance and Nitro share one save) ---------- */
  const EDIT_KEYS = ['display_name', 'bio', 'custom_status', 'accent_color', 'avatar_url', 'banner_url', 'banner_gif_url', 'theme'];
  const DRAFT_TABS = ['profile', 'appearance', 'nitro'];
  function snapshot() {
    const me = NX.me, out = {};
    EDIT_KEYS.forEach((k) => { out[k] = k === 'theme' ? JSON.parse(JSON.stringify(me.theme || {})) : (me[k] ?? null); });
    return out;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function touch() {
    pg.dirty(!same(draft, saved) && DRAFT_TABS.includes(tab), { onSave: save, onReset: reset });
    previewTheme();
  }
  function reset() {
    draft = JSON.parse(JSON.stringify(saved));
    pg.dirty(false);
    NX.applyTheme();
    render();
  }
  async function save() {
    // Save during an upload: wait for it, so the picture saved is the uploaded one.
    if (uploading.size) {
      NX.toast('Finishing your upload…');
      await Promise.allSettled([...uploading.values()]);
      await NX.sleep(0);
    }
    const patch = {};
    EDIT_KEYS.forEach((k) => { if (!same(draft[k], saved[k])) patch[k] = draft[k]; });
    // A local preview never leaves this tab (nobody else could load it).
    ['avatar_url', 'banner_url', 'banner_gif_url'].forEach((k) => { if (/^(blob|data|file):/i.test(patch[k] || '')) delete patch[k]; });
    if (!Object.keys(patch).length) { pg.dirty(!same(draft, saved), { onSave: save, onReset: reset }); return; }
    if ('display_name' in patch) patch.display_name = (patch.display_name || '').trim() || NX.me.username;
    if ('bio' in patch) patch.bio = (patch.bio || '').trim() || null;
    if ('custom_status' in patch) patch.custom_status = (patch.custom_status || '').trim() || null;
    if (patch.theme?.halo_css && !P().haloCss({ theme: { dev_mode: true, halo_css: patch.theme.halo_css } })) throw new Error('That halo CSS isn’t allowed: plain declarations only, no braces or url().');
    const { error } = await window.db.from('profiles').update(patch).eq('id', NX.me.id);
    if (error) throw error;
    Object.assign(NX.me, patch);
    P().put({ id: NX.me.id, ...patch });
    saved = snapshot();
    draft = JSON.parse(JSON.stringify(saved));
    pg.dirty(false);
    NX.emit('me');
    NX.toast('Saved.');
    paintBrand();
    render();
  }
  // Appearance edits preview live on the whole app behind the page.
  function previewTheme() {
    const real = NX.me.theme;
    NX.me.theme = draft.theme;
    NX.applyTheme();
    NX.me.theme = real;
  }
  const person = () => ({ ...NX.me, ...draft, is_nitro: NX.me.is_nitro, theme: { ...(NX.me.theme || {}), ...draft.theme } });
  const setTheme = (k, v) => { draft.theme[k] = v; touch(); };

  /* ---------- tabs ---------- */
  const TABS = () => [
    { title: 'User settings', items: [
      { id: 'account', label: 'My account', icon: 'fa-circle-user', tint: '#3b9ef5' },
      { id: 'profile', label: 'Profile', icon: 'fa-id-badge', tint: '#7c6cff' },
      { id: 'drive', label: 'My Drive', icon: 'fa-hard-drive', tint: '#5ac8d8' },
    ] },
    { title: 'Nitro', items: [
      { id: 'nitro', label: NX.me.is_nitro ? 'Nitro' : 'Get Nitro', icon: 'fa-bolt', tint: '#f0b232', badge: NX.me.is_nitro ? '' : 'New' },
      { id: 'shop', label: 'Nitro shop', icon: 'fa-bag-shopping', tint: '#e8659a', hidden: !NX.me.is_nitro },
    ] },
    { title: 'App settings', items: [
      { id: 'appearance', label: 'Appearance', icon: 'fa-palette', tint: '#a78bfa' },
      { id: 'notifications', label: 'Notifications', icon: 'fa-bell', tint: '#f2555a' },
      { id: 'voice', label: 'Voice & video', icon: 'fa-microphone', tint: '#2fbf87' },
      { id: 'advanced', label: 'Advanced', icon: 'fa-code', tint: '#94a3b8' },
    ] },
    { title: '', items: [{ id: 'logout', label: 'Log out', icon: 'fa-right-from-bracket', danger: true }] },
  ];
  function brandHtml() {
    const me = NX.me;
    return `<div class="pb-banner" data-bbanner></div><div class="pb-row">${P().avatar(me, 52, { presence: true })}
      <div class="pb-t"><b>${P().nameText(me)}</b><small>@${esc(me.username)}</small></div>
      <button class="btn btn-ghost btn-sm" data-brand-edit>Edit</button></div>`;
  }
  function paintBrand() {
    const b = host?.querySelector('.pg-brand');
    if (!b) return;
    b.innerHTML = brandHtml();
    const bn = b.querySelector('[data-bbanner]');
    const ac = /^#[0-9a-f]{6}$/i.test(NX.me.accent_color || '') ? NX.me.accent_color : '#5865F2';
    bn.style.background = `linear-gradient(135deg, ${ac}, color-mix(in srgb, ${ac} 25%, #0e0f13))`;
    if (NX.me.banner_url) NX.files.resolved(NX.me.banner_url).then((u) => { bn.style.background = `url("${u}") center / cover`; }).catch(() => {});
    b.querySelector('[data-brand-edit]').onclick = () => { if (pg.guard()) NX.go('settings/profile', { replace: true }); };
  }

  function enter(h, parts) {
    host = h;
    saved = snapshot();
    draft = JSON.parse(JSON.stringify(saved));
    tab = parts[1] || 'profile';
    pg = NX.pageShell(host, {
      sections: TABS(), active: tab, kind: 'settings', brand: brandHtml(), startOnNav: !parts[1],
      onSelect: (id) => { if (id === 'logout') return NX.signOut(); NX.go('settings/' + id, { replace: true }); },
    });
    paintBrand();
    render();
  }
  function update(parts) {
    const next = parts[1] || 'profile';
    if (next === tab) { if (parts[1]) pg.setActive(tab); return; }
    tab = next;
    pg.setActive(tab);
    render();
  }
  function leave() {
    if (draft && !same(draft.theme, saved?.theme)) NX.applyTheme();
    window.Drive?.unmount?.();
    host = null; pg = null;
  }

  function render() {
    if (!pg) return;
    const b = pg.body;
    b.classList.toggle('wide', tab === 'drive' || tab === 'shop');
    b.innerHTML = '';
    ({ account, profile, appearance, nitro, shop, drive, notifications, voice, advanced }[tab] || profile)(b);
    if (DRAFT_TABS.includes(tab)) touch(); else pg.dirty(false);
  }
  const hero = (o) => pg.hero(o);

  /* ---------- profile card (preview + account page) ---------- */
  function cardInner(p, { editable = false } = {}) {
    const accent = /^#[0-9a-f]{6}$/i.test(p.accent_color || '') ? p.accent_color : '#5865F2';
    const deco = P().decoPath(p, 'bio');
    return `${deco ? `<div class="card-deco" aria-hidden="true">${P().decoImg(deco, '')}</div>` : ''}
      <div class="pc-banner" style="background:linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 30%, #0e0f13))" ${p.banner_url ? `data-bg="${esc(p.banner_url)}"` : ''}>${editable ? '<label class="pc-edit"><i class="fa-solid fa-camera"></i>Change banner<input type="file" accept="image/*" hidden data-up="banner_url"></label>' : ''}</div>
      <div class="pc-av">${P().avatar(p, 88)}${editable ? '<label class="pc-edit"><i class="fa-solid fa-camera"></i><input type="file" accept="image/*" hidden data-up="avatar_url"></label>' : ''}</div>
      <div class="pc-body"><div class="pc-name">${P().bigName(p)}</div>
        <div class="pc-handle">@${esc(p.username)} ${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i>Nitro</span>' : ''} ${P().roleBadge(p)}</div>
        ${p.custom_status ? `<div style="font-size:13.5px">${esc(p.custom_status)}</div>` : ''}
        ${p.bio ? `<div class="pc-bio">${esc(p.bio)}</div>` : ''}
        <div class="pc-since"><b>Member since</b><span>${new Date(p.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></div>`;
  }
  function hydrateCard(root) {
    root.querySelectorAll('.pcard').forEach((c) => { const d = !!c.querySelector('.card-deco'); c.classList.toggle('has-deco', d); c.classList.toggle('card-deco-host', d); });
    root.querySelectorAll('[data-bg]').forEach((el) => {
      const u = el.dataset.bg;
      const set = (x) => { el.style.background = `url("${String(x).replace(/"/g, '%22')}") center / cover`; };
      if (/^blob:/.test(u)) set(u); else NX.files.resolved(u).then(set).catch(() => set(u));
    });
  }

  /* ---------- My account ---------- */
  function account(b) {
    const me = NX.me;
    b.innerHTML = `<h1 class="page-title">My account</h1><p class="lead">Your sign-in details and account security.</p>
      <div class="acct-grid"><div class="pcard">${cardInner(me)}</div>
      <div class="card"><div class="set-row"><span class="ri"><i class="fa-solid fa-signature"></i></span><div class="info"><b>Display name</b><small>${P().nameText(me)}</small></div><button class="btn btn-ghost btn-sm" data-go="profile">Edit</button></div>
        <div class="set-row"><span class="ri"><i class="fa-solid fa-at"></i></span><div class="info"><b>Username</b><small>@${esc(me.username)} · can’t be changed</small></div><button class="btn btn-ghost btn-sm" data-a="copy">Copy</button></div>
        <div class="set-row"><span class="ri"><i class="fa-solid fa-calendar"></i></span><div class="info"><b>Member since</b><small>${new Date(me.created_at).toLocaleDateString([], { dateStyle: 'long' })}</small></div></div>
        <div class="set-row"><span class="ri"><i class="fa-solid fa-hard-drive"></i></span><div class="info"><b>Drive storage</b><small>${Number(me.drive_quota_gb) || 5} GB</small></div><button class="btn btn-ghost btn-sm" data-go="drive">Open</button></div>
        ${P().rank(me) ? `<div class="set-row"><span class="ri"><i class="fa-solid fa-shield-halved"></i></span><div class="info"><b>NexChat role</b><small>${P().roleBadge(me)}</small></div><a class="btn btn-ghost btn-sm" href="#/admin">Console</a></div>` : ''}</div></div>
      <h2 class="sec-title" style="margin-top:28px"><i class="fa-solid fa-key"></i> Password</h2>
      <div class="card"><form class="stack" data-f="pw">
        <div class="field-row"><div class="field"><label>New password</label><input type="password" autocomplete="new-password" minlength="8" required data-p1></div>
        <div class="field"><label>Confirm new password</label><input type="password" autocomplete="new-password" required data-p2></div></div>
        <p class="hint">There’s no email recovery, so don’t lose the new one.</p><p class="err"></p>
        <div><button class="btn btn-primary">Change password</button></div></form></div>
      <h2 class="sec-title" style="margin-top:28px"><i class="fa-solid fa-triangle-exclamation"></i> Account removal</h2>
      <div class="card danger-card"><h3>Delete account</h3><p>This permanently removes your account, your servers, messages and friends. It can’t be undone.</p>
        <form class="stack" data-f="del"><div class="field"><label>Enter your password to confirm</label><input type="password" autocomplete="current-password" data-dp></div><p class="err"></p>
        <div><button class="btn btn-danger">Delete account</button></div></form></div>`;
    hydrateCard(b);
    b.querySelectorAll('[data-go]').forEach((x) => { x.onclick = () => NX.go('settings/' + x.dataset.go, { replace: true }); });
    b.querySelector('[data-a="copy"]').onclick = () => NX.copy('@' + me.username, 'Username copied');
    b.querySelector('[data-f="pw"]').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, err = f.querySelector('.err');
      const a = f.querySelector('[data-p1]').value, c = f.querySelector('[data-p2]').value;
      err.textContent = '';
      if (a.length < 8) return (err.textContent = 'Use at least 8 characters.');
      if (a !== c) return (err.textContent = 'Those don’t match.');
      const btn = f.querySelector('.btn'); btn.classList.add('busy');
      const { error } = await window.db.auth.updateUser({ password: a });
      btn.classList.remove('busy');
      if (error) return (err.textContent = error.message);
      f.reset(); NX.toast('Password changed.');
    };
    b.querySelector('[data-f="del"]').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target, err = f.querySelector('.err');
      const pass = f.querySelector('[data-dp]').value;
      err.textContent = '';
      if (!pass) return (err.textContent = 'Enter your password to continue.');
      if (!await NX.confirm({ title: 'Delete your account?', body: 'Everything goes: servers you own, messages, friends and your profile. This can’t be undone.', ok: 'Delete my account', danger: true })) return;
      const btn = f.querySelector('.btn'); btn.classList.add('busy');
      try {
        const { error } = await window.db.auth.signInWithPassword({ email: `${me.username.toLowerCase()}@users.nexchat-app.com`, password: pass });
        if (error) throw new Error('Wrong password.');
        const { error: e2 } = await window.db.rpc('delete_my_account');
        if (e2) throw e2;
        await window.db.auth.signOut().catch(() => {});
        NX.reload();
      } catch (ex) { err.textContent = ex.message || 'Could not delete the account.'; btn.classList.remove('busy'); }
    };
  }

  /* ---------- Profile ---------- */
  function profile(b) {
    const nitro = NX.me.is_nitro;
    b.innerHTML = `<h1 class="page-title">Profile</h1><p class="lead">How you appear to everyone on NexChat. Click your avatar or banner in the preview to change them.</p>
      <div class="two-col"><div class="stack">
        <div class="card"><div class="stack">
          <div class="field"><label>Display name</label><input class="input" maxlength="60" data-k="display_name" placeholder="${esc(NX.me.username)}"></div>
          <div class="field"><label>Custom status</label><input class="input" maxlength="128" data-k="custom_status" placeholder="What’s happening?"></div>
          <div class="field"><label>About me</label><textarea class="input" rows="4" maxlength="500" data-k="bio" placeholder="A line or two about you. Markdown isn’t needed."></textarea><span class="hint" style="text-align:right"><span data-count>0</span>/500</span></div>
        </div></div>
        <div class="card"><h3><i class="fa-solid fa-image"></i> Avatar & banner</h3><p>Square images work best for avatars. Uploads are resized and optimised automatically.</p>
          <div class="row" style="flex-wrap:wrap;gap:8px">
            <label class="btn btn-primary btn-sm"><i class="fa-solid fa-upload"></i>Change avatar<input type="file" accept="image/*" hidden data-up="avatar_url"></label>
            <button class="btn btn-ghost btn-sm" data-clear="avatar_url">Remove avatar</button>
            <span style="width:12px"></span>
            <label class="btn btn-ghost btn-sm"><i class="fa-solid fa-panorama"></i>Change banner<input type="file" accept="image/*" hidden data-up="banner_url"></label>
            <button class="btn btn-quiet btn-sm" data-clear="banner_url">Remove banner</button></div></div>
        <div class="card"><h3><i class="fa-solid fa-droplet"></i> Profile colour</h3><p>Colours your banner when you don’t have one, and your default avatar.</p>
          <div class="swatches" data-sw>${ACCENTS.map((c) => `<span class="swatch" data-c="${c}" style="background:${c};color:${c}" title="${c}"></span>`).join('')}<label class="swatch custom" title="Custom colour"><input type="color" data-color></label></div></div>
        <div class="card glow" style="--t:var(--nitro)"><h3><i class="fa-solid fa-wand-magic-sparkles" style="color:var(--nitro)"></i> Nitro extras</h3>
          <p>${nitro ? 'Avatar frames, profile banners, name styles and an animated halo.' : 'Get an animated halo, styled names, avatar frames and profile banners.'}</p>
          <div class="row" style="flex-wrap:wrap;gap:8px">${nitro ? '<button class="btn btn-ghost btn-sm" data-go="shop"><i class="fa-solid fa-bag-shopping"></i>Avatar frames & banners</button><button class="btn btn-ghost btn-sm" data-go="nitro"><i class="fa-solid fa-font"></i>Name style & halo</button>' : '<button class="btn btn-primary btn-sm" data-go="nitro" style="background:var(--nitro);color:#241800"><i class="fa-solid fa-bolt"></i>Get Nitro</button>'}</div></div>
      </div>
      <div class="sticky"><h2 class="sec-title" style="margin-top:0">Preview</h2><div class="pcard" data-preview></div></div></div>`;
    const set = (k, v) => { draft[k] = v; paintPreview(); touch(); };
    b.querySelectorAll('[data-k]').forEach((el) => {
      el.value = draft[el.dataset.k] || '';
      el.addEventListener('input', () => { set(el.dataset.k, el.value); if (el.dataset.k === 'bio') b.querySelector('[data-count]').textContent = el.value.length; });
    });
    b.querySelector('[data-count]').textContent = (draft.bio || '').length;
    b.querySelectorAll('[data-go]').forEach((x) => { x.onclick = () => { if (pg.guard()) NX.go('settings/' + x.dataset.go, { replace: true }); }; });
    b.addEventListener('change', async (e) => {
      const inp = e.target.closest('[data-up]');
      if (!inp) return;
      const f = inp.files[0]; inp.value = '';
      if (!f) return;
      const key = inp.dataset.up;
      const before = draft[key];
      // the preview shows at once; only the uploaded URL ever goes into a save
      const preview = P().localUrl(f);
      draft[key] = preview; paintPreview();
      const job = NX.files.uploadImage(f, `users/${NX.me.id}`, { max: key === 'avatar_url' ? 512 : 1600 });
      uploading.set(key, job);
      try {
        const up = await job;
        if (draft[key] === preview) set(key, up.url);   // not if another picture or a reset came after
      } catch (err) {
        if (draft[key] === preview) { draft[key] = before; paintPreview(); }
        NX.fail(err, 'Upload failed');
      } finally {
        if (uploading.get(key) === job) uploading.delete(key);
      }
    });
    b.querySelectorAll('[data-clear]').forEach((x) => { x.onclick = () => set(x.dataset.clear, null); });
    const paintSw = () => {
      const cur = (draft.accent_color || '').toLowerCase();
      b.querySelectorAll('.swatch[data-c]').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === cur));
      const custom = b.querySelector('.swatch.custom');
      const isCustom = cur && !ACCENTS.some((c) => c.toLowerCase() === cur);
      custom.classList.toggle('on', isCustom);
      custom.style.background = isCustom ? cur : '';
      b.querySelector('[data-color]').value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#5865f2';
    };
    b.querySelector('[data-sw]').addEventListener('click', (e) => { const s = e.target.closest('.swatch[data-c]'); if (s) { set('accent_color', s.dataset.c); paintSw(); } });
    b.querySelector('[data-color]').addEventListener('input', (e) => { set('accent_color', e.target.value); paintSw(); });
    paintSw();
    paintPreview();
  }
  function paintPreview() {
    const el = pg?.body.querySelector('[data-preview]');
    if (!el) return;
    el.innerHTML = cardInner(person(), { editable: tab === 'profile' });
    hydrateCard(el.parentElement);
  }

  /* ---------- Appearance ---------- */
  function appearance(b) {
    const t = draft.theme;
    const cur = () => (draft.theme.dash_wallpaper_key ? '__key' : (draft.theme.dash_bg || ''));
    const urlVal = (cur().match(/^url\(\s*["']?(.*?)["']?\s*\)$/) || [])[1] || '';
    b.innerHTML = `<h1 class="page-title">Appearance</h1><p class="lead">Make NexChat yours. Changes preview live behind this page and sync to every device.</p>
      <div class="two-col"><div class="stack">
      <div class="card"><h3>Interface</h3><p>How NexChat looks and feels overall. Switch back any time.</p>
        <div class="opt-grid" data-layout>
          <button class="opt-card" data-v="modern"><span class="oc-prev ui-prev-modern"><i></i><i></i><i></i></span><b>NexChat 3</b><small>The new look, with the Home dashboard and softer panels.</small></button>
          <button class="opt-card" data-v="classic"><span class="oc-prev ui-prev-classic"><i></i><i></i><i></i></span><b>Classic</b><small>The original NexChat look, rebuilt: black chat, violet highlights, pill composer.</small></button>
        </div></div>
      <div class="card"><h3>Theme</h3><p>How panels are drawn. <span class="muted" data-classic-note hidden>Classic always uses its own flat panels; this applies to NexChat 3.</span></p>
        <div class="opt-grid" data-style>
          <button class="opt-card" data-v="solid"><span class="oc-prev theme-solid"><i></i><i></i><i></i></span><b>Midnight</b><small>Solid, crisp, easy on battery.</small></button>
          <button class="opt-card" data-v="glass"><span class="oc-prev theme-glass"><i></i><i></i><i></i></span><b>Liquid glass</b><small>Frosted panels that float over your wallpaper.</small></button>
        </div></div>
      <div class="card"><h3>Accent colour</h3><p>Buttons, highlights and links across the app. Servers with their own accent still use theirs.</p>
        <div class="swatches" data-acc>${['', ...ACCENTS].map((c) => `<span class="swatch${c ? '' : ' def'}" data-c="${c}" style="${c ? `background:${c};color:${c}` : ''}" title="${c || 'Default'}">${c ? '' : '<i class="fa-solid fa-rotate-left"></i>'}</span>`).join('')}<label class="swatch custom" title="Custom"><input type="color" data-acc-custom></label></div></div>
      <div class="card"><h3>Background</h3><p>Shown behind everything. Pick a scene, upload your own, or paste a link.</p>
        <div class="opt-grid bg-grid" data-bgp>${BG_PRESETS.map((p) => `<button class="opt-card" data-v="${esc(p.v)}"><span class="oc-prev" style="background:${p.v || 'var(--bg-2)'}">${p.v ? '' : '<i class="fa-solid fa-ban" style="color:var(--txt-3)"></i>'}</span><b>${p.n}</b></button>`).join('')}
          <label class="opt-card" data-up><span class="oc-prev" data-wp><i class="fa-solid fa-cloud-arrow-up" style="color:var(--txt-3);font-size:20px"></i></span><b>Your image</b><input type="file" accept="image/*" hidden></label></div>
        <div class="field" style="margin-top:12px"><label>Image link</label><input class="input" data-url placeholder="https://…/wallpaper.jpg" value="${esc(cur() !== '__key' ? urlVal : '')}"></div>
        <div class="stack" style="margin-top:14px">${range('Brightness', 'dash_bright', 20, 200, 100, '%')}${range('Darken', 'dash_dim', 0, 95, 0, '%')}${range('Blur', 'dash_blur', 0, 30, 0, 'px')}</div></div>
      <div class="card"><h3>Chat</h3><p>Readability of messages over your background.</p>
        <div class="stack">${range('Chat blur', 'chat_blur', 0, 30, t.ui_style === 'glass' ? 5 : 12, 'px')}${range('Chat darken', 'chat_dim', 0, 95, 42, '%')}${range('Message text size', 'chat_fs', 12, 20, 15, 'px')}
          <div class="field"><label>Message display</label><div class="seg" data-density><button type="button" data-v="cozy">Cozy</button><button type="button" data-v="compact">Compact</button></div></div>
          <label class="toggle-row"><div class="info"><b>Reduce motion</b><small>Turns off animations like shimmering names and spinning halos.</small></div><input type="checkbox" class="switch" data-motion></label></div></div>
      </div>
      <div class="sticky"><h2 class="sec-title" style="margin-top:0">Preview</h2><div class="look-prev" data-look></div></div></div>`;
    const paintSel = () => {
      b.querySelectorAll('[data-style] .opt-card').forEach((c) => c.classList.toggle('on', c.dataset.v === (draft.theme.ui_style === 'glass' ? 'glass' : 'solid')));
      b.querySelectorAll('[data-layout] .opt-card').forEach((c) => c.classList.toggle('on', c.dataset.v === (draft.theme.ui_layout === 'classic' ? 'classic' : 'modern')));
      b.querySelector('[data-classic-note]').hidden = draft.theme.ui_layout !== 'classic';
      const c = cur();
      b.querySelectorAll('[data-bgp] .opt-card[data-v]').forEach((x) => x.classList.toggle('on', x.dataset.v === c));
      const isImg = /^url\(/.test(c) || c === '__key';
      b.querySelector('[data-up]').classList.toggle('on', isImg);
      if (isImg && /^url\(/.test(c)) { const wp = b.querySelector('[data-wp]'); wp.style.background = `${c} center / cover`; wp.innerHTML = ''; }
      const acc = (draft.theme.ui_accent || '').toLowerCase();
      b.querySelectorAll('[data-acc] .swatch[data-c]').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === acc));
      const cu = b.querySelector('[data-acc] .swatch.custom');
      const isCustom = acc && !ACCENTS.some((x) => x.toLowerCase() === acc);
      cu.classList.toggle('on', isCustom); cu.style.background = isCustom ? acc : '';
      b.querySelectorAll('[data-density] button').forEach((x) => x.classList.toggle('on', x.dataset.v === (draft.theme.density === 'compact' ? 'compact' : 'cozy')));
      b.querySelector('[data-motion]').checked = !!draft.theme.reduce_motion;
      paintLook(b.querySelector('[data-look]'));
    };
    b.querySelector('[data-style]').onclick = (e) => { const c = e.target.closest('[data-v]'); if (!c) return; setTheme('ui_style', c.dataset.v); paintSel(); };
    b.querySelector('[data-layout]').onclick = (e) => { const c = e.target.closest('[data-v]'); if (!c) return; setTheme('ui_layout', c.dataset.v === 'classic' ? 'classic' : null); paintSel(); };
    b.querySelector('[data-acc]').addEventListener('click', (e) => { const s = e.target.closest('.swatch[data-c]'); if (!s) return; setTheme('ui_accent', s.dataset.c || null); paintSel(); });
    b.querySelector('[data-acc-custom]').addEventListener('input', (e) => { setTheme('ui_accent', e.target.value); paintSel(); });
    b.querySelector('[data-density]').onclick = (e) => { const x = e.target.closest('[data-v]'); if (!x) return; setTheme('density', x.dataset.v); paintSel(); };
    b.querySelector('[data-motion]').onchange = (e) => { setTheme('reduce_motion', e.target.checked); paintSel(); };
    b.querySelector('[data-bgp]').addEventListener('click', (e) => {
      const c = e.target.closest('.opt-card[data-v]'); if (!c) return;
      draft.theme.dash_bg = c.dataset.v || null; draft.theme.dash_wallpaper_key = null;
      b.querySelector('[data-url]').value = '';
      touch(); paintSel();
    });
    b.querySelector('[data-up] input').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      if (f.size > 25 * 1024 * 1024) return NX.toast('That image is over 25 MB.', { err: true });
      const wp = b.querySelector('[data-wp]');
      wp.innerHTML = '<span class="spinner"></span>';
      try {
        const up = await NX.files.uploadImage(f, `users/${NX.me.id}`, { max: 2560 });
        draft.theme.dash_bg = `url("${up.url}")`; draft.theme.dash_wallpaper_key = null;
        b.querySelector('[data-url]').value = '';
        touch(); paintSel();
      } catch (err) { wp.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i>'; NX.fail(err, 'Upload failed'); }
    };
    b.querySelector('[data-url]').addEventListener('input', NX.debounce((e) => {
      const u = e.target.value.trim();
      if (u && !/^https:\/\//i.test(u)) return;
      draft.theme.dash_bg = u ? `url("${u.replace(/"/g, '%22')}")` : null; draft.theme.dash_wallpaper_key = null;
      touch(); paintSel();
    }, 300));
    b.querySelectorAll('[data-range]').forEach((r) => {
      const out = r.parentElement.querySelector('span');
      r.addEventListener('input', () => { draft.theme[r.dataset.range] = +r.value; out.textContent = r.value + r.dataset.unit; touch(); paintLook(b.querySelector('[data-look]')); });
    });
    paintSel();
  }
  function range(label, key, min, max, def, unit) {
    const v = draft.theme[key] ?? def;
    return `<div class="field"><label>${label}</label><div class="range-row"><input type="range" min="${min}" max="${max}" value="${v}" data-range="${key}" data-unit="${unit}"><span>${v}${unit}</span></div></div>`;
  }
  // A tiny mock of the app with the draft look applied.
  function paintLook(el) {
    if (!el) return;
    const t = draft.theme, p = person();
    const bg = t.dash_bg || 'var(--bg-0)';
    const acc = t.ui_accent || 'var(--accent)';
    const glass = t.ui_style === 'glass' && t.dash_bg;
    el.className = 'look-prev' + (glass ? ' is-glass' : '');
    el.style.setProperty('--lp-acc', acc);
    el.style.setProperty('--lp-fs', (t.chat_fs || 15) + 'px');
    el.innerHTML = `<div class="lp-bg" style="background:${esc(bg)} center / cover;filter:brightness(${(t.dash_bright ?? 100) / 100}) blur(${Math.min(8, (t.dash_blur || 0) / 3)}px)"></div>
      <div class="lp-app"><div class="lp-rail"><i></i><i class="on"></i><i></i></div><div class="lp-side"><b></b><span></span><span class="on"></span><span></span></div>
      <div class="lp-main" style="background:rgba(19,20,25,${t.dash_bg ? (t.chat_dim ?? 42) / 100 : 1})">
        <div class="lp-msg">${P().avatar(p, 26, { halo: false, deco: false })}<div><b style="${esc(P().nameCss(p, { noGlow: true }))}">${P().nameText(p)}</b><p>Looking good! ✨</p></div></div>
        <div class="lp-msg${t.density === 'compact' ? ' compact' : ''}"><span class="lp-av2">A</span><div><b>alex</b><p>Love the new colours.</p></div></div>
        <div class="lp-input"><span>Message #general</span><i style="background:${esc(acc)}"></i></div></div></div>`;
  }

  /* ---------- Nitro ---------- */
  async function nitro(b) {
    const me = NX.me;
    if (!me.is_nitro) {
      b.innerHTML = `<div class="nitro-hero"><div class="nh-glow"></div><span class="nh-ico"><i class="fa-solid fa-bolt"></i></span><h1>NexChat Nitro</h1><p>Stand out everywhere you talk.</p></div>
        <div class="perk-grid">
          <div class="perk"><i class="fa-solid fa-circle-notch" style="--t:#f0b232"></i><b>Animated halo</b><small>A spinning ring or your own GIF around your avatar.</small></div>
          <div class="perk"><i class="fa-solid fa-font" style="--t:#e8659a"></i><b>Name styles</b><small>Gradients, glow, shimmer, fancy lettering and ASCII art.</small></div>
          <div class="perk"><i class="fa-solid fa-user-astronaut" style="--t:#7c6cff"></i><b>Avatar frames</b><small>${'33'} animated decorations around your picture.</small></div>
          <div class="perk"><i class="fa-solid fa-id-card" style="--t:#2fbf87"></i><b>Profile banners</b><small>Full-card animated art on your profile.</small></div>
        </div>
        <div class="card" data-state><span class="spinner"></span></div>`;
      const { data } = await window.db.from('nitro_requests').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(1);
      const last = data?.[0];
      const st = b.querySelector('[data-state]');
      if (!st) return;
      if (last?.status === 'pending') st.innerHTML = '<h3><i class="fa-solid fa-hourglass-half" style="color:var(--nitro)"></i> Request pending</h3><p style="margin:0">An admin will review it. Nitro switches on here the moment it’s approved.</p>';
      else {
        st.innerHTML = `${last?.status === 'denied' ? `<h3>Last request declined</h3><p>${esc(last.review_note || 'No reason was given.')}</p>` : '<h3>Request Nitro</h3><p>Nitro is granted by the NexChat admins. Tell them why, a sentence is plenty.</p>'}
          <div class="stack"><textarea class="input" rows="3" maxlength="500" placeholder="I’d love the animated halo for my profile."></textarea><div><button class="btn btn-nitro"><i class="fa-solid fa-paper-plane"></i>Send request</button></div></div>`;
        st.querySelector('.btn').onclick = async (e) => {
          e.currentTarget.classList.add('busy');
          const { error } = await window.db.from('nitro_requests').insert({ user_id: me.id, message: st.querySelector('textarea').value.trim() || null });
          if (error) { e.currentTarget.classList.remove('busy'); return NX.fail(error); }
          NX.toast('Request sent to the admins.');
          render();
        };
      }
      return;
    }
    const ns = () => (draft.theme.name_style = draft.theme.name_style || { font: 'normal' });
    const sample = (style) => ({ ...person(), theme: { ...person().theme, name_style: style } });
    b.innerHTML = `<h1 class="page-title">Nitro</h1><p class="lead">${me.nitro_since ? 'Active since ' + new Date(me.nitro_since).toLocaleDateString([], { dateStyle: 'long' }) + '. ' : ''}Design how your name looks everywhere, and set your halo.</p>
      <div class="name-stage" data-stage></div>
      <div class="two-col" style="margin-top:18px"><div class="stack">
        <div class="card"><h3>Presets</h3><p>Start from a look, then tweak it below.</p><div class="preset-grid" data-presets>${NS_PRESETS.map((p, i) => `<button type="button" class="preset" data-i="${i}"><span class="pv" data-pv="${i}"></span><small>${p.n}</small></button>`).join('')}</div></div>
        <div class="card"><h3>Lettering</h3><div class="font-grid" data-font>${NS_FONTS.map(([k, t]) => `<button type="button" data-v="${k}"><span data-fv="${k}"></span><small>${t}</small></button>`).join('')}</div></div>
        <div class="card"><h3>Colour & effects</h3>
          <div class="stack">
            <label class="toggle-row"><div class="info"><b>Custom colour</b><small>Otherwise your name is white${ns().font === 'ascii' ? ' (ASCII gets a rainbow)' : ''}.</small></div><input type="color" data-c="c1"><input type="checkbox" class="switch" data-c="c1on"></label>
            <label class="toggle-row"><div class="info"><b>Gradient</b><small>Blend into a second colour.</small></div><input type="color" data-c="c2"><input type="checkbox" class="switch" data-c="c2on"></label>
            <label class="toggle-row"><div class="info"><b>Glow</b><small>A soft neon light around the letters.</small></div><input type="color" data-c="glow"><input type="checkbox" class="switch" data-c="glowon"></label>
            <label class="toggle-row"><div class="info"><b>Shimmer</b><small>Animates the gradient.</small></div><input type="checkbox" class="switch" data-c="shimmer"></label>
            <div class="row" style="gap:10px"><label class="toggle-row" style="flex:1"><div class="info"><b>Bold</b></div><input type="checkbox" class="switch" data-c="bold"></label><label class="toggle-row" style="flex:1"><div class="info"><b>Italic</b></div><input type="checkbox" class="switch" data-c="italic"></label></div>
          </div></div>
        <div class="card"><h3>Animated halo</h3><p>A GIF or APNG link that rings your avatar. Leave empty for the gold sweep.</p>
          <input class="input" data-halo placeholder="https://…/loop.gif" value="${esc(draft.banner_gif_url || '')}">
          ${draft.theme.dev_mode ? `<div class="field" style="margin-top:14px"><label>Custom halo CSS (developer mode)</label><textarea class="input mono" rows="3" data-halocss placeholder="background: linear-gradient(90deg,#f0f,#0ff); animation: spin 2s linear infinite;">${esc(draft.theme.halo_css || '')}</textarea>
            <span class="hint">Declarations only. <b>spin</b> and <b>pulse</b> animations are built in.</span>
            <div class="chip-input" style="margin-top:8px" data-egs>${HALO_EGS.map((e, i) => `<button type="button" class="chip" data-i="${i}">${e.n}</button>`).join('')}</div></div>` : '<p class="hint" style="margin-top:8px">Turn on developer mode in Advanced to write your own halo CSS.</p>'}
        </div>
      </div><div class="sticky"><h2 class="sec-title" style="margin-top:0">Profile preview</h2><div class="pcard" data-preview></div>
        <button class="btn btn-ghost btn-block" style="margin-top:12px" data-shop><i class="fa-solid fa-bag-shopping"></i>Browse frames & banners</button></div></div>`;
    b.querySelectorAll('[data-pv]').forEach((el) => { const s = NS_PRESETS[+el.dataset.pv].s; el.innerHTML = `<span style="${esc(P().nameCss(sample(s)))}">${P().nameText(sample(s))}</span>`; });
    const paint = () => {
      const s = ns(), p = person();
      b.querySelector('[data-stage]').innerHTML = `<div class="ns-big">${P().bigName(p)}</div><div class="ns-chat">${P().avatar(p, 40)}<div><span style="${esc(P().nameCss(p))};font-weight:600">${P().nameText(p)}</span><span class="m-time" style="margin-left:8px">Today at ${NX.fmt.time(new Date().toISOString())}</span><div style="color:#dcdee5">This is how you look in chat.</div></div></div>`;
      b.querySelectorAll('[data-font] button').forEach((x) => x.classList.toggle('on', x.dataset.v === (s.font || 'normal')));
      b.querySelectorAll('[data-fv]').forEach((el) => { const st = { ...s, font: el.dataset.fv }; el.innerHTML = el.dataset.fv === 'ascii' ? '<b style="font-family:var(--f-mono);letter-spacing:1px">█▀█</b>' : `<span style="${esc(P().nameCss(sample(st), { noGlow: true }))}">${esc(P().fancy('Aa', el.dataset.fv))}</span>`; });
      const c = (k) => b.querySelector(`[data-c="${k}"]`);
      c('c1on').checked = !!s.color; c('c1').value = s.color || '#ffffff';
      c('c2on').checked = !!s.color2; c('c2').value = s.color2 || '#8b7cff';
      c('glowon').checked = !!s.glow; c('glow').value = s.glow || '#f5b94a';
      c('bold').checked = !!s.bold; c('italic').checked = !!s.italic; c('shimmer').checked = !!s.shimmer;
      paintPreview();
    };
    b.querySelector('[data-shop]').onclick = () => { if (pg.guard()) NX.go('settings/shop', { replace: true }); };
    b.querySelector('[data-font]').onclick = (e) => { const x = e.target.closest('[data-v]'); if (!x) return; ns().font = x.dataset.v; paint(); touch(); };
    b.querySelector('[data-presets]').onclick = (e) => { const x = e.target.closest('[data-i]'); if (!x) return; draft.theme.name_style = { font: 'normal', ...NS_PRESETS[+x.dataset.i].s }; paint(); touch(); };
    b.querySelectorAll('[data-c]').forEach((el) => el.addEventListener('input', () => {
      const s = ns(), c = (k) => b.querySelector(`[data-c="${k}"]`);
      if (el.type === 'color') { const map = { c1: 'c1on', c2: 'c2on', glow: 'glowon' }; c(map[el.dataset.c]).checked = true; }
      s.color = c('c1on').checked ? c('c1').value : null;
      s.color2 = c('c2on').checked ? c('c2').value : null;
      s.glow = c('glowon').checked ? c('glow').value : null;
      s.bold = c('bold').checked; s.italic = c('italic').checked; s.shimmer = c('shimmer').checked;
      paint(); touch();
    }));
    b.querySelector('[data-halo]').addEventListener('input', (e) => { draft.banner_gif_url = e.target.value.trim() || null; paint(); touch(); });
    b.querySelector('[data-halocss]')?.addEventListener('input', (e) => { draft.theme.halo_css = e.target.value.trim() || null; paint(); touch(); });
    b.querySelector('[data-egs]')?.addEventListener('click', (e) => { const x = e.target.closest('[data-i]'); if (!x) return; draft.theme.halo_css = HALO_EGS[+x.dataset.i].css; b.querySelector('[data-halocss]').value = draft.theme.halo_css; paint(); touch(); });
    paint();
  }

  /* ---------- Nitro shop ----------
     Grids show still frames (a few KB each) and only the item under the
     pointer, or the one selected, animates. Equips save immediately. */
  let manifest = null, shopKind = 'pfp', shopSel = null;
  async function shop(b) {
    if (!NX.me.is_nitro) { NX.go('settings/nitro', { replace: true }); return; }
    if (!manifest) {
      b.innerHTML = '<div style="padding:40px;display:flex;justify-content:center"><span class="spinner"></span></div>';
      try { const r = await fetch('assets/deco/manifest.json'); manifest = r.ok ? await r.json() : {}; } catch { manifest = {}; }
      if (tab !== 'shop' || !pg) return;
    }
    const list = (shopKind === 'pfp' ? manifest.pfp : manifest.profile) || [];
    const key = shopKind === 'pfp' ? 'pfp_deco' : 'bio_deco';
    const th = NX.me.theme || {};
    shopSel = shopSel && list.some((x) => x.file === shopSel) ? shopSel : (th[key] || list[0]?.file || null);
    b.innerHTML = `<div class="shop-hero"><div><h1>Nitro shop</h1><p>Decorate your avatar and profile. Everything here is included with Nitro.</p></div><i class="fa-solid fa-bag-shopping"></i></div>
      <div class="shop-tabs seg" data-kind><button type="button" data-v="pfp">Avatar frames <span class="muted">${(manifest.pfp || []).length}</span></button><button type="button" data-v="bio">Profile banners <span class="muted">${(manifest.profile || []).length}</span></button></div>
      <div class="shop-layout"><div class="shop-grid2" data-grid>${list.map((it) => `<button type="button" class="shop-card${th[key] === it.file ? ' equipped' : ''}${shopSel === it.file ? ' sel' : ''}" data-file="${esc(it.file)}">
          <span class="sc-art ${shopKind}"><img src="${esc(P().decoSrc(it.file, true))}" data-anim="${esc(P().decoSrc(it.file))}" data-orig="${esc(it.file)}" alt="" loading="lazy" decoding="async" onerror="this.onerror=null;this.src=this.dataset.orig"></span>
          <b>${esc(it.name || it.id)}</b>${th[key] === it.file ? '<span class="sc-eq"><i class="fa-solid fa-check"></i>Equipped</span>' : ''}</button>`).join('')}</div>
        <aside class="shop-side sticky" data-side></aside></div>`;
    b.querySelectorAll('[data-kind] button').forEach((x) => x.classList.toggle('on', x.dataset.v === shopKind));
    b.querySelector('[data-kind]').onclick = (e) => { const x = e.target.closest('[data-v]'); if (!x || x.dataset.v === shopKind) return; shopKind = x.dataset.v; shopSel = null; shop(b); };
    const grid = b.querySelector('[data-grid]');
    // animate on hover only
    grid.addEventListener('pointerover', (e) => { const im = e.target.closest('.shop-card')?.querySelector('img'); if (im && !im.dataset.on) { im.dataset.still = im.src; im.dataset.on = '1'; im.src = im.dataset.anim; } });
    grid.addEventListener('pointerout', (e) => { const card = e.target.closest('.shop-card'); if (!card || card.contains(e.relatedTarget)) return; const im = card.querySelector('img'); if (im?.dataset.on && !card.classList.contains('sel')) { im.src = im.dataset.still; delete im.dataset.on; } });
    grid.onclick = (e) => {
      const c = e.target.closest('.shop-card'); if (!c) return;
      grid.querySelectorAll('.shop-card.sel').forEach((x) => { x.classList.remove('sel'); const im = x.querySelector('img'); if (im?.dataset.on) { im.src = im.dataset.still; delete im.dataset.on; } });
      c.classList.add('sel'); shopSel = c.dataset.file; paintSide();
    };
    const paintSide = () => {
      const side = b.querySelector('[data-side]');
      const item = list.find((x) => x.file === shopSel);
      if (!item) { side.innerHTML = ''; return; }
      const on = (NX.me.theme || {})[key] === item.file;
      const p = { ...NX.me, theme: { ...(NX.me.theme || {}), [key]: item.file } };
      side.innerHTML = `<div class="pcard">${cardInner(p)}</div>
        <div class="shop-buy"><div><b>${esc(item.name || item.id)}</b><small>${shopKind === 'pfp' ? 'Avatar frame' : 'Profile banner'} · included with Nitro</small></div>
        <button class="btn ${on ? 'btn-ghost' : 'btn-nitro'}" data-equip>${on ? '<i class="fa-solid fa-xmark"></i>Remove' : '<i class="fa-solid fa-check"></i>Equip'}</button></div>`;
      hydrateCard(side);
      side.querySelector('[data-equip]').onclick = async (e) => {
        e.currentTarget.classList.add('busy');
        const theme = { ...(NX.me.theme || {}) };
        theme[key] = on ? null : item.file;
        const { error } = await window.db.from('profiles').update({ theme }).eq('id', NX.me.id);
        if (error) { e.currentTarget.classList.remove('busy'); return NX.fail(error); }
        NX.me.theme = theme; P().put({ id: NX.me.id, theme });
        saved.theme = JSON.parse(JSON.stringify(theme)); draft.theme = JSON.parse(JSON.stringify(theme));
        NX.emit('me'); paintBrand();
        NX.toast(on ? 'Removed.' : 'Equipped!', { icon: 'fa-wand-magic-sparkles' });
        shop(b);
      };
    };
    const sel = grid.querySelector('.shop-card.sel img');
    if (sel) { sel.dataset.still = sel.src; sel.dataset.on = '1'; sel.src = sel.dataset.anim; }
    paintSide();
  }

  /* ---------- My Drive ---------- */
  function drive(b) {
    b.innerHTML = '<div data-drive></div>';
    if (!window.Drive) { b.innerHTML = '<div class="empty"><p>The drive couldn’t load.</p></div>'; return; }
    if (!window.crypto?.subtle) { b.innerHTML = '<div class="empty"><div class="ico"><i class="fa-solid fa-lock"></i></div><h3>Secure connection needed</h3><p>My Drive encrypts files in your browser, which needs HTTPS.</p></div>'; return; }
    window.Drive.mount(NX.me, b.querySelector('[data-drive]'));
  }

  /* ---------- Notifications ---------- */
  function notifications(b) {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    b.innerHTML = `<h1 class="page-title">Notifications</h1><p class="lead">Choose how NexChat gets your attention.</p>
      <div class="stack">
        <label class="toggle-row"><span class="ri"><i class="fa-solid fa-desktop"></i></span><div class="info"><b>Desktop notifications</b><small>${perm === 'granted' ? 'Allowed by your browser.' : perm === 'denied' ? 'Blocked in your browser’s site settings.' : perm === 'unsupported' ? 'Not supported in this browser.' : 'Your browser will ask for permission.'} For DMs, mentions and calls while NexChat isn’t the active tab.</small></div>
          <input type="checkbox" class="switch" data-k="nx_desktop_notify" ${NX.ls.get('nx_desktop_notify', true) && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' || perm === 'denied' ? 'disabled' : ''}></label>
        <label class="toggle-row"><span class="ri"><i class="fa-solid fa-volume-high"></i></span><div class="info"><b>Sounds</b><small>A soft chime for new messages and a ring for calls.</small></div><input type="checkbox" class="switch" data-k="nx_sounds" ${NX.ls.get('nx_sounds', true) ? 'checked' : ''}></label>
        <label class="toggle-row"><span class="ri"><i class="fa-solid fa-moon"></i></span><div class="info"><b>Do not disturb</b><small>Silences everything. Same as choosing Do not disturb from your status.</small></div><input type="checkbox" class="switch" data-dnd ${P().myStatus() === 'dnd' ? 'checked' : ''}></label>
      </div>`;
    b.querySelectorAll('[data-k]').forEach((el) => el.onchange = async () => {
      if (el.dataset.k === 'nx_desktop_notify' && el.checked && Notification.permission !== 'granted') {
        const p = await Notification.requestPermission().catch(() => 'denied');
        if (p !== 'granted') { el.checked = false; NX.toast('Your browser blocked notifications.', { err: true }); return; }
      }
      NX.ls.set(el.dataset.k, el.checked);
      if (el.dataset.k === 'nx_sounds' && el.checked) NX.data.sound();
    });
    b.querySelector('[data-dnd]').onchange = (e) => P().setStatus(e.target.checked ? 'dnd' : 'online');
  }

  /* ---------- Voice & video ---------- */
  function voice(b) {
    const mode = window.Voice?.audioMode() || 'voice';
    b.innerHTML = `<h1 class="page-title">Voice & video</h1><p class="lead">Check your devices before a call.</p>
      <div class="card"><h3>Audio mode</h3><p>Applies the next time you join a call.</p>
        <div class="opt-grid">
          <button class="opt-card${mode === 'voice' ? ' on' : ''}" data-mode="voice"><b><i class="fa-solid fa-comment"></i> Voice</b><small>Echo cancellation, noise suppression and auto gain. Best for talking.</small></button>
          <button class="opt-card${mode === 'studio' ? ' on' : ''}" data-mode="studio"><b><i class="fa-solid fa-music"></i> Studio</b><small>No processing, stereo, 128 kbps. Use headphones.</small></button></div></div>
      <div class="card"><h3>Mic test</h3><p>Say something; the bar should move.</p>
        <div class="row"><button class="btn btn-ghost" data-test><i class="fa-solid fa-microphone"></i>Let’s check</button>
        <div class="meter"><div data-level></div></div></div></div>
      <div class="card"><h3>Camera test</h3><p>Preview your camera.</p>
        <div class="stack"><div><button class="btn btn-ghost" data-cam><i class="fa-solid fa-video"></i>Test video</button></div><video data-vid playsinline muted style="display:none;max-width:420px;width:100%;border-radius:14px;transform:scaleX(-1);background:#000"></video></div></div>`;
    b.querySelectorAll('[data-mode]').forEach((el) => el.onclick = () => { window.Voice?.setAudioMode(el.dataset.mode); voice(b); NX.toast('Saved. Applies on your next call.'); });
    let stream = null, raf = 0, actx = null;
    const stopMic = () => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); try { actx?.close(); } catch {} stream = null; };
    b.querySelector('[data-test]').onclick = async (e) => {
      const btn = e.currentTarget;
      if (stream) { stopMic(); btn.innerHTML = '<i class="fa-solid fa-microphone"></i>Let’s check'; b.querySelector('[data-level]').style.width = '0'; return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return NX.toast('Microphone access was blocked.', { err: true }); }
      btn.innerHTML = '<i class="fa-solid fa-stop"></i>Stop testing';
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const an = actx.createAnalyser(); an.fftSize = 512;
      actx.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.fftSize);
      const lvl = b.querySelector('[data-level]');
      const tick = () => {
        an.getByteTimeDomainData(data);
        let s = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; s += v * v; }
        lvl.style.width = Math.min(100, Math.sqrt(s / data.length) * 400) + '%';
        if (lvl.isConnected) raf = requestAnimationFrame(tick); else stopMic();
      };
      tick();
    };
    let cam = null;
    b.querySelector('[data-cam]').onclick = async (e) => {
      const v = b.querySelector('[data-vid]');
      if (cam) { cam.getTracks().forEach((t) => t.stop()); cam = null; v.style.display = 'none'; e.currentTarget.innerHTML = '<i class="fa-solid fa-video"></i>Test video'; return; }
      try { cam = await navigator.mediaDevices.getUserMedia({ video: true }); } catch { return NX.toast('Camera access was blocked.', { err: true }); }
      v.srcObject = cam; v.style.display = 'block'; v.play();
      e.currentTarget.innerHTML = '<i class="fa-solid fa-stop"></i>Stop video';
      const stopWhenGone = setInterval(() => { if (!v.isConnected) { cam?.getTracks().forEach((t) => t.stop()); cam = null; clearInterval(stopWhenGone); } }, 1000);
    };
  }

  /* ---------- Advanced ---------- */
  function advanced(b) {
    const dev = !!NX.me.theme?.dev_mode;
    b.innerHTML = `<h1 class="page-title">Advanced</h1><p class="lead">Power-user options.</p>
      <div class="stack"><label class="toggle-row"><span class="ri"><i class="fa-solid fa-code"></i></span><div class="info"><b>Developer mode</b><small>Unlocks custom halo CSS (Nitro) and manual STUN server selection for calls.</small></div><input type="checkbox" class="switch" data-dev ${dev ? 'checked' : ''}></label>
        <div class="toggle-row"><span class="ri"><i class="fa-solid fa-fingerprint"></i></span><div class="info"><b>Your user ID</b><small class="mono">${esc(NX.me.id)}</small></div><button class="btn btn-ghost btn-sm" data-id>Copy</button></div></div>
      ${dev ? `<h2 class="sec-title" style="margin-top:28px">STUN servers</h2><div class="card"><p>Calls use two well-known STUN servers. Tick servers to use your own picks instead; re-test measures each one.</p>
        <div class="row" style="margin-bottom:10px"><button class="btn btn-ghost btn-sm" data-probe><i class="fa-solid fa-gauge-high"></i>Re-test all</button><button class="btn btn-quiet btn-sm" data-auto>Back to automatic</button></div>
        <div class="stack" data-ice style="gap:4px"></div></div>` : ''}`;
    b.querySelector('[data-id]').onclick = () => NX.copy(NX.me.id, 'ID copied');
    b.querySelector('[data-dev]').onchange = async (e) => {
      const theme = { ...(NX.me.theme || {}), dev_mode: e.target.checked };
      const { error } = await window.db.from('profiles').update({ theme }).eq('id', NX.me.id);
      if (error) return NX.fail(error);
      NX.me.theme = theme; saved.theme = JSON.parse(JSON.stringify(theme)); draft.theme = JSON.parse(JSON.stringify(theme));
      advanced(b);
    };
    const ice = b.querySelector('[data-ice]');
    if (!ice) return;
    const manual = new Set(NX.me.theme?.manual_stun || []);
    const paintIce = () => {
      const probed = window.ICE?.lastProbe() || [];
      ice.innerHTML = (window.ICE?.STUN || []).map((u) => {
        const ms = probed.find((p) => p.url === u)?.ms;
        return `<label class="row" style="justify-content:space-between;padding:7px 10px;border-radius:9px;background:var(--bg-0)"><span class="row"><input type="checkbox" value="${esc(u)}" ${manual.has(u) ? 'checked' : ''}><code class="mono" style="font-size:12.5px">${esc(u)}</code></span><span style="color:${ms == null ? 'var(--txt-4)' : ms < 80 ? 'var(--ok)' : ms < 220 ? 'var(--warn)' : 'var(--danger)'};font-size:12px">${ms == null ? 'untested' : ms + ' ms'}</span></label>`;
      }).join('');
    };
    const saveManual = async () => {
      const list = [...manual];
      const theme = { ...(NX.me.theme || {}), manual_stun: list };
      await window.db.from('profiles').update({ theme }).eq('id', NX.me.id);
      NX.me.theme = theme; saved.theme = JSON.parse(JSON.stringify(theme)); draft.theme = JSON.parse(JSON.stringify(theme));
      await window.Voice?.setManualStun(list);
    };
    ice.onchange = (e) => { if (e.target.checked) manual.add(e.target.value); else manual.delete(e.target.value); saveManual(); };
    b.querySelector('[data-probe]').onclick = async (e) => { const btn = e.currentTarget; btn.classList.add('busy'); await window.ICE.rank(window.ICE.STUN, true); btn.classList.remove('busy'); paintIce(); };
    b.querySelector('[data-auto]').onclick = () => { manual.clear(); saveManual(); paintIce(); NX.toast('Back to automatic.'); };
    paintIce();
  }

  NX.views.settings = { enter, update, leave };
})();
