(function () {
  const $ = (id) => document.getElementById(id);
  let me = null, users = [];

  document.querySelectorAll('.set-nav button[data-tab]').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.set-nav button[data-tab]').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
      if (b.dataset.tab === 'users') loadUsers();
      if (b.dataset.tab === 'appeals') loadAppeals();
      if (b.dataset.tab === 'announce') loadAnnouncements();
      if (b.dataset.tab === 'overview') loadOverview();
      if (b.dataset.tab === 'nitro') loadRequests();
      if (b.dataset.tab === 'servers') loadServers();
      if (b.dataset.tab === 'roles') loadRoles();
      if (b.dataset.tab === 'audit') loadAudit();
      if (b.dataset.tab === 'owner') loadOwner();
      document.querySelector('.set-main')?.scrollTo({ top: 0 });
    };
  });

  async function loadRequests() {
    const { data, error } = await window.db.from('nitro_requests')
      .select('*, profiles!user_id(username,display_name,avatar_url,accent_color,is_nitro,banner_gif_url,theme)')
      .order('created_at', { ascending: false });
    if (error) return UI.toast(error.message, true);

    const pending = (data || []).filter((r) => r.status === 'pending');
    $('pendCount').innerHTML = pending.length ? `<span class="badge badge-admin" style="margin-left:auto;">${pending.length}</span>` : '';

    $('reqRows').innerHTML = (data || []).map((r) => {
      const p = r.profiles || { username: 'unknown' };
      const tag = r.status === 'pending' ? '' :
        `<span class="badge ${r.status === 'approved' ? 'badge-admin' : 'badge-owner'}">${r.status}</span>`;
      return `<div class="lrow" data-id="${r.id}" data-u="${r.user_id}">
        ${UI.avatar(p, 32, { presence: true })}
        <div class="lmain">
          <b>${UI.esc(p.display_name || p.username)} ${tag}</b>
          <small>${UI.esc(r.message || 'No message')} · ${new Date(r.created_at).toLocaleDateString()}</small>
        </div>
        ${r.status === 'pending' ? `<div class="lacts">
          <button class="btn btn-quiet btn-sm r-no">Decline</button>
          <button class="btn btn-primary btn-sm r-yes">Approve</button>
        </div>` : ''}
      </div>`;
    }).join('') || '<div class="empty"><div class="ico"><i class="fa-solid fa-inbox"></i></div><h3>Nothing waiting</h3><p>New Nitro requests land here.</p></div>';

    $('reqRows').querySelectorAll('.lrow').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.r-yes')?.addEventListener('click', async () => {
        const { error } = await window.db.from('nitro_requests')
          .update({ status: 'approved', reviewed_by: me.id, reviewed_at: new Date().toISOString() }).eq('id', id);
        UI.toast(error ? error.message : 'Nitro granted.', !!error);
        loadRequests();
      });
      row.querySelector('.r-no')?.addEventListener('click', async () => {
        const note = prompt('Reason (optional)') || null;
        const { error } = await window.db.from('nitro_requests')
          .update({ status: 'denied', reviewed_by: me.id, reviewed_at: new Date().toISOString(), review_note: note }).eq('id', id);
        UI.toast(error ? error.message : 'Request declined.', !!error);
        loadRequests();
      });
    });
  }

  async function loadAppeals({ quiet = false } = {}) {
    const { data, error } = await window.db.from('ban_appeals')
      .select('*, profiles!user_id(username,display_name,avatar_url,accent_color,is_banned)')
      .order('created_at', { ascending: false });

    if (error) {
      // The appeals table arrives with a migration that may not have been run
      // yet. Say so in the pane rather than nagging from whichever tab is open.
      const missing = error.code === 'PGRST205' || /schema cache|does not exist/i.test(error.message || '');
      $('appealCount').innerHTML = '';
      if (missing) {
        $('appealRows').innerHTML = `<div class="empty"><div class="ico"><i class="fa-solid fa-database"></i></div>
          <h3>Appeals aren't set up yet</h3>
          <p>Run <code>nexchat_patch6.sql</code> in the Supabase SQL editor to create the appeals table.</p></div>`;
        return;
      }
      $('appealRows').innerHTML = `<div class="empty"><div class="ico"><i class="fa-solid fa-triangle-exclamation"></i></div>
        <h3>Couldn't load appeals</h3><p>${UI.esc(error.message || 'Unknown error')}</p></div>`;
      if (!quiet) UI.toast(error.message, true);
      return;
    }

    const pending = (data || []).filter((a) => a.status === 'pending');
    $('appealCount').innerHTML = pending.length
      ? `<span class="badge badge-admin" style="margin-left:auto;">${pending.length}</span>` : '';

    $('appealRows').innerHTML = (data || []).map((a) => {
      const p = a.profiles || { username: 'unknown' };
      const tag = a.status === 'pending' ? ''
        : `<span class="badge ${a.status === 'accepted' ? 'badge-admin' : 'badge-owner'}">${a.status}</span>`;
      return `<div class="lrow" data-id="${a.id}" style="align-items:flex-start;">
        ${UI.avatar(p, 32)}
        <div class="lmain">
          <b>${UI.esc(p.display_name || p.username)} ${tag}</b>
          <small>@${UI.esc(p.username)} · ${new Date(a.created_at).toLocaleString()}</small>
          <div class="appeal-msg">${UI.esc(a.message)}</div>
          ${a.review_note ? `<small style="display:block;margin-top:6px;">Note: ${UI.esc(a.review_note)}</small>` : ''}
        </div>
        ${a.status === 'pending' ? `<div class="lacts">
          <button class="btn btn-quiet btn-sm a-no">Decline</button>
          <button class="btn btn-primary btn-sm a-yes">Accept &amp; unban</button>
        </div>` : ''}
      </div>`;
    }).join('') || '<div class="empty"><div class="ico"><i class="fa-solid fa-gavel"></i></div><h3>No appeals</h3><p>Appeals from banned accounts land here.</p></div>';

    $('appealRows').querySelectorAll('.lrow').forEach((row) => {
      const id = row.dataset.id;
      const resolve = async (accept, note) => {
        const { error } = await window.db.rpc('resolve_ban_appeal',
          { p_appeal_id: id, p_accept: accept, p_note: note });
        if (error) return UI.toast(error.message, true);
        UI.toast(accept ? 'Appeal accepted — account restored.' : 'Appeal declined.');
        // The ban state just changed underneath the cached user list.
        users = [];
        loadAppeals();
      };
      row.querySelector('.a-yes')?.addEventListener('click', () => resolve(true, null));
      row.querySelector('.a-no')?.addEventListener('click', () => resolve(false, prompt('Reason (optional)') || null));
    });
  }

  async function loadUsers() {
    if (!users.length) {
      const { data, error } = await window.db.from('profiles').select('*').order('created_at', { ascending: false }).limit(1000);
      if (error) return UI.toast(error.message, true);
      users = data || [];
    }
    paintUsers();
  }

  /* ---- ranks ----
     owner 3 > sudo admin 2 > admin 1 > user 0. Every action on someone needs
     a strictly higher rank; the database enforces it, these only decide which
     buttons to show. */
  const R = (u) => UI.rank(u);
  const myRank = () => R(me);
  const canAct = (u) => u.id !== me.id && myRank() > R(u);

  /* ---- permissions (Owner tab) ----
     What sudo admins and admins may do lives in platform_role_perms; the
     owner always can. These mirror the database defaults so the panel still
     behaves if roles_v2.sql hasn't been run yet. */
  const PERMS = [
    { k: 'ban_users', ic: 'fa-ban', t: 'Ban & unban accounts', d: 'Lock people out, or let them back in.' },
    { k: 'manage_roles', ic: 'fa-user-shield', t: 'Manage staff roles', d: 'Give or remove roles below their own.' },
    { k: 'view_all_servers', ic: 'fa-eye', t: 'See every server', d: 'Open any server, its members and messages without joining.' },
    { k: 'post_anywhere', ic: 'fa-paper-plane', t: 'Post in any server', d: 'Send messages in servers they haven\u2019t joined.' },
    { k: 'delete_messages', ic: 'fa-comment-slash', t: 'Delete any message', d: 'Remove messages in any server.' },
    { k: 'reset_passwords', ic: 'fa-key', t: 'Set user passwords', d: 'Replace a password and sign the person out. Never for staff at or above them.' },
    { k: 'delete_users', ic: 'fa-user-xmark', t: 'Delete accounts', d: 'Permanently remove an account and its data.' },
    { k: 'post_announcements', ic: 'fa-bullhorn', t: 'Post announcements', d: 'Post, pin and delete announcements for everyone.' },
    { k: 'review_appeals', ic: 'fa-gavel', t: 'Review ban appeals', d: 'Accept or decline appeals from banned accounts.' },
    { k: 'view_audit', ic: 'fa-clock-rotate-left', t: 'View the audit log', d: 'See every staff action.' },
  ];
  const DEFAULT_PERMS = {
    sudo: Object.fromEntries(PERMS.map((p) => [p.k, true])),
    admin: Object.fromEntries(PERMS.map((p) => [p.k, ['ban_users', 'post_announcements', 'review_appeals'].includes(p.k)])),
  };
  let perms = JSON.parse(JSON.stringify(DEFAULT_PERMS)), permsLive = false;
  async function loadPerms() {
    const { data, error } = await window.db.from('platform_role_perms').select('role,perm,allowed');
    permsLive = !error;
    perms = JSON.parse(JSON.stringify(DEFAULT_PERMS));
    (data || []).forEach((r) => { if (perms[r.role]) perms[r.role][r.perm] = r.allowed; });
  }
  const roleKey = (r) => ['', 'admin', 'sudo'][r];
  const can = (k) => myRank() >= 3 || (myRank() > 0 && !!perms[roleKey(myRank())]?.[k]);
  const canAuth = () => can('view_all_servers') || can('reset_passwords') || can('delete_users');
  const ROLE_KEYS = ['user', 'admin', 'sudo'];

  // The rpcs raise plain-language exceptions; show them without the prefix.
  function adminErr(error, fallback) {
    const m = error?.message || '';
    if (error?.code === 'PGRST202' || /could not find the function|schema cache/i.test(m)) {
      return 'Run supabase/roles_and_powers.sql in the Supabase SQL editor first.';
    }
    return m.replace(/^.*?exception:\s*/i, '') || fallback || 'That didn’t work.';
  }

  let uFilter = 'all';
  const FILTERS = { all: () => true, admin: (u) => R(u) > 0, nitro: (u) => u.is_nitro, banned: (u) => u.is_banned };
  document.querySelectorAll('#uFilter button').forEach((b) => {
    b.onclick = () => {
      uFilter = b.dataset.f;
      document.querySelectorAll('#uFilter button').forEach((x) => x.classList.toggle('on', x === b));
      paintUsers();
    };
  });

  function paintUsers() {
    paintPowers();
    const q = $('uSearch').value.trim().toLowerCase();
    document.querySelectorAll('#uFilter button').forEach((b) => { b.querySelector('span').textContent = users.filter(FILTERS[b.dataset.f]).length; });
    const rows = users.filter(FILTERS[uFilter])
      .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q))
      .sort((a, b) => R(b) - R(a));
    $('userRows').innerHTML = rows.map((u) => `
      <div class="lrow u-row" data-u="${u.id}" tabindex="0">
        ${UI.avatar(u, 32, { presence: true })}
        <div class="lmain">
          <b>${UI.esc(u.display_name || u.username)}
            ${u.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i> Nitro</span>' : ''}
            ${UI.roleBadge(u)}
            ${u.is_banned ? '<span class="badge badge-banned">Banned</span>' : ''}
          </b>
          <small>@${UI.esc(u.username)} · joined ${new Date(u.created_at).toLocaleDateString()}</small>
        </div>
        ${u.id === me.id ? `<div class="lacts"><span class="badge badge-owner">You</span>${rankUpButton()}</div>` : `
        <div class="lacts">
          ${canAct(u) && can('ban_users') ? `<button class="btn btn-quiet btn-sm u-ban" style="${u.is_banned ? '' : 'color:#FF8085;'}">${u.is_banned ? 'Unban' : 'Ban'}</button>` : (canAct(u) ? '' : '<span class="u-lock" title="Ranked the same as or above you"><i class="fa-solid fa-lock"></i></span>')}
          <button class="btn btn-ghost btn-sm u-open">${actionsOn(u) ? 'Manage' : 'View'} <i class="fa-solid fa-chevron-right"></i></button>
        </div>`}
      </div>`).join('') || '<div class="empty"><p>No one matches that.</p></div>';

    $('userRows').querySelectorAll('.u-row').forEach((row) => {
      const u = users.find((x) => x.id === row.dataset.u);
      row.querySelector('.u-ban')?.addEventListener('click', (e) => { e.stopPropagation(); toggleBan(u); });
      row.querySelector('.rr-ask')?.addEventListener('click', (e) => { e.stopPropagation(); requestRankUp(); });
      row.onclick = (e) => { if (!e.target.closest('.u-ban, .rr-ask')) openUser(u); };
      row.onkeydown = (e) => { if (e.key === 'Enter') openUser(u); };
    });
  }
  $('uSearch').oninput = paintUsers;

  async function toggleBan(u, after) {
    let reason = null;
    if (!u.is_banned) {
      if (!await UI.confirmDialog('Ban account', `${u.username} will be locked out of NexChat entirely.`, true, 'Ban account')) return;
      reason = prompt('Reason (optional)') || null;
    }
    const { error } = await window.db.rpc('set_user_ban', { p_user_id: u.id, p_banned: !u.is_banned, p_reason: reason });
    if (error) return UI.toast(adminErr(error), true);
    u.is_banned = !u.is_banned; u.ban_reason = reason;
    UI.toast(u.is_banned ? 'Account banned.' : 'Account restored.');
    paintUsers(); after?.();
  }

  /* ---- user drawer ---- */
  function sheet(html) {
    document.querySelector('.adm-panel')?.remove();
    const ov = document.createElement('div');
    ov.className = 'adm-panel';
    ov.innerHTML = `<aside class="adm-sheet" role="dialog">${html}</aside>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('in'));
    const close = () => { ov.classList.remove('in'); setTimeout(() => ov.remove(), 260); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.onclick = (e) => { if (e.target === ov || e.target.closest('[data-x]')) close(); };
    return { el: ov.querySelector('.adm-sheet'), close };
  }

  function openUser(u) {
    const banner = u.banner_url ? `style="background-image:url('${UI.esc(u.banner_url)}')"` : `style="background:linear-gradient(120deg, ${UI.esc(u.accent_color || '#7C6CFF')}, transparent)"`;
    // Only roles you may hand out are offered; nobody sees a way to go above their own rank.
    const roleOpts = ROLE_KEYS.map((k, r) => (r < myRank() ? `<option value="${k}" ${R(u) === r ? 'selected' : ''}>${['User', 'Admin', 'Sudo Admin'][r]}</option>` : '')).join('');
    const canRole = canAct(u) && can('manage_roles');
    const { el, close } = sheet(`
      <div class="us-banner" ${banner}><button class="x-btn" data-x><i class="fa-solid fa-xmark"></i></button></div>
      <div class="us-head">
        ${UI.avatar(u, 72, { presence: true })}
        <div><h3>${UI.esc(u.display_name || u.username)}</h3><small>@${UI.esc(u.username)}</small>
          <div class="us-badges">${UI.roleBadge(u)}${u.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i> Nitro</span>' : ''}${u.is_banned ? '<span class="badge badge-banned">Banned</span>' : ''}</div></div>
      </div>
      <div class="us-body">
        <div class="us-facts">
          <div><span>Username</span><b class="mono">${UI.esc(u.username)}</b></div>
          <div><span>Joined</span><b>${new Date(u.created_at).toLocaleDateString([], { dateStyle: 'medium' })}</b></div>
          <div><span>Last sign-in</span><b id="usLast">${canAuth() ? '…' : '—'}</b></div>
          <div><span>Active sessions</span><b id="usSess">${canAuth() ? '…' : '—'}</b></div>
          <div class="wide"><span>User ID</span><b class="mono sel">${u.id}</b></div>
          ${u.is_banned && u.ban_reason ? `<div class="wide"><span>Ban reason</span><b>${UI.esc(u.ban_reason)}</b></div>` : ''}
        </div>

        ${can('view_all_servers') ? `<h4 class="us-h"><i class="fa-solid fa-server"></i> Servers <span id="usSrvN"></span></h4><div id="usSrv" class="us-srv"><div class="skel" style="height:52px;border-radius:14px"></div></div>` : ''}

        ${u.id === me.id ? (rrLive && nextRole() ? `<h4 class="us-h"><i class="fa-solid fa-arrow-up"></i> Your rank</h4><div class="us-actions"><div class="us-act"><div><b>${UI.roleName(me)}</b><small>You can\u2019t raise your own rank, but you can ask for ${ROLE_LABEL[nextRole()]}.</small></div>${rankUpButton()}</div></div>` : '') : `<h4 class="us-h"><i class="fa-solid fa-sliders"></i> Manage</h4>
        <div class="us-actions">
          ${!canAct(u) ? `<div class="us-act locked"><div><b><i class="fa-solid fa-lock"></i> View only</b><small>${UI.esc(u.username)} is ranked the same as or above you, so you can\u2019t ban, reset, delete or change their role.</small></div></div>` : `
          <div class="us-act">
            <div><b>Role</b><small>${canRole ? 'You can give roles below your own.' : 'Only staff allowed to manage roles can change this.'}</small></div>
            ${canRole ? `<select id="usRole" class="input">${roleOpts}</select>` : `<span class="role-txt">${UI.roleName(u) || 'User'}</span>`}
          </div>
          ${can('ban_users') ? `<div class="us-act">
            <div><b>${u.is_banned ? 'Lift ban' : 'Ban account'}</b><small>${u.is_banned ? 'Let them back in.' : 'Locks them out everywhere, instantly.'}</small></div>
            <button class="btn ${u.is_banned ? 'btn-ghost' : 'btn-danger'} btn-sm" id="usBan">${u.is_banned ? 'Unban' : 'Ban'}</button>
          </div>` : ''}
          ${can('reset_passwords') ? `<div class="us-act">
            <div><b>Set a new password</b><small>Their current password can\u2019t be viewed (only a one-way hash is stored). This replaces it and signs them out everywhere.</small></div>
            <button class="btn btn-ghost btn-sm" id="usPw"><i class="fa-solid fa-key"></i> Set password</button>
          </div>` : ''}
          ${can('delete_users') ? `<div class="us-act danger">
            <div><b>Delete account</b><small>Removes the account, their messages, servers they own and their private drive. Can\u2019t be undone.</small></div>
            <button class="btn btn-danger btn-sm" id="usDel"><i class="fa-solid fa-trash"></i> Delete</button>
          </div>` : ''}`}
        </div>`}
      </div>`);

    if (canAuth()) {
      window.db.rpc('admin_user_auth', { p_user_id: u.id }).then(({ data, error }) => {
        const row = Array.isArray(data) ? data[0] : data;
        el.querySelector('#usLast').textContent = error ? '—' : (row?.last_sign_in_at ? UI.timeLabel(row.last_sign_in_at) : 'Never');
        el.querySelector('#usSess').textContent = error ? '—' : String(row?.sessions ?? 0);
      });
    }
    if (can('view_all_servers')) {
      userServers(u).then((list) => {
        const host = el.querySelector('#usSrv');
        el.querySelector('#usSrvN').textContent = list ? `(${list.length})` : '';
        if (!list) { host.innerHTML = '<p class="bsub">Couldn’t load. Run supabase/roles_and_powers.sql.</p>'; return; }
        host.innerHTML = list.map((s) => `<a class="us-srv-row" href="server.html?id=${s.id}">
            <span class="us-srv-ico">${s.icon_url ? `<img ${window.Store ? Store.imgAttr(s.icon_url) : `src="${UI.esc(s.icon_url)}"`} alt="">` : UI.esc(initials(s.name))}</span>
            <span class="us-srv-t"><b>${UI.esc(s.name)}</b><small>${s.owner_id === u.id ? '<i class="fa-solid fa-crown"></i> Owner' : 'Member'} · ${s.members} member${s.members === 1 ? '' : 's'}</small></span>
            <span class="btn btn-quiet btn-sm">Preview <i class="fa-solid fa-arrow-up-right-from-square"></i></span></a>`).join('')
          || '<p class="bsub">Not in any servers.</p>';
      });
    }

    el.querySelector('#usRole')?.addEventListener('change', async (e) => {
      const role = e.target.value;
      const label = ['User', 'Admin', 'Sudo Admin'][ROLE_KEYS.indexOf(role)];
      if (!await UI.confirmDialog('Change role', `Make ${u.username} ${label === 'User' ? 'a regular user' : 'a ' + label}?`, false, 'Change role')) {
        e.target.value = ROLE_KEYS[R(u)]; return;
      }
      const { error } = await window.db.rpc('set_user_role', { p_user_id: u.id, p_role: role });
      if (error) { e.target.value = ROLE_KEYS[R(u)]; return UI.toast(adminErr(error), true); }
      u.platform_role = role === 'user' ? null : role;
      u.is_platform_admin = role !== 'user';
      UI.toast(`${u.username} is now ${label === 'User' ? 'a regular user' : 'a ' + label}.`);
      paintUsers(); openUser(u);
    });
    el.querySelector('#usBan')?.addEventListener('click', () => toggleBan(u, () => openUser(u)));
    el.querySelector('#usPw')?.addEventListener('click', () => setPassword(u));
    el.querySelector('#usDel')?.addEventListener('click', () => deleteUser(u, close));
    el.querySelector('.rr-ask')?.addEventListener('click', () => { close(); requestRankUp(); });
  }

  const initials = (n) => (n || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase();

  async function userServers(u) {
    const { data: mem, error } = await window.db.from('server_members').select('server_id').eq('user_id', u.id);
    if (error) return null;
    const ids = (mem || []).map((m) => m.server_id);
    if (!ids.length) return [];
    const { data: list, error: e2 } = await window.db.from('servers').select('id,name,icon_url,owner_id,server_members(count)').in('id', ids);
    if (e2) return null;
    return (list || []).map((s) => ({ ...s, members: s.server_members?.[0]?.count ?? 0 }))
      .sort((a, b) => (b.owner_id === u.id) - (a.owner_id === u.id) || a.name.localeCompare(b.name));
  }

  function setPassword(u) {
    const gen = () => {
      const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const b = crypto.getRandomValues(new Uint32Array(14));
      return [...b].map((x) => a[x % a.length]).join('');
    };
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" style="max-width:420px;">
      <div class="modal-head"><h3>New password for @${UI.esc(u.username)}</h3></div>
      <div class="modal-body">
        <p class="bsub" style="margin:0">They’ll be signed out on every device and need this password to get back in.</p>
        <div class="pw-row"><input id="npw" class="input mono" type="text" autocomplete="off" spellcheck="false" value="${gen()}" />
          <button class="btn btn-ghost btn-icon" id="npwGen" title="Generate"><i class="fa-solid fa-dice"></i></button>
          <button class="btn btn-ghost btn-icon" id="npwCopy" title="Copy"><i class="fa-regular fa-copy"></i></button></div>
        <p class="err" id="npwErr"></p>
      </div>
      <div class="modal-foot"><button class="btn btn-quiet" data-no>Cancel</button><button class="btn btn-primary" data-yes><i class="fa-solid fa-key"></i> Set password</button></div>
    </div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('#npw');
    ov.querySelector('#npwGen').onclick = () => { inp.value = gen(); };
    ov.querySelector('#npwCopy').onclick = () => navigator.clipboard?.writeText(inp.value).then(() => UI.toast('Copied.'));
    ov.querySelector('[data-no]').onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    ov.querySelector('[data-yes]').onclick = async () => {
      if (inp.value.length < 8) return (ov.querySelector('#npwErr').textContent = 'At least 8 characters.');
      const btn = ov.querySelector('[data-yes]'); btn.disabled = true;
      const { error } = await window.db.rpc('admin_set_password', { p_user_id: u.id, p_password: inp.value });
      btn.disabled = false;
      if (error) return (ov.querySelector('#npwErr').textContent = adminErr(error));
      navigator.clipboard?.writeText(inp.value).catch(() => {});
      ov.remove();
      UI.toast(`Password changed and copied. @${u.username} was signed out everywhere.`);
    };
  }

  function deleteUser(u, closeSheet) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" style="max-width:420px;">
      <div class="modal-head"><h3>Delete @${UI.esc(u.username)}?</h3></div>
      <div class="modal-body">
        <p class="bsub" style="margin:0">This permanently removes the account, everything they posted, the servers they own and their private drive. Type <b class="mono">${UI.esc(u.username)}</b> to confirm.</p>
        <input id="delConfirm" class="input" autocomplete="off" placeholder="${UI.esc(u.username)}" />
        <p class="err" id="delErr"></p>
      </div>
      <div class="modal-foot"><button class="btn btn-quiet" data-no>Cancel</button><button class="btn btn-danger" data-yes disabled><i class="fa-solid fa-trash"></i> Delete forever</button></div>
    </div>`;
    document.body.appendChild(ov);
    const yes = ov.querySelector('[data-yes]');
    ov.querySelector('#delConfirm').oninput = (e) => { yes.disabled = e.target.value !== u.username; };
    ov.querySelector('[data-no]').onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    yes.onclick = async () => {
      yes.disabled = true;
      const { error } = await window.db.rpc('admin_delete_user', { p_user_id: u.id });
      if (error) { yes.disabled = false; return (ov.querySelector('#delErr').textContent = adminErr(error)); }
      // Their drive is encrypted with a key that just got deleted with them;
      // clear the unreadable files out too.
      if (window.CloudGate?.enabled()) window.CloudGate.deleteFolder('vault', u.id).catch(() => {});
      ov.remove(); closeSheet();
      users = users.filter((x) => x.id !== u.id);
      paintUsers();
      UI.toast(`@${u.username} was deleted.`);
    };
  }

  /* ---- every server (owner & sudo) ---- */
  let servers = null, sSort = 'new';
  async function loadServers() {
    if (!can('view_all_servers')) return;
    if (!users.length) await loadUsers();
    $('srvRows').innerHTML = '<div class="skel" style="height:150px;border-radius:20px"></div>'.repeat(6);
    const [{ data, error }, { data: mine }] = await Promise.all([
      window.db.from('servers').select('id,name,description,icon_url,banner_url,owner_id,created_at,server_members(count)').order('created_at', { ascending: false }).limit(2000),
      window.db.from('server_members').select('server_id').eq('user_id', me.id),
    ]);
    if (error) { $('srvRows').innerHTML = `<div class="empty"><p>${UI.esc(adminErr(error))}</p></div>`; return; }
    const joined = new Set((mine || []).map((m) => m.server_id));
    servers = (data || []).map((s) => ({ ...s, members: s.server_members?.[0]?.count ?? 0, joined: joined.has(s.id) }));
    paintServers();
  }
  document.querySelectorAll('#sSort button').forEach((b) => {
    b.onclick = () => {
      sSort = b.dataset.s;
      document.querySelectorAll('#sSort button').forEach((x) => x.classList.toggle('on', x === b));
      paintServers();
    };
  });
  $('sSearch').oninput = () => paintServers();

  function paintServers() {
    if (!servers) return;
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    const q = $('sSearch').value.trim().toLowerCase();
    const list = servers.filter((s) => {
      const o = byId[s.owner_id];
      return !q || s.name.toLowerCase().includes(q) || (o && (o.username.toLowerCase().includes(q) || (o.display_name || '').toLowerCase().includes(q)));
    }).sort((a, b) => sSort === 'members' ? b.members - a.members : sSort === 'name' ? a.name.localeCompare(b.name) : new Date(b.created_at) - new Date(a.created_at));
    $('srvRows').innerHTML = list.map((s, i) => {
      const o = byId[s.owner_id];
      const banner = s.banner_url ? `style="background-image:url('${UI.esc(s.banner_url)}')"` : `style="--h:${(i * 137.5) % 360}"`;
      return `<article class="srv-card${s.banner_url ? ' has-img' : ''}" style="--i:${Math.min(i, 12)}">
        <div class="srv-ban" ${banner}></div>
        <div class="srv-ico">${s.icon_url ? `<img ${window.Store ? Store.imgAttr(s.icon_url) : `src="${UI.esc(s.icon_url)}"`} alt="">` : UI.esc(initials(s.name))}</div>
        <div class="srv-body">
          <b>${UI.esc(s.name)}</b>
          <small>${UI.esc(s.description || 'No description.')}</small>
          <div class="srv-meta">
            <span title="Owner">${o ? `${UI.avatar(o, 18)} @${UI.esc(o.username)}` : '<i class="fa-solid fa-user-slash"></i> unknown'}</span>
            <span><i class="fa-solid fa-users"></i> ${s.members}</span>
            <span><i class="fa-regular fa-calendar"></i> ${new Date(s.created_at).toLocaleDateString()}</span>
          </div>
          <div class="srv-acts">
            <span class="pill ${s.joined ? 'in' : ''}">${s.joined ? 'Member' : 'Not joined'}</span>
            <button class="btn btn-quiet btn-sm s-mem" data-id="${s.id}"><i class="fa-solid fa-users"></i> Members</button>
            <a class="btn btn-primary btn-sm" href="server.html?id=${s.id}"><i class="fa-solid fa-eye"></i> Open</a>
          </div>
        </div>
      </article>`;
    }).join('') || '<div class="empty"><p>No servers match that.</p></div>';
    $('srvRows').querySelectorAll('.s-mem').forEach((b) => { b.onclick = () => serverMembers(servers.find((s) => s.id === b.dataset.id)); });
  }

  async function serverMembers(s) {
    const { el } = sheet(`<header class="adm-sheet-h"><div><b>${UI.esc(s.name)}</b><small>${s.members} member${s.members === 1 ? '' : 's'}</small></div>
      <button class="x-btn" data-x><i class="fa-solid fa-xmark"></i></button></header><div class="us-body" id="smList"><div class="skel" style="height:48px;border-radius:12px"></div></div>`);
    const { data, error } = await window.db.from('server_members').select('user_id').eq('server_id', s.id);
    const host = el.querySelector('#smList');
    if (error) { host.innerHTML = `<p class="bsub">${UI.esc(adminErr(error))}</p>`; return; }
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    host.innerHTML = (data || []).map((m) => byId[m.user_id]).filter(Boolean)
      .sort((a, b) => (b.id === s.owner_id) - (a.id === s.owner_id))
      .map((u) => `<div class="lrow u-row" data-u="${u.id}">${UI.avatar(u, 30, { presence: true })}
        <div class="lmain"><b>${UI.esc(u.display_name || u.username)} ${u.id === s.owner_id ? '<span class="badge badge-nitro"><i class="fa-solid fa-crown"></i> Owner</span>' : ''} ${UI.roleBadge(u)}</b><small>@${UI.esc(u.username)}</small></div>
        <i class="fa-solid fa-chevron-right" style="color:var(--txt-3)"></i></div>`).join('') || '<p class="bsub">No members.</p>';
    host.querySelectorAll('.u-row').forEach((row) => { row.onclick = () => openUser(byId[row.dataset.u]); });
  }

  /* ---- tabs that depend on permissions ---- */
  function applyPermTabs() {
    document.querySelectorAll('.set-nav [data-perm]').forEach((b) => b.classList.toggle('hidden', !can(b.dataset.perm)));
    document.querySelectorAll('.set-nav [data-owner]').forEach((b) => b.classList.toggle('hidden', myRank() < 3));
  }

  /* ---- admin roles ---- */
  const TIERS = [
    { r: 3, name: 'Owner', ic: 'fa-crown', blurb: 'Every permission, always. There is only one.' },
    { r: 2, name: 'Sudo Admins', ic: 'fa-user-shield', blurb: 'Act on admins and users. Cannot touch the owner.' },
    { r: 1, name: 'Admins', ic: 'fa-shield-halved', blurb: 'Act on regular users only.' },
  ];
  async function loadRoles() {
    if (!users.length) await loadUsers();
    await loadRankRequests();
    paintRankBox();
    $('addStaff').classList.toggle('hidden', !can('manage_roles'));
    $('addStaff').onclick = addStaff;
    $('tiers').innerHTML = TIERS.map((t) => {
      const list = users.filter((u) => R(u) === t.r);
      return `<div class="tier r${t.r}">
        <div class="tier-h"><span class="tier-ico"><i class="fa-solid ${t.ic}"></i></span><div><b>${t.name}</b><small>${t.blurb}</small></div><em>${list.length}</em></div>
        <div class="tier-list">${list.map((u) => `<div class="tier-row" data-u="${u.id}">
            ${UI.avatar(u, 32, { presence: true })}
            <div class="lmain"><b>${UI.esc(u.display_name || u.username)}${u.id === me.id ? ' <span class="badge badge-owner">You</span>' : ''}</b><small>@${UI.esc(u.username)}</small></div>
            ${canAct(u) && can('manage_roles') ? `<select class="input tier-sel" aria-label="Role">${ROLE_KEYS.map((k, r) => `<option value="${k}" ${R(u) === r ? 'selected' : ''} ${r >= myRank() ? 'disabled' : ''}>${['User', 'Admin', 'Sudo Admin'][r]}</option>`).join('')}</select>`
              : `<span class="u-lock"${canAct(u) ? '' : ' title="Ranked the same as or above you"'}><i class="fa-solid fa-lock"></i></span>`}
            <button class="drv-ib tier-open" title="Open"><i class="fa-solid fa-chevron-right"></i></button>
          </div>`).join('') || `<p class="tier-empty">No ${t.name.toLowerCase()} yet.</p>`}</div>
      </div>`;
    }).join('');
    $('tiers').querySelectorAll('.tier-row').forEach((row) => {
      const u = users.find((x) => x.id === row.dataset.u);
      row.querySelector('.tier-open').onclick = () => openUser(u);
      row.querySelector('.tier-sel')?.addEventListener('change', async (e) => {
        const ok = await changeRole(u, e.target.value);
        if (!ok) e.target.value = ROLE_KEYS[R(u)];
      });
    });
    paintMatrix($('roleMatrix'), false);
    $('matrixNote').textContent = myRank() >= 3 ? 'Change these in the Owner tab.' : 'Set by the owner.';
  }

  async function changeRole(u, role) {
    const label = ['User', 'Admin', 'Sudo Admin'][ROLE_KEYS.indexOf(role)];
    if (!await UI.confirmDialog('Change role', `Make ${u.username} ${label === 'User' ? 'a regular user' : 'a ' + label}?`, false, 'Change role')) return false;
    const { error } = await window.db.rpc('set_user_role', { p_user_id: u.id, p_role: role });
    if (error) { UI.toast(adminErr(error), true); return false; }
    u.platform_role = role === 'user' ? null : role;
    u.is_platform_admin = role !== 'user';
    UI.toast(`${u.username} is now ${label === 'User' ? 'a regular user' : 'a ' + label}.`);
    paintUsers();
    if (!document.querySelector('[data-pane="roles"]').classList.contains('hidden')) loadRoles();
    return true;
  }

  function addStaff() {
    const opts = ROLE_KEYS.slice(1).map((k, i) => ({ k, r: i + 1 })).filter((o) => o.r < myRank());
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" style="max-width:460px;">
      <div class="modal-head"><h3>Add staff</h3></div>
      <div class="modal-body">
        <label class="search-pill"><i class="fa-solid fa-magnifying-glass"></i><input id="asQ" placeholder="Search by name or username" autocomplete="off" /></label>
        <div class="as-list" id="asList"></div>
        <div class="field"><label for="asRole">Role</label><select id="asRole" class="input">${opts.map((o) => `<option value="${o.k}">${['', 'Admin', 'Sudo Admin'][o.r]}</option>`).join('')}</select></div>
        <p class="err" id="asErr"></p>
      </div>
      <div class="modal-foot"><button class="btn btn-quiet" data-no>Cancel</button><button class="btn btn-primary" data-yes disabled><i class="fa-solid fa-user-plus"></i> Add</button></div>
    </div>`;
    document.body.appendChild(ov);
    let pick = null;
    const yes = ov.querySelector('[data-yes]');
    const paint = () => {
      const q = ov.querySelector('#asQ').value.trim().toLowerCase();
      const list = users.filter((u) => !R(u) && u.id !== me.id && (!q || u.username.toLowerCase().includes(q) || (u.display_name || '').toLowerCase().includes(q))).slice(0, 8);
      ov.querySelector('#asList').innerHTML = list.map((u) => `<button class="as-row${pick?.id === u.id ? ' on' : ''}" data-u="${u.id}">${UI.avatar(u, 28)}<span><b>${UI.esc(u.display_name || u.username)}</b><small>@${UI.esc(u.username)}${u.is_banned ? ' · banned' : ''}</small></span><i class="fa-solid fa-check"></i></button>`).join('')
        || '<p class="bsub" style="margin:6px 2px">No regular users match.</p>';
      ov.querySelectorAll('.as-row').forEach((b) => { b.onclick = () => { pick = users.find((u) => u.id === b.dataset.u); yes.disabled = false; paint(); }; });
    };
    ov.querySelector('#asQ').oninput = paint;
    paint();
    ov.querySelector('#asQ').focus();
    ov.querySelector('[data-no]').onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    yes.onclick = async () => {
      yes.disabled = true;
      const role = ov.querySelector('#asRole').value;
      const { error } = await window.db.rpc('set_user_role', { p_user_id: pick.id, p_role: role });
      if (error) { yes.disabled = false; return (ov.querySelector('#asErr').textContent = adminErr(error)); }
      pick.platform_role = role; pick.is_platform_admin = true;
      ov.remove();
      UI.toast(`${pick.username} is now ${role === 'sudo' ? 'a Sudo Admin' : 'an Admin'}.`);
      paintUsers(); loadRoles();
    };
  }

  // Read-only (Roles tab) or editable (Owner tab) permission table.
  function paintMatrix(host, editable) {
    host.innerHTML = `<div class="rp ${editable ? 'edit' : ''}">
      <div class="rp-h"><span>Permission</span><span><i class="fa-solid fa-crown"></i> Owner</span><span><i class="fa-solid fa-user-shield"></i> Sudo</span><span><i class="fa-solid fa-shield-halved"></i> Admin</span></div>
      ${PERMS.map((p) => `<div class="rp-row" data-k="${p.k}">
        <span class="rp-t"><i class="fa-solid ${p.ic}"></i><span><b>${p.t}</b><small>${p.d}</small></span></span>
        <span><i class="fa-solid fa-circle-check rp-yes"></i></span>
        ${['sudo', 'admin'].map((role) => editable
          ? `<span><input type="checkbox" class="switch" data-role="${role}" ${perms[role][p.k] ? 'checked' : ''} aria-label="${p.t} for ${role}"></span>`
          : `<span>${perms[role][p.k] ? '<i class="fa-solid fa-circle-check rp-yes"></i>' : '<i class="fa-solid fa-circle-minus rp-no"></i>'}</span>`).join('')}
      </div>`).join('')}
    </div>`;
    if (!editable) return;
    host.querySelectorAll('input.switch').forEach((sw) => {
      sw.onchange = async () => {
        const k = sw.closest('.rp-row').dataset.k, role = sw.dataset.role, on = sw.checked;
        sw.disabled = true;
        const { error } = await window.db.rpc('set_role_perm', { p_role: role, p_perm: k, p_allowed: on });
        sw.disabled = false;
        if (error) { sw.checked = !on; return UI.toast(adminErr(error), true); }
        perms[role][k] = on;
        UI.toast(`${role === 'sudo' ? 'Sudo Admins' : 'Admins'} ${on ? 'can now' : 'can no longer'}: ${PERMS.find((p) => p.k === k).t.toLowerCase()}.`);
      };
    });
  }

  /* ---- owner tab ---- */
  async function loadOwner() {
    if (myRank() < 3) return;
    if (!users.length) await loadUsers();
    await loadPerms();
    const n = (r) => users.filter((u) => R(u) === r).length;
    $('ownerHero').innerHTML = `
      <div class="oh-main">${UI.avatar(me, 54, { presence: true })}<div><b>${UI.esc(me.display_name || me.username)}</b><small><i class="fa-solid fa-crown"></i> Owner of NexChat</small></div></div>
      <div class="oh-stats">
        <button data-goto="roles"><b>${n(2)}</b><small>Sudo Admins</small></button>
        <button data-goto="roles"><b>${n(1)}</b><small>Admins</small></button>
        <button data-goto="users"><b>${users.filter((u) => !R(u)).length}</b><small>Users</small></button>
      </div>`;
    $('ownerHero').querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => document.querySelector(`.set-nav button[data-tab="${b.dataset.goto}"]`)?.click(); });
    if (!permsLive) {
      $('permGrid').innerHTML = '<div class="empty"><div class="ico"><i class="fa-solid fa-database"></i></div><h3>Permissions aren’t set up yet</h3><p>Run <code>supabase/roles_v2.sql</code> in the Supabase SQL editor, then reload.</p></div>';
    } else paintMatrix($('permGrid'), true);
    await loadRankRequests();
    $('ownerRequests').innerHTML = reviewQueue.length ? `<div class="set-block"><div class="bh-row"><h4><i class="fa-solid fa-inbox"></i> Rank-up requests</h4><span class="bsub" style="margin:0">${reviewQueue.length} waiting for you</span></div>${requestsHtml()}</div>` : '';
    wireRequests($('ownerRequests'));
    paintAudit($('ownerAudit'), 8);
  }

  /* ---- audit log ---- */
  const ACTIONS = {
    role: (d) => `changed the role of {t} to <b>${UI.esc({ user: 'User', admin: 'Admin', sudo: 'Sudo Admin' }[d?.role] || d?.role)}</b>`,
    ban: (d) => `banned {t}${d?.reason ? ` <span class="au-q">“${UI.esc(d.reason)}”</span>` : ''}`,
    unban: () => 'unbanned {t}',
    reset_password: () => 'set a new password for {t}',
    delete_user: (d) => `deleted the account <b>@${UI.esc(d?.username || 'unknown')}</b>`,
    permission: (d) => `${d?.allowed ? 'allowed' : 'blocked'} <b>${d?.role === 'sudo' ? 'Sudo Admins' : 'Admins'}</b> to ${UI.esc((PERMS.find((p) => p.k === d?.perm)?.t || d?.perm || '').toLowerCase())}`,
    appeal_accept: () => 'accepted the ban appeal of {t}',
    appeal_decline: () => 'declined the ban appeal of {t}',
    rankup_approve: (d) => `approved {t} for <b>${UI.esc(ROLE_LABEL[d?.role] || d?.role)}</b>`,
    rankup_decline: (d) => `declined the ${UI.esc(ROLE_LABEL[d?.role] || d?.role)} request from {t}`,
  };
  const AU_ICON = { role: 'fa-user-shield', ban: 'fa-ban', unban: 'fa-unlock', reset_password: 'fa-key', delete_user: 'fa-user-xmark', permission: 'fa-sliders', appeal_accept: 'fa-gavel', appeal_decline: 'fa-gavel', rankup_approve: 'fa-arrow-up', rankup_decline: 'fa-arrow-up' };
  let auditFilter = 'all';
  document.querySelectorAll('#auditFilter button').forEach((b) => {
    b.onclick = () => { auditFilter = b.dataset.f; document.querySelectorAll('#auditFilter button').forEach((x) => x.classList.toggle('on', x === b)); loadAudit(); };
  });
  async function loadAudit() { paintAudit($('auditRows'), 200); }
  async function paintAudit(host, limit) {
    if (!users.length) await loadUsers();
    host.innerHTML = '<div class="skel" style="height:56px;border-radius:14px"></div>';
    let q = window.db.from('admin_audit').select('*').order('created_at', { ascending: false }).limit(limit);
    if (host.id === 'auditRows' && auditFilter !== 'all') q = auditFilter === 'ban' ? q.in('action', ['ban', 'unban']) : q.eq('action', auditFilter);
    const { data, error } = await q;
    if (error) { host.innerHTML = `<div class="empty"><p>${/does not exist|schema cache/i.test(error.message || '') ? 'Run supabase/roles_v2.sql to start the audit log.' : UI.esc(error.message)}</p></div>`; return; }
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    const who = (id) => { const u = byId[id]; return u ? `<b>@${UI.esc(u.username)}</b>` : '<b>a deleted account</b>'; };
    host.innerHTML = (data || []).map((a) => {
      const actor = byId[a.actor_id];
      const text = (ACTIONS[a.action] || (() => UI.esc(a.action)))(a.detail || {}).replace('{t}', a.target_id ? who(a.target_id) : '');
      return `<div class="au-row a-${a.action}">
        <span class="au-ico"><i class="fa-solid ${AU_ICON[a.action] || 'fa-circle'}"></i></span>
        ${actor ? UI.avatar(actor, 26) : ''}
        <div class="au-t">${actor ? `<b>@${UI.esc(actor.username)}</b>` : '<b>Someone</b>'} ${text}</div>
        <span class="au-time" title="${new Date(a.created_at).toLocaleString()}">${UI.timeLabel(a.created_at)}</span>
      </div>`;
    }).join('') || '<div class="empty"><p>No staff actions yet.</p></div>';
  }

  /* ---- "what you can do" + rank-up requests ---- */
  const actionsOn = (u) => canAct(u) && ['ban_users', 'manage_roles', 'reset_passwords', 'delete_users'].some(can);
  function paintPowers() {
    const host = $('powers'); if (!host) return;
    const r = myRank();
    const who = r >= 3 ? 'everyone else' : r === 2 ? 'admins and regular users' : 'regular users';
    const list = PERMS.filter((p) => can(p.k)).map((p) => `<span><i class="fa-solid ${p.ic}"></i> ${p.t}</span>`).join('');
    host.innerHTML = `<div class="pw-h">${UI.roleBadge(me)}<b>You can act on ${who}.</b>${r < 3 ? '<small>Anyone at or above your rank is locked.</small>' : ''}${rankUpButton()}</div>
      <div class="pw-list">${list || '<span>No moderation permissions yet.</span>'}</div>`;
    host.querySelector('.rr-ask')?.addEventListener('click', requestRankUp);
  }

  let rrLive = false, myReq = null, reviewQueue = [];
  const nextRole = () => ({ 0: 'admin', 1: 'sudo' })[myRank()] || null;
  const ROLE_LABEL = { admin: 'Admin', sudo: 'Sudo Admin' };
  async function loadRankRequests() {
    const { data, error } = await window.db.from('rank_requests').select('*').order('created_at', { ascending: false }).limit(200);
    rrLive = !error;
    const list = data || [];
    myReq = list.find((r) => r.user_id === me.id && r.status === 'pending') || null;
    reviewQueue = list.filter((r) => r.user_id !== me.id && r.status === 'pending');
    $('rrCount').innerHTML = reviewQueue.length ? `<span class="badge badge-admin" style="margin-left:auto;">${reviewQueue.length}</span>` : '';
  }
  function rankUpButton() {
    if (!rrLive || !nextRole()) return '';
    if (myReq) return `<span class="rr-pending"><i class="fa-regular fa-clock"></i> ${ROLE_LABEL[myReq.role]} requested</span>`;
    return `<button class="btn btn-ghost btn-sm rr-ask"><i class="fa-solid fa-arrow-up"></i> Request ${ROLE_LABEL[nextRole()]}</button>`;
  }
  function requestRankUp() {
    const role = nextRole(); if (!role) return;
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal" style="max-width:440px;">
      <div class="modal-head"><h3>Request ${ROLE_LABEL[role]}</h3></div>
      <div class="modal-body">
        <p class="bsub" style="margin:0">Staff can’t raise their own rank. Your request goes to ${role === 'sudo' ? 'the owner' : 'staff who can grant it'}, who can approve or decline it.</p>
        <div class="field"><label for="rrWhy">Why? (optional)</label><textarea id="rrWhy" rows="3" maxlength="1000" placeholder="What you’d do with it"></textarea></div>
        <p class="err" id="rrErr"></p>
      </div>
      <div class="modal-foot"><button class="btn btn-quiet" data-no>Cancel</button><button class="btn btn-primary" data-yes><i class="fa-solid fa-paper-plane"></i> Send request</button></div></div>`;
    document.body.appendChild(ov);
    ov.querySelector('[data-no]').onclick = () => ov.remove();
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    ov.querySelector('[data-yes]').onclick = async () => {
      const { error } = await window.db.from('rank_requests').insert({ user_id: me.id, role, reason: ov.querySelector('#rrWhy').value.trim() || null });
      if (error) return (ov.querySelector('#rrErr').textContent = /duplicate|unique/i.test(error.message) ? 'You already have a request waiting.' : adminErr(error));
      ov.remove();
      UI.toast('Request sent.');
      await loadRankRequests(); paintUsers(); paintRankBox();
    };
  }
  async function cancelRankUp() {
    const { error } = await window.db.from('rank_requests').update({ status: 'cancelled' }).eq('id', myReq.id);
    if (error) return UI.toast(adminErr(error), true);
    await loadRankRequests(); paintUsers(); paintRankBox();
  }
  async function reviewRankUp(r, approve) {
    const note = approve ? null : (prompt('Reason (optional)') || null);
    const { error } = await window.db.rpc('review_rank_request', { p_id: r.id, p_approve: approve, p_note: note });
    if (error) return UI.toast(adminErr(error), true);
    const u = users.find((x) => x.id === r.user_id);
    if (approve && u) { u.platform_role = r.role; u.is_platform_admin = true; }
    UI.toast(approve ? `${u?.username || 'They'} ${u ? 'is' : 'are'} now ${r.role === 'sudo' ? 'a Sudo Admin' : 'an Admin'}.` : 'Request declined.');
    await loadRankRequests(); paintRankBox(); paintUsers();
    if (!document.querySelector('[data-pane="roles"]').classList.contains('hidden')) loadRoles();
    if (!document.querySelector('[data-pane="owner"]').classList.contains('hidden')) loadOwner();
  }
  function requestsHtml() {
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    return reviewQueue.map((r) => {
      const u = byId[r.user_id] || { username: 'unknown' };
      return `<div class="rr-row" data-id="${r.id}">${UI.avatar(u, 34, { presence: true })}
        <div class="lmain"><b>${UI.esc(u.display_name || u.username)} ${UI.roleBadge(u)} <i class="fa-solid fa-arrow-right" style="color:var(--txt-3);font-size:11px"></i> <span class="badge badge-role ${r.role === 'sudo' ? 'r2' : 'r1'}">${ROLE_LABEL[r.role]}</span></b>
          <small>@${UI.esc(u.username)} · ${UI.timeLabel(r.created_at)}</small>${r.reason ? `<div class="appeal-msg">${UI.esc(r.reason)}</div>` : ''}</div>
        <div class="lacts"><button class="btn btn-quiet btn-sm rr-no">Decline</button><button class="btn btn-primary btn-sm rr-yes">Approve</button></div></div>`;
    }).join('');
  }
  function wireRequests(host) {
    host.querySelectorAll('.rr-row').forEach((row) => {
      const r = reviewQueue.find((x) => x.id === row.dataset.id);
      row.querySelector('.rr-yes').onclick = () => reviewRankUp(r, true);
      row.querySelector('.rr-no').onclick = () => reviewRankUp(r, false);
    });
  }
  function paintRankBox() {
    const host = $('rankBox'); if (!host) return;
    if (!rrLive) { host.innerHTML = ''; return; }
    const mine = nextRole() ? `<div class="set-block rr-mine">
        <div class="bh-row"><h4><i class="fa-solid fa-arrow-up-right-dots"></i> Your rank</h4>${UI.roleBadge(me)}</div>
        ${myReq ? `<p class="bsub" style="margin:0">You asked to become a <b>${ROLE_LABEL[myReq.role]}</b> ${UI.timeLabel(myReq.created_at).toLowerCase()}. ${myReq.role === 'sudo' ? 'The owner' : 'Staff'} will decide.</p>
            <div style="margin-top:10px"><button class="btn btn-quiet btn-sm" id="rrCancel">Withdraw request</button></div>`
          : `<p class="bsub" style="margin:0">You can’t raise your own rank, but you can ask for <b>${ROLE_LABEL[nextRole()]}</b>.</p>
            <div style="margin-top:10px"><button class="btn btn-primary btn-sm rr-ask"><i class="fa-solid fa-arrow-up"></i> Request ${ROLE_LABEL[nextRole()]}</button></div>`}
      </div>` : '';
    const queue = reviewQueue.length ? `<div class="set-block"><div class="bh-row"><h4><i class="fa-solid fa-inbox"></i> Rank-up requests</h4><span class="bsub" style="margin:0">${reviewQueue.length} waiting</span></div>${requestsHtml()}</div>` : '';
    host.innerHTML = mine + queue;
    host.querySelector('.rr-ask')?.addEventListener('click', requestRankUp);
    host.querySelector('#rrCancel')?.addEventListener('click', cancelRankUp);
    wireRequests(host);
  }

  /* ---- overview dashboard ---- */
  const countUp = (el, to) => {
    const t0 = performance.now(), dur = 800;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  async function headCount(table, filter) {
    let q = window.db.from(table).select('id', { count: 'exact', head: true });
    if (filter) q = filter(q);
    const { count, error } = await q;
    return error ? null : (count ?? 0);
  }

  async function loadOverview() {
    users = [];
    await loadUsers();
    const day = 86400000, now = Date.now();
    const week = users.filter((u) => now - new Date(u.created_at) < 7 * day).length;
    const online = window.Presence?.online ? (window.Presence.online.size ?? Object.keys(window.Presence.online).length) : 0;
    const [servers, pendNitro, pendAppeals, anns] = await Promise.all([
      headCount('servers'),
      headCount('nitro_requests', (q) => q.eq('status', 'pending')),
      headCount('ban_appeals', (q) => q.eq('status', 'pending')),
      headCount('announcements'),
    ]);
    const kpis = [
      { k: 'Members', v: users.length, ic: 'fa-users', c: 'c4', sub: `+${week} this week` },
      { k: 'Online now', v: online, ic: 'fa-signal', c: 'c6', sub: 'live presence' },
      { k: 'Servers', v: servers, ic: 'fa-server', c: 'c1', sub: 'across the platform' },
      { k: 'Nitro', v: users.filter((u) => u.is_nitro).length, ic: 'fa-bolt', c: 'c3', sub: `${pendNitro ?? 0} pending` },
      { k: 'Banned', v: users.filter((u) => u.is_banned).length, ic: 'fa-ban', c: 'c8', sub: `${pendAppeals ?? 0} appeals open` },
      { k: 'Staff', v: users.filter((u) => UI.rank(u) > 0).length, ic: 'fa-shield-halved', c: 'c2', sub: anns == null ? 'announcements not set up' : `${anns} announcements` },
    ];
    $('kpis').innerHTML = kpis.map((x, i) => `<div class="kpi" style="--i:${i}">
        <span class="ph-ico ${x.c}"><i class="fa-solid ${x.ic}"></i></span>
        <div class="kv" data-v="${x.v ?? ''}">${x.v == null ? '—' : '0'}</div>
        <div class="kk">${x.k}</div><div class="ks">${UI.esc(x.sub)}</div></div>`).join('');
    $('kpis').querySelectorAll('.kv[data-v]').forEach((el) => { if (el.dataset.v !== '') countUp(el, +el.dataset.v); });

    const queue = [];
    if (pendNitro) queue.push(`<button class="q-item" data-goto="nitro"><span class="ph-ico c3"><i class="fa-solid fa-bolt"></i></span><span><b>${pendNitro} Nitro request${pendNitro === 1 ? '' : 's'}</b><small>Waiting for a decision</small></span><i class="fa-solid fa-chevron-right"></i></button>`);
    if (pendAppeals) queue.push(`<button class="q-item" data-goto="appeals"><span class="ph-ico c8"><i class="fa-solid fa-gavel"></i></span><span><b>${pendAppeals} ban appeal${pendAppeals === 1 ? '' : 's'}</b><small>Someone wants back in</small></span><i class="fa-solid fa-chevron-right"></i></button>`);
    if (anns == null) queue.push(`<button class="q-item" data-goto="announce"><span class="ph-ico c2"><i class="fa-solid fa-database"></i></span><span><b>Announcements not set up</b><small>Run supabase/announcements.sql</small></span><i class="fa-solid fa-chevron-right"></i></button>`);
    $('ovQueue').innerHTML = queue.join('') || '<div class="ov-clear"><i class="fa-solid fa-circle-check"></i> All clear. Nothing waiting on you.</div>';

    $('ovRecent').innerHTML = users.slice(0, 6).map((u) => `<div class="mini-row">${UI.avatar(u, 30, { presence: true })}
      <div><b>${UI.esc(u.display_name || u.username)}</b><small>@${UI.esc(u.username)}</small></div>
      <span class="mr-t">${UI.timeLabel(u.created_at).replace(' at ', ' · ')}</span></div>`).join('') || '<p class="bsub">No members yet.</p>';

    // Sign-ups per day: one series, so one hue, a hover label per bar, no legend.
    const days = [...Array(14)].map((_, i) => {
      const d = new Date(now - (13 - i) * day); d.setHours(0, 0, 0, 0);
      return { d, n: 0 };
    });
    users.forEach((u) => {
      const t = new Date(u.created_at); t.setHours(0, 0, 0, 0);
      const hit = days.find((x) => x.d.getTime() === t.getTime());
      if (hit) hit.n++;
    });
    const max = Math.max(1, ...days.map((x) => x.n));
    const total = days.reduce((a, x) => a + x.n, 0);
    $('ovSpark').textContent = `${total} in total`;
    $('ovBars').innerHTML = days.map((x, i) => {
      const label = x.d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return `<div class="bar-col" data-tip="${label}: ${x.n} sign-up${x.n === 1 ? '' : 's'}">
        <div class="bar" style="--h:${(x.n / max) * 100}%;--i:${i}">${x.n === max && x.n ? `<span class="bar-v">${x.n}</span>` : ''}</div>
        <span class="bar-x">${i % 2 === 1 || i === 13 ? label : ''}</span></div>`;
    }).join('');

    document.querySelectorAll('#ovQueue [data-goto]').forEach((b) => {
      b.onclick = () => document.querySelector(`.set-nav button[data-tab="${b.dataset.goto}"]`)?.click();
    });
  }

  /* ---- announcements ---- */
  const annMissing = (e) => e && (e.code === 'PGRST205' || e.code === '42P01' || /schema cache|does not exist/i.test(e.message || ''));

  function annDraft() {
    return {
      title: $('annTitle').value.trim(), body: $('annBody').value.trim(),
      level: $('annLevel').value, pinned: $('annPinned').checked,
      created_at: new Date().toISOString(),
    };
  }
  function annPreview() {
    const d = annDraft();
    $('annPreview').innerHTML = Nav.annCard({ ...d, title: d.title || 'Your title here' });
  }
  ['annTitle', 'annBody', 'annLevel', 'annPinned'].forEach((id) => { $(id).addEventListener('input', annPreview); $(id).addEventListener('change', annPreview); });

  async function loadAnnouncements() {
    annPreview();
    const { data, error } = await window.db.from('announcements').select('*').order('created_at', { ascending: false }).limit(100);
    const missing = annMissing(error);
    $('annSetup').classList.toggle('hidden', !missing);
    $('annComposer').classList.toggle('hidden', missing);
    if (missing) {
      $('annSetup').innerHTML = `<div class="empty"><div class="ico"><i class="fa-solid fa-database"></i></div>
        <h3>Announcements aren't set up yet</h3>
        <p>Run <code>supabase/announcements.sql</code> in the Supabase SQL editor, then reload this page.</p></div>`;
      $('annRows').innerHTML = '';
      return;
    }
    if (error) return UI.toast(error.message, true);
    $('annRows').innerHTML = (data || []).map((a) => `<div class="lrow" data-id="${a.id}" style="align-items:flex-start;">
        <div class="lmain">${Nav.annCard(a, true)}</div>
        <div class="lacts" style="flex-direction:column;">
          <button class="btn btn-quiet btn-sm a-pin">${a.pinned ? 'Unpin' : 'Pin'}</button>
          <button class="btn btn-danger btn-sm a-del">Delete</button>
        </div></div>`).join('') || '<div class="empty"><p>Nothing posted yet.</p></div>';
    $('annRows').querySelectorAll('.lrow').forEach((row) => {
      const a = data.find((x) => x.id === row.dataset.id);
      row.querySelector('.a-pin').onclick = async () => {
        const { error: e } = await window.db.from('announcements').update({ pinned: !a.pinned }).eq('id', a.id);
        if (e) return UI.toast(e.message, true);
        loadAnnouncements();
      };
      row.querySelector('.a-del').onclick = async () => {
        if (!await UI.confirmDialog('Delete announcement', `"${a.title}" will disappear for everyone.`, true)) return;
        const { error: e } = await window.db.from('announcements').delete().eq('id', a.id);
        if (e) return UI.toast(e.message, true);
        UI.toast('Announcement deleted.');
        loadAnnouncements();
      };
    });
  }

  $('annPost').onclick = async () => {
    const d = annDraft();
    $('annErr').textContent = '';
    if (!d.title) return ($('annErr').textContent = 'Give it a title.');
    const btn = $('annPost'); btn.disabled = true;
    const { error } = await window.db.from('announcements').insert({
      title: d.title, body: d.body, level: d.level, pinned: d.pinned, author_id: me.id,
    });
    btn.disabled = false;
    if (error) return ($('annErr').textContent = error.message);
    $('annTitle').value = ''; $('annBody').value = ''; $('annPinned').checked = false;
    UI.toast('Announcement posted.');
    loadAnnouncements();
  };

  (async () => {
    const s = await UI.requireSession(); if (!s) return;
    me = await UI.myProfile(s.user.id);
    if (UI.rank(me) < 1) { $('denied').classList.remove('hidden'); return; }
    window.Notify?.start(me);
    window.Guard?.start(me);
    window.Presence?.start(me);
    window.Presence?.onChange(() => window.Presence.refreshDots());
    $('wrap').classList.remove('hidden');
    UI.applyBackground(me.theme);
    $('admWho').textContent = `@${me.username} · ${UI.roleName(me) || 'Admin'}`;
    // Tabs follow the permissions the owner has handed out.
    await loadPerms();
    applyPermTabs();
    await loadRankRequests();
    if (can('view_all_servers')) document.querySelector('.kpis')?.addEventListener('click', (e) => {
      if (e.target.closest('.kpi:nth-child(3)')) document.querySelector('.set-nav button[data-tab="servers"]')?.click();
    });
    document.querySelectorAll('[data-goto]').forEach((b) => {
      b.onclick = () => document.querySelector(`.set-nav button[data-tab="${b.dataset.goto}"]`)?.click();
    });
    loadOverview();
    // Presence arrives a moment after boot; keep the live tile honest.
    window.Presence?.onChange((set) => { const el = $('kpis').querySelector('.kpi:nth-child(2) .kv'); if (el && set) el.textContent = set.size; });
    loadRequests();
    loadAppeals({ quiet: true });
  })();
})();
