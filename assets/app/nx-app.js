/* App shell: boot, sign-in, the server rail, the sidebar frame, routing
   between views, and app-wide dialogs (create/join server, new DM, quick
   switcher). Views register themselves in NX.views. */
(function () {
  const { esc, $ } = NX;
  const P = () => NX.people;

  let current = null;        // { name, key, view }
  let baseRoute = 'home';    // last non-overlay route, to return to from settings pages
  let page = null;           // overlay page view (settings, admin, server settings)

  /* ---------- legacy globals still used by vendor-ish modules (voice, drive) ---------- */
  window.UI = Object.assign(window.UI || {}, {
    toast: (m, err) => NX.toast(m, { err: !!err }),
    esc: NX.esc,
    confirmDialog: (title, body, danger, ok) => NX.confirm({ title, body, danger, ok }),
    go: (u) => legacyGo(u),
    avatar: (p, s, o) => P().avatar(p, s, o),
    params: () => NX.pageParams(),
    pageUrl: (p) => NX.pageUrl(p),
  });

  /* ---------- boot ---------- */
  async function boot() {
    const bootEl = $('#boot');
    const { data } = await window.db.auth.getSession();
    if (!data.session) { bootEl?.classList.add('gone'); return showAuth(); }
    try {
      await NX.data.loadMe(data.session.user.id);
    } catch (e) {
      // A session for a deleted account: sign out cleanly.
      await window.db.auth.signOut().catch(() => {});
      bootEl?.classList.add('gone');
      return showAuth();
    }
    if (NX.me.is_banned) { bootEl?.classList.add('gone'); NX.guard.lock(NX.me.ban_reason); return; }
    mountShell();
    applyTheme();
    try { await NX.data.loadInbox(); }
    catch (e) { NX.fail(e, 'Could not load your servers and messages'); }
    P().startPresence(NX.me);
    NX.data.startLive();
    NX.data.startCalls();
    window.CloudGate?.refresh?.();
    NX.on('route', route);
    route(firstRoute());
    bootEl?.classList.add('gone');
    setTimeout(() => bootEl?.remove(), 400);
    // Desktop notifications: ask once, after the user has done something.
    if ('Notification' in window && Notification.permission === 'default' && !NX.ls.get('nx_asked_notify')) {
      const ask = () => { NX.ls.set('nx_asked_notify', 1); Notification.requestPermission().catch(() => {}); window.removeEventListener('pointerdown', ask); };
      setTimeout(() => window.addEventListener('pointerdown', ask, { once: true }), 4000);
    }
  }

  // Old links: portal.html?invite=, server.html?id=, dms.html?c=, profile.html …
  function firstRoute() {
    const r = NX.initRoute();
    const q = NX.pageParams();
    if (q.get('invite')) return NX.go('invite/' + q.get('invite'), { replace: true, silent: true }) || NX.route();
    const pg = (window.__NX_SHELL__?.page || location.pathname.split('/').pop() || '').replace(/\.html$/, '');
    if (!r.path) {
      const map = {
        server: q.get('id') ? 's/' + q.get('id') : 'home',
        dms: q.get('c') ? 'dm/' + q.get('c') + (q.get('call') || q.get('join') ? '?join=1' : '') : 'home',
        profile: 'settings', 'server-settings': q.get('id') ? `s/${q.get('id')}/settings` : 'home', admin: 'admin',
      };
      NX.go(map[pg] || 'home', { replace: true, silent: true });
    }
    return NX.route();
  }
  function legacyGo(u) {
    u = String(u);
    if (/^index\.html/.test(u) && !u.includes('#')) return NX.reload();
    const m = u.match(/^(\w[\w-]*)\.html(\?[^#]*)?(#.*)?$/);
    if (!m) { location.href = u; return; }
    const q = new URLSearchParams(m[2] || '');
    const map = { portal: 'home', server: 's/' + q.get('id'), dms: q.get('c') ? 'dm/' + q.get('c') : 'home', profile: 'settings', admin: 'admin', 'server-settings': `s/${q.get('id')}/settings` };
    NX.go(map[m[1]] || 'home');
  }

  /* ---------- sign-in ---------- */
  function showAuth() {
    document.body.classList.add('is-auth');
    const el = NX.h(`<div class="auth">
      <div class="auth-bg" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="auth-card">
        <div class="auth-brand"><img src="assets/img/logo.svg" alt=""><h1>nexchat</h1><p>Chat, call and share with your people.</p></div>
        <div class="seg"><button type="button" class="on" data-t="in">Sign in</button><button type="button" data-t="up">Create account</button></div>
        <form data-f="in">
          <div class="field"><label for="aUser">Username</label><input id="aUser" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
          <div class="field pw"><label for="aPass">Password</label><input id="aPass" type="password" autocomplete="current-password" required><button type="button" class="icon-btn" data-peek title="Show password"><i class="fa-regular fa-eye"></i></button></div>
          <p class="err"></p>
          <button class="btn btn-primary btn-lg btn-block">Sign in</button>
        </form>
        <form data-f="up" class="hidden">
          <div class="field"><label for="uUser">Username</label><input id="uUser" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="32" required><span class="hint">2–32 letters, numbers or underscores. This can’t be changed later.</span></div>
          <div class="field pw"><label for="uPass">Password</label><input id="uPass" type="password" autocomplete="new-password" minlength="8" required><button type="button" class="icon-btn" data-peek title="Show password"><i class="fa-regular fa-eye"></i></button></div>
          <div class="field"><label for="uPass2">Confirm password</label><input id="uPass2" type="password" autocomplete="new-password" required></div>
          <p class="hint">There’s no email and no password reset, so keep your password somewhere safe.</p>
          <p class="err"></p>
          <button class="btn btn-primary btn-lg btn-block">Create account</button>
        </form>
        <p class="foot">A hobby project · be nice ✌️</p>
      </div></div>`);
    document.body.appendChild(el);
    const forms = { in: el.querySelector('[data-f="in"]'), up: el.querySelector('[data-f="up"]') };
    el.querySelector('.seg').onclick = (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      el.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
      forms.in.classList.toggle('hidden', b.dataset.t !== 'in'); forms.up.classList.toggle('hidden', b.dataset.t !== 'up');
      forms[b.dataset.t].querySelector('input').focus();
    };
    el.addEventListener('click', (e) => {
      const pk = e.target.closest('[data-peek]'); if (!pk) return;
      const inp = pk.parentElement.querySelector('input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      pk.innerHTML = `<i class="fa-regular fa-eye${inp.type === 'text' ? '-slash' : ''}"></i>`;
    });
    const addr = (u) => `${u.trim().toLowerCase()}@users.nexchat-app.com`;
    const busy = (f, on) => { const b = f.querySelector('.btn'); b.classList.toggle('busy', on); b.disabled = on; };
    const done = async () => { el.remove(); document.body.classList.remove('is-auth'); document.body.insertAdjacentHTML('afterbegin', '<div class="boot" id="boot"><img class="mark" src="assets/img/logo.svg" alt=""></div>'); await boot(); };
    forms.in.onsubmit = async (e) => {
      e.preventDefault();
      const err = forms.in.querySelector('.err'); err.textContent = '';
      busy(forms.in, true);
      const { data, error } = await window.db.auth.signInWithPassword({ email: addr($('#aUser').value), password: $('#aPass').value });
      busy(forms.in, false);
      if (error) { err.textContent = /confirm/i.test(error.message) ? error.message : 'Wrong username or password.'; return; }
      const { data: p } = await window.db.from('profiles').select('is_banned, ban_reason').eq('id', data.user.id).maybeSingle();
      if (p?.is_banned) {
        NX.guard.screen({ reason: p.ban_reason, userId: data.user.id, exitText: 'Back to sign in', onExit: async () => { await window.db.auth.signOut().catch(() => {}); NX.reload(); } });
        return;
      }
      done();
    };
    forms.up.onsubmit = async (e) => {
      e.preventDefault();
      const err = forms.up.querySelector('.err'); err.textContent = '';
      const u = $('#uUser').value.trim(), p1 = $('#uPass').value, p2 = $('#uPass2').value;
      if (!/^[a-zA-Z0-9_]{2,32}$/.test(u)) { err.textContent = 'Usernames are 2–32 letters, numbers or underscores.'; return; }
      if (p1.length < 8) { err.textContent = 'Use at least 8 characters for your password.'; return; }
      if (p1 !== p2) { err.textContent = 'Those passwords don’t match.'; return; }
      busy(forms.up, true);
      try {
        const { data: free } = await window.db.rpc('is_username_available', { p_username: u });
        if (free === false) throw new Error('That username is taken.');
        const { data, error } = await window.db.auth.signUp({ email: addr(u), password: p1, options: { data: { username: u, display_name: u } } });
        if (error) throw error;
        if (!data.session) {
          const r = await window.db.auth.signInWithPassword({ email: addr(u), password: p1 });
          if (r.error) throw r.error;
        }
        done();
      } catch (ex) { err.textContent = ex.message || 'Could not create that account.'; }
      finally { busy(forms.up, false); }
    };
    setTimeout(() => $('#aUser')?.focus(), 50);
  }

  /* ---------- shell ---------- */
  function mountShell() {
    document.body.classList.remove('is-auth');
    $('#app')?.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <div id="wall"><div class="wall-img"></div><div class="wall-dim"></div></div>
      <div class="app" id="app">
        <div class="drawer">
          <nav class="rail" id="rail" aria-label="Servers"></nav>
          <aside class="side" id="side"><div id="sideView" style="display:flex;flex-direction:column;flex:1;min-height:0"></div><div id="voicePanel"></div><div class="me-panel" id="mePanel"></div></aside>
        </div>
        <main class="main" id="main"></main>
      </div>
      <div class="scrim" id="scrim"></div>`);
    $('#scrim').onclick = closeDrawer;
    wireRail();
    paintRail();
    paintMe();
    NX.call.wirePanel($('#voicePanel'));
    ['servers', 'unread', 'dms', 'friends'].forEach((e) => NX.on(e, NX.debounce(paintRail, 30)));
    NX.on('me', () => { paintMe(); paintRail(); applyTheme(); });
    NX.on('presence', () => P().refreshDots());
    NX.on('call', () => { paintVoicePanel(); paintRail(); });
    NX.on('people', () => P().refreshDots());
    paintVoicePanel();
    document.addEventListener('keydown', globalKeys);
    // swipe from the left edge opens the drawer on phones
    let sx = null, sy = null;
    document.addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX < 24 ? t.clientX : null; sy = t.clientY; }, { passive: true });
    document.addEventListener('touchend', (e) => {
      if (sx == null) return;
      const t = e.changedTouches[0];
      if (t.clientX - sx > 60 && Math.abs(t.clientY - sy) < 60) openDrawer();
      sx = null;
    }, { passive: true });
  }
  function openDrawer() { document.body.classList.add('drawer-open'); }
  function closeDrawer() { document.body.classList.remove('drawer-open'); }
  NX.openDrawer = openDrawer; NX.closeDrawer = closeDrawer;

  /* ---------- rail ---------- */
  function initials(name) {
    return (String(name || '?').trim().split(/\s+/).slice(0, 3).map((w) => [...w][0] || '').join('') || '?').toUpperCase();
  }
  function paintRail() {
    const rail = $('#rail');
    if (!rail) return;
    const r = NX.route();
    const onHome = !r.parts[0] || r.parts[0] === 'home' || r.parts[0] === 'dm';
    const dmN = NX.data.ready ? NX.data.dmUnreadTotal() : 0;
    const servers = NX.data.ready ? NX.data.servers : NX.ls.get('nx_rail_cache', []);
    const activeSrv = r.parts[0] === 's' ? r.parts[1] : (page ? baseRoute.split('/')[1] : null);
    const unreadDms = NX.data.ready ? NX.data.visibleDms().filter((c) => c.unread > 0 && NX.viewing !== 'dm:' + c.id).slice(0, 4) : [];
    const st = NX.call.state();
    const staff = P().rank(NX.me) > 0;
    rail.innerHTML = `
      <div class="r-item${onHome && !page ? ' on' : ''}"><span class="r-pip"></span><a class="r-btn home" href="#/home" data-go="home" data-tip="Direct messages" data-tip-pos="right"><img src="assets/img/logo.svg" alt="Home"></a>${dmN ? `<span class="count">${dmN > 99 ? '99+' : dmN}</span>` : ''}</div>
      ${unreadDms.map((c) => `<div class="r-item unread"><span class="r-pip"></span><a class="r-btn" href="#/dm/${esc(c.id)}" data-go="dm/${esc(c.id)}" data-tip="${esc(NX.data.dmTitle(c))}" data-tip-pos="right">${c.is_group ? '<i class="fa-solid fa-user-group"></i>' : P().avatar(c.people[0], 48, { halo: false, deco: false })}</a><span class="count">${c.unread > 99 ? '99+' : c.unread}</span></div>`).join('')}
      ${st.active ? `<div class="r-item r-call"><a class="r-btn" href="#" data-call data-tip="Back to call: ${esc(st.channel?.name || '')}" data-tip-pos="right"><i class="fa-solid fa-phone-volume"></i></a></div>` : ''}
      <div class="rail-sep"></div>
      <div class="rail-list">${servers.map((s) => `<div class="r-item${s.id === activeSrv ? ' on' : ''}${s.unread && s.id !== activeSrv ? ' unread' : ''}"><span class="r-pip"></span>
        <a class="r-btn tint" href="#/s/${esc(s.id)}" data-go="s/${esc(s.id)}" data-tip="${esc(s.name)}" data-tip-pos="right" data-sid="${esc(s.id)}">${s.icon_url ? `<img ${P().imgAttr(s.icon_url)} alt="">` : `<span style="font-size:${initials(s.name).length > 2 ? 12 : 15}px">${esc(initials(s.name))}</span>`}</a></div>`).join('')}</div>
      <div class="r-item"><span class="r-pip"></span><button class="r-btn add" data-add data-tip="Add a server" data-tip-pos="right"><i class="fa-solid fa-plus"></i></button></div>
      <div class="rail-fill"></div>
      ${staff ? `<div class="r-item${r.parts[0] === 'admin' ? ' on' : ''}"><span class="r-pip"></span><a class="r-btn tint" href="#/admin" data-go="admin" data-tip="Admin console" data-tip-pos="right"><i class="fa-solid fa-shield-halved"></i></a></div>` : ''}`;
  }
  function wireRail() {
    const rail = $('#rail');
    rail.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]');
      if (go) { e.preventDefault(); NX.go(go.dataset.go); if (!go.dataset.go.startsWith('s/')) closeDrawer(); return; }
      if (e.target.closest('[data-add]')) { addServerDialog(); return; }
      if (e.target.closest('[data-call]')) { e.preventDefault(); NX.call.openRoom(); closeDrawer(); }
    });
    rail.addEventListener('contextmenu', (e) => {
      const a = e.target.closest('[data-sid]');
      if (!a) return;
      e.preventDefault();
      const s = NX.data.server(a.dataset.sid);
      if (s) serverMenu(s, e);
    });
  }
  function serverMenu(s, at) {
    const owner = s.owner_id === NX.me.id;
    NX.menu(at, [
      { label: 'Mark as read', icon: 'fa-check', hidden: !s.unread, onClick: () => markServerRead(s) },
      { label: 'Invite people', icon: 'fa-user-plus', onClick: () => NX.views.server?.invite(s.id) },
      { label: 'Server settings', icon: 'fa-gear', onClick: () => NX.go(`s/${s.id}/settings`) },
      { label: 'Copy server ID', icon: 'fa-id-card', onClick: () => NX.copy(s.id, 'ID copied') },
      { sep: true, hidden: owner },
      { label: 'Leave server', icon: 'fa-right-from-bracket', danger: true, hidden: owner, onClick: () => NX.data.leaveServer(s) },
    ]);
  }
  async function markServerRead(s) {
    s.unread = false;
    [...NX.chanServer.entries()].filter(([, sid]) => sid === s.id).forEach(([cid]) => {
      NX.data.chanUnread.set(cid, 0);
      if (NX.data.v3) NX.data.rpc('nx_mark_channel_read', { p_channel: cid });
    });
    NX.emit('servers'); NX.emit('unread');
  }
  NX.markServerRead = markServerRead;
  NX.serverMenu = serverMenu;

  /* ---------- me panel ---------- */
  function paintMe() {
    const el = $('#mePanel');
    if (!el || !NX.me) return;
    const st = NX.call.state();
    const status = P().myStatus();
    el.innerHTML = `
      <div class="me-id" data-a="status" title="Set status">${P().avatar(NX.me, 34, { presence: true })}
        <div class="t"><b>${P().nameText(NX.me)}</b><small>${esc(NX.me.custom_status || P().STATUS_LABEL[status] || '@' + NX.me.username)}</small></div></div>
      <button class="icon-btn${st.active && st.muted ? ' off' : ''}" data-a="mute" data-tip="${st.active ? (st.muted ? 'Unmute' : 'Mute') : 'Mute (in calls)'}"><i class="fa-solid fa-microphone${st.active && st.muted ? '-slash' : ''}"></i></button>
      <button class="icon-btn${st.active && st.deaf ? ' off' : ''}" data-a="deaf" data-tip="${st.active ? (st.deaf ? 'Undeafen' : 'Deafen') : 'Deafen (in calls)'}"><i class="fa-solid fa-headphones${st.active && st.deaf ? '' : ''}"></i></button>
      <button class="icon-btn" data-a="settings" data-tip="User settings"><i class="fa-solid fa-gear"></i></button>`;
    el.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'settings') { NX.go('settings'); closeDrawer(); }
      if (a === 'mute') { if (NX.call.active()) NX.call.toggleMute(); else NX.toast('You’re not in a call.'); }
      if (a === 'deaf') { if (NX.call.active()) NX.call.toggleDeaf(); else NX.toast('You’re not in a call.'); }
      if (a === 'status') statusMenu(e.target.closest('[data-a]'));
    };
  }
  NX.on('call', paintMe);
  function statusMenu(at) {
    const cur = P().myStatus();
    const opt = (k, label, sub) => ({ label, dot: P().STATUS_COLOR[k], on: cur === k, onClick: () => P().setStatus(k === 'invisible' ? 'offline' : k), kbd: sub });
    NX.menu(at, [
      { header: '@' + NX.me.username },
      opt('online', 'Online'), opt('idle', 'Idle'), opt('dnd', 'Do not disturb', 'no alerts'), opt('invisible', 'Invisible'),
      { sep: true },
      { label: NX.me.custom_status ? 'Edit custom status' : 'Set a custom status', icon: 'fa-face-smile', onClick: setCustomStatus },
      { label: 'Edit profile', icon: 'fa-pen', onClick: () => NX.go('settings/profile') },
      { label: 'Copy username', icon: 'fa-at', onClick: () => NX.copy('@' + NX.me.username, 'Username copied') },
      { sep: true },
      { label: 'Sign out', icon: 'fa-right-from-bracket', danger: true, onClick: signOut },
    ], { side: 'top' });
  }
  async function setCustomStatus() {
    const v = await NX.prompt({ title: 'Custom status', label: 'What’s up?', value: NX.me.custom_status || '', max: 128, allowEmpty: true, ok: 'Save' });
    if (v === null) return;
    const { error } = await window.db.from('profiles').update({ custom_status: v || null }).eq('id', NX.me.id);
    if (error) return NX.fail(error);
    NX.me.custom_status = v || null; P().put({ id: NX.me.id, custom_status: NX.me.custom_status });
    NX.emit('me');
  }
  async function signOut() {
    if (!await NX.confirm({ title: 'Sign out?', body: 'You’ll need your username and password to sign back in.', ok: 'Sign out', danger: true })) return;
    try { await NX.call.leave(); } catch {}
    await window.db.auth.signOut().catch(() => {});
    NX.ls.del('nx_rail_cache');
    NX.reload();
  }
  NX.signOut = signOut;

  function paintVoicePanel() {
    const el = $('#voicePanel');
    if (el) el.innerHTML = NX.call.panelHtml();
  }

  /* ---------- theme: wallpaper + glass + accent ---------- */
  // Glass needs something behind it; without a wallpaper it gets this scene.
  const GLASS_DEFAULT_BG = 'radial-gradient(70% 70% at 85% 10%,#4b2a99,transparent 60%),radial-gradient(60% 60% at 10% 90%,#0e6b74,transparent 60%),radial-gradient(50% 50% at 50% 50%,#2a1546,transparent 70%),#07080c';
  function applyTheme() {
    const t = NX.me?.theme || {};
    const root = document.documentElement.style;
    document.body.classList.toggle('glass', t.ui_style === 'glass');
    document.body.classList.toggle('compact', t.density === 'compact');
    document.body.classList.toggle('reduce-motion', !!t.reduce_motion);
    if (t.chat_fs) root.setProperty('--chat-fs', t.chat_fs + 'px'); else root.removeProperty('--chat-fs');
    // The app accent (a server's own accent wins while that server is open).
    NX.userAccent = /^#[0-9a-f]{6}$/i.test(t.ui_accent || '') ? t.ui_accent : null;
    if (!document.documentElement.dataset.srvAccent) {
      if (NX.userAccent) root.setProperty('--accent', NX.userAccent); else root.removeProperty('--accent');
    }
    const key = (() => {
      if (!t.dash_wallpaper_key) return '';
      if (!t.dash_bg) return t.dash_wallpaper_key;
      try { if (/^url\(/i.test(t.dash_bg) && decodeURIComponent(t.dash_bg).includes(t.dash_wallpaper_key)) return t.dash_wallpaper_key; } catch {}
      return '';
    })();
    const set = (bg) => {
      if (!bg) { document.body.classList.remove('has-bg'); root.removeProperty('--dash-bg'); return; }
      document.body.classList.add('has-bg');
      root.setProperty('--dash-bg', bg);
      root.setProperty('--dash-dim', (t.dash_dim ?? 0) / 100);
      root.setProperty('--dash-blur', (t.dash_blur ?? 0) + 'px');
      root.setProperty('--dash-bright', (t.dash_bright ?? 100) / 100);
      root.setProperty('--chat-dim', (t.chat_dim ?? 42) / 100);
      root.setProperty('--chat-blur', (t.chat_blur ?? (t.ui_style === 'glass' ? 5 : 12)) + 'px');
    };
    if (key && window.Store) {
      window.Store.signKey(key).then((u) => set(`url("${u}")`)).catch(() => set(null));
    } else set(t.dash_bg || (t.ui_style === 'glass' ? GLASS_DEFAULT_BG : null));
  }
  NX.applyTheme = applyTheme;

  /* ---------- routing ---------- */
  function route(r) {
    r = r || NX.route();
    const [a, b, c, d] = r.parts;
    if (a === 'invite' && b) { NX.go('home', { replace: true, silent: true }); inviteFlow(b); return route(NX.route()); }
    // overlay pages keep whatever is underneath alive (calls keep running)
    const pageName = a === 'settings' ? 'settings' : a === 'admin' ? 'admin' : (a === 's' && c === 'settings') ? 'serverSettings' : null;
    if (pageName) {
      if (!current) show('home', ['home']);
      openPage(pageName, r);
      paintRail();
      return;
    }
    closePage();
    baseRoute = r.raw || 'home';
    if (a === 's' && b) show('server', r.parts, r);
    else if (a === 'dm' && b) show('dms', r.parts, r);
    else show('home', r.parts, r);
    paintRail();
    closeDrawer();
    if (NX.isNarrow() && a === 's' && !c) openDrawer();
  }
  function show(name, parts, r = NX.route()) {
    const view = NX.views[name];
    if (!view) return;
    if (current?.name !== name) {
      current?.view.leave?.();
      $('#sideView').innerHTML = '';
      $('#main').innerHTML = '';
      $('#app').classList.toggle('no-side', !!view.noSide);
      current = { name, view };
      view.enter($('#sideView'), $('#main'), parts, r);
    } else view.update?.(parts, r);
  }
  function openPage(name, r) {
    if (page?.name === name) { page.view.update?.(r.parts, r); return; }
    closePage(true);
    const view = NX.views[name];
    if (!view) return NX.go('home');
    const host = NX.h('<div class="page" role="dialog" aria-modal="true"></div>');
    document.body.appendChild(host);
    page = { name, view, host };
    view.enter(host, r.parts, r);
  }
  function closePage(swap) {
    if (!page) return;
    page.view.leave?.();
    page.host.remove();
    page = null;
    if (!swap) NX.viewing = current?.view.viewingKey?.() || null;
  }
  NX.closePage = () => NX.go(baseRoute || 'home');
  NX.baseRoute = () => baseRoute;

  function globalKeys(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); switcher(); return; }
    if (e.key === 'Escape' && page && !NX.topModal() && !document.querySelector('.menu, .ucard, .emoji-pick, .lightbox')) { NX.closePage(); return; }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { current?.view.step?.(e.key === 'ArrowUp' ? -1 : 1); e.preventDefault(); }
    // typing anywhere goes to the composer
    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && !page && !NX.topModal()
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
      const ta = $('#main .composer textarea');
      if (ta && !ta.disabled) ta.focus();
    }
  }

  /* ---------- dialogs ---------- */
  function addServerDialog() {
    const m = NX.modal({
      title: 'Add a server', sub: 'Your server is where you and your friends hang out.', center: true,
      body: `<button class="choice" data-k="create"><span class="c-ico"><i class="fa-solid fa-wand-magic-sparkles"></i></span><span><b>Create my own</b><small>Start fresh with text and voice channels.</small></span><i class="fa-solid fa-chevron-right chev"></i></button>
        <button class="choice" data-k="join"><span class="c-ico teal"><i class="fa-solid fa-right-to-bracket"></i></span><span><b>Join with an invite</b><small>Got a code or link from a friend?</small></span><i class="fa-solid fa-chevron-right chev"></i></button>`,
    });
    m.body.onclick = (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (!k) return;
      m.close();
      if (k === 'create') createServerDialog(); else joinServerDialog();
    };
  }
  NX.addServerDialog = addServerDialog;
  function createServerDialog() {
    let icon = null;
    const body = NX.h(`<div style="display:flex;flex-direction:column;gap:16px;align-items:center">
      <label class="upload-zone"><span class="uz-prev"><i class="fa-solid fa-camera"></i></span><input type="file" accept="image/*" hidden></label>
      <div class="field" style="width:100%"><label>Server name</label><input class="input" maxlength="100" value="${esc(P().nameOf(NX.me))}’s server"></div>
      <p class="hint">By creating a server you agree to be nice in it.</p></div>`);
    const prev = body.querySelector('.uz-prev');
    body.querySelector('input[type=file]').onchange = (e) => {
      icon = e.target.files[0]; if (!icon) return;
      prev.style.backgroundImage = `url("${URL.createObjectURL(icon)}")`; prev.innerHTML = '';
    };
    const m = NX.modal({
      title: 'Customize your server', sub: 'Give it a name and an icon. You can change both later.', center: true, body,
      foot: [{ label: 'Back', onClick: () => { addServerDialog(); } }, {
        label: 'Create', cls: 'btn-primary', primary: true, onClick: async () => {
          const name = body.querySelector('.input').value.trim();
          if (name.length < 2) { NX.toast('Server names need at least 2 characters.', { err: true }); return false; }
          const id = await NX.data.createServer(name, icon);
          return id ? true : false;
        },
      }],
    });
    body.querySelector('.input').addEventListener('keydown', (e) => { if (e.key === 'Enter') m.primary.click(); });
  }
  function joinServerDialog(prefill = '') {
    const body = NX.h(`<div class="field"><label>Invite code or link</label><input class="input" placeholder="a1b2c3d4 or https://…?invite=a1b2c3d4" value="${esc(prefill)}"><span class="hint">Invites look like <span class="mono">a1b2c3d4</span>.</span></div>`);
    const m = NX.modal({
      title: 'Join a server', sub: 'Enter an invite below to join an existing server.', center: true, body,
      foot: [{ label: 'Back', onClick: () => { addServerDialog(); } }, {
        label: 'Join server', cls: 'btn-primary', primary: true,
        onClick: async () => !!(await NX.data.joinServer(body.querySelector('input').value)),
      }],
    });
    body.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') m.primary.click(); });
  }
  NX.joinServerDialog = joinServerDialog;
  async function inviteFlow(code) {
    const { data } = await window.db.from('invites').select('server_id, servers(name,icon_url)').eq('code', code).maybeSingle();
    if (data && NX.data.server(data.server_id)) { NX.go('s/' + data.server_id); return; }
    joinServerDialog(code);
  }

  function newDmDialog() {
    const friends = NX.data.friendIds().map((id) => P().get(id)).filter(Boolean).sort((a, b) => P().nameOf(a).localeCompare(P().nameOf(b)));
    const picked = new Set();
    const body = NX.h(`<div style="display:flex;flex-direction:column;gap:12px">
      <input class="input" placeholder="Type the username of a friend">
      <div class="pick-list">${friends.length ? friends.map((f) => `<label class="pick-row" data-id="${esc(f.id)}" data-n="${esc((P().nameOf(f) + ' ' + f.username).toLowerCase())}">${P().avatar(f, 32, { presence: true })}<span class="grow"><b style="font-weight:600">${P().nameText(f)}</b> <small class="muted">${esc(f.username)}</small></span><input type="checkbox"></label>`).join('')
        : '<div class="empty" style="padding:20px"><p>You don’t have any friends yet. Add some from the Friends tab.</p></div>'}</div>
      <div class="field group-name hidden"><label>Group name (optional)</label><input class="input" maxlength="60" placeholder="The squad"></div></div>`);
    const go = () => {
      const ids = [...picked];
      if (!ids.length) { NX.toast('Pick at least one friend.', { err: true }); return false; }
      if (ids.length === 1) { NX.data.openDm(ids[0]); return true; }
      return NX.data.createGroup(body.querySelector('.group-name input').value.trim(), ids).then((id) => !!id);
    };
    const m = NX.modal({ title: 'Select friends', sub: 'Pick one friend for a DM, or up to 9 for a group.', body, foot: [{ label: 'Cancel' }, { label: 'Create DM', cls: 'btn-primary', primary: true, onClick: go }] });
    body.querySelector('input').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      body.querySelectorAll('.pick-row').forEach((r) => { r.hidden = q && !r.dataset.n.includes(q); });
    });
    body.addEventListener('change', (e) => {
      const r = e.target.closest('.pick-row'); if (!r) return;
      if (e.target.checked) { if (picked.size >= 9) { e.target.checked = false; return NX.toast('Groups can have up to 10 people.', { err: true }); } picked.add(r.dataset.id); }
      else picked.delete(r.dataset.id);
      body.querySelector('.group-name').classList.toggle('hidden', picked.size < 2);
      m.primary.textContent = picked.size > 1 ? 'Create group' : 'Create DM';
    });
  }
  NX.newDmDialog = newDmDialog;

  /* Quick switcher: Ctrl/Cmd+K. Conversations, friends, servers, channels. */
  async function switcher() {
    if (document.querySelector('.switcher')) return;
    const items = [];
    NX.data.dms.forEach((c) => items.push({ t: NX.data.dmTitle(c), sub: c.is_group ? 'Group' : '@' + (c.people[0]?.username || ''), icon: c.is_group ? '<i class="fa-solid fa-user-group"></i>' : P().avatar(c.people[0], 24, { halo: false, deco: false }), go: 'dm/' + c.id, unread: c.unread }));
    NX.data.friendIds().forEach((id) => { const p = P().get(id); if (p && !NX.data.dms.some((c) => !c.is_group && c.people[0]?.id === id)) items.push({ t: P().nameOf(p), sub: '@' + p.username, icon: P().avatar(p, 24, { halo: false, deco: false }), fn: () => NX.data.openDm(id) }); });
    NX.data.servers.forEach((s) => items.push({ t: s.name, sub: 'Server', icon: '<i class="fa-solid fa-server"></i>', go: 's/' + s.id }));
    (NX.views.server?.knownChannels?.() || []).forEach((c) => items.push({ t: c.name, sub: NX.data.server(c.server_id)?.name || '', icon: `<i class="fa-solid ${c.type === 'voice' ? 'fa-volume-high' : 'fa-hashtag'}"></i>`, go: `s/${c.server_id}/${c.id}` }));
    const body = NX.h(`<div style="display:flex;flex-direction:column;gap:10px"><input class="input" placeholder="Where would you like to go?" style="height:46px;font-size:16px"><div class="pop-list" style="position:static;box-shadow:none;border:0;padding:0;max-height:50vh;overflow:auto;animation:none"></div><p class="hint">Tip: <span class="kbd">Ctrl</span> <span class="kbd">K</span> opens this anywhere.</p></div>`);
    const list = body.querySelector('.pop-list'), input = body.querySelector('input');
    let shown = [], sel = 0;
    const paint = () => {
      const q = input.value.trim().toLowerCase().replace(/^[@#]/, '');
      shown = (q ? items.filter((i) => i.t.toLowerCase().includes(q) || i.sub.toLowerCase().includes(q)) : items.filter((i) => i.unread).concat(items.slice(0, 12))).slice(0, 14);
      shown = [...new Set(shown)];
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      list.innerHTML = shown.length ? shown.map((i, n) => `<button type="button" data-i="${n}" class="${n === sel ? 'on' : ''}"><span style="width:24px;display:inline-flex;justify-content:center">${i.icon}</span><span class="ellipsis">${esc(i.t)}</span><small>${esc(i.sub)}</small></button>`).join('')
        : '<div class="empty" style="padding:20px"><p>No matches.</p></div>';
    };
    const m = NX.modal({ cls: 'switcher', body });
    const pick = (i) => { if (!i) return; m.close(); if (i.go) NX.go(i.go); else i.fn(); };
    input.addEventListener('input', () => { sel = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); paint(); }
      if (e.key === 'Enter') { e.preventDefault(); pick(shown[sel]); }
    });
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pick(shown[+b.dataset.i]); });
    paint();
  }
  NX.switcher = switcher;

  /* ---------- go ---------- */
  NX.boot = boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
