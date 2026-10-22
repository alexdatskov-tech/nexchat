/* App state: who you are, your servers, conversations, friends, unread
   counts, and the one realtime subscription that keeps them live.

   Loading is a single RPC (nx_inbox, supabase/nexchat_v3.sql). When that SQL
   has not been run yet, the same data is assembled from plain table queries
   and read state is kept on this device instead. */
(function () {
  const db = () => window.db;
  const people = () => NX.people;
  const D = {
    me: null,
    servers: [],          // [{ id, name, icon_url, owner_id, theme, unread }]
    dms: [],              // [{ id, is_group, name, people: [], last, unread, last_read_at }]
    friendships: [],      // raw rows (both directions)
    blocked: new Set(),
    chanUnread: new Map(),   // channel id -> count
    ready: false,
    v3: true,             // the nexchat_v3 SQL is installed
  };
  const P_dnd = () => NX.people.myStatus() === 'dnd';
  const missing = new Set();
  const isMissingFn = (e) => e && (e.code === 'PGRST202' || /Could not find the function|does not exist/i.test(e.message || ''));

  async function rpc(name, args) {
    if (missing.has(name)) return { data: null, error: { code: 'PGRST202', message: 'missing' }, missing: true };
    const res = await db().rpc(name, args);
    if (isMissingFn(res.error)) { missing.add(name); D.v3 = false; return { ...res, missing: true }; }
    return res;
  }

  /* ---------- local read state (fallback when nexchat_v3 isn't installed) ---------- */
  const READ_KEY = 'nx_read_v1';
  const localRead = NX.ls.get(READ_KEY, {});
  const saveLocalRead = NX.debounce(() => NX.ls.set(READ_KEY, localRead), 500);

  /* ---------- boot ---------- */
  async function loadMe(uid) {
    const { data, error } = await db().from('profiles').select('*').eq('id', uid).single();
    if (error) throw error;
    D.me = people().put(data);
    NX.me = D.me;
    // Platform staff powers, as configured by the owner (nx_can). The database
    // enforces them; the UI only uses this to hide what would be refused.
    D.staff = {};
    if (people().rank(D.me) >= 1) {
      await Promise.all(['post_anywhere', 'delete_messages', 'view_all_servers'].map(async (k) => {
        const { data: ok } = await db().rpc('nx_can', { p_perm: k });
        D.staff[k] = !!ok;
      })).catch(() => {});
    }
    return D.me;
  }

  async function loadInbox() {
    const { data, error, missing: gone } = await rpc('nx_inbox');
    if (!error && data) {
      // Private realtime channels need the policies from nexchat_v3.sql.
      NX.privateRT = Number(data.v) >= 3;
      D.servers = data.servers || [];
      D.dms = (data.dms || []).map((c) => ({ ...c, people: (c.people || []).map((p) => people().put(p)) }));
      D.friendships = (data.friendships || []).map((f) => { if (f.other) people().put(f.other); return f; });
    } else if (gone) {
      await loadInboxFallback();
    } else throw error;
    const sids = D.servers.map((s) => s.id);
    const [{ data: bl }, { data: chans }] = await Promise.all([
      db().from('blocked_users').select('blocked_id').eq('user_id', D.me.id),
      sids.length ? db().from('channels').select('id,server_id').in('server_id', sids) : Promise.resolve({ data: [] }),
    ]);
    D.blocked = new Set((bl || []).map((b) => b.blocked_id));
    (chans || []).forEach((c) => NX.chanServer.set(c.id, c.server_id));
    D.ready = true;
    NX.ls.set('nx_rail_cache', D.servers.map(({ id, name, icon_url }) => ({ id, name, icon_url })));
    emitAll();
  }

  async function loadInboxFallback() {
    const me = D.me.id;
    const [mem, parts, fr] = await Promise.all([
      db().from('server_members').select('server_id, joined_at').eq('user_id', me),
      db().from('dm_participants').select('conversation_id, last_read_at, joined_at').eq('user_id', me),
      db().from('friendships').select('*').or(`user_id.eq.${me},friend_id.eq.${me}`),
    ]);
    const sids = (mem.data || []).map((m) => m.server_id);
    const { data: srv } = sids.length ? await db().from('servers').select('id,name,icon_url,owner_id,theme,created_at').in('id', sids) : { data: [] };
    const joined = new Map((mem.data || []).map((m) => [m.server_id, m.joined_at]));
    D.servers = (srv || []).map((s) => ({ ...s, joined_at: joined.get(s.id), unread: false }))
      .sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)));

    const cids = (parts.data || []).map((p) => p.conversation_id);
    D.dms = [];
    if (cids.length) {
      const [cs, all, recent] = await Promise.all([
        db().from('dm_conversations').select('*').in('id', cids),
        db().from('dm_participants').select('conversation_id, user_id').in('conversation_id', cids),
        db().from('dm_messages').select('id,conversation_id,author_id,content,created_at').in('conversation_id', cids).order('created_at', { ascending: false }).limit(300),
      ]);
      const others = [...new Set((all.data || []).map((p) => p.user_id).filter((u) => u !== me))];
      await people().need(others);
      const lastBy = new Map();
      (recent.data || []).forEach((m) => { if (!lastBy.has(m.conversation_id)) lastBy.set(m.conversation_id, m); });
      D.dms = (cs.data || []).map((c) => {
        const last = lastBy.get(c.id) || null;
        const read = localRead['dm:' + c.id] || null;
        const unread = read ? (recent.data || []).filter((m) => m.conversation_id === c.id && m.author_id !== me && m.created_at > read).length : 0;
        if (!read && last) localRead['dm:' + c.id] = last.created_at;
        return {
          ...c, last, unread,
          people: (all.data || []).filter((p) => p.conversation_id === c.id && p.user_id !== me).map((p) => people().get(p.user_id)).filter(Boolean),
        };
      }).sort((a, b) => String(b.last?.created_at || b.created_at).localeCompare(String(a.last?.created_at || a.created_at)));
      saveLocalRead();
    }
    D.friendships = fr.data || [];
    await people().need(D.friendships.map((f) => (f.user_id === me ? f.friend_id : f.user_id)));
  }

  function emitAll() { NX.emit('servers'); NX.emit('dms'); NX.emit('friends'); NX.emit('unread'); }

  /* ---------- friends ---------- */
  function friendIds() {
    const me = D.me.id, out = new Set();
    D.friendships.forEach((f) => { if (f.status === 'accepted') out.add(f.user_id === me ? f.friend_id : f.user_id); });
    return [...out];
  }
  function incoming() { return D.friendships.filter((f) => f.status === 'pending' && f.friend_id === D.me.id).map((f) => f.user_id); }
  function outgoing() { return D.friendships.filter((f) => f.status === 'pending' && f.user_id === D.me.id).map((f) => f.friend_id); }
  function relation(uid) {
    if (!D.me || uid === D.me.id) return 'self';
    if (friendIds().includes(uid)) return 'friends';
    if (incoming().includes(uid)) return 'incoming';
    if (outgoing().includes(uid)) return 'outgoing';
    return null;
  }
  async function refreshFriends() {
    const me = D.me.id;
    const { data } = await db().from('friendships').select('*').or(`user_id.eq.${me},friend_id.eq.${me}`);
    D.friendships = data || [];
    await people().need(D.friendships.map((f) => (f.user_id === me ? f.friend_id : f.user_id)));
    NX.emit('friends');
  }
  async function addFriend(username) {
    username = String(username || '').trim().replace(/^@/, '');
    if (!username) return { error: 'Type a username.' };
    const { data, error } = await db().rpc('send_friend_request', { p_username: username });
    if (error) { NX.toast(error.message, { err: true }); return { error: error.message }; }
    await refreshFriends();
    const rel = relation(data);
    NX.toast(rel === 'friends' ? `You and @${username} are now friends.` : `Friend request sent to @${username}.`);
    return { ok: true };
  }
  async function acceptFriend(uid) {
    const { error } = await db().rpc('accept_friend_request', { p_from: uid });
    if (error) return NX.fail(error);
    await refreshFriends();
    NX.toast(`You and ${people().nameOf(people().get(uid))} are now friends.`);
  }
  async function removeFriend(uid, label, { ask = true, quiet = false } = {}) {
    const rel = relation(uid);
    if (ask && rel === 'friends' && !await NX.confirm({ title: `Remove ${label}`, body: `Remove ${label} from your friends?`, ok: 'Remove friend', danger: true })) return;
    const { error } = await db().rpc('remove_friend', { p_other: uid });
    if (error) return NX.fail(error);
    await refreshFriends();
    if (!quiet) NX.toast(rel === 'incoming' ? 'Request ignored.' : rel === 'outgoing' ? 'Request cancelled.' : 'Friend removed.');
  }
  const isBlocked = (uid) => D.blocked.has(uid);
  async function toggleBlock(uid, label) {
    if (isBlocked(uid)) {
      const { error } = await db().from('blocked_users').delete().eq('user_id', D.me.id).eq('blocked_id', uid);
      if (error) return NX.fail(error);
      D.blocked.delete(uid);
      NX.toast(`Unblocked ${label}.`);
    } else {
      if (!await NX.confirm({ title: `Block ${label}?`, body: 'They won’t be able to message you or send friend requests, and their messages are hidden from you.', ok: 'Block', danger: true })) return;
      const { error } = await db().from('blocked_users').insert({ user_id: D.me.id, blocked_id: uid });
      if (error) return NX.fail(error);
      D.blocked.add(uid);
      if (relation(uid)) await db().rpc('remove_friend', { p_other: uid });
      await refreshFriends();
      NX.toast(`Blocked ${label}.`);
    }
    NX.emit('blocked');
  }

  /* ---------- DMs ---------- */
  const dm = (id) => D.dms.find((c) => c.id === id) || null;
  function dmTitle(c) {
    if (!c) return 'Conversation';
    if (c.is_group) return c.name || c.people.map((p) => people().nameOf(p)).join(', ') || 'Group';
    return people().nameOf(c.people[0]);
  }
  async function reloadDms() {
    const { data, missing: gone } = await rpc('nx_inbox');
    if (data) {
      D.dms = (data.dms || []).map((c) => ({ ...c, people: (c.people || []).map((p) => people().put(p)) }));
      D.servers = data.servers || D.servers;
      D.friendships = data.friendships || D.friendships;
    } else if (gone) await loadInboxFallback();
    emitAll();
  }
  async function openDm(uid, o = {}) {
    const { data: cid, error } = await db().rpc('open_dm', { p_other: uid });
    if (error) return NX.fail(error);
    if (!dm(cid)) await reloadDms();
    if (o.send) {
      const { error: e2 } = await db().from('dm_messages').insert({ conversation_id: cid, author_id: D.me.id, content: o.send });
      if (e2) NX.fail(e2);
    }
    NX.go('dm/' + cid + (o.call ? '?call=1' : ''));
    return cid;
  }
  async function createGroup(name, ids) {
    const { data, error } = await db().rpc('create_group_dm', { p_name: name || '', p_members: ids });
    if (error) { NX.fail(error); return null; }
    await reloadDms();
    NX.go('dm/' + data);
    return data;
  }
  async function leaveDm(c) {
    if (!c.is_group) {
      // 1:1 threads can't be left server-side (there's no delete policy for the
      // other side); they are just hidden from the list until a new message.
      const hidden = NX.ls.get('nx_hidden_dms', {});
      hidden[c.id] = c.last?.created_at || new Date().toISOString();
      NX.ls.set('nx_hidden_dms', hidden);
      NX.emit('dms');
      if (NX.route().parts[1] === c.id) NX.go('home');
      return;
    }
    if (!await NX.confirm({ title: `Leave ${dmTitle(c)}?`, body: 'You won’t get messages from this group unless someone adds you back.', ok: 'Leave group', danger: true })) return;
    const { error } = await NX.must(db().from('dm_participants').delete().eq('conversation_id', c.id).eq('user_id', D.me.id));
    if (error) return NX.fail(error);
    D.dms = D.dms.filter((x) => x.id !== c.id);
    NX.emit('dms');
    if (NX.route().parts[1] === c.id) NX.go('home');
  }
  function visibleDms() {
    const hidden = NX.ls.get('nx_hidden_dms', {});
    return D.dms.filter((c) => {
      const h = hidden[c.id];
      return !h || (c.last && c.last.created_at > h) || NX.route().parts[1] === c.id;
    });
  }
  function markDmRead(cid) {
    const c = dm(cid);
    if (!c) return;
    const had = c.unread;
    c.unread = 0;
    c.last_read_at = new Date().toISOString();
    if (D.v3) rpc('nx_mark_dm_read', { p_conv: cid }).then(() => {}, () => {});
    if (!D.v3) { localRead['dm:' + cid] = c.last_read_at; saveLocalRead(); }
    if (had) { NX.emit('dms'); NX.emit('unread'); }
  }

  /* ---------- servers ---------- */
  const server = (id) => D.servers.find((s) => s.id === id) || null;
  async function reloadServers() {
    const { data, missing: gone } = await rpc('nx_inbox');
    if (data) D.servers = data.servers || [];
    else if (gone) await loadInboxFallback();
    NX.ls.set('nx_rail_cache', D.servers.map(({ id, name, icon_url }) => ({ id, name, icon_url })));
    NX.emit('servers'); NX.emit('unread');
  }
  const reloadServersSoon = NX.throttle(() => reloadServers().catch(() => {}), 10000);
  async function loadChannelUnreads(sid) {
    const { data, missing: gone } = await rpc('nx_channel_unreads', { p_server: sid });
    if (gone || !data) return;
    data.forEach((r) => D.chanUnread.set(r.channel_id, r.unread));
    NX.emit('unread');
  }
  function markChannelRead(cid, sid) {
    const had = D.chanUnread.get(cid);
    D.chanUnread.set(cid, 0);
    if (D.v3) rpc('nx_mark_channel_read', { p_channel: cid }).then(() => {}, () => {});
    const s = server(sid);
    if (s && s.unread) {
      // The server stays marked only if another channel still has something new.
      s.unread = [...D.chanUnread.entries()].some(([id, n]) => n > 0 && id !== cid && (NX.chanServer?.get(id) === sid));
      NX.emit('servers');
    }
    if (had) NX.emit('unread');
  }
  async function joinServer(code) {
    code = String(code || '').trim().replace(/^.*[?&]invite=([^&#]+).*$/, '$1').replace(/^.*\/(?:invite|i)\/([^/?#]+).*$/, '$1');
    if (!code) return null;
    const { data, error } = await db().rpc('join_server_by_invite', { p_code: code });
    if (error) { NX.toast(error.message, { err: true }); return null; }
    await reloadServers();
    NX.go('s/' + data);
    return data;
  }
  async function createServer(name, iconFile) {
    const { data, error } = await db().from('servers').insert({ name, owner_id: D.me.id }).select().single();
    if (error) { NX.fail(error); return null; }
    if (iconFile) {
      try {
        const up = await NX.files.uploadImage(iconFile, `servers/${data.id}`, { max: 512 });
        await NX.must(db().from('servers').update({ icon_url: up.url }).eq('id', data.id));
      } catch (e) { NX.fail(e, 'Icon upload failed'); }
    }
    await reloadServers();
    NX.go('s/' + data.id);
    return data.id;
  }
  async function leaveServer(s) {
    if (s.owner_id === D.me.id) return NX.toast('Owners can’t leave their own server. Transfer or delete it in Server settings.', { err: true });
    if (!await NX.confirm({ title: `Leave ${s.name}?`, body: `You won’t be able to rejoin unless you get a new invite.`, ok: 'Leave server', danger: true })) return;
    if (window.Voice?.state().active && window.Voice.state().serverId === s.id) await window.Voice.leave();
    const { error } = await NX.must(db().from('server_members').delete().eq('server_id', s.id).eq('user_id', D.me.id));
    if (error) return NX.fail(error);
    D.servers = D.servers.filter((x) => x.id !== s.id);
    NX.emit('servers');
    NX.go('home');
  }

  /* ---------- totals for the title / rail ---------- */
  function dmUnreadTotal() { return D.dms.reduce((a, c) => a + (D.blocked.has(c.people[0]?.id) && !c.is_group ? 0 : (c.unread || 0)), 0) + incoming().length; }
  function updateTitle() {
    const n = dmUnreadTotal();
    document.title = (n ? `(${n}) ` : '') + 'NexChat';
  }
  NX.on('unread', updateTitle); NX.on('dms', updateTitle); NX.on('friends', updateTitle);

  /* ---------- realtime: one channel for everything outside the open chat ---------- */
  let live = null, poll = null, liveOk = false;
  function startLive() {
    const me = D.me.id;
    if (live) db().removeChannel(live);
    live = db().channel('nx-inbox:' + me, { config: { private: !!NX.privateRT } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'dm_messages' }, ({ new: m }) => onDmMessage(m))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, ({ new: m }) => onChannelMessage(m))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, (p) => onFriendship(p))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'dm_participants', filter: `user_id=eq.${me}` }, () => reloadDms())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'server_members', filter: `user_id=eq.${me}` }, () => reloadServers())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'servers' }, ({ new: s }) => {
        const cur = server(s.id);
        if (cur) { Object.assign(cur, { name: s.name, icon_url: s.icon_url, theme: s.theme, owner_id: s.owner_id }); NX.emit('servers'); NX.emit('server:update', s); }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${me}` }, ({ new: p }) => {
        const wasNitro = D.me.is_nitro;
        Object.assign(D.me, p); people().put(p);
        if (p.is_banned) NX.guard.lock(p.ban_reason);
        if (p.is_nitro && !wasNitro) NX.toast('Nitro is now active on your account.', { icon: 'fa-bolt' });
        NX.emit('me');
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, ({ new: a }) => {
        NX.island({ title: a.title, body: 'New announcement', icon: 'fa-bullhorn', onClick: () => NX.go('home'), ms: 8000 });
        NX.emit('announcements');
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'announcements' }, () => NX.emit('announcements'))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          if (!liveOk && D.ready) catchUp();
          liveOk = true;
          clearInterval(poll); poll = null;
        } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          liveOk = false;
          if (!poll) poll = setInterval(() => { if (!document.hidden) catchUp(); }, 30000);
        }
      });
  }
  const catchUp = NX.throttle(() => { reloadDms().catch(() => {}); }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && D.ready && !liveOk) catchUp(); });
  window.addEventListener('online', () => { if (D.ready) { catchUp(); startLive(); } });

  async function onDmMessage(m) {
    let c = dm(m.conversation_id);
    let fresh = false;
    if (!c) { await reloadDms(); c = dm(m.conversation_id); if (!c) return; fresh = true; }
    c.last = { id: m.id, author_id: m.author_id, content: m.content, created_at: m.created_at, files: 0 };
    D.dms.sort((a, b) => String(b.last?.created_at || b.created_at).localeCompare(String(a.last?.created_at || a.created_at)));
    const mine = m.author_id === D.me.id;
    const viewing = NX.viewing === 'dm:' + c.id && !document.hidden;
    if (!mine && !viewing) {
      if (!fresh || !D.v3) c.unread = (c.unread || 0) + 1;   // a fresh inbox already counted it
      if (!D.blocked.has(m.author_id)) notifyDm(c, m);
    }
    if (viewing) markDmRead(c.id);
    NX.emit('dms'); NX.emit('unread');
  }
  async function notifyDm(c, m) {
    if (P_dnd()) return;
    await people().need([m.author_id]);
    const p = people().get(m.author_id);
    const body = m.content ? MD.plain(m.content, 90) : 'Sent an attachment';
    const title = c.is_group ? `${people().nameOf(p)} in ${dmTitle(c)}` : people().nameOf(p);
    if (document.hidden) desktopNotify(title, body, () => NX.go('dm/' + c.id));
    else NX.island({ avatar: people().avatar(p, 36, { halo: false, deco: false }), title, body, onClick: () => NX.go('dm/' + c.id) });
    sound();
  }
  function onChannelMessage(m) {
    if (m.author_id === D.me.id) return;
    const viewing = NX.viewing === 'channel:' + m.channel_id && !document.hidden;
    if (viewing) return;
    D.chanUnread.set(m.channel_id, (D.chanUnread.get(m.channel_id) || 0) + 1);
    const sid = NX.chanServer?.get(m.channel_id);
    const s = sid ? server(sid) : null;
    if (s) { s.unread = true; NX.emit('servers'); }
    else reloadServersSoon();   // a channel we haven't seen yet (new channel or server)
    // Mentions of you notify like a DM.
    const mentioned = MD.mentions(m.content).some((u) => u === D.me.username.toLowerCase() || u === 'everyone' || u === 'here');
    if (mentioned && !P_dnd()) {
      people().need([m.author_id]).then(() => {
        const p = people().get(m.author_id);
        const go = () => NX.go(`s/${sid || ''}/${m.channel_id}`);
        if (document.hidden) desktopNotify(`${people().nameOf(p)} mentioned you`, MD.plain(m.content, 90), go);
        else NX.island({ avatar: people().avatar(p, 36, { halo: false, deco: false }), title: `${people().nameOf(p)} mentioned you`, body: MD.plain(m.content, 90), onClick: go });
        sound();
      });
    }
    NX.emit('unread');
  }
  async function onFriendship(p) {
    const row = p.new && Object.keys(p.new).length ? p.new : p.old;
    await refreshFriends();
    if (p.eventType === 'INSERT' && row.friend_id === D.me.id && row.status === 'pending') {
      await people().need([row.user_id]);
      const who = people().get(row.user_id);
      NX.island({
        avatar: people().avatar(who, 36, { halo: false, deco: false }), title: people().nameOf(who), body: 'Sent you a friend request',
        onClick: () => NX.go('home/pending'),
        actions: [{ icon: 'fa-check', label: 'Accept', cls: 'ok', fn: () => acceptFriend(row.user_id) }, { icon: 'fa-xmark', label: 'Ignore', cls: 'no', fn: () => removeFriend(row.user_id, '', { ask: false }) }],
        ms: 9000,
      });
      sound();
    }
    if (p.eventType === 'UPDATE' && row.user_id === D.me.id && row.status === 'accepted') {
      const who = people().get(row.friend_id);
      NX.island({ avatar: people().avatar(who, 36, { halo: false, deco: false }), title: people().nameOf(who), body: 'Accepted your friend request', onClick: () => openDm(row.friend_id) });
    }
  }

  /* ---------- incoming calls ---------- */
  let callChan = null;
  function startCalls() {
    callChan = db().channel('nx-call:' + D.me.id, { config: { private: !!NX.privateRT } })
      .on('broadcast', { event: 'ring' }, async ({ payload }) => {
        // Everything in a ring comes from the caller's browser: only ids are
        // trusted, and the name and avatar are looked up here.
        const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!payload || payload.to !== D.me.id || !UUID.test(payload.from || '') || !UUID.test(payload.conversation || '')) return;
        if (D.blocked.has(payload.from)) return;
        if (!dm(payload.conversation)) await reloadDms();
        const conv = dm(payload.conversation);
        if (!conv || !conv.people.some((p) => p.id === payload.from)) return;
        if (window.Voice?.state().active && window.Voice.state().channel?.id === 'dm-' + payload.conversation) return;
        if (P_dnd()) return;
        await people().need([payload.from]);
        const caller = people().get(payload.from);
        const name = people().nameOf(caller);
        const go = (join) => NX.go(`dm/${payload.conversation}${join ? '?join=1' : ''}`);
        if (document.hidden) desktopNotify(`${name} is calling`, 'Click to answer', () => go(true));
        NX.island({
          ring: true, avatar: people().avatar(caller, 36, { halo: false, deco: false }), icon: 'fa-phone', title: `${name} is calling`, body: payload.video ? 'Video call' : 'Voice call', ms: 30000,
          onClick: () => go(false),
          actions: [{ icon: 'fa-phone', label: 'Join', cls: 'ok', fn: () => go(true) }, { icon: 'fa-phone-slash', label: 'Decline', cls: 'no', fn: () => {} }],
        });
        ringtone();
      })
      .subscribe();
  }
  // Rings go out over Realtime's REST endpoint: sending only needs the write
  // permission, while joining someone else's private ring channel isn't allowed.
  function ring(uid, payload) {
    const body = { conversation: payload.conversation, video: !!payload.video, to: uid, from: D.me.id };
    const ch = db().channel('nx-call:' + uid, { config: { private: !!NX.privateRT } });
    const done = () => db().removeChannel(ch);
    if (typeof ch.httpSend === 'function') {
      ch.httpSend('ring', body).then(done, () => { fallback(); });
    } else fallback();
    function fallback() {
      const t = setTimeout(done, 6000);
      ch.subscribe((s) => {
        if (s === 'SUBSCRIBED') { ch.send({ type: 'broadcast', event: 'ring', payload: body }); clearTimeout(t); setTimeout(done, 1500); }
        else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) { clearTimeout(t); done(); }
      });
    }
  }

  /* ---------- sounds + desktop notifications ---------- */
  let actx = null;
  function beep(freqs, len = 0.09, gap = 0.1, vol = 0.05) {
    if (NX.ls.get('nx_sounds', true) === false) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      freqs.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        const t = actx.currentTime + i * gap;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(actx.destination); o.start(t); o.stop(t + len + 0.02);
      });
    } catch {}
  }
  const sound = NX.throttle(() => beep([880, 1320], 0.12, 0.09), 1500);
  const ringtone = () => beep([660, 880, 660, 880], 0.18, 0.22, 0.06);
  function desktopNotify(title, body, onClick) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || NX.ls.get('nx_desktop_notify', true) === false) return;
    try {
      const n = new Notification(title, { body, icon: 'assets/img/logo.svg', tag: 'nx-' + title });
      n.onclick = () => { window.focus(); onClick?.(); n.close(); };
    } catch {}
  }

  /* ---------- ban guard ---------- */
  NX.guard = {
    locked: false,
    lock(reason) {
      if (NX.guard.locked) return;
      NX.guard.locked = true;
      try { window.Voice?.leave(); } catch {}
      document.querySelectorAll('audio, video').forEach((v) => { try { v.pause(); } catch {} });
      NX.guard.screen({ reason, userId: D.me?.id });
    },
    screen({ reason, userId, onExit, exitText }) {
      if (document.querySelector('.ban-screen')) return;
      const el = NX.h(`<div class="ban-screen" role="alertdialog" aria-modal="true"><div class="ban-card">
        <div class="ban-ico"><i class="fa-solid fa-ban"></i></div>
        <h1>Account banned</h1>
        <p>Your access to NexChat has been revoked by an administrator.</p>
        ${reason ? `<div class="reason"><span>Reason</span><p>${NX.esc(reason)}</p></div>` : ''}
        <div class="acts">${userId ? '<button class="btn btn-ghost" data-a="appeal">Appeal this ban</button>' : ''}<button class="btn btn-danger" data-a="out">${NX.esc(exitText || 'Sign out')}</button></div>
        <form class="hidden"><label class="label">Tell an administrator why this should be reviewed</label>
          <textarea class="input" rows="4" maxlength="2000" required placeholder="Explain what happened, in your own words."></textarea>
          <button class="btn btn-primary">Submit appeal</button><p class="err"></p></form>
      </div></div>`);
      document.body.appendChild(el);
      el.querySelector('[data-a="out"]').onclick = async () => {
        if (onExit) return onExit();
        try { await db().auth.signOut(); } catch {}
        NX.reload();
      };
      el.querySelector('[data-a="appeal"]')?.addEventListener('click', () => el.querySelector('form').classList.toggle('hidden'));
      el.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const text = e.target.querySelector('textarea').value.trim();
        const err = e.target.querySelector('.err');
        if (text.length < 10) { err.textContent = 'Please write at least a sentence.'; return; }
        const { error } = await db().from('ban_appeals').insert({ user_id: userId, message: text });
        if (error) { err.textContent = /duplicate|unique/i.test(error.message) ? 'You already have an appeal waiting to be reviewed.' : error.message; return; }
        e.target.innerHTML = '<p style="color:var(--ok)">Appeal submitted. You’ll be able to sign in again if it’s accepted.</p>';
      };
    },
  };
  // A slow safety poll: realtime is the fast path for bans.
  setInterval(async () => {
    if (!D.me || NX.guard.locked || document.hidden) return;
    const { data } = await db().from('profiles').select('is_banned, ban_reason').eq('id', D.me.id).maybeSingle();
    if (data?.is_banned) NX.guard.lock(data.ban_reason);
  }, 60000);

  Object.assign(D, {
    rpc, loadMe, loadInbox, reloadDms, reloadServers, startLive, startCalls, ring,
    friendIds, incoming, outgoing, relation, refreshFriends, addFriend, acceptFriend, removeFriend, isBlocked, toggleBlock,
    dm, dmTitle, openDm, createGroup, leaveDm, visibleDms, markDmRead,
    server, loadChannelUnreads, markChannelRead, joinServer, createServer, leaveServer,
    dmUnreadTotal, desktopNotify, sound, beep,
  });
  NX.data = D;
  NX.chanServer = new Map();   // channel id -> server id, filled as servers are opened
})();
