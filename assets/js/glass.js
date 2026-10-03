/* Liquid glass mode (Settings → Appearance → Style).

   Clear, not frosted: panels stay transparent and the scene behind them is
   bent at the edges like a thick lens, using an SVG displacement filter as a
   backdrop-filter (Chromium). Elsewhere the panels are still clear glass,
   with edge highlights, just without the bend. A specular highlight follows
   the cursor across each panel and cards lean slightly toward it.

   Opt-in and lazy: nothing here costs anything until Glass.set(true). The CSS
   lives in this file so it also works inside the nexchat.svg launcher. */
window.Glass = (function () {
  let on = false, wired = false, styleEl = null;
  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Surfaces that become glass, and the subset that also tilts.
  const PANELS = ['.spaces', '.rail', '.dm-rail', '.chat-head', '.composer-inner', '.scard', '.hero', '.ann', '.set-nav', '.set-block',
    '.nav-id', '.kpi', '.modal', '.upop', '.popover', '.plus-menu', '.emoji-pick', '.vroom-bar', '.vstats', '.lrow', '.island', '.toast',
    '.home-top', '.ann-sheet', '.q-item', '.style-opt', '.tray-item', '.att-file', '.aplayer', '.cblock', '.pdfv', '.msgs-older',
    '.dm-tabs', '.search-pill', '.vc-dock', '.save-bar', '.auth-panel', '.vtile', '.pcard', '.rail-foot', '.m-acts'];
  const TILT = '.scard, .ann, .kpi, .style-opt, .q-item, .vtile, .pcard, .nav-id, .upop, .att-file, .aplayer';

  // Displacement maps: red ramps horizontally, green vertically, neutral
  // (128) across the middle, so only the rim of each panel refracts.
  const ramp = (ch, dir) => {
    const c = (v) => (ch === 'r' ? `rgb(${v},0,0)` : `rgb(0,${v},0)`);
    const g = dir === 'h' ? "x1='0' y1='0' x2='1' y2='0'" : "x1='0' y1='0' x2='0' y2='1'";
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100' preserveAspectRatio='none'>
      <linearGradient id='g' ${g}><stop offset='0' stop-color='${c(255)}'/><stop offset='.035' stop-color='${c(205)}'/>
      <stop offset='.1' stop-color='${c(128)}'/><stop offset='.9' stop-color='${c(128)}'/><stop offset='.965' stop-color='${c(51)}'/>
      <stop offset='1' stop-color='${c(0)}'/></linearGradient><rect width='100' height='100' fill='url(#g)'/></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/\s+/g, ' '));
  };

  function filterSvg() {
    if (document.getElementById('nx-glass-defs')) return;
    const box = document.createElement('div');
    box.innerHTML = `<svg id="nx-glass-defs" width="0" height="0" style="position:absolute;width:0;height:0" aria-hidden="true" focusable="false">
      <filter id="nx-lens" x="0" y="0" width="1" height="1" primitiveUnits="objectBoundingBox" color-interpolation-filters="sRGB">
        <feImage href="${ramp('r', 'h')}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="rx"/>
        <feImage href="${ramp('g', 'v')}" x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="gy"/>
        <feComposite in="rx" in2="gy" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="map"/>
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0.07" xChannelSelector="R" yChannelSelector="G"/>
      </filter></svg>`;
    document.body.appendChild(box.firstElementChild);
  }

  function css() {
    const P = PANELS.map((s) => `body.glass ${s}`).join(',\n');
    return `
body.glass { --txt-2: #C3C7D4; --txt-3: #8C92A4; --line: rgba(255,255,255,.12); --line-2: rgba(255,255,255,.2); }
.glass-scene { position: fixed; inset: 0; z-index: -3; overflow: hidden; pointer-events: none; display: none; background: #07060D; }
body.glass:not(.has-bg) .glass-scene { display: block; }
.glass-scene i { position: absolute; border-radius: 50%; filter: blur(40px); will-change: transform; }
.glass-scene i:nth-child(1) { width: 46vmax; height: 46vmax; left: -8vmax; top: -12vmax; background: radial-gradient(circle, #6D4BFF, transparent 62%); animation: gs1 22s ease-in-out infinite alternate; }
.glass-scene i:nth-child(2) { width: 40vmax; height: 40vmax; right: -10vmax; top: 20vh; background: radial-gradient(circle, #0FB9A5, transparent 62%); animation: gs2 26s ease-in-out infinite alternate; }
.glass-scene i:nth-child(3) { width: 34vmax; height: 34vmax; left: 30vw; bottom: -14vmax; background: radial-gradient(circle, #E0559B, transparent 62%); animation: gs3 19s ease-in-out infinite alternate; }
.glass-scene i:nth-child(4) { width: 22vmax; height: 22vmax; left: 55vw; top: 8vh; background: radial-gradient(circle, #F5B94A, transparent 62%); opacity: .6; animation: gs1 30s ease-in-out -8s infinite alternate-reverse; }
@keyframes gs1 { to { transform: translate(16vmax, 10vmax) scale(1.2); } }
@keyframes gs2 { to { transform: translate(-18vmax, -8vmax) scale(.85); } }
@keyframes gs3 { to { transform: translate(-12vmax, -16vmax) scale(1.25); } }

${P} {
  background: radial-gradient(220px circle at var(--gx, 18%) var(--gy, 0%), rgba(255,255,255,.17), transparent 70%),
              linear-gradient(155deg, rgba(255,255,255,.09), rgba(255,255,255,.015) 45%, rgba(255,255,255,.045)) !important;
  border-color: rgba(255,255,255,.18) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.42), inset 1px 0 0 rgba(255,255,255,.14), inset -1px 0 0 rgba(255,255,255,.05),
              inset 0 -1px 0 rgba(255,255,255,.08), inset 0 0 24px rgba(255,255,255,.04), 0 22px 50px -24px rgba(0,0,0,.75) !important;
  -webkit-backdrop-filter: saturate(1.7) brightness(1.08) contrast(1.05);
  backdrop-filter: saturate(1.7) brightness(1.08) contrast(1.05);
  backdrop-filter: url(#nx-lens) saturate(1.7) brightness(1.08) contrast(1.05);
}
body.glass .chat-head, body.glass .composer-inner, body.glass .rail-foot { border-radius: 0; }
body.glass .composer-inner { border-radius: 22px; }
body.glass .scard-banner::after { background: linear-gradient(to top, rgba(10,10,18,.55), transparent 70%); }
body.glass .scard-ico { border-color: rgba(255,255,255,.25); }
body.glass .hero-fx { opacity: .55; }
body.glass:not(.has-bg) .chat { position: relative; z-index: 0; }
body.glass:not(.has-bg) .chat::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: rgba(6,7,12,.38); }
body.glass .m-text, body.glass .m-name, body.glass h1, body.glass h2, body.glass .ann h4 { text-shadow: 0 1px 2px rgba(0,0,0,.45); }
body.glass .m:hover { background: rgba(255,255,255,.06); }
body.glass .overlay { background: rgba(4,4,8,.35); }
body.glass .set-bg { display: none; }
body.glass input:not([type=checkbox]):not([type=range]):not([type=color]):not([type=file]), body.glass textarea, body.glass select { background: rgba(0,0,0,.22) !important; }

/* Tilt: a few degrees toward the cursor, springing back on leave. */
body.glass :is(${TILT}) {
  transform: perspective(900px) rotateX(var(--tx, 0deg)) rotateY(var(--ty, 0deg)) translateY(var(--lift, 0px));
  transition: transform .5s cubic-bezier(.34,1.56,.64,1), box-shadow .3s;
  will-change: transform;
}
body.glass :is(${TILT}).tilting { transition: transform .12s linear; }
body.glass .scard:hover { --lift: -3px; }
`;
  }

  function scene() {
    if (document.querySelector('.glass-scene')) return;
    const s = document.createElement('div');
    s.className = 'glass-scene';
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<i></i><i></i><i></i><i></i>';
    document.body.prepend(s);
  }

  /* One rAF-throttled pointer handler for the whole page: it moves the
     highlight on whichever panel is under the cursor and tilts tilt-able
     cards. Only the hovered elements are touched. */
  let lastTilt = null, lastPanel = null, pending = null;
  const panelSel = PANELS.join(',');
  function onMove(e) {
    pending = e;
    if (onMove.raf) return;
    onMove.raf = requestAnimationFrame(() => {
      onMove.raf = 0;
      const ev = pending; if (!on || !ev) return;
      const t = ev.target instanceof Element ? ev.target : null;
      const panel = t?.closest(panelSel) || null;
      if (panel) {
        const r = panel.getBoundingClientRect();
        panel.style.setProperty('--gx', ((ev.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        panel.style.setProperty('--gy', ((ev.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      }
      if (lastPanel && lastPanel !== panel) { lastPanel.style.removeProperty('--gx'); lastPanel.style.removeProperty('--gy'); }
      lastPanel = panel;
      if (reduce()) return;
      const card = t?.closest(TILT) || null;
      if (lastTilt && lastTilt !== card) {
        lastTilt.classList.remove('tilting');
        lastTilt.style.setProperty('--tx', '0deg'); lastTilt.style.setProperty('--ty', '0deg');
      }
      lastTilt = card;
      if (card) {
        const r = card.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
        const k = Math.max(1.5, 6 - r.width / 160);      // big cards tilt less
        card.classList.add('tilting');
        card.style.setProperty('--tx', (-y * k).toFixed(2) + 'deg');
        card.style.setProperty('--ty', (x * k).toFixed(2) + 'deg');
      }
    });
  }

  function set(enable) {
    enable = !!enable;
    if (enable === on && (styleEl || !enable)) return;
    on = enable;
    if (on) {
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'nx-glass-css';
        styleEl.textContent = css();
        document.head.appendChild(styleEl);
      }
      filterSvg();
      scene();
      if (!wired && matchMedia('(hover: hover)').matches) {
        wired = true;
        document.addEventListener('pointermove', onMove, { passive: true });
      }
    }
    document.body.classList.toggle('glass', on);
  }

  return { set, get on() { return on; } };
})();
