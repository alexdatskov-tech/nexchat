/* The composer's "+" button: spins open a menu with uploads, a voice
   recorder, Markdown snippets and a full Markdown editor with live preview.
   Shared by DMs (dms.js) and server channels (server.js).

   ComposerPlus.attach({ button, input, fileInput, stage })
     button     the + button in the composer
     input      the message <textarea>
     fileInput  the existing <input type=file multiple>
     stage(fs)  the page's "add these files to the tray" function       */
window.ComposerPlus = (function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const ITEMS = [
    { k: 'files', icon: 'fa-file-arrow-up', label: 'Upload files', sub: 'Anything up to 100 MB' },
    { k: 'media', icon: 'fa-photo-film', label: 'Photos & videos', sub: 'From your device or camera roll' },
    { k: 'voice', icon: 'fa-microphone-lines', label: 'Voice message', sub: 'Record and send audio' },
    { sep: true },
    { k: 'md', icon: 'fa-wand-magic-sparkles', label: 'Markdown editor', sub: 'Write with a live preview' },
    { k: 'code', icon: 'fa-code', label: 'Code block', sub: '```lang … ```' },
    { k: 'spoiler', icon: 'fa-eye-slash', label: 'Spoiler', sub: '||hidden until clicked||' },
    { k: 'quote', icon: 'fa-quote-left', label: 'Quote', sub: '> quoted text' },
    { k: 'table', icon: 'fa-table', label: 'Table', sub: 'A starter grid' },
  ];

  /* ---------- text helpers ---------- */
  function insert(ta, before, after = '', placeholder = '') {
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
    const sel = ta.value.slice(a, b) || placeholder;
    ta.value = ta.value.slice(0, a) + before + sel + after + ta.value.slice(b);
    ta.focus();
    ta.setSelectionRange(a + before.length, a + before.length + sel.length);
    ta.dispatchEvent(new Event('input'));
  }
  function prefixLines(ta, prefix, placeholder) {
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
    const sel = ta.value.slice(a, b) || placeholder;
    const out = sel.split('\n').map((l) => prefix + l).join('\n');
    const lead = a > 0 && ta.value[a - 1] !== '\n' ? '\n' : '';
    ta.value = ta.value.slice(0, a) + lead + out + ta.value.slice(b);
    ta.focus();
    ta.setSelectionRange(a + lead + prefix.length, a + lead.length + out.length);
    ta.dispatchEvent(new Event('input'));
  }
  const TABLE = '| Column | Column |\n| --- | --- |\n| Cell | Cell |\n';

  /* ---------- Markdown editor modal ---------- */
  function mdEditor(ta) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `<div class="modal md-modal">
      <div class="modal-head"><h3><i class="fa-solid fa-wand-magic-sparkles" style="color:var(--accent-hi)"></i> Markdown editor</h3><button class="x-btn" data-x><i class="fa-solid fa-xmark"></i></button></div>
      <div class="md-tools">
        ${[['b', 'fa-bold', 'Bold'], ['i', 'fa-italic', 'Italic'], ['u', 'fa-underline', 'Underline'], ['s', 'fa-strikethrough', 'Strike'],
           ['h', 'fa-heading', 'Heading'], ['c', 'fa-code', 'Inline code'], ['cb', 'fa-file-code', 'Code block'], ['l', 'fa-link', 'Link'],
           ['ul', 'fa-list-ul', 'List'], ['ol', 'fa-list-ol', 'Numbered list'], ['q', 'fa-quote-left', 'Quote'], ['sp', 'fa-eye-slash', 'Spoiler'],
           ['t', 'fa-table', 'Table'], ['hr', 'fa-minus', 'Divider']]
          .map(([k, ic, t]) => `<button type="button" data-t="${k}" title="${t}"><i class="fa-solid ${ic}"></i></button>`).join('')}
      </div>
      <div class="md-split">
        <textarea class="md-src" spellcheck="true" placeholder="Write **anything**…"></textarea>
        <div class="md-prev m-text"></div>
      </div>
      <div class="modal-foot"><span class="md-count"></span><span style="flex:1"></span>
        <button class="btn btn-quiet" data-x>Cancel</button>
        <button class="btn btn-primary" data-ins><i class="fa-solid fa-arrow-down"></i> Put in message</button></div>
    </div>`;
    document.body.appendChild(ov);
    const src = ov.querySelector('.md-src'), prev = ov.querySelector('.md-prev'), count = ov.querySelector('.md-count');
    src.value = ta.value;
    const render = () => {
      prev.innerHTML = src.value.trim() ? (window.MD ? MD.render(src.value) : esc(src.value)) : '<span class="md-empty">Preview appears here.</span>';
      prev.querySelectorAll('.spoil').forEach((x) => { x.onclick = () => x.classList.add('shown'); });
      count.textContent = `${src.value.length} characters`;
    };
    src.addEventListener('input', render);
    render();
    setTimeout(() => src.focus(), 50);
    const T = {
      b: () => insert(src, '**', '**', 'bold'), i: () => insert(src, '*', '*', 'italic'), u: () => insert(src, '__', '__', 'underline'),
      s: () => insert(src, '~~', '~~', 'struck'), h: () => prefixLines(src, '## ', 'Heading'), c: () => insert(src, '`', '`', 'code'),
      cb: () => insert(src, '```js\n', '\n```', '// code'), l: () => insert(src, '[', '](https://)', 'link text'),
      ul: () => prefixLines(src, '- ', 'item'), ol: () => prefixLines(src, '1. ', 'item'), q: () => prefixLines(src, '> ', 'quote'),
      sp: () => insert(src, '||', '||', 'spoiler'), t: () => insert(src, (src.value && !src.value.endsWith('\n') ? '\n' : '') + TABLE, ''),
      hr: () => insert(src, '\n---\n', ''),
    };
    ov.querySelectorAll('[data-t]').forEach((b) => { b.onclick = () => T[b.dataset.t](); });
    src.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) { e.preventDefault(); T[e.key.toLowerCase()](); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); done(true); }
    });
    const done = (put) => {
      if (put) { ta.value = src.value; ta.dispatchEvent(new Event('input')); ta.focus(); }
      ov.remove();
    };
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-x]')) done(false); });
    ov.querySelector('[data-ins]').onclick = () => done(true);
  }

  /* ---------- voice recorder ---------- */
  function recorder(composer, stage) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return UI.toast('Voice messages aren’t supported in this browser.', true);
    }
    if (composer.querySelector('.rec-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'rec-bar';
    bar.innerHTML = `<span class="rec-dot"></span><b class="rec-t">0:00</b>
      <div class="rec-wave">${'<i></i>'.repeat(28)}</div>
      <button class="btn btn-quiet btn-sm" data-c><i class="fa-solid fa-trash-can"></i></button>
      <button class="btn btn-primary btn-sm" data-s><i class="fa-solid fa-paper-plane"></i> Add</button>`;
    composer.prepend(bar);
    let rec, stream, chunks = [], t0 = Date.now(), timer, raf, actx, keep = false;
    const stop = () => {
      clearInterval(timer); cancelAnimationFrame(raf);
      try { rec && rec.state !== 'inactive' && rec.stop(); } catch {}
      stream?.getTracks().forEach((t) => t.stop());
      try { actx?.close(); } catch {}
    };
    const close = () => { stop(); bar.remove(); };
    bar.querySelector('[data-c]').onclick = () => { keep = false; close(); };
    bar.querySelector('[data-s]').onclick = () => { keep = true; stop(); };
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then((s) => {
      stream = s;
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
      rec = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        if (keep && chunks.length) {
          const type = rec.mimeType || chunks[0].type || 'audio/webm';
          const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'weba';
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          stage([new File(chunks, `voice-message-${stamp}.${ext}`, { type: type.split(';')[0] })]);
        }
        bar.remove();
      };
      rec.start(250);
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        bar.querySelector('.rec-t').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (s >= 300) { keep = true; stop(); }   // 5-minute cap
      }, 250);
      // Live level meter.
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const an = actx.createAnalyser(); an.fftSize = 64;
        actx.createMediaStreamSource(s).connect(an);
        const data = new Uint8Array(an.frequencyBinCount), bars = bar.querySelectorAll('.rec-wave i');
        const draw = () => {
          an.getByteFrequencyData(data);
          bars.forEach((b, i) => { b.style.height = Math.max(12, (data[i % data.length] / 255) * 100) + '%'; });
          raf = requestAnimationFrame(draw);
        };
        draw();
      } catch {}
    }).catch(() => { UI.toast('Microphone access is needed to record.', true); bar.remove(); });
  }

  /* ---------- menu ---------- */
  function attach({ button, input, fileInput, stage }) {
    if (!button || button._nxPlus) return;
    button._nxPlus = true;
    button.classList.add('plus-btn');
    button.innerHTML = '<i class="fa-solid fa-plus"></i>';
    const composer = button.closest('.composer');
    let menu = null;
    const media = document.createElement('input');
    media.type = 'file'; media.multiple = true; media.accept = 'image/*,video/*'; media.className = 'hidden';
    media.onchange = () => { stage(media.files); media.value = ''; };
    composer.appendChild(media);

    const close = () => {
      button.classList.remove('open');
      if (!menu) return;
      const m = menu; menu = null;
      m.classList.add('out');
      setTimeout(() => m.remove(), 160);
    };
    const open = () => {
      button.classList.add('open');
      menu = document.createElement('div');
      menu.className = 'plus-menu';
      menu.innerHTML = ITEMS.map((it, i) => it.sep ? '<div class="pm-sep"></div>' : `
        <button type="button" data-k="${it.k}" style="--i:${i}"><span class="pm-ico"><i class="fa-solid ${it.icon}"></i></span>
        <span class="pm-t"><b>${it.label}</b><small>${esc(it.sub)}</small></span></button>`).join('');
      composer.appendChild(menu);
      menu.querySelectorAll('[data-k]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); close(); run(b.dataset.k); };
      });
    };
    const run = (k) => {
      if (k === 'files') fileInput.click();
      else if (k === 'media') media.click();
      else if (k === 'voice') recorder(composer, stage);
      else if (k === 'md') mdEditor(input);
      else if (k === 'code') insert(input, '```js\n', '\n```', '// your code');
      else if (k === 'spoiler') insert(input, '||', '||', 'spoiler');
      else if (k === 'quote') prefixLines(input, '> ', 'quote');
      else if (k === 'table') insert(input, (input.value && !input.value.endsWith('\n') ? '\n' : '') + TABLE, '');
    };
    button.onclick = (e) => { e.stopPropagation(); menu ? close() : open(); };
    document.addEventListener('click', (e) => { if (menu && !menu.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  return { attach, mdEditor };
})();
