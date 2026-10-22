/* Server settings page (#/s/<id>/settings/<tab>): overview + appearance,
   channels, roles, members, invites, bans, delete. Opens as an overlay page,
   so a call in the background keeps running. */
(function () {
  const { esc } = NX;
  const P = () => NX.people;
  const BIT = { VIEW: 1, SEND: 2, MANAGE_MESSAGES: 4, MANAGE_CHANNELS: 8, MANAGE_ROLES: 16, KICK: 32, BAN: 64, MANAGE_SERVER: 128, INVITE: 256, NICK: 16384, ADMIN: 65536 };
  const PERMS = [
    ['VIEW_CHANNEL', 1, 'View channels', 'Read text channels and see voice channels.'],
    ['SEND_MESSAGES', 2, 'Send messages', 'Post in text channels.'],
    ['MANAGE_MESSAGES', 4, 'Manage messages', 'Delete and pin other people’s messages.'],
    ['MANAGE_CHANNELS', 8, 'Manage channels', 'Create, edit and delete channels.'],
    ['MANAGE_ROLES', 16, 'Manage roles', 'Create and edit roles below their own, and assign them.'],
    ['KICK_MEMBERS', 32, 'Kick members', 'Remove people from the server. They can rejoin with an invite.'],
    ['BAN_MEMBERS', 64, 'Ban members', 'Remove people for good.'],
    ['MANAGE_SERVER', 128, 'Manage server', 'Change the server’s name, icon and look.'],
    ['CREATE_INVITE', 256, 'Create invites', 'Invite new people.'],
    ['CONNECT_VOICE', 512, 'Connect to voice', 'Join voice channels.'],
    ['SPEAK', 1024, 'Speak', 'Talk in voice channels.'],
    ['VIDEO', 2048, 'Video', 'Turn on a camera or share a screen in voice.'],
    ['MUTE_MEMBERS', 4096, 'Mute members', 'Mute other people in voice.'],
    ['DEAFEN_MEMBERS', 8192, 'Deafen members', 'Deafen other people in voice.'],
    ['MANAGE_NICKNAMES', 16384, 'Manage nicknames', 'Change other members’ nicknames.'],
    ['MANAGE_EMOJIS', 32768, 'Manage emoji', 'Add and remove custom emoji.'],
    ['ADMINISTRATOR', 65536, 'Administrator', 'Every permission, and bypasses channel overrides. Grant with care.'],
  ];
  const DEFAULT_PERMS = 1 + 2 + 256 + 512 + 1024;
  const ACCENTS = ['#7C6CFF', '#2FBF87', '#3B9EF5', '#8B7CF6', '#E8659A', '#E8B04B', '#E5484D', '#5AC8D8', '#94A3B8'];
  const NAME_COLORS = ['#FFFFFF', '#EDEBEF', '#2FBF87', '#3B9EF5', '#8B7CF6', '#E8659A', '#E8B04B', '#E5484D'];
  const FONTS = {
    display: ['Display', 'var(--f-display)'], body: ['Sans', 'var(--f-ui)'], mono: ['Mono', 'var(--f-mono)'],
    serif: ['Serif', "Georgia, 'Times New Roman', serif"], rounded: ['Rounded', "'Trebuchet MS', 'Segoe UI', sans-serif"],
  };
  const HEX = /^#[0-9a-f]{6}$/i;

  let host = null, pg = null, sid = null, srv = null, perms = 0, tab = 'overview';
  let roles = [], memberRoles = [], members = [], channels = [];
  let draft = null, selRole = null, roleDraft = null;

  const isOwner = () => srv && srv.owner_id === NX.me.id;
  const staff = () => P().rank(NX.me) >= 1;
  const can = (bit) => isOwner() || staff() || (perms & BIT.ADMIN) !== 0 || (perms & bit) !== 0;
  const canOverview = () => isOwner() || staff();   // servers update policy: owner or platform admin

  /* ---------- tabs ---------- */
  function tabs() {
    return [
      { title: srv.name, items: [
        { id: 'overview', label: 'Overview', icon: 'fa-sliders', hidden: !canOverview() },
        { id: 'roles', label: 'Roles', icon: 'fa-shield-halved', hidden: !can(BIT.MANAGE_ROLES) },
        { id: 'channels', label: 'Channels', icon: 'fa-hashtag', hidden: !can(BIT.MANAGE_CHANNELS) },
      ] },
      { title: 'People', items: [
        { id: 'members', label: 'Members', icon: 'fa-user-group', hidden: !(can(BIT.KICK) || can(BIT.BAN) || can(BIT.MANAGE_ROLES) || can(BIT.NICK)) },
        { id: 'invites', label: 'Invites', icon: 'fa-link', hidden: !(can(BIT.INVITE) || can(BIT.MANAGE_CHANNELS)) },
        { id: 'bans', label: 'Bans', icon: 'fa-ban', hidden: !can(BIT.BAN) },
      ] },
      { title: '', items: [{ id: 'danger', label: 'Delete server', icon: 'fa-trash-can', danger: true, hidden: !(isOwner() || staff()) }] },
    ];
  }
  const allowed = () => tabs().flatMap((s) => s.items).filter((i) => !i.hidden).map((i) => i.id);

  async function load() {
    const { data, error } = await window.db.from('servers').select('*').eq('id', sid).maybeSingle();
    if (error || !data) return false;
    srv = data;
    const cur = NX.views.server?.current?.();
    if (cur?.id === sid) perms = Number(NX.views.server.perms()) || 0;
    else {
      const { data: pm } = await window.db.rpc('member_permissions', { p_server_id: sid, p_user_id: NX.me.id });
      perms = Number(pm) || 0;
    }
    return true;
  }
  function touched() { NX.views.server?.invalidate?.(sid); }

  async function enter(h, parts) {
    host = h;
    sid = parts[1];
    tab = parts[3] || '';
    host.innerHTML = '<div style="margin:auto"><span class="spinner"></span></div>';
    if (!await load()) {
      host.innerHTML = '<div class="empty" style="margin:auto"><div class="ico"><i class="fa-solid fa-ghost"></i></div><h3>Server not found</h3><button class="btn btn-primary" data-x>Close</button></div>';
      host.querySelector('[data-x]').onclick = () => NX.closePage();
      return;
    }
    const ok = allowed();
    if (!ok.length) {
      host.innerHTML = '<div class="empty" style="margin:auto"><div class="ico"><i class="fa-solid fa-lock"></i></div><h3>No access</h3><p>You don’t have permission to manage this server.</p><button class="btn btn-primary" data-x>Close</button></div>';
      host.querySelector('[data-x]').onclick = () => NX.closePage();
      return;
    }
    if (!ok.includes(tab)) tab = ok[0];
    pg = NX.pageShell(host, {
      sections: tabs(), active: tab, kind: 'server', onSelect: (id) => NX.go(`s/${sid}/settings/${id}`),
      brand: `<div class="pb-logo"><span class="lg" style="${srv.icon_url ? 'background:var(--bg-4)' : ''};overflow:hidden">${srv.icon_url ? `<img ${NX.people.imgAttr(srv.icon_url)} alt="" style="width:100%;height:100%;object-fit:cover">` : esc((srv.name || '?')[0].toUpperCase())}</span><div class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${esc(srv.name)}</b><small>Server settings</small></div></div>`,
    });
    render();
  }
  function update(parts) {
    if (parts[1] !== sid) { leave(); return enter(host, parts); }
    const t = parts[3] || allowed()[0];
    if (t === tab) return;
    if (!pg.guard()) { NX.go(`s/${sid}/settings/${tab}`, { replace: true, silent: true }); return; }
    tab = allowed().includes(t) ? t : allowed()[0];
    pg.setActive(tab);
    render();
  }
  function leave() { revokePreview(); pg = null; host = null; draft = null; selRole = null; roleDraft = null; }

  function render() {
    pg.dirty(false);
    const b = pg.body;
    b.innerHTML = '';
    ({ overview, roles: rolesTab, channels: channelsTab, members: membersTab, invites: invitesTab, bans: bansTab, danger: dangerTab }[tab] || overview)(b);
  }

  /* ---------- overview + appearance ---------- */
  let fontPreview = '', fontPending = null;
  function revokePreview() { if (fontPreview) URL.revokeObjectURL(fontPreview); fontPreview = ''; fontPending = null; }
  function freshDraft() {
    const t = srv.theme || {};
    return {
      name: srv.name || '', description: srv.description || '', icon_url: srv.icon_url || null, banner_url: srv.banner_url || null,
      accent: HEX.test(t.accent || '') ? t.accent : '#7C6CFF',
      name_color: HEX.test(t.name_color || '') ? t.name_color : '#FFFFFF',
      name_font: FONTS[t.name_font] || t.name_font === 'google' || t.name_font === 'upload' ? t.name_font : 'display',
      name_font_url: t.name_font_url || '', name_font_file: t.name_font_file || '',
    };
  }
  function googleHref(raw) {
    const m = String(raw || '').replace(/&amp;/g, '&').match(/https:\/\/fonts\.googleapis\.com\/css2?\?[^\s'"()<>]+/);
    if (!m) return '';
    try { const u = new URL(m[0]); return u.searchParams.get('family') ? u.href : ''; } catch { return ''; }
  }
  function famHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return 'NxSrvFont' + (h >>> 0).toString(36); }
  function fontStack(d) {
    if (d.name_font === 'google' && d.name_font_url) {
      const href = googleHref(d.name_font_url);
      if (href) {
        if (!document.querySelector(`link[data-ssfont="${CSS.escape(href)}"]`)) {
          const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.dataset.ssfont = href; document.head.appendChild(l);
        }
        const fam = (new URL(href).searchParams.get('family') || '').split(':')[0].replace(/\+/g, ' ').replace(/'/g, '');
        return `'${fam}', var(--f-display)`;
      }
    }
    if (d.name_font === 'upload') {
      const url = fontPreview || d.name_font_file;
      if (url) {
        const fam = famHash(url);
        if (!document.querySelector(`style[data-ssfont="${fam}"]`)) {
          const st = document.createElement('style'); st.dataset.ssfont = fam;
          st.textContent = `@font-face{font-family:'${fam}';src:url("${url.replace(/"/g, '%22')}");font-display:swap;}`;
          document.head.appendChild(st);
        }
        return `'${fam}', var(--f-display)`;
      }
    }
    return (FONTS[d.name_font] || FONTS.display)[1];
  }
  function isDirty() {
    const f = freshDraft();
    return !!fontPending || Object.keys(f).some((k) => (f[k] || '') !== (draft[k] || ''));
  }

  function overview(b) {
    draft = freshDraft();
    revokePreview();
    b.innerHTML = `<h1 class="page-title">Server overview</h1>
      <div class="two-col">
        <div class="stack">
          <div class="card stack">
            <div class="field"><label>Server name</label><input class="input" data-k="name" maxlength="100"></div>
            <div class="field"><label>Description</label><textarea class="input" data-k="description" rows="3" maxlength="300" placeholder="What’s this server about?"></textarea></div>
          </div>
          <div class="card"><h3>Icon</h3><p>Square images work best. Shown in the server list.</p><div data-icon></div></div>
          <div class="card"><h3>Banner</h3><p>Wide image shown above the channel list.</p><div data-banner></div></div>
          <h2 class="sec-title">Appearance</h2>
          <div class="card"><h3>Accent colour</h3><p>The highlight colour for this server.</p>
            <div class="swatches" data-sw="accent">${ACCENTS.map((c) => `<span class="swatch" data-c="${c}" style="background:${c}"></span>`).join('')}
              <input type="color" data-color="accent"><input class="input mono" data-hex="accent" maxlength="7" style="max-width:110px"></div></div>
          <div class="card stack"><div><h3>Server name style</h3><p style="margin:0">Colour and typeface of the server name in the sidebar.</p></div>
            <div class="swatches" data-sw="name_color">${NAME_COLORS.map((c) => `<span class="swatch" data-c="${c}" style="background:${c}"></span>`).join('')}
              <input type="color" data-color="name_color"><input class="input mono" data-hex="name_color" maxlength="7" style="max-width:110px"></div>
            <div class="field"><label>Typeface</label><select class="input" data-k="name_font" style="max-width:260px">
              ${Object.entries(FONTS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join('')}<option value="google">Google Font…</option><option value="upload">Upload a font…</option></select></div>
            <div class="field" data-src="google"><label>Google Fonts URL</label><input class="input mono" data-k="name_font_url" spellcheck="false" placeholder="https://fonts.googleapis.com/css2?family=Rubik+Glitch&display=swap">
              <span class="hint">Pick a family on fonts.google.com and paste its <code>@import</code> or <code>&lt;link&gt;</code> URL. Only fonts.googleapis.com links work.</span><p class="err" data-fonterr></p></div>
            <div class="field" data-src="upload"><label>Font file</label>
              <div class="row"><label class="btn btn-ghost btn-sm"><i class="fa-solid fa-upload"></i>Choose file<input type="file" data-fontfile accept=".woff2,.woff,.ttf,.otf" hidden></label><span class="hint" data-fontname></span></div>
              <span class="hint">WOFF2, WOFF, TTF or OTF, up to 3 MB.</span></div>
            <div><button class="btn btn-quiet btn-sm" data-namereset><i class="fa-solid fa-rotate-left"></i>Reset name style</button></div>
          </div>
        </div>
        <div class="sticky"><h2 class="sec-title">Preview</h2><div class="ss-preview"></div></div>
      </div>`;
    const set = (k, v) => { draft[k] = v; sync(); };
    b.querySelectorAll('[data-k]').forEach((i) => { i.value = draft[i.dataset.k] || ''; i.addEventListener('input', () => set(i.dataset.k, i.value)); i.addEventListener('change', () => set(i.dataset.k, i.value)); });
    b.querySelectorAll('[data-sw]').forEach((sw) => sw.addEventListener('click', (e) => { const s = e.target.closest('[data-c]'); if (s) set(sw.dataset.sw, s.dataset.c); }));
    b.querySelectorAll('[data-color]').forEach((i) => i.addEventListener('input', () => set(i.dataset.color, i.value.toUpperCase())));
    b.querySelectorAll('[data-hex]').forEach((i) => i.addEventListener('input', () => { const v = i.value.trim(); if (HEX.test(v)) set(i.dataset.hex, v.toUpperCase()); }));
    b.querySelector('[data-namereset]').onclick = () => { revokePreview(); Object.assign(draft, { name_color: '#FFFFFF', name_font: 'display', name_font_url: '', name_font_file: '' }); paintFields(); sync(); };
    b.querySelector('[data-fontfile]').onchange = (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      if (!/\.(woff2?|ttf|otf)$/i.test(f.name)) return NX.toast('Use a WOFF2, WOFF, TTF or OTF file.', { err: true });
      if (f.size > 3 * 1024 * 1024) return NX.toast('Font files must be under 3 MB.', { err: true });
      revokePreview();
      fontPending = f; fontPreview = URL.createObjectURL(f);
      sync();
    };
    const icon = NX.imagePicker({
      url: draft.icon_url, shape: 'square', label: 'Upload icon',
      onPick: async (f) => { const up = await NX.files.uploadImage(f, `servers/${sid}`, { max: 512 }); set('icon_url', up.url); return up.url; },
      onClear: () => set('icon_url', null),
    });
    const banner = NX.imagePicker({
      url: draft.banner_url, shape: 'wide', label: 'Upload banner',
      onPick: async (f) => { const up = await NX.files.uploadImage(f, `servers/${sid}`, { max: 1920 }); set('banner_url', up.url); return up.url; },
      onClear: () => set('banner_url', null),
    });
    b.querySelector('[data-icon]').appendChild(icon.el);
    b.querySelector('[data-banner]').appendChild(banner.el);

    function paintFields() {
      b.querySelectorAll('[data-k]').forEach((i) => { if (document.activeElement !== i) i.value = draft[i.dataset.k] || ''; });
      ['accent', 'name_color'].forEach((k) => {
        b.querySelector(`[data-color="${k}"]`).value = draft[k].toLowerCase();
        const hx = b.querySelector(`[data-hex="${k}"]`); if (document.activeElement !== hx) hx.value = draft[k];
        b.querySelectorAll(`[data-sw="${k}"] [data-c]`).forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === draft[k].toLowerCase()));
      });
      b.querySelector('[data-src="google"]').classList.toggle('hidden', draft.name_font !== 'google');
      b.querySelector('[data-src="upload"]').classList.toggle('hidden', draft.name_font !== 'upload');
      b.querySelector('[data-fontname]').textContent = fontPending ? fontPending.name : draft.name_font_file ? 'Saved font in use' : 'No file chosen';
      const bad = draft.name_font === 'google' && draft.name_font_url && !googleHref(draft.name_font_url);
      b.querySelector('[data-fonterr]').textContent = bad ? 'That doesn’t look like a fonts.googleapis.com URL.' : '';
      [[icon, draft.icon_url], [banner, draft.banner_url]].forEach(([pk, v]) => { if (!pk.el.classList.contains('busy') && (pk.get() || null) !== (v || null)) pk.set(v); });
    }
    function paintPreview() {
      const pv = b.querySelector('.ss-preview');
      const initials = (draft.name || '?').trim().split(/\s+/).slice(0, 3).map((w) => [...w][0] || '').join('').toUpperCase() || '?';
      pv.innerHTML = `<div class="ss-pv-side">
        <div class="ss-pv-banner"${draft.banner_url ? '' : ' hidden'}></div>
        <div class="ss-pv-head"><span class="ss-pv-name" style="color:${draft.name_color};font-family:${esc(fontStack(draft))}">${esc(draft.name || 'Server name')}</span><i class="fa-solid fa-chevron-down"></i></div>
        <div class="ss-pv-ch"><i class="fa-solid fa-hashtag"></i>general</div>
        <div class="ss-pv-ch on" style="box-shadow:inset 3px 0 0 ${draft.accent}"><i class="fa-solid fa-hashtag"></i>announcements</div>
        <div class="ss-pv-ch"><i class="fa-solid fa-volume-high"></i>Lounge</div></div>
        <div class="ss-pv-card"><span class="ss-pv-ico" ${draft.icon_url ? '' : `style="background:${draft.accent}"`}>${draft.icon_url ? '' : esc(initials)}</span>
          <div><b>${esc(draft.name || 'Server name')}</b><small>${esc(draft.description || 'No description yet.')}</small></div></div>`;
      const setImg = (el, url) => NX.files.resolved(url).then((u) => { el.style.backgroundImage = `url("${String(u).replace(/"/g, '%22')}")`; }).catch(() => {});
      if (draft.banner_url) setImg(pv.querySelector('.ss-pv-banner'), draft.banner_url);
      if (draft.icon_url) setImg(pv.querySelector('.ss-pv-ico'), draft.icon_url);
    }
    function sync() {
      paintFields(); paintPreview();
      pg.dirty(isDirty(), { onSave: save, onReset: () => { revokePreview(); draft = freshDraft(); paintFields(); paintPreview(); pg.dirty(false); } });
    }
    async function save() {
      const name = draft.name.trim();
      if (name.length < 2) throw new Error('The server needs a name of at least 2 characters.');
      if (draft.name_font === 'google' && !googleHref(draft.name_font_url)) throw new Error('Paste a fonts.googleapis.com URL, or pick another typeface.');
      if (draft.name_font === 'upload' && !fontPending && !draft.name_font_file) throw new Error('Choose a font file, or pick another typeface.');
      if (fontPending) {
        const up = await NX.files.put(`servers/${sid}/fonts`, fontPending);
        draft.name_font_file = up.url;
      }
      const patch = {
        name, description: draft.description.trim() || null, icon_url: draft.icon_url || null, banner_url: draft.banner_url || null,
        theme: {
          ...(srv.theme || {}), accent: draft.accent, name_color: draft.name_color, name_font: draft.name_font,
          name_font_url: draft.name_font === 'google' ? googleHref(draft.name_font_url) : (draft.name_font_url ? googleHref(draft.name_font_url) || null : null),
          name_font_file: draft.name_font_file || null,
        },
      };
      const { data, error } = await window.db.from('servers').update(patch).eq('id', sid).select().maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('You don’t have permission to change this server.');
      srv = data;
      revokePreview();
      draft = freshDraft();
      touched();
      NX.data.reloadServers();
      NX.emit('server:update', srv);
      paintFields(); paintPreview();
      pg.dirty(false);
      NX.toast('Server updated.');
    }
    paintFields(); paintPreview();
  }

  /* ---------- channels ---------- */
  const chIcon = (t) => (t === 'voice' || t === 'stage' ? 'fa-volume-high' : t === 'category' ? 'fa-folder' : t === 'announcement' ? 'fa-bullhorn' : 'fa-hashtag');
  async function loadChannels() {
    const { data, error } = await window.db.from('channels').select('*').eq('server_id', sid).order('position');
    if (error) throw error;
    channels = data || [];
  }
  async function channelsTab(b) {
    b.innerHTML = `<h1 class="page-title">Channels</h1><p class="lead">Rename, reorder and organise channels into categories.</p>
      <div class="toolbar"><button class="btn btn-primary btn-sm" data-a="newch"><i class="fa-solid fa-plus"></i>Create channel</button><button class="btn btn-ghost btn-sm" data-a="newcat"><i class="fa-solid fa-folder-plus"></i>Create category</button></div>
      <div class="ss-chlist"><div style="padding:20px;display:flex;justify-content:center"><span class="spinner"></span></div></div>`;
    b.querySelector('[data-a="newch"]').onclick = () => editChannel(null, b);
    b.querySelector('[data-a="newcat"]').onclick = async () => {
      const name = await NX.prompt({ title: 'Create category', label: 'Category name', max: 100, ok: 'Create' });
      if (!name) return;
      const { error } = await window.db.from('channels').insert({ server_id: sid, name, type: 'category', position: channels.filter((c) => c.type === 'category').length });
      if (error) return NX.fail(error);
      touched(); paintChannels(b);
    };
    paintChannels(b);
  }
  async function paintChannels(b) {
    try { await loadChannels(); } catch (e) { return NX.fail(e); }
    const list = b.querySelector('.ss-chlist');
    if (!list) return;
    const cats = channels.filter((c) => c.type === 'category').sort((a, z) => a.position - z.position);
    const groups = [{ cat: null, kids: channels.filter((c) => c.type !== 'category' && !c.parent_id) }, ...cats.map((cat) => ({ cat, kids: channels.filter((c) => c.parent_id === cat.id) }))];
    const row = (c, arr, i) => `<div class="ss-ch${c.type === 'category' ? ' cat' : ''}" data-id="${esc(c.id)}">
      <i class="fa-solid ${chIcon(c.type)}"></i><div class="grow"><b>${esc(c.name)}</b>${c.topic ? `<small>${esc(c.topic)}</small>` : ''}</div>
      <button class="icon-btn sm" data-a="up" title="Move up"${i === 0 ? ' disabled' : ''}><i class="fa-solid fa-arrow-up"></i></button>
      <button class="icon-btn sm" data-a="down" title="Move down"${i === arr.length - 1 ? ' disabled' : ''}><i class="fa-solid fa-arrow-down"></i></button>
      <button class="icon-btn sm" data-a="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
      <button class="icon-btn sm danger" data-a="del" title="Delete"><i class="fa-solid fa-trash-can"></i></button></div>`;
    list.innerHTML = groups.map((g) => {
      const kids = g.kids.sort((a, z) => a.position - z.position);
      if (!g.cat && !kids.length) return '';
      return `<div class="ss-chgroup">${g.cat ? row(g.cat, cats, cats.indexOf(g.cat)) : '<div class="ss-ch cat muted"><i class="fa-solid fa-folder-open"></i><div class="grow"><b>No category</b></div></div>'}
        <div class="ss-chkids">${kids.map((c, i) => row(c, kids, i)).join('') || '<div class="hint" style="padding:8px 14px">Empty category</div>'}</div></div>`;
    }).join('') || '<div class="empty"><p>No channels yet.</p></div>';
    list.onclick = async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      const c = channels.find((x) => x.id === e.target.closest('[data-id]')?.dataset.id);
      if (!a || !c) return;
      if (a === 'edit') return editChannel(c, b);
      if (a === 'del') {
        if (!await NX.confirm({ title: `Delete ${c.type === 'category' ? 'category' : '#' + c.name}?`, body: c.type === 'category' ? 'Channels inside it stay, without a category.' : 'Every message in it goes too. This can’t be undone.', danger: true })) return;
        const { error } = await window.db.from('channels').delete().eq('id', c.id);
        if (error) return NX.fail(error);
        NX.Chat?.drop?.('channel:' + c.id);
        touched(); NX.toast('Channel deleted.'); return paintChannels(b);
      }
      if (a === 'up' || a === 'down') {
        const sibs = channels.filter((x) => (c.type === 'category' ? x.type === 'category' : x.type !== 'category' && (x.parent_id || null) === (c.parent_id || null))).sort((p, q) => p.position - q.position);
        const i = sibs.indexOf(c), j = i + (a === 'up' ? -1 : 1);
        if (j < 0 || j >= sibs.length) return;
        [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
        const res = await Promise.all(sibs.map((x, k) => (x.position === k ? null : window.db.from('channels').update({ position: k }).eq('id', x.id))).filter(Boolean));
        const err = res.find((r) => r.error);
        if (err) NX.fail(err.error);
        touched(); paintChannels(b);
      }
    };
  }
  function editChannel(c, b) {
    const cats = channels.filter((x) => x.type === 'category');
    const isCat = c?.type === 'category';
    const body = NX.h(`<div class="stack">
      ${c ? '' : `<div class="field"><label>Type</label><select class="input" data-t><option value="text">Text</option><option value="voice">Voice</option><option value="announcement">Announcement</option></select></div>`}
      <div class="field"><label>Name</label><input class="input" data-n maxlength="100" value="${esc(c?.name || '')}" placeholder="new-channel"></div>
      ${isCat ? '' : `<div class="field" data-tw><label>Topic</label><input class="input" data-topic maxlength="1024" value="${esc(c?.topic || '')}" placeholder="What’s this channel about?"></div>
      <div class="field"><label>Category</label><select class="input" data-p><option value="">No category</option>${cats.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></div>`}</div>`);
    if (!isCat) {
      const fitCat = (type) => cats.find((cat) => { const k = channels.filter((x) => x.parent_id === cat.id); return k.length && k.every((x) => (x.type === 'voice' || x.type === 'stage') === (type === 'voice')); })?.id || '';
      const sel = body.querySelector('[data-p]');
      sel.value = c ? (c.parent_id || '') : fitCat('text');
      body.querySelector('[data-t]')?.addEventListener('change', (e) => { sel.value = fitCat(e.target.value); body.querySelector('[data-tw]').classList.toggle('hidden', e.target.value === 'voice'); });
    }
    const m = NX.modal({
      title: c ? (isCat ? 'Edit category' : 'Edit channel') : 'Create channel', body,
      foot: [{ label: 'Cancel' }, {
        label: c ? 'Save' : 'Create', cls: 'btn-primary', primary: true, onClick: async () => {
          const name = body.querySelector('[data-n]').value.trim().replace(/^#/, '');
          if (!name) { NX.toast('Give it a name.', { err: true }); return false; }
          const patch = { name };
          if (!isCat) { patch.topic = body.querySelector('[data-topic]').value.trim() || null; patch.parent_id = body.querySelector('[data-p]').value || null; }
          if (c) {
            const { error } = await window.db.from('channels').update(patch).eq('id', c.id);
            if (error) throw error;
          } else {
            const type = body.querySelector('[data-t]').value;
            if (type === 'voice') delete patch.topic;
            const pos = channels.filter((x) => x.type !== 'category' && (x.parent_id || null) === patch.parent_id).length;
            const { error } = await window.db.from('channels').insert({ ...patch, server_id: sid, type, position: pos });
            if (error) throw error;
          }
          touched(); NX.toast(c ? 'Channel updated.' : 'Channel created.');
          paintChannels(b);
        },
      }],
    });
    body.querySelector('[data-n]').addEventListener('keydown', (e) => { if (e.key === 'Enter') m.primary.click(); });
  }

  /* ---------- roles ---------- */
  async function loadRoles() {
    const [r, mr] = await Promise.all([
      window.db.from('roles').select('*').eq('server_id', sid),
      window.db.from('member_roles').select('*').eq('server_id', sid),
    ]);
    if (r.error) throw r.error;
    roles = (r.data || []).sort((a, z) => (z.position || 0) - (a.position || 0) || (a.is_default - z.is_default));
    memberRoles = mr.data || [];
  }
  async function loadMembers() {
    const { data, error } = await window.db.from('server_members').select('user_id,nickname,joined_at').eq('server_id', sid);
    if (error) throw error;
    members = data || [];
    await P().need(members.map((m) => m.user_id));
  }
  const roleChip = (r) => `<span class="ss-rolechip"><span class="d" style="background:${esc(HEX.test(r.color || '') ? r.color : '#99AAB5')}"></span>${P().roleIcon(r)}${esc(r.name)}</span>`;

  async function rolesTab(b) {
    b.innerHTML = '<div style="padding:40px;display:flex;justify-content:center"><span class="spinner"></span></div>';
    try { await Promise.all([loadRoles(), loadMembers()]); } catch (e) { return NX.fail(e); }
    if (!selRole || !roles.some((r) => r.id === selRole)) selRole = roles.find((r) => !r.is_default)?.id || roles[0]?.id;
    paintRoles(b);
  }
  function paintRoles(b) {
    const r = roles.find((x) => x.id === selRole);
    roleDraft = r ? { name: r.name, color: HEX.test(r.color || '') ? r.color : '#99AAB5', permissions: Number(r.permissions) || 0 } : null;
    b.innerHTML = `<h1 class="page-title">Roles</h1><p class="lead">Use roles to group members and give them permissions. Higher roles are listed first.</p>
      <div class="ss-roles">
        <div class="ss-rolecol"><button class="btn btn-primary btn-sm btn-block" data-a="newrole"><i class="fa-solid fa-plus"></i>Create role</button>
          <div class="role-list">${roles.map((x) => `<div class="role-item${x.id === selRole ? ' on' : ''}" data-r="${esc(x.id)}"><span class="d" style="background:${esc(HEX.test(x.color || '') ? x.color : '#99AAB5')}"></span>${P().roleIcon(x)}<span class="grow ellipsis">${esc(x.name)}</span><small class="muted">${x.is_default ? '' : memberRoles.filter((m) => m.role_id === x.id).length}</small></div>`).join('')}</div></div>
        <div class="ss-roleedit">${r ? roleEditor(r) : '<div class="empty"><p>No roles yet.</p></div>'}</div></div>`;
    b.querySelector('[data-a="newrole"]').onclick = async () => {
      const name = await NX.prompt({ title: 'Create role', label: 'Role name', placeholder: 'Moderator', max: 100, ok: 'Create' });
      if (!name) return;
      const top = Math.max(0, ...roles.map((x) => x.position || 0));
      const { data, error } = await window.db.from('roles').insert({ server_id: sid, name, color: '#99AAB5', permissions: DEFAULT_PERMS, position: top + 1 }).select().single();
      if (error) return NX.fail(error);
      selRole = data.id; touched(); rolesTab(b);
    };
    b.querySelector('.role-list').onclick = (e) => {
      const it = e.target.closest('[data-r]'); if (!it || it.dataset.r === selRole) return;
      if (!pg.guard()) return;
      selRole = it.dataset.r; paintRoles(b);
    };
    if (r) wireRoleEditor(b, r);
  }
  function roleEditor(r) {
    const holders = memberRoles.filter((m) => m.role_id === r.id).map((m) => P().get(m.user_id)).filter(Boolean);
    return `<div class="card stack">
        <div class="row" style="gap:12px;flex-wrap:wrap">${roleChip(r)}${r.is_default ? '<span class="badge badge-muted">Everyone</span>' : ''}<span class="grow"></span>
          ${r.is_default ? '' : `<button class="icon-btn sm" data-a="rup" title="Move up"><i class="fa-solid fa-arrow-up"></i></button><button class="icon-btn sm" data-a="rdown" title="Move down"><i class="fa-solid fa-arrow-down"></i></button>`}
          <button class="btn btn-ghost btn-sm" data-a="ricon"><i class="fa-regular fa-image"></i>Icon</button>
          ${r.is_default ? '' : '<button class="btn btn-danger-ghost btn-sm" data-a="rdel"><i class="fa-solid fa-trash-can"></i>Delete</button>'}</div>
        <div class="field-row"><div class="field"><label>Role name</label><input class="input" data-rk="name" maxlength="100" ${r.is_default ? 'disabled' : ''}></div>
          <div class="field"><label>Colour</label><div class="row"><input type="color" data-rk="color"><input class="input mono" data-rhex maxlength="7" style="max-width:110px"></div></div></div>
        <div class="swatches" data-rsw>${['#99AAB5', ...ACCENTS].map((c) => `<span class="swatch" data-c="${c}" style="background:${c}"></span>`).join('')}</div>
      </div>
      <h2 class="sec-title">Permissions</h2>
      <div class="card"><div class="row" style="justify-content:flex-end;margin-bottom:4px"><button class="btn btn-quiet btn-sm" data-a="rreset"><i class="fa-solid fa-rotate-left"></i>Reset to defaults</button></div>
        ${PERMS.map(([, bit, label, desc]) => `<div class="perm-row"><div class="info"><b>${esc(label)}</b><small>${esc(desc)}</small></div><input type="checkbox" class="switch" data-bit="${bit}"></div>`).join('')}</div>
      ${r.is_default ? '' : `<h2 class="sec-title">Members with this role — ${holders.length}</h2>
      <div class="card"><div class="row" style="margin-bottom:10px"><button class="btn btn-ghost btn-sm" data-a="radd"><i class="fa-solid fa-user-plus"></i>Add members</button></div>
        <div class="ss-holders">${holders.map((p) => `<div class="ss-holder" data-u="${esc(p.id)}">${P().avatar(p, 28, { halo: false, deco: false })}<span class="grow">${P().nameText(p)} <small class="muted">${esc(p.username)}</small></span><button class="icon-btn sm danger" data-a="runassign" title="Remove role"><i class="fa-solid fa-xmark"></i></button></div>`).join('') || '<p class="hint">Nobody has this role yet.</p>'}</div></div>`}`;
  }
  function wireRoleEditor(b, r) {
    const ed = b.querySelector('.ss-roleedit');
    const fill = () => {
      const nm = ed.querySelector('[data-rk="name"]'); if (document.activeElement !== nm) nm.value = roleDraft.name;
      ed.querySelector('[data-rk="color"]').value = roleDraft.color.toLowerCase();
      const hx = ed.querySelector('[data-rhex]'); if (document.activeElement !== hx) hx.value = roleDraft.color.toUpperCase();
      ed.querySelectorAll('[data-rsw] [data-c]').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === roleDraft.color.toLowerCase()));
      ed.querySelectorAll('[data-bit]').forEach((c) => { c.checked = (BigInt(roleDraft.permissions) & BigInt(c.dataset.bit)) !== 0n; });
    };
    const orig = () => ({ name: r.name, color: HEX.test(r.color || '') ? r.color : '#99AAB5', permissions: Number(r.permissions) || 0 });
    const sync = () => {
      fill();
      const o = orig();
      const dirty = o.name !== roleDraft.name || o.color.toLowerCase() !== roleDraft.color.toLowerCase() || o.permissions !== roleDraft.permissions;
      pg.dirty(dirty, {
        onReset: () => { roleDraft = orig(); sync(); },
        onSave: async () => {
          if (!roleDraft.name.trim()) throw new Error('Roles need a name.');
          const patch = { color: roleDraft.color, permissions: roleDraft.permissions };
          if (!r.is_default) patch.name = roleDraft.name.trim();
          const { data, error } = await window.db.from('roles').update(patch).eq('id', r.id).select().maybeSingle();
          if (error) throw error;
          if (!data) throw new Error('You don’t have permission to change this role.');
          Object.assign(r, data);
          pg.dirty(false); touched();
          NX.toast(`${r.is_default ? '@everyone' : r.name} saved.`);
          paintRoles(b);
        },
      });
    };
    ed.querySelector('[data-rk="name"]').addEventListener('input', (e) => { roleDraft.name = e.target.value; sync(); });
    ed.querySelector('[data-rk="color"]').addEventListener('input', (e) => { roleDraft.color = e.target.value.toUpperCase(); sync(); });
    ed.querySelector('[data-rhex]').addEventListener('input', (e) => { const v = e.target.value.trim(); if (HEX.test(v)) { roleDraft.color = v.toUpperCase(); sync(); } });
    ed.querySelector('[data-rsw]').addEventListener('click', (e) => { const s = e.target.closest('[data-c]'); if (s) { roleDraft.color = s.dataset.c; sync(); } });
    ed.querySelectorAll('[data-bit]').forEach((c) => c.addEventListener('change', () => {
      let bits = BigInt(roleDraft.permissions);
      bits = c.checked ? bits | BigInt(c.dataset.bit) : bits & ~BigInt(c.dataset.bit);
      roleDraft.permissions = Number(bits); sync();
    }));
    ed.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'rreset') { roleDraft.permissions = DEFAULT_PERMS; sync(); }
      if (a === 'ricon') roleIconDialog(r, b);
      if (a === 'rdel') {
        if (!await NX.confirm({ title: `Delete ${r.name}?`, body: 'Members lose this role and its permissions.', danger: true })) return;
        const { error } = await window.db.from('roles').delete().eq('id', r.id);
        if (error) return NX.fail(error);
        pg.dirty(false); selRole = null; touched(); rolesTab(b);
      }
      if (a === 'rup' || a === 'rdown') {
        if (!pg.guard()) return;
        const list = roles.filter((x) => !x.is_default);
        const i = list.indexOf(r), j = i + (a === 'rup' ? -1 : 1);
        if (j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        const n = list.length;
        const res = await Promise.all(list.map((x, k) => (x.position === n - k ? null : window.db.from('roles').update({ position: n - k }).eq('id', x.id))).filter(Boolean));
        const err = res.find((x) => x.error); if (err) NX.fail(err.error);
        touched(); rolesTab(b);
      }
      if (a === 'runassign') {
        const uid = e.target.closest('[data-u]').dataset.u;
        const { error } = await window.db.from('member_roles').delete().eq('server_id', sid).eq('user_id', uid).eq('role_id', r.id);
        if (error) return NX.fail(error);
        touched(); await loadRoles(); paintRoles(b);
      }
      if (a === 'radd') {
        const have = new Set(memberRoles.filter((m) => m.role_id === r.id).map((m) => m.user_id));
        const pool = members.filter((m) => !have.has(m.user_id)).map((m) => P().get(m.user_id)).filter(Boolean);
        if (!pool.length) return NX.toast('Everyone already has this role.');
        const body = NX.h(`<div class="stack"><input class="input" placeholder="Search members"><div class="pick-list">${pool.map((p) => `<label class="pick-row" data-id="${esc(p.id)}" data-n="${esc((P().nameOf(p) + ' ' + p.username).toLowerCase())}">${P().avatar(p, 28, { halo: false, deco: false })}<span class="grow">${P().nameText(p)} <small class="muted">${esc(p.username)}</small></span><input type="checkbox"></label>`).join('')}</div></div>`);
        body.querySelector('input').oninput = (ev) => { const q = ev.target.value.toLowerCase(); body.querySelectorAll('.pick-row').forEach((x) => { x.classList.toggle('hidden', !!q && !x.dataset.n.includes(q)); }); };
        NX.modal({
          title: `Add members to ${r.name}`, body, foot: [{ label: 'Cancel' }, {
            label: 'Add', cls: 'btn-primary', onClick: async () => {
              const ids = [...body.querySelectorAll('.pick-row input:checked')].map((x) => x.closest('[data-id]').dataset.id);
              if (!ids.length) return false;
              const { error } = await window.db.from('member_roles').insert(ids.map((user_id) => ({ server_id: sid, user_id, role_id: r.id })));
              if (error) throw error;
              touched(); await loadRoles(); paintRoles(b);
            },
          }],
        });
      }
    });
    fill();
  }
  function roleIconDialog(r, b) {
    let file = null;
    const isEmoji = r.icon_url && !/^https?:|^data:/.test(r.icon_url);
    const body = NX.h(`<div class="stack">
      <div class="img-pick"><div class="ip-prev sq ss-ricon">${r.icon_url ? P().roleIcon(r) : '<i class="fa-regular fa-image"></i>'}</div>
        <div class="ip-acts"><label class="btn btn-ghost btn-sm"><i class="fa-solid fa-upload"></i>Upload image<input type="file" accept=".png,.svg,.ico,.gif,.webp,.jpg,.jpeg,image/*" hidden></label></div></div>
      <span class="hint">PNG, SVG, ICO, GIF or WebP, under 1 MB.</span>
      <div class="field"><label>…or use an emoji</label><input class="input" data-emoji maxlength="8" placeholder="🛡️" value="${isEmoji ? esc(r.icon_url) : ''}"></div></div>`);
    body.querySelector('input[type=file]').onchange = (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      if (f.size > 1024 * 1024) return NX.toast('That image is over 1 MB.', { err: true });
      file = f;
      body.querySelector('.ss-ricon').innerHTML = `<img src="${URL.createObjectURL(f)}" alt="" style="width:40px;height:40px;object-fit:contain">`;
      body.querySelector('[data-emoji]').value = '';
    };
    const done = async (icon) => {
      const { error } = await window.db.from('roles').update({ icon_url: icon }).eq('id', r.id);
      if (error) throw error;
      r.icon_url = icon; touched(); paintRoles(b);
    };
    NX.modal({
      title: 'Role icon', body,
      foot: [
        { left: (() => { const x = NX.h('<button class="btn btn-quiet btn-sm">Remove icon</button>'); x.onclick = async () => { try { await done(null); NX.closeMenu(); NX.topModal()?.close(); NX.toast('Icon removed.'); } catch (e) { NX.fail(e); } }; return x; })() },
        { label: 'Cancel' },
        {
          label: 'Save icon', cls: 'btn-primary', onClick: async () => {
            let icon = body.querySelector('[data-emoji]').value.trim() || null;
            if (file) icon = (await NX.files.put(`roles/${sid}`, file)).url;
            await done(icon);
            NX.toast('Role icon saved.');
          },
        },
      ],
    });
  }

  /* ---------- members ---------- */
  async function membersTab(b) {
    b.innerHTML = `<h1 class="page-title">Members</h1>
      <div class="toolbar"><input class="input" data-q placeholder="Search by name or username"><span class="grow"></span><span class="hint" data-n></span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Member</th><th>Joined</th><th>Roles</th><th></th></tr></thead><tbody><tr><td colspan="4" style="text-align:center;padding:30px"><span class="spinner"></span></td></tr></tbody></table></div>`;
    try { await Promise.all([loadMembers(), loadRoles()]); } catch (e) { return NX.fail(e); }
    const paint = () => {
      const q = b.querySelector('[data-q]').value.trim().toLowerCase();
      const rows = members.map((m) => ({ m, p: P().get(m.user_id) })).filter((x) => x.p && (!q || P().nameOf(x.p).toLowerCase().includes(q) || x.p.username.toLowerCase().includes(q) || (x.m.nickname || '').toLowerCase().includes(q)))
        .sort((a, z) => (z.p.id === srv.owner_id) - (a.p.id === srv.owner_id) || P().nameOf(a.p).localeCompare(P().nameOf(z.p)));
      b.querySelector('[data-n]').textContent = NX.fmt.plural(members.length, 'member');
      b.querySelector('tbody').innerHTML = rows.map(({ m, p }) => {
        const theirs = memberRoles.filter((x) => x.user_id === p.id).map((x) => roles.find((r) => r.id === x.role_id)).filter(Boolean);
        return `<tr data-u="${esc(p.id)}"><td><div class="who" data-card style="cursor:pointer">${P().avatar(p, 32, { presence: true, halo: false, deco: false })}<div><b>${esc(m.nickname || '') || P().nameText(p)}${p.id === srv.owner_id ? ' <i class="fa-solid fa-crown" style="color:var(--nitro);font-size:11px" title="Owner"></i>' : ''}</b><small>@${esc(p.username)}${m.nickname ? ' · ' + esc(P().nameOf(p)) : ''}</small></div></div></td>
          <td class="muted" style="white-space:nowrap">${m.joined_at ? new Date(m.joined_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</td>
          <td><div class="chip-input">${theirs.map(roleChip).join('') || '<span class="muted">—</span>'}</div></td>
          <td style="text-align:right"><button class="icon-btn" data-a="more" title="Manage"><i class="fa-solid fa-ellipsis-vertical"></i></button></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">Nobody matches that.</td></tr>';
    };
    b.querySelector('[data-q]').oninput = NX.debounce(paint, 120);
    b.querySelector('tbody').onclick = (e) => {
      const tr = e.target.closest('[data-u]'); if (!tr) return;
      const uid = tr.dataset.u;
      if (e.target.closest('[data-card]')) return P().card(uid, e.target.closest('[data-card]'), { serverId: sid });
      const btn = e.target.closest('[data-a="more"]'); if (!btn) return;
      const m = members.find((x) => x.user_id === uid), p = P().get(uid);
      const self = uid === NX.me.id, owner = uid === srv.owner_id;
      NX.menu(btn, [
        { label: 'Profile', icon: 'fa-user', onClick: () => P().card(uid, btn, { serverId: sid }) },
        { label: 'Change nickname', icon: 'fa-pen', hidden: !(self || can(BIT.NICK)), onClick: () => nickname(m, p, paint) },
        { label: 'Roles', icon: 'fa-shield-halved', hidden: !can(BIT.MANAGE_ROLES), onClick: () => memberRolesDialog(uid, paint) },
        { sep: true, hidden: self || owner },
        { label: `Kick ${P().nameOf(p)}`, icon: 'fa-user-minus', danger: true, hidden: self || owner || !can(BIT.KICK), onClick: () => kick(uid, p, paint) },
        { label: `Ban ${P().nameOf(p)}`, icon: 'fa-ban', danger: true, hidden: self || owner || !can(BIT.BAN), onClick: () => ban(uid, p, paint) },
      ], { alignRight: true });
    };
    paint();
  }
  async function nickname(m, p, repaint) {
    const v = await NX.prompt({ title: 'Change nickname', label: `Nickname for ${P().nameOf(p)} in ${srv.name}`, value: m.nickname || '', max: 32, allowEmpty: true, placeholder: P().nameOf(p) });
    if (v === null) return;
    const { data, error } = await window.db.from('server_members').update({ nickname: v || null }).eq('server_id', sid).eq('user_id', m.user_id).select().maybeSingle();
    if (error) return NX.fail(error);
    if (!data) return NX.toast('You can’t change that nickname.', { err: true });
    m.nickname = v || null; touched(); repaint(); NX.toast('Nickname updated.');
  }
  function memberRolesDialog(uid, repaint) {
    const owned = new Set(memberRoles.filter((x) => x.user_id === uid).map((x) => x.role_id));
    const list = roles.filter((r) => !r.is_default);
    if (!list.length) return NX.toast('Create a role first (Roles tab).');
    const body = NX.h(`<div class="pick-list">${list.map((r) => `<label class="pick-row" data-r="${esc(r.id)}">${roleChip(r)}<span class="grow"></span><input type="checkbox" ${owned.has(r.id) ? 'checked' : ''}></label>`).join('')}</div>`);
    NX.modal({
      title: `Roles for ${P().nameOf(P().get(uid))}`, body, foot: [{ label: 'Cancel' }, {
        label: 'Apply', cls: 'btn-primary', onClick: async () => {
          const want = new Set([...body.querySelectorAll('input:checked')].map((c) => c.closest('[data-r]').dataset.r));
          const add = [...want].filter((r) => !owned.has(r)), rem = [...owned].filter((r) => !want.has(r));
          if (add.length) { const { error } = await window.db.from('member_roles').insert(add.map((role_id) => ({ server_id: sid, user_id: uid, role_id }))); if (error) throw error; }
          for (const role_id of rem) { const { error } = await window.db.from('member_roles').delete().eq('server_id', sid).eq('user_id', uid).eq('role_id', role_id); if (error) throw error; }
          await loadRoles(); touched(); repaint(); NX.toast('Roles updated.');
        },
      }],
    });
  }
  async function kick(uid, p, repaint) {
    if (!await NX.confirm({ title: `Kick ${P().nameOf(p)}?`, body: 'They can rejoin with a new invite.', ok: 'Kick', danger: true })) return;
    const { error } = await window.db.rpc('kick_member', { p_server_id: sid, p_user_id: uid });
    if (error) return NX.fail(error);
    members = members.filter((m) => m.user_id !== uid); touched(); repaint(); NX.toast('Member kicked.');
  }
  async function ban(uid, p, repaint) {
    const reason = await NX.prompt({ title: `Ban ${P().nameOf(p)}?`, label: 'Reason (optional)', placeholder: 'Spamming', max: 500, allowEmpty: true, ok: 'Ban', danger: true, hint: 'They’re removed and can’t rejoin until you unban them.' });
    if (reason === null) return;
    const { error } = await window.db.rpc('ban_member', { p_server_id: sid, p_user_id: uid, p_reason: reason || null });
    if (error) return NX.fail(error);
    members = members.filter((m) => m.user_id !== uid); touched(); repaint(); NX.toast('Member banned.');
  }

  /* ---------- invites ---------- */
  async function invitesTab(b) {
    b.innerHTML = `<h1 class="page-title">Invites</h1><p class="lead">Active invite links for ${esc(srv.name)}. Revoke any you no longer want working.</p>
      <div class="toolbar">${can(BIT.INVITE) ? '<button class="btn btn-primary btn-sm" data-a="new"><i class="fa-solid fa-plus"></i>Create invite</button>' : ''}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Created by</th><th>Uses</th><th>Expires</th><th></th></tr></thead><tbody><tr><td colspan="5" style="text-align:center;padding:30px"><span class="spinner"></span></td></tr></tbody></table></div>`;
    const paint = async () => {
      const { data, error } = await window.db.from('invites').select('*').eq('server_id', sid).order('created_at', { ascending: false });
      if (error) return NX.fail(error);
      await P().need((data || []).map((i) => i.created_by));
      const tb = b.querySelector('tbody');
      if (!tb) return;
      tb.innerHTML = (data || []).map((i) => {
        const dead = i.expires_at && new Date(i.expires_at) < new Date();
        const by = P().get(i.created_by);
        const mine = i.created_by === NX.me.id;
        return `<tr data-id="${esc(i.id)}" data-code="${esc(i.code)}"${dead ? ' style="opacity:.55"' : ''}><td><b class="mono">${esc(i.code)}</b></td>
          <td><div class="who">${P().avatar(by, 24, { halo: false, deco: false })}<span>${P().nameText(by)}</span></div></td>
          <td>${i.uses || 0}${i.max_uses ? ' / ' + i.max_uses : ''}</td>
          <td class="muted" style="white-space:nowrap">${dead ? 'Expired' : i.expires_at ? NX.fmt.stamp(i.expires_at) : 'Never'}</td>
          <td style="text-align:right;white-space:nowrap"><button class="icon-btn sm" data-a="copy" title="Copy link"><i class="fa-regular fa-copy"></i></button>
            ${mine || can(BIT.MANAGE_CHANNELS) ? '<button class="icon-btn sm danger" data-a="del" title="Revoke"><i class="fa-solid fa-trash-can"></i></button>' : ''}</td></tr>`;
      }).join('') || '<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">No invites yet.</td></tr>';
    };
    b.querySelector('[data-a="new"]')?.addEventListener('click', () => { NX.views.server?.invite?.(sid); setTimeout(paint, 1500); });
    b.querySelector('tbody').onclick = async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a; const tr = e.target.closest('[data-id]');
      if (!a || !tr) return;
      if (a === 'copy') return NX.copy(NX.pageUrl(`index.html?invite=${tr.dataset.code}`), 'Invite link copied');
      if (a === 'del') {
        const { error } = await window.db.from('invites').delete().eq('id', tr.dataset.id);
        if (error) return NX.fail(error);
        NX.toast('Invite revoked.'); paint();
      }
    };
    paint();
  }

  /* ---------- bans ---------- */
  async function bansTab(b) {
    b.innerHTML = `<h1 class="page-title">Bans</h1><p class="lead">People who can’t rejoin ${esc(srv.name)}.</p>
      <div class="toolbar"><input class="input" data-q placeholder="Search bans"></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Member</th><th>Reason</th><th>Banned</th><th></th></tr></thead><tbody><tr><td colspan="4" style="text-align:center;padding:30px"><span class="spinner"></span></td></tr></tbody></table></div>`;
    const { data, error } = await window.db.from('server_bans').select('*').eq('server_id', sid).order('created_at', { ascending: false });
    if (error) return NX.fail(error);
    let list = data || [];
    await P().need(list.flatMap((x) => [x.user_id, x.banned_by]).filter(Boolean));
    const paint = () => {
      const q = b.querySelector('[data-q]').value.trim().toLowerCase();
      const rows = list.filter((x) => { const p = P().get(x.user_id); return !q || P().nameOf(p).toLowerCase().includes(q) || (p?.username || '').toLowerCase().includes(q); });
      b.querySelector('tbody').innerHTML = rows.map((x) => {
        const p = P().get(x.user_id), by = x.banned_by ? P().get(x.banned_by) : null;
        return `<tr data-u="${esc(x.user_id)}"><td><div class="who">${P().avatar(p, 28, { halo: false, deco: false })}<div><b>${P().nameText(p)}</b><small>@${esc(p?.username || '')}</small></div></div></td>
          <td>${x.reason ? esc(x.reason) : '<span class="muted">No reason given</span>'}</td>
          <td class="muted" style="white-space:nowrap">${x.created_at ? NX.fmt.stamp(x.created_at) : ''}${by ? `<br><small>by ${P().nameText(by)}</small>` : ''}</td>
          <td style="text-align:right"><button class="btn btn-ghost btn-sm" data-a="unban">Unban</button></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">Nobody is banned.</td></tr>';
    };
    b.querySelector('[data-q]').oninput = NX.debounce(paint, 120);
    b.querySelector('tbody').onclick = async (e) => {
      if (!e.target.closest('[data-a="unban"]')) return;
      const uid = e.target.closest('[data-u]').dataset.u;
      if (!await NX.confirm({ title: `Unban ${P().nameOf(P().get(uid))}?`, body: 'They’ll be able to rejoin with an invite.', ok: 'Unban' })) return;
      const { error: err } = await window.db.from('server_bans').delete().eq('server_id', sid).eq('user_id', uid);
      if (err) return NX.fail(err);
      list = list.filter((x) => x.user_id !== uid); paint(); NX.toast('Ban lifted.');
    };
    paint();
  }

  /* ---------- danger ---------- */
  function dangerTab(b) {
    b.innerHTML = `<h1 class="page-title">Delete server</h1>
      <div class="card danger-card"><h3>Delete ${esc(srv.name)}</h3><p>Every channel, message, role and invite goes with it. This can’t be undone.</p>
        <div class="field" style="max-width:360px"><label>Type the server name to confirm</label><input class="input" data-confirm placeholder="${esc(srv.name)}"></div>
        <div style="margin-top:14px"><button class="btn btn-danger" data-a="del" disabled><i class="fa-solid fa-trash-can"></i>Delete server</button></div></div>`;
    const inp = b.querySelector('[data-confirm]'), btn = b.querySelector('[data-a="del"]');
    inp.oninput = () => { btn.disabled = inp.value.trim() !== srv.name.trim(); };
    btn.onclick = async () => {
      if (!await NX.confirm({ title: `Delete ${srv.name}?`, body: 'This is permanent.', ok: 'Delete server', danger: true })) return;
      btn.classList.add('busy');
      if (window.Voice?.state().active && window.Voice.state().serverId === sid) await NX.call.leave();
      const { data, error } = await window.db.from('servers').delete().eq('id', sid).select();
      btn.classList.remove('busy');
      if (error) return NX.fail(error);
      if (!data?.length) return NX.toast('Only the owner can delete this server.', { err: true });
      touched();
      NX.data.servers = NX.data.servers.filter((s) => s.id !== sid);
      NX.emit('servers');
      await NX.data.reloadServers();
      NX.toast('Server deleted.');
      NX.go('home');
    };
  }

  NX.views.serverSettings = { enter, update, leave };
})();
