/* Server view: channel list, chat, member list, voice rooms. */
(function () {
  const { esc } = NX;
  const P = () => NX.people;
  const D = () => NX.data;
  const BIT = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 4, MANAGE_CHANNELS: 8, MANAGE_ROLES: 16, KICK: 32, BAN: 64, MANAGE_SERVER: 128, INVITE: 256, CONNECT: 512, SPEAK: 1024, VIDEO: 2048, ADMIN: 65536 };

  let side = null, main = null, offs = [];
  let srv = null, channels = [], perms = 0, member = true, roles = [], memberRoles = new Map(), members = null;
  let active = null, chat = null, voiceSessions = [], vsChan = null, srvChan = null;
  const cache = new Map();   // server id -> { srv, channels, perms, member, roles, memberRoles, members }
  const collapsed = new Set(NX.ls.get('nx_collapsed', []));
  const allChannels = new Map();   // for the quick switcher

  const can = (bit) => !!srv && (srv.owner_id === NX.me.id || (perms & BIT.ADMIN) !== 0 || (perms & bit) !== 0 || P().rank(NX.me) >= 1 && bit !== BIT.SEND);
  const canManageAny = () => !!srv && (srv.owner_id === NX.me.id || P().rank(NX.me) >= 1 || (perms & (BIT.ADMIN | BIT.MANAGE_SERVER | BIT.MANAGE_ROLES | BIT.MANAGE_CHANNELS | BIT.KICK | BIT.BAN)) !== 0);
  const isVoice = (c) => c.type === 'voice' || c.type === 'stage';
  const chanIcon = (c) => (isVoice(c) ? 'fa-volume-high' : c.type === 'announcement' ? 'fa-bullhorn' : 'fa-hashtag');

  /* ---------- loading ---------- */
  async function load(sid) {
    const c = cache.get(sid);
    if (c && Date.now() - c.at < 5 * 60 * 1000) { refreshQuietly(sid); return c; }
    const [s, ch, pm, mem] = await Promise.all([
      window.db.from('servers').select('*').eq('id', sid).maybeSingle(),
      window.db.from('channels').select('*').eq('server_id', sid).order('position'),
      window.db.rpc('member_permissions', { p_server_id: sid, p_user_id: NX.me.id }),
      window.db.from('server_members').select('user_id').eq('server_id', sid).eq('user_id', NX.me.id).maybeSingle(),
    ]);
    if (!s.data) return null;
    const entry = { srv: s.data, channels: ch.data || [], perms: Number(pm.data) || 0, member: !!mem.data, roles: [], memberRoles: new Map(), members: null, at: Date.now() };
    cache.set(sid, entry);
    loadRoles(sid);
    return entry;
  }
  function apply(e) {
    srv = e.srv; channels = e.channels; perms = e.perms; member = e.member; roles = e.roles; memberRoles = e.memberRoles; members = e.members;
    channels.forEach((c) => { NX.chanServer.set(c.id, c.server_id); allChannels.set(c.id, c); });
  }
  async function refreshQuietly(sid) {
    const { data } = await window.db.from('channels').select('*').eq('server_id', sid).order('position');
    if (data && srv?.id === sid) { channels = data; cache.get(sid).channels = data; data.forEach((c) => { NX.chanServer.set(c.id, sid); allChannels.set(c.id, c); }); paintChannels(); }
  }
  async function loadRoles(sid) {
    const [r, mr] = await Promise.all([
      window.db.from('roles').select('id,name,color,position,is_default,icon_url').eq('server_id', sid),
      window.db.from('member_roles').select('user_id,role_id').eq('server_id', sid),
    ]);
    const e = cache.get(sid);
    if (!e) return;
    e.roles = (r.data || []).sort((a, b) => (b.position || 0) - (a.position || 0));
    e.memberRoles = new Map();
    (mr.data || []).forEach((x) => { if (!e.memberRoles.has(x.user_id)) e.memberRoles.set(x.user_id, []); e.memberRoles.get(x.user_id).push(x.role_id); });
    if (srv?.id === sid) { roles = e.roles; memberRoles = e.memberRoles; paintMembers(); }
  }
  async function loadMembers(sid) {
    const e = cache.get(sid);
    if (e?.members) { members = e.members; return; }
    const { data } = await window.db.from('server_members').select('user_id,nickname,joined_at').eq('server_id', sid);
    const rows = data || [];
    await P().need(rows.map((r) => r.user_id));
    if (e) e.members = rows;
    if (srv?.id === sid) members = rows;
  }
  function topRole(uid) {
    const ids = memberRoles.get(uid) || [];
    return roles.find((r) => ids.includes(r.id) && !r.is_default) || null;
  }
  function roleColor(uid) {
    const ids = memberRoles.get(uid) || [];
    const r = roles.find((x) => ids.includes(x.id) && !x.is_default && x.color && x.color.toUpperCase() !== '#99AAB5');
    return r?.color || null;
  }

  /* ---------- sidebar ---------- */
  function mountSide(host) {
    host.innerHTML = `<div class="srv-top"></div><div class="side-body" id="chanList"></div>`;
    side = host;
    host.querySelector('#chanList').addEventListener('click', onChanClick);
    host.querySelector('#chanList').addEventListener('contextmenu', (e) => {
      const it = e.target.closest('[data-ch]');
      if (!it) return;
      e.preventDefault();
      chanMenu(channels.find((c) => c.id === it.dataset.ch), e);
    });
  }
  function paintTop() {
    const top = side?.querySelector('.srv-top');
    if (!top || !srv) return;
    const nameStyle = srvNameStyle(srv.theme);
    const banner = srv.banner_url ? `<div class="side-banner" data-bn></div>` : '';
    top.innerHTML = `${banner}<div class="side-head btn-like" data-a="menu" ${banner ? 'style="position:relative;margin-top:-52px;border:0;z-index:2"' : ''}>
      <span class="t srv-name" style="${esc(nameStyle)}">${esc(srv.name)}</span><i class="fa-solid fa-chevron-down" style="font-size:12px"></i></div>`;
    if (srv.banner_url) {
      const bn = top.querySelector('[data-bn]');
      NX.files.resolved(srv.banner_url).then((u) => { bn.style.backgroundImage = `url("${u}")`; }).catch(() => {});
    }
    top.querySelector('[data-a="menu"]').onclick = (e) => serverMenu(e.currentTarget);
  }
  /* Server name colour + typeface (theme.name_color / name_font / name_font_url /
     name_font_file), shared with the server settings preview. */
  const NAME_FONTS = { display: 'var(--f-display)', body: 'var(--f-ui)', mono: 'var(--f-mono)', serif: "Georgia, 'Times New Roman', serif", rounded: "'Trebuchet MS', 'Segoe UI', sans-serif" };
  function srvNameStyle(theme) {
    const t = theme || {};
    let css = /^#[0-9a-f]{6}$/i.test(t.name_color || '') ? `color:${t.name_color};` : '';
    let stack = NAME_FONTS[t.name_font] || null;
    if (t.name_font === 'google' && t.name_font_url) {
      try {
        const m = String(t.name_font_url).replace(/&amp;/g, '&').match(/https:\/\/fonts\.googleapis\.com\/css2?\?[^\s'"()<>]+/);
        const u = m && new URL(m[0]);
        const fam = u && (u.searchParams.get('family') || '').split(':')[0].replace(/[^A-Za-z0-9 _-]/g, ' ').trim().slice(0, 60);
        if (fam) {
          if (!document.querySelector(`link[data-nxfont="${CSS.escape(u.href)}"]`)) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = u.href; l.dataset.nxfont = u.href; document.head.appendChild(l); }
          stack = `'${fam}', var(--f-display)`;
        }
      } catch {}
    } else if (t.name_font === 'upload' && t.name_font_file) {
      const fam = NX.fontFace(t.name_font_file);
      if (fam) stack = `'${fam}', var(--f-display)`;
    }
    if (stack) css += `font-family:${stack};`;
    return css;
  }
  NX.serverNameStyle = srvNameStyle;
  // A server can override the accent colour while it is open.
  function resetAccent() {
    const root = document.documentElement;
    delete root.dataset.srvAccent;
    if (NX.userAccent) root.style.setProperty('--accent', NX.userAccent); else root.style.removeProperty('--accent');
  }
  function applyAccent() {
    const a = srv?.theme?.accent;
    const root = document.documentElement;
    if (/^#[0-9a-f]{6}$/i.test(a || '')) { root.style.setProperty('--accent', a); root.dataset.srvAccent = '1'; }
    else resetAccent();
  }
  function paintChannels() {
    const host = side?.querySelector('#chanList');
    if (!host || !srv) return;
    const st = NX.call.state();
    const live = window.Voice?.live?.() || new Map();
    const cats = channels.filter((c) => c.type === 'category').sort((a, b) => a.position - b.position);
    const loose = channels.filter((c) => c.type !== 'category' && !c.parent_id).sort((a, b) => a.position - b.position);
    const item = (c) => {
      const voice = isVoice(c);
      const unread = !voice && (D().chanUnread.get(c.id) || 0) > 0 && active?.id !== c.id;
      const here = st.active && st.channel?.id === c.id;
      let occ = '';
      if (voice) {
        const people = here ? [...st.members.values()] : ((live.get(c.id) || 0) > 0 ? voiceSessions.filter((v) => v.channel_id === c.id).map((v) => ({ ...(P().get(v.user_id) || { id: v.user_id }), muted: v.is_muted, deaf: v.is_deafened, cam: v.is_camera_on, sharing: v.is_screen_sharing })) : []);
        if (people.length) occ = `<div class="vc-users">${people.map((p) => `<div class="vc-user${NX.call.speaking().has(p.id) ? ' speaking' : ''}" data-uid="${esc(p.id)}">${P().avatar(P().get(p.id) || p, 22, { halo: false, deco: false })}<span class="nm">${P().nameText(P().get(p.id) || p)}</span><span class="flags">${p.sharing ? '<span class="live" style="font-size:9px">LIVE</span>' : ''}${p.cam ? '<i class="fa-solid fa-video"></i>' : ''}${p.muted ? '<i class="fa-solid fa-microphone-slash off"></i>' : ''}${p.deaf ? '<i class="fa-solid fa-headphones off"></i>' : ''}</span></div>`).join('')}</div>`;
        else if (live.get(c.id)) occ = `<div class="vc-users"><div class="vc-user" style="cursor:default"><span class="nm" style="color:var(--ok)">${NX.fmt.plural(live.get(c.id), 'person', 'people')} talking</span></div></div>`;
      }
      return `<a class="s-item${active?.id === c.id ? ' on' : ''}${unread ? ' unread' : ''}" href="#/s/${esc(srv.id)}/${esc(c.id)}" data-ch="${esc(c.id)}"><i class="fa-solid ${chanIcon(c)}"></i><span class="nm">${esc(c.name)}</span>
        ${can(BIT.MANAGE_CHANNELS) ? `<span class="acts"><button class="icon-btn" data-a="invite" data-tip="Create invite"><i class="fa-solid fa-user-plus"></i></button><button class="icon-btn" data-a="edit" data-tip="Edit channel"><i class="fa-solid fa-gear"></i></button></span>` : ''}
        ${unread && D().chanUnread.get(c.id) > 0 && false ? '' : ''}</a>${occ}`;
    };
    let html = loose.map(item).join('');
    cats.forEach((cat) => {
      const kids = channels.filter((c) => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
      const shut = collapsed.has(cat.id);
      const visible = shut ? kids.filter((c) => c.id === active?.id || (st.active && st.channel?.id === c.id)) : kids;
      html += `<div class="side-sect${shut ? ' shut' : ''}" data-cat="${esc(cat.id)}"><i class="fa-solid fa-chevron-down chev"></i><span class="grow">${esc(cat.name)}</span>${can(BIT.MANAGE_CHANNELS) ? `<button class="icon-btn" data-a="add" data-tip="Create channel"><i class="fa-solid fa-plus"></i></button>` : ''}</div>${visible.map(item).join('')}`;
    });
    if (!channels.some((c) => c.type !== 'category')) html += `<div class="empty" style="padding:24px 10px"><p style="font-size:13px">No channels yet.${can(BIT.MANAGE_CHANNELS) ? '' : ' Ask an admin to make one.'}</p>${can(BIT.MANAGE_CHANNELS) ? '<button class="btn btn-ghost btn-sm" data-a="add">Create a channel</button>' : ''}</div>`;
    host.innerHTML = html;
  }
  function onChanClick(e) {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const it = e.target.closest('[data-ch]');
    const c = it && channels.find((x) => x.id === it.dataset.ch);
    if (a === 'add') { e.preventDefault(); return channelDialog(null, e.target.closest('[data-cat]')?.dataset.cat); }
    if (a === 'edit' && c) { e.preventDefault(); e.stopPropagation(); return channelDialog(c); }
    if (a === 'invite') { e.preventDefault(); e.stopPropagation(); return invite(srv.id); }
    const u = e.target.closest('.vc-user[data-uid]');
    if (u) { e.preventDefault(); return P().card(u.dataset.uid, u, { serverId: srv.id }); }
    const cat = e.target.closest('[data-cat]');
    if (cat) {
      if (collapsed.has(cat.dataset.cat)) collapsed.delete(cat.dataset.cat); else collapsed.add(cat.dataset.cat);
      NX.ls.set('nx_collapsed', [...collapsed]);
      return paintChannels();
    }
    if (c) {
      e.preventDefault();
      NX.go(`s/${srv.id}/${c.id}`);
      if (isVoice(c)) { const st = NX.call.state(); if (!(st.active && st.channel?.id === c.id)) joinVoice(c); }
      NX.closeDrawer();
    }
  }
  function serverMenu(at) {
    const owner = srv.owner_id === NX.me.id;
    NX.menu(at, [
      { label: 'Invite people', icon: 'fa-user-plus', hidden: !can(BIT.INVITE) || !member, onClick: () => invite(srv.id) },
      { label: 'Server settings', icon: 'fa-gear', hidden: !canManageAny(), onClick: () => NX.go(`s/${srv.id}/settings`) },
      { label: 'Create channel', icon: 'fa-circle-plus', hidden: !can(BIT.MANAGE_CHANNELS), onClick: () => channelDialog(null) },
      { label: 'Create category', icon: 'fa-folder-plus', hidden: !can(BIT.MANAGE_CHANNELS), onClick: () => categoryDialog() },
      { sep: true },
      { label: 'Mark as read', icon: 'fa-check', onClick: () => { const s = D().server(srv.id); if (s) NX.markServerRead(s); paintChannels(); } },
      { label: 'Copy server ID', icon: 'fa-id-card', onClick: () => NX.copy(srv.id, 'ID copied') },
      { sep: true, hidden: owner || !member },
      { label: 'Leave server', icon: 'fa-right-from-bracket', danger: true, hidden: owner || !member, onClick: () => D().leaveServer(srv) },
    ], { anchor: true });
  }
  function chanMenu(c, at) {
    if (!c) return;
    NX.menu(at, [
      { label: 'Mark as read', icon: 'fa-check', hidden: isVoice(c), onClick: () => { D().markChannelRead(c.id, srv.id); paintChannels(); } },
      { label: 'Copy link', icon: 'fa-link', onClick: () => NX.copy(NX.pageUrl(`index.html#/s/${srv.id}/${c.id}`), 'Link copied') },
      { label: 'Edit channel', icon: 'fa-pen', hidden: !can(BIT.MANAGE_CHANNELS), onClick: () => channelDialog(c) },
      { label: 'Delete channel', icon: 'fa-trash-can', danger: true, hidden: !can(BIT.MANAGE_CHANNELS), onClick: () => deleteChannel(c) },
    ]);
  }

  /* ---------- channel dialogs ---------- */
  function channelDialog(c, parent) {
    const editing = !!c;
    const cats = channels.filter((x) => x.type === 'category');
    const body = NX.h(`<div style="display:flex;flex-direction:column;gap:14px">
      ${editing ? '' : `<div class="field"><label>Channel type</label>
        <label class="choice" style="padding:10px 12px"><input type="radio" name="ct" value="text" checked><span class="c-ico" style="width:34px;height:34px"><i class="fa-solid fa-hashtag"></i></span><span><b>Text</b><small>Messages, images, files, emoji</small></span></label>
        <label class="choice" style="padding:10px 12px"><input type="radio" name="ct" value="voice"><span class="c-ico teal" style="width:34px;height:34px"><i class="fa-solid fa-volume-high"></i></span><span><b>Voice</b><small>Talk, video and share your screen</small></span></label></div>`}
      <div class="field"><label>Channel name</label><input class="input" data-n maxlength="100" placeholder="new-channel" value="${esc(c?.name || '')}"></div>
      <div class="field" data-topic ${editing && isVoice(c) ? 'hidden' : ''}><label>Topic</label><input class="input" data-t maxlength="1024" placeholder="Let everyone know what this channel is about" value="${esc(c?.topic || '')}"></div>
      <div class="field"><label>Category</label><select class="input" data-p><option value="">No category</option>${cats.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div></div>`);
    const sel = body.querySelector('[data-p]');
    sel.value = c ? (c.parent_id || '') : (parent || pickCategory('text') || '');
    body.querySelectorAll('[name=ct]').forEach((r) => r.onchange = () => {
      body.querySelector('[data-topic]').hidden = r.value === 'voice' && r.checked;
      if (r.checked) sel.value = pickCategory(r.value) || sel.value;
    });
    const nameIn = body.querySelector('[data-n]');
    nameIn.addEventListener('input', () => {
      const type = body.querySelector('[name=ct]:checked')?.value || c?.type;
      if (type === 'text' || type === 'announcement') { const p = nameIn.selectionStart; nameIn.value = nameIn.value.toLowerCase().replace(/\s/g, '-'); nameIn.setSelectionRange(p, p); }
    });
    const m = NX.modal({
      title: editing ? 'Edit channel' : 'Create channel', body,
      foot: [
        ...(editing ? [{ left: NX.h('<button class="btn btn-danger-ghost btn-sm">Delete channel</button>') }] : []),
        { label: 'Cancel' },
        {
          label: editing ? 'Save' : 'Create channel', cls: 'btn-primary', primary: true, onClick: async () => {
            const name = nameIn.value.trim().replace(/^#/, '');
            if (!name) { NX.toast('Give the channel a name.', { err: true }); return false; }
            const patch = { name, parent_id: sel.value || null };
            if (!editing || !isVoice(c)) patch.topic = body.querySelector('[data-t]').value.trim() || null;
            if (editing) {
              const { error } = await NX.must(window.db.from('channels').update(patch).eq('id', c.id));
              if (error) throw error;
              Object.assign(c, patch);
            } else {
              const type = body.querySelector('[name=ct]:checked').value;
              const pos = channels.filter((x) => (x.parent_id || null) === patch.parent_id && x.type !== 'category').length;
              const { data, error } = await window.db.from('channels').insert({ ...patch, server_id: srv.id, type, position: pos }).select().single();
              if (error) throw error;
              channels.push(data); NX.chanServer.set(data.id, srv.id); allChannels.set(data.id, data);
              if (type !== 'voice') NX.go(`s/${srv.id}/${data.id}`);
            }
            paintChannels(); paintHead();
          },
        },
      ],
    });
    m.el.querySelector('.btn-danger-ghost')?.addEventListener('click', () => { m.close(); deleteChannel(c); });
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.primary.click(); });
  }
  function pickCategory(type) {
    const wantVoice = type === 'voice';
    const cats = channels.filter((c) => c.type === 'category');
    const fit = cats.find((cat) => { const k = channels.filter((c) => c.parent_id === cat.id); return k.length && k.every((x) => isVoice(x) === wantVoice); });
    return fit?.id || cats.find((c) => (wantVoice ? /voice|vc|talk/i : /text|chat|general/i).test(c.name))?.id || null;
  }
  async function categoryDialog() {
    const name = await NX.prompt({ title: 'Create category', label: 'Category name', placeholder: 'New category', max: 100, ok: 'Create' });
    if (!name) return;
    const pos = channels.filter((c) => c.type === 'category').length;
    const { data, error } = await window.db.from('channels').insert({ server_id: srv.id, name, type: 'category', position: pos }).select().single();
    if (error) return NX.fail(error);
    channels.push(data); paintChannels();
  }
  async function deleteChannel(c) {
    if (!await NX.confirm({ title: `Delete ${c.type === 'category' ? 'category' : '#' + c.name}?`, body: c.type === 'category' ? 'Channels inside it stay, without a category.' : 'Every message in it will be deleted. This can’t be undone.', ok: 'Delete', danger: true })) return;
    const { error } = await NX.must(window.db.from('channels').delete().eq('id', c.id));
    if (error) return NX.fail(error);
    channels = channels.filter((x) => x.id !== c.id);
    if (cache.get(srv.id)) cache.get(srv.id).channels = channels;
    NX.Chat.drop('channel:' + c.id);
    if (active?.id === c.id) NX.go('s/' + srv.id); else paintChannels();
  }

  /* ---------- invites ---------- */
  async function invite(sid) {
    const s = sid === srv?.id ? srv : (await window.db.from('servers').select('*').eq('id', sid).maybeSingle()).data;
    if (!s) return;
    const body = NX.h(`<div style="display:flex;flex-direction:column;gap:12px">
      <div class="field"><label>Send a server invite link to a friend</label>
        <div class="row"><input class="input mono" readonly data-link placeholder="Generating…"><button class="btn btn-primary" data-copy disabled>Copy</button></div></div>
      <div class="field"><label>Expire after</label><select class="input" data-exp><option value="24">1 day</option><option value="168" selected>7 days</option><option value="1">1 hour</option><option value="0">Never</option></select>
      <span class="hint">Code: <b class="mono" data-code>…</b> · people can paste the code or open the link.</span></div></div>`);
    NX.modal({ title: `Invite friends to ${s.name}`, body });
    const gen = async () => {
      const hrs = +body.querySelector('[data-exp]').value;
      const row = { server_id: s.id, created_by: NX.me.id };
      if (hrs) row.expires_at = new Date(Date.now() + hrs * 3600e3).toISOString();
      const { data, error } = await window.db.from('invites').insert(row).select().single();
      if (error) { body.querySelector('[data-link]').value = ''; return NX.fail(error); }
      const link = NX.pageUrl(`index.html?invite=${data.code}`);
      body.querySelector('[data-link]').value = link;
      body.querySelector('[data-code]').textContent = data.code;
      body.querySelector('[data-copy]').disabled = false;
      body.querySelector('[data-copy]').onclick = () => NX.copy(link, 'Invite link copied');
    };
    body.querySelector('[data-exp]').onchange = gen;
    gen();
  }

  /* ---------- main ---------- */
  function mainShell() {
    const open = NX.ls.get('nx_members_open', !NX.isNarrow() && innerWidth > 1180);
    main.innerHTML = `
      <div class="main-head"></div>
      <div class="preview-slot"></div>
      <div class="main-body"><div class="main-col" id="chanMain"></div><aside class="members${open ? '' : ' hidden'}" id="memList"></aside><aside class="side-panel hidden" id="pinPanel"></aside></div>`;
  }
  function paintHead() {
    const head = main?.querySelector('.main-head');
    if (!head) return;
    if (!active) { head.innerHTML = `<button class="icon-btn h-burger" data-a="burger"><i class="fa-solid fa-bars"></i></button><span class="h-title">${esc(srv?.name || '')}</span>`; head.onclick = (e) => { if (e.target.closest('[data-a="burger"]')) NX.openDrawer(); }; return; }
    const voice = isVoice(active);
    const memOpen = !main.querySelector('#memList').classList.contains('hidden');
    head.innerHTML = `
      <button class="icon-btn h-burger" data-a="burger" aria-label="Menu"><i class="fa-solid fa-bars"></i></button>
      <i class="fa-solid ${chanIcon(active)} h-ico"></i><span class="h-title">${esc(active.name)}</span>
      <span class="h-sub" title="${esc(active.topic || '')}">${active.topic ? MD.render(active.topic).replace(/<\/?div>/g, ' ') : ''}</span>
      <div class="h-acts">
        ${voice ? '' : '<button class="icon-btn" data-a="pins" data-tip="Pinned messages" data-tip-pos="bottom"><i class="fa-solid fa-thumbtack"></i></button>'}
        <button class="icon-btn${memOpen ? ' on' : ''}" data-a="members" data-tip="${memOpen ? 'Hide' : 'Show'} member list" data-tip-pos="bottom"><i class="fa-solid fa-users"></i></button>
        ${can(BIT.INVITE) && member ? '<button class="icon-btn" data-a="invite" data-tip="Invite people" data-tip-pos="bottom"><i class="fa-solid fa-user-plus"></i></button>' : ''}
      </div>`;
    head.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'burger') NX.openDrawer();
      if (a === 'members') {
        const ml = main.querySelector('#memList');
        const on = ml.classList.toggle('hidden') === false;
        NX.ls.set('nx_members_open', on);
        if (on) { main.querySelector('#pinPanel').classList.add('hidden'); paintMembers(); }
        paintHead();
      }
      if (a === 'pins') togglePins();
      if (a === 'invite') invite(srv.id);
    };
  }
  function paintPreview() {
    const slot = main?.querySelector('.preview-slot');
    if (!slot) return;
    slot.innerHTML = !member ? `<div class="preview-bar"><i class="fa-solid fa-eye"></i><span>You’re viewing this server as <b>${esc(P().ROLE_NAMES[P().rank(NX.me)] || 'staff')}</b>. You haven’t joined it; anything you post appears under your name.</span></div>` : '';
  }

  async function openChannel(c, r) {
    if (c && active?.id === c.id && (chat || isVoice(c))) { paintHead(); if (r?.q.get('m')) chat?.jumpTo(r.q.get('m')); return; }
    if (chat) { chat.hide(); chat = null; }
    const host = main.querySelector('#chanMain');
    if (host.querySelector('.call')) NX.call.unmount(host);
    host.innerHTML = '';
    active = c;
    NX.ls.set('nx_last_ch:' + srv.id, c?.id || null);
    paintHead(); paintChannels();
    if (!c) {
      host.innerHTML = `<div class="empty" style="margin:auto"><div class="ico"><i class="fa-solid fa-hashtag"></i></div><h3>No text channels</h3><p>${can(BIT.MANAGE_CHANNELS) ? 'Create one from the server menu.' : 'There’s nothing to read here yet.'}</p></div>`;
      return;
    }
    if (isVoice(c)) return paintVoice();
    chat = NX.Chat.open({
      kind: 'channel', id: c.id, table: 'messages', attTable: 'message_attachments', rxTable: 'message_reactions', fk: 'channel_id',
      serverId: srv.id, route: `s/${srv.id}/${c.id}`, title: '#' + c.name, placeholder: `Message #${c.name}`,
      intro: () => `<div class="big-ico"><i class="fa-solid ${chanIcon(c)}"></i></div><h2>Welcome to #${esc(c.name)}!</h2><p>${c.topic ? esc(c.topic) : `This is the start of the #${esc(c.name)} channel.`}</p>
        ${can(BIT.MANAGE_CHANNELS) ? '<button class="btn btn-quiet btn-sm" style="margin-top:8px;padding-left:0" data-intro="edit"><i class="fa-solid fa-pen"></i>Edit channel</button>' : ''}`,
      canSend: () => member ? can(BIT.SEND) : !!D().staff?.post_anywhere,
      canManage: () => can(BIT.MANAGE_MESSAGES) || !!D().staff?.delete_messages,
      canPin: () => can(BIT.MANAGE_MESSAGES) || !!D().staff?.delete_messages,
      roleColor,
      badges: (uid) => uid === srv.owner_id ? '<i class="fa-solid fa-crown" title="Server owner" style="color:var(--nitro);font-size:12px"></i>' : '',
      uploadPath: `${srv.id}/${c.id}`,
      lastReadAt: () => null,
      markRead: () => D().markChannelRead(c.id, srv.id),
      members: () => (members || []).map((m) => P().get(m.user_id)).filter(Boolean),
    });
    const cur = chat;
    await chat.show(host);
    if (chat !== cur) return;
    if (!members) loadMembers(srv.id).then(() => paintMembers());
    host.onclick = (e) => { if (e.target.closest('[data-intro="edit"]')) channelDialog(c); };
    if (r?.q.get('m')) chat.jumpTo(r.q.get('m'));
  }

  /* ---------- voice channel ---------- */
  async function joinVoice(c) {
    if (!can(BIT.CONNECT) && member) return NX.toast('You don’t have permission to join voice here.', { err: true });
    const ok = await NX.call.join({ id: c.id, name: c.name }, srv.id);
    if (ok) paintVoice();
  }
  function paintVoice() {
    const host = main?.querySelector('#chanMain');
    if (!host || !active || !isVoice(active)) return;
    const st = NX.call.state();
    const here = st.active && st.channel?.id === active.id;
    if (here) {
      if (!host.querySelector('.call')) { host.innerHTML = ''; NX.call.mount(host, { title: active.name }); }
      return;
    }
    if (host.querySelector('.call')) NX.call.unmount(host);
    const live = (window.Voice?.live?.() || new Map()).get(active.id) || 0;
    const ppl = live ? voiceSessions.filter((v) => v.channel_id === active.id).map((v) => P().get(v.user_id)).filter(Boolean) : [];
    host.innerHTML = `<div class="call" style="align-items:center;justify-content:center;gap:16px;text-align:center;padding:20px">
      <div style="display:flex;gap:-8px">${ppl.slice(0, 6).map((p) => `<span style="margin:0 -6px">${P().avatar(p, 56, { halo: false })}</span>`).join('') || '<div class="ico" style="width:72px;height:72px;border-radius:50%;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--txt-2)"><i class="fa-solid fa-volume-high"></i></div>'}</div>
      <h2 style="font-family:var(--f-display);font-size:26px">${esc(active.name)}</h2>
      <p class="muted">${live ? `${NX.fmt.plural(live, 'person is', 'people are')} in this channel.` : 'No one is here yet. Start the conversation.'}</p>
      <button class="btn btn-ok btn-lg" data-a="join"><i class="fa-solid fa-phone"></i>Join voice</button>
      ${st.active ? `<p class="hint">You’ll leave ${esc(st.channel?.name || 'your current call')}.</p>` : ''}</div>`;
    host.querySelector('[data-a="join"]').onclick = () => joinVoice(active);
  }
  async function loadVoiceSessions() {
    if (!srv) return;
    const { data } = await window.db.from('voice_sessions').select('*').eq('server_id', srv.id);
    voiceSessions = data || [];
    await P().need(voiceSessions.map((v) => v.user_id));
    paintChannels();
    if (active && isVoice(active)) paintVoice();
  }

  /* ---------- members ---------- */
  async function paintMembers() {
    const host = main?.querySelector('#memList');
    if (!host || host.classList.contains('hidden') || !srv) return;
    if (!members) { host.innerHTML = '<div style="padding:20px;display:flex;justify-content:center"><span class="spinner"></span></div>'; await loadMembers(srv.id); }
    if (!members) return;
    const ppl = members.map((m) => ({ m, p: P().get(m.user_id) })).filter((x) => x.p);
    const online = ppl.filter((x) => P().isOnline(x.p.id));
    const offline = ppl.filter((x) => !P().isOnline(x.p.id));
    const sortFn = (a, b) => (b.p.id === srv.owner_id) - (a.p.id === srv.owner_id) || ((topRole(b.p.id)?.position || 0) - (topRole(a.p.id)?.position || 0)) || P().nameOf(a.p).localeCompare(P().nameOf(b.p));
    // group online people by their top role, like Discord's hoisted roles
    const groups = new Map();
    online.sort(sortFn).forEach((x) => {
      const r = topRole(x.p.id);
      const key = r ? r.id : '_online';
      if (!groups.has(key)) groups.set(key, { name: r ? r.name : 'Online', list: [], pos: r?.position ?? -1 });
      groups.get(key).list.push(x);
    });
    const row = (x) => `<div class="mem${P().isOnline(x.p.id) ? '' : ' off'}" data-uid="${esc(x.p.id)}">${P().avatar(x.p, 32, { presence: true })}
      <div class="t"><b style="${esc(P().nameCss(x.p, { color: roleColor(x.p.id), noGlow: true }))}">${esc(x.m.nickname || '') || P().nameText(x.p)}${x.p.id === srv.owner_id ? '<i class="fa-solid fa-crown crown" title="Server owner"></i>' : ''}</b>${x.p.custom_status ? `<small>${esc(x.p.custom_status)}</small>` : ''}</div></div>`;
    host.innerHTML = [...groups.values()].sort((a, b) => b.pos - a.pos).map((g) => `<div class="side-sect">${esc(g.name)} — ${g.list.length}</div>${g.list.map(row).join('')}`).join('')
      + (offline.length ? `<div class="side-sect">Offline — ${offline.length}</div>${offline.sort(sortFn).slice(0, 200).map(row).join('')}` : '');
    host.onclick = (e) => { const r = e.target.closest('[data-uid]'); if (r) P().card(r.dataset.uid, r, { serverId: srv.id }); };
  }

  /* ---------- pins ---------- */
  async function togglePins() {
    const panel = main.querySelector('#pinPanel');
    if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    main.querySelector('#memList').classList.add('hidden'); paintHead();
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="sp-head"><i class="fa-solid fa-thumbtack"></i><span class="grow">Pinned messages</span><button class="icon-btn" data-x><i class="fa-solid fa-xmark"></i></button></div><div class="sp-body"><div style="padding:20px;display:flex;justify-content:center"><span class="spinner"></span></div></div>`;
    panel.querySelector('[data-x]').onclick = () => panel.classList.add('hidden');
    const { data } = await window.db.from('messages').select('*').eq('channel_id', active.id).eq('is_pinned', true).order('created_at', { ascending: false }).limit(50);
    await P().need((data || []).map((m) => m.author_id));
    const body = panel.querySelector('.sp-body');
    body.innerHTML = data?.length ? data.map((m) => { const p = P().get(m.author_id); return `<div class="mini-msg" data-m="${esc(m.id)}"><div class="mm-head">${P().avatar(p, 22, { halo: false, deco: false })}<b>${P().nameText(p)}</b><small>${esc(NX.fmt.stamp(m.created_at))}</small></div><div class="m-text">${MD.render(m.content || '_attachment_')}</div></div>`; }).join('')
      : '<div class="empty"><div class="ico"><i class="fa-solid fa-thumbtack"></i></div><h3>No pins yet</h3><p>Messages pinned in this channel show up here.</p></div>';
    body.onclick = (e) => { const r = e.target.closest('[data-m]'); if (r) chat?.jumpTo(r.dataset.m); };
  }

  /* ---------- realtime for the open server ---------- */
  async function subscribeServer() {
    if (srvChan) { const old = srvChan; srvChan = null; await window.db.removeChannel(old).catch(() => {}); }
    const sid = srv.id;
    for (const c of (window.db.getChannels?.() || []).filter((x) => x.topic === 'realtime:srv:' + sid)) await window.db.removeChannel(c).catch(() => {});
    if (srv?.id !== sid || !main) return;
    srvChan = window.db.channel('srv:' + sid, { config: { private: !!NX.privateRT } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'channels', filter: `server_id=eq.${sid}` }, () => refreshQuietly(sid))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'voice_sessions', filter: `server_id=eq.${sid}` }, () => loadVoiceSessions())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'server_members', filter: `server_id=eq.${sid}` }, () => { const e = cache.get(sid); if (e) e.members = null; members = null; paintMembers(); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'member_roles', filter: `server_id=eq.${sid}` }, () => loadRoles(sid))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'roles', filter: `server_id=eq.${sid}` }, () => loadRoles(sid))
      .subscribe();
  }

  /* ---------- view ---------- */
  let showGen = 0;
  async function show(parts, r) {
    const [, sid, cid] = parts;
    const gen = ++showGen;
    if (srv?.id !== sid) {
      if (chat) { chat.hide(); chat = null; }
      active = null;
      side.querySelector('#chanList').innerHTML = `<div style="padding:10px">${'<div class="skel" style="height:22px;margin:8px 4px"></div>'.repeat(6)}</div>`;
      side.querySelector('.srv-top').innerHTML = `<div class="side-head"><span class="t">${esc(D().server(sid)?.name || '')}</span></div>`;
      mainShell();
      const entry = await load(sid);
      // Another server (or another view) was opened while this one loaded.
      if (gen !== showGen || !main || !side) return;
      if (entry) apply(entry);
      if (!entry) {
        main.innerHTML = '<div class="gone-card"><div class="empty"><div class="ico"><i class="fa-solid fa-ghost"></i></div><h3>Server not found</h3><p>It may have been deleted, or you’re no longer a member.</p><button class="btn btn-primary" onclick="NX.go(\'home\')">Go home</button></div></div>';
        side.querySelector('#chanList').innerHTML = '';
        D().reloadServers();
        return;
      }
      paintTop(); paintPreview(); applyAccent();
      D().loadChannelUnreads(sid);
      loadVoiceSessions();
      subscribeServer();
      watchVoice();
      if (NX.ls.get('nx_members_open', true) && !main.querySelector('#memList').classList.contains('hidden')) paintMembers();
    }
    let c = cid ? channels.find((x) => x.id === cid) : null;
    if (!c) {
      const last = NX.ls.get('nx_last_ch:' + sid);
      c = channels.find((x) => x.id === last && !isVoice(x)) || channels.filter((x) => x.type === 'text' || x.type === 'announcement').sort((a, b) => {
        const pa = channels.find((p) => p.id === a.parent_id)?.position ?? -1, pb = channels.find((p) => p.id === b.parent_id)?.position ?? -1;
        return pa - pb || a.position - b.position;
      })[0] || null;
      if (c) NX.go(`s/${sid}/${c.id}`, { replace: true, silent: true });
    }
    openChannel(c, r);
  }
  function watchVoice() {
    const ids = D().dms.map((c) => 'dm-' + c.id).concat(voiceIds());
    window.Voice?.watch?.(ids);
  }
  function voiceIds() { return channels.filter(isVoice).map((c) => c.id); }

  NX.views.server = {
    enter(sideHost, mainHost, parts, r) {
      mountSide(sideHost); main = mainHost;
      offs = [
        NX.on('unread', NX.debounce(paintChannels, 50)),
        NX.on('call', () => { paintChannels(); paintVoice(); }),
        NX.on('call:speak', () => document.querySelectorAll('#chanList .vc-user[data-uid]').forEach((u) => u.classList.toggle('speaking', NX.call.speaking().has(u.dataset.uid)))),
        NX.on('live', () => { paintChannels(); if (active && isVoice(active)) paintVoice(); }),
        NX.on('presence', NX.debounce(paintMembers, 400)),
        NX.on('server:update', (s) => { if (srv?.id === s.id) { Object.assign(srv, s); paintTop(); applyAccent(); } }),
      ];
      return show(parts, r);
    },
    update: (parts, r) => show(parts, r),
    leave() {
      offs.forEach((f) => f()); offs = [];
      if (chat) { chat.hide(); chat = null; }
      const host = main?.querySelector('#chanMain');
      if (host?.querySelector('.call')) NX.call.unmount(host);
      if (srvChan) { window.db.removeChannel(srvChan); srvChan = null; }
      srv = null; active = null; side = null; main = null;
      resetAccent();
      window.Voice?.watch?.(D().dms.map((c) => 'dm-' + c.id));
    },
    viewingKey: () => (active && !isVoice(active) ? 'channel:' + active.id : null),
    step(d) {
      const list = channels.filter((c) => c.type !== 'category').sort((a, b) => {
        const pa = channels.find((p) => p.id === a.parent_id)?.position ?? -1, pb = channels.find((p) => p.id === b.parent_id)?.position ?? -1;
        return pa - pb || a.position - b.position;
      });
      const i = list.findIndex((c) => c.id === active?.id);
      const n = list[i + d];
      if (n) NX.go(`s/${srv.id}/${n.id}`);
    },
    invite, voiceIds,
    knownChannels: () => [...allChannels.values()].filter((c) => c.type !== 'category'),
    current: () => srv,
    perms: () => perms,
    invalidate(sid) { cache.delete(sid); },
    BIT,
  };
})();
