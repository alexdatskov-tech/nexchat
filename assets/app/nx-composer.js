/* The message composer: text, replies, attachments (uploaded in the
   background as soon as they are added), voice messages, emoji, mentions,
   drafts and typing indicators. */
(function () {
  const { esc, fmt } = NX;
  const P = () => NX.people;
  const MAX_LEN = 4000;
  const drafts = NX.ls.get('nx_drafts', {});
  const saveDrafts = NX.debounce(() => NX.ls.set('nx_drafts', drafts), 400);

  class Composer {
    constructor(chat) {
      this.chat = chat;
      this.a = chat.a;
      this.jobs = [];
      this.reply = null;
      this.el = NX.h(`<div class="composer">
        <div class="cbox">
          <div class="c-bar hidden"></div>
          <div class="tray hidden"></div>
          <div class="c-row">
            <button class="icon-btn plus" type="button" title="Upload or more" aria-label="Upload a file"><i class="fa-solid fa-circle-plus"></i></button>
            <textarea rows="1" maxlength="${MAX_LEN * 4}" aria-label="Message" enterkeyhint="send"></textarea>
            <button class="icon-btn emo" type="button" title="Emoji" aria-label="Emoji"><i class="fa-regular fa-face-smile"></i></button>
            <button class="icon-btn send" type="button" title="Send" aria-label="Send" disabled><i class="fa-solid fa-paper-plane"></i></button>
          </div>
        </div>
        <div class="c-note hidden"></div>
        <input type="file" multiple hidden class="f-any"><input type="file" multiple hidden accept="image/*,video/*" class="f-media">
      </div>`);
      this.ta = this.el.querySelector('textarea');
      this.bar = this.el.querySelector('.c-bar');
      this.tray = this.el.querySelector('.tray');
      this.sendBtn = this.el.querySelector('.send');
      this.note = this.el.querySelector('.c-note');
      this.wire();
      this.refreshPermission();
      this._offBlocked = NX.on('blocked', () => this.refreshPermission());
      this.loadDraft();
    }

    refreshPermission() {
      const ok = this.a.canSend();
      this.el.classList.toggle('locked', !ok);
      this.ta.disabled = !ok;
      this.ta.placeholder = ok ? (this.a.placeholder || 'Message') : 'You don’t have permission to send messages here.';
      this.el.querySelector('.plus').disabled = !ok;
    }

    wire() {
      const ta = this.ta;
      ta.addEventListener('input', () => { this.fit(); this.sync(); this.autocomplete(); this.typing(); });
      ta.addEventListener('keydown', (e) => this.onKey(e));
      ta.addEventListener('focus', () => window.CloudGate?.warm?.());
      ta.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) { e.preventDefault(); this.addFiles(files); return; }
        const text = e.clipboardData?.getData('text/plain') || '';
        if (text.length > MAX_LEN) {
          e.preventDefault();
          this.addFiles([new File([text], 'message.txt', { type: 'text/plain' })]);
          NX.toast('That was too long for a message, so it’s attached as a file.', { icon: 'fa-file-lines' });
        }
      });
      this.sendBtn.onclick = () => this.send();
      this.el.querySelector('.emo').onclick = (e) => NX.emoji.open(e.currentTarget, (em) => this.insert(em));
      const any = this.el.querySelector('.f-any'), media = this.el.querySelector('.f-media');
      any.onchange = () => { this.addFiles(any.files); any.value = ''; };
      media.onchange = () => { this.addFiles(media.files); media.value = ''; };
      const plus = this.el.querySelector('.plus');
      plus.onclick = () => {
        if (NX.isTouch() && false) return any.click();
        plus.classList.add('open');
        NX.menu(plus, [
          { label: 'Upload a file', icon: 'fa-file-arrow-up', onClick: () => any.click() },
          { label: 'Photos & videos', icon: 'fa-photo-film', onClick: () => media.click() },
          { label: 'Voice message', icon: 'fa-microphone', onClick: () => this.record() },
          { sep: true },
          { label: 'Code block', icon: 'fa-code', onClick: () => this.wrap('```\n', '\n```', 'code') },
          { label: 'Spoiler', icon: 'fa-eye-slash', onClick: () => this.wrap('||', '||', 'spoiler') },
          { label: 'Quote', icon: 'fa-quote-left', onClick: () => this.wrap('> ', '', 'quote') },
        ], { side: 'top', onClose: () => plus.classList.remove('open') });
      };
    }

    /* ---------- text ---------- */
    fit() {
      const ta = this.ta;
      const max = Math.round(innerHeight * 0.4);
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
      // scroll only once the text is taller than the box can grow
      ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden';
    }
    sync() {
      const has = this.ta.value.trim().length > 0 || this.jobs.length > 0;
      this.sendBtn.disabled = !has;
      const over = this.ta.value.length - MAX_LEN;
      this.note.classList.toggle('hidden', over <= -200);
      if (over > -200) this.note.innerHTML = over > 0 ? `<span style="color:#ff8a8e">${over} characters over the ${MAX_LEN} limit</span>` : `${-over} characters left`;
      this.saveDraftSoon();
    }
    insert(text) {
      const ta = this.ta;
      const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
      ta.value = ta.value.slice(0, a) + text + ta.value.slice(b);
      ta.focus();
      ta.setSelectionRange(a + text.length, a + text.length);
      this.fit(); this.sync();
    }
    wrap(before, after, placeholder) {
      const ta = this.ta;
      const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
      const sel = ta.value.slice(a, b) || placeholder;
      const lead = before.endsWith('\n') && a > 0 && ta.value[a - 1] !== '\n' ? '\n' : '';
      ta.value = ta.value.slice(0, a) + lead + before + sel + after + ta.value.slice(b);
      ta.focus();
      const s = a + lead.length + before.length;
      ta.setSelectionRange(s, s + sel.length);
      this.fit(); this.sync();
    }
    focus() { if (!NX.isTouch() && !this.ta.disabled && !NX.topModal()) this.ta.focus({ preventScroll: true }); }
    typing() {
      if (!this.ta.value.trim()) return;
      const now = Date.now();
      if (now - (this._typedAt || 0) < 3000) return;
      this._typedAt = now;
      this.chat.sendTyping();
    }

    onKey(e) {
      if (this.ac && this.acKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        if (NX.isTouch() && NX.isNarrow()) return;   // phones: Enter is a new line, the button sends
        e.preventDefault();
        this.send();
        return;
      }
      if (e.key === 'ArrowUp' && !this.ta.value && !this.jobs.length) {
        if (this.chat.editLast()) e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        if (this.reply) { this.setReply(null); e.stopPropagation(); }
      }
      if ((e.ctrlKey || e.metaKey) && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        const m = { b: ['**', '**'], i: ['*', '*'], u: ['__', '__'] }[e.key.toLowerCase()];
        this.wrap(m[0], m[1], '');
      }
    }

    /* ---------- @mention autocomplete ---------- */
    autocomplete() {
      const ta = this.ta;
      const upto = ta.value.slice(0, ta.selectionStart || 0);
      const m = upto.match(/(?:^|\s)@([A-Za-z0-9_]{0,32})$/);
      if (!m) return this.closeAc();
      const q = m[1].toLowerCase();
      const pool = (this.a.members?.() || []).filter((p) => p && p.id !== NX.me.id);
      const list = pool.filter((p) => !q || p.username?.toLowerCase().startsWith(q) || (p.display_name || '').toLowerCase().includes(q)).slice(0, 8);
      if (this.a.kind === 'channel' && 'everyone'.startsWith(q) && this.a.canManage()) list.push({ id: '@everyone', username: 'everyone', display_name: 'Notify everyone here', _special: true });
      if (!list.length) return this.closeAc();
      this.ac = { list, i: 0, start: upto.length - m[1].length - 1 };
      this.paintAc();
    }
    paintAc() {
      let box = this.el.querySelector('.pop-list.ac');
      if (!box) { box = NX.h('<div class="pop-list ac"></div>'); this.el.appendChild(box); }
      box.innerHTML = `<div class="pl-h">Members</div>` + this.ac.list.map((p, i) => `<button type="button" data-i="${i}" class="${i === this.ac.i ? 'on' : ''}">
        ${p._special ? '<i class="fa-solid fa-at"></i>' : P().avatar(p, 24, { halo: false, deco: false })}<span>${P().nameText(p)}</span><small>@${esc(p.username)}</small></button>`).join('');
      box.onmousedown = (e) => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) { this.ac.i = +b.dataset.i; this.pickAc(); } };
    }
    acKey(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.ac.i = (this.ac.i + (e.key === 'ArrowDown' ? 1 : -1) + this.ac.list.length) % this.ac.list.length;
        this.paintAc();
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); this.pickAc(); return true; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeAc(); return true; }
      return false;
    }
    pickAc() {
      const p = this.ac.list[this.ac.i];
      const ta = this.ta;
      const end = ta.selectionStart;
      const ins = `@${p.username} `;
      ta.value = ta.value.slice(0, this.ac.start) + ins + ta.value.slice(end);
      const pos = this.ac.start + ins.length;
      ta.setSelectionRange(pos, pos);
      this.closeAc(); this.fit(); this.sync(); ta.focus();
    }
    closeAc() { this.ac = null; this.el.querySelector('.pop-list.ac')?.remove(); }

    /* ---------- reply ---------- */
    setReply(m) {
      this.reply = m && !m._pending ? m : null;
      if (!this.reply) { this.bar.classList.add('hidden'); this.bar.innerHTML = ''; this.chat.list.querySelector('.reply-target')?.classList.remove('reply-target'); return; }
      const p = P().get(m.author_id);
      this.chat.list.querySelectorAll('.reply-target').forEach((x) => x.classList.remove('reply-target'));
      this.chat.rowEl(m.id)?.classList.add('reply-target');
      this.bar.classList.remove('hidden');
      this.bar.innerHTML = `<span class="grow">Replying to <b>${P().nameText(p)}</b></span><button class="icon-btn sm" title="Cancel reply"><i class="fa-solid fa-circle-xmark"></i></button>`;
      this.bar.querySelector('button').onclick = () => this.setReply(null);
      this.ta.focus();
    }

    /* ---------- attachments ---------- */
    addFiles(list) {
      if (!this.a.canSend()) return;
      const files = [...list];
      for (const f of files) {
        if (this.jobs.length >= 10) { NX.toast('Up to 10 files per message.', { err: true }); break; }
        if (f.size > NX.files.MAX_MB * 1024 * 1024) { NX.toast(`${f.name} is larger than ${NX.files.MAX_MB} MB.`, { err: true }); continue; }
        if (!f.size) { NX.toast(`${f.name} is empty.`, { err: true }); continue; }
        const job = NX.files.startUpload(f, this.a.uploadPath);
        job.on(() => this.paintJob(job));
        this.jobs.push(job);
      }
      this.paintTray();
      this.sync();
      this.ta.focus();
    }
    paintTray() {
      this.tray.classList.toggle('hidden', !this.jobs.length);
      const keep = new Set(this.jobs.map((j) => j.id));
      this.tray.querySelectorAll('.tray-item').forEach((n) => { if (!keep.has(n.dataset.id)) n.remove(); });
      this.jobs.forEach((j) => { if (!this.tray.querySelector(`[data-id="${j.id}"]`)) this.tray.appendChild(this.jobEl(j)); this.paintJob(j); });
    }
    jobEl(j) {
      const kind = NX.files.kindOf(j.original.name, j.original.type);
      const prev = j.preview ? (kind === 'video' ? `<video src="${esc(j.preview)}" muted playsinline preload="metadata"></video>` : `<img src="${esc(j.preview)}" alt="">`)
        : `<i class="fa-solid ${{ pdf: 'fa-file-pdf', audio: 'fa-file-audio', text: 'fa-file-lines', zip: 'fa-file-zipper' }[kind] || 'fa-file'}"></i>`;
      const el = NX.h(`<div class="tray-item" data-id="${j.id}">
        <div class="ti-prev">${prev}</div>
        <div class="ti-name" title="${esc(j.original.name)}">${esc(j.original.name)}</div>
        <div class="ti-meta"><span class="sz"></span><span class="st"></span></div>
        <div class="ti-bar"><i></i></div>
        <button class="ti-x" type="button" title="Remove"><i class="fa-solid fa-xmark"></i></button>
      </div>`);
      el.querySelector('.ti-x').onclick = () => { j.cancel(); this.jobs = this.jobs.filter((x) => x !== j); this.paintTray(); this.sync(); };
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'retry') j.retry();
        if (a === 'orig') {
          j.cancel();
          const nj = NX.files.startUpload(j.original, this.a.uploadPath, { original: true });
          nj.on(() => this.paintJob(nj));
          this.jobs[this.jobs.indexOf(j)] = nj;
          this.paintTray();
        }
      });
      return el;
    }
    paintJob(j) {
      const el = this.tray.querySelector(`[data-id="${j.id}"]`);
      if (!el) return;
      el.classList.toggle('done', j.state === 'done');
      el.classList.toggle('error', j.state === 'error');
      el.querySelector('.sz').textContent = j.compressed ? `${fmt.bytes(j.original.size)} → ${fmt.bytes(j.file.size)}` : fmt.bytes(j.file.size);
      const st = el.querySelector('.st');
      st.innerHTML = j.state === 'done' ? '<span class="ok"><i class="fa-solid fa-check"></i></span>'
        : j.state === 'error' ? `<a data-a="retry" class="bad" style="cursor:pointer" title="${esc(j.error || '')}">Retry</a>`
          : j.state === 'preparing' ? 'Optimizing…' : j.state === 'queued' ? 'Waiting…' : Math.round(j.progress * 100) + '%';
      if (j.compressed && j.state !== 'error' && !el.querySelector('[data-a="orig"]')) {
        el.querySelector('.ti-name').insertAdjacentHTML('afterend', '<a data-a="orig" style="font-size:11px;cursor:pointer;color:var(--txt-3)" title="Send the full-size file instead">Optimized · use original</a>');
      }
      el.querySelector('.ti-bar i').style.width = Math.round((j.state === 'done' ? 1 : j.progress) * 100) + '%';
    }

    /* ---------- sending ---------- */
    send() {
      if (!this.a.canSend()) return;
      let text = this.ta.value.trim();
      const jobs = this.jobs.slice();
      if (!text && !jobs.length) return;
      if (text.length > MAX_LEN) {
        jobs.push(NX.files.startUpload(new File([text], 'message.txt', { type: 'text/plain' }), this.a.uploadPath));
        text = '';
      }
      const reply = this.reply;
      this.ta.value = ''; this.fit();
      this.jobs = []; this.paintTray();
      this.setReply(null); this.closeAc(); this.sync();
      delete drafts[this.chat.key]; saveDrafts();
      const m = {
        id: 'tmp-' + NX.uid(), [this.a.fk]: this.a.id, author_id: NX.me.id, content: text || null,
        reply_to_id: reply?.id || null, created_at: new Date().toISOString(), _pending: true, _jobs: jobs,
      };
      this.localAtts(m);
      this.chat.insert(m);
      this.chat.toBottom();
      const repaint = NX.throttle(() => { this.localAtts(m); this.chat.paintAtts(m.id); }, 150);
      jobs.forEach((j) => j.on(repaint));
      this.chat.sendChain = this.chat.sendChain.then(() => this.deliver(m)).catch(() => {});
    }
    localAtts(m) {
      m._localAtts = (m._jobs || []).map((j) => ({
        id: j.id, _local: true, file_name: j.file.name, file_size: j.file.size, mime_type: j.file.type,
        url: j.preview || '', width: j.width, height: j.height, _progress: j.state === 'done' ? 1 : j.progress,
      }));
    }
    async deliver(m) {
      const chat = this.chat;
      try {
        let results = [];
        if (m._jobs?.length) {
          const settled = await Promise.allSettled(m._jobs.map((j) => (j.state === 'error' ? Promise.reject(new Error(j.error)) : j.done)));
          const bad = settled.filter((s) => s.status === 'rejected' && s.reason?.name !== 'AbortError');
          if (bad.length) throw new Error(`${bad.length === 1 ? 'A file' : bad.length + ' files'} failed to upload${bad[0].reason?.message ? ': ' + bad[0].reason.message : ''}`);
          results = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
          if (!results.length && !m.content) { chat.remove(m.id); return; }
        }
        // A retry after the files failed must not post the message twice.
        let real = m._real || null;
        if (!real) {
          const row = { [this.a.fk]: this.a.id, author_id: NX.me.id, content: m.content };
          if (m.reply_to_id) row.reply_to_id = m.reply_to_id;
          const res = await window.db.from(this.a.table).insert(row).select().single();
          if (res.error) throw res.error;
          real = m._real = res.data;
        }
        let atts = [];
        if (results.length) {
          const rows = results.map((r, i) => ({
            message_id: real.id, url: r.url, file_name: r.name, file_size: r.size, mime_type: r.mime || null,
            width: r.width || null, height: r.height || null, position: i,
          }));
          const ins = await window.db.from(this.a.attTable).insert(rows).select();
          if (ins.error) {
            // Older databases may lack width/height: retry with the basic columns.
            const basic = rows.map(({ width, height, ...rest }) => rest);
            const again = await window.db.from(this.a.attTable).insert(basic).select();
            if (again.error) throw again.error;
            atts = again.data || [];
          } else atts = ins.data || [];
        }
        atts.sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
        const keep = chat.pinned;
        chat.remove(m.id);
        if (atts.length) chat.atts.set(real.id, atts);
        if (!chat.byId.has(real.id)) chat.insert(real);
        else chat.paintAtts(real.id);
        if (keep) chat.toBottom();
        (m._jobs || []).forEach((j) => j.preview && setTimeout(() => URL.revokeObjectURL(j.preview), 60000));
        this.a.onSent?.(real);
      } catch (e) {
        m._pending = false; m._failed = true;
        m._error = /row-level|policy|permission/i.test(e.message || '') ? 'You can’t send messages here.' : (e.message || 'Not sent.');
        const i = chat.msgs.indexOf(m);
        chat.rowEl(m.id)?.replaceWith(chat.row(m, chat.msgs[i - 1]));
      }
    }
    retry(id) {
      const m = this.chat.byId.get(id);
      if (!m) return;
      m._failed = false; m._pending = true; m._error = null;
      (m._jobs || []).forEach((j) => j.state === 'error' && j.retry());
      const i = this.chat.msgs.indexOf(m);
      this.chat.rowEl(m.id)?.replaceWith(this.chat.row(m, this.chat.msgs[i - 1]));
      this.chat.sendChain = this.chat.sendChain.then(() => this.deliver(m)).catch(() => {});
    }

    /* ---------- voice message ---------- */
    async record() {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return NX.toast('Voice messages aren’t supported in this browser.', { err: true });
      if (this.el.querySelector('.rec-bar')) return;
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch { return NX.toast('Microphone access is needed to record.', { err: true }); }
      const bar = NX.h(`<div class="rec-bar"><span class="rec-dot"></span><b class="rec-t mono">0:00</b>
        <div class="rec-wave">${'<i></i>'.repeat(32)}</div>
        <button class="icon-btn danger" data-a="x" title="Discard"><i class="fa-solid fa-trash-can"></i></button>
        <button class="btn btn-primary btn-sm" data-a="ok"><i class="fa-solid fa-check"></i>Done</button></div>`);
      const row = this.el.querySelector('.c-row');
      row.classList.add('hidden');
      row.before(bar);
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
      const chunks = [];
      let keep = false, raf = 0, actx = null;
      const t0 = Date.now(), p0 = performance.now();
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000);
        bar.querySelector('.rec-t').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (s >= 600) { keep = true; stop(); }
      }, 250);
      const stop = () => {
        clearInterval(timer); cancelAnimationFrame(raf);
        try { if (rec.state !== 'inactive') rec.stop(); } catch {}
        stream.getTracks().forEach((t) => t.stop());
        try { actx?.close(); } catch {}
      };
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        bar.remove(); row.classList.remove('hidden');
        if (!keep || !chunks.length) return;
        const type = (rec.mimeType || chunks[0].type || 'audio/webm').split(';')[0];
        const ext = /mp4/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'weba';
        const file = new File(chunks, `voice-message.${ext}`, { type });
        // Recorded WebM has no length in its header, so the length travels with
        // the upload (stored as the attachment's width; audio has no width).
        file.nxDurationMs = Math.max(1, Math.round(performance.now() - p0));
        this.addFiles([file]);
      };
      bar.querySelector('[data-a="x"]').onclick = () => { keep = false; stop(); };
      bar.querySelector('[data-a="ok"]').onclick = () => { keep = true; stop(); };
      rec.start(250);
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
        const an = actx.createAnalyser(); an.fftSize = 64;
        actx.createMediaStreamSource(stream).connect(an);
        const data = new Uint8Array(an.frequencyBinCount), bars = bar.querySelectorAll('.rec-wave i');
        const draw = () => { an.getByteFrequencyData(data); bars.forEach((b, i) => { b.style.height = Math.max(10, (data[i % data.length] / 255) * 100) + '%'; }); raf = requestAnimationFrame(draw); };
        draw();
      } catch {}
    }

    /* ---------- drafts ---------- */
    saveDraftSoon() { clearTimeout(this._dt); this._dt = setTimeout(() => this.saveDraft(), 500); }
    saveDraft() {
      const v = this.ta.value;
      if (v.trim()) drafts[this.chat.key] = v; else delete drafts[this.chat.key];
      saveDrafts();
    }
    loadDraft() {
      const d = drafts[this.chat.key];
      if (d) { this.ta.value = d; requestAnimationFrame(() => { this.fit(); this.sync(); }); }
    }
    destroy() {
      this._offBlocked?.();
      this.jobs.forEach((j) => j.state !== 'done' && j.cancel());
    }
  }

  NX.Composer = Composer;
})();
