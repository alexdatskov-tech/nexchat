/* User settings (#/settings/<tab>): account, profile, appearance, Nitro,
   Nitro shop, My Drive, notifications, voice & video, advanced. */
(function () {
  const { esc } = NX;
  const P = () => NX.people;
  let host = null, pg = null, tab = 'profile';
  let draft = null, saved = null;

  const ACCENTS = ['#5865F2', '#7C6CFF', '#2FBF87', '#3B9EF5', '#E8659A', '#E8B04B', '#E5484D', '#5AC8D8', '#94A3B8'];
  const BG_PRESETS = [
    { n: 'None', v: '' },
    { n: 'Aurora', v: 'linear-gradient(135deg,#0B3B2E,#0C2436 55%,#211B3D)' },
    { n: 'Ember', v: 'linear-gradient(135deg,#3A1D14,#2A1520 60%,#161018)' },
    { n: 'Deep', v: 'linear-gradient(135deg,#0A1A2F,#0B1220 60%,#0A0A12)' },
    { n: 'Moss', v: 'linear-gradient(135deg,#16281B,#101E23 60%,#0D1014)' },
    { n: 'Dusk', v: 'radial-gradient(120% 100% at 20% 0%,#2B2246,#141222 55%,#0B0A11)' },
    { n: 'Nebula', v: 'radial-gradient(80% 80% at 80% 10%,#3b1d6e,transparent 60%),radial-gradient(70% 70% at 10% 90%,#0e4d5c,transparent 60%),#07080c' },
  ];
  const NS_FONTS = [['normal', 'Normal'], ['bold', 'Bold'], ['script', 'Script'], ['double', 'Double'], ['ascii', 'ASCII art']];
  const NS_PRESETS = [
    { n: 'Gold', s: { font: 'bold', color: '#F5B94A', color2: '#FF7A59', glow: '#F5B94A', bold: true } },
    { n: 'Aurora', s: { font: 'normal', color: '#3DDC97', color2: '#4F9DFF', glow: '#3DDC97', shimmer: true, bold: true } },
    { n: 'Neon', s: { font: 'script', color: '#E8659A', glow: '#E8659A' } },
    { n: 'Ice', s: { font: 'double', color: '#5AC8D8', color2: '#8B7CF6' } },
    { n: 'Terminal', s: { font: 'ascii', color: '#3DDC97', glow: '#3DDC97' } },
    { n: 'Plain', s: { font: 'normal' } },
  ];
  const HALO_EGS = [
    { n: 'Prism', css: 'background: conic-gradient(from 0deg,#F0F,#0FF,#FF0,#F0F); animation: spin 2.4s linear infinite;' },
    { n: 'Ember', css: 'background: conic-gradient(from 90deg,#E8B04B,#FFE9A8,#C98A20,#E8B04B); animation: spin 6s linear infinite;' },
    { n: 'Tide', css: 'background: linear-gradient(135deg,#2FBF87,#3B9EF5); animation: pulse 2s ease-in-out infinite;' },
    { n: 'Neon', css: 'background: #E8659A; box-shadow: 0 0 9px 2px rgba(232,101,154,.8);' },
  ];

  /* ---------- draft handling (profile + appearance share one save) ---------- */
  const EDIT_KEYS = ['display_name', 'bio', 'custom_status', 'accent_color', 'avatar_url', 'banner_url', 'banner_gif_url', 'theme'];
  function snapshot() {
    const me = NX.me;
    const out = {};
    EDIT_KEYS.forEach((k) => { out[k] = k === 'theme' ? JSON.parse(JSON.stringify(me.theme || {})) : (me[k] ?? null); });
    return out;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function touch() {
    const dirty = !same(draft, saved);
    pg.dirty(dirty && ['profile', 'appearance', 'nitro'].includes(tab), { onSave: save, onReset: reset });
    previewTheme();
  }
  function reset() {
    draft = JSON.parse(JSON.stringify(saved));
    pg.dirty(false);
    NX.applyTheme();
    render();
  }
  async function save() {
    const patch = {};
    EDIT_KEYS.forEach((k) => { if (!same(draft[k], saved[k])) patch[k] = draft[k]; });
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
    render();
  }
  // Live preview of appearance edits on the whole app (behind the page).
  function previewTheme() {
    const real = NX.me.theme;
    NX.me.theme = draft.theme;
    NX.applyTheme();
    NX.me.theme = real;
  }
  const person = () => ({ ...NX.me, ...draft, is_nitro: NX.me.is_nitro, theme: { ...(NX.me.theme || {}), ...draft.theme } });

  /* ---------- tabs ---------- */
  const TABS = () => [
    { title: 'User settings', items: [
      { id: 'account', label: 'My account', icon: 'fa-circle-user' },
      { id: 'profile', label: 'Profile', icon: 'fa-id-badge' },
      { id: 'drive', label: 'My Drive', icon: 'fa-hard-drive' },
    ] },
    { title: 'Nitro', items: [
      { id: 'nitro', label: NX.me.is_nitro ? 'Nitro' : 'Get Nitro', icon: 'fa-bolt' },
      { id: 'shop', label: 'Nitro shop', icon: 'fa-bag-shopping', hidden: !NX.me.is_nitro },
    ] },
    { title: 'App settings', items: [
      { id: 'appearance', label: 'Appearance', icon: 'fa-palette' },
      { id: 'notifications', label: 'Notifications', icon: 'fa-bell' },
      { id: 'voice', label: 'Voice & video', icon: 'fa-microphone' },
      { id: 'advanced', label: 'Advanced', icon: 'fa-code' },
    ] },
    { title: '', items: [{ id: 'logout', label: 'Log out', icon: 'fa-right-from-bracket', danger: true }] },
  ];

  function enter(h, parts) {
    host = h;
    saved = snapshot();
    draft = JSON.parse(JSON.stringify(saved));
    tab = parts[1] || (NX.isNarrow() ? 'account' : 'profile');
    pg = NX.pageShell(host, {
      sections: TABS(), active: tab,
      onSelect: (id) => {
        if (id === 'logout') return NX.signOut();
        NX.go('settings/' + id, { replace: true });
      },
    });
    render();
  }
  function update(parts) {
    const next = parts[1] || 'profile';
    if (next === tab) return;
    tab = next;
    pg.setActive(tab);
    render();
  }
  function leave() {
    // Unsaved appearance previews are dropped when the page closes.
    if (draft && !same(draft.theme, saved?.theme)) NX.applyTheme();
    window.Drive?.unmount?.();
    host = null; pg = null;
  }

  function render() {
    if (!pg) return;
    const b = pg.body;
    const bar = b.querySelector('.save-bar');
    b.innerHTML = '';
    ({ account, profile, appearance, nitro, shop, drive, notifications, voice, advanced }[tab] || profile)(b);
    if (bar && ['profile', 'appearance', 'nitro'].includes(tab)) b.appendChild(bar);
    else if (!['profile', 'appearance', 'nitro'].includes(tab)) pg.dirty(false);
    else touch();
  }

  /* ---------- My account ---------- */
  function account(b) {
    const me = NX.me;
    b.innerHTML = `<h1 class="page-title">My account</h1>
      <div class="pcard" style="margin-bottom:20px">${cardInner(me)}</div>
      <div class="card"><div class="set-row"><div class="info"><b>Display name</b><small>${P().nameText(me)}</small></div><button class="btn btn-ghost btn-sm" data-go="profile">Edit</button></div>
        <div class="set-row"><div class="info"><b>Username</b><small>@${esc(me.username)} · usernames can’t be changed</small></div><button class="btn btn-ghost btn-sm" data-a="copy">Copy</button></div>
        <div class="set-row"><div class="info"><b>Member since</b><small>${new Date(me.created_at).toLocaleDateString([], { dateStyle: 'long' })}</small></div></div>
        ${P().rank(me) ? `<div class="set-row"><div class="info"><b>NexChat role</b><small>${P().roleBadge(me)}</small></div></div>` : ''}</div>
      <h2 class="sec-title" style="margin-top:28px">Password</h2>
      <div class="card"><form class="stack" data-f="pw">
        <div class="field-row"><div class="field"><label>New password</label><input type="password" autocomplete="new-password" minlength="8" required data-p1></div>
        <div class="field"><label>Confirm new password</label><input type="password" autocomplete="new-password" required data-p2></div></div>
        <p class="hint">There’s no email recovery, so don’t lose the new one.</p><p class="err"></p>
        <div><button class="btn btn-primary">Change password</button></div></form></div>
      <h2 class="sec-title" style="margin-top:28px">Account removal</h2>
      <div class="card danger-card"><h3>Delete account</h3><p>This permanently removes your account, your servers, messages and friends. It can’t be undone.</p>
        <form class="stack" data-f="del"><div class="field"><label>Enter your password to confirm</label><input type="password" autocomplete="current-password" data-dp></div><p class="err"></p>
        <div><button class="btn btn-danger">Delete account</button></div></form></div>`;
    hydrateCard(b);
    b.querySelector('[data-go]').onclick = () => NX.go('settings/profile', { replace: true });
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

  /* profile card markup used by the preview and the account page */
  function cardInner(p) {
    const accent = /^#[0-9a-f]{6}$/i.test(p.accent_color || '') ? p.accent_color : '#5865F2';
    const deco = P().decoPath(p, 'bio');
    return `${deco ? `<div class="card-deco" aria-hidden="true"><img src="${esc(deco)}" alt=""></div>` : ''}
      <div class="pc-banner" style="background:linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 30%, #0e0f13))" ${p.banner_url ? `data-bg="${esc(p.banner_url)}"` : ''}></div>
      <div class="pc-av">${P().avatar(p, 80, { presence: false })}</div>
      <div class="pc-body"><div class="pc-name">${P().bigName(p)}${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i>Nitro</span>' : ''}${P().roleBadge(p)}</div>
        <div class="pc-handle">@${esc(p.username)}</div>
        ${p.custom_status ? `<div style="font-size:13.5px">${esc(p.custom_status)}</div>` : ''}
        ${p.bio ? `<div class="pc-bio">${esc(p.bio)}</div>` : ''}</div>`;
  }
  function hydrateCard(root) {
    root.querySelectorAll('.pcard').forEach((c) => c.classList.toggle('has-deco', !!c.querySelector('.card-deco')));
    root.querySelectorAll('.pcard').forEach((c) => c.classList.toggle('card-deco-host', !!c.querySelector('.card-deco')));
    root.querySelectorAll('[data-bg]').forEach((el) => {
      const u = el.dataset.bg;
      const set = (x) => { el.style.background = `url("${String(x).replace(/"/g, '%22')}") center / cover`; };
      if (/^blob:/.test(u)) set(u); else NX.files.resolved(u).then(set).catch(() => set(u));
    });
  }

  /* ---------- Profile ---------- */
  function profile(b) {
    b.innerHTML = `<h1 class="page-title">Profile</h1>
      <div class="two-col"><div class="stack">
        <div class="field"><label>Display name</label><input class="input" maxlength="60" data-k="display_name" placeholder="${esc(NX.me.username)}"></div>
        <div class="field"><label>Custom status</label><input class="input" maxlength="128" data-k="custom_status" placeholder="What’s happening?"></div>
        <div class="field"><label>About me</label><textarea class="input" rows="4" maxlength="500" data-k="bio" placeholder="A line or two about you."></textarea><span class="hint"><span data-count>0</span>/500</span></div>
        <div class="field"><label>Avatar</label><div data-av></div><span class="hint">Square images look best. Resized to 512 px.</span></div>
        <div class="field"><label>Banner</label><div data-bn></div></div>
        <div class="field"><label>Profile colour</label><div class="swatches" data-sw>${ACCENTS.map((c) => `<span class="swatch" data-c="${c}" style="background:${c}" title="${c}"></span>`).join('')}<input type="color" data-color></div><span class="hint">Used for your banner when you don’t have one, and your default avatar.</span></div>
      </div>
      <div class="sticky"><h2 class="sec-title" style="margin-top:0">Preview</h2><div class="pcard" data-preview></div></div></div>`;
    const set = (k, v) => { draft[k] = v; paintPreview(); touch(); };
    b.querySelectorAll('[data-k]').forEach((el) => {
      el.value = draft[el.dataset.k] || '';
      el.addEventListener('input', () => { set(el.dataset.k, el.value); if (el.dataset.k === 'bio') b.querySelector('[data-count]').textContent = el.value.length; });
    });
    b.querySelector('[data-count]').textContent = (draft.bio || '').length;
    const av = NX.imagePicker({ url: draft.avatar_url, label: 'Change avatar', onPick: async (f) => (await NX.files.uploadImage(f, `users/${NX.me.id}`, { max: 512 })).url, onChange: (u) => set('avatar_url', u), onClear: () => set('avatar_url', null) });
    b.querySelector('[data-av]').appendChild(av.el);
    const bn = NX.imagePicker({ url: draft.banner_url, shape: 'wide', label: 'Change banner', onPick: async (f) => (await NX.files.uploadImage(f, `users/${NX.me.id}`, { max: 1600 })).url, onChange: (u) => set('banner_url', u), onClear: () => set('banner_url', null) });
    b.querySelector('[data-bn]').appendChild(bn.el);
    const paintSw = () => {
      b.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === (draft.accent_color || '').toLowerCase()));
      b.querySelector('[data-color]').value = /^#[0-9a-f]{6}$/i.test(draft.accent_color || '') ? draft.accent_color : '#5865F2';
    };
    b.querySelector('[data-sw]').addEventListener('click', (e) => { const s = e.target.closest('.swatch'); if (s) { set('accent_color', s.dataset.c); paintSw(); } });
    b.querySelector('[data-color]').addEventListener('input', (e) => { set('accent_color', e.target.value); paintSw(); });
    paintSw();
    paintPreview();
  }
  function paintPreview() {
    const el = pg?.body.querySelector('[data-preview]');
    if (!el) return;
    el.innerHTML = cardInner(person());
    hydrateCard(el.parentElement);
  }

  /* ---------- Appearance ---------- */
  function appearance(b) {
    const t = draft.theme;
    const bgv = t.dash_wallpaper_key ? 'key' : (t.dash_bg || '');
    const urlVal = (bgv.match(/^url\(\s*["']?(.*?)["']?\s*\)$/) || [])[1] || '';
    b.innerHTML = `<h1 class="page-title">Appearance</h1>
      <h2 class="sec-title">Style</h2>
      <div class="opt-grid" data-style>
        <button class="opt-card" data-v="solid"><span class="oc-prev" style="background:linear-gradient(90deg,#08090c 18%,#0e0f13 18% 40%,#131419 40%)"></span><b>Midnight</b><small>Solid and crisp. Easiest on battery.</small></button>
        <button class="opt-card" data-v="glass"><span class="oc-prev" style="background:linear-gradient(135deg,#3b1d6e,#0e4d5c)"><span style="width:70%;height:60%;border-radius:8px;background:rgba(255,255,255,.12);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.2)"></span></span><b>Glass</b><small>Frosted panels over your wallpaper.</small></button>
      </div>
      <h2 class="sec-title">Background</h2>
      <div class="opt-grid" data-bgp>${BG_PRESETS.map((p) => `<button class="opt-card" data-v="${esc(p.v)}"><span class="oc-prev" style="background:${p.v || 'var(--bg-2)'}">${p.v ? '' : '<i class="fa-solid fa-ban" style="color:var(--txt-3)"></i>'}</span><b>${p.n}</b></button>`).join('')}
        <label class="opt-card" data-up><span class="oc-prev" data-wp><i class="fa-solid fa-upload" style="color:var(--txt-3)"></i></span><b>Upload image</b><small>Up to 15 MB</small><input type="file" accept="image/*" hidden></label></div>
      <div class="field" style="margin-top:12px"><label>…or use an image link</label><input class="input" data-url placeholder="https://…/wallpaper.jpg" value="${esc(bgv !== 'key' ? urlVal : '')}"></div>
      <div class="card" style="margin-top:16px"><div class="stack">
        ${range('Brightness', 'dash_bright', 20, 200, 100, '%')}${range('Darken', 'dash_dim', 0, 95, 0, '%')}${range('Blur', 'dash_blur', 0, 30, 0, 'px')}
        <div class="divider"></div><p class="hint" style="margin:-4px 0 0">Extra treatment behind the chat so messages stay readable.</p>
        ${range('Chat blur', 'chat_blur', 0, 30, t.ui_style === 'glass' ? 5 : 12, 'px')}${range('Chat darken', 'chat_dim', 0, 95, 42, '%')}
      </div></div>`;
    const paintSel = () => {
      b.querySelectorAll('[data-style] .opt-card').forEach((c) => c.classList.toggle('on', c.dataset.v === (draft.theme.ui_style === 'glass' ? 'glass' : 'solid')));
      const cur = draft.theme.dash_wallpaper_key ? '__key' : (draft.theme.dash_bg || '');
      b.querySelectorAll('[data-bgp] .opt-card[data-v]').forEach((c) => c.classList.toggle('on', c.dataset.v === cur));
      const isImg = /^url\(/.test(cur) || cur === '__key';
      b.querySelector('[data-up]').classList.toggle('on', isImg);
      const wp = b.querySelector('[data-wp]');
      if (isImg && /^url\(/.test(cur)) { wp.style.backgroundImage = cur; wp.innerHTML = ''; }
    };
    b.querySelector('[data-style]').onclick = (e) => { const c = e.target.closest('[data-v]'); if (!c) return; draft.theme.ui_style = c.dataset.v; paintSel(); touch(); };
    b.querySelector('[data-bgp]').addEventListener('click', (e) => {
      const c = e.target.closest('.opt-card[data-v]'); if (!c) return;
      draft.theme.dash_bg = c.dataset.v || null; draft.theme.dash_wallpaper_key = null;
      b.querySelector('[data-url]').value = '';
      paintSel(); touch();
    });
    b.querySelector('[data-up] input').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      if (f.size > 15 * 1024 * 1024) return NX.toast('That image is over 15 MB.', { err: true });
      const wp = b.querySelector('[data-wp]');
      wp.innerHTML = '<span class="spinner"></span>';
      try {
        const up = await NX.files.uploadImage(f, `users/${NX.me.id}`, { max: 2560 });
        draft.theme.dash_bg = `url("${up.url}")`; draft.theme.dash_wallpaper_key = null;
        b.querySelector('[data-url]').value = '';
        paintSel(); touch();
      } catch (err) { wp.innerHTML = '<i class="fa-solid fa-upload"></i>'; NX.fail(err, 'Upload failed'); }
    };
    b.querySelector('[data-url]').addEventListener('input', NX.debounce((e) => {
      const u = e.target.value.trim();
      if (u && !/^https:\/\//i.test(u)) return;
      draft.theme.dash_bg = u ? `url("${u.replace(/"/g, '%22')}")` : null; draft.theme.dash_wallpaper_key = null;
      paintSel(); touch();
    }, 300));
    b.querySelectorAll('[data-range]').forEach((r) => {
      const out = r.parentElement.querySelector('span');
      r.addEventListener('input', () => { draft.theme[r.dataset.range] = +r.value; out.textContent = r.value + r.dataset.unit; touch(); });
    });
    paintSel();
  }
  function range(label, key, min, max, def, unit) {
    const v = draft.theme[key] ?? def;
    return `<div class="field"><label>${label}</label><div class="range-row"><input type="range" min="${min}" max="${max}" value="${v}" data-range="${key}" data-unit="${unit}"><span>${v}${unit}</span></div></div>`;
  }

  /* ---------- Nitro ---------- */
  async function nitro(b) {
    const me = NX.me;
    if (!me.is_nitro) {
      b.innerHTML = `<div class="hero" style="background:radial-gradient(120% 140% at 0% 0%,rgba(240,178,50,.35),transparent 55%),radial-gradient(90% 120% at 100% 100%,rgba(232,101,154,.25),transparent 60%),var(--bg-3)">
        <h1><i class="fa-solid fa-bolt" style="color:var(--nitro)"></i> Nitro</h1><p>An animated halo around your avatar, styled names, avatar frames and profile banners. Granted by the NexChat admins.</p></div>
        <div class="card" data-state><span class="spinner"></span></div>`;
      const { data } = await window.db.from('nitro_requests').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(1);
      const last = data?.[0];
      const st = b.querySelector('[data-state]');
      if (!st) return;
      if (last?.status === 'pending') st.innerHTML = '<h3>Request pending</h3><p style="margin:0">An admin will review it. Nitro switches on here the moment it’s approved.</p>';
      else {
        st.innerHTML = `${last?.status === 'denied' ? `<h3>Last request declined</h3><p>${esc(last.review_note || 'No reason was given.')}</p>` : '<h3>Request Nitro</h3><p>Tell the admins why. A sentence is plenty.</p>'}
          <div class="stack"><textarea class="input" rows="3" maxlength="500" placeholder="I’d love the animated halo for my profile."></textarea><div><button class="btn btn-primary"><i class="fa-solid fa-paper-plane"></i>Send request</button></div></div>`;
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
    b.innerHTML = `<h1 class="page-title"><i class="fa-solid fa-bolt" style="color:var(--nitro)"></i> Nitro</h1>
      <p class="lead">${me.nitro_since ? 'Active since ' + new Date(me.nitro_since).toLocaleDateString([], { dateStyle: 'long' }) : 'Active on your account.'} Frames and banners live in the <a href="#/settings/shop" data-shop>Nitro shop</a>.</p>
      <div class="two-col"><div class="stack">
        <div class="card"><h3>Name style</h3><p>How your name looks in chat, member lists and your profile.</p>
          <div class="stack">
            <div class="field"><label>Lettering</label><div class="seg" data-font>${NS_FONTS.map(([k, t]) => `<button type="button" data-v="${k}">${t}</button>`).join('')}</div></div>
            <div class="field"><label>Presets</label><div class="chip-input" data-presets>${NS_PRESETS.map((p, i) => `<button type="button" class="chip" data-i="${i}">${p.n}</button>`).join('')}</div></div>
            <div class="field"><label>Colour</label><div class="row" style="flex-wrap:wrap;gap:14px">
              <label class="row"><input type="checkbox" data-c="c1on"> Custom colour <input type="color" data-c="c1"></label>
              <label class="row"><input type="checkbox" data-c="c2on"> Gradient to <input type="color" data-c="c2"></label>
              <label class="row"><input type="checkbox" data-c="glowon"> Glow <input type="color" data-c="glow"></label></div></div>
            <div class="field"><label>Effects</label><div class="row" style="gap:16px;flex-wrap:wrap">
              <label class="row"><input type="checkbox" data-c="bold"> Bold</label><label class="row"><input type="checkbox" data-c="italic"> Italic</label>
              <label class="row"><input type="checkbox" data-c="shimmer"> Shimmer (gradients)</label></div></div>
          </div></div>
        <div class="card"><h3>Animated halo</h3><p>A GIF or APNG link that rings your avatar everywhere. Leave empty for the gold sweep.</p>
          <input class="input" data-halo placeholder="https://…/loop.gif" value="${esc(draft.banner_gif_url || '')}">
          ${draft.theme.dev_mode ? `<div class="field" style="margin-top:14px"><label>Custom halo CSS (developer mode)</label><textarea class="input mono" rows="3" data-halocss placeholder="background: linear-gradient(90deg,#f0f,#0ff); animation: spin 2s linear infinite;">${esc(draft.theme.halo_css || '')}</textarea>
            <span class="hint">Declarations only, no selectors, braces or url(). <b>spin</b> and <b>pulse</b> animations are built in.</span>
            <div class="chip-input" style="margin-top:8px" data-egs>${HALO_EGS.map((e, i) => `<button type="button" class="chip" data-i="${i}">${e.n}</button>`).join('')}</div></div>` : ''}
        </div>
      </div><div class="sticky"><h2 class="sec-title" style="margin-top:0">Preview</h2><div class="pcard" data-preview></div>
        <div class="card" style="margin-top:12px"><div class="row">${P().avatar(person(), 40)}<div><div data-chatname style="font-weight:600"></div><div style="color:#dcdee5">This is how you look in chat.</div></div></div></div></div></div>`;
    const paint = () => {
      const s = ns();
      b.querySelectorAll('[data-font] button').forEach((x) => x.classList.toggle('on', x.dataset.v === (s.font || 'normal')));
      const c = (k) => b.querySelector(`[data-c="${k}"]`);
      c('c1on').checked = !!s.color; c('c1').value = s.color || '#ffffff'; c('c1').disabled = !s.color;
      c('c2on').checked = !!s.color2; c('c2').value = s.color2 || '#8b7cff'; c('c2').disabled = !s.color2;
      c('glowon').checked = !!s.glow; c('glow').value = s.glow || '#f5b94a'; c('glow').disabled = !s.glow;
      c('bold').checked = !!s.bold; c('italic').checked = !!s.italic; c('shimmer').checked = !!s.shimmer; c('shimmer').disabled = !s.color2;
      paintPreview();
      const p = person();
      b.querySelector('[data-chatname]').innerHTML = `<span style="${esc(P().nameCss(p))}">${P().nameText(p)}</span>`;
    };
    b.querySelector('[data-shop]').onclick = (e) => { e.preventDefault(); NX.go('settings/shop', { replace: true }); };
    b.querySelector('[data-font]').onclick = (e) => { const x = e.target.closest('[data-v]'); if (!x) return; ns().font = x.dataset.v; paint(); touch(); };
    b.querySelector('[data-presets]').onclick = (e) => { const x = e.target.closest('[data-i]'); if (!x) return; draft.theme.name_style = { font: 'normal', ...NS_PRESETS[+x.dataset.i].s }; paint(); touch(); };
    b.querySelectorAll('[data-c]').forEach((el) => el.addEventListener('input', () => {
      const s = ns(), c = (k) => b.querySelector(`[data-c="${k}"]`);
      s.color = c('c1on').checked ? c('c1').value : null;
      s.color2 = c('c2on').checked ? c('c2').value : null;
      s.glow = c('glowon').checked ? c('glow').value : null;
      s.bold = c('bold').checked; s.italic = c('italic').checked; s.shimmer = c('shimmer').checked && !!s.color2;
      paint(); touch();
    }));
    b.querySelector('[data-halo]').addEventListener('input', (e) => { draft.banner_gif_url = e.target.value.trim() || null; paint(); touch(); });
    b.querySelector('[data-halocss]')?.addEventListener('input', (e) => { draft.theme.halo_css = e.target.value.trim() || null; paint(); touch(); });
    b.querySelector('[data-egs]')?.addEventListener('click', (e) => { const x = e.target.closest('[data-i]'); if (!x) return; draft.theme.halo_css = HALO_EGS[+x.dataset.i].css; b.querySelector('[data-halocss]').value = draft.theme.halo_css; paint(); touch(); });
    paint();
  }

  /* ---------- Nitro shop (equips save immediately) ---------- */
  let manifest = null;
  async function shop(b) {
    if (!NX.me.is_nitro) { NX.go('settings/nitro', { replace: true }); return; }
    b.innerHTML = `<h1 class="page-title"><i class="fa-solid fa-bag-shopping" style="color:var(--nitro)"></i> Nitro shop</h1><p class="lead">Equip an avatar frame or a profile banner. Changes apply straight away.</p><div data-shop><span class="spinner"></span></div>`;
    if (!manifest) {
      try { const r = await fetch('assets/deco/manifest.json'); manifest = r.ok ? await r.json() : {}; } catch { manifest = {}; }
    }
    const host2 = b.querySelector('[data-shop]');
    if (!host2) return;
    const th = NX.me.theme || {};
    const sect = (title, kind, list) => `<h2 class="sec-title">${title} · ${list.length}</h2><div class="shop-grid">${list.map((it) => {
      const on = (kind === 'pfp' ? th.pfp_deco : th.bio_deco) === it.file;
      const prev = kind === 'pfp' ? P().avatar({ ...NX.me, is_nitro: true, theme: { ...th, pfp_deco: it.file } }, 64, { halo: false }) : `<img class="bio" src="${esc(it.file)}" alt="" loading="lazy">`;
      return `<button class="shop-item${on ? ' on' : ''}" data-kind="${kind}" data-file="${esc(it.file)}"><div class="si-prev">${prev}</div><b>${esc(it.name || it.id)}</b><small class="muted">${on ? 'Equipped · click to remove' : 'Click to equip'}</small></button>`;
    }).join('')}</div>`;
    host2.innerHTML = sect('Avatar frames', 'pfp', manifest.pfp || []) + sect('Profile banners', 'bio', manifest.profile || []);
    host2.onclick = async (e) => {
      const it = e.target.closest('[data-kind]'); if (!it) return;
      const key = it.dataset.kind === 'pfp' ? 'pfp_deco' : 'bio_deco';
      const theme = { ...(NX.me.theme || {}) };
      theme[key] = theme[key] === it.dataset.file ? null : it.dataset.file;
      const { error } = await window.db.from('profiles').update({ theme }).eq('id', NX.me.id);
      if (error) return NX.fail(error);
      NX.me.theme = theme; P().put({ id: NX.me.id, theme });
      saved.theme = JSON.parse(JSON.stringify(theme)); draft.theme = JSON.parse(JSON.stringify(theme));
      NX.emit('me');
      NX.toast(theme[key] ? 'Equipped.' : 'Removed.');
      shop(b);
    };
  }

  /* ---------- My Drive ---------- */
  function drive(b) {
    b.parentElement.classList.add('wide');
    b.innerHTML = '<div data-drive></div>';
    if (!window.Drive) { b.innerHTML = '<div class="empty"><p>The drive couldn’t load.</p></div>'; return; }
    window.Drive.mount(NX.me, b.querySelector('[data-drive]'));
  }

  /* ---------- Notifications ---------- */
  function notifications(b) {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    b.innerHTML = `<h1 class="page-title">Notifications</h1>
      <div class="card">
        <div class="set-row"><div class="info"><b>Desktop notifications</b><small>${perm === 'granted' ? 'Allowed by your browser.' : perm === 'denied' ? 'Blocked in your browser’s site settings.' : perm === 'unsupported' ? 'Not supported in this browser.' : 'Your browser will ask for permission.'} Shown for DMs, mentions and calls when NexChat isn’t the active tab.</small></div>
          <input type="checkbox" class="switch" data-k="nx_desktop_notify" ${NX.ls.get('nx_desktop_notify', true) && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' || perm === 'denied' ? 'disabled' : ''}></div>
        <div class="set-row"><div class="info"><b>Sounds</b><small>A soft chime for new messages and a ring for calls.</small></div><input type="checkbox" class="switch" data-k="nx_sounds" ${NX.ls.get('nx_sounds', true) ? 'checked' : ''}></div>
        <div class="set-row"><div class="info"><b>Do not disturb</b><small>Silences everything. Same as choosing Do not disturb from your status.</small></div><input type="checkbox" class="switch" data-dnd ${P().myStatus() === 'dnd' ? 'checked' : ''}></div>
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
    b.innerHTML = `<h1 class="page-title">Voice & video</h1>
      <div class="card"><h3>Audio mode</h3><p>Applies the next time you join a call.</p>
        <div class="opt-grid">
          <button class="opt-card${mode === 'voice' ? ' on' : ''}" data-mode="voice"><b><i class="fa-solid fa-comment"></i> Voice</b><small>Echo cancellation, noise suppression and auto gain. Best for talking.</small></button>
          <button class="opt-card${mode === 'studio' ? ' on' : ''}" data-mode="studio"><b><i class="fa-solid fa-music"></i> Studio</b><small>No processing, stereo, 128 kbps. Use headphones.</small></button></div></div>
      <div class="card"><h3>Mic test</h3><p>Check that NexChat can hear you.</p>
        <div class="row"><button class="btn btn-ghost" data-test><i class="fa-solid fa-microphone"></i>Let’s check</button>
        <div style="flex:1;height:10px;border-radius:5px;background:var(--bg-4);overflow:hidden"><div data-level style="height:100%;width:0;background:var(--ok);transition:width .08s"></div></div></div></div>
      <div class="card"><h3>Camera test</h3><p>Preview your camera before a call.</p>
        <div class="stack"><div><button class="btn btn-ghost" data-cam><i class="fa-solid fa-video"></i>Test video</button></div><video data-vid playsinline muted style="display:none;max-width:360px;border-radius:12px;transform:scaleX(-1);background:#000"></video></div></div>`;
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
    b.innerHTML = `<h1 class="page-title">Advanced</h1>
      <div class="card"><div class="set-row"><div class="info"><b>Developer mode</b><small>Unlocks custom halo CSS (Nitro) and manual STUN server selection for calls.</small></div><input type="checkbox" class="switch" data-dev ${dev ? 'checked' : ''}></div>
        <div class="set-row"><div class="info"><b>Copy my user ID</b><small class="mono">${esc(NX.me.id)}</small></div><button class="btn btn-ghost btn-sm" data-id>Copy</button></div></div>
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
        return `<label class="row" style="justify-content:space-between;padding:6px 8px;border-radius:8px;background:var(--bg-0)"><span class="row"><input type="checkbox" value="${esc(u)}" ${manual.has(u) ? 'checked' : ''}><code class="mono" style="font-size:12.5px">${esc(u)}</code></span><span style="color:${ms == null ? 'var(--txt-4)' : ms < 80 ? 'var(--ok)' : ms < 220 ? 'var(--warn)' : 'var(--danger)'};font-size:12px">${ms == null ? 'untested' : ms + ' ms'}</span></label>`;
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
    b.querySelector('[data-probe]').onclick = async (e) => { e.currentTarget.classList.add('busy'); await window.ICE.rank(window.ICE.STUN, true); e.currentTarget?.classList.remove('busy'); paintIce(); };
    b.querySelector('[data-auto]').onclick = () => { manual.clear(); saveManual(); paintIce(); NX.toast('Back to automatic.'); };
    paintIce();
  }

  NX.views.settings = { enter, update, leave };
})();
