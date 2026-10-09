/* Sign-in page ambience: chat bubbles drifting up behind the card, a rotating
   tagline, and show/hide on password fields. Purely decorative -- auth.js
   owns the actual sign-in. */
(function () {
  // The spaces bar is painted from this cache before auth; never let the
  // next account see the last one's servers.
  try { sessionStorage.removeItem('nx_me_v1'); sessionStorage.removeItem('nx_spaces_v1'); } catch {}
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  /* ---- floating bubbles ---- */
  const LINES = ['gg', 'omw 🚀', 'vc?', 'lmaooo', 'brb', 'who’s on', 'ship it', '👀', 'gn 🌙', 'sup',
    'one more game', 'check dms', 'w', 'that’s wild', '🔥🔥', 'call in 5?', 'lol', 'ok ok', '💜', 'hop in'];
  const host = document.getElementById('bubbles');
  if (host && !reduce) {
    const spawn = (warm) => {
      const b = document.createElement('span');
      b.className = 'bub' + (Math.random() < 0.5 ? ' me' : '');
      b.textContent = LINES[(Math.random() * LINES.length) | 0];
      const dur = 16 + Math.random() * 18;
      b.style.left = (2 + Math.random() * 92) + '%';
      b.style.setProperty('--dur', dur + 's');
      b.style.setProperty('--sway', (Math.random() * 60 - 30) + 'px');
      b.style.setProperty('--s', (0.75 + Math.random() * 0.5).toFixed(2));
      // Pre-warm: start some mid-flight so the sky isn't empty on load.
      if (warm) b.style.animationDelay = -(Math.random() * dur) + 's';
      host.appendChild(b);
      b.addEventListener('animationend', () => b.remove());
    };
    for (let i = 0; i < 14; i++) spawn(true);
    setInterval(() => { if (!document.hidden && host.childElementCount < 22) spawn(false); }, 1600);
  }

  /* ---- rotating tagline ---- */
  // Minecraft-style splash lines: jokes, not claims about who is online.
  const TAGS = ['Not an enterprise product!', 'Stay a while!', 'Hop in, it’s late anyway', 'Now with more chatting!', 'Bring your friends!', 'Ask me about DMs!', 'Pings, not reports!'];
  const tag = document.getElementById('authTag');
  if (tag && !reduce) {
    let i = 0;
    setInterval(() => {
      tag.classList.add('out');
      setTimeout(() => { i = (i + 1) % TAGS.length; tag.textContent = TAGS[i]; tag.classList.remove('out'); }, 350);
    }, 4200);
  }

  /* ---- show / hide password ---- */
  document.querySelectorAll('[data-peek]').forEach((b) => {
    b.onclick = () => {
      const inp = document.getElementById(b.dataset.peek);
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = `<i class="fa-regular fa-eye${show ? '-slash' : ''}"></i>`;
      inp.focus();
    };
  });

  /* ---- card follows the cursor a touch ---- */
  const card = document.querySelector('.auth-panel');
  if (card && !reduce && matchMedia('(hover: hover)').matches) {
    const tilt = window.UI?.smooth
      ? UI.smooth({ rx: 0, ry: 0 }, (v) => { card.style.transform = `perspective(900px) rotateX(${v.rx.toFixed(3)}deg) rotateY(${v.ry.toFixed(3)}deg)`; }, 0.08)
      : null;
    window.addEventListener('pointermove', (e) => {
      const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
      tilt?.({ rx: -y * 4, ry: x * 5 });
    }, { passive: true });
    document.addEventListener('pointerleave', () => tilt?.({ rx: 0, ry: 0 }));
  }
})();
