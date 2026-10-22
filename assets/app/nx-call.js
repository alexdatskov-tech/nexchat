/* Calls: the UI around voice.js (WebRTC mesh). Because the app no longer
   reloads between pages, a call keeps running while you move between
   servers, DMs and settings. A floating mini call shows when the call room
   isn't on screen. */
(function () {
  const { esc } = NX;
  const P = () => NX.people;
  const V = () => window.Voice;
  let speaking = new Set();
  let roomHost = null;          // the element currently showing the room (if any)
  let roomOpts = null;
  let statsOpen = false;
  let since = 0;

  const state = () => V()?.state() || { active: false, members: new Map() };
  const active = () => state().active;
  const isDm = () => String(state().channel?.id || '').startsWith('dm-');

  function onChange() { NX.emit('call', state()); paint(); }
  function onSpeak(set) { speaking = set; markSpeaking(); NX.emit('call:speak', set); }
  function onStats() { if (statsOpen) paintStats(); }

  async function join(channel, serverId, { video = false } = {}) {
    const st = state();
    if (st.active && st.channel?.id === channel.id) { if (video && !st.cam) await V().toggleCam(); return true; }
    if (st.active) await V().leave();
    try {
      await V().join(channel, serverId, { ...NX.me, muted: false, deaf: false, cam: false, sharing: false }, onChange, onSpeak, onStats);
    } catch { return false; }
    since = Date.now();
    NX.data.beep([523, 784], 0.12, 0.1, 0.04);
    if (video) await V().toggleCam();
    onChange();
    return true;
  }
  async function joinDm(conv, { video = false, ring = true } = {}) {
    const ok = await join({ id: 'dm-' + conv.id, name: NX.data.dmTitle(conv), dm: conv.id }, null, { video });
    if (ok && ring) {
      conv.people.forEach((p) => NX.data.ring(p.id, {
        conversation: conv.id, name: P().nameOf(NX.me), video,
        avatarHtml: P().avatar(NX.me, 36, { halo: false, deco: false }),
      }));
    }
    return ok;
  }
  async function leave() {
    if (!active()) return;
    await V().leave();
    NX.data.beep([784, 523], 0.12, 0.1, 0.04);
    statsOpen = false;
    onChange();
  }
  const toggleMute = () => V().setMute();
  const toggleDeaf = () => V().setDeaf();
  const toggleCam = () => V().toggleCam();

  function sharePicker() {
    if (state().sharing) return V().stopShare();
    if (!V().screenSupported()) return NX.toast('Screen sharing needs a desktop browser.', { err: true });
    const body = NX.h(`<div style="display:flex;flex-direction:column;gap:14px">
      <div class="field"><label>Quality</label><div class="seg" data-q>
        <button type="button" class="on" data-v="text">Sharp text (1080p)</button><button type="button" data-v="motion">Smooth motion (720p)</button><button type="button" data-v="auto">Auto</button></div>
        <span class="hint">Sharp keeps code and slides crisp; smooth keeps video and games fluid.</span></div>
      <label class="row" style="gap:10px;cursor:pointer"><input type="checkbox" class="switch" data-audio checked><span>Share audio too (tab or system audio, where the browser allows it)</span></label>
    </div>`);
    body.querySelector('[data-q]').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      body.querySelectorAll('[data-q] button').forEach((x) => x.classList.toggle('on', x === b));
    });
    NX.modal({
      title: 'Share your screen', sub: 'Your browser asks which screen, window or tab next.', body,
      foot: [{ label: 'Cancel' }, {
        label: 'Go live', cls: 'btn-primary', icon: 'fa-display', onClick: async () => {
          const quality = body.querySelector('[data-q] .on').dataset.v;
          setTimeout(() => V().startShare({ quality, audio: body.querySelector('[data-audio]').checked }), 0);
        },
      }],
    });
  }

  /* ---------- tiles ---------- */
  function feeds(st) {
    const out = [];
    st.members.forEach((p) => {
      const me = p.id === NX.me.id;
      const cam = (me ? st.cam : p.cam) ? (me ? V().localCam() : V().peerCam(p.id)) : null;
      const scr = (me ? st.sharing : p.sharing) ? (me ? V().localScreen() : V().peerScreen(p.id)) : null;
      if (scr) out.push({ p, me, key: p.id + ':screen', stream: scr, screen: true });
      if (cam) out.push({ p, me, key: p.id + ':cam', stream: cam });
      if (!cam && !scr) out.push({ p, me, key: p.id + ':av', stream: null });
    });
    return out;
  }
  function paintTiles(stage, st, { focusable = true } = {}) {
    const grid = stage.querySelector('.grid');
    const focusSlot = stage.querySelector('.focus-slot');
    const list = feeds(st);
    let focus = stage.dataset.focus || '';
    if (!focus && focusable) { const sc = list.find((f) => f.screen && !f.me); if (sc && !stage.dataset.unfocused) focus = sc.key; }
    if (focus && !list.some((f) => f.key === focus)) focus = '';
    stage.closest('.call')?.classList.toggle('has-focus', !!focus && !!focusSlot);
    grid.dataset.count = list.filter((f) => f.key !== focus || !focusSlot).length;
    const seen = new Set();
    list.forEach((f) => {
      seen.add(f.key);
      let t = stage.querySelector(`.vtile[data-k="${CSS.escape(f.key)}"]`);
      if (!t) {
        t = NX.h(`<div class="vtile" data-k="${esc(f.key)}"><video autoplay playsinline muted></video><div class="vt-av"></div><div class="vt-name"></div>
          ${focusSlot ? '<button class="vt-max" title="Focus"><i class="fa-solid fa-expand"></i></button>' : ''}</div>`);
        const v = t.querySelector('video');
        const ready = () => t.classList.toggle('has-frame', v.videoWidth > 0);
        ['loadeddata', 'resize', 'emptied'].forEach((ev) => v.addEventListener(ev, ready));
        t.querySelector('.vt-max')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (stage.dataset.focus === f.key) { stage.dataset.focus = ''; stage.dataset.unfocused = '1'; }
          else { stage.dataset.focus = f.key; delete stage.dataset.unfocused; }
          paintTiles(stage, state(), { focusable });
        });
        t.querySelector('.vt-av').addEventListener('click', () => P().card(f.p.id, t));
        t.addEventListener('dblclick', () => t.querySelector('.vt-max')?.click());
      }
      const host = focusSlot && f.key === focus ? focusSlot : grid;
      if (t.parentNode !== host) host.appendChild(t);
      const v = t.querySelector('video');
      const track = f.stream?.getVideoTracks()[0] || null;
      const tid = track ? track.id : '';
      if (t.dataset.track !== tid) {
        t.dataset.track = tid;
        v.srcObject = f.stream || null;
        if (f.stream) v.play?.().catch(() => {});
        t.classList.remove('has-frame');
      }
      t.classList.toggle('is-screen', !!f.screen);
      t.classList.toggle('mirror', f.me && !f.screen);
      const av = t.querySelector('.vt-av');
      const size = focusSlot && f.key === focus ? 120 : (list.length > 4 ? 64 : 88);
      if (av.dataset.u !== f.p.id + size) { av.dataset.u = f.p.id + size; av.innerHTML = P().avatar(P().get(f.p.id) || f.p, size, { halo: false }); }
      const name = `${f.p.muted ? '<i class="fa-solid fa-microphone-slash off"></i>' : ''}${f.p.deaf ? '<i class="fa-solid fa-headphones off"></i>' : ''}<span>${esc(P().nameOf(f.p))}${f.me ? ' (you)' : ''}${f.screen ? ' · screen' : ''}</span>`;
      const nm = t.querySelector('.vt-name');
      if (nm.innerHTML !== name) nm.innerHTML = name;
      const pc = !f.me && st.peers?.get(f.p.id)?.pc;
      const bad = pc && ['failed', 'disconnected', 'new', 'connecting'].includes(pc.connectionState);
      let warn = t.querySelector('.vt-bad');
      if (bad && !warn) t.appendChild(NX.h(`<span class="vt-bad" title="Connecting…"><i class="fa-solid fa-signal"></i></span>`));
      if (!bad && warn) warn.remove();
      t.classList.toggle('speaking', speaking.has(f.p.id) && !f.p.muted);
    });
    stage.querySelectorAll('.vtile').forEach((t) => {
      if (!seen.has(t.dataset.k)) { const v = t.querySelector('video'); if (v) v.srcObject = null; t.remove(); }
    });
  }
  function markSpeaking() {
    document.querySelectorAll('.vtile').forEach((t) => {
      const uid = t.dataset.k.split(':')[0];
      const p = state().members.get(uid);
      t.classList.toggle('speaking', speaking.has(uid) && !p?.muted);
    });
    document.querySelectorAll('.vc-user[data-uid]').forEach((u) => u.classList.toggle('speaking', speaking.has(u.dataset.uid)));
  }

  /* ---------- the room ---------- */
  // mount(host, { title, onBack }) shows the room inside host until unmount().
  function mount(host, opts = {}) {
    roomHost = host; roomOpts = opts;
    host.innerHTML = `<div class="call${opts.embedded ? ' embedded' : ''}">
      <div class="call-top"><span class="pill"><i class="fa-solid fa-volume-high" style="color:var(--ok)"></i><span class="ct-title"></span></span><span class="pill ct-time mono"></span><span class="grow"></span>
        <button class="icon-btn" data-c="stats" data-tip="Connection" title="Connection"><i class="fa-solid fa-signal"></i></button>
        <button class="icon-btn" data-c="pip" data-tip="Pop out video" title="Pop out"><i class="fa-solid fa-up-right-from-square"></i></button>
        <button class="icon-btn" data-c="full" data-tip="Full screen" title="Full screen"><i class="fa-solid fa-expand"></i></button>
        ${opts.onBack ? '<button class="icon-btn" data-c="back" data-tip="Back to chat" title="Back to chat"><i class="fa-solid fa-message"></i></button>' : ''}</div>
      <div class="stage"><div class="focus-slot"></div><div class="grid"></div></div>
      <div class="call-bar">
        <button class="cb" data-c="mute" title="Mute"></button>
        <button class="cb" data-c="deaf" title="Deafen"><i class="fa-solid fa-headphones"></i></button>
        <button class="cb" data-c="cam" title="Camera"></button>
        <button class="cb" data-c="share" title="Share screen"><i class="fa-solid fa-display"></i></button>
        <button class="cb leave" data-c="leave" title="Leave call"><i class="fa-solid fa-phone-slash"></i></button>
      </div></div>`;
    const call = host.querySelector('.call');
    call.addEventListener('click', (e) => {
      const c = e.target.closest('[data-c]')?.dataset.c;
      if (!c) return;
      if (c === 'mute') toggleMute();
      if (c === 'deaf') toggleDeaf();
      if (c === 'cam') toggleCam();
      if (c === 'share') sharePicker();
      if (c === 'leave') leave();
      if (c === 'back') opts.onBack?.();
      if (c === 'stats') { statsOpen = !statsOpen; paintStats(); }
      if (c === 'pip') popOut();
      if (c === 'full') {
        call.classList.toggle('full');
        e.target.closest('[data-c]').innerHTML = `<i class="fa-solid fa-${call.classList.contains('full') ? 'compress' : 'expand'}"></i>`;
      }
    });
    paint();
  }
  function unmount(host) {
    if (roomHost !== host) return;
    roomHost?.querySelectorAll('video').forEach((v) => { v.srcObject = null; });
    roomHost = null; roomOpts = null;
    paint();
  }
  const roomVisible = () => !!roomHost?.isConnected;

  function paint() {
    const st = state();
    if (roomHost && !roomHost.isConnected) { roomHost = null; roomOpts = null; }
    if (roomHost) {
      const call = roomHost.querySelector('.call');
      if (call && st.active) {
        call.querySelector('.ct-title').textContent = roomOpts?.title || st.channel?.name || 'Call';
        const set = (c, on, html, cls = 'off') => { const b = call.querySelector(`[data-c="${c}"]`); b.classList.toggle(cls, on); if (html) b.innerHTML = html; };
        set('mute', st.muted, `<i class="fa-solid fa-microphone${st.muted ? '-slash' : ''}"></i>`);
        set('deaf', st.deaf);
        set('cam', st.cam, `<i class="fa-solid fa-video${st.cam ? '' : '-slash'}"></i>`, 'live');
        set('share', st.sharing, null, 'live');
        paintTiles(call.querySelector('.stage'), st);
      }
    }
    paintMini(st);
    NX.emit('call:paint', st);
  }
  setInterval(() => {
    if (!active()) return;
    const s = Math.floor((Date.now() - since) / 1000);
    const txt = `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ':' : ''}${String(Math.floor(s / 60) % 60).padStart(Math.floor(s / 3600) ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
    document.querySelectorAll('.ct-time').forEach((el) => { el.textContent = txt; });
  }, 1000);

  /* ---------- mini call ---------- */
  let mini = null;
  function paintMini(st) {
    const show = st.active && !roomVisible();
    if (!show) { mini?.remove(); mini = null; return; }
    if (!mini) {
      mini = NX.h(`<div class="mini-call">
        <div class="mc-stage" title="Back to the call"><div class="grid" style="position:absolute;inset:0;display:block"></div></div>
        <div class="mc-bar"><div class="t"><b></b><small></small></div>
          <button class="icon-btn" data-c="mute"></button>
          <button class="icon-btn" data-c="cam"></button>
          <button class="icon-btn leave" data-c="leave" title="Leave"><i class="fa-solid fa-phone-slash"></i></button></div></div>`);
      mini.addEventListener('click', (e) => {
        const c = e.target.closest('[data-c]')?.dataset.c;
        if (c === 'mute') return toggleMute();
        if (c === 'cam') return toggleCam();
        if (c === 'leave') return leave();
        if (e.target.closest('.mc-stage, .t')) openRoom();
      });
      document.body.appendChild(mini);
    }
    mini.querySelector('.t b').textContent = st.channel?.name || 'Call';
    mini.querySelector('.t small').textContent = NX.fmt.plural(st.members.size, 'person', 'people') + ' in call';
    const m = mini.querySelector('[data-c="mute"]');
    m.classList.toggle('off', st.muted); m.innerHTML = `<i class="fa-solid fa-microphone${st.muted ? '-slash' : ''}"></i>`;
    const c = mini.querySelector('[data-c="cam"]');
    c.classList.toggle('on', st.cam); c.innerHTML = `<i class="fa-solid fa-video${st.cam ? '' : '-slash'}"></i>`;
    // the mini stage shows the most interesting single feed
    const list = feeds(st);
    const pick = list.find((f) => f.screen && !f.me) || list.find((f) => f.stream && !f.me) || list.find((f) => !f.me) || list[0];
    const stage = mini.querySelector('.mc-stage');
    const fake = { ...st, members: new Map(pick ? [[pick.p.id, pick.p]] : []) };
    paintTiles(stage, fake, { focusable: false });
    if (pick?.screen === false && list.some((f) => f.p.id === pick.p.id && f.screen)) { /* fine */ }
  }
  function openRoom() {
    const st = state();
    if (!st.active) return;
    if (isDm()) NX.go('dm/' + st.channel.dm + '?room=1');
    else NX.go(`s/${st.serverId}/${st.channel.id}`);
  }

  async function popOut() {
    const pick = [...document.querySelectorAll('.vtile.is-screen video'), ...document.querySelectorAll('.vtile video')].find((v) => v.srcObject && v.videoWidth > 0);
    if (!pick || !document.pictureInPictureEnabled) return NX.toast('Turn on a camera or screen share first.', { err: true });
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); await pick.requestPictureInPicture(); }
    catch { NX.toast('Could not open the floating window.', { err: true }); }
  }

  /* ---------- connection stats ---------- */
  const mbps = (k) => (k >= 1000 ? (k / 1000).toFixed(1) + ' Mbps' : (k || 0) + ' kbps');
  const tone = (v, good, warn) => (v == null ? '' : v <= good ? 'good' : v <= warn ? 'warn' : 'bad');
  const CAND = { host: 'Direct (same network)', srflx: 'Direct (peer-to-peer)', prflx: 'Direct (peer-to-peer)', relay: 'Relayed (TURN)' };
  function paintStats() {
    const call = roomHost?.querySelector('.call');
    if (!call) return;
    let el = call.querySelector('.call-stats');
    if (!statsOpen) { el?.remove(); return; }
    if (!el) { el = NX.h('<div class="call-stats"></div>'); call.appendChild(el); }
    const s = state().stats || {};
    const cap = s.capture || {};
    const rows = [];
    const row = (k, v, cls = '') => rows.push(`<div class="cs-row"><span>${k}</span><b class="${cls}">${v}</b></div>`);
    rows.push(`<div class="cs-h" style="display:flex;align-items:center;justify-content:space-between">Your microphone <label style="text-transform:none;font-weight:500;display:flex;gap:6px;align-items:center;cursor:pointer" title="No echo cancellation, stereo, 128 kbps. Use headphones."><input type="checkbox" data-studio ${V().audioMode() === 'studio' ? 'checked' : ''}>Studio audio</label></div>`);
    row('Capture', cap.channels ? `${cap.channels === 1 ? 'Mono' : 'Stereo'}${cap.rate ? ' · ' + cap.rate / 1000 + ' kHz' : ''}` : '—');
    row('Processing', [cap.ec && 'echo cancel', cap.ns && 'noise suppression', cap.agc && 'auto gain'].filter(Boolean).join(', ') || 'off');
    if (s.camera) row('Camera', `${s.camera.w}×${s.camera.h} @ ${s.camera.fps} fps`);
    if (!s.peers?.length) rows.push('<div class="cs-empty">Stats appear once someone else joins.</div>');
    (s.peers || []).forEach((p) => {
      rows.push(`<div class="cs-h">${esc(p.name)} <small style="text-transform:none;color:var(--txt-3)">${esc(p.state)}</small></div>`);
      if (p.path) {
        const relayed = p.path.local === 'relay' || p.path.remote === 'relay';
        row('Route', `${CAND[relayed ? 'relay' : p.path.local] || p.path.local || '?'}${p.path.proto ? ' · ' + p.path.proto.toUpperCase() : ''}`, relayed ? 'warn' : 'good');
        row('Ping', p.path.rtt != null ? p.path.rtt + ' ms' : '—', tone(p.path.rtt, 80, 200));
      } else row('Route', 'Connecting…');
      if (p.audioIn) row('Audio in', `${p.audioIn.kbps} kbps · loss ${p.audioIn.lossPct}%`, tone(p.audioIn.lossPct, 1, 5));
      if (p.videoOut?.w) row('Video out', `${p.videoOut.w}×${p.videoOut.h} @ ${Math.round(p.videoOut.fps || 0)} fps · ${mbps(p.videoOut.kbps)}`, tone(-(p.videoOut.fps || 0), -24, -12));
      if (p.videoIn?.w) row('Video in', `${p.videoIn.w}×${p.videoIn.h} @ ${Math.round(p.videoIn.fps || 0)} fps · ${mbps(p.videoIn.kbps)}`, tone(-(p.videoIn.fps || 0), -24, -12));
      if (p.screenIn?.w) row('Screen in', `${p.screenIn.w}×${p.screenIn.h} @ ${Math.round(p.screenIn.fps || 0)} fps`);
      if (p.screenOut?.w) row('Screen out', `${p.screenOut.w}×${p.screenOut.h} @ ${Math.round(p.screenOut.fps || 0)} fps`);
    });
    el.innerHTML = rows.join('');
    el.querySelector('[data-studio]').onchange = (e) => { V().setAudioMode(e.target.checked ? 'studio' : 'voice'); NX.toast('Audio mode applies the next time you join a call.'); };
  }

  /* ---------- sidebar voice panel ---------- */
  function panelHtml() {
    const st = state();
    if (!st.active) return '';
    const where = isDm() ? 'Direct call' : (NX.data.server(st.serverId)?.name || '');
    return `<div class="voice-panel">
      <div class="vp-top"><div class="vp-state" data-c="open"><b><i class="fa-solid fa-signal"></i>Voice connected</b><small>${esc(st.channel?.name || '')}${where ? ' / ' + esc(where) : ''}</small></div>
        <button class="icon-btn danger" data-c="leave" data-tip="Disconnect"><i class="fa-solid fa-phone-slash"></i></button></div>
      <div class="vp-btns">
        <button data-c="cam" class="${st.cam ? 'on' : ''}" data-tip="${st.cam ? 'Turn off camera' : 'Turn on camera'}"><i class="fa-solid fa-video${st.cam ? '' : '-slash'}"></i></button>
        <button data-c="share" class="${st.sharing ? 'on' : ''}" data-tip="${st.sharing ? 'Stop sharing' : 'Share your screen'}"><i class="fa-solid fa-display"></i></button>
        <button data-c="open" data-tip="Open call"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button>
      </div></div>`;
  }
  function wirePanel(root) {
    root.addEventListener('click', (e) => {
      const c = e.target.closest('.voice-panel [data-c]')?.dataset.c;
      if (!c) return;
      if (c === 'leave') leave();
      if (c === 'cam') toggleCam();
      if (c === 'share') sharePicker();
      if (c === 'open') openRoom();
    });
  }

  window.addEventListener('pagehide', () => { if (active()) { try { V().leave(); } catch {} } });

  NX.call = { join, joinDm, leave, state, active, isDm, toggleMute, toggleDeaf, toggleCam, sharePicker, mount, unmount, roomVisible, panelHtml, wirePanel, openRoom, speaking: () => speaking };
})();
