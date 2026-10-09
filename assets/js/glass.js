/* Liquid glass mode (Settings → Appearance → Style).

   Clear glass: panels stay transparent with a thin edge. Refraction (an SVG
   displacement filter used as a backdrop-filter, Chromium only) is applied to
   fixed chrome only, the rails and headers that never sit over scrolling
   content. Everything else is plain translucent glass with no backdrop filter,
   because re-sampling a blur behind a scrolling list every frame is what made
   the mode lag. The scene behind the glass is static for the same reason. A
   soft highlight appears under the cursor on the panel it is over and is
   cleared when the cursor leaves that panel or the window.

   Opt-in and lazy: nothing here costs anything until Glass.set(true). The CSS
   lives in this file so it also works inside the nexchat.svg launcher. */
window.Glass = (function () {
  let on = false, wired = false, styleEl = null;
  const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Every surface that becomes glass.
  const PANELS = ['.spaces', '.rail', '.dm-rail', '.chat-head', '.composer-inner', '.scard', '.hero', '.ann', '.set-nav', '.set-block',
    '.nav-id', '.kpi', '.modal', '.upop', '.popover', '.plus-menu', '.emoji-pick', '.vroom-bar', '.vstats', '.lrow', '.island', '.toast',
    '.home-top', '.ann-sheet', '.q-item', '.style-opt', '.tray-item', '.att-file', '.aplayer', '.cblock', '.pdfv', '.msgs-older',
    '.dm-tabs', '.search-pill', '.vc-dock', '.save-bar', '.auth-panel', '.vtile', '.pcard', '.rail-foot', '.m-acts'];
  // The subset that gets refraction: fixed chrome, never over the scrolling message list.
  const LENS = ['.spaces', '.rail', '.dm-rail', '.chat-head', '.set-nav', '.nav-id', '.rail-foot'];
  // Surfaces that also tilt toward the cursor.
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
    const sel = (list) => list.map((s) => `body.glass ${s}`).join(',\n');
    const plain = PANELS.filter((s) => !LENS.includes(s));
    return `
/* Non-inherited, so moving the highlight restyles one panel, not every
   message and channel inside it. */
@property --gx { syntax: '<percentage>'; inherits: false; initial-value: 50%; }
@property --gy { syntax: '<percentage>'; inherits: false; initial-value: 50%; }
body.glass { --txt-2: #C3C7D4; --txt-3: #8C92A4; --line: rgba(255,255,255,.1); --line-2: rgba(255,255,255,.16); }
.glass-scene { position: fixed; inset: 0; z-index: -3; overflow: hidden; pointer-events: none; display: none; background: #07060D; }
body.glass:not(.has-bg) .glass-scene { display: block; }
.glass-scene i { position: absolute; border-radius: 50%; }
.glass-scene i:nth-child(1) { width: 50vmax; height: 50vmax; left: -10vmax; top: -14vmax; background: radial-gradient(closest-side, var(--amb-1), transparent); }
.glass-scene i:nth-child(2) { width: 44vmax; height: 44vmax; right: -12vmax; top: 18vh; background: radial-gradient(closest-side, var(--amb-2), transparent); }
.glass-scene i:nth-child(3) { width: 38vmax; height: 38vmax; left: 28vw; bottom: -16vmax; background: radial-gradient(closest-side, var(--amb-3), transparent); }
.glass-scene i:nth-child(4) { width: 26vmax; height: 26vmax; left: 53vw; top: 6vh; background: radial-gradient(closest-side, color-mix(in oklab, var(--amb-1), var(--amb-3)), transparent); opacity: .5; }

/* Clear glass for every panel: no blur, a thin edge, and a highlight that only
   exists while the cursor is over the panel (--ga is set by the pointer code). */
${sel(PANELS)} {
  background: radial-gradient(220px circle at var(--gx, 50%) var(--gy, 50%), rgba(255,255,255,var(--ga, 0)), transparent 70%),
              linear-gradient(155deg, rgba(255,255,255,.07), rgba(255,255,255,.012) 50%, rgba(255,255,255,.03)) !important;
  border-color: rgba(255,255,255,.12) !important;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 18px 40px -26px rgba(0,0,0,.7) !important;
}
/* Refraction only on fixed chrome. */
${sel(LENS)} {
  -webkit-backdrop-filter: saturate(1.4);
  backdrop-filter: url(#nx-lens) saturate(1.4) brightness(1.04) !important;
}
/* Everything that scrolls under or over content: no backdrop filter at all. */
${sel(plain)} {
  -webkit-backdrop-filter: none !important;
  backdrop-filter: none !important;
}
body.glass .chat-head, body.glass .composer-inner, body.glass .rail-foot { border-radius: 0; }
body.glass .composer-inner { border-radius: 22px; }
body.glass .scard-banner::after { background: linear-gradient(to top, rgba(10,10,18,.55), transparent 70%); }
body.glass .scard-ico { border-color: rgba(255,255,255,.2); }
body.glass .hero-fx { opacity: .5; }
body.glass:not(.has-bg) .chat { position: relative; z-index: 0; }
body.glass:not(.has-bg) .chat::before { content: ''; position: absolute; inset: 0; z-index: -1; pointer-events: none; background: rgba(6,7,12,.38); }
body.glass .m-text, body.glass .m-name, body.glass h1, body.glass h2, body.glass .ann h4 { text-shadow: 0 1px 2px rgba(0,0,0,.45); }
body.glass .m:hover { background: rgba(255,255,255,.05); }
body.glass .overlay { background: rgba(4,4,8,.35); }
body.glass .set-bg { display: none; }
body.glass input:not([type=checkbox]):not([type=range]):not([type=color]):not([type=file]), body.glass textarea, body.glass select { background: rgba(0,0,0,.22) !important; }

/* Tilt: glass.js writes the transform itself every frame (eased toward the
   cursor and back), so no CSS transition may chase it. */
body.glass :is(${TILT}) { transition-property: border-color, opacity, color, background-color; }
body.glass :is(${TILT}).tilting { will-change: transform; }
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
  const clearHighlight = (el) => { el.style.removeProperty('--gx'); el.style.removeProperty('--gy'); el.style.removeProperty('--ga'); };
  function onMove(e) {
    pending = e;
    if (onMove.raf) return;
    onMove.raf = requestAnimationFrame(() => {
      onMove.raf = 0;
      const ev = pending; if (!on || !ev) return;
      const t = ev.target instanceof Element ? ev.target : null;
      const panel = t?.closest(panelSel) || null;
      if (lastPanel && lastPanel !== panel) { clearHighlight(lastPanel); lastPanel = null; }
      if (panel) {
        const r = panel.getBoundingClientRect();
        panel.style.setProperty('--gx', ((ev.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        panel.style.setProperty('--gy', ((ev.clientY - r.top) / r.height * 100).toFixed(1) + '%');
        panel.style.setProperty('--ga', '0.16');
        lastPanel = panel;
      }
      if (reduce()) return;
      const card = t?.closest(TILT) || null;
      if (lastTilt && lastTilt !== card) release(lastTilt);
      lastTilt = card;
      if (card) {
        const r = card.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width - 0.5, y = (ev.clientY - r.top) / r.height - 0.5;
        const k = Math.max(1.5, 6 - r.width / 160);      // big cards tilt less
        tiltOf(card)({ tx: -y * k, ty: x * k, lift: card.matches('.scard') ? -4 : 0 });
      }
    });
  }

  /* Each tilting card gets its own smoother; it eases back to flat on
     leave and then hands the transform back to the stylesheet. */
  const tilters = new WeakMap();
  function tiltOf(card) {
    let f = tilters.get(card);
    if (!f) {
      const ease = window.UI?.smooth || ((i, apply) => (v) => apply({ ...i, ...v }, true));
      f = ease({ tx: 0, ty: 0, lift: 0 }, (v, done) => {
        if (done && !v.tx && !v.ty && !v.lift) { card.style.transform = ''; card.classList.remove('tilting'); return; }
        card.classList.add('tilting');
        card.style.transform = `perspective(900px) rotateX(${v.tx.toFixed(3)}deg) rotateY(${v.ty.toFixed(3)}deg) translateY(${v.lift.toFixed(2)}px)`;
      }, 0.14);
      tilters.set(card, f);
    }
    return f;
  }
  const release = (card) => tiltOf(card)({ tx: 0, ty: 0, lift: 0 });
  // pointerout with no relatedTarget means the cursor left the window: clear
  // the highlight and the tilt so nothing stays lit or leaning.
  document.addEventListener('pointerout', (e) => {
    if (e.relatedTarget) return;
    if (lastPanel) { clearHighlight(lastPanel); lastPanel = null; }
    if (lastTilt) { release(lastTilt); lastTilt = null; }
  });

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
