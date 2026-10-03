/* Shared call UI: the video stage and the connection panel, used by both DM
   calls (dms.js) and server voice rooms (server.js). */
window.CallUI = (function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Every participant contributes up to two feeds: screen and camera.
  function feedsFor(p, st, meId) {
    const isMe = p.id === meId;
    const wantsCam = isMe ? st.cam : !!p.cam;
    const wantsScreen = isMe ? st.sharing : !!p.sharing;
    const camS = wantsCam ? (isMe ? Voice.localCam() : Voice.peerCam(p.id)) : null;
    const scrS = wantsScreen ? (isMe ? Voice.localScreen() : Voice.peerScreen(p.id)) : null;
    const out = [];
    if (scrS) out.push({ p, isMe, key: p.id + ':screen', stream: scrS, screen: true });
    if (camS) out.push({ p, isMe, key: p.id + ':cam', stream: camS, screen: false });
    if (!out.length) out.push({ p, isMe, key: p.id + ':av', stream: null, screen: false });
    return out;
  }

  /* Tiles are created once and updated in place. A <video> is only given a
     new srcObject when the underlying track really changes, and the avatar
     stays up until the first decoded frame arrives -- no black tiles while
     waiting for a keyframe, and no resets on every repaint. */
  function paintStage(grid, st, opts) {
    const feeds = [...st.members.values()].flatMap((p) => feedsFor(p, st, opts.meId));
    grid.classList.toggle('solo', feeds.length === 1);
    grid.classList.toggle('duo', feeds.length === 2);
    grid.dataset.count = feeds.length;
    const seen = new Set();
    feeds.forEach((f) => {
      seen.add(f.key);
      let t = grid.querySelector(`[data-t="${CSS.escape(f.key)}"]`);
      if (!t) {
        t = document.createElement('div');
        t.className = 'vtile';
        t.dataset.t = f.key;
        t.innerHTML = `<video autoplay playsinline muted></video><div class="vt-av"></div>
          <div class="vt-name"></div><button class="vt-max" title="Focus"><i class="fa-solid fa-expand"></i></button>`;
        const v = t.querySelector('video');
        const ready = () => t.classList.toggle('has-frame', v.videoWidth > 0);
        v.addEventListener('loadeddata', ready);
        v.addEventListener('resize', ready);
        v.addEventListener('emptied', ready);
        t.querySelector('.vt-av').onclick = () => opts.onAvatar?.(f.p.id);
        t.querySelector('.vt-max').onclick = (e) => {
          e.stopPropagation();
          const on = !t.classList.contains('focus');
          grid.querySelectorAll('.vtile.focus').forEach((x) => x.classList.remove('focus'));
          t.classList.toggle('focus', on);
          grid.classList.toggle('has-focus', on);
        };
        grid.appendChild(t);
      }
      const v = t.querySelector('video');
      const track = f.stream?.getVideoTracks()[0] || null;
      const tid = track ? track.id : '';
      if (t.dataset.track !== tid) {
        t.dataset.track = tid;
        v.srcObject = null;
        if (f.stream) { v.srcObject = f.stream; v.play?.().catch(() => {}); }
        t.classList.remove('has-frame');
      }
      t.classList.toggle('is-video', !!f.stream);
      t.classList.toggle('is-screen', f.screen);
      t.classList.toggle('mirror', f.isMe && !f.screen);
      const av = t.querySelector('.vt-av');
      if (!av.dataset.u || av.dataset.u !== f.p.id) { av.dataset.u = f.p.id; av.innerHTML = UI.avatar(f.p, 84, { halo: false }); }
      const name = `${f.p.muted ? '<i class="fa-solid fa-microphone-slash off"></i>' : ''}${f.p.deaf ? '<i class="fa-solid fa-headphones-simple off"></i>' : ''}<span>${esc(f.p.display_name || f.p.username)}${f.isMe ? ' (you)' : ''}${f.screen ? ' · screen' : ''}</span>`;
      const nm = t.querySelector('.vt-name');
      if (nm.innerHTML !== name) nm.innerHTML = name;
      t.classList.toggle('speaking', !!opts.speakSet?.has(f.p.id) && !f.p.muted);
    });
    [...grid.children].forEach((t) => {
      if (!seen.has(t.dataset.t)) {
        const v = t.querySelector('video'); if (v) v.srcObject = null;
        t.remove();
      }
    });
    if (!grid.querySelector('.vtile.focus')) grid.classList.remove('has-focus');
  }

  function markSpeaking(grid, set) {
    grid.querySelectorAll('.vtile').forEach((t) => {
      const uid = t.dataset.t.split(':')[0];
      const p = Voice.state().members.get(uid);
      t.classList.toggle('speaking', set.has(uid) && !p?.muted);
    });
  }

  /* ---------- connection panel: only measured values ---------- */
  const mbps = (k) => (k >= 1000 ? (k / 1000).toFixed(1) + ' Mbps' : k + ' kbps');
  const tone = (v, good, warn) => (v == null ? '' : v <= good ? 'good' : v <= warn ? 'warn' : 'bad');
  const CAND = { host: 'Direct (same network)', srflx: 'Direct (peer-to-peer)', prflx: 'Direct (peer-to-peer)', relay: 'Relayed through TURN' };
  const LIMIT = { none: 'not limited', bandwidth: 'limited by bandwidth', cpu: 'limited by CPU', other: 'limited' };

  function codecName(c) {
    if (!c) return '—';
    const n = c.mime || '?';
    return n === 'opus' ? 'Opus' : n.toUpperCase();
  }

  function statsPanel(s) {
    if (!s) return '';
    const cap = s.capture || {};
    const rows = [];
    const row = (label, value, cls = '') => rows.push(`<div class="cs-row"><span>${label}</span><b class="${cls}">${value}</b></div>`);

    rows.push('<div class="cs-h">Your microphone</div>');
    row('Capture', cap.channels ? `${cap.channels === 1 ? 'Mono' : cap.channels === 2 ? 'Stereo' : cap.channels + ' ch'}${cap.rate ? ' · ' + (cap.rate / 1000) + ' kHz' : ''}` : 'Unknown (browser did not report)');
    row('Processing', [cap.ec ? 'echo cancel' : null, cap.ns ? 'noise suppress' : null, cap.agc ? 'auto gain' : null].filter(Boolean).join(', ') || 'off (studio)');
    row('Mode', s.audioMode === 'studio' ? 'Studio (128 kbps target)' : 'Voice (48 kbps target, FEC + DTX)');
    if (s.camera) row('Camera', `${s.camera.w}×${s.camera.h} @ ${s.camera.fps} fps captured`);

    if (!s.peers?.length) {
      rows.push('<div class="cs-empty">Nobody else is connected yet — network stats appear once someone joins.</div>');
    }
    s.peers?.forEach((p) => {
      rows.push(`<div class="cs-h">${esc(p.name)} <small>${esc(p.state)}</small></div>`);
      const path = p.path;
      if (path) {
        const relayed = path.local === 'relay' || path.remote === 'relay';
        row('Route', `${CAND[relayed ? 'relay' : path.local] || path.local || '?'}${path.proto ? ' · ' + path.proto.toUpperCase() : ''}${relayed && path.relay ? ' (' + path.relay + ')' : ''}`, relayed ? 'warn' : 'good');
        row('Round trip', path.rtt != null ? path.rtt + ' ms' : '—', tone(path.rtt, 80, 200));
        if (path.avail) row('Uplink estimate', mbps(path.avail), tone(-path.avail, -1500, -500));
      } else row('Route', 'Connecting…');

      if (p.audioOut) {
        const c = p.audioOut.codec;
        const stereoReq = c && /stereo=1/.test(c.fmtp || '');
        row('Audio sent', `${codecName(c)}${c?.clock ? ' ' + c.clock / 1000 + ' kHz' : ''} · ${stereoReq ? 'stereo negotiated' : 'mono'} · ${p.audioOut.kbps} kbps`);
      }
      if (p.audioIn) {
        const a = p.audioIn;
        row('Audio received', `${a.kbps} kbps · loss ${a.lossPct}%${a.jitter != null ? ' · jitter ' + a.jitter + ' ms' : ''}`, tone(a.lossPct, 1, 5));
        row('Audio concealed', (a.conceal * 100).toFixed(1) + '%' + (a.jbDelay != null ? ` · buffer ${a.jbDelay} ms` : ''), tone(a.conceal * 100, 2, 8));
      }
      if (p.videoOut && p.videoOut.w) {
        const v = p.videoOut;
        row('Video sent', `${codecName(v.codec)} · ${v.w}×${v.h} @ ${Math.round(v.fps || 0)} fps · ${mbps(v.kbps)}`, tone(-(v.fps || 0), -24, -12));
        row('Encoder', `${esc(v.enc || '?')}${v.hw === true ? ' (hardware)' : v.hw === false ? ' (software)' : ''} · ${LIMIT[v.limit] || v.limit || '—'}`, v.limit && v.limit !== 'none' ? 'warn' : '');
      }
      if (p.videoIn && p.videoIn.w) {
        const v = p.videoIn;
        row('Video received', `${codecName(v.codec)} · ${v.w}×${v.h} @ ${Math.round(v.fps || 0)} fps · ${mbps(v.kbps)}`, tone(-(v.fps || 0), -24, -12));
        row('Video health', `loss ${v.lossPct}% · dropped ${v.dropped} · freezes ${v.freezes}`, tone(v.lossPct, 1, 5));
      }
      if (p.screenOut?.w) row('Screen sent', `${p.screenOut.w}×${p.screenOut.h} @ ${Math.round(p.screenOut.fps || 0)} fps · ${mbps(p.screenOut.kbps || 0)} · ${LIMIT[p.screenOut.limit] || '—'}`);
      if (p.screenIn?.w) row('Screen received', `${p.screenIn.w}×${p.screenIn.h} @ ${Math.round(p.screenIn.fps || 0)} fps`);
    });
    if (s.budget && s.peers?.length) rows.push(`<div class="cs-foot">Camera budget per person: ${mbps(s.budget.kbps)} (shrinks as the call grows — everyone uploads one copy per participant).</div>`);
    return rows.join('');
  }

  // Studio/voice toggle lives in the panel header.
  function wirePanel(panel, rerender) {
    panel.querySelector('[data-audio-mode]')?.addEventListener('change', (e) => {
      Voice.setAudioMode(e.target.checked ? 'studio' : 'voice');
      UI.toast('Audio mode applies the next time you join a call.');
      rerender?.();
    });
  }

  function panelShell() {
    return `<div class="cs-head"><b><i class="fa-solid fa-signal"></i> Connection</b>
      <label class="cs-mode" title="Studio: no echo cancellation, stereo, higher bitrate. Use headphones."><input type="checkbox" data-audio-mode ${Voice.audioMode() === 'studio' ? 'checked' : ''}> Studio audio</label>
      <button class="x-btn" data-cs-close><i class="fa-solid fa-xmark"></i></button></div><div class="cs-body"></div>`;
  }

  return { feedsFor, paintStage, markSpeaking, statsPanel, panelShell, wirePanel };
})();
