/* Home (friends) and direct messages. Both share the conversation sidebar. */
(function () {
  const { esc, fmt } = NX;
  const P = () => NX.people;
  const D = () => NX.data;
  let side = null, main = null;
  let offs = [];

  /* ---------- sidebar: conversations ---------- */
  function mountSide(host) {
    host.innerHTML = `
      <div class="side-head" style="padding:0 10px"><button class="side-search" data-a="find"><span class="grow">Find or start a conversation</span><span class="kbd">Ctrl K</span></button></div>
      <div class="side-body" id="dmSide"></div>`;
    side = host.querySelector('#dmSide');
    host.querySelector('[data-a="find"]').onclick = () => NX.switcher();
    side.addEventListener('click', onSideClick);
    side.addEventListener('contextmenu', (e) => {
      const it = e.target.closest('[data-cid]');
      if (!it) return;
      e.preventDefault();
      dmMenu(D().dm(it.dataset.cid), e);
    });
    paintSide();
  }
  function paintSide() {
    if (!side) return;
    const r = NX.route();
    const onHome = (!r.parts[0] || r.parts[0] === 'home') && !r.parts[1];
    const onFriends = r.parts[0] === 'home' && !!r.parts[1];
    const pending = D().incoming().length;
    const live = window.Voice?.live?.() || new Map();
    // a 1:1 whose other person deleted their account sinks to the bottom
    const list = D().visibleDms().slice().sort((a, b) => (!a.is_group && !a.people[0]) - (!b.is_group && !b.people[0]));
    side.innerHTML = `
      <a class="s-item big${onHome ? ' on' : ''}" href="#/home" data-go="home"><i class="fa-solid fa-house"></i><span class="nm">Home</span></a>
      <a class="s-item big${onFriends ? ' on' : ''}" href="#/home/online" data-go="home/online"><i class="fa-solid fa-user-group"></i><span class="nm">Friends</span>${pending ? `<span class="count">${pending}</span>` : ''}</a>
      <div class="side-sect"><span class="grow">Direct messages</span><button class="icon-btn" data-a="new" data-tip="Create DM"><i class="fa-solid fa-plus"></i></button></div>
      ${list.length ? list.map((c) => {
        const o = c.people[0];
        const unread = c.unread > 0 && NX.viewing !== 'dm:' + c.id;
        const gone = !c.is_group && !o;
        const sub = c.is_group ? NX.fmt.plural(c.people.length + 1, 'member') : gone ? 'This account no longer exists'
          : (o?.custom_status || (c.last ? (c.last.author_id === NX.me.id ? 'You: ' : '') + (c.last.content ? MD.plain(c.last.content, 60) : 'Sent a file') : '@' + (o?.username || '')));
        const inCall = live.get('dm-' + c.id);
        return `<a class="s-item dm${r.parts[1] === c.id ? ' on' : ''}${unread ? ' unread' : ''}" href="#/dm/${esc(c.id)}" data-go="dm/${esc(c.id)}" data-cid="${esc(c.id)}">
          ${c.is_group ? `<span class="av" style="width:32px;height:32px;background:var(--accent);font-size:13px"><i class="fa-solid fa-user-group"></i></span>`
            : gone ? '<span class="av" style="width:32px;height:32px;background:var(--bg-4);color:var(--txt-3);font-size:13px"><i class="fa-solid fa-ghost"></i></span>' : P().avatar(o, 32, { presence: true, deco: false })}
          <span class="t"><b>${esc(D().dmTitle(c))}</b><small>${inCall ? '<span style="color:var(--ok)"><i class="fa-solid fa-phone-volume"></i> Call in progress</span>' : esc(sub)}</small></span>
          ${unread ? `<span class="count">${c.unread > 99 ? '99+' : c.unread}</span>` : `<button class="icon-btn sm x" data-a="close" data-cid="${esc(c.id)}" title="${c.is_group ? 'Leave group' : 'Close DM'}"><i class="fa-solid fa-xmark"></i></button>`}
        </a>`;
      }).join('') : '<div class="empty" style="padding:24px 10px"><p style="font-size:13px">No conversations yet. Message a friend to get started.</p></div>'}`;
  }
  function onSideClick(e) {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'new') { e.preventDefault(); return NX.newDmDialog(); }
    if (a === 'close') { e.preventDefault(); e.stopPropagation(); return D().leaveDm(D().dm(e.target.closest('[data-cid]').dataset.cid)); }
    const go = e.target.closest('[data-go]');
    if (go) { e.preventDefault(); NX.go(go.dataset.go); }
  }
  function dmMenu(c, at) {
    if (!c) return;
    const o = c.people[0];
    NX.menu(at, [
      { label: 'Mark as read', icon: 'fa-check', hidden: !c.unread, onClick: () => D().markDmRead(c.id) },
      { label: 'Profile', icon: 'fa-user', hidden: c.is_group, onClick: () => P().card(o.id, at.target || at) },
      { label: 'Start a call', icon: 'fa-phone', onClick: () => NX.go('dm/' + c.id + '?call=1') },
      { label: 'Rename group', icon: 'fa-pen', hidden: !c.is_group, onClick: () => renameGroup(c) },
      { label: 'Add people', icon: 'fa-user-plus', hidden: !c.is_group, onClick: () => addToGroup(c) },
      { sep: true },
      { label: c.is_group ? 'Leave group' : 'Close DM', icon: c.is_group ? 'fa-right-from-bracket' : 'fa-xmark', danger: c.is_group, onClick: () => D().leaveDm(c) },
    ]);
  }
  async function renameGroup(c) {
    const v = await NX.prompt({ title: 'Rename group', label: 'Group name', value: c.name || '', max: 60 });
    if (v == null) return;
    const { error } = await NX.must(window.db.from('dm_conversations').update({ name: v }).eq('id', c.id));
    if (error) return NX.fail(error);
    c.name = v; NX.emit('dms');
  }
  async function addToGroup(c) {
    const have = new Set(c.people.map((p) => p.id));
    const friends = D().friendIds().filter((id) => !have.has(id)).map((id) => P().get(id)).filter(Boolean);
    if (!friends.length) return NX.toast('All your friends are already in this group.');
    const body = NX.h(`<div class="pick-list">${friends.map((f) => `<label class="pick-row" data-id="${esc(f.id)}">${P().avatar(f, 32)}<span class="grow">${P().nameText(f)} <small class="muted">${esc(f.username)}</small></span><input type="checkbox"></label>`).join('')}</div>`);
    NX.modal({
      title: 'Add friends to group', body, foot: [{ label: 'Cancel' }, {
        label: 'Add', cls: 'btn-primary', onClick: async () => {
          const ids = [...body.querySelectorAll('input:checked')].map((i) => i.closest('[data-id]').dataset.id);
          if (!ids.length) return false;
          const { error } = await window.db.from('dm_participants').insert(ids.map((id) => ({ conversation_id: c.id, user_id: id })));
          if (error) throw error;
          await D().reloadDms();
          NX.toast(`Added ${NX.fmt.plural(ids.length, 'person', 'people')}.`);
        },
      }],
    });
  }

  function watchCalls() {
    const ids = D().dms.map((c) => 'dm-' + c.id).concat(NX.views.server?.voiceIds?.() || []);
    window.Voice?.watch?.(ids);
  }
  window.Voice?.onLive?.(() => { paintSide(); NX.emit('live'); });

  /* ---------- Home: friends ---------- */
  let tab = 'home';
  function homeMain(host, parts) {
    tab = ['online', 'all', 'pending', 'blocked', 'add'].includes(parts[1]) ? parts[1] : 'home';
    const dash = tab === 'home';
    const pending = D().incoming().length;
    host.innerHTML = `
      <div class="main-head">
        <button class="icon-btn h-burger" data-a="burger" aria-label="Menu"><i class="fa-solid fa-bars"></i></button>
        <i class="fa-solid fa-${dash ? 'house' : 'user-group'} h-ico"></i><span class="h-title">${dash ? 'Home' : 'Friends'}</span>
        <div class="tabs" style="margin-left:10px">
          <span class="sep"></span>
          <button data-t="home"><i class="fa-solid fa-house"></i>Home</button>
          <button data-t="online">Online</button><button data-t="all">All</button>
          <button data-t="pending">Pending${pending ? ` <span class="count">${pending}</span>` : ''}</button><button data-t="blocked">Blocked</button>
          <button data-t="add" class="cta">Add Friend</button>
        </div>
        <div class="h-acts"><button class="icon-btn" data-a="new" data-tip="New group DM" data-tip-pos="bottom"><i class="fa-solid fa-comment-medical"></i></button></div>
      </div>
      <div class="home${dash ? ' is-dash' : ''}"><div class="home-main" id="homeList"></div>${dash ? '' : '<aside class="home-aside" id="homeAside"></aside>'}</div>`;
    host.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) NX.go(b.dataset.t === 'home' ? 'home' : 'home/' + b.dataset.t); };
    host.querySelector('[data-a="new"]').onclick = () => NX.newDmDialog();
    host.querySelector('[data-a="burger"]').onclick = () => NX.openDrawer();
    if (NX.isNarrow()) host.querySelector('.tabs').style.cssText = 'margin-left:4px;overflow-x:auto;flex-wrap:nowrap';
    paintTabs();
    paintFriends();
    paintAside();
  }
  function paintTabs() {
    main?.querySelectorAll('.tabs [data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  }
  function personRow(p, actions, sub) {
    return `<div class="person" data-uid-row="${esc(p.id)}">${P().avatar(p, 36, { presence: true })}
      <div class="t"><b>${P().nameText(p)} <span class="muted" style="font-weight:500;font-size:13px">${esc(p.username)}</span></b><small>${esc(sub || '')}</small></div>
      <div class="acts">${actions}</div></div>`;
  }
  function statusSub(p) {
    const st = P().presenceOf(p.id);
    return p.custom_status || P().STATUS_LABEL[st];
  }
  function paintFriends() {
    const host = main?.querySelector('#homeList');
    if (!host) return;
    if (tab === 'home') {
      // the dashboard keeps itself up to date; only draw it once
      if (!host.querySelector('.dash')) { host.onclick = null; NX.dash.render(host); }
      return;
    }
    const q = (host.querySelector('.f-search input')?.value || '').trim().toLowerCase();
    const match = (p) => !q || P().nameOf(p).toLowerCase().includes(q) || p.username.toLowerCase().includes(q);
    const search = `<div class="f-search" style="margin-bottom:6px"><input class="input" placeholder="Search" value="${esc(q)}" style="background:var(--bg-0)"></div>`;
    let html = '';
    if (tab === 'add') {
      html = `<div class="add-friend"><h2>Add friend</h2><p>You can add friends with their NexChat username.</p>
        <form><input placeholder="You can add friends with their username." autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="33"><button class="btn btn-primary" disabled>Send Friend Request</button></form><div class="msg"></div></div>
        <div class="empty" style="padding-top:60px"><div class="ico"><i class="fa-solid fa-user-plus"></i></div><h3>Find your people</h3><p>Ask friends for their username, or share yours: <b class="mono">@${esc(NX.me.username)}</b></p></div>`;
      host.innerHTML = html;
      const form = host.querySelector('form'), inp = form.querySelector('input'), btn = form.querySelector('button'), msg = host.querySelector('.msg');
      inp.oninput = () => { btn.disabled = !inp.value.trim(); msg.innerHTML = ''; };
      form.onsubmit = async (e) => {
        e.preventDefault();
        btn.classList.add('busy');
        const r = await D().addFriend(inp.value);
        btn.classList.remove('busy');
        msg.innerHTML = r.ok ? `<p class="ok-msg">Success! Your friend request to <b>${esc(inp.value.trim().replace(/^@/, ''))}</b> was sent.</p>` : `<p class="err">${esc(r.error)}</p>`;
        if (r.ok) { inp.value = ''; btn.disabled = true; }
      };
      setTimeout(() => inp.focus(), 30);
      return;
    }
    if (tab === 'pending') {
      const inc = D().incoming().map((id) => P().get(id)).filter(Boolean).filter(match);
      const out = D().outgoing().map((id) => P().get(id)).filter(Boolean).filter(match);
      html = search + (inc.length || out.length ? `<div class="list-h">Pending — ${inc.length + out.length}</div>`
        + inc.map((p) => personRow(p, `<button class="round-btn ok" data-f="accept" data-tip="Accept"><i class="fa-solid fa-check"></i></button><button class="round-btn no" data-f="ignore" data-tip="Ignore"><i class="fa-solid fa-xmark"></i></button>`, 'Incoming friend request')).join('')
        + out.map((p) => personRow(p, `<button class="round-btn no" data-f="cancel" data-tip="Cancel"><i class="fa-solid fa-xmark"></i></button>`, 'Outgoing friend request')).join('')
        : empty('fa-hourglass-half', 'No pending requests', 'Requests you send and receive show up here.'));
    } else if (tab === 'blocked') {
      const bl = [...D().blocked];
      P().need(bl).then(() => { if (tab === 'blocked' && bl.some((id) => P().get(id) && !host.querySelector(`[data-uid-row="${id}"]`))) paintFriends(); });
      const people = bl.map((id) => P().get(id)).filter(Boolean).filter(match);
      html = search + (people.length ? `<div class="list-h">Blocked — ${people.length}</div>` + people.map((p) => personRow(p, `<button class="round-btn" data-f="unblock" data-tip="Unblock"><i class="fa-solid fa-user-check"></i></button>`, 'Blocked')).join('')
        : empty('fa-ban', 'Nobody blocked', 'You haven’t blocked anyone.'));
    } else {
      let fr = D().friendIds().map((id) => P().get(id)).filter(Boolean);
      if (tab === 'online') fr = fr.filter((p) => P().isOnline(p.id));
      fr = fr.filter(match).sort((a, b) => (P().isOnline(b.id) - P().isOnline(a.id)) || P().nameOf(a).localeCompare(P().nameOf(b)));
      const total = D().friendIds().length;
      html = search + (fr.length ? `<div class="list-h">${tab === 'online' ? 'Online' : 'All friends'} — ${fr.length}</div>`
        + fr.map((p) => personRow(p, `<button class="round-btn" data-f="msg" data-tip="Message"><i class="fa-solid fa-message"></i></button><button class="round-btn" data-f="call" data-tip="Call"><i class="fa-solid fa-phone"></i></button><button class="round-btn" data-f="more" data-tip="More"><i class="fa-solid fa-ellipsis-vertical"></i></button>`, statusSub(p))).join('')
        : !total ? welcome()
          : empty('fa-moon', tab === 'online' ? 'No one’s around right now' : 'No matches', tab === 'online' ? 'Your friends will show up here when they come online.' : 'Try a different search.'));
    }
    const focused = document.activeElement === host.querySelector('.f-search input');
    host.innerHTML = html;
    const s = host.querySelector('.f-search input');
    if (s) { s.oninput = NX.debounce(paintFriends, 120); if (focused) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
    host.onclick = onFriendClick;
  }
  function empty(icon, title, text) {
    return `<div class="empty" style="padding-top:70px"><div class="ico"><i class="fa-solid ${icon}"></i></div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
  }
  function welcome() {
    return `<div class="hero" style="margin-top:8px"><h1>Welcome to NexChat, ${P().nameText(NX.me)}</h1>
      <p>Add friends, start a server, or jump into one with an invite.</p>
      <div class="hero-acts"><button class="btn btn-primary" data-f="add"><i class="fa-solid fa-user-plus"></i>Add a friend</button>
      <button class="btn btn-ghost" data-f="create"><i class="fa-solid fa-plus"></i>Create a server</button>
      <button class="btn btn-ghost" data-f="join"><i class="fa-solid fa-right-to-bracket"></i>Join with an invite</button></div></div>`;
  }
  function onFriendClick(e) {
    const f = e.target.closest('[data-f]')?.dataset.f;
    const row = e.target.closest('[data-uid-row]');
    const uid = row?.dataset.uidRow;
    if (f === 'add') return NX.go('home/add');
    if (f === 'create') return NX.addServerDialog();
    if (f === 'join') return NX.joinServerDialog();
    if (!uid) return;
    const p = P().get(uid);
    if (f === 'accept') return D().acceptFriend(uid);
    if (f === 'ignore' || f === 'cancel') return D().removeFriend(uid, P().nameOf(p), { ask: false });
    if (f === 'unblock') return D().toggleBlock(uid, P().nameOf(p));
    if (f === 'msg') return D().openDm(uid);
    if (f === 'call') return D().openDm(uid, { call: true });
    if (f === 'more') {
      return NX.menu(e.target.closest('[data-f]'), [
        { label: 'Start video call', icon: 'fa-video', onClick: () => D().openDm(uid, { call: true }) },
        { label: 'Profile', icon: 'fa-user', onClick: () => P().card(uid, row) },
        { sep: true },
        { label: 'Remove friend', icon: 'fa-user-minus', danger: true, onClick: () => D().removeFriend(uid, P().nameOf(p)) },
        { label: 'Block', icon: 'fa-ban', danger: true, onClick: () => D().toggleBlock(uid, P().nameOf(p)) },
      ], { alignRight: true });
    }
    if (!e.target.closest('button')) D().openDm(uid);
  }

  /* right column: active now + announcements + your servers */
  let anns = null;
  async function loadAnns() {
    const { data, error } = await window.db.from('announcements').select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(20);
    anns = error ? [] : (data || []).filter((a) => !a.expires_at || new Date(a.expires_at) > new Date());
    paintAside();
  }
  NX.on('announcements', () => loadAnns());
  const LV = { info: ['fa-circle-info', 'Info'], update: ['fa-rocket', 'Update'], warning: ['fa-triangle-exclamation', 'Heads up'], event: ['fa-calendar-days', 'Event'] };
  function paintAside() {
    const host = main?.querySelector('#homeAside');
    if (!host) return;
    if (anns === null) loadAnns();
    const live = window.Voice?.live?.() || new Map();
    const active = D().friendIds().map((id) => P().get(id)).filter((p) => p && P().isOnline(p.id)).slice(0, 8);
    const calls = D().dms.filter((c) => live.get('dm-' + c.id));
    host.innerHTML = `
      <h3>Active now</h3>
      <div class="active-now">${calls.map((c) => `<div class="active-card" data-go="dm/${esc(c.id)}?join=1">${c.is_group ? '<span class="av" style="width:36px;height:36px;background:var(--accent)"><i class="fa-solid fa-user-group"></i></span>' : P().avatar(c.people[0], 36, { presence: true })}<div class="t"><b>${esc(D().dmTitle(c))}</b><small style="color:var(--ok)"><i class="fa-solid fa-phone-volume"></i> In a call · ${live.get('dm-' + c.id)}</small></div><button class="btn btn-ok btn-sm">Join</button></div>`).join('')}
      ${active.map((p) => `<div class="active-card" data-dm="${esc(p.id)}">${P().avatar(p, 36, { presence: true })}<div class="t"><b>${P().nameText(p)}</b><small>${esc(statusSub(p))}</small></div></div>`).join('')}
      ${!active.length && !calls.length ? '<div class="empty" style="padding:16px 8px;align-items:flex-start;text-align:left"><b style="color:var(--txt-1)">It’s quiet for now…</b><p style="font-size:13px">When friends are online or in a call, they’ll show up here.</p></div>' : ''}</div>
      ${anns?.length ? `<div class="sub-h">Announcements</div>${anns.map((a) => {
        const lv = LV[a.level] || LV.info;
        return `<article class="ann lv-${esc(a.level || 'info')}"><div class="ann-ico"><i class="fa-solid ${lv[0]}"></i></div><div class="ann-main">
          <div class="ann-meta"><span class="ann-tag">${lv[1]}</span>${a.pinned ? '<span class="ann-pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}<span>${esc(fmt.ago(a.created_at))}</span></div>
          <h4>${esc(a.title)}</h4>${a.body ? `<div class="ann-body m-text">${MD.render(a.body)}</div>` : ''}</div></article>`;
      }).join('')}` : ''}
      ${D().servers.length ? `<div class="sub-h">Your servers</div><div class="srv-grid" style="grid-template-columns:1fr 1fr">${D().servers.slice(0, 8).map((s) => `<button class="srv-card" data-go="s/${esc(s.id)}"><div class="sc-banner" style="${bannerCss(s)}"></div><div class="sc-body"><div class="sc-ico">${s.icon_url ? `<img ${P().imgAttr(s.icon_url)} alt="">` : esc((s.name || '?')[0].toUpperCase())}</div><b>${esc(s.name)}</b></div></button>`).join('')}</div>` : ''}`;
    host.onclick = (e) => {
      const g = e.target.closest('[data-go]'); if (g) return NX.go(g.dataset.go);
      const d = e.target.closest('[data-dm]'); if (d) return D().openDm(d.dataset.dm);
    };
  }
  function bannerCss(s) {
    let h = 0;
    for (const ch of String(s.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const a = Math.round((h * 137.508) % 360), b = (a + 48) % 360;
    return `background:radial-gradient(120% 140% at 0% 0%, hsl(${a} 62% 42%) 0%, transparent 60%), linear-gradient(135deg, hsl(${b} 45% 24%), hsl(${a} 30% 12%))`;
  }

  /* ---------- DM conversation ---------- */
  let chat = null, conv = null, roomOpen = false;
  function adapterFor(c) {
    const other = c.people[0];
    return {
      kind: 'dm', id: c.id, table: 'dm_messages', attTable: 'dm_message_attachments', rxTable: 'dm_message_reactions', fk: 'conversation_id',
      title: D().dmTitle(c), route: 'dm/' + c.id,
      placeholder: c.is_group ? `Message ${D().dmTitle(c)}` : `Message @${other?.username || ''}`,
      intro: () => !c.is_group && !other
        ? '<div class="big-ico" style="background:var(--bg-4);color:var(--txt-3)"><i class="fa-solid fa-ghost"></i></div><h2>Deleted user</h2><p>This account no longer exists, so you can read the old messages but not reply.</p>'
        : c.is_group
        ? `<div class="big-ico" style="background:var(--accent);color:#fff"><i class="fa-solid fa-user-group"></i></div><h2>${esc(D().dmTitle(c))}</h2><p>Welcome to the beginning of the <b>${esc(D().dmTitle(c))}</b> group.</p>`
        : `<div style="margin-bottom:12px">${P().avatar(other, 80)}</div><h2>${P().nameText(other)}</h2><p style="font-size:16px;color:var(--txt-1);margin:2px 0 8px">${esc(other?.username || '')}</p><p>This is the beginning of your direct message history with <b>${esc(P().nameOf(other))}</b>.</p>
          <div class="row" style="margin-top:12px">${D().relation(other?.id) === 'friends' ? '<button class="btn btn-ghost btn-sm" data-intro="remove">Remove friend</button>' : D().relation(other?.id) === 'incoming' ? '<button class="btn btn-primary btn-sm" data-intro="accept">Accept friend request</button>' : D().relation(other?.id) === 'outgoing' ? '<button class="btn btn-ghost btn-sm" disabled>Friend request sent</button>' : '<button class="btn btn-primary btn-sm" data-intro="add">Add friend</button>'}
          <button class="btn btn-ghost btn-sm" data-intro="block">${D().isBlocked(other?.id) ? 'Unblock' : 'Block'}</button></div>`,
      canSend: () => c.is_group || (!!other && !D().isBlocked(other.id)),
      canManage: () => false, canPin: () => false,
      uploadPath: `dm/${c.id}`,
      lastReadAt: () => c.last_read_at,
      markRead: () => D().markDmRead(c.id),
      members: () => c.people,
    };
  }
  function dmMain(host, c, r) {
    conv = c;
    const other = c.people[0];
    host.innerHTML = `
      <div class="main-head">
        <button class="icon-btn h-burger" data-a="burger" aria-label="Menu"><i class="fa-solid fa-bars"></i></button>
        ${c.is_group ? '<span class="av" style="width:26px;height:26px;background:var(--accent);font-size:11px"><i class="fa-solid fa-user-group"></i></span>' : P().avatar(other, 26, { presence: true, halo: false, deco: false })}
        <span class="h-title" ${c.is_group ? '' : `data-a="profile" style="cursor:pointer"`}>${c.is_group ? esc(D().dmTitle(c)) : P().name(other, { uid: false, noGlow: true })}</span>
        <span class="h-sub">${c.is_group ? NX.fmt.plural(c.people.length + 1, 'member') : esc(other?.custom_status || '')}</span>
        <div class="h-acts">
          <button class="icon-btn" data-a="call" data-tip="Start voice call" data-tip-pos="bottom"><i class="fa-solid fa-phone"></i></button>
          <button class="icon-btn" data-a="video" data-tip="Start video call" data-tip-pos="bottom"><i class="fa-solid fa-video"></i></button>
          ${c.is_group ? '<button class="icon-btn" data-a="add" data-tip="Add friends to group" data-tip-pos="bottom"><i class="fa-solid fa-user-plus"></i></button>' : ''}
          <button class="icon-btn" data-a="info" data-tip="${c.is_group ? 'Members' : 'Profile'}" data-tip-pos="bottom"><i class="fa-solid fa-${c.is_group ? 'users' : 'circle-user'}"></i></button>
        </div>
      </div>
      <div class="live-banner"></div>
      <div class="main-body"><div class="main-col"><div class="room-slot"></div><div class="chat-slot" style="flex:1;min-height:0;display:flex;flex-direction:column"></div></div></div>`;
    host.querySelector('.main-head').onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'burger') NX.openDrawer();
      if (a === 'call' || a === 'video') startCall(a === 'video');
      if (a === 'add') addToGroup(c);
      if (a === 'profile' || (a === 'info' && !c.is_group)) P().card(other.id, e.target.closest('[data-a]'));
      if (a === 'info' && c.is_group) groupMembers(c, e.target.closest('[data-a]'));
    };
    chat?.hide();
    chat = NX.Chat.open(adapterFor(c));
    const cur = chat;
    const shown = chat.show(host.querySelector('.chat-slot'));
    host.querySelector('.chat-slot').addEventListener('click', (e) => {
      const a = e.target.closest('[data-intro]')?.dataset.intro;
      if (!a || !other) return;
      if (a === 'add') D().addFriend(other.username);
      if (a === 'accept') D().acceptFriend(other.id);
      if (a === 'remove') D().removeFriend(other.id, P().nameOf(other));
      if (a === 'block') D().toggleBlock(other.id, P().nameOf(other));
    });
    paintRoom();
    paintLive();
    const q = r?.q;
    if (q?.get('call') === '1') { NX.go('dm/' + c.id, { replace: true, silent: true }); startCall(false); }
    else if (q?.get('join') === '1') { NX.go('dm/' + c.id, { replace: true, silent: true }); NX.call.joinDm(c, { ring: false }).then(() => { roomOpen = true; paintRoom(); }); }
    else if (q?.get('room') === '1') { NX.go('dm/' + c.id, { replace: true, silent: true }); roomOpen = true; paintRoom(); }
    if (q?.get('m')) shown.then(() => { if (chat === cur) chat.jumpTo(q.get('m')); });
  }
  async function startCall(video) {
    const c = conv;
    if (!c) return;
    const live = (window.Voice?.live?.() || new Map()).get('dm-' + c.id);
    const ok = await NX.call.joinDm(c, { video, ring: !live });
    if (ok) { roomOpen = true; paintRoom(); if (!live) NX.toast('Calling…', { icon: 'fa-phone' }); }
  }
  function paintRoom() {
    const slot = main?.querySelector('.room-slot');
    if (!slot || !conv) return;
    const st = NX.call.state();
    const here = st.active && st.channel?.id === 'dm-' + conv.id;
    if (here && roomOpen) {
      if (!slot.querySelector('.call')) NX.call.mount(slot, { embedded: true, title: D().dmTitle(conv), onBack: () => { roomOpen = false; paintRoom(); } });
    } else if (slot.querySelector('.call')) { NX.call.unmount(slot); slot.innerHTML = ''; }
    if (here && !roomOpen && !slot.querySelector('.call')) {
      slot.innerHTML = `<div class="preview-bar" style="background:rgba(61,214,140,.1)"><i class="fa-solid fa-phone-volume" style="color:var(--ok)"></i><span class="grow">You’re in a call here.</span><button class="btn btn-ghost btn-sm" data-a="show">Show call</button></div>`;
      slot.querySelector('[data-a="show"]').onclick = () => { roomOpen = true; slot.innerHTML = ''; paintRoom(); };
    } else if (!here && slot.querySelector('.preview-bar')) slot.innerHTML = '';
  }
  function paintLive() {
    const el = main?.querySelector('.live-banner');
    if (!el || !conv) return;
    const n = (window.Voice?.live?.() || new Map()).get('dm-' + conv.id);
    const st = NX.call.state();
    const here = st.active && st.channel?.id === 'dm-' + conv.id;
    el.innerHTML = n && !here ? `<div class="preview-bar" style="background:rgba(61,214,140,.1)"><i class="fa-solid fa-phone-volume" style="color:var(--ok)"></i><span class="grow">${NX.fmt.plural(n, 'person is', 'people are')} in a call here.</span><button class="btn btn-ok btn-sm" data-a="join">Join call</button></div>` : '';
    el.querySelector('[data-a="join"]')?.addEventListener('click', () => NX.call.joinDm(conv, { ring: false }).then((ok) => { if (ok) { roomOpen = true; paintRoom(); paintLive(); } }));
  }
  function groupMembers(c, at) {
    const all = [NX.me, ...c.people];
    NX.menu(at, [{ header: `Members — ${all.length}` }, ...all.map((p) => ({
      html: `<button type="button" data-u="${esc(p.id)}">${P().avatar(p, 24, { presence: true, halo: false, deco: false })}<span class="grow">${P().nameText(p)}</span>${p.id === c.created_by ? '<i class="fa-solid fa-crown" style="color:var(--nitro)"></i>' : ''}</button>`,
    }))], { alignRight: true, wire: (m) => m.querySelectorAll('[data-u]').forEach((b) => { b.onclick = () => { NX.closeMenu(); P().card(b.dataset.u, at); }; }) });
  }

  /* ---------- views ---------- */
  function subscribe() {
    offs.forEach((f) => f());
    offs = [
      NX.on('dms', () => { paintSide(); watchCalls(); }),
      NX.on('friends', () => { paintSide(); if (main?.querySelector('#homeList')) { paintFriends(); paintAside(); main.querySelectorAll('.tabs [data-t="pending"]').forEach((b) => { const n = D().incoming().length; b.innerHTML = `Pending${n ? ` <span class="count">${n}</span>` : ''}`; }); } }),
      NX.on('presence', NX.debounce(() => { if (main?.querySelector('#homeList') && (tab === 'online' || tab === 'all')) paintFriends(); if (main?.querySelector('#homeAside')) paintAside(); }, 300)),
      NX.on('blocked', () => { if (tab === 'blocked') paintFriends(); }),
      NX.on('live', () => { paintLive(); if (main?.querySelector('#homeAside')) paintAside(); }),
      NX.on('call', () => { paintRoom(); paintLive(); paintSide(); }),
      NX.on('people', NX.debounce(paintSide, 100)),
    ];
  }
  function enter(sideHost, mainHost, parts, r) {
    mountSide(sideHost);
    main = mainHost;
    subscribe();
    watchCalls();
    this.update(parts, r);
  }
  function leave() {
    offs.forEach((f) => f()); offs = [];
    chat?.hide(); chat = null; conv = null;
    if (main?.querySelector('.room-slot .call')) NX.call.unmount(main.querySelector('.room-slot'));
    side = null; main = null;
  }

  NX.views.home = {
    enter, leave,
    update(parts) {
      if (chat) { chat.hide(); chat = null; }
      if (main?.querySelector('.room-slot .call')) NX.call.unmount(main.querySelector('.room-slot'));
      conv = null; roomOpen = false;
      NX.viewing = null;
      homeMain(main, parts);
      paintSide();
    },
    viewingKey: () => null,
  };
  NX.views.dms = {
    enter, leave,
    async update(parts, r) {
      const id = parts[1];
      let c = D().dm(id);
      if (!c) { await D().reloadDms(); c = D().dm(id); }
      if (!c) { NX.toast('That conversation doesn’t exist or you’re not in it.', { err: true }); NX.go('home', { replace: true }); return; }
      if (main?.querySelector('.room-slot .call')) NX.call.unmount(main.querySelector('.room-slot'));
      const st = NX.call.state();
      roomOpen = st.active && st.channel?.id === 'dm-' + c.id;
      dmMain(main, c, r);
      paintSide();
    },
    viewingKey: () => (conv ? 'dm:' + conv.id : null),
    step(d) {
      // a 1:1 whose other person deleted their account sinks to the bottom
    const list = D().visibleDms().slice().sort((a, b) => (!a.is_group && !a.people[0]) - (!b.is_group && !b.people[0]));
      const i = list.findIndex((c) => c.id === conv?.id);
      const n = list[i + d];
      if (n) NX.go('dm/' + n.id);
    },
  };
  NX.views.home.step = NX.views.dms.step;
})();
