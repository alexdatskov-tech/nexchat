/* The chat engine, shared by server channels and DMs.

   One ChatView per conversation. Views are kept alive (DOM and data) in a
   small LRU, so going back to a chat you just had open is instant: it only
   asks the server for what changed since.

   adapter = {
     kind: 'channel' | 'dm', id, table, attTable, rxTable, fk,
     title, intro() -> html, placeholder,
     canSend(), canManage(), canPin(), roleColor(uid),
     uploadPath, lastReadAt, markRead(), members() -> [profiles]  (mentions)
   } */
(function () {
  const { esc, fmt } = NX;
  const P = () => NX.people;
  const PAGE = 50;
  const GROUP_MS = 7 * 60 * 1000;
  const QUICK = ['👍', '❤️', '😂', '🔥', '😮', '😢'];

  const views = new Map();   // key -> ChatView
  const LIVE_MAX = 8;

  class ChatView {
    constructor(adapter) {
      this.a = adapter;
      this.key = adapter.kind + ':' + adapter.id;
      this.msgs = [];              // ascending by created_at
      this.byId = new Map();
      this.atts = new Map();       // message id -> [attachment]
      this.rx = new Map();         // message id -> Map(emoji -> Set(user ids))
      this.refs = new Map();       // replied-to messages not in the list
      this.haveOlder = true;
      this.loadingOlder = false;
      this.pinned = true;          // scrolled to the bottom
      this.unseen = 0;
      this.typing = new Map();     // uid -> timeout
      this.sendChain = Promise.resolve();
      this.lastUsed = Date.now();
      this.build();
    }

    /* ---------- DOM ---------- */
    build() {
      const el = document.createElement('div');
      el.className = 'chat';
      el.innerHTML = `
        <div class="msgs" tabindex="-1"><div class="msgs-inner">
          <div class="msgs-head"></div><div class="msgs-list"></div>
        </div></div>
        <div class="typing" aria-live="polite"></div>
        <div class="composer-host"></div>
        <div class="drop-hint"><i class="fa-solid fa-cloud-arrow-up"></i>Drop files to upload<small style="font-weight:500;color:var(--txt-3)">to ${esc(this.a.title)}</small></div>`;
      this.el = el;
      this.scroller = el.querySelector('.msgs');
      this.list = el.querySelector('.msgs-list');
      this.head = el.querySelector('.msgs-head');
      this.typingEl = el.querySelector('.typing');
      this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
      // media that loads late must not push the newest message off-screen
      this.scroller.addEventListener('load', () => { if (this.pinned) this.toBottom(); }, true);
      this.ro = new ResizeObserver(() => { if (this.pinned) this.toBottom(); });
      this.ro.observe(this.list);
      this.list.addEventListener('click', (e) => this.onClick(e));
      this.list.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.m[data-id]');
        if (!row || e.target.closest('a, img, video, audio, input, textarea')) return;
        e.preventDefault();
        this.menuFor(row.dataset.id, e);
      });
      // long press on touch = context menu
      let lp = null;
      this.list.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.m[data-id]');
        if (!row) return;
        lp = setTimeout(() => { lp = null; navigator.vibrate?.(15); this.menuFor(row.dataset.id, e.touches[0]); }, 480);
      }, { passive: true });
      ['touchend', 'touchmove', 'touchcancel'].forEach((t) => this.list.addEventListener(t, () => { clearTimeout(lp); lp = null; }, { passive: true }));
      this.composer = new NX.Composer(this);
      el.querySelector('.composer-host').replaceWith(this.composer.el);
      // drag and drop anywhere in the chat
      let depth = 0;
      el.addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types?.includes('Files')) return; depth++; el.classList.add('dragging'); });
      el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('dragging'); });
      el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
      el.addEventListener('drop', (e) => {
        depth = 0; el.classList.remove('dragging');
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        this.composer.addFiles(e.dataTransfer.files);
      });
      this.topIO = new IntersectionObserver((ents) => {
        if (ents.some((x) => x.isIntersecting)) this.loadOlder();
      }, { root: this.scroller, rootMargin: '600px 0px 0px 0px' });
    }

    /* ---------- lifecycle ---------- */
    async show(host) {
      this.lastUsed = Date.now();
      host.appendChild(this.el);
      NX.viewing = this.key;
      this.subscribe();
      if (!this.loaded) {
        this.head.innerHTML = '';
        this.list.innerHTML = skeleton();
        await this.loadLatest();
      } else {
        if (this.pinned) this.toBottom();
        this.catchUp(true);
      }
      this.maybeRead();
      this.composer.focus();
    }
    hide() {
      if (NX.viewing === this.key) NX.viewing = null;
      this.composer.saveDraft();
      this.unsubscribe();
      this.el.remove();
    }
    destroy() {
      this.hide();
      this.ro.disconnect();
      this.topIO.disconnect();
      this.composer.destroy();
    }

    /* ---------- loading ---------- */
    async fetchPage(before) {
      let q = window.db.from(this.a.table).select('*').eq(this.a.fk, this.a.id)
        .order('created_at', { ascending: false }).limit(PAGE + 1);
      if (before) q = q.lt('created_at', before);
      const { data, error } = await q;
      if (error) throw error;
      const rows = data || [];
      const page = rows.slice(0, PAGE).reverse();
      page.more = rows.length > PAGE;
      await this.extras(page);
      return page;
    }
    // Authors, files, reactions and replied-to messages for a batch, in parallel.
    async extras(page) {
      if (!page.length) return;
      const ids = page.map((m) => m.id);
      const replyIds = [...new Set(page.map((m) => m.reply_to_id).filter((r) => r && !this.byId.has(r) && !this.refs.has(r)))];
      const [att, rx, refs] = await Promise.all([
        window.db.from(this.a.attTable).select('*').in('message_id', ids),
        window.db.from(this.a.rxTable).select('message_id,user_id,emoji,created_at').in('message_id', ids).order('created_at'),
        replyIds.length ? window.db.from(this.a.table).select('id,author_id,content,created_at').in('id', replyIds) : Promise.resolve({ data: [] }),
        P().need([...page.map((m) => m.author_id)]),
      ]);
      ids.forEach((id) => { this.atts.delete(id); this.rx.delete(id); });
      (att.data || []).sort((x, y) => (x.position ?? 0) - (y.position ?? 0) || String(x.created_at).localeCompare(y.created_at))
        .forEach((x) => { if (!this.atts.has(x.message_id)) this.atts.set(x.message_id, []); this.atts.get(x.message_id).push(x); });
      (rx.data || []).forEach((r) => this.addRx(r.message_id, r.emoji, r.user_id));
      (refs.data || []).forEach((r) => this.refs.set(r.id, r));
      const refAuthors = (refs.data || []).map((r) => r.author_id);
      if (refAuthors.length) await P().need(refAuthors);
    }

    async loadLatest() {
      try {
        const page = await this.fetchPage();
        this.msgs = page; this.byId = new Map(page.map((m) => [m.id, m]));
        this.haveOlder = page.more;
        this.loaded = true;
        this.paintAll();
        this.toBottom();
      } catch (e) {
        this.list.innerHTML = `<div class="msgs-fail"><i class="fa-solid fa-cloud-bolt" style="font-size:28px"></i><p>Couldn’t load messages.<br><small>${esc(e.message || '')}</small></p><button class="btn btn-ghost btn-sm" data-a="retry">Try again</button></div>`;
        this.list.querySelector('[data-a="retry"]').onclick = () => { this.list.innerHTML = skeleton(); this.loadLatest(); };
      }
    }

    async loadOlder() {
      if (!this.loaded || this.loadingOlder || !this.haveOlder || !this.msgs.length) return;
      this.loadingOlder = true;
      this.head.innerHTML = '<div class="msgs-older"><span class="spinner"></span>Loading earlier messages…</div>';
      try {
        const page = await this.fetchPage(this.msgs[0].created_at);
        const fresh = page.filter((m) => !this.byId.has(m.id));
        this.haveOlder = page.more;
        if (fresh.length) {
          const h0 = this.scroller.scrollHeight, t0 = this.scroller.scrollTop;
          this.msgs = [...fresh, ...this.msgs];
          fresh.forEach((m) => this.byId.set(m.id, m));
          const frag = document.createDocumentFragment();
          let prev = null;
          fresh.forEach((m) => { this.rowsFor(m, prev).forEach((n) => frag.appendChild(n)); prev = m; });
          // the old first row may now group with the new batch, and its day divider may be redundant
          const firstOld = this.list.firstElementChild;
          if (firstOld?.classList.contains('day') && dayKey(fresh[fresh.length - 1].created_at) === firstOld.dataset.day) firstOld.remove();
          this.list.prepend(frag);
          this.regroup(this.msgs[fresh.length]);
          this.scroller.scrollTop = t0 + (this.scroller.scrollHeight - h0);
        }
      } catch (e) { NX.fail(e, 'Couldn’t load older messages'); }
      this.loadingOlder = false;
      this.paintHead();
    }

    /* After being away (tab hidden, socket down, chat switched): fetch what's
       new, and re-check the visible tail for edits and deletes. */
    async catchUp(full) {
      if (!this.loaded || this.catching) return;
      this.catching = true;
      try {
        const serverRows = this.msgs.filter((m) => !m._pending);
        const last = serverRows[serverRows.length - 1];
        let q = window.db.from(this.a.table).select('*').eq(this.a.fk, this.a.id).order('created_at', { ascending: true }).limit(100);
        if (last) q = q.gt('created_at', last.created_at);
        const { data } = await q;
        if (data?.length) {
          if (data.length === 100) { this.loaded = false; this.list.innerHTML = skeleton(); await this.loadLatest(); return; }
          await this.extras(data);
          data.forEach((m) => this.insert(m, { quiet: true }));
        }
        if (full) {
          const tail = serverRows.slice(-PAGE).map((m) => m.id);
          if (tail.length) {
            const [{ data: still }, ex] = await Promise.all([
              window.db.from(this.a.table).select('id,content,edited_at,is_pinned').in('id', tail).then((r) => r, () => ({ data: null })),
              this.extras(tail.map((id) => this.byId.get(id)).filter(Boolean)).then(() => true, () => false),
            ]);
            if (still) {
              const alive = new Map(still.map((m) => [m.id, m]));
              tail.forEach((id) => {
                const cur = alive.get(id);
                if (!cur) this.remove(id);
                else if (cur.content !== this.byId.get(id)?.content || cur.edited_at !== this.byId.get(id)?.edited_at) this.update(cur);
              });
            }
            if (ex) tail.forEach((id) => { if (this.byId.has(id)) { this.paintAtts(id); this.paintRx(id); } });
          }
        }
      } catch { /* next tick */ }
      finally { this.catching = false; }
    }

    /* ---------- realtime ---------- */
    subscribe() {
      if (this.sub) return;
      const a = this.a;
      this.subOk = false;
      this.sub = window.db.channel(`chat:${this.key}:${NX.uid()}`, { config: { broadcast: { self: false } } })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: a.table, filter: `${a.fk}=eq.${a.id}` }, async ({ new: m }) => {
          if (this.byId.has(m.id)) return;
          // Our own message echoing back while its send is still in flight:
          // the send will swap the pending bubble for it.
          if (m.author_id === NX.me.id && this.msgs.some((x) => x._pending && (x.content || null) === (m.content || null))) return;
          await P().need([m.author_id]);
          if (m.reply_to_id && !this.byId.has(m.reply_to_id) && !this.refs.has(m.reply_to_id)) {
            const { data } = await window.db.from(a.table).select('id,author_id,content,created_at').eq('id', m.reply_to_id).maybeSingle();
            if (data) { this.refs.set(data.id, data); await P().need([data.author_id]); }
          }
          this.insert(m);
          this.clearTyping(m.author_id);
          // files are written right after their message: double-check shortly
          setTimeout(() => this.refreshAtts(m.id), 1800);
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: a.table, filter: `${a.fk}=eq.${a.id}` }, ({ new: m }) => this.update(m))
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: a.table, filter: `${a.fk}=eq.${a.id}` }, ({ old }) => this.remove(old.id))
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: a.attTable }, ({ new: x }) => {
          if (!this.byId.has(x.message_id)) return;
          const list = this.atts.get(x.message_id) || [];
          if (list.some((y) => y.id === x.id)) return;
          list.push(x);
          list.sort((p, q) => (p.position ?? 0) - (q.position ?? 0));
          this.atts.set(x.message_id, list);
          this.paintAtts(x.message_id);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: a.attTable }, ({ old }) => {
          for (const [mid, list] of this.atts) {
            if (list.some((y) => y.id === old.id)) { this.atts.set(mid, list.filter((y) => y.id !== old.id)); this.paintAtts(mid); break; }
          }
        })
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: a.rxTable }, ({ new: r }) => {
          if (!this.byId.has(r.message_id)) return;
          this.addRx(r.message_id, r.emoji, r.user_id); this.paintRx(r.message_id);
        })
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: a.rxTable }, ({ old: r }) => {
          if (!r?.message_id || !this.byId.has(r.message_id)) return;
          this.dropRx(r.message_id, r.emoji, r.user_id); this.paintRx(r.message_id);
        })
        .on('broadcast', { event: 'typing' }, ({ payload }) => this.onTyping(payload))
        .subscribe((s) => {
          if (s === 'SUBSCRIBED') {
            const wasDown = this.subWasDown;
            this.subOk = true; this.subWasDown = false;
            clearInterval(this.poll); this.poll = null;
            if (wasDown) this.catchUp(true);
          } else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(s)) {
            this.subOk = false; this.subWasDown = true;
            // Realtime is down: keep the chat alive by polling until it's back.
            if (!this.poll && this.sub) this.poll = setInterval(() => { if (!document.hidden) this.catchUp(false); }, 4000);
          }
        });
      this.onVis = () => { if (!document.hidden) { this.catchUp(true); this.maybeRead(); } };
      document.addEventListener('visibilitychange', this.onVis);
    }
    unsubscribe() {
      clearInterval(this.poll); this.poll = null;
      if (this.sub) { window.db.removeChannel(this.sub); this.sub = null; }
      document.removeEventListener('visibilitychange', this.onVis);
      this.typing.forEach((t) => clearTimeout(t)); this.typing.clear(); this.paintTyping();
    }
    async refreshAtts(mid) {
      if (!this.byId.has(mid) || (this.atts.get(mid) || []).length) return;
      const { data } = await window.db.from(this.a.attTable).select('*').eq('message_id', mid).order('position');
      if (data?.length) { this.atts.set(mid, data); this.paintAtts(mid); }
    }

    /* ---------- typing ---------- */
    sendTyping() {
      if (!this.sub || !this.subOk) return;
      this.sub.send({ type: 'broadcast', event: 'typing', payload: { uid: NX.me.id } }).catch?.(() => {});
    }
    onTyping({ uid } = {}) {
      if (!uid || uid === NX.me.id || NX.data.isBlocked(uid)) return;
      clearTimeout(this.typing.get(uid));
      this.typing.set(uid, setTimeout(() => this.clearTyping(uid), 6500));
      P().need([uid]).then(() => this.paintTyping());
    }
    clearTyping(uid) { clearTimeout(this.typing.get(uid)); if (this.typing.delete(uid)) this.paintTyping(); }
    paintTyping() {
      const names = [...this.typing.keys()].map((u) => `<b>${esc(P().nameOf(P().get(u)))}</b>`);
      this.typingEl.innerHTML = !names.length ? ''
        : `<span class="dots"><i></i><i></i><i></i></span>${names.length > 3 ? 'Several people are typing…'
          : names.length === 1 ? `${names[0]} is typing…` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are typing…`}`;
    }

    /* ---------- painting ---------- */
    paintHead() {
      if (this.loadingOlder) return;
      if (this.haveOlder) {
        this.head.innerHTML = '<div class="msgs-older" data-older><span class="spinner"></span>Loading earlier messages…</div>';
        this.topIO.disconnect();
        this.topIO.observe(this.head.firstElementChild);
      } else {
        this.topIO.disconnect();
        this.head.innerHTML = `<div class="msgs-top">${this.a.intro()}</div>`;
      }
    }
    paintAll() {
      const frag = document.createDocumentFragment();
      let prev = null;
      const readAt = this.a.lastReadAt?.();
      let divDone = !readAt;
      this.msgs.forEach((m) => {
        const nodes = this.rowsFor(m, prev);
        if (!divDone && m.created_at > readAt && m.author_id !== NX.me.id) {
          divDone = true;
          if (prev) nodes.unshift(NX.h('<div class="new-div">New</div>'));
        }
        nodes.forEach((n) => frag.appendChild(n));
        prev = m;
      });
      this.list.replaceChildren(frag);
      this.paintHead();
    }
    // The row for m, preceded by a day divider when the day changes.
    rowsFor(m, prev) {
      const out = [];
      if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) out.push(NX.h(`<div class="day" data-day="${dayKey(m.created_at)}">${esc(fmt.day(m.created_at))}</div>`));
      out.push(this.row(m, prev));
      return out;
    }
    groupedWith(m, prev) {
      return !!prev && !m.reply_to_id && prev.author_id === m.author_id && !prev._failed
        && (new Date(m.created_at) - new Date(prev.created_at)) < GROUP_MS && dayKey(prev.created_at) === dayKey(m.created_at);
    }
    row(m, prev) {
      const p = P().get(m.author_id) || { id: m.author_id, username: 'unknown' };
      const mine = m.author_id === NX.me.id;
      const grp = this.groupedWith(m, prev);
      const el = document.createElement('div');
      const blocked = !mine && NX.data.isBlocked(m.author_id);
      const mentioned = !mine && m.content && MD.mentions(m.content).some((u) => u === NX.me.username.toLowerCase() || u === 'everyone' || u === 'here');
      const replyMentions = !mine && m.reply_to_id && (this.byId.get(m.reply_to_id) || this.refs.get(m.reply_to_id))?.author_id === NX.me.id;
      el.className = `m${grp ? ' grp' : ''}${m._pending ? ' sending' : ''}${m._failed ? ' failed' : ''}${mentioned || replyMentions ? ' mentioned' : ''}${MD.isJumbo(m.content) ? ' jumbo' : ''}`;
      el.dataset.id = m.id;
      if (blocked) {
        el.className = 'm grp';
        el.innerHTML = `<div class="m-left"></div><div class="m-main"><div class="m-sys"><i class="fa-solid fa-ban"></i>Blocked message <button class="btn btn-quiet btn-sm" data-a="unhide">Show</button></div></div>`;
        return el;
      }
      const color = this.a.roleColor?.(m.author_id);
      el.innerHTML = `
        ${m.reply_to_id ? this.replyHtml(m.reply_to_id) : ''}
        <div class="m-left">${grp ? `<span class="hover-time" title="${esc(fmt.full(m.created_at))}">${esc(fmt.time(m.created_at))}</span>` : `<span data-uid="${esc(m.author_id)}">${P().avatar(p, 40)}</span>`}</div>
        <div class="m-main">
          ${grp ? '' : `<div class="m-head"><span class="m-name" data-uid="${esc(m.author_id)}" style="${esc(P().nameCss(p, { color, noGlow: false }))}">${P().nameText(p)}</span>${p.is_nitro ? '<span class="badge badge-nitro" title="Nitro"><i class="fa-solid fa-bolt"></i></span>' : ''}${this.a.badges?.(m.author_id) || ''}<span class="m-time" title="${esc(fmt.full(m.created_at))}">${esc(fmt.stamp(m.created_at))}</span></div>`}
          <div class="m-text">${textHtml(m)}</div>
          <div class="atts"></div>
          <div class="rx-row"></div>
          ${m._failed ? `<div class="m-fail"><i class="fa-solid fa-circle-exclamation"></i>${esc(m._error || 'Not sent.')} <button data-a="retry">Retry</button><button data-a="discard">Delete</button></div>` : ''}
        </div>
        ${m._pending || m._failed ? '' : `<div class="m-acts">
          ${QUICK.slice(0, 3).map((e) => `<button class="q" data-a="q" data-e="${e}" title="React ${e}">${e}</button>`).join('')}
          <button data-a="react" title="Add reaction"><i class="fa-regular fa-face-smile"></i></button>
          ${this.a.canSend() ? '<button data-a="reply" title="Reply"><i class="fa-solid fa-reply"></i></button>' : ''}
          ${mine ? '<button data-a="edit" title="Edit"><i class="fa-solid fa-pen"></i></button>' : ''}
          <button data-a="more" title="More"><i class="fa-solid fa-ellipsis"></i></button>
        </div>`}`;
      if (!m.content && !m.edited_at) el.querySelector('.m-text').remove();
      this.paintAtts(m.id, el);
      this.paintRx(m.id, el);
      return el;
    }
    replyHtml(rid) {
      const r = this.byId.get(rid) || this.refs.get(rid);
      if (!r) return `<div class="m-reply" data-a="jump" data-rid="${esc(rid)}"><span><i>Original message was deleted</i></span></div>`;
      const p = P().get(r.author_id) || {};
      return `<div class="m-reply" data-a="jump" data-rid="${esc(rid)}">${P().avatar(p, 16, { halo: false, deco: false })}<b style="${esc(P().nameCss(p, { noGlow: true, color: this.a.roleColor?.(r.author_id) }))}">${P().nameText(p)}</b><span>${r.content ? esc(MD.plain(r.content, 140)) : '<i>Click to see attachment</i>'}</span></div>`;
    }
    rowEl(id) { return this.list.querySelector(`.m[data-id="${CSS.escape(id)}"]`); }
    paintAtts(mid, el = this.rowEl(mid)) {
      const host = el?.querySelector('.atts');
      if (!host) return;
      const m = this.byId.get(mid);
      const list = m?._localAtts || this.atts.get(mid) || [];
      const canRemove = !!m && !m._pending && (m.author_id === NX.me.id || this.a.canManage());
      NX.files.renderAll(host, list, {
        canRemove, table: this.a.attTable,
        onRemove: (x) => { this.atts.set(mid, (this.atts.get(mid) || []).filter((y) => y.id !== x.id)); this.paintAtts(mid); },
      });
    }
    paintRx(mid, el = this.rowEl(mid)) {
      const host = el?.querySelector('.rx-row');
      if (!host) return;
      const map = this.rx.get(mid);
      if (!map || !map.size) { host.innerHTML = ''; return; }
      host.innerHTML = [...map.entries()].map(([e, users]) => {
        const mine = users.has(NX.me.id);
        const who = [...users].slice(0, 6).map((u) => P().nameOf(P().get(u))).join(', ') + (users.size > 6 ? ` and ${users.size - 6} more` : '');
        return `<button class="rx${mine ? ' mine' : ''}" data-a="rx" data-e="${esc(e)}" data-tip="${esc(who)} reacted with ${esc(e)}">${esc(e)}<b>${users.size}</b></button>`;
      }).join('') + '<button class="rx add" data-a="react" title="Add reaction"><i class="fa-regular fa-face-smile"></i></button>';
      P().need([...map.values()].flatMap((s) => [...s]));
    }
    addRx(mid, e, uid) {
      if (!this.rx.has(mid)) this.rx.set(mid, new Map());
      const m = this.rx.get(mid);
      if (!m.has(e)) m.set(e, new Set());
      m.get(e).add(uid);
    }
    dropRx(mid, e, uid) {
      const m = this.rx.get(mid);
      if (!m?.has(e)) return;
      m.get(e).delete(uid);
      if (!m.get(e).size) m.delete(e);
    }
    // Re-derive the compact/full form of one row (after an insert or removal next to it).
    regroup(m) {
      if (!m) return;
      const i = this.msgs.indexOf(m);
      const el = this.rowEl(m.id);
      if (!el) return;
      const want = this.groupedWith(m, this.msgs[i - 1]);
      if (el.classList.contains('grp') === want) return;
      el.replaceWith(this.row(m, this.msgs[i - 1]));
    }

    /* ---------- mutations ---------- */
    insert(m, { quiet = false } = {}) {
      if (this.byId.has(m.id)) return;
      // A pending bubble of ours with the same nonce is swapped for the real row.
      const atBottom = this.pinned;
      this.byId.set(m.id, m);
      let i = this.msgs.length;
      while (i > 0 && this.msgs[i - 1].created_at > m.created_at && !this.msgs[i - 1]._pending) i--;
      // pending bubbles always stay last
      while (i > 0 && this.msgs[i - 1]._pending && !m._pending) i--;
      const prev = this.msgs[i - 1] || null;
      const next = this.msgs[i] || null;
      this.msgs.splice(i, 0, m);
      const nodes = this.rowsFor(m, prev);
      const nextEl = next ? this.rowEl(next.id) : null;
      // A day divider directly above the next row: m either joins that day
      // (goes after the divider) or belongs to an earlier day (goes before it).
      let anchor = nextEl;
      const above = nextEl?.previousElementSibling;
      if (above?.classList.contains('day')) {
        if (above.dataset.day === dayKey(m.created_at)) { if (nodes[0]?.classList.contains('day')) nodes.shift(); }
        else anchor = above;
      }
      nodes.forEach((n) => this.list.insertBefore(n, anchor));
      if (next) this.regroup(next);
      if (!this.loaded) return;
      const mine = m.author_id === NX.me.id;
      if (atBottom || mine) this.toBottom();
      else { this.unseen++; this.paintJump(); }
      if (!mine) this.maybeRead();
    }
    update(m) {
      const cur = this.byId.get(m.id);
      if (!cur) return;
      Object.assign(cur, m);
      const el = this.rowEl(m.id);
      if (!el || el.querySelector('.editbox')) return;
      const i = this.msgs.indexOf(cur);
      el.replaceWith(this.row(cur, this.msgs[i - 1]));
      // replies that quote it
      this.msgs.forEach((x) => { if (x.reply_to_id === m.id) { const r = this.rowEl(x.id)?.querySelector('.m-reply'); if (r) r.outerHTML = this.replyHtml(m.id); } });
    }
    remove(id) {
      const m = this.byId.get(id);
      if (!m) return;
      const i = this.msgs.indexOf(m);
      this.msgs.splice(i, 1);
      this.byId.delete(id);
      this.atts.delete(id); this.rx.delete(id);
      const el = this.rowEl(id);
      if (el) {
        const before = el.previousElementSibling, after = el.nextElementSibling;
        el.remove();
        if (before?.classList.contains('day') && (!after || after.classList.contains('day'))) before.remove();
        if (before?.classList.contains('new-div') && (!after || after.classList.contains('day'))) before.remove();
      }
      this.regroup(this.msgs[i]);
      this.msgs.forEach((x) => { if (x.reply_to_id === id) { const r = this.rowEl(x.id)?.querySelector('.m-reply'); if (r) r.outerHTML = this.replyHtml(id); } });
    }

    /* ---------- scrolling ---------- */
    onScroll() {
      const s = this.scroller;
      const was = this.pinned;
      this.pinned = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
      if (this.pinned && !was) { this.unseen = 0; this.paintJump(); this.maybeRead(); }
      if (s.scrollTop < 400 && this.haveOlder) this.loadOlder();
    }
    toBottom() {
      this.scroller.scrollTop = this.scroller.scrollHeight;
      this.pinned = true;
      if (this.unseen) { this.unseen = 0; this.paintJump(); }
    }
    paintJump() {
      let j = this.el.querySelector('.jump');
      if (!this.unseen) { j?.remove(); return; }
      if (!j) {
        j = NX.h('<button class="jump"></button>');
        j.onclick = () => { this.scroller.scrollTo({ top: this.scroller.scrollHeight, behavior: 'smooth' }); };
        this.el.querySelector('.msgs').after(j);
      }
      j.innerHTML = `<i class="fa-solid fa-arrow-down"></i>${this.unseen} new message${this.unseen === 1 ? '' : 's'}`;
    }
    maybeRead() {
      if (!this.pinned || document.hidden || NX.viewing !== this.key) return;
      this.a.markRead?.();
    }
    async jumpTo(id) {
      let el = this.rowEl(id);
      for (let tries = 0; !el && this.haveOlder && tries < 12; tries++) {
        await this.loadOlder();
        el = this.rowEl(id);
      }
      if (!el) return NX.toast('That message is too far back or was deleted.', { err: true });
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }

    /* ---------- interactions ---------- */
    onClick(e) {
      const t = e.target;
      const uidEl = t.closest('[data-uid]');
      if (uidEl && !t.closest('.m-acts')) { P().card(uidEl.dataset.uid, uidEl, { serverId: this.a.serverId }); return; }
      const men = t.closest('.mention[data-mention]');
      if (men) {
        const u = men.dataset.mention.toLowerCase();
        const p = P().all().find((x) => x.username?.toLowerCase() === u);
        if (p) P().card(p.id, men, { serverId: this.a.serverId });
        return;
      }
      if (t.closest('.spoil')) { t.closest('.spoil').classList.add('shown'); return; }
      const btn = t.closest('[data-a]');
      const row = t.closest('.m[data-id]');
      if (!btn) {
        if (row && NX.isTouch() && !t.closest('a, button, video, audio, .att-media')) {
          const was = row.classList.contains('tapped');
          this.list.querySelectorAll('.m.tapped').forEach((x) => x.classList.remove('tapped'));
          row.classList.toggle('tapped', !was);
        }
        return;
      }
      const id = row?.dataset.id;
      const a = btn.dataset.a;
      if (a === 'q' || a === 'rx') return this.toggleRx(id, btn.dataset.e);
      if (a === 'react') return this.pickReaction(id, btn);
      if (a === 'reply') return this.composer.setReply(this.byId.get(id));
      if (a === 'edit') return this.edit(id);
      if (a === 'more') return this.menuFor(id, btn);
      if (a === 'jump') return this.jumpTo(btn.dataset.rid);
      if (a === 'retry') return this.composer.retry(id);
      if (a === 'discard') { this.remove(id); return; }
      if (a === 'unhide') { const m = this.byId.get(id); NX.data.blocked.delete(m.author_id); this.update(m); NX.data.blocked.add(m.author_id); }
    }
    pickReaction(id, anchor) {
      NX.emoji.open(anchor, (e) => this.toggleRx(id, e));
    }
    async toggleRx(mid, emoji) {
      const has = this.rx.get(mid)?.get(emoji)?.has(NX.me.id);
      if (has) this.dropRx(mid, emoji, NX.me.id); else this.addRx(mid, emoji, NX.me.id);
      this.paintRx(mid);
      const q = has
        ? window.db.from(this.a.rxTable).delete().eq('message_id', mid).eq('user_id', NX.me.id).eq('emoji', emoji)
        : window.db.from(this.a.rxTable).insert({ message_id: mid, user_id: NX.me.id, emoji });
      const { error } = await q;
      if (error && !/duplicate/i.test(error.message)) {
        if (has) this.addRx(mid, emoji, NX.me.id); else this.dropRx(mid, emoji, NX.me.id);
        this.paintRx(mid);
        NX.fail(error);
      }
      if (!has) NX.emoji.remember(emoji);
    }
    menuFor(id, at) {
      const m = this.byId.get(id);
      if (!m || m._pending) return;
      const mine = m.author_id === NX.me.id;
      const row = this.rowEl(id);
      row?.classList.add('menu-open');
      NX.menu(at, [
        { html: `<div class="quick">${QUICK.map((e) => `<button type="button" data-q="${e}">${e}</button>`).join('')}<button type="button" data-q="+" title="More"><i class="fa-regular fa-face-smile" style="font-size:15px"></i></button></div>` },
        { label: 'Reply', icon: 'fa-reply', hidden: !this.a.canSend(), onClick: () => this.composer.setReply(m) },
        { label: 'Edit message', icon: 'fa-pen', hidden: !mine, onClick: () => this.edit(id) },
        { label: m.is_pinned ? 'Unpin message' : 'Pin message', icon: 'fa-thumbtack', hidden: !this.a.canPin?.(), onClick: () => this.setPinned(m, !m.is_pinned) },
        { label: 'Copy text', icon: 'fa-copy', hidden: !m.content, onClick: () => NX.copy(m.content, 'Text copied') },
        { label: 'Mention', icon: 'fa-at', hidden: mine || !this.a.canSend(), onClick: () => this.composer.insert(`@${P().get(m.author_id)?.username} `) },
        { label: 'Copy message link', icon: 'fa-link', onClick: () => NX.copy(NX.pageUrl(`index.html#/${this.a.route}?m=${m.id}`), 'Link copied') },
        { sep: true, hidden: !(mine || this.a.canManage()) },
        { label: 'Delete message', icon: 'fa-trash-can', danger: true, hidden: !(mine || this.a.canManage()), onClick: () => this.del(id) },
      ], {
        onClose: () => row?.classList.remove('menu-open'),
        wire: (menu) => menu.querySelectorAll('[data-q]').forEach((b) => {
          b.onclick = (ev) => {
            ev.stopPropagation(); NX.closeMenu();
            if (b.dataset.q === '+') this.pickReaction(id, row?.querySelector('.m-acts') || row);
            else this.toggleRx(id, b.dataset.q);
          };
        }),
      });
    }
    async setPinned(m, on) {
      const { error } = await NX.data.rpc('nx_set_pinned', { p_message: m.id, p_pinned: on });
      if (error) return NX.fail(error.missing ? { message: 'Pins need the nexchat_v3 SQL update.' } : error);
      m.is_pinned = on;
      NX.toast(on ? 'Message pinned.' : 'Message unpinned.', { icon: 'fa-thumbtack' });
    }
    async del(id, skipConfirm) {
      const m = this.byId.get(id);
      if (!m) return;
      const n = (this.atts.get(id) || []).length;
      if (!skipConfirm && !await NX.confirm({
        title: 'Delete message', danger: true,
        body: `Are you sure you want to delete this message${n ? ` and its ${n === 1 ? 'file' : n + ' files'}` : ''}? This can’t be undone.`,
      })) return;
      const files = (this.atts.get(id) || []).slice();
      this.remove(id);
      const { error } = await window.db.from(this.a.table).delete().eq('id', id);
      if (error) {
        NX.fail(/policy|permission|row-level/i.test(error.message) ? { message: 'You don’t have permission to delete that.' } : error);
        this.insert(m, { quiet: true });
        return;
      }
      files.forEach((f) => window.Store?.del(f.url).catch(() => {}));
    }
    edit(id) {
      const m = this.byId.get(id);
      const el = this.rowEl(id);
      if (!m || !el || el.querySelector('.editbox')) return;
      const main = el.querySelector('.m-main');
      let text = main.querySelector('.m-text');
      if (!text) { text = NX.h('<div class="m-text"></div>'); main.querySelector('.atts').before(text); }
      const box = NX.h(`<div class="editbox"><textarea rows="1" maxlength="4000"></textarea><small>escape to <a data-x>cancel</a> · enter to <a data-s>save</a></small></div>`);
      const ta = box.querySelector('textarea');
      ta.value = m.content || '';
      text.replaceWith(box);
      const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 300) + 'px'; };
      fit(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      const done = () => { const i = this.msgs.indexOf(m); el.replaceWith(this.row(m, this.msgs[i - 1])); this.composer.focus(); };
      const save = async () => {
        const v = ta.value.trim();
        if (v === (m.content || '').trim()) return done();
        if (!v && !(this.atts.get(id) || []).length) { done(); return this.del(id); }
        const prev = { content: m.content, edited_at: m.edited_at };
        m.content = v; m.edited_at = new Date().toISOString();
        done();
        const { error } = await window.db.from(this.a.table).update({ content: v, edited_at: m.edited_at }).eq('id', id);
        if (error) { Object.assign(m, prev); this.update(m); NX.fail(error); }
      };
      ta.addEventListener('input', fit);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
      });
      box.querySelector('[data-x]').onclick = done;
      box.querySelector('[data-s]').onclick = save;
    }
    editLast() {
      for (let i = this.msgs.length - 1; i >= 0 && i >= this.msgs.length - 30; i--) {
        const m = this.msgs[i];
        if (m.author_id === NX.me.id && !m._pending && !m._failed) { this.edit(m.id); this.rowEl(m.id)?.scrollIntoView({ block: 'nearest' }); return true; }
      }
      return false;
    }
  }

  const dayKey = (iso) => new Date(iso).toDateString();
  // Message body, with "(edited)" tucked onto the end of the last line.
  function textHtml(m) {
    let html = m.content ? MD.render(m.content, { me: NX.me.username }) : '';
    if (m.edited_at) {
      const tag = `<span class="m-edited" title="${esc(fmt.full(m.edited_at))}">(edited)</span>`;
      html = /<\/div>$/.test(html) ? html.replace(/<\/div>$/, tag + '</div>') : html + tag;
    }
    return html;
  }
  const skeleton = () => `<div style="padding:16px 0">${Array.from({ length: 6 }, (_, i) => `<div style="display:flex;gap:14px;padding:10px 16px 10px 16px">
      <div class="skel" style="width:40px;height:40px;border-radius:50%;flex-shrink:0"></div>
      <div style="flex:1;display:flex;flex-direction:column;gap:8px;padding-top:4px"><div class="skel" style="width:${90 + (i * 37) % 80}px;height:12px"></div><div class="skel" style="width:${40 + (i * 53) % 50}%;height:12px"></div></div></div>`).join('')}</div>`;

  /* ---------- view cache ---------- */
  function open(adapter) {
    const key = adapter.kind + ':' + adapter.id;
    let v = views.get(key);
    if (v) { Object.assign(v.a, adapter); }
    else {
      v = new ChatView(adapter);
      views.set(key, v);
      if (views.size > LIVE_MAX) {
        const old = [...views.values()].filter((x) => x !== v && !x.el.isConnected).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (old) { old.destroy(); views.delete(old.key); }
      }
    }
    return v;
  }
  function drop(key) { const v = views.get(key); if (v) { v.destroy(); views.delete(key); } }
  function dropAll() { views.forEach((v) => v.destroy()); views.clear(); }

  NX.Chat = { open, drop, dropAll, views, QUICK };
})();
