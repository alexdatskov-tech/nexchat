/* Home dashboard: a live clock and greeting, the weather where you are,
   announcements you can't miss, what changed in NexChat, who's around and
   your servers. Also shows new announcements once in a popup when the app
   opens. Weather comes from Open-Meteo (no key); the place is either your
   device's location or a city you pick, saved on this device only. */
(function () {
  const { esc, fmt } = NX;
  const D = () => NX.data;
  const P = () => NX.people;

  /* ---------- what's new ---------- */
  const VERSION = '3.1';
  const CHANGELOG = [
    {
      v: '3.1', date: '2026-10-22', title: 'Calls you can actually see, and a real home page',
      items: [
        ['fa-video', 'Video tiles keep the real shape of each camera, so nobody is zoomed in or cropped any more.'],
        ['fa-clone', 'One-to-one calls put the other person front and centre with you in a small corner preview. Tap it to swap, drag it to any corner.'],
        ['fa-display', 'Screen shares take the main stage with everyone else in a strip below, and the call controls stay put.'],
        ['fa-expand', 'Full screen is now real full screen on phones and desktops.'],
        ['fa-house', 'This page: a clock, the weather where you are, announcements, what’s new, who’s around and big server cards.'],
        ['fa-cloud-sun-rain', 'Colourful animated weather icons (Meteocons by Bas Milius). They hold still if you turn on Reduce motion.'],
        ['fa-cloud-sun', 'Weather on the home page: tap it for the full forecast (24 hours, 7 days, UV, air quality, wind and more), checked against several weather services. It never asks for your location unless you choose to share it.'],
        ['fa-clock-rotate-left', 'Miss the old look? Settings → Appearance → Interface → Classic brings back the original NexChat style, rebuilt on the new app.'],
        ['fa-mobile-screen', 'The sidebar on phones is no longer greyed out behind its own shadow.'],
        ['fa-image', 'Very wide screenshots no longer leave an empty box under them.'],
        ['fa-ghost', 'Chats with accounts that were deleted show as “Deleted user” instead of “Unknown”.'],
      ],
    },
    {
      v: '3.0', date: '2026-10-21', title: 'The big rebuild',
      items: [
        ['fa-bolt', 'One app instead of separate pages: switching servers and chats is instant and calls keep going while you move around.'],
        ['fa-cloud-arrow-up', 'Much faster uploads: photos are shrunk before sending and several files go up at once.'],
        ['fa-wand-magic-sparkles', 'A new look with optional liquid glass, accent colours, compact mode and chat text size.'],
        ['fa-sliders', 'Settings rebuilt from scratch, with live previews.'],
        ['fa-gem', 'A smoother Nitro shop and vibrant, glowing name styles, including ASCII art names.'],
        ['fa-shield-halved', 'A new admin panel and a long list of security fixes.'],
        ['fa-reply', 'Replies, reactions, edits, deletes and typing indicators all update live.'],
      ],
    },
  ];

  /* ---------- announcements ---------- */
  let anns = null;
  async function loadAnns() {
    const { data, error } = await window.db.from('announcements').select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(20);
    anns = error ? [] : (data || []).filter((a) => !a.expires_at || new Date(a.expires_at) > new Date());
    return anns;
  }
  const LV = { info: ['fa-circle-info', 'Info'], update: ['fa-rocket', 'Update'], warning: ['fa-triangle-exclamation', 'Heads up'], event: ['fa-calendar-days', 'Event'] };
  const seenAt = () => NX.ls.get('nx_ann_seen') || '';
  const isNew = (a) => a.created_at > seenAt();
  function annCard(a, big) {
    const lv = LV[a.level] || LV.info;
    return `<article class="dash-ann lv-${esc(a.level || 'info')}${big ? ' big' : ''}${isNew(a) ? ' new' : ''}">
      <div class="da-ico"><i class="fa-solid ${lv[0]}"></i></div>
      <div class="da-main"><div class="da-meta"><span class="da-tag">${lv[1]}</span>${a.pinned ? '<span class="da-pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}${isNew(a) ? '<span class="da-new">New</span>' : ''}<span>${esc(fmt.ago(a.created_at))}</span></div>
        <h3>${esc(a.title)}</h3>${a.body ? `<div class="da-body m-text">${MD.render(a.body)}</div>` : ''}</div></article>`;
  }
  // New announcements pop up once when the app opens; after that they stay
  // on the home page.
  async function announceNew() {
    const list = await loadAnns();
    const fresh = list.filter(isNew);
    if (!fresh.length) return;
    const body = NX.h(`<div class="dash-ann-pop">${fresh.slice(0, 4).map((a) => annCard(a, true)).join('')}${fresh.length > 4 ? `<p class="muted" style="font-size:13px">and ${fresh.length - 4} more on the home page.</p>` : ''}</div>`);
    NX.modal({
      title: fresh.length === 1 ? 'Announcement' : `${fresh.length} new announcements`, body, wide: true,
      foot: [{ label: 'Got it', cls: 'btn-primary', onClick: () => markSeen() }],
      onClose: () => markSeen(),
    });
  }
  function markSeen() {
    const top = (anns || []).reduce((m, a) => (a.created_at > m ? a.created_at : m), seenAt());
    NX.ls.set('nx_ann_seen', top);
  }

  /* ---------- the page ---------- */
  let host = null, tick = null;
  function render(el) {
    host = el;
    el.innerHTML = `<div class="dash">
      <section class="dash-anns"></section>
      <section class="dash-hero" data-sky="clear">
        <div class="dh-fx" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="dh-left">
          <div class="dh-greet"></div>
          <div class="dh-hey"></div>
          <div class="dh-clock"><span class="dh-hm mono"></span><span class="dh-s mono"></span><span class="dh-ap"></span></div>
          <div class="dh-date"></div>
          <div class="dh-day"><div class="dh-day-bar"><i></i></div><span></span></div>
          <div class="dh-chips"></div>
        </div>
        <div class="dash-wx"></div>
      </section>
      <section class="dash-servers"><div class="ds-head"><h2><i class="fa-solid fa-server"></i>Your servers<span class="ds-n"></span></h2><span class="grow"></span>
        <button class="btn btn-ghost btn-sm" data-f="join"><i class="fa-solid fa-right-to-bracket"></i>Join</button><button class="btn btn-primary btn-sm" data-f="create"><i class="fa-solid fa-plus"></i>Create</button></div>
        <div class="ds-row"></div></section>
      <div class="dash-grid">
        <section class="dash-card dc-active"><h2><i class="fa-solid fa-signal"></i>Active now</h2><div class="dc-body"></div></section>
        <section class="dash-card dc-news"><h2><i class="fa-solid fa-wand-magic-sparkles"></i>What’s new<span class="grow"></span><span class="ver">v${VERSION}</span></h2><div class="dc-body"></div></section>
      </div>

    </div>`;
    el.querySelector('.dash').addEventListener('click', onClick);
    clearInterval(tick);
    tick = setInterval(() => { if (!host?.isConnected) { clearInterval(tick); tick = null; return; } paintClock(); }, 1000);
    paintClock(); paintChips(); paintActive(); paintNews(); paintServers();
    NX.weather.mount(el.querySelector('.dash'));
    (anns ? Promise.resolve(anns) : loadAnns()).then(paintAnns);
    NX.ls.set('nx_seen_ver', VERSION);
  }
  const $d = (sel) => host?.querySelector(sel);

  function paintClock() {
    const now = new Date();
    const h = now.getHours();
    const greet = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Good night';
    const g = $d('.dh-greet');
    if (!g) return;
    const gt = `${greet}, ${P().nameText(NX.me)}`;
    if (g.dataset.t !== gt) {
      g.dataset.t = gt; g.innerHTML = `${greet}, <b>${P().nameText(NX.me)}</b>`;
      // the classic portal's hero: "Hey, name 👋" with a line for the time of day
      const sub = h < 5 ? 'Still up? Somebody’s always around.' : h < 12 ? 'Fresh start. See who’s up.' : h < 17 ? 'Afternoon check-in.' : h < 22 ? 'Evening hangout time.' : 'Winding down? Say goodnight.';
      const phrase = h < 5 ? 'Up late?' : greet;
      $d('.dh-hey').innerHTML = `<div class="dh-hey-top">${P().avatar(NX.me, 22, { halo: false, deco: false })}<span>${esc(phrase)}</span></div><h1>Hey, <span class="dh-hey-n">${P().nameText(NX.me)}</span> <span class="wave">👋</span></h1><p>${esc(sub)}</p>`;
    }
    const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).formatToParts(now);
    const pick = (t) => parts.find((p) => p.type === t)?.value || '';
    $d('.dh-hm').textContent = `${pick('hour')}:${pick('minute')}`;
    $d('.dh-s').textContent = pick('second');
    $d('.dh-ap').textContent = pick('dayPeriod');
    $d('.dh-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const pct = ((now - new Date(now).setHours(0, 0, 0, 0)) / 864e5) * 100;
    $d('.dh-day-bar i').style.width = pct.toFixed(2) + '%';
    $d('.dh-day span').textContent = `${Math.floor(pct)}% of today done`;
  }
  function paintChips() {
    const el = $d('.dh-chips');
    if (!el) return;
    const online = D().friendIds().filter((id) => P().isOnline(id)).length;
    const unread = D().dms.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0);
    const live = window.Voice?.live?.() || new Map();
    const calls = D().dms.filter((c) => live.get('dm-' + c.id)).length;
    el.innerHTML = [
      `<button class="dh-chip" data-go="home/online"><i class="fa-solid fa-circle" style="color:var(--ok)"></i><b>${online}</b> ${online === 1 ? 'friend' : 'friends'} online</button>`,
      unread ? `<button class="dh-chip hot" data-go="${esc('dm/' + D().dms.find((c) => c.unread > 0).id)}"><i class="fa-solid fa-envelope"></i><b>${unread}</b> unread ${unread === 1 ? 'chat' : 'chats'}</button>` : '',
      calls ? `<span class="dh-chip live"><i class="fa-solid fa-phone-volume"></i><b>${calls}</b> ${calls === 1 ? 'call' : 'calls'} going on</span>` : '',
      D().incoming().length ? `<button class="dh-chip hot" data-go="home/pending"><i class="fa-solid fa-user-plus"></i><b>${D().incoming().length}</b> friend ${D().incoming().length === 1 ? 'request' : 'requests'}</button>` : '',
    ].join('');
  }
  function paintAnns() {
    const el = $d('.dash-anns');
    if (!el) return;
    const list = anns || [];
    el.innerHTML = list.length
      ? `<div class="dash-sect"><i class="fa-solid fa-bullhorn"></i>Announcements${list.some(isNew) ? `<span class="da-new">${list.filter(isNew).length} new</span>` : ''}</div>${list.slice(0, 6).map((a, i) => annCard(a, i === 0)).join('')}`
      : '';
    if (list.length) setTimeout(markSeen, 1500);
  }
  function paintActive() {
    const el = $d('.dc-active .dc-body');
    if (!el) return;
    const live = window.Voice?.live?.() || new Map();
    const calls = D().dms.filter((c) => live.get('dm-' + c.id));
    const online = D().friendIds().map((id) => P().get(id)).filter((p) => p && P().isOnline(p.id))
      .sort((a, b) => P().nameOf(a).localeCompare(P().nameOf(b))).slice(0, 10);
    el.innerHTML = calls.map((c) => `<div class="active-card" data-go="dm/${esc(c.id)}?join=1">${c.is_group ? '<span class="av" style="width:36px;height:36px;background:var(--accent)"><i class="fa-solid fa-user-group"></i></span>' : P().avatar(c.people[0], 36, { presence: true })}<div class="t"><b>${esc(D().dmTitle(c))}</b><small style="color:var(--ok)"><i class="fa-solid fa-phone-volume"></i> In a call · ${live.get('dm-' + c.id)}</small></div><button class="btn btn-ok btn-sm">Join</button></div>`).join('')
      + online.map((p) => `<div class="active-card" data-dm="${esc(p.id)}">${P().avatar(p, 36, { presence: true })}<div class="t"><b>${P().nameText(p)}</b><small>${esc(p.custom_status || P().STATUS_LABEL[P().presenceOf(p.id)])}</small></div><i class="fa-solid fa-message" style="color:var(--txt-3)"></i></div>`).join('')
      + (!calls.length && !online.length ? `<div class="dc-empty"><i class="fa-solid fa-moon"></i><b>It’s quiet right now</b><span>Friends who come online show up here.</span><button class="btn btn-ghost btn-sm" data-go="home/add"><i class="fa-solid fa-user-plus"></i>Add a friend</button></div>` : '');
  }
  function paintNews() {
    const el = $d('.dc-news .dc-body');
    if (!el) return;
    el.innerHTML = CHANGELOG.map((r, i) => `<details class="cl-rel"${i === 0 ? ' open' : ''}><summary><span class="cl-v">v${esc(r.v)}</span><b>${esc(r.title)}</b><small>${esc(new Date(r.date + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</small></summary>
      <ul>${r.items.map(([ic, t]) => `<li><i class="fa-solid ${ic}"></i><span>${esc(t)}</span></li>`).join('')}</ul></details>`).join('');
  }
  // Descriptions, banners and member counts aren't in the inbox, so they're
  // fetched once per set of servers.
  const srvInfo = new Map();
  let srvInfoKey = '';
  async function loadServerInfo(ids) {
    const key = ids.slice().sort().join(',');
    if (!ids.length || key === srvInfoKey) return false;
    srvInfoKey = key;
    const { data } = await window.db.from('servers').select('id,description,banner_url,server_members(count)').in('id', ids);
    (data || []).forEach((r) => srvInfo.set(r.id, { description: r.description, banner_url: r.banner_url, members: r.server_members?.[0]?.count ?? null }));
    return true;
  }
  function srvGradient(id) {
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const a = Math.round((h * 137.508) % 360), b = (a + 48) % 360;
    return `radial-gradient(120% 140% at 0% 0%, hsl(${a} 70% 48%) 0%, transparent 62%), radial-gradient(100% 120% at 100% 100%, hsl(${b} 65% 40%) 0%, transparent 60%), linear-gradient(135deg, hsl(${b} 45% 22%), hsl(${a} 35% 12%))`;
  }
  function paintServers() {
    const row = $d('.ds-row');
    if (!row) return;
    const list = D().servers;
    $d('.ds-n').textContent = list.length ? ` · ${list.length}` : '';
    if (!list.length) {
      row.innerHTML = `<div class="dc-empty" style="grid-column:1/-1"><i class="fa-solid fa-compass"></i><b>No servers yet</b><span>Start your own, or join one with an invite link.</span></div>`;
      return;
    }
    row.innerHTML = list.map((s) => {
      const info = srvInfo.get(s.id) || {};
      const nameStyle = NX.serverNameStyle ? NX.serverNameStyle(s.theme) : '';
      const ini = esc(((s.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('') || '?').toUpperCase());
      return `<button class="ds-card${s.unread ? ' unread' : ''}" data-go="s/${esc(s.id)}">
        <span class="ds-banner" style="background:${srvGradient(s.id)}" data-banner="${esc(info.banner_url || '')}"></span>
        <span class="ds-ic">${s.icon_url ? `<img ${P().imgAttr(s.icon_url)} alt="">` : ini}</span>
        ${s.unread ? '<span class="ds-new">New</span>' : ''}
        <span class="ds-body"><b class="ds-name" style="${esc(nameStyle)}">${esc(s.name)}</b>
          <span class="ds-desc">${info.description ? esc(info.description) : '<i>No description yet</i>'}</span>
          <span class="ds-foot">${info.members != null ? `<span><i class="fa-solid fa-user-group"></i>${NX.fmt.plural(info.members, 'member')}</span>` : '<span></span>'}${s.owner_id === NX.me.id ? '<span class="ds-own"><i class="fa-solid fa-crown"></i>Owner</span>' : ''}</span></span>
      </button>`;
    }).join('') + `<button class="ds-card ds-add" data-f="add-srv"><span class="ds-add-ic"><i class="fa-solid fa-plus"></i></span><b>Create or join</b><span>Start a server or use an invite</span></button>`;
    row.querySelectorAll('.ds-banner[data-banner]').forEach((b) => {
      const u = b.dataset.banner;
      if (u) NX.files.resolved(u).then((x) => { b.style.background = `url("${x}") center / cover`; }).catch(() => {});
    });
    loadServerInfo(list.map((s) => s.id)).then((changed) => { if (changed && host?.isConnected) paintServers(); }).catch(() => {});
  }

  function onClick(e) {
    if (e.target.closest('[data-w]')) return;   // weather buttons: nx-weather.js
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (f === 'create' || f === 'add-srv') return NX.addServerDialog();
    if (f === 'join') return NX.joinServerDialog();
    const g = e.target.closest('[data-go]'); if (g) return NX.go(g.dataset.go);
    const d = e.target.closest('[data-dm]'); if (d) return D().openDm(d.dataset.dm);
  }

  const repaint = NX.debounce(() => { if (!host?.isConnected) return; paintChips(); paintActive(); paintServers(); }, 60);
  ['presence', 'friends', 'dms', 'servers', 'unread', 'live', 'call'].forEach((ev) => NX.on(ev, repaint));
  NX.on('announcements', () => loadAnns().then(() => { if (host?.isConnected) paintAnns(); else announceNew(); }));

  NX.dash = { render, announceNew, loadAnns, VERSION };
})();
