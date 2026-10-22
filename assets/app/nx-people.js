/* People: one profile cache for the whole app, avatar + name rendering
   (including the Nitro halo, frames and name styles), presence, and the user
   card. */
(function () {
  const { esc } = NX;
  const CARD = 'id,username,display_name,avatar_url,banner_url,accent_color,is_nitro,banner_gif_url,theme,custom_status,status,platform_role,is_platform_admin,is_banned,created_at,bio';
  const cache = new Map();
  const want = new Set();
  let flushT = null;
  const waiters = new Map();

  function put(p) {
    if (!p || !p.id) return p;
    const old = cache.get(p.id);
    // Partial rows (inbox cards) never wipe fields a full row already gave us.
    const merged = old ? { ...old, ...p, theme: { ...(old.theme || {}), ...(p.theme || {}) } } : { ...p };
    cache.set(p.id, merged);
    return merged;
  }
  const get = (id) => cache.get(id) || null;

  // Batches every lookup made in the same tick into one query.
  function need(ids) {
    const missing = [...new Set(ids)].filter((id) => id && !cache.has(id));
    if (!missing.length) return Promise.resolve();
    missing.forEach((id) => want.add(id));
    if (!flushT) flushT = setTimeout(flush, 0);
    return Promise.all(missing.map((id) => new Promise((r) => {
      if (!waiters.has(id)) waiters.set(id, []);
      waiters.get(id).push(r);
    })));
  }
  async function flush() {
    flushT = null;
    const ids = [...want]; want.clear();
    for (let i = 0; i < ids.length; i += 80) {
      const chunk = ids.slice(i, i + 80);
      try {
        const { data } = await window.db.from('profiles').select(CARD).in('id', chunk);
        (data || []).forEach(put);
      } catch {}
      chunk.forEach((id) => {
        if (!cache.has(id)) cache.set(id, { id, username: 'deleted', display_name: 'Deleted user', _gone: true });
        (waiters.get(id) || []).forEach((r) => r());
        waiters.delete(id);
      });
    }
    NX.emit('people');
  }
  async function fetchFull(id) {
    const { data } = await window.db.from('profiles').select('*').eq('id', id).maybeSingle();
    if (data) put(data);
    return data ? get(id) : null;
  }

  const nameOf = (p) => (p && (p.display_name || p.username)) || 'Unknown';

  /* ---------- image URLs ----------
     New files are permanent CloudFront URLs. Old iDrive URLs get a signature
     at render time (storage.js hydrates <img data-nx-src>). */
  const imgAttr = (url) => (window.Store ? window.Store.imgAttr(url) : `src="${esc(url)}"`);

  /* ---------- Nitro styling ---------- */
  const NX_FONTS = ['normal', 'bold', 'script', 'double', 'ascii'];
  const HEX = /^#[0-9a-f]{6}$/i;
  function nameStyle(p) {
    if (!p?.is_nitro) return null;
    const n = p.theme?.name_style;
    if (!n || typeof n !== 'object') return null;
    const font = NX_FONTS.includes(n.font) ? n.font : 'normal';
    const out = {
      font, color: HEX.test(n.color || '') ? n.color : null, color2: HEX.test(n.color2 || '') ? n.color2 : null,
      glow: HEX.test(n.glow || '') ? n.glow : null, italic: !!n.italic, shimmer: !!n.shimmer, bold: !!n.bold || font === 'bold',
    };
    // ASCII art is meant to pop: without colours of its own it gets the
    // animated rainbow, and it always glows.
    if (font === 'ascii') {
      if (!out.color && !out.color2) out.rainbow = true;
      if (!out.glow) out.glow = out.color || '#a78bfa';
      out.bold = true;
    }
    return out;
  }
  const FANCY = { bold: { up: 0x1D400, lo: 0x1D41A, dg: 0x1D7CE }, script: { up: 0x1D4D0, lo: 0x1D4EA }, double: { up: 0x1D538, lo: 0x1D552, dg: 0x1D7D8 } };
  const DOUBLE_HOLES = { C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124 };
  function fancy(text, font) {
    const m = FANCY[font];
    if (!m) return text;
    return [...text].map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(font === 'double' && DOUBLE_HOLES[ch] ? DOUBLE_HOLES[ch] : m.up + c - 65);
      if (c >= 97 && c <= 122) return String.fromCodePoint(m.lo + c - 97);
      if (c >= 48 && c <= 57 && m.dg) return String.fromCodePoint(m.dg + c - 48);
      return ch;
    }).join('');
  }
  // color: a role colour from the current server, used when the name has no Nitro style.
  function nameCss(p, { noGlow = false, noItalic = false, color = null } = {}) {
    const ns = nameStyle(p);
    const roleCol = HEX.test(color || '') ? color : null;
    if (!ns) return roleCol ? `color:${roleCol};` : '';
    let css = '';
    const base = ns.color || roleCol;
    const grad = ns.rainbow ? 'linear-gradient(90deg,#ff4d8d,#ffb347,#facc15,#4ade80,#38bdf8,#a78bfa,#ff4d8d)'
      : ns.color2 ? `linear-gradient(90deg, ${base || '#fff'}, ${ns.color2}, ${base || '#fff'})` : null;
    if (grad) css += `background:${grad};-webkit-background-clip:text;background-clip:text;color:transparent;-webkit-text-fill-color:transparent;`;
    else if (base) css += `color:${base};`;
    if ((ns.shimmer || ns.rainbow) && grad) css += 'background-size:200% auto;animation:nxShimmer 3.2s linear infinite;';
    if (ns.glow && !noGlow) css += `filter:drop-shadow(0 0 4px ${ns.glow}) drop-shadow(0 0 10px ${ns.glow});`;
    if (ns.bold) css += 'font-weight:800;';
    if (ns.font === 'ascii') css += 'font-family:var(--f-mono);text-transform:uppercase;letter-spacing:.03em;';
    if (ns.italic && !noItalic) css += 'font-style:italic;padding-right:.2em;';
    return css;
  }
  function nameText(p) {
    const n = nameOf(p);
    const ns = nameStyle(p);
    return esc(ns && ns.font !== 'ascii' ? fancy(n, ns.font) : n);
  }
  // Inline name: styled text, single line.
  function name(p, opts = {}) {
    return `<span class="nx-name ${opts.cls || ''}" style="${esc(nameCss(p, opts))}"${opts.uid !== false && p?.id ? ` data-uid="${esc(p.id)}"` : ''}>${nameText(p)}</span>`;
  }
  const PIXEL = {
    A: ['010', '101', '111', '101', '101'], B: ['110', '101', '110', '101', '110'], C: ['011', '100', '100', '100', '011'], D: ['110', '101', '101', '101', '110'],
    E: ['111', '100', '110', '100', '111'], F: ['111', '100', '110', '100', '100'], G: ['011', '100', '101', '101', '011'], H: ['101', '101', '111', '101', '101'],
    I: ['111', '010', '010', '010', '111'], J: ['001', '001', '001', '101', '010'], K: ['101', '101', '110', '101', '101'], L: ['100', '100', '100', '100', '111'],
    M: ['101', '111', '111', '101', '101'], N: ['110', '101', '101', '101', '101'], O: ['010', '101', '101', '101', '010'], P: ['110', '101', '110', '100', '100'],
    Q: ['010', '101', '101', '110', '011'], R: ['110', '101', '110', '101', '101'], S: ['011', '100', '010', '001', '110'], T: ['111', '010', '010', '010', '010'],
    U: ['101', '101', '101', '101', '111'], V: ['101', '101', '101', '101', '010'], W: ['101', '101', '111', '111', '101'], X: ['101', '101', '010', '101', '101'],
    Y: ['101', '101', '010', '010', '010'], Z: ['111', '001', '010', '100', '111'], 0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'],
    2: ['110', '001', '010', '100', '111'], 3: ['110', '001', '010', '001', '110'], 4: ['101', '101', '111', '001', '001'], 5: ['111', '100', '110', '001', '110'],
    6: ['011', '100', '111', '101', '111'], 7: ['111', '001', '010', '010', '010'], 8: ['111', '101', '111', '101', '111'], 9: ['111', '101', '111', '001', '110'],
    ' ': ['000', '000', '000', '000', '000'], '?': ['110', '001', '011', '000', '010'],
    _: ['000', '000', '000', '000', '111'], '-': ['000', '000', '111', '000', '000'], '.': ['000', '000', '000', '000', '010'],
    '!': ['010', '010', '010', '000', '010'], '\'': ['010', '010', '000', '000', '000'], '+': ['000', '010', '111', '010', '000'],
    '*': ['101', '010', '101', '000', '000'], '#': ['101', '111', '101', '111', '101'], '@': ['111', '101', '111', '100', '111'],
    '&': ['010', '101', '010', '101', '011'], '(': ['001', '010', '010', '010', '001'], ')': ['100', '010', '010', '010', '100'],
  };
  function asciiArt(text) {
    const rows = ['', '', '', '', ''];
    [...String(text || '').toUpperCase().slice(0, 14)].forEach((ch, i) => {
      const g = PIXEL[ch] || PIXEL['?'];
      for (let r = 0; r < 5; r++) rows[r] += (i ? ' ' : '') + g[r].replace(/0/g, ' ').replace(/1/g, '\u2588');
    });
    return rows.join('\n');
  }
  // Big name for the profile card: ASCII art when chosen.
  function bigName(p) {
    const ns = nameStyle(p);
    if (ns?.font === 'ascii') return `<pre class="nx-ascii" style="${esc(nameCss(p, { noItalic: true }))}" aria-label="${esc(nameOf(p))}">${esc(asciiArt(nameOf(p)))}</pre>`;
    return `<span class="nx-name" style="${esc(nameCss(p))}">${nameText(p)}</span>`;
  }

  function decoPath(p, kind) {
    if (!p?.is_nitro) return null;
    const folder = kind === 'pfp' ? 'assets/deco/pfp/' : 'assets/deco/profile/';
    const v = kind === 'pfp' ? p.theme?.pfp_deco : p.theme?.bio_deco;
    if (typeof v !== 'string' || !v.startsWith(folder) || v.includes('..')) return null;
    if (!/^[\w./-]+\.(png|apng|gif|webp)$/i.test(v)) return null;
    return v;
  }

  // Optimised copies (assets/deco/opt, ~3x smaller animated WebP, plus a
  // still frame for grids). Falls back to the original file if missing.
  function decoSrc(path, still) {
    const m = /^assets\/deco\/(pfp|profile)\/([\w-]+)\.png$/i.exec(path || '');
    return m ? `assets/deco/opt/${m[1]}/${m[2]}${still ? '.still' : ''}.webp` : path;
  }
  function decoImg(path, cls, still) {
    return `<img class="${cls}" src="${esc(decoSrc(path, still))}" onerror="this.onerror=null;this.src='${esc(path)}'" alt="" loading="lazy" decoding="async">`;
  }
  const IMG_EXT = /\.(gif|apng|png|jpe?g|webp|avif)($|\?)/i;
  function haloImage(p) {
    const raw = (p?.banner_gif_url || '').trim();
    if (!raw) return null;
    try {
      const u = new URL(raw, location.href);
      if (!['https:', 'http:'].includes(u.protocol) || !IMG_EXT.test(u.pathname)) return null;
      return u.href;
    } catch { return null; }
  }
  function haloCss(p) {
    if (!p?.theme?.dev_mode) return null;
    const raw = (p.theme.halo_css || '').trim();
    if (!raw || raw.length > 400) return null;
    if (/[{}<>]/.test(raw)) return null;
    if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:|@import/i.test(raw)) return null;
    return raw;
  }
  const haloKeys = new Set();
  let haloSheet = null;
  function haloClass(p) {
    const custom = haloCss(p);
    if (custom) {
      let h = 0;
      for (let i = 0; i < custom.length; i++) h = (Math.imul(31, h) + custom.charCodeAt(i)) | 0;
      const key = 'av-halo-c' + (h >>> 0).toString(36);
      if (!haloKeys.has(key)) {
        if (!haloSheet) { haloSheet = document.createElement('style'); document.head.appendChild(haloSheet); }
        if (haloKeys.size > 64) { haloSheet.textContent = ''; haloKeys.clear(); }
        haloSheet.appendChild(document.createTextNode(`.${key}::before{${custom};}`));
        haloKeys.add(key);
      }
      return `av-halo av-halo-custom ${key}`;
    }
    return haloImage(p) ? 'av-halo av-halo-img' : 'av-halo';
  }
  function haloStyle(p) {
    if (haloCss(p)) return '';
    const img = haloImage(p);
    return img ? ` style="--halo-img:url('${esc(img.replace(/['"\\]/g, ''))}')"` : '';
  }

  const initial = (n) => ([...(String(n || '?').trim())][0] || '?').toUpperCase();
  const tint = (p) => {
    if (p?.accent_color && HEX.test(p.accent_color)) return p.accent_color;
    let h = 0;
    for (const ch of String(p?.id || p?.username || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${h % 360} 45% 42%)`;
  };

  /* avatar(p, size, { presence, halo, deco, cls }) */
  function avatar(p, size = 40, o = {}) {
    p = p || {};
    const fs = Math.round(size * 0.4);
    const inner = p.avatar_url
      ? `<span class="av" style="width:${size}px;height:${size}px"><img ${imgAttr(p.avatar_url)} alt="" loading="lazy" decoding="async"></span>`
      : `<span class="av" style="width:${size}px;height:${size}px;font-size:${fs}px;background:${tint(p)}">${esc(initial(nameOf(p)))}</span>`;
    const deco = o.deco !== false && size >= 24 ? decoPath(p, 'pfp') : null;
    let out = deco ? `<span class="av-decoed">${inner}${decoImg(deco, 'av-deco', o.still)}</span>` : inner;
    if (p.is_nitro && o.halo !== false && size >= 24) out = `<span class="${haloClass(p)}"${haloStyle(p)}>${out}</span>`;
    if (o.presence && p.id) out = `<span class="av-slot${size < 30 ? ' sm' : ''}">${out}${presenceDot(p.id)}</span>`;
    return out;
  }

  /* ---------- platform roles ---------- */
  function rank(p) {
    if (!p) return 0;
    return { owner: 3, sudo: 2, admin: 1 }[p.platform_role] || (p.is_platform_admin ? 1 : 0);
  }
  const ROLE_NAMES = ['', 'Admin', 'Sudo Admin', 'Owner'];
  function roleBadge(p) {
    const r = rank(p);
    if (!r) return '';
    const ic = ['', 'fa-shield-halved', 'fa-user-shield', 'fa-crown'][r];
    return `<span class="badge badge-role r${r}" title="NexChat ${ROLE_NAMES[r]}"><i class="fa-solid ${ic}"></i>${ROLE_NAMES[r]}</span>`;
  }
  function roleIcon(role) {
    const v = (role?.icon_url || '').trim();
    if (!v) return '';
    if (/^https?:\/\//i.test(v)) return `<img class="role-ico" ${imgAttr(v)} alt="">`;
    if (v.startsWith('data:image/')) return `<img class="role-ico" src="${esc(v)}" alt="">`;
    return `<span class="role-emoji">${esc(v)}</span>`;
  }

  /* ---------- presence ----------
     One shared realtime presence channel. Each client publishes its user id
     and a status: online, idle (away from the keyboard), dnd. Invisible means
     not publishing at all. The chosen status is kept on the profile
     (profiles.status: online | idle | dnd | offline=invisible). */
  const online = new Map();   // uid -> 'online' | 'idle' | 'dnd'
  let pchan = null, meId = null, chosen = 'online', afk = false, afkTimer = null;
  const AFK_MS = 10 * 60 * 1000;

  function presenceOf(uid) { return online.get(uid) || 'offline'; }
  function isOnline(uid) { return online.has(uid); }
  const DOT = { online: 'on', idle: 'idle', dnd: 'dnd', offline: 'off' };
  function presenceDot(uid) { return `<span class="pdot ${DOT[presenceOf(uid)]}" data-pd="${esc(uid)}"></span>`; }
  const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline', invisible: 'Invisible' };
  const STATUS_COLOR = { online: 'var(--ok)', idle: 'var(--warn)', dnd: 'var(--danger)', offline: '#5b5f6d', invisible: '#5b5f6d' };

  function effective() { if (chosen === 'offline') return null; if (chosen === 'dnd') return 'dnd'; return afk || chosen === 'idle' ? 'idle' : 'online'; }
  let lastSent = undefined;
  function publish(force) {
    if (!pchan || !meId) return;
    const st = effective();
    if (!force && st === lastSent) return;
    lastSent = st;
    if (st) pchan.track({ user_id: meId, status: st, at: Date.now() }).catch(() => {});
    else pchan.untrack().catch(() => {});
  }
  function recompute() {
    const state = pchan?.presenceState() || {};
    online.clear();
    Object.keys(state).forEach((k) => {
      const metas = state[k] || [];
      // Several tabs: the most "present" wins.
      let best = null;
      metas.forEach((m) => {
        const s = m.status || 'online';
        if (!best || s === 'online' || (s === 'dnd' && best === 'idle')) best = s;
      });
      const id = metas[0]?.user_id || k;
      if (best) online.set(id, best);
    });
    if (meId && effective()) online.set(meId, effective());
    refreshDots();
    NX.emit('presence');
  }
  function refreshDots(root = document) {
    root.querySelectorAll('.pdot[data-pd]').forEach((el) => {
      const cls = DOT[presenceOf(el.dataset.pd)];
      if (!el.classList.contains(cls)) el.className = 'pdot ' + cls;
    });
  }
  function bumpActivity() {
    if (afk) { afk = false; publish(); recompute(); }
    clearTimeout(afkTimer);
    afkTimer = setTimeout(() => { afk = true; publish(); recompute(); }, AFK_MS);
  }
  function startPresence(me) {
    if (pchan) return;
    meId = me.id;
    // The chosen status lives in theme.status (profiles.status defaults to
    // 'offline' for every account, so it can't mean "invisible").
    const pref = me.theme?.status;
    chosen = pref === 'invisible' ? 'offline' : ['online', 'idle', 'dnd'].includes(pref) ? pref : 'online';
    pchan = window.db.channel('nx-presence', { config: { presence: { key: me.id }, private: !!NX.privateRT } });
    pchan.on('presence', { event: 'sync' }, recompute)
      .on('presence', { event: 'join' }, recompute)
      .on('presence', { event: 'leave' }, recompute)
      .subscribe((s) => { if (s === 'SUBSCRIBED') { lastSent = undefined; publish(true); } });
    ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, NX.throttle(bumpActivity, 5000), { passive: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) bumpActivity(); });
    bumpActivity();
    recompute();
    window.addEventListener('pagehide', () => { try { pchan.untrack(); } catch {} });
  }
  async function setStatus(st) {
    chosen = st;
    lastSent = undefined;
    publish(true);
    recompute();
    const me = NX.me;
    if (me) {
      const theme = { ...(me.theme || {}), status: st === 'offline' ? 'invisible' : st };
      me.theme = theme;
      put({ id: me.id, theme });
      const { error } = await window.db.from('profiles').update({ theme, status: st }).eq('id', me.id);
      if (error) NX.fail(error);
    }
    NX.emit('me');
  }
  const myStatus = () => chosen === 'offline' ? 'invisible' : chosen;

  /* ---------- user card ---------- */
  async function card(uid, at, opts = {}) {
    NX.closeMenu();
    document.querySelector('.ucard')?.remove();
    let p = get(uid);
    const el = document.createElement('div');
    el.className = 'ucard';
    el.innerHTML = '<div style="padding:40px;display:flex;justify-content:center"><span class="spinner"></span></div>';
    document.body.appendChild(el);
    const place = () => {
      if (NX.isNarrow()) return;
      const r = el.getBoundingClientRect();
      let x, y;
      if (at && at.getBoundingClientRect) {
        const a = at.getBoundingClientRect();
        x = a.right + 12; y = a.top;
        if (x + r.width > innerWidth - 8) x = a.left - r.width - 12;
        if (x < 8) { x = Math.min(Math.max(8, a.left), innerWidth - r.width - 8); y = a.bottom + 8; }
      } else if (at && at.clientX != null) { x = at.clientX + 12; y = at.clientY - 40; }
      else { x = (innerWidth - r.width) / 2; y = (innerHeight - r.height) / 2; }
      el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
      el.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    };
    place();
    const close = () => { el.remove(); document.removeEventListener('pointerdown', away, true); };
    const away = (e) => { if (!el.contains(e.target) && !e.target.closest('.menu, .overlay, .emoji-pick')) close(); };
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);

    const full = await fetchFull(uid).catch(() => null);
    if (!el.isConnected) return;
    p = full || p;
    if (!p) { el.innerHTML = '<div class="empty"><p>Could not load that profile.</p></div>'; return; }
    const isMe = uid === NX.me?.id;
    let roles = [];
    if (opts.serverId) {
      const { data } = await window.db.from('member_roles').select('roles(name,color,icon_url,position)').eq('server_id', opts.serverId).eq('user_id', uid);
      roles = (data || []).map((r) => r.roles).filter(Boolean).sort((a, b) => (b.position || 0) - (a.position || 0));
    }
    const rel = NX.data?.relation?.(uid) || null;
    const accent = HEX.test(p.accent_color || '') ? p.accent_color : '#5865F2';
    const bannerCss = p.banner_url ? '' : `background:linear-gradient(135deg, ${accent}, color-mix(in srgb, ${accent} 30%, #0e0f13))`;
    const deco = decoPath(p, 'bio');
    if (deco) el.classList.add('has-deco', 'card-deco-host');
    const st = presenceOf(uid);
    el.innerHTML = `
      ${deco ? `<div class="card-deco" aria-hidden="true">${decoImg(deco, '')}</div>` : ''}
      <div class="uc-banner" style="${bannerCss}"${p.banner_url ? ` data-bg="${esc(p.banner_url)}"` : ''}></div>
      <div class="uc-av">${avatar(p, 84, { presence: true })}</div>
      <div class="uc-body">
        <div>
          <div class="uc-name">${bigName(p)}</div>
          <div class="uc-handle">@${esc(p.username)}${st !== 'offline' ? ` · <span style="color:${STATUS_COLOR[st]}">${STATUS_LABEL[st]}</span>` : ''}</div>
        </div>
        ${p.is_nitro || rank(p) || p.is_banned ? `<div class="uc-badges">${p.is_nitro ? '<span class="badge badge-nitro"><i class="fa-solid fa-bolt"></i>Nitro</span>' : ''}${roleBadge(p)}${p.is_banned ? '<span class="badge badge-banned">Banned</span>' : ''}</div>` : ''}
        ${p.custom_status ? `<div class="uc-status">${esc(p.custom_status)}</div>` : ''}
        ${p.bio ? `<div class="uc-sect"><h5>About me</h5><p>${esc(p.bio)}</p></div>` : ''}
        ${roles.length ? `<div class="uc-sect"><h5>Roles</h5><div class="uc-roles">${roles.map((r) => `<span class="uc-role"><span class="d" style="background:${esc(HEX.test(r.color || '') ? r.color : '#99AAB5')}"></span>${roleIcon(r)}${esc(r.name)}</span>`).join('')}</div></div>` : ''}
        <div class="uc-sect"><h5>Member since</h5><p>${new Date(p.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</p></div>
        <div class="uc-acts">${isMe
          ? '<button class="btn btn-ghost btn-sm" data-a="edit"><i class="fa-solid fa-pen"></i>Edit profile</button>'
          : `${rel === 'friends' ? '' : rel === 'incoming' ? '<button class="btn btn-ok btn-sm" data-a="accept"><i class="fa-solid fa-check"></i>Accept request</button>'
            : rel === 'outgoing' ? '<button class="btn btn-ghost btn-sm" disabled><i class="fa-solid fa-clock"></i>Request sent</button>'
              : '<button class="btn btn-primary btn-sm" data-a="add"><i class="fa-solid fa-user-plus"></i>Add friend</button>'}
            <button class="icon-btn" data-a="more" title="More"><i class="fa-solid fa-ellipsis"></i></button>`}</div>
        ${isMe ? '' : `<form class="uc-msg"><input placeholder="Message @${esc(p.username)}" maxlength="4000"><button class="icon-btn" title="Send"><i class="fa-solid fa-paper-plane"></i></button></form>`}
      </div>`;
    const bn = el.querySelector('[data-bg]');
    if (bn) {
      const url = bn.dataset.bg;
      const set = (u) => { bn.style.backgroundImage = `url("${u.replace(/"/g, '%22')}")`; };
      if (window.Store?.isManaged(url)) window.Store.sign(url).then(set).catch(() => {}); else set(url);
    }
    place();
    el.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'edit') { close(); NX.go('settings/profile'); }
      if (a === 'add') { close(); NX.data.addFriend(p.username); }
      if (a === 'accept') { close(); NX.data.acceptFriend(uid); }
      if (a === 'more') {
        NX.menu(e.target.closest('[data-a]'), [
          { label: 'Message', icon: 'fa-message', onClick: () => { close(); NX.data.openDm(uid); } },
          { label: 'Start a call', icon: 'fa-phone', onClick: () => { close(); NX.data.openDm(uid, { call: true }); } },
          { label: 'Copy username', icon: 'fa-at', onClick: () => NX.copy('@' + p.username, 'Username copied') },
          { sep: true, hidden: rel !== 'friends' && rel !== 'outgoing' },
          { label: rel === 'outgoing' ? 'Cancel request' : 'Remove friend', icon: 'fa-user-minus', danger: true, hidden: rel !== 'friends' && rel !== 'outgoing', onClick: () => { close(); NX.data.removeFriend(uid, nameOf(p)); } },
          { sep: true },
          { label: NX.data?.isBlocked?.(uid) ? 'Unblock' : 'Block', icon: 'fa-ban', danger: true, onClick: () => { close(); NX.data.toggleBlock(uid, nameOf(p)); } },
        ], { anchor: true });
      }
    });
    el.querySelector('.uc-msg')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = e.target.querySelector('input').value.trim();
      if (!v) return;
      close();
      NX.data.openDm(uid, { send: v });
    });
  }

  NX.people = {
    CARD, put, get, need, fetchFull, nameOf, name, nameText, nameCss, bigName, nameStyle, fancy, asciiArt, NX_FONTS,
    avatar, decoPath, decoSrc, decoImg, haloClass, haloStyle, haloCss, haloImage, rank, roleBadge, roleIcon, ROLE_NAMES, imgAttr, tint,
    startPresence, setStatus, myStatus, presenceOf, isOnline, presenceDot, refreshDots, STATUS_LABEL, STATUS_COLOR,
    card, all: () => [...cache.values()],
  };
})();
