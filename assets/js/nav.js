/* The left "spaces" bar shared by Home, Messages and every server page:
   home, DMs, announcements, one icon per server, create/join, profile.
   Also owns platform announcements: the megaphone panel, the unread dot and
   the live pop-up when an admin posts one. */
window.Nav = (function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SRV_KEY = 'nx_spaces_v1', SEEN_KEY = 'nx_ann_seen', ME_KEY = 'nx_me_v1';
  let me = null, opts = {}, anns = null, annOk = true, annSub = null;
  const annListeners = new Set();

  const store = {
    get(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {} },
    seen() { try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; } },
    markSeen(ts) { try { localStorage.setItem(SEEN_KEY, ts); } catch {} },
  };

  const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase() || '?';

  const PIP = '<b class="sp-pip" aria-hidden="true"></b>';

  function serverIcon(s) {
    const on = opts.active === s.id;
    const inner = s.icon_url
      ? `<img ${window.Store ? Store.imgAttr(s.icon_url) : `src="${esc(s.icon_url)}"`} alt="">`
      : `<span>${esc(initials(s.name))}</span>`;
    return `<a class="sp-item sp-srv${on ? ' on' : ''}" href="server.html?id=${esc(s.id)}" data-tip="${esc(s.name)}">${PIP}${inner}</a>`;
  }

  function paintServers(list) {
    const host = $('spServers');
    const html = list.map(serverIcon).join('');
    // Identical markup is left alone so icons never flash on a refresh.
    if (host && host.dataset.html !== html) { host.innerHTML = html; host.dataset.html = html; }
  }

  async function loadServers() {
    paintServers(store.get(SRV_KEY, []));      // instant paint from last visit
    const { data: mem } = await window.db.from('server_members').select('server_id').eq('user_id', me.id);
    const ids = (mem || []).map((m) => m.server_id);
    if (!ids.length) { paintServers([]); store.set(SRV_KEY, []); return; }
    const { data } = await window.db.from('servers').select('id,name,icon_url,created_at').in('id', ids).order('created_at', { ascending: true });
    const list = (data || []).map(({ id, name, icon_url }) => ({ id, name, icon_url }));
    store.set(SRV_KEY, list);
    paintServers(list);
  }

  /* ---------------- announcements ---------------- */
  const LEVEL = {
    info: { icon: 'fa-circle-info', label: 'Info' },
    update: { icon: 'fa-rocket', label: 'Update' },
    warning: { icon: 'fa-triangle-exclamation', label: 'Heads up' },
    event: { icon: 'fa-calendar-days', label: 'Event' },
  };
  const md = (t) => (window.MD ? MD.render(t || '') : esc(t || '').replace(/\n/g, '<br>'));

  function annCard(a, compact) {
    const lv = LEVEL[a.level] || LEVEL.info;
    const when = window.UI ? UI.timeLabel(a.created_at) : new Date(a.created_at).toLocaleString();
    return `<article class="ann lv-${esc(a.level || 'info')}${a.pinned ? ' pinned' : ''}${compact ? ' compact' : ''}">
      <div class="ann-ico"><i class="fa-solid ${lv.icon}"></i></div>
      <div class="ann-main">
        <div class="ann-meta"><span class="ann-tag">${lv.label}</span>${a.pinned ? '<span class="ann-pin"><i class="fa-solid fa-thumbtack"></i> Pinned</span>' : ''}<span class="ann-time">${esc(when)}</span></div>
        <h4>${esc(a.title)}</h4>
        ${a.body ? `<div class="ann-body m-text">${md(a.body)}</div>` : ''}
      </div>
    </article>`;
  }

  async function fetchAnnouncements() {
    const { data, error } = await window.db.from('announcements')
      .select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(30);
    if (error) {
      annOk = false;      // table not created yet: the feature simply stays hidden
      anns = [];
    } else {
      annOk = true;
      anns = (data || []).filter((a) => !a.expires_at || new Date(a.expires_at) > new Date());
    }
    paintAnnBadge();
    annListeners.forEach((f) => f(anns, annOk));
    return anns;
  }

  const latestTs = () => (anns || []).reduce((m, a) => (a.created_at > m ? a.created_at : m), '');
  const unread = () => (anns || []).filter((a) => a.created_at > store.seen()).length;

  function paintAnnBadge() {
    const b = document.querySelector('.sp-ann');
    if (!b) return;
    b.classList.toggle('hidden', !annOk);
    const n = unread();
    const dot = b.querySelector('.sp-badge');
    dot.textContent = n > 9 ? '9+' : n;
    dot.classList.toggle('hidden', !n);
  }

  function openAnnouncements() {
    closeDrawer();
    document.querySelector('.ann-panel')?.remove();
    const ov = document.createElement('div');
    ov.className = 'ann-panel';
    ov.innerHTML = `<div class="ann-sheet" role="dialog" aria-label="Announcements">
      <header><div><b>Announcements</b><small>News from the NexChat team</small></div>
      <button class="x-btn" data-x><i class="fa-solid fa-xmark"></i></button></header>
      <div class="ann-list">${(anns || []).length ? anns.map((a) => annCard(a)).join('')
        : '<div class="empty"><div class="ico"><i class="fa-solid fa-bullhorn"></i></div><h3>All quiet</h3><p>Announcements from the team will show up here.</p></div>'}</div>
    </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('in'));
    const close = () => { ov.classList.remove('in'); setTimeout(() => ov.remove(), 220); };
    ov.onclick = (e) => { if (e.target === ov || e.target.closest('[data-x]')) close(); };
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    if (latestTs()) store.markSeen(latestTs());
    paintAnnBadge();
  }

  function liveAnnouncements() {
    if (annSub || !window.db.channel) return;
    annSub = window.db.channel('announcements-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'announcements' }, (p) => {
        if (p.eventType === 'INSERT' && p.new?.title) {
          window.UI?.island({ title: p.new.title, body: 'New announcement', icon: 'fa-bullhorn', accent: true, duration: 5000, action: openAnnouncements });
        }
        fetchAnnouncements();
      }).subscribe();
  }

  /* ---------------- mobile drawer ---------------- */
  function openDrawer() {
    document.body.classList.add('nav-open');
    document.getElementById('rail')?.classList.add('open');
    if (!document.querySelector('.rail-scrim')) {
      const s = document.createElement('div');
      s.className = 'rail-scrim';
      s.onclick = closeDrawer;
      document.body.appendChild(s);
    }
  }
  function closeDrawer() {
    document.body.classList.remove('nav-open');
    document.getElementById('rail')?.classList.remove('open');
    document.querySelector('.rail-scrim')?.remove();
  }

  /* opts: { active: 'home' | 'dms' | <serverId>, onAdd?: () => void } */
  let mounted = false;
  function mount(profile, o = {}, early = false) {
    me = profile; opts = o;
    const nav = $('spaces');
    if (!nav || !me) return;
    const html = `
      <a class="sp-item sp-home${o.active === 'home' ? ' on' : ''}" href="portal.html" data-tip="Home">${PIP}<img src="assets/img/logo.svg" alt="NexChat"></a>
      <a class="sp-item sp-dms${o.active === 'dms' ? ' on' : ''}" href="dms.html" data-tip="Messages">${PIP}<i class="fa-solid fa-comment-dots"></i></a>
      <button class="sp-item sp-ann" data-tip="Announcements">${PIP}<i class="fa-solid fa-bullhorn"></i><span class="sp-badge hidden"></span></button>
      <div class="sp-sep"></div>
      <div class="sp-servers" id="spServers"></div>
      <button class="sp-item sp-add" data-tip="Create or join a server">${PIP}<i class="fa-solid fa-plus"></i></button>
      <div class="sp-fill"></div>
      ${me.is_platform_admin ? `<a class="sp-item sp-admin" href="admin.html" data-tip="Admin">${PIP}<i class="fa-solid fa-shield-halved"></i></a>` : ''}
      <a class="sp-me" href="profile.html" data-tip="Profile & settings">${window.UI ? UI.avatar(me, 40, { presence: true }) : ''}</a>`;
    // The early paint (from cache, before auth) and the real mount usually
    // produce the same bar: keep the DOM so nothing blinks or re-animates.
    if (nav.dataset.html !== html) {
      const servers = $('spServers')?.innerHTML;
      nav.innerHTML = html;
      nav.dataset.html = html;
      if (servers) $('spServers').innerHTML = servers;
    }
    nav.querySelector('.sp-ann').onclick = openAnnouncements;
    nav.querySelector('.sp-add').onclick = () => (o.onAdd ? o.onAdd() : UI.go('portal.html?new=1'));
    if (!nav.dataset.wired) {
      nav.dataset.wired = '1';
      nav.addEventListener('click', (e) => { if (e.target.closest('a.sp-item, a.sp-me')) closeDrawer(); });
      tooltips(nav);
      nav.addEventListener('pointerover', (e) => { const a = e.target.closest('a[href]'); if (a) warm(a.getAttribute('href')); });
    }
    if (early) { paintServers(store.get(SRV_KEY, [])); return; }
    mounted = true;
    try { sessionStorage.setItem(ME_KEY, JSON.stringify(me)); } catch {}
    loadServers().catch(() => {});
    fetchAnnouncements().then(liveAnnouncements).catch(() => {});
  }

  /* One floating tooltip for the whole bar. It glides between icons instead
     of popping a new box per hover, and fades rather than blinking. */
  function tooltips(nav) {
    if (!matchMedia('(hover: hover)').matches) return;
    const tip = document.createElement('div');
    tip.className = 'sp-tip';
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    let cur = null, hideT = 0;
    const show = (el) => {
      clearTimeout(hideT);
      const r = el.getBoundingClientRect();
      tip.textContent = el.dataset.tip;
      const first = !tip.classList.contains('show');
      if (first) tip.classList.add('jump');           // appear in place, then glide from here on
      tip.style.transform = `translate3d(${Math.round(r.right + 12)}px, ${Math.round(r.top + r.height / 2)}px, 0) translateY(-50%)`;
      if (first) { void tip.offsetWidth; tip.classList.remove('jump'); }
      tip.classList.add('show');
      cur = el;
    };
    const hide = () => { cur = null; hideT = setTimeout(() => tip.classList.remove('show'), 60); };
    nav.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el && el !== cur) show(el); else if (!el && cur) hide(); });
    nav.addEventListener('pointerleave', hide);
    nav.addEventListener('scroll', hide, { passive: true });
    window.addEventListener('pagehide', () => tip.classList.remove('show'));
  }

  /* Prerender a page the moment the pointer settles on a link to it, so the
     click lands on an already-built page (Chromium; elsewhere a no-op). */
  const warmed = new Set();
  function warm(href) {
    if (!href || warmed.has(href) || warmed.size > 8 || !HTMLScriptElement.supports?.('speculationrules')) return;
    if (window.__NX_SHELL__ || /admin|profile|server-settings|index\.html/.test(href)) return;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || url.href === location.href) return;
    warmed.add(href);
    const s = document.createElement('script');
    s.type = 'speculationrules';
    s.textContent = JSON.stringify({ prerender: [{ source: 'list', urls: [url.href], eagerness: 'immediate' }] });
    document.head.appendChild(s);
  }

  /* Paint the bar from the last visit right away, so a page switch shows the
     same bar on its very first frame (and the view transition keeps it still). */
  (function early() {
    let cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(ME_KEY)); } catch {}
    if (!cached || !$('spaces')) return;
    const page = location.pathname.split('/').pop() || 'portal.html';
    const active = page.startsWith('dms') ? 'dms' : page.startsWith('server') ? (window.UI?.params?.().get('id') || new URLSearchParams(location.search).get('id')) : 'home';
    try { if (!mounted) mount(cached, { active }, true); } catch {}
  })();

  function onAnnouncements(f) { annListeners.add(f); if (anns) f(anns, annOk); }

  return { mount, warm, openAnnouncements, onAnnouncements, annCard, fetchAnnouncements, openDrawer, closeDrawer, refreshServers: () => loadServers().catch(() => {}) };
})();
