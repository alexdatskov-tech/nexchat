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
  const isSuper = () => myRank() >= 2;
  const canAct = (u) => u.id !== me.id && myRank() > R(u);
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
        ${u.id === me.id ? '<span class="badge badge-owner">You</span>' : `
        <div class="lacts">
          ${canAct(u) ? `<button class="btn btn-quiet btn-sm u-ban" style="${u.is_banned ? '' : 'color:#FF8085;'}">${u.is_banned ? 'Unban' : 'Ban'}</button>` : '<span class="u-lock" title="Ranked the same as or above you"><i class="fa-solid fa-lock"></i></span>'}
          <button class="btn btn-ghost btn-sm u-open">Manage <i class="fa-solid fa-chevron-right"></i></button>
        </div>`}
      </div>`).join('') || '<div class="empty"><p>No one matches that.</p></div>';

    $('userRows').querySelectorAll('.u-row').forEach((row) => {
      const u = users.find((x) => x.id === row.dataset.u);
      row.querySelector('.u-ban')?.addEventListener('click', (e) => { e.stopPropagation(); toggleBan(u); });
      row.onclick = (e) => { if (!e.target.closest('.u-ban')) openUser(u); };
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
    const roleOpts = ROLE_KEYS.map((k, r) => `<option value="${k}" ${R(u) === r ? 'selected' : ''} ${r >= myRank() ? 'disabled' : ''}>${['User', 'Admin', 'Sudo Admin'][r]}</option>`).join('');
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
          <div><span>Last sign-in</span><b id="usLast">${isSuper() ? '…' : '—'}</b></div>
          <div><span>Active sessions</span><b id="usSess">${isSuper() ? '…' : '—'}</b></div>
          <div class="wide"><span>User ID</span><b class="mono sel">${u.id}</b></div>
          ${u.is_banned && u.ban_reason ? `<div class="wide"><span>Ban reason</span><b>${UI.esc(u.ban_reason)}</b></div>` : ''}
        </div>

        ${isSuper() ? `<h4 class="us-h"><i class="fa-solid fa-server"></i> Servers <span id="usSrvN"></span></h4><div id="usSrv" class="us-srv"><div class="skel" style="height:52px;border-radius:14px"></div></div>` : ''}

        ${u.id === me.id ? '' : `<h4 class="us-h"><i class="fa-solid fa-sliders"></i> Manage</h4>
        <div class="us-actions">
          <div class="us-act">
            <div><b>Role</b><small>${canAct(u) ? 'You can give roles below your own.' : 'Ranked the same as or above you.'}</small></div>
            <select id="usRole" class="input" ${canAct(u) ? '' : 'disabled'}>${roleOpts}</select>
          </div>
          <div class="us-act">
            <div><b>${u.is_banned ? 'Lift ban' : 'Ban account'}</b><small>${u.is_banned ? 'Let them back in.' : 'Locks them out everywhere, instantly.'}</small></div>
            <button class="btn ${u.is_banned ? 'btn-ghost' : 'btn-danger'} btn-sm" id="usBan" ${canAct(u) ? '' : 'disabled'}>${u.is_banned ? 'Unban' : 'Ban'}</button>
          </div>
          ${isSuper() ? `<div class="us-act">
            <div><b>Set a new password</b><small>Their current password can’t be viewed (only a one-way hash is stored). This replaces it and signs them out everywhere.</small></div>
            <button class="btn btn-ghost btn-sm" id="usPw" ${canAct(u) ? '' : 'disabled'}><i class="fa-solid fa-key"></i> Set password</button>
          </div>
          <div class="us-act danger">
            <div><b>Delete account</b><small>Removes the account, their messages, servers they own and their private drive. Can’t be undone.</small></div>
            <button class="btn btn-danger btn-sm" id="usDel" ${canAct(u) ? '' : 'disabled'}><i class="fa-solid fa-trash"></i> Delete</button>
          </div>` : ''}
        </div>`}
      </div>`);

    if (isSuper()) {
      window.db.rpc('admin_user_auth', { p_user_id: u.id }).then(({ data, error }) => {
        const row = Array.isArray(data) ? data[0] : data;
        el.querySelector('#usLast').textContent = error ? '—' : (row?.last_sign_in_at ? UI.timeLabel(row.last_sign_in_at) : 'Never');
        el.querySelector('#usSess').textContent = error ? '—' : String(row?.sessions ?? 0);
      });
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
    if (!isSuper()) return;
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
    if (!me?.is_platform_admin) { $('denied').classList.remove('hidden'); return; }
    window.Notify?.start(me);
    window.Guard?.start(me);
    window.Presence?.start(me);
    window.Presence?.onChange(() => window.Presence.refreshDots());
    $('wrap').classList.remove('hidden');
    UI.applyBackground(me.theme);
    $('admWho').textContent = `@${me.username} · ${UI.roleName(me) || 'Admin'}`;
    // Owner & sudo admins get the platform-wide tools.
    document.querySelectorAll('.super-only').forEach((el) => el.classList.toggle('hidden', UI.rank(me) < 2));
    if (UI.rank(me) >= 2) document.querySelector('.kpis')?.addEventListener('click', (e) => {
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
