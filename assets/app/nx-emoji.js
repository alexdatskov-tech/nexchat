/* Emoji picker. The catalogue (assets/js/emoji-data.js, ~150 KB) is loaded
   the first time the picker opens, not with the app. */
(function () {
  const { esc } = NX;
  const RECENT_KEY = 'nx.emoji.recent';
  let dataP = null, panel = null, onPick = null;

  function load() {
    if (window.EMOJI) return Promise.resolve();
    if (!dataP) {
      dataP = new Promise((ok, no) => {
        const s = document.createElement('script');
        s.src = 'assets/js/emoji-data.js?v=3';
        s.onload = ok;
        s.onerror = () => { dataP = null; no(new Error('Could not load emoji.')); };
        document.head.appendChild(s);
      });
    }
    return dataP;
  }
  // A reaction is a short emoji, never markup.
  const isEmoji = (e) => typeof e === 'string' && /^[^<>"'&\\\s]{1,16}$/u.test(e) && /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u00a9\u00ae\u203c-\u3299]/u.test(e);
  const recents = () => NX.ls.get(RECENT_KEY, ['👍', '❤️', '😂', '🔥', '😮', '😢', '🎉', '💀']).filter(isEmoji);
  function remember(e) { if (!isEmoji(e)) return; NX.ls.set(RECENT_KEY, [e, ...recents().filter((x) => x !== e)].slice(0, 32)); }

  function build() {
    const E = window.EMOJI;
    panel = document.createElement('div');
    panel.className = 'emoji-pick';
    panel.innerHTML = `
      <div class="ep-search"><i class="fa-solid fa-magnifying-glass"></i><input type="text" placeholder="Find the perfect emoji" spellcheck="false" autocomplete="off"></div>
      <div class="ep-rail">${[{ name: 'Frequently used', icon: 'fa-clock-rotate-left' }, ...E.groups].map((g, i) => `<button class="ep-cat${i ? '' : ' on'}" data-g="${i - 1}" data-tip="${esc(g.name)}" data-tip-pos="right"><i class="fa-solid ${g.icon}"></i></button>`).join('')}</div>
      <div class="ep-body"><div class="ep-grid"></div><div class="ep-none" hidden>No emoji match that.</div></div>
      <div class="ep-foot"><span class="ep-prev">🙂</span><span class="ep-name">Pick an emoji</span></div>`;
    const grid = panel.querySelector('.ep-grid');
    const parts = ['<div class="ep-sec" data-g="-1"><div class="ep-h">Frequently used</div><div class="ep-row ep-recent"></div></div>'];
    E.groups.forEach((g, gi) => {
      parts.push(`<div class="ep-sec" data-g="${gi}"><div class="ep-h">${esc(g.name)}</div><div class="ep-row">`
        + E.list.filter((x) => x[2] === gi).map((x) => `<button class="ep-e" data-e="${x[0]}" data-n="${esc(x[1])}" data-k="${esc(x[3] || '')}">${x[0]}</button>`).join('')
        + '</div></div>');
    });
    grid.innerHTML = parts.join('');
    const body = panel.querySelector('.ep-body');
    const input = panel.querySelector('input');
    const none = panel.querySelector('.ep-none');
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('.ep-e');
      if (b) {
        remember(b.dataset.e);
        const cb = onPick;
        if (!e.shiftKey) close();
        cb?.(b.dataset.e);
        return;
      }
      const c = e.target.closest('.ep-cat');
      if (c) {
        input.value = ''; filter('');
        const sec = grid.querySelector(`.ep-sec[data-g="${c.dataset.g}"]`);
        body.scrollTo({ top: sec.offsetTop - 4 });
      }
    });
    panel.addEventListener('pointerover', (e) => {
      const b = e.target.closest('.ep-e');
      if (!b) return;
      panel.querySelector('.ep-prev').textContent = b.dataset.e;
      panel.querySelector('.ep-name').textContent = `:${(b.dataset.n || '').replace(/\s+/g, '_')}:`;
    });
    body.addEventListener('scroll', NX.throttle(() => {
      let cur = '-1';
      grid.querySelectorAll('.ep-sec').forEach((s) => { if (s.offsetTop - 30 <= body.scrollTop) cur = s.dataset.g; });
      panel.querySelectorAll('.ep-cat').forEach((c) => c.classList.toggle('on', c.dataset.g === cur));
    }, 100), { passive: true });
    const filter = (q) => {
      q = q.trim().toLowerCase();
      let any = false;
      grid.querySelectorAll('.ep-sec').forEach((sec) => {
        let n = 0;
        sec.querySelectorAll('.ep-e').forEach((b) => {
          const hit = !q || (b.dataset.n || '').toLowerCase().includes(q) || (b.dataset.k || '').toLowerCase().includes(q);
          b.hidden = !hit; if (hit) n++;
        });
        sec.hidden = !n || (q && sec.dataset.g === '-1');
        if (n && !sec.hidden) any = true;
      });
      none.hidden = any;
    };
    input.addEventListener('input', () => filter(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const b = grid.querySelector('.ep-sec:not([hidden]) .ep-e:not([hidden])'); if (b) b.click(); }
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    });
  }

  function paintRecents() {
    panel.querySelector('.ep-recent').innerHTML = recents().map((e) => `<button class="ep-e" data-e="${esc(e)}" data-n="">${esc(e)}</button>`).join('');
  }

  function away(e) { if (panel && !panel.contains(e.target) && !e.target.closest('[data-emoji-anchor]')) close(); }
  function close() {
    if (!panel?.isConnected) return;
    panel.remove();
    onPick = null;
    document.removeEventListener('pointerdown', away, true);
  }

  async function open(anchor, cb) {
    if (panel?.isConnected) { close(); return; }
    try { await load(); } catch (e) { return NX.fail(e); }
    if (!panel) build();
    onPick = cb;
    paintRecents();
    const input = panel.querySelector('input');
    input.value = '';
    input.dispatchEvent(new Event('input'));
    document.body.appendChild(panel);
    if (!NX.isNarrow()) {
      const a = anchor.getBoundingClientRect();
      const r = panel.getBoundingClientRect();
      let x = a.right - r.width, y = a.top - r.height - 8;
      if (y < 8) y = a.bottom + 8;
      if (x < 8) x = Math.min(a.left, innerWidth - r.width - 8);
      panel.style.left = Math.max(8, x) + 'px';
      panel.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    }
    panel.querySelector('.ep-body').scrollTop = 0;
    if (!NX.isTouch()) input.focus();
    setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  }

  NX.emoji = { open, close, remember, recents, load, isEmoji };
})();
