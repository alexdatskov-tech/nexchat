/* Admin console (#/admin/<tab>): platform staff tools.

   Ranks: owner 3 > sudo admin 2 > admin 1 > user 0. Staff can only act on
   people ranked below them, and what sudo admins / admins may do at all is
   set by the owner (platform_role_perms). The database enforces every rule
   here; the page only hides buttons that would be refused. */
(function () {
  const { esc, fmt } = NX;
  const P = () => NX.people;
  const db = () => window.db;

  /* ---------- permissions ---------- */
  const PERMS = [
    { k: 'ban_users', ic: 'fa-ban', t: 'Ban & unban accounts', d: 'Lock people out, or let them back in.' },
    { k: 'manage_roles', ic: 'fa-user-shield', t: 'Manage staff roles', d: 'Give or remove roles below their own.' },
    { k: 'view_all_servers', ic: 'fa-eye', t: 'See every server', d: 'Open any server, its members and messages without joining.' },
    { k: 'post_anywhere', ic: 'fa-paper-plane', t: 'Post in any server', d: 'Send messages in servers they haven’t joined.' },
    { k: 'delete_messages', ic: 'fa-comment-slash', t: 'Delete any message', d: 'Remove messages in any server.' },
    { k: 'reset_passwords', ic: 'fa-key', t: 'Set user passwords', d: 'Replace a password and sign the person out. Never for staff at or above them.' },
    { k: 'delete_users', ic: 'fa-user-xmark', t: 'Delete accounts', d: 'Permanently remove an account and its data.' },
    { k: 'post_announcements', ic: 'fa-bullhorn', t: 'Post announcements', d: 'Post, pin and delete announcements for everyone.' },
    { k: 'manage_storage', ic: 'fa-hard-drive', t: 'Manage drive storage', d: 'Change how much space a user’s drive gets, and answer storage requests.' },
    { k: 'manage_storage_endpoints', ic: 'fa-server', t: 'Manage storage endpoints', d: 'Add storage groups and endpoints, their logins, and the category NexChat uses.' },
    { k: 'review_appeals', ic: 'fa-gavel', t: 'Review ban appeals', d: 'Accept or decline appeals from banned accounts.' },
    { k: 'view_audit', ic: 'fa-clock-rotate-left', t: 'View the audit log', d: 'See every staff action.' },
  ];
  const DEFAULT_PERMS = {
    sudo: Object.fromEntries(PERMS.map((p) => [p.k, true])),
    admin: Object.fromEntries(PERMS.map((p) => [p.k, ['ban_users', 'post_announcements', 'review_appeals', 'manage_storage'].includes(p.k)])),
  };
  let perms = JSON.parse(JSON.stringify(DEFAULT_PERMS)), permsLive = false;
  async function loadPerms() {
    const { data, error } = await db().from('platform_role_perms').select('role,perm,allowed');
    permsLive = !error;
    perms = JSON.parse(JSON.stringify(DEFAULT_PERMS));
    (data || []).forEach((r) => { if (perms[r.role]) perms[r.role][r.perm] = r.allowed; });
  }
  const R = (u) => P().rank(u);
  const myRank = () => R(NX.me);
  const roleKey = (r) => ['', 'admin', 'sudo'][r];
  const can = (k) => myRank() >= 3 || (myRank() > 0 && !!perms[roleKey(myRank())]?.[k]);
  const canAuth = () => can('view_all_servers') || can('reset_passwords') || can('delete_users');
  const canAct = (u) => u.id !== NX.me.id && myRank() > R(u);
  const ROLE_KEYS = ['user', 'admin', 'sudo'];
  const ROLE_TXT = ['User', 'Admin', 'Sudo Admin'];
  const ROLE_LABEL = { admin: 'Admin', sudo: 'Sudo Admin' };
  const DRIVE_DEFAULT_GB = 5;
  const quotaOf = (u) => Number(u?.drive_quota_gb) || DRIVE_DEFAULT_GB;

  // The RPCs raise plain-language exceptions; show them without the prefix.
  function adminErr(error, fallback) {
    const m = error?.message || '';
    if (error?.code === 'PGRST202' || /could not find the function|schema cache/i.test(m)) return 'Run supabase/roles_and_powers.sql in the Supabase SQL editor first.';
    return m.replace(/^.*?exception:\s*/i, '') || fallback || 'That didn’t work.';
  }
  const missingTable = (e) => e && (e.code === 'PGRST205' || e.code === '42P01' || /schema cache|does not exist/i.test(e.message || ''));
  const emptyBox = (icon, title, text) => `<div class="empty"><div class="ico"><i class="fa-solid ${icon}"></i></div><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}</div>`;
  const skel = (n = 3, h = 56) => `<div class="stack">${`<div class="skel" style="height:${h}px;border-radius:12px"></div>`.repeat(n)}</div>`;
  const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase();
  const statusBadge = (s, good) => `<span class="badge ${s === good ? 'badge-ok' : s === 'pending' ? 'badge-muted' : 'badge-banned'}">${esc(s)}</span>`;

  /* ---------- state ---------- */
  let host = null, pg = null, tab = 'overview', body = null, alive = false;
  let users = [];
  const counts = { nitro: 0, storage: 0, appeals: 0, roles: 0 };
  let rrLive = false, myReq = null, reviewQueue = [];

  async function loadUsers(force) {
    if (users.length && !force) return users;
    const { data, error } = await db().from('profiles').select('*').order('created_at', { ascending: false }).limit(1000);
    if (error) { NX.fail(error); return users; }
    users = data || [];
    users.forEach((u) => P().put(u));
    return users;
  }
  const userById = () => Object.fromEntries(users.map((u) => [u.id, u]));
  async function askReason(title) {
    return NX.prompt({ title, label: 'Reason (optional)', allowEmpty: true, multiline: true, max: 500, ok: 'Continue' });
  }

  /* ---------- shell ---------- */
  const TABS = () => [
    { title: 'Platform', items: [
      { id: 'overview', label: 'Overview', icon: 'fa-chart-simple' },
      { id: 'users', label: 'Users', icon: 'fa-users' },
      { id: 'servers', label: 'Servers', icon: 'fa-server', hidden: !can('view_all_servers') },
      { id: 'announce', label: 'Announcements', icon: 'fa-bullhorn', hidden: !can('post_announcements') },
    ] },
    { title: 'Staff', items: [
      { id: 'roles', label: 'Admin roles', icon: 'fa-user-shield' },
      { id: 'audit', label: 'Audit log', icon: 'fa-clock-rotate-left', hidden: !can('view_audit') },
      { id: 'owner', label: 'Owner', icon: 'fa-crown', hidden: myRank() < 3 },
    ] },
    { title: 'Queues', items: [
      { id: 'nitro', label: 'Nitro requests', icon: 'fa-bolt' },
      { id: 'storage', label: 'Storage requests', icon: 'fa-hard-drive', hidden: !can('manage_storage') },
      { id: 'endpoints', label: 'Storage endpoints', icon: 'fa-database', hidden: !can('manage_storage_endpoints') },
      { id: 'appeals', label: 'Ban appeals', icon: 'fa-gavel', hidden: !can('review_appeals') },
    ] },
  ];
  const visibleTabs = () => TABS().flatMap((s) => s.items).filter((i) => !i.hidden).map((i) => i.id);

  function setCount(id, n) {
    counts[id] = n;
    const b = host?.querySelector(`.pg-nav [data-id="${id}"]`);
    if (!b) return;
    b.querySelector('.count')?.remove();
    if (n) b.insertAdjacentHTML('beforeend', `<span class="count">${n > 99 ? '99+' : n}</span>`);
  }

  // A compact title row (no banner): the tab's name, one line on what it's
  // for, and its actions on the right.
  function head(title, sub, extra = '') {
    return `<header class="adm-top"><div class="adm-top-t"><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${extra ? `<div class="adm-top-acts">${extra}</div>` : ''}</header>`;
  }

  async function enter(h, parts) {
    host = h; alive = true;
    host.classList.add('adm-page');
    if (myRank() < 1) {
      host.style.display = 'flex'; host.style.alignItems = 'center'; host.style.justifyContent = 'center';
      host.innerHTML = `<div style="max-width:420px">${emptyBox('fa-shield-halved', 'Admins only', 'This area is for NexChat platform staff.')}<div style="display:flex;justify-content:center"><button class="btn btn-primary" data-home>Back to NexChat</button></div></div>`;
      host.querySelector('[data-home]').onclick = () => NX.closePage();
      return;
    }
    host.innerHTML = `<div style="grid-column:1/-1;display:flex;align-items:center;justify-content:center"><span class="spinner"></span></div>`;
    await loadPerms();
    if (!alive) return;
    tab = parts[1] && visibleTabs().includes(parts[1]) ? parts[1] : 'overview';
    const rk = myRank();
    pg = NX.pageShell(host, {
      sections: TABS(), active: tab, wide: true, kind: 'admin',
      brand: `<div class="pb-logo"><span class="lg"><i class="fa-solid fa-shield-halved"></i></span><div class="grow" style="min-width:0"><b>Admin console</b><small style="display:flex;gap:6px;align-items:center;margin-top:3px">${P().roleBadge(NX.me)}<span class="ellipsis">${esc(P().nameOf(NX.me))}</span></small></div></div>
`,
      onSelect: (id) => NX.go('admin/' + id),
    });
    body = pg.body;
    body.addEventListener('click', onBodyClick);
    body.addEventListener('click', seClick);
    show(tab);
    refreshCounts();
  }

  function update(parts) {
    if (!pg) return;
    const t = parts[1] && visibleTabs().includes(parts[1]) ? parts[1] : 'overview';
    if (t === tab && body.childElementCount) return;
    show(t);
  }
  function leave() {
    alive = false;
    document.querySelector('.adm-user')?.remove();
    host = null; pg = null; body = null; users = [];
  }

  function show(t) {
    tab = t;
    pg.setActive(t);
    body.innerHTML = '';
    body.dataset.tab = t;
    ({ overview, users: usersTab, servers: serversTab, announce: announceTab, roles: rolesTab, audit: auditTab, owner: ownerTab,
      nitro: nitroTab, storage: storageTab, endpoints: endpointsTab, appeals: appealsTab }[t] || overview)();
  }
  const still = (t) => alive && tab === t;

  async function refreshCounts() {
    const pend = async (table) => {
      const { count, error } = await db().from(table).select('id', { count: 'exact', head: true }).eq('status', 'pending');
      return error ? 0 : count || 0;
    };
    const [n, s, a] = await Promise.all([pend('nitro_requests'), can('manage_storage') ? pend('storage_requests') : 0, can('review_appeals') ? pend('ban_appeals') : 0]);
    if (!alive) return;
    setCount('nitro', n); setCount('storage', s); setCount('appeals', a);
    await loadRankRequests();
    if (alive) setCount('roles', reviewQueue.length);
  }

  function onBodyClick(e) {
    const go = e.target.closest('[data-goto]');
    if (go) { NX.go('admin/' + go.dataset.goto); return; }
    const u = e.target.closest('[data-open-user]');
    if (u && !e.target.closest('button:not([data-open-user]), select, a')) {
      const user = users.find((x) => x.id === u.dataset.openUser);
      if (user) openUser(user);
    }
  }

  /* ============ Overview ============ */
  async function headCount(table, filter) {
    let q = db().from(table).select('id', { count: 'exact', head: true });
    if (filter) q = filter(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  }
  async function overview() {
    body.innerHTML = head('Overview', 'Everything happening on NexChat right now.') + `<div class="kpis" id="admKpis">${'<div class="skel kpi-skel"></div>'.repeat(6)}</div>
      <div class="card adm-chart"><div class="adm-row-h"><h3>Sign-ups</h3><span class="adm-chip-muted">Last 14 days</span><span class="grow"></span><b class="adm-total" id="ovTotal"></b></div><div class="adm-bars" id="ovBars"></div></div>
      <div class="adm-two"><div class="card"><h3>Needs attention</h3><div id="ovQueue">${skel(2, 48)}</div></div>
        <div class="card"><div class="adm-row-h"><h3>Newest members</h3><span class="grow"></span><button class="btn btn-quiet btn-sm" data-goto="users">All users <i class="fa-solid fa-arrow-right"></i></button></div><div id="ovRecent">${skel(3, 40)}</div></div></div>`;
    await loadUsers(true);
    if (!still('overview')) return;
    const day = 86400000, now = Date.now();
    const week = users.filter((u) => now - new Date(u.created_at) < 7 * day).length;
    const online = users.filter((u) => P().isOnline(u.id)).length;
    const [servers, pendNitro, pendAppeals, anns, pendStorage] = await Promise.all([
      headCount('servers'),
      headCount('nitro_requests', (q) => q.eq('status', 'pending')),
      headCount('ban_appeals', (q) => q.eq('status', 'pending')),
      headCount('announcements'),
      headCount('storage_requests', (q) => q.eq('status', 'pending')),
    ]);
    if (!still('overview')) return;
    const kpis = [
      { t: '#3b9ef5', k: 'Members', v: users.length, ic: 'fa-users', sub: `+${week} this week`, go: 'users' },
      { t: '#2fbf87', k: 'Online now', v: online, ic: 'fa-signal', sub: 'live presence' },
      { t: '#7c6cff', k: 'Servers', v: servers, ic: 'fa-server', sub: 'across the platform', go: can('view_all_servers') ? 'servers' : null },
      { t: '#f0b232', k: 'Nitro', v: users.filter((u) => u.is_nitro).length, ic: 'fa-bolt', sub: `${pendNitro ?? 0} pending`, go: 'nitro' },
      { t: '#f2555a', k: 'Banned', v: users.filter((u) => u.is_banned).length, ic: 'fa-ban', sub: `${pendAppeals ?? 0} appeals open`, go: can('review_appeals') ? 'appeals' : null },
      { t: '#a78bfa', k: 'Staff', v: users.filter((u) => R(u) > 0).length, ic: 'fa-shield-halved', sub: anns == null ? 'announcements not set up' : `${anns} announcements`, go: 'roles' },
    ];
    body.querySelector('#admKpis').innerHTML = kpis.map((x) => `<${x.go ? 'button' : 'div'} class="kpi" style="--t:${x.t}"${x.go ? ` data-goto="${x.go}"` : ''}>
      <span class="kpi-k"><i></i>${esc(x.k)}</span><b class="kpi-v">${x.v == null ? '—' : Number(x.v).toLocaleString()}</b><small class="kpi-s${/^\+[1-9]/.test(x.sub) ? ' up' : ''}">${esc(x.sub)}</small></${x.go ? 'button' : 'div'}>`).join('');
    const queue = [];
    const qi = (go, ic, t, s) => `<button class="adm-q" data-goto="${go}"><span class="adm-qi"><i class="fa-solid ${ic}"></i></span><span class="grow"><b>${t}</b><small>${s}</small></span><i class="fa-solid fa-chevron-right muted"></i></button>`;
    if (pendNitro) queue.push(qi('nitro', 'fa-bolt', `${fmt.plural(pendNitro, 'Nitro request')}`, 'Waiting for a decision'));
    if (pendStorage && can('manage_storage')) queue.push(qi('storage', 'fa-hard-drive', fmt.plural(pendStorage, 'storage request'), 'More room in My Drive'));
    if (pendAppeals && can('review_appeals')) queue.push(qi('appeals', 'fa-gavel', fmt.plural(pendAppeals, 'ban appeal'), 'Someone wants back in'));
    if (reviewQueue.length) queue.push(qi('roles', 'fa-arrow-up', fmt.plural(reviewQueue.length, 'rank-up request'), 'Staff asking for a higher role'));
    if (anns == null && can('post_announcements')) queue.push(qi('announce', 'fa-database', 'Announcements not set up', 'Run supabase/announcements.sql'));
    body.querySelector('#ovQueue').innerHTML = queue.join('') || '<div class="adm-clear"><i class="fa-solid fa-circle-check"></i> All clear. Nothing waiting on you.</div>';
    body.querySelector('#ovRecent').innerHTML = users.slice(0, 6).map((u) => `<div class="adm-mini" data-open-user="${esc(u.id)}">${P().avatar(u, 30, { presence: true })}
      <div class="grow"><b>${P().nameText(u)}</b><small>@${esc(u.username)}</small></div><span class="muted adm-t">${esc(fmt.ago(u.created_at))}</span></div>`).join('') || '<p class="muted">No members yet.</p>';
    const days = [...Array(14)].map((_, i) => { const d = new Date(now - (13 - i) * day); d.setHours(0, 0, 0, 0); return { d, n: 0 }; });
    users.forEach((u) => {
      const t = new Date(u.created_at); t.setHours(0, 0, 0, 0);
      const hit = days.find((x) => x.d.getTime() === t.getTime());
      if (hit) hit.n++;
    });
    const max = Math.max(1, ...days.map((x) => x.n));
    body.querySelector('#ovTotal').textContent = fmt.plural(days.reduce((a, x) => a + x.n, 0), 'new member');
    body.querySelector('#ovBars').innerHTML = days.map((x, i) => {
      const label = x.d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `<div class="adm-bar-col" data-tip="${esc(label)}: ${fmt.plural(x.n, 'sign-up')}"><div class="adm-bar" style="height:${Math.max(2, (x.n / max) * 100)}%">${x.n === max && x.n ? `<span>${x.n}</span>` : ''}</div><span class="adm-bar-x">${i % 2 === 1 || i === 13 ? esc(label) : ''}</span></div>`;
    }).join('');
  }

  /* ============ Users ============ */
  let uFilter = 'all', uQuery = '';
  const FILTERS = { all: () => true, admin: (u) => R(u) > 0, nitro: (u) => u.is_nitro, banned: (u) => u.is_banned };
  async function usersTab() {
    body.innerHTML = head('Users', 'Everyone with an account.') + `<div id="admPowers"></div>
      <div class="adm-tools"><label class="f-search adm-search"><i class="fa-solid fa-magnifying-glass"></i><input id="uSearch" placeholder="Search by name or username" value="${esc(uQuery)}" autocomplete="off" spellcheck="false"></label>
        <div class="seg-tabs" id="uFilter">${[['all', 'All'], ['admin', 'Staff'], ['nitro', 'Nitro'], ['banned', 'Banned']].map(([k, l]) => `<button type="button" data-f="${k}" class="${uFilter === k ? 'on' : ''}">${l}<span class="seg-c"></span></button>`).join('')}</div></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>User</th><th class="adm-hide-m">Joined</th><th class="adm-hide-m">Drive</th><th style="text-align:right">Actions</th></tr></thead><tbody id="userRows"><tr><td colspan="4">${skel(4, 36)}</td></tr></tbody></table></div>`;
    body.querySelector('#uSearch').oninput = (e) => { uQuery = e.target.value; paintUsers(); };
    body.querySelector('#uFilter').onclick = (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      uFilter = b.dataset.f;
      body.querySelectorAll('#uFilter button').forEach((x) => x.classList.toggle('on', x === b));
      paintUsers();
    };
    await Promise.all([loadUsers(), loadRankRequests()]);
    if (still('users')) paintUsers();
  }
  function paintPowers() {
    const el = body.querySelector('#admPowers');
    if (!el) return;
    const r = myRank();
    const who = r >= 3 ? 'everyone else' : r === 2 ? 'admins and regular users' : 'regular users';
    const list = PERMS.filter((p) => can(p.k)).map((p) => `<span class="chip"><i class="fa-solid ${p.ic}"></i>${esc(p.t)}</span>`).join('');
    const n = PERMS.filter((p) => can(p.k)).length;
    el.innerHTML = `<details class="adm-powers"><summary>${P().roleBadge(NX.me)}<span class="grow">You can act on ${who}<small> · ${fmt.plural(n, 'permission')}</small></span>${rankUpButton()}<i class="fa-solid fa-chevron-down adm-chev"></i></summary>
      <div class="adm-powers-list">${list || '<span class="muted">No moderation permissions yet.</span>'}${r < 3 ? '<p class="muted">Anyone at or above your rank is locked.</p>' : ''}</div></details>`;
    el.querySelector('[data-rr-ask]')?.addEventListener('click', (e) => { e.preventDefault(); requestRankUp(); });
  }
  function paintUsers() {
    const tb = body?.querySelector('#userRows');
    if (!tb) return;
    paintPowers();
    body.querySelectorAll('#uFilter button').forEach((b) => { b.querySelector('span').textContent = users.filter(FILTERS[b.dataset.f]).length; });
    const q = uQuery.trim().toLowerCase();
    const rows = users.filter(FILTERS[uFilter])
      .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q))
      .sort((a, b) => R(b) - R(a));
    tb.innerHTML = rows.slice(0, 400).map((u) => `<tr class="adm-urow" data-open-user="${esc(u.id)}">
      <td><div class="who">${P().avatar(u, 32, { presence: true })}<div style="min-width:0"><b>${P().nameText(u)}</b> ${u.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i></span>' : ''}${P().roleBadge(u)}${u.is_banned ? ' <span class="badge badge-banned">Banned</span>' : ''}<small>@${esc(u.username)}</small></div></div></td>
      <td class="adm-hide-m muted">${new Date(u.created_at).toLocaleDateString()}</td>
      <td class="adm-hide-m muted">${quotaOf(u)} GB</td>
      <td style="text-align:right;white-space:nowrap">${u.id === NX.me.id ? '<span class="badge badge-owner">You</span>'
        : `${canAct(u) && can('ban_users') ? `<button class="btn btn-sm ${u.is_banned ? 'btn-ghost' : 'btn-danger-ghost'}" data-ban="${esc(u.id)}">${u.is_banned ? 'Unban' : 'Ban'}</button>` : (canAct(u) ? '' : '<span class="muted" title="Ranked the same as or above you"><i class="fa-solid fa-lock"></i></span>')}
          <button class="btn btn-ghost btn-sm" data-open-user="${esc(u.id)}">${canAct(u) ? 'Manage' : 'View'}</button>`}</td></tr>`).join('')
      || '<tr><td colspan="4"><div class="empty" style="padding:20px"><p>No one matches that.</p></div></td></tr>';
    tb.querySelectorAll('[data-ban]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); toggleBan(users.find((x) => x.id === b.dataset.ban)); }; });
  }

  async function toggleBan(u, after) {
    let reason = null;
    if (!u.is_banned) {
      if (!await NX.confirm({ title: 'Ban account', body: `@${u.username} will be locked out of NexChat entirely.`, danger: true, ok: 'Ban account' })) return;
      reason = await askReason(`Why is @${u.username} being banned?`);
      if (reason === null) return;
      reason = reason || null;
    }
    const { error } = await db().rpc('set_user_ban', { p_user_id: u.id, p_banned: !u.is_banned, p_reason: reason });
    if (error) return NX.toast(adminErr(error), { err: true });
    u.is_banned = !u.is_banned; u.ban_reason = reason;
    NX.toast(u.is_banned ? 'Account banned.' : 'Account restored.');
    if (tab === 'users') paintUsers();
    after?.();
  }

  async function changeRole(u, role) {
    const label = ROLE_TXT[ROLE_KEYS.indexOf(role)];
    const what = label === 'User' ? 'a regular user' : (label === 'Admin' ? 'an Admin' : 'a ' + label);
    if (!await NX.confirm({ title: 'Change role', body: `Make @${u.username} ${what}?`, ok: 'Change role' })) return false;
    const { error } = await db().rpc('set_user_role', { p_user_id: u.id, p_role: role });
    if (error) { NX.toast(adminErr(error), { err: true }); return false; }
    u.platform_role = role === 'user' ? null : role;
    u.is_platform_admin = role !== 'user';
    NX.toast(`@${u.username} is now ${what}.`);
    if (tab === 'users') paintUsers();
    if (tab === 'roles') rolesTab();
    return true;
  }

  /* user drawer (a wide modal) */
  function openUser(u) {
    document.querySelector('.adm-user')?.remove();
    const canRole = canAct(u) && can('manage_roles');
    const roleOpts = ROLE_KEYS.map((k, r) => (r < myRank() ? `<option value="${k}" ${R(u) === r ? 'selected' : ''}>${ROLE_TXT[r]}</option>` : '')).join('');
    const accent = /^#[0-9a-f]{6}$/i.test(u.accent_color || '') ? u.accent_color : '#7c6cff';
    const act = (title, sub, ctl, cls = '') => `<div class="set-row ${cls}"><div class="info"><b>${title}</b><small>${sub}</small></div>${ctl}</div>`;
    const bodyEl = NX.h(`<div class="adm-ubody">
      <div class="adm-ubanner" style="background:linear-gradient(120deg, ${accent}, color-mix(in srgb, ${accent} 25%, #0e0f13))"${u.banner_url ? ` data-bn="${esc(u.banner_url)}"` : ''}></div>
      <div class="adm-uhead">${P().avatar(u, 72, { presence: true })}<div class="grow"><h3>${P().nameText(u)}</h3><small class="muted">@${esc(u.username)}</small>
        <div class="row" style="margin-top:6px;flex-wrap:wrap">${P().roleBadge(u)}${u.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i>Nitro</span>' : ''}${u.is_banned ? '<span class="badge badge-banned">Banned</span>' : ''}</div></div></div>
      <div class="adm-facts">
        <div><span>Username</span><b class="mono">${esc(u.username)}</b></div>
        <div><span>Joined</span><b>${new Date(u.created_at).toLocaleDateString([], { dateStyle: 'medium' })}</b></div>
        <div><span>Drive storage</span><b data-quota>${quotaOf(u)} GB</b></div>
        <div><span>Last sign-in</span><b data-last>${canAuth() ? '…' : '—'}</b></div>
        <div><span>Active sessions</span><b data-sess>${canAuth() ? '…' : '—'}</b></div>
        <div class="wide"><span>User ID</span><b class="mono adm-sel">${esc(u.id)}</b></div>
        ${u.is_banned && u.ban_reason ? `<div class="wide"><span>Ban reason</span><b>${esc(u.ban_reason)}</b></div>` : ''}
      </div>
      ${can('view_all_servers') ? `<h2 class="sec-title">Servers <span data-srvn></span></h2><div data-srv>${skel(1, 52)}</div>` : ''}
      ${u.id === NX.me.id ? (rrLive && nextRole() ? `<h2 class="sec-title">Your rank</h2><div class="card">${act(esc(P().ROLE_NAMES[myRank()] || 'User'), `You can’t raise your own rank, but you can ask for ${ROLE_LABEL[nextRole()]}.`, rankUpButton())}</div>` : '')
        : `<h2 class="sec-title">Manage</h2><div class="card">${!canAct(u)
          ? act('<i class="fa-solid fa-lock"></i> View only', `@${esc(u.username)} is ranked the same as or above you, so you can’t ban, reset, delete or change their role.`, '')
          : [
            act('Role', canRole ? 'You can give roles below your own.' : 'Only staff allowed to manage roles can change this.',
              canRole ? `<select class="input" data-role style="width:auto">${roleOpts}</select>` : `<span class="muted">${esc(P().ROLE_NAMES[R(u)] || 'User')}</span>`),
            can('manage_storage') ? act('Drive storage', 'How much space their My Drive gets. Applies straight away.',
              `<div class="row"><input class="input mono" data-gb type="number" min="1" max="2048" step="1" value="${quotaOf(u)}" style="width:90px"><span class="muted">GB</span><button class="btn btn-ghost btn-sm" data-gbsave>Save</button></div>`) : '',
            can('ban_users') ? act(u.is_banned ? 'Lift ban' : 'Ban account', u.is_banned ? 'Let them back in.' : 'Locks them out everywhere, instantly.',
              `<button class="btn btn-sm ${u.is_banned ? 'btn-ghost' : 'btn-danger'}" data-uban>${u.is_banned ? 'Unban' : 'Ban'}</button>`) : '',
            can('reset_passwords') ? act('Set a new password', 'Their current password can’t be viewed (only a one-way hash is stored). This replaces it and signs them out everywhere.',
              '<button class="btn btn-ghost btn-sm" data-pw><i class="fa-solid fa-key"></i>Set password</button>') : '',
            can('delete_users') ? act('Delete account', 'Removes the account, their messages, servers they own and their private drive. Can’t be undone.',
              '<button class="btn btn-danger btn-sm" data-del><i class="fa-solid fa-trash"></i>Delete</button>', 'adm-danger') : '',
          ].join('')}</div>`}
    </div>`);
    const m = NX.modal({ cls: 'adm-user', wide: true, body: bodyEl });
    m.modal.insertAdjacentHTML('afterbegin', '<button class="icon-btn adm-ux" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button>');
    const bn = bodyEl.querySelector('[data-bn]');
    if (bn) NX.files.resolved(bn.dataset.bn).then((url) => { bn.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`; bn.style.backgroundSize = 'cover'; }).catch(() => {});
    if (canAuth()) {
      db().rpc('admin_user_auth', { p_user_id: u.id }).then(({ data, error }) => {
        const row = Array.isArray(data) ? data[0] : data;
        const l = bodyEl.querySelector('[data-last]'), s = bodyEl.querySelector('[data-sess]');
        if (l) l.textContent = error ? '—' : (row?.last_sign_in_at ? fmt.stamp(row.last_sign_in_at) : 'Never');
        if (s) s.textContent = error ? '—' : String(row?.sessions ?? 0);
      });
    }
    if (can('view_all_servers')) {
      userServers(u).then((list) => {
        const h = bodyEl.querySelector('[data-srv]');
        if (!h) return;
        bodyEl.querySelector('[data-srvn]').textContent = list ? `(${list.length})` : '';
        if (!list) { h.innerHTML = '<p class="muted">Couldn’t load servers.</p>'; return; }
        h.innerHTML = list.map((s) => `<button class="adm-srvrow" data-go-srv="${esc(s.id)}"><span class="adm-srvico">${s.icon_url ? `<img ${P().imgAttr(s.icon_url)} alt="">` : esc(initials(s.name))}</span>
          <span class="grow"><b>${esc(s.name)}</b><small>${s.owner_id === u.id ? '<i class="fa-solid fa-crown" style="color:var(--nitro)"></i> Owner' : 'Member'} · ${fmt.plural(s.members, 'member')}</small></span><i class="fa-solid fa-arrow-up-right-from-square muted"></i></button>`).join('')
          || '<p class="muted">Not in any servers.</p>';
        h.querySelectorAll('[data-go-srv]').forEach((b) => { b.onclick = () => { m.close(); NX.go('s/' + b.dataset.goSrv); }; });
      });
    }
    bodyEl.querySelector('[data-role]')?.addEventListener('change', async (e) => {
      const ok = await changeRole(u, e.target.value);
      if (!ok) e.target.value = ROLE_KEYS[R(u)]; else { m.close(); openUser(u); }
    });
    bodyEl.querySelector('[data-uban]')?.addEventListener('click', () => toggleBan(u, () => { m.close(); openUser(u); }));
    bodyEl.querySelector('[data-gbsave]')?.addEventListener('click', async (e) => {
      const gb = Math.floor(Number(bodyEl.querySelector('[data-gb]').value));
      if (!(gb >= 1 && gb <= 2048)) return NX.toast('Storage must be between 1 and 2048 GB.', { err: true });
      e.currentTarget.classList.add('busy');
      const { error } = await db().rpc('admin_set_drive_quota', { p_user_id: u.id, p_gb: gb });
      e.target.closest('button')?.classList.remove('busy');
      if (error) return NX.toast(adminErr(error), { err: true });
      u.drive_quota_gb = gb;
      bodyEl.querySelector('[data-quota]').textContent = gb + ' GB';
      NX.toast(`@${u.username} now has ${gb} GB of drive storage.`);
      if (tab === 'users') paintUsers();
    });
    bodyEl.querySelector('[data-pw]')?.addEventListener('click', () => setPassword(u));
    bodyEl.querySelector('[data-del]')?.addEventListener('click', () => deleteUser(u, () => m.close()));
    bodyEl.querySelector('[data-rr-ask]')?.addEventListener('click', () => { m.close(); requestRankUp(); });
  }

  async function userServers(u) {
    const { data: mem, error } = await db().from('server_members').select('server_id').eq('user_id', u.id);
    if (error) return null;
    const ids = (mem || []).map((x) => x.server_id);
    if (!ids.length) return [];
    const { data: list, error: e2 } = await db().from('servers').select('id,name,icon_url,owner_id,server_members(count)').in('id', ids);
    if (e2) return null;
    return (list || []).map((s) => ({ ...s, members: s.server_members?.[0]?.count ?? 0 }))
      .sort((a, b) => (b.owner_id === u.id) - (a.owner_id === u.id) || a.name.localeCompare(b.name));
  }

  function setPassword(u) {
    const gen = () => {
      const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      return [...crypto.getRandomValues(new Uint32Array(14))].map((x) => a[x % a.length]).join('');
    };
    const b = NX.h(`<div class="stack"><p class="muted" style="font-size:13.5px">They’ll be signed out on every device and need this password to get back in.</p>
      <div class="row"><input class="input mono" data-npw autocomplete="off" spellcheck="false" value="${gen()}">
      <button class="icon-btn" data-gen title="Generate"><i class="fa-solid fa-dice"></i></button><button class="icon-btn" data-cp title="Copy"><i class="fa-regular fa-copy"></i></button></div><p class="err"></p></div>`);
    const inp = b.querySelector('[data-npw]');
    b.querySelector('[data-gen]').onclick = () => { inp.value = gen(); };
    b.querySelector('[data-cp]').onclick = () => NX.copy(inp.value, 'Password copied');
    NX.modal({
      title: `New password for @${u.username}`, body: b,
      foot: [{ label: 'Cancel' }, {
        label: 'Set password', cls: 'btn-primary', icon: 'fa-key', onClick: async () => {
          if (inp.value.length < 8) { b.querySelector('.err').textContent = 'At least 8 characters.'; return false; }
          const { error } = await db().rpc('admin_set_password', { p_user_id: u.id, p_password: inp.value });
          if (error) { b.querySelector('.err').textContent = adminErr(error); return false; }
          navigator.clipboard?.writeText(inp.value).catch(() => {});
          NX.toast(`Password changed and copied. @${u.username} was signed out everywhere.`);
        },
      }],
    });
  }

  function deleteUser(u, closeDrawer) {
    const b = NX.h(`<div class="stack"><p class="muted" style="font-size:13.5px">This permanently removes the account, everything they posted, the servers they own and their private drive. Type <b class="mono">${esc(u.username)}</b> to confirm.</p>
      <input class="input" data-c autocomplete="off" placeholder="${esc(u.username)}"><p class="err"></p></div>`);
    const m = NX.modal({
      title: `Delete @${u.username}?`, body: b,
      foot: [{ label: 'Cancel' }, {
        label: 'Delete forever', cls: 'btn-danger', icon: 'fa-trash', primary: true, onClick: async () => {
          if (b.querySelector('[data-c]').value !== u.username) { b.querySelector('.err').textContent = 'Type the username exactly to confirm.'; return false; }
          const { error } = await db().rpc('admin_delete_user', { p_user_id: u.id });
          if (error) { b.querySelector('.err').textContent = adminErr(error); return false; }
          // Their drive was encrypted with a key that is gone now; clear it out.
          if (window.CloudGate?.enabled()) window.CloudGate.deleteFolder('vault', u.id).catch(() => {});
          closeDrawer?.();
          users = users.filter((x) => x.id !== u.id);
          if (tab === 'users') paintUsers();
          NX.toast(`@${u.username} was deleted.`);
        },
      }],
    });
    m.primary.disabled = true;
    b.querySelector('[data-c]').oninput = (e) => { m.primary.disabled = e.target.value !== u.username; };
  }

  /* ============ Servers ============ */
  let servers = null, sSort = 'new', sQuery = '';
  async function serversTab() {
    body.innerHTML = head('Servers', 'Every server on NexChat. Open any of them to read and post without joining.') + `
      <div class="adm-tools"><label class="f-search adm-search"><i class="fa-solid fa-magnifying-glass"></i><input id="sSearch" placeholder="Search servers or owners" value="${esc(sQuery)}" autocomplete="off" spellcheck="false"></label>
        <div class="seg-tabs" id="sSort">${[['new', 'Newest'], ['members', 'Most members'], ['name', 'A–Z']].map(([k, l]) => `<button type="button" data-s="${k}" class="${sSort === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="adm-srvgrid" id="srvRows">${'<div class="skel" style="height:170px;border-radius:14px"></div>'.repeat(6)}</div>`;
    body.querySelector('#sSearch').oninput = (e) => { sQuery = e.target.value; paintServers(); };
    body.querySelector('#sSort').onclick = (e) => {
      const b = e.target.closest('[data-s]'); if (!b) return;
      sSort = b.dataset.s;
      body.querySelectorAll('#sSort button').forEach((x) => x.classList.toggle('on', x === b));
      paintServers();
    };
    await loadUsers();
    const [{ data, error }, { data: mine }] = await Promise.all([
      db().from('servers').select('id,name,description,icon_url,banner_url,owner_id,created_at,server_members(count)').order('created_at', { ascending: false }).limit(2000),
      db().from('server_members').select('server_id').eq('user_id', NX.me.id),
    ]);
    if (!still('servers')) return;
    if (error) { body.querySelector('#srvRows').innerHTML = emptyBox('fa-triangle-exclamation', 'Couldn’t load servers', esc(adminErr(error))); return; }
    const joined = new Set((mine || []).map((x) => x.server_id));
    servers = (data || []).map((s) => ({ ...s, members: s.server_members?.[0]?.count ?? 0, joined: joined.has(s.id) }));
    paintServers();
  }
  function paintServers() {
    const host2 = body?.querySelector('#srvRows');
    if (!host2 || !servers) return;
    const byId = userById();
    const q = sQuery.trim().toLowerCase();
    const list = servers.filter((s) => {
      const o = byId[s.owner_id];
      return !q || s.name.toLowerCase().includes(q) || (o && (o.username.toLowerCase().includes(q) || (o.display_name || '').toLowerCase().includes(q)));
    }).sort((a, b) => (sSort === 'members' ? b.members - a.members : sSort === 'name' ? a.name.localeCompare(b.name) : new Date(b.created_at) - new Date(a.created_at)));
    host2.innerHTML = list.map((s, i) => {
      const o = byId[s.owner_id];
      const hue = (i * 137.5) % 360;
      return `<article class="adm-srv">
        <div class="adm-srvban" style="background:linear-gradient(135deg, hsl(${hue} 50% 30%), hsl(${(hue + 50) % 360} 40% 14%))"${s.banner_url ? ` data-bn="${esc(s.banner_url)}"` : ''}></div>
        <div class="adm-srvico big">${s.icon_url ? `<img ${P().imgAttr(s.icon_url)} alt="">` : esc(initials(s.name))}</div>
        <div class="adm-srvbody"><b>${esc(s.name)}</b><small class="muted adm-clamp">${esc(s.description || 'No description.')}</small>
          <div class="adm-meta"><span>${o ? `${P().avatar(o, 18, { halo: false, deco: false })} @${esc(o.username)}` : '<i class="fa-solid fa-user-slash"></i> unknown'}</span><span><i class="fa-solid fa-users"></i> ${s.members}</span><span><i class="fa-regular fa-calendar"></i> ${new Date(s.created_at).toLocaleDateString()}</span></div>
          <div class="adm-srvacts"><span class="badge ${s.joined ? 'badge-ok' : 'badge-muted'}">${s.joined ? 'Member' : 'Not joined'}</span><span class="grow"></span>
            <button class="btn btn-quiet btn-sm" data-smem="${esc(s.id)}"><i class="fa-solid fa-users"></i>Members</button>
            <button class="btn btn-primary btn-sm" data-sopen="${esc(s.id)}"><i class="fa-solid fa-eye"></i>Open</button></div></div></article>`;
    }).join('') || emptyBox('fa-server', 'No servers match that.', '');
    host2.querySelectorAll('[data-bn]').forEach((el) => NX.files.resolved(el.dataset.bn).then((u) => { el.style.background = `center/cover url("${u.replace(/"/g, '%22')}")`; }).catch(() => {}));
    host2.querySelectorAll('[data-smem]').forEach((b) => { b.onclick = () => serverMembers(servers.find((s) => s.id === b.dataset.smem)); });
    host2.querySelectorAll('[data-sopen]').forEach((b) => { b.onclick = () => NX.go('s/' + b.dataset.sopen); });
  }
  async function serverMembers(s) {
    const list = NX.h(`<div>${skel(3, 44)}</div>`);
    const m = NX.modal({ title: s.name, sub: fmt.plural(s.members, 'member'), body: list });
    const { data, error } = await db().from('server_members').select('user_id').eq('server_id', s.id);
    if (error) { list.innerHTML = `<p class="muted">${esc(adminErr(error))}</p>`; return; }
    const byId = userById();
    list.innerHTML = `<div class="pick-list" style="max-height:60vh">${(data || []).map((x) => byId[x.user_id]).filter(Boolean)
      .sort((a, b) => (b.id === s.owner_id) - (a.id === s.owner_id))
      .map((u) => `<div class="pick-row" data-u="${esc(u.id)}">${P().avatar(u, 30, { presence: true })}<span class="grow"><b>${P().nameText(u)}</b> ${u.id === s.owner_id ? '<span class="badge badge-owner"><i class="fa-solid fa-crown"></i>Owner</span>' : ''} ${P().roleBadge(u)}<br><small class="muted">@${esc(u.username)}</small></span><i class="fa-solid fa-chevron-right muted"></i></div>`).join('') || '<p class="muted" style="padding:10px">No members.</p>'}</div>`;
    list.querySelectorAll('[data-u]').forEach((r) => { r.onclick = () => { m.close(); openUser(byId[r.dataset.u]); }; });
  }

  /* ============ Announcements ============ */
  const LV = { info: ['fa-circle-info', 'Info'], update: ['fa-rocket', 'Update'], warning: ['fa-triangle-exclamation', 'Heads up'], event: ['fa-calendar-days', 'Event'] };
  function annCard(a) {
    const lv = LV[a.level] || LV.info;
    return `<article class="ann lv-${esc(a.level || 'info')}"><div class="ann-ico"><i class="fa-solid ${lv[0]}"></i></div><div class="ann-main">
      <div class="ann-meta"><span class="ann-tag">${lv[1]}</span>${a.pinned ? '<span class="ann-pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}<span>${esc(fmt.stamp(a.created_at))}</span>${a.expires_at ? `<span><i class="fa-regular fa-clock"></i> ${new Date(a.expires_at) < new Date() ? 'expired' : 'until ' + new Date(a.expires_at).toLocaleDateString()}</span>` : ''}</div>
      <h4>${esc(a.title)}</h4>${a.body ? `<div class="ann-body m-text">${MD.render(a.body)}</div>` : ''}</div></article>`;
  }
  async function announceTab() {
    body.innerHTML = head('Announcements', 'Posted to everyone: shown on Home and popped up live for anyone online.') + `<div id="annBox">${skel(2, 120)}</div>`;
    const { data, error } = await db().from('announcements').select('*').order('created_at', { ascending: false }).limit(100);
    if (!still('announce')) return;
    const box = body.querySelector('#annBox');
    if (missingTable(error)) { box.innerHTML = emptyBox('fa-database', 'Announcements aren’t set up yet', 'Run <code>supabase/announcements.sql</code> in the Supabase SQL editor, then reload.'); return; }
    if (error) { box.innerHTML = emptyBox('fa-triangle-exclamation', 'Couldn’t load announcements', esc(error.message)); return; }
    box.innerHTML = `<div class="card"><h3>New announcement</h3><p>Markdown works in the body: **bold**, links, lists, \`code\`.</p>
      <div class="stack" data-compose>
        <div class="field"><label>Title</label><input class="input" data-t maxlength="140" placeholder="Voice calls just got a lot smoother"></div>
        <div class="field"><label>Body</label><textarea class="input" data-b rows="5" maxlength="8000" placeholder="What changed, what people should know…"></textarea></div>
        <div class="field-row"><div class="field"><label>Type</label><select class="input" data-l><option value="update">Update</option><option value="info">Info</option><option value="event">Event</option><option value="warning">Heads up</option></select></div>
          <div class="field"><label>Expires</label><select class="input" data-x><option value="">Never</option><option value="24">After 1 day</option><option value="72">After 3 days</option><option value="168">After 1 week</option><option value="720">After 30 days</option></select></div></div>
        <label class="row" style="cursor:pointer"><input type="checkbox" class="switch" data-p><span>Pin to the top</span></label>
        <div class="field"><label>Preview</label><div data-prev></div></div>
        <p class="err" data-err></p>
        <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-post><i class="fa-solid fa-paper-plane"></i>Post announcement</button></div>
      </div></div>
      <h2 class="sec-title" style="margin-top:26px">Posted</h2><div data-list></div>`;
    const c = box.querySelector('[data-compose]');
    const draft = () => ({ title: c.querySelector('[data-t]').value.trim(), body: c.querySelector('[data-b]').value.trim(), level: c.querySelector('[data-l]').value, pinned: c.querySelector('[data-p]').checked, created_at: new Date().toISOString() });
    const prev = () => { const d = draft(); c.querySelector('[data-prev]').innerHTML = annCard({ ...d, title: d.title || 'Your title here' }); };
    c.addEventListener('input', prev); c.addEventListener('change', prev); prev();
    c.querySelector('[data-post]').onclick = async (e) => {
      const d = draft();
      const err = c.querySelector('[data-err]'); err.textContent = '';
      if (!d.title) { err.textContent = 'Give it a title.'; return; }
      const hrs = +c.querySelector('[data-x]').value;
      const row = { title: d.title, body: d.body, level: d.level, pinned: d.pinned, author_id: NX.me.id };
      if (hrs) row.expires_at = new Date(Date.now() + hrs * 3600e3).toISOString();
      const btn = e.currentTarget; btn.classList.add('busy');
      const { error: e2 } = await db().from('announcements').insert(row);
      btn.classList.remove('busy');
      if (e2) { err.textContent = e2.message; return; }
      NX.toast('Announcement posted.');
      NX.emit('announcements');
      announceTab();
    };
    const list = box.querySelector('[data-list]');
    list.innerHTML = (data || []).map((a) => `<div class="adm-annrow" data-id="${esc(a.id)}"><div class="grow">${annCard(a)}</div>
      <div class="adm-annacts"><button class="btn btn-ghost btn-sm" data-edit>Edit</button><button class="btn btn-ghost btn-sm" data-pin>${a.pinned ? 'Unpin' : 'Pin'}</button><button class="btn btn-danger-ghost btn-sm" data-del>Delete</button></div></div>`).join('')
      || '<div class="empty" style="padding:20px"><p>Nothing posted yet.</p></div>';
    list.querySelectorAll('[data-id]').forEach((row) => {
      const a = data.find((x) => x.id === row.dataset.id);
      row.querySelector('[data-pin]').onclick = async () => {
        const { error: e } = await db().from('announcements').update({ pinned: !a.pinned }).eq('id', a.id);
        if (e) return NX.fail(e);
        NX.emit('announcements'); announceTab();
      };
      row.querySelector('[data-del]').onclick = async () => {
        if (!await NX.confirm({ title: 'Delete announcement', body: `"${a.title}" will disappear for everyone.`, danger: true })) return;
        const { error: e } = await db().from('announcements').delete().eq('id', a.id);
        if (e) return NX.fail(e);
        NX.toast('Announcement deleted.');
        NX.emit('announcements'); announceTab();
      };
      row.querySelector('[data-edit]').onclick = () => editAnnouncement(a);
    });
  }
  function editAnnouncement(a) {
    const b = NX.h(`<div class="stack">
      <div class="field"><label>Title</label><input class="input" data-t maxlength="140" value="${esc(a.title)}"></div>
      <div class="field"><label>Body</label><textarea class="input" data-b rows="6" maxlength="8000">${esc(a.body || '')}</textarea></div>
      <div class="field-row"><div class="field"><label>Type</label><select class="input" data-l>${Object.entries(LV).map(([k, v]) => `<option value="${k}" ${a.level === k ? 'selected' : ''}>${v[1]}</option>`).join('')}</select></div>
        <div class="field"><label>Expires</label><select class="input" data-x><option value="keep">${a.expires_at ? 'Keep (' + new Date(a.expires_at).toLocaleDateString() + ')' : 'Never'}</option><option value="0">Never</option><option value="24">1 day from now</option><option value="168">1 week from now</option><option value="720">30 days from now</option></select></div></div>
      <p class="err"></p></div>`);
    NX.modal({
      title: 'Edit announcement', wide: true, body: b,
      foot: [{ label: 'Cancel' }, {
        label: 'Save', cls: 'btn-primary', onClick: async () => {
          const title = b.querySelector('[data-t]').value.trim();
          if (!title) { b.querySelector('.err').textContent = 'Give it a title.'; return false; }
          const patch = { title, body: b.querySelector('[data-b]').value.trim(), level: b.querySelector('[data-l]').value };
          const x = b.querySelector('[data-x]').value;
          if (x !== 'keep') patch.expires_at = +x ? new Date(Date.now() + +x * 3600e3).toISOString() : null;
          const { error } = await db().from('announcements').update(patch).eq('id', a.id);
          if (error) { b.querySelector('.err').textContent = error.message; return false; }
          NX.toast('Announcement updated.');
          NX.emit('announcements');
          if (tab === 'announce') announceTab();
        },
      }],
    });
  }

  /* ============ Roles ============ */
  const nextRole = () => ({ 0: 'admin', 1: 'sudo' })[myRank()] || null;
  async function loadRankRequests() {
    const { data, error } = await db().from('rank_requests').select('*').order('created_at', { ascending: false }).limit(200);
    rrLive = !error;
    const list = data || [];
    myReq = list.find((r) => r.user_id === NX.me.id && r.status === 'pending') || null;
    reviewQueue = list.filter((r) => r.user_id !== NX.me.id && r.status === 'pending');
    if (alive) setCount('roles', reviewQueue.length);
  }
  function rankUpButton() {
    if (!rrLive || !nextRole()) return '';
    if (myReq) return `<span class="badge badge-muted"><i class="fa-regular fa-clock"></i>${ROLE_LABEL[myReq.role]} requested</span>`;
    return `<button class="btn btn-ghost btn-sm" data-rr-ask><i class="fa-solid fa-arrow-up"></i>Request ${ROLE_LABEL[nextRole()]}</button>`;
  }
  function requestRankUp() {
    const role = nextRole(); if (!role) return;
    const b = NX.h(`<div class="stack"><p class="muted" style="font-size:13.5px">Staff can’t raise their own rank. Your request goes to ${role === 'sudo' ? 'the owner' : 'staff who can grant it'}, who can approve or decline it.</p>
      <div class="field"><label>Why? (optional)</label><textarea class="input" rows="3" maxlength="1000" placeholder="What you’d do with it"></textarea></div><p class="err"></p></div>`);
    NX.modal({
      title: `Request ${ROLE_LABEL[role]}`, body: b,
      foot: [{ label: 'Cancel' }, {
        label: 'Send request', cls: 'btn-primary', icon: 'fa-paper-plane', onClick: async () => {
          const { error } = await db().from('rank_requests').insert({ user_id: NX.me.id, role, reason: b.querySelector('textarea').value.trim() || null });
          if (error) { b.querySelector('.err').textContent = /duplicate|unique/i.test(error.message) ? 'You already have a request waiting.' : adminErr(error); return false; }
          NX.toast('Request sent.');
          await loadRankRequests();
          if (tab === 'roles') rolesTab(); else if (tab === 'users') paintUsers();
        },
      }],
    });
  }
  async function cancelRankUp() {
    const { error } = await db().from('rank_requests').update({ status: 'cancelled' }).eq('id', myReq.id);
    if (error) return NX.toast(adminErr(error), { err: true });
    await loadRankRequests();
    if (tab === 'roles') rolesTab();
  }
  async function reviewRankUp(r, approve) {
    let note = null;
    if (!approve) { note = await askReason('Decline this request'); if (note === null) return; note = note || null; }
    const { error } = await db().rpc('review_rank_request', { p_id: r.id, p_approve: approve, p_note: note });
    if (error) return NX.toast(adminErr(error), { err: true });
    const u = users.find((x) => x.id === r.user_id);
    if (approve && u) { u.platform_role = r.role; u.is_platform_admin = true; }
    NX.toast(approve ? `@${u?.username || 'They'} ${u ? 'is' : 'are'} now ${r.role === 'sudo' ? 'a Sudo Admin' : 'an Admin'}.` : 'Request declined.');
    await loadRankRequests();
    if (tab === 'roles') rolesTab();
    if (tab === 'owner') ownerTab();
  }
  function requestsHtml() {
    const byId = userById();
    return reviewQueue.map((r) => {
      const u = byId[r.user_id] || { id: r.user_id, username: 'unknown' };
      return `<div class="adm-lrow" data-rr="${esc(r.id)}">${P().avatar(u, 34, { presence: true })}
        <div class="grow"><b>${P().nameText(u)} ${P().roleBadge(u)} <i class="fa-solid fa-arrow-right muted" style="font-size:11px"></i> <span class="badge badge-role ${r.role === 'sudo' ? 'r2' : ''}">${ROLE_LABEL[r.role]}</span></b>
          <small class="muted">@${esc(u.username)} · ${esc(fmt.stamp(r.created_at))}</small>${r.reason ? `<div class="adm-quote">${esc(r.reason)}</div>` : ''}</div>
        <div class="row"><button class="btn btn-quiet btn-sm" data-rr-no>Decline</button><button class="btn btn-primary btn-sm" data-rr-yes>Approve</button></div></div>`;
    }).join('');
  }
  function wireRequests(el) {
    el.querySelectorAll('[data-rr]').forEach((row) => {
      const r = reviewQueue.find((x) => x.id === row.dataset.rr);
      row.querySelector('[data-rr-yes]').onclick = () => reviewRankUp(r, true);
      row.querySelector('[data-rr-no]').onclick = () => reviewRankUp(r, false);
    });
  }
  const TIERS = [
    { r: 3, name: 'Owner', ic: 'fa-crown', blurb: 'Every permission, always. There is only one.' },
    { r: 2, name: 'Sudo Admins', ic: 'fa-user-shield', blurb: 'Act on admins and users. Cannot touch the owner.' },
    { r: 1, name: 'Admins', ic: 'fa-shield-halved', blurb: 'Act on regular users only.' },
  ];
  async function rolesTab() {
    body.innerHTML = head('Admin roles', 'Owner &gt; Sudo Admin &gt; Admin. Staff can only act on people ranked below them.',
      can('manage_roles') ? '<button class="btn btn-primary btn-sm" data-add-staff><i class="fa-solid fa-user-plus"></i>Add staff</button>' : '') + skel(3, 90);
    await Promise.all([loadUsers(), loadRankRequests(), loadPerms()]);
    if (!still('roles')) return;
    const mine = rrLive && nextRole() ? `<div class="card"><div class="adm-row-h"><h3><i class="fa-solid fa-arrow-up-right-dots"></i> Your rank</h3>${P().roleBadge(NX.me)}</div>
      ${myReq ? `<p>You asked to become a <b>${ROLE_LABEL[myReq.role]}</b> ${esc(fmt.ago(myReq.created_at))} ago. ${myReq.role === 'sudo' ? 'The owner' : 'Staff'} will decide.</p><button class="btn btn-quiet btn-sm" data-rr-cancel>Withdraw request</button>`
        : `<p>You can’t raise your own rank, but you can ask for <b>${ROLE_LABEL[nextRole()]}</b>.</p><button class="btn btn-primary btn-sm" data-rr-ask><i class="fa-solid fa-arrow-up"></i>Request ${ROLE_LABEL[nextRole()]}</button>`}</div>` : '';
    const queue = reviewQueue.length ? `<div class="card"><div class="adm-row-h"><h3><i class="fa-solid fa-inbox"></i> Rank-up requests</h3><span class="muted">${reviewQueue.length} waiting</span></div>${requestsHtml()}</div>` : '';
    const tiers = TIERS.map((t) => {
      const list = users.filter((u) => R(u) === t.r);
      return `<div class="card adm-tier r${t.r}"><div class="adm-row-h"><span class="adm-tico"><i class="fa-solid ${t.ic}"></i></span><div class="grow"><h3 style="margin:0">${t.name}</h3><small class="muted">${t.blurb}</small></div><b class="adm-tn">${list.length}</b></div>
        ${list.map((u) => `<div class="adm-lrow" data-open-user="${esc(u.id)}">${P().avatar(u, 32, { presence: true })}<div class="grow"><b>${P().nameText(u)}${u.id === NX.me.id ? ' <span class="badge badge-owner">You</span>' : ''}</b><small class="muted">@${esc(u.username)}</small></div>
          ${canAct(u) && can('manage_roles') ? `<select class="input" data-tier-sel="${esc(u.id)}" style="width:auto">${ROLE_KEYS.map((k, r) => `<option value="${k}" ${R(u) === r ? 'selected' : ''} ${r >= myRank() ? 'disabled' : ''}>${ROLE_TXT[r]}</option>`).join('')}</select>`
            : `<span class="muted"${canAct(u) ? '' : ' title="Ranked the same as or above you"'}><i class="fa-solid fa-lock"></i></span>`}</div>`).join('') || `<p class="muted" style="margin-top:8px">No ${t.name.toLowerCase()} yet.</p>`}</div>`;
    }).join('');
    body.innerHTML = head('Admin roles', 'Owner &gt; Sudo Admin &gt; Admin. Staff can only act on people ranked below them.',
      can('manage_roles') ? '<button class="btn btn-primary btn-sm" data-add-staff><i class="fa-solid fa-user-plus"></i>Add staff</button>' : '')
      + mine + queue + tiers
      + `<h2 class="sec-title" style="margin-top:26px">What each role can do <span class="muted" style="text-transform:none;font-weight:500;letter-spacing:0">· ${myRank() >= 3 ? 'change these in the Owner tab' : 'set by the owner'}</span></h2><div data-matrix></div>`;
    wireRequests(body);
    body.querySelector('[data-rr-ask]')?.addEventListener('click', requestRankUp);
    body.querySelector('[data-rr-cancel]')?.addEventListener('click', cancelRankUp);
    body.querySelector('[data-add-staff]')?.addEventListener('click', addStaff);
    body.querySelectorAll('[data-tier-sel]').forEach((sel) => {
      sel.onclick = (e) => e.stopPropagation();
      sel.onchange = async () => {
        const u = users.find((x) => x.id === sel.dataset.tierSel);
        if (!await changeRole(u, sel.value)) sel.value = ROLE_KEYS[R(u)];
      };
    });
    paintMatrix(body.querySelector('[data-matrix]'), false);
  }
  function addStaff() {
    const opts = ROLE_KEYS.slice(1).map((k, i) => ({ k, r: i + 1 })).filter((o) => o.r < myRank());
    let pick = null;
    const b = NX.h(`<div class="stack"><input class="input" data-q placeholder="Search by name or username" autocomplete="off"><div class="pick-list" data-list></div>
      <div class="field"><label>Role</label><select class="input" data-role>${opts.map((o) => `<option value="${o.k}">${ROLE_TXT[o.r]}</option>`).join('')}</select></div><p class="err"></p></div>`);
    const paint = () => {
      const q = b.querySelector('[data-q]').value.trim().toLowerCase();
      const list = users.filter((u) => !R(u) && u.id !== NX.me.id && (!q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q))).slice(0, 8);
      b.querySelector('[data-list]').innerHTML = list.map((u) => `<div class="pick-row${pick?.id === u.id ? ' adm-picked' : ''}" data-u="${esc(u.id)}">${P().avatar(u, 28)}<span class="grow"><b>${P().nameText(u)}</b> <small class="muted">@${esc(u.username)}${u.is_banned ? ' · banned' : ''}</small></span>${pick?.id === u.id ? '<i class="fa-solid fa-check" style="color:var(--accent-hi)"></i>' : ''}</div>`).join('')
        || '<p class="muted" style="padding:8px">No regular users match.</p>';
      b.querySelectorAll('[data-u]').forEach((r) => { r.onclick = () => { pick = users.find((u) => u.id === r.dataset.u); m.primary.disabled = false; paint(); }; });
    };
    const m = NX.modal({
      title: 'Add staff', body: b,
      foot: [{ label: 'Cancel' }, {
        label: 'Add', cls: 'btn-primary', icon: 'fa-user-plus', primary: true, onClick: async () => {
          if (!pick) return false;
          const role = b.querySelector('[data-role]').value;
          const { error } = await db().rpc('set_user_role', { p_user_id: pick.id, p_role: role });
          if (error) { b.querySelector('.err').textContent = adminErr(error); return false; }
          pick.platform_role = role; pick.is_platform_admin = true;
          NX.toast(`@${pick.username} is now ${role === 'sudo' ? 'a Sudo Admin' : 'an Admin'}.`);
          if (tab === 'roles') rolesTab();
        },
      }],
    });
    m.primary.disabled = true;
    b.querySelector('[data-q]').oninput = paint;
    paint();
  }
  function paintMatrix(el, editable) {
    el.innerHTML = `<div class="tbl-wrap"><table class="tbl adm-matrix"><thead><tr><th>Permission</th><th><i class="fa-solid fa-crown"></i> Owner</th><th><i class="fa-solid fa-user-shield"></i> Sudo</th><th><i class="fa-solid fa-shield-halved"></i> Admin</th></tr></thead><tbody>
      ${PERMS.map((p) => `<tr data-k="${p.k}"><td><div class="who"><i class="fa-solid ${p.ic} muted" style="width:18px;text-align:center"></i><div><b>${esc(p.t)}</b><small>${esc(p.d)}</small></div></div></td>
        <td><i class="fa-solid fa-circle-check adm-yes"></i></td>
        ${['sudo', 'admin'].map((role) => `<td>${editable ? `<input type="checkbox" class="switch" data-role="${role}" ${perms[role][p.k] ? 'checked' : ''} aria-label="${esc(p.t)} for ${role}">`
          : (perms[role][p.k] ? '<i class="fa-solid fa-circle-check adm-yes"></i>' : '<i class="fa-solid fa-circle-minus adm-no"></i>')}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`;
    if (!editable) return;
    el.querySelectorAll('input.switch').forEach((sw) => {
      sw.onchange = async () => {
        const k = sw.closest('[data-k]').dataset.k, role = sw.dataset.role, on = sw.checked;
        sw.disabled = true;
        const { error } = await db().rpc('set_role_perm', { p_role: role, p_perm: k, p_allowed: on });
        sw.disabled = false;
        if (error) { sw.checked = !on; return NX.toast(adminErr(error), { err: true }); }
        perms[role][k] = on;
        NX.toast(`${role === 'sudo' ? 'Sudo Admins' : 'Admins'} ${on ? 'can now' : 'can no longer'}: ${PERMS.find((p) => p.k === k).t.toLowerCase()}.`);
      };
    });
  }

  /* ============ Owner ============ */
  async function ownerTab() {
    body.innerHTML = head('Owner controls', 'Only you can see this. Decide what Sudo Admins and Admins are allowed to do; it applies instantly and the database enforces it.') + skel(3, 90);
    if (myRank() < 3) { body.innerHTML = emptyBox('fa-lock', 'Owner only', ''); return; }
    await Promise.all([loadUsers(), loadPerms(), loadRankRequests()]);
    if (!still('owner')) return;
    const n = (r) => users.filter((u) => R(u) === r).length;
    body.innerHTML = head('Owner controls', 'Only you can see this. Decide what Sudo Admins and Admins are allowed to do; it applies instantly and the database enforces it.') + `
      <div class="card adm-owner"><div class="adm-row-h">${P().avatar(NX.me, 54, { presence: true })}<div class="grow"><b style="font-size:17px">${P().nameText(NX.me)}</b><br><small style="color:var(--nitro)"><i class="fa-solid fa-crown"></i> Owner of NexChat</small></div>
        <div class="adm-ostats"><button data-goto="roles"><b>${n(2)}</b><small>Sudo Admins</small></button><button data-goto="roles"><b>${n(1)}</b><small>Admins</small></button><button data-goto="users"><b>${users.filter((u) => !R(u)).length}</b><small>Users</small></button></div></div></div>
      ${reviewQueue.length ? `<div class="card"><div class="adm-row-h"><h3><i class="fa-solid fa-inbox"></i> Rank-up requests</h3><span class="muted">${reviewQueue.length} waiting for you</span></div>${requestsHtml()}</div>` : ''}
      <h2 class="sec-title" style="margin-top:26px">Role permissions <span class="muted" style="text-transform:none;font-weight:500;letter-spacing:0">· you always have every permission</span></h2>
      <div data-grid></div>
      <p class="hint" style="margin-top:10px"><i class="fa-solid fa-circle-info"></i> The rank rule applies on top of every switch: staff can never ban, reset the password of, delete or demote someone at or above their own rank.</p>
      <div class="adm-row-h" style="margin-top:26px"><h2 class="sec-title" style="margin:0">Recent staff activity</h2><button class="btn btn-quiet btn-sm" data-goto="audit">Full log <i class="fa-solid fa-arrow-right"></i></button></div>
      <div data-audit></div>`;
    wireRequests(body);
    if (!permsLive) body.querySelector('[data-grid]').innerHTML = emptyBox('fa-database', 'Permissions aren’t set up yet', 'Run <code>supabase/roles_v2</code> in the Supabase SQL editor, then reload.');
    else paintMatrix(body.querySelector('[data-grid]'), true);
    paintAudit(body.querySelector('[data-audit]'), 8, 'all');
  }

  /* ============ Audit ============ */
  const ACTIONS = {
    role: (d) => `changed the role of {t} to <b>${esc({ user: 'User', admin: 'Admin', sudo: 'Sudo Admin' }[d?.role] || d?.role)}</b>`,
    ban: (d) => `banned {t}${d?.reason ? ` <span class="muted">“${esc(d.reason)}”</span>` : ''}`,
    unban: () => 'unbanned {t}',
    reset_password: () => 'set a new password for {t}',
    delete_user: (d) => `deleted the account <b>@${esc(d?.username || 'unknown')}</b>`,
    permission: (d) => `${d?.allowed ? 'allowed' : 'blocked'} <b>${d?.role === 'sudo' ? 'Sudo Admins' : 'Admins'}</b> to ${esc((PERMS.find((p) => p.k === d?.perm)?.t || d?.perm || '').toLowerCase())}`,
    appeal_accept: () => 'accepted the ban appeal of {t}',
    appeal_decline: () => 'declined the ban appeal of {t}',
    rankup_approve: (d) => `approved {t} for <b>${esc(ROLE_LABEL[d?.role] || d?.role)}</b>`,
    rankup_decline: (d) => `declined the ${esc(ROLE_LABEL[d?.role] || d?.role)} request from {t}`,
    storage_quota: (d) => `set the drive storage of {t} to <b>${esc(d?.gb ?? d?.quota_gb ?? '?')} GB</b>`,
  };
  const AU_ICON = { role: 'fa-user-shield', ban: 'fa-ban', unban: 'fa-unlock', reset_password: 'fa-key', delete_user: 'fa-user-xmark', permission: 'fa-sliders', appeal_accept: 'fa-gavel', appeal_decline: 'fa-gavel', rankup_approve: 'fa-arrow-up', rankup_decline: 'fa-arrow-up', storage_quota: 'fa-hard-drive' };
  let auditFilter = 'all';
  async function auditTab() {
    body.innerHTML = head('Audit log', 'Bans, role changes, password resets, deletions and permission changes.') + `
      <div class="adm-tools"><div class="seg-tabs scroll" id="auFilter">${[['all', 'All'], ['role', 'Roles'], ['ban', 'Bans'], ['reset_password', 'Passwords'], ['delete_user', 'Deletions'], ['permission', 'Permissions']].map(([k, l]) => `<button type="button" data-f="${k}" class="${auditFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div></div><div data-audit></div>`;
    body.querySelector('#auFilter').onclick = (e) => {
      const b = e.target.closest('[data-f]'); if (!b) return;
      auditFilter = b.dataset.f;
      body.querySelectorAll('#auFilter button').forEach((x) => x.classList.toggle('on', x === b));
      paintAudit(body.querySelector('[data-audit]'), 200, auditFilter);
    };
    paintAudit(body.querySelector('[data-audit]'), 200, auditFilter);
  }
  async function paintAudit(el, limit, filter) {
    el.innerHTML = skel(3, 48);
    await loadUsers();
    let q = db().from('admin_audit').select('*').order('created_at', { ascending: false }).limit(limit);
    if (filter !== 'all') q = filter === 'ban' ? q.in('action', ['ban', 'unban']) : q.eq('action', filter);
    const { data, error } = await q;
    if (!el.isConnected) return;
    if (error) { el.innerHTML = emptyBox('fa-clock-rotate-left', missingTable(error) ? 'The audit log isn’t set up' : 'Couldn’t load the audit log', missingTable(error) ? 'Run supabase/roles_v2 to start the audit log.' : esc(error.message)); return; }
    const byId = userById();
    const who = (id) => { const u = byId[id]; return u ? `<b>@${esc(u.username)}</b>` : '<b>a deleted account</b>'; };
    el.innerHTML = `<div class="card" style="padding:6px 14px">${(data || []).map((a) => {
      const actor = byId[a.actor_id];
      const text = (ACTIONS[a.action] || (() => esc(a.action)))(a.detail || {}).replace('{t}', a.target_id ? who(a.target_id) : '');
      return `<div class="adm-au a-${esc(a.action)}"><span class="adm-auico"><i class="fa-solid ${AU_ICON[a.action] || 'fa-circle'}"></i></span>
        ${actor ? P().avatar(actor, 24, { halo: false, deco: false }) : ''}<div class="grow">${actor ? `<b>@${esc(actor.username)}</b>` : '<b>Someone</b>'} ${text}</div>
        <span class="muted adm-t" title="${esc(new Date(a.created_at).toLocaleString())}">${esc(fmt.stamp(a.created_at))}</span></div>`;
    }).join('') || '<div class="empty" style="padding:20px"><p>No staff actions yet.</p></div>'}</div>`;
  }

  /* ============ Queues: Nitro, storage, appeals ============ */
  function queueRow(o) {
    const p = o.profile || { username: 'unknown' };
    return `<div class="adm-lrow" data-qid="${esc(o.id)}">${P().avatar(p, 34, { presence: true })}
      <div class="grow"><b>${P().nameText(p)} ${o.tag || ''}</b><small class="muted">@${esc(p.username)} · ${esc(fmt.stamp(o.created_at))}${o.sub ? ' · ' + o.sub : ''}</small>
        ${o.msg ? `<div class="adm-quote">${esc(o.msg)}</div>` : ''}${o.note ? `<small class="muted" style="display:block;margin-top:6px">Note: ${esc(o.note)}</small>` : ''}</div>
      ${o.pending ? `<div class="row"><button class="btn btn-quiet btn-sm" data-q-no>Decline</button><button class="btn btn-primary btn-sm" data-q-yes>${o.yes || 'Approve'}</button></div>` : ''}</div>`;
  }
  async function nitroTab() {
    body.innerHTML = head('Nitro requests', 'Approving grants the animated halo and profile extras.') + skel(3);
    const { data, error } = await db().from('nitro_requests')
      .select('*, profiles!user_id(id,username,display_name,avatar_url,accent_color,is_nitro,banner_gif_url,theme)')
      .order('created_at', { ascending: false }).limit(300);
    if (!still('nitro')) return;
    const box = NX.h('<div class="card" style="padding:6px 16px"></div>');
    body.innerHTML = head('Nitro requests', 'Approving grants the animated halo and profile extras.');
    body.appendChild(box);
    if (error) { box.innerHTML = emptyBox('fa-triangle-exclamation', 'Couldn’t load requests', esc(error.message)); return; }
    setCount('nitro', (data || []).filter((r) => r.status === 'pending').length);
    box.innerHTML = (data || []).map((r) => queueRow({ id: r.id, profile: r.profiles, created_at: r.created_at, msg: r.message, note: r.review_note, pending: r.status === 'pending', tag: r.status === 'pending' ? '' : statusBadge(r.status, 'approved') })).join('')
      || emptyBox('fa-inbox', 'Nothing waiting', 'New Nitro requests land here.');
    box.querySelectorAll('[data-qid]').forEach((row) => {
      const id = row.dataset.qid;
      row.querySelector('[data-q-yes]')?.addEventListener('click', async () => {
        const { error: e } = await db().from('nitro_requests').update({ status: 'approved', reviewed_by: NX.me.id, reviewed_at: new Date().toISOString() }).eq('id', id);
        if (e) return NX.fail(e);
        NX.toast('Nitro granted.', { icon: 'fa-bolt' }); users = []; nitroTab();
      });
      row.querySelector('[data-q-no]')?.addEventListener('click', async () => {
        const note = await askReason('Decline this Nitro request');
        if (note === null) return;
        const { error: e } = await db().from('nitro_requests').update({ status: 'denied', reviewed_by: NX.me.id, reviewed_at: new Date().toISOString(), review_note: note || null }).eq('id', id);
        if (e) return NX.fail(e);
        NX.toast('Request declined.'); nitroTab();
      });
    });
  }
  async function storageTab() {
    const title = head('Storage requests', 'People asking for more room in My Drive. Approving sets their new size straight away.');
    body.innerHTML = title + skel(3);
    const { data, error } = await db().from('storage_requests')
      .select('*, profiles!user_id(id,username,display_name,avatar_url,accent_color,is_nitro,banner_gif_url,theme,drive_quota_gb)')
      .order('created_at', { ascending: false }).limit(300);
    if (!still('storage')) return;
    body.innerHTML = title;
    const box = NX.h('<div class="card" style="padding:6px 16px"></div>');
    body.appendChild(box);
    if (error) {
      box.innerHTML = missingTable(error) ? emptyBox('fa-database', 'Storage requests aren’t set up', 'Run <code>supabase/storage_quota.sql</code> in the Supabase SQL editor.')
        : emptyBox('fa-triangle-exclamation', 'Couldn’t load requests', esc(error.message));
      return;
    }
    setCount('storage', (data || []).filter((r) => r.status === 'pending').length);
    box.innerHTML = (data || []).map((r) => queueRow({
      id: r.id, profile: r.profiles, created_at: r.created_at, msg: r.reason, note: r.review_note, pending: r.status === 'pending',
      tag: r.status === 'pending' ? '' : statusBadge(r.status, 'approved'), yes: `Approve ${r.requested_gb} GB`,
      sub: `${quotaOf(r.profiles)} GB now → asking for <b>${esc(r.requested_gb)} GB</b>`,
    })).join('') || emptyBox('fa-hard-drive', 'Nothing waiting', 'Storage requests from My Drive land here.');
    box.querySelectorAll('[data-qid]').forEach((row) => {
      const id = row.dataset.qid;
      const resolve = async (approve) => {
        let note = null;
        if (!approve) { note = await askReason('Decline this storage request'); if (note === null) return; note = note || null; }
        const { error: e } = await db().rpc('review_storage_request', { p_id: id, p_approve: approve, p_note: note });
        if (e) return NX.toast(adminErr(e), { err: true });
        NX.toast(approve ? 'Storage increased.' : 'Request declined.');
        users = []; storageTab();
      };
      row.querySelector('[data-q-yes]')?.addEventListener('click', () => resolve(true));
      row.querySelector('[data-q-no]')?.addEventListener('click', () => resolve(false));
    });
  }
  async function appealsTab() {
    const title = head('Ban appeals', 'Accepting an appeal lifts the ban straight away.');
    body.innerHTML = title + skel(3);
    const { data, error } = await db().from('ban_appeals')
      .select('*, profiles!user_id(id,username,display_name,avatar_url,accent_color,is_banned)')
      .order('created_at', { ascending: false }).limit(300);
    if (!still('appeals')) return;
    body.innerHTML = title;
    const box = NX.h('<div class="card" style="padding:6px 16px"></div>');
    body.appendChild(box);
    if (error) {
      box.innerHTML = missingTable(error) ? emptyBox('fa-database', 'Appeals aren’t set up yet', 'Run the ban appeals SQL patch in the Supabase SQL editor.')
        : emptyBox('fa-triangle-exclamation', 'Couldn’t load appeals', esc(error.message));
      return;
    }
    setCount('appeals', (data || []).filter((a) => a.status === 'pending').length);
    box.innerHTML = (data || []).map((a) => queueRow({
      id: a.id, profile: a.profiles, created_at: a.created_at, msg: a.message, note: a.review_note, pending: a.status === 'pending',
      tag: a.status === 'pending' ? '' : statusBadge(a.status, 'accepted'), yes: 'Accept & unban',
    })).join('') || emptyBox('fa-gavel', 'No appeals', 'Appeals from banned accounts land here.');
    box.querySelectorAll('[data-qid]').forEach((row) => {
      const id = row.dataset.qid;
      const resolve = async (accept) => {
        let note = null;
        if (!accept) { note = await askReason('Decline this appeal'); if (note === null) return; note = note || null; }
        const { error: e } = await db().rpc('resolve_ban_appeal', { p_appeal_id: id, p_accept: accept, p_note: note });
        if (e) return NX.toast(adminErr(e), { err: true });
        NX.toast(accept ? 'Appeal accepted — account restored.' : 'Appeal declined.');
        users = []; appealsTab();
      };
      row.querySelector('[data-q-yes]')?.addEventListener('click', () => resolve(true));
      row.querySelector('[data-q-no]')?.addEventListener('click', () => resolve(false));
    });
  }

  /* ============ Storage endpoints ============
     Groups fill in order (group 1, then group 2 when group 1 is full). Each
     endpoint in a group is a mirror of that group's storage with its own
     login. Saved through supabase/storage_groups.sql functions. */
  const GB = 1024 ** 3, MB = 1024 ** 2;
  const CAT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
  let se = null, seEditCat = false;
  const seFmt = (bytes) => { const b = Number(bytes) || 0; if (!b) return '0 GB'; if (b < GB) return (b / MB).toFixed(b < 10 * MB ? 1 : 0) + ' MB'; return (b / GB).toFixed(b < 10 * GB ? 1 : 0) + ' GB'; };
  const seErr = (e) => (e?.code === 'PGRST202' || /could not find the function|schema cache/i.test(e?.message || '')) ? 'Run supabase/storage_groups.sql in the Supabase SQL editor first.' : ((e?.message || '').replace(/^.*?exception:\s*/i, '') || 'That didn’t work.');
  async function seRpc(name, args) { const { data, error } = await db().rpc(name, args); if (error) throw new Error(seErr(error)); return data; }
  const seAll = () => (se?.groups || []).flatMap((g) => (g.endpoints || []).map((e) => ({ ...e, groupId: g.id })));
  const seGroup = (id) => (se?.groups || []).find((g) => g.id === id) || null;
  async function seMeasure(ep) {
    const bytes = await window.CloudGate.measure(ep);
    await seRpc('storage_admin_set_baseline', { p_endpoint: ep.id, p_measured: bytes });
    return bytes;
  }
  async function seChanged() { await window.CloudGate?.refresh?.(); await endpointsTab(true); }

  async function endpointsTab(quiet) {
    const title = head('Storage endpoints', 'Groups fill in order. When group 1 is full, uploads move to group 2, and so on. Each group is one storage; its endpoints are mirrors with their own logins.',
      '<button class="btn btn-primary btn-sm" data-se="g-add"><i class="fa-solid fa-plus"></i>Add group</button>');
    if (!quiet) body.innerHTML = title + skel(2, 110);
    try { se = await seRpc('storage_admin_list'); if (!se) throw new Error('No storage data came back.'); }
    catch (e) { if (still('endpoints')) body.innerHTML = title + emptyBox('fa-database', 'Storage endpoints aren’t set up', esc(e.message)); return; }
    if (!still('endpoints')) return;
    const groups = se.groups || [];
    const nEp = seAll().length;
    let cat;
    if (se.configured && !seEditCat) {
      cat = `<div class="card adm-row-h"><div class="grow"><small class="muted">Category NexChat stores its files in</small><div><b class="mono">${esc(se.category)}</b></div>${se.cdn ? `<small class="mono muted">${esc(se.cdn)}</small>` : ''}</div><button class="btn btn-ghost btn-sm" data-se="cat-edit"><i class="fa-solid fa-pen"></i>Change</button></div>`;
    } else {
      cat = `<div class="card${!se.configured && nEp ? ' adm-next' : ''}"><h3>${se.configured ? 'Change the category' : nEp ? 'Next step · Which category does NexChat use?' : 'Category'}</h3>
        <p>${nEp ? 'Type the CloudGate category name NexChat stores its files under, for example <code>nexchats-us1</code>. Every endpoint uses the same category.' : 'Add a group and at least one endpoint first. Then set the category here.'}</p>
        <div class="field-row"><div class="field"><label>Category</label><input class="input mono" data-cat maxlength="63" spellcheck="false" autocomplete="off" value="${esc(se.category || '')}" ${nEp ? '' : 'disabled'}></div>
          <div class="field"><label>CDN host (optional)</label><input class="input mono" data-cdn spellcheck="false" autocomplete="off" placeholder="d1dncmkdpaif79.cloudfront.net" value="${esc(se.cdn || '')}" ${nEp ? '' : 'disabled'}></div></div>
        <div class="row" style="justify-content:flex-end;margin-top:12px">${se.configured ? '<button class="btn btn-quiet btn-sm" data-se="cat-cancel">Cancel</button>' : ''}<button class="btn btn-primary btn-sm" data-se="cat-save" ${nEp ? '' : 'disabled'}><i class="fa-solid fa-check"></i>Save category</button></div></div>`;
    }
    const arrow = (act, id, dir, on) => `<button class="icon-btn sm" data-se="${act}" data-id="${esc(id)}" data-dir="${dir}" title="${dir < 0 ? 'Move up' : 'Move down'}" ${on ? '' : 'disabled'}><i class="fa-solid fa-arrow-${dir < 0 ? 'up' : 'down'}"></i></button>`;
    const gcard = (g, i) => {
      const cap = Number(g.capacity_bytes) || 0, used = Number(g.used_bytes) || 0;
      const pct = cap ? Math.min(100, (used / cap) * 100) : 0;
      const full = cap > 0 && used >= cap;
      const eps = g.endpoints || [];
      return `<div class="card adm-group"><div class="adm-row-h"><span class="adm-gnum">${i + 1}</span><div class="grow"><b>${esc(g.name)}</b><small class="muted" style="display:block">${seFmt(used)} of ${seFmt(cap)} used${g.measured_at ? ` · measured ${new Date(g.measured_at).toLocaleDateString()}` : ' · not measured yet'}${full ? ' · full, uploads move to the next group' : ''}</small></div>
        <div class="row" style="gap:2px">${arrow('g-move', g.id, -1, i > 0)}${arrow('g-move', g.id, 1, i < groups.length - 1)}
          <button class="icon-btn sm" data-se="e-add" data-g="${esc(g.id)}" title="Add endpoint"><i class="fa-solid fa-plus"></i></button>
          <button class="icon-btn sm" data-se="g-edit" data-id="${esc(g.id)}" title="Edit group"><i class="fa-solid fa-pen"></i></button>
          <button class="icon-btn sm danger" data-se="g-del" data-id="${esc(g.id)}" title="Delete group"><i class="fa-solid fa-trash"></i></button></div></div>
        <div class="adm-gbar${full ? ' full' : ''}" title="${Math.round(pct)}% used"><span style="width:${pct.toFixed(1)}%"></span></div>
        ${eps.length ? eps.map((e, j) => `<div class="adm-ep"><div class="grow" style="min-width:0"><b>${esc(e.name)}</b><small class="mono muted adm-ellip">${esc(e.base_url)}</small><small class="muted">login <span class="mono">${esc(e.username)}</span> · password set · ${eps.length > 1 ? 'mirror of this group’s storage' : 'the group’s only way in'}</small></div>
          <div class="row adm-epacts">${arrow('e-move', e.id, -1, j > 0)}${arrow('e-move', e.id, 1, j < eps.length - 1)}
            <button class="btn btn-ghost btn-sm" data-se="e-test" data-id="${esc(e.id)}"><i class="fa-solid fa-plug"></i>Test</button>
            <button class="btn btn-ghost btn-sm" data-se="e-measure" data-id="${esc(e.id)}"><i class="fa-solid fa-gauge"></i>Measure</button>
            <button class="icon-btn sm" data-se="e-edit" data-id="${esc(e.id)}" title="Edit endpoint"><i class="fa-solid fa-pen"></i></button>
            <button class="icon-btn sm danger" data-se="e-del" data-id="${esc(e.id)}" title="Delete endpoint"><i class="fa-solid fa-trash"></i></button></div></div>`).join('')
          : '<p class="muted" style="margin-top:10px;font-size:13px">No endpoints in this group yet. Use the + button to add one.</p>'}</div>`;
    };
    body.innerHTML = title + cat + (groups.length ? groups.map(gcard).join('') : emptyBox('fa-hard-drive', 'No storage yet', 'Add group 1, then add its endpoints. Uploads go to the first group that has room.'));
  }
  async function busyBtn(b, fn) { b?.classList.add('busy'); try { return await fn(); } finally { b?.classList.remove('busy'); } }
  function seClick(ev) {
    if (tab !== 'endpoints') return;
    const b = ev.target.closest('[data-se]');
    if (!b || b.disabled) return;
    const act = b.dataset.se, id = b.dataset.id, dir = +b.dataset.dir;
    const ep = () => seAll().find((x) => x.id === id);
    switch (act) {
      case 'cat-edit': seEditCat = true; endpointsTab(true); break;
      case 'cat-cancel': seEditCat = false; endpointsTab(true); break;
      case 'cat-save': saveCategory(b); break;
      case 'g-add': groupEditor(null); break;
      case 'g-edit': groupEditor(seGroup(id)); break;
      case 'g-del': deleteGroup(seGroup(id)); break;
      case 'g-move': seMove('g', id, dir); break;
      case 'e-add': endpointEditor(null, b.dataset.g); break;
      case 'e-edit': { const e = ep(); if (e) endpointEditor(e, e.groupId); break; }
      case 'e-del': { const e = ep(); if (e) deleteEndpoint(e); break; }
      case 'e-move': { const e = ep(); if (e) seMove('e', id, dir, e.groupId); break; }
      case 'e-test': { const e = ep(); if (e) busyBtn(b, () => testLogin(e)); break; }
      case 'e-measure': {
        const e = ep(); if (!e) break;
        busyBtn(b, async () => {
          try { const bytes = await seMeasure(e); NX.toast(`${e.name} holds ${seFmt(bytes)} in ${se.category}.`); await seChanged(); }
          catch (err) { NX.toast(`Couldn’t measure ${e.name}: ${err.message}`, { err: true }); }
        });
        break;
      }
      default: break;
    }
  }
  async function testLogin(ep, out) {
    const say = (m, bad) => { if (out) { out.textContent = m; out.style.color = bad ? '#ff8a8e' : 'var(--ok)'; } else NX.toast(m, { err: !!bad }); };
    say('Connecting…');
    try { await window.CloudGate.probe(ep); say(`Connected. The login for ${ep.name} works.`); }
    catch (e) { say(`Couldn’t connect: ${e.message}`, true); }
  }
  function groupEditor(g) {
    const b = NX.h(`<div class="stack"><div class="field-row">
      <div class="field"><label>Name</label><input class="input" data-n maxlength="60" value="${esc(g?.name || `Group ${(se.groups || []).length + 1}`)}"></div>
      <div class="field"><label>Capacity (GB)</label><input class="input" data-c type="number" min="1" step="any" value="${g ? esc(g.capacity_gb) : 100}"></div></div>
      <p class="hint">When this group runs out of room, uploads move to the next group. Its endpoints are mirrors of one storage, so it is counted once.</p><p class="err"></p></div>`);
    NX.modal({
      title: g ? 'Edit group' : 'New group', body: b,
      foot: [{ label: 'Cancel' }, {
        label: 'Save group', cls: 'btn-primary', icon: 'fa-check', onClick: async () => {
          const name = b.querySelector('[data-n]').value.trim(), gb = Number(b.querySelector('[data-c]').value);
          const err = b.querySelector('.err');
          if (!name) { err.textContent = 'Give the group a name.'; return false; }
          if (!(gb > 0)) { err.textContent = 'Capacity must be more than 0 GB.'; return false; }
          try { await seRpc('storage_admin_save_group', { p_id: g?.id || null, p_name: name, p_capacity_gb: gb }); }
          catch (e) { err.textContent = e.message; return false; }
          NX.toast('Group saved.'); await seChanged();
        },
      }],
    });
  }
  function endpointEditor(ep, groupId) {
    const g = seGroup(groupId);
    const b = NX.h(`<div class="stack"><div class="field-row">
      <div class="field"><label>Name</label><input class="input" data-n maxlength="60" placeholder="wasmer" value="${esc(ep?.name || '')}"></div>
      <div class="field"><label>Address</label><input class="input mono" data-u spellcheck="false" autocomplete="off" placeholder="https://alexd-us1-s3.wasmer.app" value="${esc(ep?.base_url || '')}"></div></div>
      <div class="field-row"><div class="field"><label>Username</label><input class="input mono" data-user autocomplete="off" spellcheck="false" value="${esc(ep?.username || '')}"></div>
      <div class="field"><label>Password</label><input class="input mono" data-p type="password" autocomplete="new-password" placeholder="${ep ? 'Leave blank to keep the current password' : 'Required'}"></div></div>
      <p class="hint">An endpoint is one way into its group’s storage, with its own login. A second endpoint in the same group is a mirror, so it adds no extra space.</p>
      <p class="err"></p><p class="hint" data-res></p></div>`);
    const form = () => ({
      name: b.querySelector('[data-n]').value.trim() || 'endpoint',
      base_url: b.querySelector('[data-u]').value.trim().replace(/\/+$/, ''),
      username: b.querySelector('[data-user]').value.trim(),
      password: b.querySelector('[data-p]').value || ep?.password || '',
      id: ep?.id || null,
    });
    const testBtn = NX.h('<button type="button" class="btn btn-ghost btn-sm"><i class="fa-solid fa-plug"></i>Test login</button>');
    testBtn.onclick = () => busyBtn(testBtn, () => testLogin(form(), b.querySelector('[data-res]')));
    NX.modal({
      title: ep ? 'Edit endpoint' : 'New endpoint', sub: g ? `in ${esc(g.name)}` : '', wide: true, body: b,
      foot: [{ left: testBtn }, { label: 'Cancel' }, {
        label: 'Save endpoint', cls: 'btn-primary', icon: 'fa-check', onClick: async () => {
          const f = form(), err = b.querySelector('.err');
          if (!/^https?:\/\/[^/]+/.test(f.base_url)) { err.textContent = 'The address must start with https://'; return false; }
          if (!f.username) { err.textContent = 'Enter the username for this endpoint.'; return false; }
          if (!f.password) { err.textContent = 'Enter the password for this endpoint.'; return false; }
          let id;
          try {
            id = await seRpc('storage_admin_save_endpoint', { p_id: ep?.id || null, p_group: groupId, p_name: f.name, p_base_url: f.base_url, p_username: f.username, p_password: b.querySelector('[data-p]').value });
          } catch (e) { err.textContent = e.message; return false; }
          // Read what this group's storage already holds, so it starts from the real number.
          let note = 'Endpoint saved.', bad = false;
          try {
            await window.CloudGate?.refresh?.();
            const bytes = await seMeasure({ name: f.name, base_url: f.base_url, username: f.username, password: f.password, id: id || ep?.id });
            note = `Endpoint saved. The group already holds ${seFmt(bytes)}.`;
          } catch (e) { bad = true; note = `Endpoint saved, but it couldn’t be measured yet: ${e.message}`; }
          NX.toast(note, { err: bad });
          await seChanged();
        },
      }],
    });
  }
  async function deleteGroup(g) {
    const n = (g.endpoints || []).length;
    if (!await NX.confirm({ title: `Delete “${g.name}”${n ? ` and its ${fmt.plural(n, 'endpoint')}` : ''}?`, body: 'Files already stored there stay where they are. NexChat just stops using this group for new uploads.', danger: true })) return;
    try { await seRpc('storage_admin_delete_group', { p_id: g.id }); } catch (e) { return NX.toast(e.message, { err: true }); }
    NX.toast('Group deleted.'); await seChanged();
  }
  async function deleteEndpoint(e) {
    if (!await NX.confirm({ title: `Remove the endpoint “${e.name}”?`, body: 'Files it holds stay where they are. NexChat will look for them on the other endpoints.', danger: true, ok: 'Remove' })) return;
    try { await seRpc('storage_admin_delete_endpoint', { p_id: e.id }); } catch (err) { return NX.toast(err.message, { err: true }); }
    NX.toast('Endpoint removed.'); await seChanged();
  }
  async function seMove(kind, id, dir, groupId) {
    const list = kind === 'g' ? se.groups : (seGroup(groupId)?.endpoints || []);
    const i = list.findIndex((x) => x.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const ids = list.map((x) => x.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { await seRpc(kind === 'g' ? 'storage_admin_reorder_groups' : 'storage_admin_reorder_endpoints', { p_ids: ids }); }
    catch (e) { return NX.toast(e.message, { err: true }); }
    await seChanged();
  }
  async function saveCategory(btn) {
    const name = body.querySelector('[data-cat]').value.trim().toLowerCase();
    const cdn = body.querySelector('[data-cdn]').value.trim();
    if (!CAT_RE.test(name)) return NX.toast('Use lowercase letters, numbers, - or _ (up to 63 characters).', { err: true });
    if (se.configured && name !== se.category && !await NX.confirm({ title: 'Change the category?', body: `Only new uploads go to “${name}”. Files already stored under “${se.category}” will not be listed in NexChat any more.`, ok: 'Change category', danger: true })) return;
    await busyBtn(btn, async () => {
      try { await seRpc('storage_admin_set_category', { p_category: name, p_cdn: cdn || null }); }
      catch (e) { return NX.toast(e.message, { err: true }); }
      seEditCat = false;
      await window.CloudGate?.refresh?.();
      // Measurements were taken against the old category; each group is measured once.
      let failed = 0;
      for (const g of se.groups || []) { const ep = (g.endpoints || [])[0]; if (!ep) continue; try { await seMeasure(ep); } catch { failed++; } }
      NX.toast(failed ? `Category saved. ${fmt.plural(failed, 'endpoint')} couldn’t be measured; try Measure on each.` : `Category set to ${name}.`, { err: failed > 0 });
      await seChanged();
    });
  }

  NX.views.admin = { enter, update, leave };
})();
