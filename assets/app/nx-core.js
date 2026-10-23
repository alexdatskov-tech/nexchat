/* NexChat v3 core: DOM helpers, events, router, storage, formatting, and the
   shared overlay kit (toasts, notifications, modals, menus, tooltips).
   Everything hangs off window.NX. Plain scripts, no build step, so the SVG
   launcher (nexchat.svg) can inline them as-is. */
window.NX = (function () {
  const NX = { views: {} };

  /* ---------- DOM ---------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  NX.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
  NX.$ = (sel, root = document) => root.querySelector(sel);
  NX.$$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  NX.h = (html) => {
    const t = document.createElement('template');
    t.innerHTML = String(html).trim();
    return t.content.firstElementChild;
  };
  NX.frag = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    return t.content;
  };
  NX.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* Updates a list in place instead of re-rendering it: items are
     [{ key, html }]. An item whose html didn't change keeps its node; one
     that changed is rebuilt, but its child elements that didn't change are
     carried over, so avatars and icons never reload or flash. */
  const mark = (n) => { n.querySelectorAll?.('*').forEach((c) => { c._src = c.outerHTML; }); return n; };
  // Moves every unchanged descendant of `from` into `into` (matched by
  // position), so images keep their loaded, decoded element.
  function adopt(from, into) {
    const oc = [...from.children], nc = [...into.children];
    nc.forEach((c, i) => {
      const o = oc[i];
      if (!o || o.tagName !== c.tagName) return;
      if (o._src && o._src === c._src) into.replaceChild(o, c);
      else adopt(o, c);
    });
  }
  NX.patch = (box, items) => {
    if (!box) return;
    const old = new Map();
    [...box.children].forEach((n) => { if (n._k != null) old.set(n._k, n); else n.remove(); });
    let prev = null;
    for (const { key, html } of items) {
      let n = old.get(key);
      if (n && n._html !== html) {
        const fresh = mark(NX.h(html));
        if (fresh.tagName === n.tagName) adopt(n, fresh);
        fresh._k = key; fresh._html = html;
        n.replaceWith(fresh); n = fresh;
      } else if (!n) {
        n = mark(NX.h(html)); n._k = key; n._html = html;
      }
      old.delete(key);
      const want = prev ? prev.nextSibling : box.firstChild;
      if (n !== want) box.insertBefore(n, want);
      prev = n;
    }
    old.forEach((n) => n.remove());
  };
  NX.uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  NX.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  NX.throttle = (fn, ms) => {
    let last = 0, t = null;
    return (...a) => {
      const now = Date.now(), wait = ms - (now - last);
      if (wait <= 0) { last = now; fn(...a); }
      else if (!t) t = setTimeout(() => { t = null; last = Date.now(); fn(...a); }, wait);
    };
  };
  NX.isTouch = () => matchMedia('(hover: none)').matches;
  NX.isNarrow = () => matchMedia('(max-width: 860px)').matches;
  NX.copy = (text, what = 'Copied') => {
    const done = () => NX.toast(`${what} to clipboard.`);
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(done, () => fallback());
    fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch { NX.toast('Could not copy.', { err: true }); }
      ta.remove();
    }
  };

  /* ---------- events ---------- */
  const handlers = new Map();
  NX.on = (evt, fn) => {
    if (!handlers.has(evt)) handlers.set(evt, new Set());
    handlers.get(evt).add(fn);
    return () => handlers.get(evt)?.delete(fn);
  };
  NX.emit = (evt, data) => {
    handlers.get(evt)?.forEach((fn) => { try { fn(data); } catch (e) { console.error('NX handler', evt, e); } });
  };

  /* ---------- storage ---------- */
  const wrap = (area) => ({
    get(k, d = null) { try { const v = area().getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { area().setItem(k, JSON.stringify(v)); } catch { /* quota or private mode */ } },
    del(k) { try { area().removeItem(k); } catch {} },
  });
  NX.ls = wrap(() => localStorage);
  NX.ss = wrap(() => sessionStorage);

  /* ---------- formatting ---------- */
  NX.fmt = {
    bytes(b) {
      b = Number(b) || 0;
      if (b < 1024) return b + ' B';
      const u = ['KB', 'MB', 'GB', 'TB'];
      let i = -1;
      do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
      return (b >= 100 ? Math.round(b) : b.toFixed(1)) + ' ' + u[i];
    },
    time(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); },
    stamp(iso) {
      const d = new Date(iso), now = new Date();
      const t = NX.fmt.time(iso);
      if (d.toDateString() === now.toDateString()) return `Today at ${t}`;
      const y = new Date(now); y.setDate(now.getDate() - 1);
      if (d.toDateString() === y.toDateString()) return `Yesterday at ${t}`;
      return `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' })} ${t}`;
    },
    day(iso) {
      const d = new Date(iso), now = new Date();
      if (d.toDateString() === now.toDateString()) return 'Today';
      const y = new Date(now); y.setDate(now.getDate() - 1);
      if (d.toDateString() === y.toDateString()) return 'Yesterday';
      return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
    },
    full(iso) { return new Date(iso).toLocaleString([], { dateStyle: 'full', timeStyle: 'short' }); },
    ago(iso) {
      const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
      if (s < 45) return 'just now';
      if (s < 3600) return Math.round(s / 60) + 'm';
      if (s < 86400) return Math.round(s / 3600) + 'h';
      if (s < 86400 * 7) return Math.round(s / 86400) + 'd';
      return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; },
  };

  /* ---------- router ----------
     Hash routes (#/home, #/dm/<id>, #/s/<server>/<channel>, #/settings/...).
     Inside the SVG launcher the frame's own URL is about:srcdoc, so history
     calls may be refused; the route then simply lives in memory. */
  const shell = () => window.__NX_SHELL__ || null;
  let current = '';
  NX.route = () => {
    const raw = current.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    return { raw, path, parts: path.split('/').filter(Boolean).map(decodeURIComponent), q: new URLSearchParams(qs || '') };
  };
  NX.go = (to, { replace = false, silent = false } = {}) => {
    const h = '#/' + String(to).replace(/^#?\/?/, '');
    if (h === current && !replace) return;
    current = h;
    try {
      if (!shell()) history[replace ? 'replaceState' : 'pushState'](null, '', h);
    } catch { /* srcdoc or sandbox */ }
    if (!silent) NX.emit('route', NX.route());
  };
  NX.initRoute = () => {
    const sh = shell();
    current = (sh ? sh.hash : location.hash) || '';
    if (!current || current === '#' || current === '#/') current = '';
    window.addEventListener('popstate', () => {
      if (shell()) return;
      current = location.hash || '#/home';
      NX.emit('route', NX.route());
    });
    return NX.route();
  };
  // Query string of the page itself (?invite=, ?c=, ?id= from old links).
  NX.pageParams = () => new URLSearchParams(shell() ? shell().search : location.search);
  // Absolute link to a page of the app (invite links etc.).
  NX.pageUrl = (path) => new URL(path, shell() ? shell().site : location.href.replace(/[#?].*$/, '')).href;
  NX.reload = () => { if (shell()) shell().go('index.html'); else location.reload(); };

  /* Loads a font file under a generated family name through the FontFace API
     (no CSS text is built from the URL, so it can't inject styles). Only
     https and our own blob: previews are accepted. Returns the family or null. */
  const fontFaces = new Map();
  NX.fontFace = (raw) => {
    let u;
    try { u = new URL(String(raw || ''), location.href); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'blob:') return null;
    if (fontFaces.has(u.href)) return fontFaces.get(u.href);
    let h = 0;
    for (const ch of u.href) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
    const fam = 'NxFont' + (h >>> 0).toString(36);
    fontFaces.set(u.href, fam);
    try {
      const face = new FontFace(fam, `url(${JSON.stringify(u.href)})`, { display: 'swap' });
      document.fonts.add(face);
      face.load().catch(() => {});
    } catch { return null; }
    return fam;
  };

  /* ---------- layer ---------- */
  function layer(cls) {
    let el = document.querySelector('.' + cls);
    if (!el) { el = document.createElement('div'); el.className = cls; document.body.appendChild(el); }
    return el;
  }

  /* ---------- toasts ---------- */
  NX.toast = (msg, opts = {}) => {
    if (typeof opts === 'boolean') opts = { err: opts };
    const host = layer('toasts');
    const el = NX.h(`<div class="toast${opts.err ? ' err' : ''}" role="status">
      <i class="fa-solid ${opts.err ? 'fa-circle-exclamation' : (opts.icon || 'fa-circle-check')}"></i>
      <span>${NX.esc(msg)}</span>${opts.action ? `<button type="button">${NX.esc(opts.action.label)}</button>` : ''}</div>`);
    host.appendChild(el);
    while (host.children.length > 3) host.firstElementChild.remove();
    const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
    if (opts.action) el.querySelector('button').onclick = () => { kill(); opts.action.fn(); };
    setTimeout(kill, opts.ms || (opts.err ? 5000 : 3200));
    return kill;
  };
  // RLS turns a refused update/delete into "0 rows, no error". Wrap such a
  // query to get an error back when nothing was actually changed.
  NX.must = async (q, msg) => {
    const { data, error } = await q.select();
    if (error) return { data: null, error };
    if (!data || !data.length) return { data: null, error: { message: msg || 'You don\u2019t have permission to do that.' } };
    return { data, error: null };
  };
  NX.fail = (err, prefix) => {
    const m = (err && (err.message || err.error_description || err.msg)) || String(err || 'Something went wrong.');
    NX.toast(prefix ? `${prefix}: ${m}` : m, { err: true });
  };

  /* Notification card (top right): new DMs, friend requests, calls. */
  NX.island = (o) => {
    const host = layer('islands');
    const el = NX.h(`<div class="island${o.ring ? ' ring' : ''}${o.onClick ? ' click' : ''}">
      <div class="isl-ico">${o.avatar || `<i class="fa-solid ${o.icon || 'fa-bell'}"></i>`}</div>
      <div class="isl-txt"><b>${NX.esc(o.title || '')}</b>${o.body ? `<small>${NX.esc(o.body)}</small>` : ''}</div>
      ${o.actions ? `<div class="isl-acts">${o.actions.map((a, i) => `<button class="round-btn ${a.cls || ''}" data-i="${i}" title="${NX.esc(a.label)}"><i class="fa-solid ${a.icon}"></i></button>`).join('')}</div>` : ''}
    </div>`);
    host.prepend(el);
    while (host.children.length > 4) host.lastElementChild.remove();
    setTimeout(() => el.classList.add('in'), 20);
    let gone = false, timer;
    const close = () => { if (gone) return; gone = true; clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 250); };
    const arm = () => { clearTimeout(timer); timer = setTimeout(close, o.ms || 5000); };
    arm();
    el.onmouseenter = () => clearTimeout(timer);
    el.onmouseleave = arm;
    el.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { e.stopPropagation(); close(); o.actions[+b.dataset.i].fn(); return; }
      if (o.onClick) { close(); o.onClick(); }
    };
    return close;
  };

  /* ---------- modals ---------- */
  const openModals = [];
  NX.modal = (o) => {
    const ov = NX.h(`<div class="overlay" role="dialog" aria-modal="true">
      <div class="modal ${o.cls || ''}${o.wide ? ' wide' : ''}${o.center ? ' center' : ''}">
        ${o.title ? `<div class="modal-head"><div class="grow">${o.icon ? `<div style="margin-bottom:10px">${o.icon}</div>` : ''}<h3>${NX.esc(o.title)}</h3>${o.sub ? `<p>${o.sub}</p>` : ''}</div>
          ${o.noX ? '' : '<button class="icon-btn" data-x aria-label="Close"><i class="fa-solid fa-xmark"></i></button>'}</div>` : ''}
        <div class="modal-body"></div>
        ${o.foot ? '<div class="modal-foot"></div>' : ''}
      </div></div>`);
    const body = ov.querySelector('.modal-body');
    if (typeof o.body === 'string') body.innerHTML = o.body; else if (o.body) body.appendChild(o.body);
    if (!o.body) body.remove();
    let closed = false, resolve;
    const result = new Promise((r) => { resolve = r; });
    const close = (v) => {
      if (closed) return;
      closed = true;
      openModals.splice(openModals.indexOf(api), 1);
      ov.classList.add('closing');
      setTimeout(() => ov.remove(), 120);
      o.onClose?.(v);
      resolve(v);
    };
    const api = { el: ov, body, close, result, modal: ov.querySelector('.modal') };
    if (o.foot) {
      const foot = ov.querySelector('.modal-foot');
      o.foot.forEach((b) => {
        if (b.left) { const s = NX.h(`<div class="left"></div>`); s.append(typeof b.left === 'string' ? NX.h(b.left) : b.left); foot.appendChild(s); return; }
        const btn = NX.h(`<button type="button" class="btn ${b.cls || 'btn-quiet'}">${b.icon ? `<i class="fa-solid ${b.icon}"></i>` : ''}${NX.esc(b.label)}</button>`);
        btn.onclick = async () => {
          if (btn.classList.contains('busy')) return;   // Enter can't submit twice
          if (!b.onClick) return close(b.value);
          btn.classList.add('busy');
          try {
            const out = await b.onClick(api);
            if (out !== false) close(out === undefined ? b.value : out);
          } catch (e) { NX.fail(e); }
          finally { btn.classList.remove('busy'); }
        };
        if (b.primary) api.primary = btn;
        foot.appendChild(btn);
      });
    }
    ov.addEventListener('mousedown', (e) => { if (e.target === ov && !o.sticky) ov._down = true; });
    ov.addEventListener('click', (e) => {
      if (e.target === ov && ov._down) close(null);
      ov._down = false;
      if (e.target.closest('[data-x]')) close(null);
    });
    document.body.appendChild(ov);
    openModals.push(api);
    setTimeout(() => {
      const f = o.focus ? ov.querySelector(o.focus) : ov.querySelector('input:not([type=checkbox]):not([type=file]), textarea');
      if (f && !NX.isTouch()) f.focus();
    }, 40);
    if (o.onOpen) o.onOpen(api);
    return api;
  };
  NX.topModal = () => openModals[openModals.length - 1] || null;

  NX.confirm = (o) => NX.modal({
    title: o.title, body: o.body ? `<p>${o.html ? o.body : NX.esc(o.body)}</p>` : '',
    foot: [
      { label: 'Cancel', value: false },
      { label: o.ok || (o.danger ? 'Delete' : 'Confirm'), cls: o.danger ? 'btn-danger' : 'btn-primary', value: true, primary: true },
    ],
    focus: '.modal-foot .btn:last-child',
  }).result.then((v) => v === true);

  NX.prompt = (o) => {
    const body = NX.h(`<div class="field">
      ${o.label ? `<label>${NX.esc(o.label)}</label>` : ''}
      ${o.multiline ? `<textarea class="input" rows="3" maxlength="${o.max || 2000}" placeholder="${NX.esc(o.placeholder || '')}"></textarea>`
        : `<input class="input" type="${o.type || 'text'}" maxlength="${o.max || 200}" placeholder="${NX.esc(o.placeholder || '')}" autocomplete="off">`}
      ${o.hint ? `<span class="hint">${NX.esc(o.hint)}</span>` : ''}
      <p class="err"></p></div>`);
    const input = body.querySelector('input, textarea');
    input.value = o.value || '';
    const m = NX.modal({
      title: o.title, sub: o.sub, body,
      foot: [
        { label: 'Cancel', value: null },
        {
          label: o.ok || 'Save', cls: o.danger ? 'btn-danger' : 'btn-primary', primary: true,
          onClick: async () => {
            const v = input.value.trim();
            if (!v && !o.allowEmpty) { body.querySelector('.err').textContent = 'This can’t be empty.'; return false; }
            if (o.validate) {
              const bad = await o.validate(v);
              if (bad) { body.querySelector('.err').textContent = bad; return false; }
            }
            return v;
          },
        },
      ],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !o.multiline) { e.preventDefault(); m.primary.click(); } });
    setTimeout(() => { input.focus(); input.select?.(); }, 50);
    return m.result;
  };

  /* ---------- context menu ----------
     items: [{ label, icon, onClick, danger, sep, hidden, kbd, header, html }]
     at: a MouseEvent (opens at the pointer) or an element (opens beside it). */
  let openMenu = null;
  NX.closeMenu = () => { if (openMenu) { openMenu.el.remove(); openMenu.onClose?.(); openMenu = null; } };
  NX.menu = (at, items, opts = {}) => {
    NX.closeMenu();
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    const list = items.filter((i) => i && !i.hidden);
    el.innerHTML = list.map((it, i) => {
      if (it.sep) return '<div class="sep"></div>';
      if (it.header) return `<div class="m-h">${NX.esc(it.header)}</div>`;
      if (it.html) return it.html;
      return `<button type="button" data-i="${i}" class="${it.danger ? 'danger' : ''}${it.on ? ' on' : ''}" role="menuitem">
        ${it.icon ? `<i class="fa-solid ${it.icon}"></i>` : ''}${it.dot ? `<span class="status-dot" style="background:${it.dot}"></span>` : ''}<span class="grow">${NX.esc(it.label)}</span>${it.kbd ? `<span class="k">${NX.esc(it.kbd)}</span>` : ''}</button>`;
    }).join('');
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b) return;
      e.stopPropagation();
      const it = list[+b.dataset.i];
      NX.closeMenu();
      it.onClick?.();
    });
    opts.wire?.(el);
    // position
    const r = el.getBoundingClientRect();
    let x, y;
    if (!(at instanceof Element) && at && at.clientX != null) { x = at.clientX; y = at.clientY; }
    else {
      const a = at.getBoundingClientRect();
      if (opts.side === 'right') { x = a.right + 8; y = a.top; }
      else if (opts.side === 'top') { x = a.left; y = a.top - r.height - 6; }
      else { x = opts.alignRight ? a.right - r.width : a.left; y = a.bottom + 6; }
    }
    x = Math.max(8, Math.min(x, innerWidth - r.width - 8));
    if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
    el.style.left = x + 'px'; el.style.top = Math.max(8, y) + 'px';
    openMenu = { el, onClose: opts.onClose };
    return el;
  };
  document.addEventListener('pointerdown', (e) => { if (openMenu && !openMenu.el.contains(e.target)) NX.closeMenu(); }, true);
  window.addEventListener('blur', () => NX.closeMenu());
  window.addEventListener('resize', () => NX.closeMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (openMenu) { NX.closeMenu(); e.stopImmediatePropagation(); e.preventDefault(); return; }
    const m = NX.topModal();
    if (m) { m.close(null); e.stopImmediatePropagation(); e.preventDefault(); }
  });

  /* ---------- tooltips: any element with data-tip ---------- */
  (function tips() {
    if (!matchMedia('(hover: hover)').matches) return;
    let tip = null, cur = null, t = 0;
    const show = (el) => {
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; document.body.appendChild(tip); }
      tip.textContent = el.dataset.tip;
      const r = el.getBoundingClientRect();
      tip.style.left = '0px'; tip.style.top = '0px';
      tip.classList.add('show');
      const tr = tip.getBoundingClientRect();
      let x, y;
      if (el.dataset.tipPos === 'right') { x = r.right + 12; y = r.top + r.height / 2 - tr.height / 2; }
      else if (el.dataset.tipPos === 'bottom') { x = r.left + r.width / 2 - tr.width / 2; y = r.bottom + 8; }
      else { x = r.left + r.width / 2 - tr.width / 2; y = r.top - tr.height - 8; }
      tip.style.left = Math.max(6, Math.min(x, innerWidth - tr.width - 6)) + 'px';
      tip.style.top = Math.max(6, y) + 'px';
    };
    document.addEventListener('pointerover', (e) => {
      const el = e.target.closest?.('[data-tip]');
      if (el === cur) return;
      cur = el;
      clearTimeout(t);
      if (!el) { tip?.classList.remove('show'); return; }
      t = setTimeout(() => { if (cur === el && el.isConnected) show(el); }, el.dataset.tipPos === 'right' ? 0 : 350);
    });
    document.addEventListener('pointerdown', () => { clearTimeout(t); tip?.classList.remove('show'); cur = null; }, true);
    document.addEventListener('scroll', () => tip?.classList.remove('show'), true);
  })();

  return NX;
})();
