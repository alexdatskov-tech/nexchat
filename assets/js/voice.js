/* Voice + video rooms. WebRTC mesh, Supabase Realtime broadcast for signalling.

   Each peer connection pre-negotiates one audio and one camera transceiver,
   so turning a camera on/off is a replaceTrack() -- no renegotiation. Screen
   share travels on its own connection per peer.

   What made calls crawl before (and what changed):
   - The encoder was re-configured every 5 s (degradationPreference is not
     echoed back by getParameters() in Chrome, so the "only if changed" check
     always fired). Every reconfigure costs a keyframe -- a burst that, on a
     modest uplink, causes loss, freezes and the congestion controller backing
     off further. Sender settings are now written once per real change.
   - Every repaint built a brand-new MediaStream for your own preview, which
     resets the <video> element each time. Streams are now stable objects.
   - Remote tracks that briefly "muted" (normal under packet loss) were pulled
     out of the stream and re-added, which stalls the <video> until play()
     is called again -- the "1 frame per day" freeze. Tracks now stay put; the
     sender's broadcast cam flag decides whether a tile shows video.
   - Bitrate was fixed at 2.5 Mbps per peer. In a mesh you upload one copy per
     person, so the budget now shrinks with the size of the call.
   - 9 ICE servers (5 STUN + 4 public TURN) and an ICE pool of 4 meant slow
     setup and a pile of relay allocations. Now 2 STUN + TURN fallback.
   - ICE restarts never happened (restartIce() needs a new offer, which
     nothing sent). The offering side now re-offers with iceRestart.
   - Audio claimed "Opus stereo 48kHz". With echo cancellation on, browsers
     capture MONO, and every Opus stream reports 48000/2 in SDP regardless.
     The stats panel now reports what getStats() actually measures.       */
window.Voice = (function () {
  let sig = null, local = null, screen = null, camTrack = null;
  let camStream = null, screenStream = null;     // stable local preview streams
  let iceServers = null, manualStun = null;
  const peers = new Map();          // uid -> rec
  const members = new Map();        // uid -> profile + flags
  let me = null, chan = null, srvId = null;
  let muted = false, deaf = false, cam = false, sharing = false;
  const targetFps = 30;
  let onChange = () => {}, onSpeak = () => {}, onStats = () => {};
  let actx = null, meterTimer = null, statTimer = null;
  const meters = new Map();
  let stats = { res: '', fps: 0, vkbps: 0, akbps: 0, rtt: 0, codec: '', peers: [] };

  const state = () => ({ active: !!chan, channel: chan, muted, deaf, cam, sharing, members, stats, audioMode: audioMode() });

  /* ---------- audio ----------
     "voice" (default): echo cancellation, noise suppression and AGC on. The
       browser captures mono for this; Opus ~48 kbps with FEC + DTX is
       transparent for speech and holds up on bad networks.
     "studio": processing off, stereo capture, 128 kbps stereo Opus. For
       music / streaming with headphones -- without headphones you echo.   */
  function audioMode() {
    try { return localStorage.getItem('nx_audio_mode') === 'studio' ? 'studio' : 'voice'; } catch { return 'voice'; }
  }
  function setAudioMode(mode) {
    try { localStorage.setItem('nx_audio_mode', mode === 'studio' ? 'studio' : 'voice'); } catch {}
  }

  function tuneOpus(sdp) {
    const pt = (sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i) || [])[1];
    if (!pt) return sdp;
    const studio = audioMode() === 'studio';
    const want = studio
      ? { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: 128000, useinbandfec: 1, usedtx: 0 }
      : { stereo: 0, 'sprop-stereo': 0, maxaveragebitrate: 48000, useinbandfec: 1, usedtx: 1 };
    const keys = Object.keys(want);
    const opts = keys.map((k) => `${k}=${want[k]}`).join(';');
    const line = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    if (line.test(sdp)) {
      return sdp.replace(line, (m, p) => {
        const kept = p.split(';').map((x) => x.trim()).filter((x) => x && !keys.includes(x.split('=')[0]));
        return `a=fmtp:${pt} ${[...kept, opts].join(';')}`;
      });
    }
    return sdp.replace(new RegExp(`(a=rtpmap:${pt} opus/48000/2\\r?\\n)`), `$1a=fmtp:${pt} ${opts}\r\n`);
  }
  const tuned = (d) => ({ type: d.type, sdp: tuneOpus(d.sdp) });

  async function getMic() {
    if (local) return local;
    const studio = audioMode() === 'studio';
    local = await navigator.mediaDevices.getUserMedia({
      audio: studio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } }
        : { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
      video: false,
    });
    return local;
  }

  /* ---------- bandwidth budget ----------
     A mesh uploads one copy of your camera per person, so the per-peer
     budget has to shrink as the call grows or the uplink saturates. */
  function camBudget() {
    const n = Math.max(1, peers.size);
    if (n <= 1) return { kbps: 1500, scale: 1 };
    if (n === 2) return { kbps: 900, scale: 1 };
    if (n <= 4) return { kbps: 550, scale: 1.5 };
    return { kbps: 300, scale: 2 };
  }

  /* Writes sender settings only when the values WE want change. Comparing
     against getParameters() is unreliable (fields come back missing), which
     is what made the old code reconfigure the encoder every few seconds. */
  async function applySender(sender, want) {
    if (!sender || !sender.track) return;
    const sigOf = JSON.stringify(want);
    if (sender._nxApplied === sigOf) return;
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      const e = p.encodings[0];
      if (want.kbps) e.maxBitrate = want.kbps * 1000;
      if (want.fps) e.maxFramerate = want.fps;
      if (want.scale) e.scaleResolutionDownBy = want.scale;
      e.priority = want.priority || 'high';
      e.networkPriority = want.priority || 'high';
      if (want.degradation) p.degradationPreference = want.degradation;
      await sender.setParameters(p);
      sender._nxApplied = sigOf;
    } catch (err) {
      // Some browsers reject unknown fields; retry with the bare minimum.
      try {
        const p = sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        if (want.kbps) p.encodings[0].maxBitrate = want.kbps * 1000;
        await sender.setParameters(p);
        sender._nxApplied = sigOf;
      } catch {}
    }
  }

  function applyCamSender(rec) {
    if (!rec.tx.cam || !cam) return;
    const b = camBudget();
    applySender(rec.tx.cam.sender, { kbps: b.kbps, scale: b.scale, fps: targetFps, degradation: 'balanced', priority: 'medium' });
  }
  function applyAudioSender(rec) {
    if (rec.tx.audio) applySender(rec.tx.audio.sender, { priority: 'high' });
  }
  const rebudget = () => peers.forEach(applyCamSender);

  /* ---------- peer connections ---------- */
  function rtcConfig() {
    return { iceServers, iceCandidatePoolSize: 1, bundlePolicy: 'max-bundle' };
  }

  function blankPeer(uid) {
    const pc = new RTCPeerConnection(rtcConfig());
    const rec = {
      pc, uid, tx: { audio: null, cam: null },
      audioStream: new MediaStream(), camStream: new MediaStream(),
      queue: [], ready: false, failTimer: null, restarting: false,
      prev: null,   // last stats sample, for rates
    };
    peers.set(uid, rec);

    pc.onicecandidate = (e) => { if (e.candidate) send('ice', { to: uid, candidate: e.candidate }); };

    pc.ontrack = (e) => {
      const tr = e.track;
      if (tr.kind === 'audio') {
        if (!rec.audioStream.getTracks().includes(tr)) {
          rec.audioStream.getAudioTracks().forEach((t) => rec.audioStream.removeTrack(t));
          rec.audioStream.addTrack(tr);
        }
        attachAudio(uid, rec);
        if (!meters.has(uid)) meter(uid, rec.audioStream);
      } else {
        // Keep the receiver track for good. It may mute and unmute as packets
        // stall; the <video> handles that by itself, removing it does not.
        const cur = rec.camStream.getVideoTracks()[0];
        if (cur !== tr) {
          if (cur) rec.camStream.removeTrack(cur);
          rec.camStream.addTrack(tr);
          rec.camGen = (rec.camGen || 0) + 1;
        }
        tr.onunmute = () => onChange(state());
      }
      onChange(state());
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      clearTimeout(rec.failTimer);
      if (s === 'failed' || s === 'disconnected') rec.badSince = rec.badSince || Date.now();
      if (s === 'failed') restart(rec);
      else if (s === 'disconnected') rec.failTimer = setTimeout(() => restart(rec), 4000);
      else if (s === 'connected') { rec.restarting = false; rec.badSince = 0; }
      onChange(state());
    };
    return rec;
  }

  /* ICE restart: only the side that offers re-offers (lower user id), the
     other side answers it through the normal 'offer' path. */
  async function restart(rec) {
    if (!chan || rec.restarting || peers.get(rec.uid) !== rec) return;
    // Someone who closed the tab without a goodbye: stop retrying, drop them.
    if (rec.badSince && Date.now() - rec.badSince > 30000) { drop(rec.uid); closeScreenFrom(rec.uid); closeScreenTo(rec.uid); return; }
    rec.restarting = true;
    if (me.id < rec.uid) {
      try {
        const o = await rec.pc.createOffer({ iceRestart: true });
        await rec.pc.setLocalDescription(o);
        send('offer', { to: rec.uid, sdp: tuned(rec.pc.localDescription), profile: selfProfile() });
      } catch {}
    } else {
      send('ping', { to: rec.uid });     // nudge the offerer
    }
    setTimeout(() => {
      rec.restarting = false;
      if (peers.get(rec.uid) === rec && ['failed', 'disconnected'].includes(rec.pc.connectionState)) restart(rec);
    }, 8000);
  }

  function buildOfferer(uid) {
    const rec = blankPeer(uid);
    rec.tx.audio = rec.pc.addTransceiver(local.getAudioTracks()[0], { direction: 'sendrecv', streams: [local] });
    rec.tx.cam = rec.pc.addTransceiver('video', { direction: 'sendrecv' });
    attachLocalVideo(rec);
    applyAudioSender(rec);
    rec.ready = true;
    rebudget();
    return rec;
  }

  function adoptTransceivers(rec) {
    const txs = rec.pc.getTransceivers();
    rec.tx.audio = txs.find((t) => t.receiver.track?.kind === 'audio') || txs[0];
    rec.tx.cam = txs.find((t) => t.receiver.track?.kind === 'video') || null;
    try {
      if (rec.tx.audio) {
        rec.tx.audio.direction = 'sendrecv';
        if (rec.tx.audio.sender.track !== local.getAudioTracks()[0]) rec.tx.audio.sender.replaceTrack(local.getAudioTracks()[0]);
      }
      if (rec.tx.cam) rec.tx.cam.direction = 'sendrecv';
    } catch {}
    attachLocalVideo(rec);
    applyAudioSender(rec);
    rec.ready = true;
    rebudget();
  }

  function attachLocalVideo(rec) {
    if (!rec.tx.cam) return;
    const want = cam ? camTrack : null;
    if (rec.tx.cam.sender.track === want) return;
    rec.tx.cam.sender._nxApplied = null;
    rec.tx.cam.sender.replaceTrack(want).then(() => applyCamSender(rec)).catch(() => {});
  }

  async function flushIce(rec) {
    while (rec.queue.length) {
      const c = rec.queue.shift();
      try { await rec.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
  }

  function attachAudio(uid, rec) {
    let a = document.getElementById('va-' + uid);
    if (!a) {
      a = document.createElement('audio');
      a.id = 'va-' + uid;
      a.autoplay = true; a.playsInline = true;
      document.body.appendChild(a);
    }
    if (a.srcObject !== rec.audioStream) a.srcObject = rec.audioStream;
    a.muted = deaf;
    a.play?.().catch(() => {});
  }

  function drop(uid) {
    meters.delete(uid);
    const p = peers.get(uid);
    if (p) { clearTimeout(p.failTimer); try { p.pc.close(); } catch {} peers.delete(uid); }
    document.getElementById('va-' + uid)?.remove();
    members.delete(uid);
    rebudget();
    onChange(state());
  }

  function send(type, payload) {
    sig?.send({ type: 'broadcast', event: 'sig', payload: { type, from: me.id, ...payload } });
  }

  async function offerTo(uid) {
    const rec = peers.get(uid) || buildOfferer(uid);
    const o = await rec.pc.createOffer();
    await rec.pc.setLocalDescription(o);
    send('offer', { to: uid, sdp: tuned(rec.pc.localDescription), profile: selfProfile() });
  }

  let session = '';
  const selfProfile = () => ({ ...me, muted, deaf, cam, sharing, _sid: session });

  /* ===================== SCREEN SHARE =====================
     Own RTCPeerConnection per viewer, so the share gets its own encoder and
     bandwidth estimate instead of fighting the camera inside one bundle. */
  const scrOut = new Map();   // uid -> { pc, queue }  (we share to them)
  const scrIn = new Map();    // uid -> { pc, stream, queue }  (they share to us)
  let screenQuality = { w: 1920, h: 1080, kbps: 2500, hint: 'detail', degradation: 'maintain-resolution' };

  async function screenOfferTo(uid) {
    if (!screen || scrOut.has(uid)) return;
    const pc = new RTCPeerConnection(rtcConfig());
    const rec = { pc, queue: [] };
    scrOut.set(uid, rec);
    screen.getTracks().forEach((t) => pc.addTrack(t, screen));
    pc.onicecandidate = (e) => { if (e.candidate) send('s-ice', { to: uid, candidate: e.candidate }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { closeScreenTo(uid); if (sharing) screenOfferTo(uid); }
    };
    const vs = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    const viewers = Math.max(1, members.size - 1);
    await applySender(vs, {
      kbps: Math.round(screenQuality.kbps / Math.min(viewers, 3)), fps: targetFps,
      degradation: screenQuality.degradation, priority: 'medium',
    });
    const o = await pc.createOffer();
    await pc.setLocalDescription(o);
    send('s-offer', { to: uid, sdp: pc.localDescription });
  }

  async function screenAnswer(uid, sdp) {
    let rec = scrIn.get(uid);
    if (!rec) {
      const pc = new RTCPeerConnection(rtcConfig());
      rec = { pc, stream: new MediaStream(), queue: [] };
      scrIn.set(uid, rec);
      pc.onicecandidate = (e) => { if (e.candidate) send('s-ice', { to: uid, candidate: e.candidate }); };
      pc.ontrack = (e) => {
        rec.stream.getTracks().forEach((t) => { if (t.kind === e.track.kind && t !== e.track) rec.stream.removeTrack(t); });
        if (!rec.stream.getTracks().includes(e.track)) rec.stream.addTrack(e.track);
        if (e.track.kind === 'audio') {
          let a = document.getElementById('vsa-' + uid);
          if (!a) { a = document.createElement('audio'); a.id = 'vsa-' + uid; a.autoplay = true; document.body.appendChild(a); }
          a.srcObject = new MediaStream([e.track]); a.muted = deaf; a.play?.().catch(() => {});
        }
        e.track.onended = () => { rec.stream.removeTrack(e.track); onChange(state()); };
        onChange(state());
      };
    }
    await rec.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    while (rec.queue.length) { try { await rec.pc.addIceCandidate(new RTCIceCandidate(rec.queue.shift())); } catch {} }
    const a = await rec.pc.createAnswer();
    await rec.pc.setLocalDescription(a);
    send('s-answer', { to: uid, sdp: rec.pc.localDescription });
    onChange(state());
  }

  function closeScreenTo(uid) {
    const o = scrOut.get(uid);
    if (o) { try { o.pc.close(); } catch {} scrOut.delete(uid); }
  }
  function closeScreenFrom(uid) {
    const i = scrIn.get(uid);
    if (i) { try { i.pc.close(); } catch {} scrIn.delete(uid); }
    document.getElementById('vsa-' + uid)?.remove();
    onChange(state());
  }
  function teardownScreen() {
    scrOut.forEach((_, uid) => closeScreenTo(uid));
    scrOut.clear();
    send('s-stop', {});
  }

  /* ---------- speaking meters ----------
     10 Hz on a timer instead of every animation frame: same responsiveness,
     a fraction of the main-thread time during a call. */
  function meter(uid, stream) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const an = actx.createAnalyser();
      an.fftSize = 512; an.smoothingTimeConstant = 0.6;
      actx.createMediaStreamSource(stream).connect(an);
      meters.set(uid, { an, data: new Uint8Array(an.fftSize), on: false, hold: 0 });
      if (!meterTimer) meterTimer = setInterval(tick, 100);
    } catch {}
  }
  function tick() {
    let changed = false;
    meters.forEach((m, uid) => {
      m.an.getByteTimeDomainData(m.data);
      let s = 0;
      for (let i = 0; i < m.data.length; i++) { const v = (m.data[i] - 128) / 128; s += v * v; }
      const loud = Math.sqrt(s / m.data.length) > 0.035 && !(uid === me?.id && muted);
      if (loud) m.hold = 3;                         // ~300 ms hangover, no flicker
      const on = loud || m.hold-- > 0;
      if (on !== m.on) { m.on = on; changed = true; }
    });
    if (changed) onSpeak(speaking());
  }
  function speaking() {
    const s = new Set();
    meters.forEach((m, uid) => { if (m.on) s.add(uid); });
    return s;
  }

  /* ---------- live connection stats (all real getStats() values) ---------- */
  const kbps = (bytes, prevBytes, dt) => (dt > 0 && prevBytes != null ? Math.max(0, Math.round(((bytes - prevBytes) * 8) / dt / 1000)) : 0);

  async function sampleConn(pc, prev) {
    const rep = await pc.getStats();
    const byId = new Map();
    rep.forEach((r) => byId.set(r.id, r));
    const codecOf = (r) => {
      const c = r && r.codecId ? byId.get(r.codecId) : null;
      if (!c) return null;
      return { mime: (c.mimeType || '').split('/')[1] || '', clock: c.clockRate, channels: c.channels, fmtp: c.sdpFmtpLine || '' };
    };
    const out = { t: performance.now(), audioOut: null, audioIn: null, videoOut: null, videoIn: null, path: null };
    rep.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.audioOut = { bytes: r.bytesSent, codec: codecOf(r) };
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        out.audioIn = {
          bytes: r.bytesReceived, codec: codecOf(r), lost: r.packetsLost || 0, recv: r.packetsReceived || 0,
          jitter: r.jitter != null ? Math.round(r.jitter * 1000) : null,
          conceal: r.totalSamplesReceived ? (r.concealedSamples || 0) / r.totalSamplesReceived : 0,
          jbDelay: r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : null,
        };
      }
      if (r.type === 'outbound-rtp' && r.kind === 'video' && (r.frameWidth || r.bytesSent)) {
        out.videoOut = {
          bytes: r.bytesSent, codec: codecOf(r), w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond,
          limit: r.qualityLimitationReason, enc: r.encoderImplementation, hw: r.powerEfficientEncoder,
        };
      }
      if (r.type === 'inbound-rtp' && r.kind === 'video' && (r.frameWidth || r.bytesReceived)) {
        out.videoIn = {
          bytes: r.bytesReceived, codec: codecOf(r), w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond,
          dropped: r.framesDropped || 0, freezes: r.freezeCount || 0, lost: r.packetsLost || 0, recv: r.packetsReceived || 0,
          dec: r.decoderImplementation, hw: r.powerEfficientDecoder,
        };
      }
      if (r.type === 'transport' && r.selectedCandidatePairId) out._pair = r.selectedCandidatePairId;
    });
    // The pair in actual use is the transport's selected one; "nominated" can
    // be true for several pairs. Fall back to it only if transport stats lack it.
    const pairs = [];
    rep.forEach((r) => { if (r.type === 'candidate-pair') pairs.push(r); });
    const pair = (out._pair && byId.get(out._pair)) || pairs.find((r) => r.nominated && r.state === 'succeeded');
    delete out._pair;
    if (pair) {
      const lc = byId.get(pair.localCandidateId), rc = byId.get(pair.remoteCandidateId);
      out.path = {
        rtt: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
        avail: pair.availableOutgoingBitrate ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
        local: lc?.candidateType, remote: rc?.candidateType, proto: lc?.protocol, relay: lc?.relayProtocol,
      };
    }
    const dt = prev ? (out.t - prev.t) / 1000 : 0;
    if (out.audioOut) out.audioOut.kbps = kbps(out.audioOut.bytes, prev?.audioOut?.bytes, dt);
    if (out.audioIn) {
      out.audioIn.kbps = kbps(out.audioIn.bytes, prev?.audioIn?.bytes, dt);
      const dl = out.audioIn.lost - (prev?.audioIn?.lost || 0), dr = out.audioIn.recv - (prev?.audioIn?.recv || 0);
      out.audioIn.lossPct = dl + dr > 0 ? Math.round((dl / (dl + dr)) * 1000) / 10 : 0;
    }
    if (out.videoOut) out.videoOut.kbps = kbps(out.videoOut.bytes, prev?.videoOut?.bytes, dt);
    if (out.videoIn) {
      out.videoIn.kbps = kbps(out.videoIn.bytes, prev?.videoIn?.bytes, dt);
      const dl = out.videoIn.lost - (prev?.videoIn?.lost || 0), dr = out.videoIn.recv - (prev?.videoIn?.recv || 0);
      out.videoIn.lossPct = dl + dr > 0 ? Math.round((dl / (dl + dr)) * 1000) / 10 : 0;
    }
    return out;
  }

  function captureInfo() {
    const t = local?.getAudioTracks()[0];
    const s = t?.getSettings?.() || {};
    return {
      channels: s.channelCount || null, rate: s.sampleRate || null,
      ec: s.echoCancellation, ns: s.noiseSuppression, agc: s.autoGainControl,
      device: t?.label || '',
    };
  }

  async function pollStats() {
    const list = [];
    for (const rec of peers.values()) {
      try {
        const cur = await sampleConn(rec.pc, rec.prev);
        rec.prev = cur;
        const p = members.get(rec.uid);
        list.push({ uid: rec.uid, name: p?.display_name || p?.username || 'Peer', state: rec.pc.connectionState, ...cur });
      } catch {}
    }
    for (const [uid, rec] of scrOut) {
      try { const cur = await sampleConn(rec.pc, rec.prev); rec.prev = cur; const row = list.find((x) => x.uid === uid); if (row) row.screenOut = cur.videoOut; } catch {}
    }
    for (const [uid, rec] of scrIn) {
      try { const cur = await sampleConn(rec.pc, rec.prev); rec.prev = cur; const row = list.find((x) => x.uid === uid); if (row) row.screenIn = cur.videoIn; } catch {}
    }

    const first = list[0];
    const camS = camTrack?.getSettings?.() || {};
    stats = {
      peers: list,
      capture: captureInfo(),
      camera: cam ? { w: camS.width, h: camS.height, fps: Math.round(camS.frameRate || 0) } : null,
      audioMode: audioMode(),
      budget: camBudget(),
      // Summary fields (kept for older callers).
      res: first?.videoOut?.w ? `${first.videoOut.w}×${first.videoOut.h}` : (camS.width ? `${camS.width}×${camS.height}` : ''),
      fps: Math.round(first?.videoOut?.fps || camS.frameRate || 0),
      vkbps: list.reduce((a, x) => a + (x.videoOut?.kbps || 0), 0),
      akbps: list.reduce((a, x) => a + (x.audioOut?.kbps || 0), 0),
      rtt: first?.path?.rtt || 0,
      codec: first?.audioOut?.codec ? `${first.audioOut.codec.mime}` : '',
    };
    onStats(stats);
  }

  /* ---------- join / leave ---------- */
  async function join(channel, serverId, profile, cb, speakCb, statsCb) {
    if (chan) await leave();
    me = profile; chan = channel; srvId = serverId;
    session = Math.random().toString(36).slice(2);
    onChange = cb || (() => {}); onSpeak = speakCb || (() => {}); onStats = statsCb || (() => {});

    try { await getMic(); }
    catch { chan = null; UI.toast('NexChat needs microphone access to join voice.', true); throw new Error('mic'); }
    iceServers = await ICE.build({ manual: manualStun });

    members.set(me.id, selfProfile());
    meter(me.id, local);

    if (serverId) {
      window.db.from('voice_sessions').upsert({
        channel_id: channel.id, user_id: me.id, server_id: serverId,
        is_muted: muted, is_deafened: deaf, is_camera_on: cam, is_screen_sharing: sharing,
      }).then(() => {}, () => {});
    }

    sig = window.db.channel('voice:' + channel.id, { config: { broadcast: { self: false, ack: false } } });

    sig.on('broadcast', { event: 'sig' }, async ({ payload: m }) => {
      if (!m || !chan || m.from === me.id || (m.to && m.to !== me.id)) return;
      const lowerIsMe = me.id < m.from;
      try {
        if (m.type === 'hello') {
          const knownSid = members.get(m.from)?._sid;
          members.set(m.from, m.profile);
          // A rejoin after a reload: the old connection is dead, start fresh.
          // A socket reconnect re-announces with the same session id; that
          // healthy connection is kept.
          const old = peers.get(m.from);
          const sameSession = knownSid && knownSid === m.profile?._sid && old?.pc.connectionState === 'connected';
          if (old && !sameSession) {
            clearTimeout(old.failTimer); try { old.pc.close(); } catch {} peers.delete(m.from);
          } else if (old) { onChange(state()); return; }
          if (lowerIsMe) await offerTo(m.from);
          else send('hello-ack', { to: m.from, profile: selfProfile() });
          if (sharing) { closeScreenTo(m.from); screenOfferTo(m.from); }
          onChange(state());
        } else if (m.type === 'hello-ack') {
          members.set(m.from, m.profile);
          if (lowerIsMe && !peers.has(m.from)) await offerTo(m.from);
          if (sharing) screenOfferTo(m.from);
          onChange(state());
        } else if (m.type === 'offer') {
          members.set(m.from, { ...(members.get(m.from) || {}), ...m.profile });
          let rec = peers.get(m.from);
          if (rec && rec.pc.signalingState === 'have-local-offer') {
            // Glare: the lower id's offer wins.
            if (lowerIsMe) return;
            await rec.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
          }
          if (!rec) rec = blankPeer(m.from);
          await rec.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
          adoptTransceivers(rec);
          const ans = await rec.pc.createAnswer();
          await rec.pc.setLocalDescription(ans);
          await flushIce(rec);
          send('answer', { to: m.from, sdp: tuned(rec.pc.localDescription), profile: selfProfile() });
          onChange(state());
        } else if (m.type === 'answer') {
          const rec = peers.get(m.from);
          if (rec && rec.pc.signalingState === 'have-local-offer') {
            await rec.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
            await flushIce(rec);
          }
        } else if (m.type === 'ice') {
          const rec = peers.get(m.from);
          if (!rec) return;
          if (rec.pc.remoteDescription?.type) { try { await rec.pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {} }
          else rec.queue.push(m.candidate);
        } else if (m.type === 's-offer') await screenAnswer(m.from, m.sdp);
        else if (m.type === 's-answer') {
          const rec = scrOut.get(m.from);
          if (rec && rec.pc.signalingState === 'have-local-offer') {
            await rec.pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
            while (rec.queue.length) { try { await rec.pc.addIceCandidate(new RTCIceCandidate(rec.queue.shift())); } catch {} }
          }
        } else if (m.type === 's-ice') {
          const rec = scrIn.get(m.from) || scrOut.get(m.from);
          if (!rec) return;
          if (rec.pc.remoteDescription?.type) { try { await rec.pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {} }
          else rec.queue.push(m.candidate);
        } else if (m.type === 's-stop') closeScreenFrom(m.from);
        else if (m.type === 'bye') { drop(m.from); closeScreenFrom(m.from); closeScreenTo(m.from); }
        else if (m.type === 'state') {
          members.set(m.from, { ...(members.get(m.from) || {}), ...m.flags });
          onChange(state());
        } else if (m.type === 'ping') {
          const rec = peers.get(m.from);
          if (lowerIsMe && rec && ['failed', 'disconnected'].includes(rec.pc.connectionState)) restart(rec);
          else send('hello-ack', { to: m.from, profile: selfProfile() });
        }
      } catch (err) { console.warn('signal error', m.type, err); }
    });

    await sig.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        send('hello', { profile: selfProfile() });
        setTimeout(() => send('ping', {}), 1500);
      }
    });

    statTimer = setInterval(pollStats, 1000);
    onChange(state());
    return true;
  }

  async function leave() {
    if (!chan) return;
    send('bye', {});
    peers.forEach((p, uid) => { clearTimeout(p.failTimer); try { p.pc.close(); } catch {} document.getElementById('va-' + uid)?.remove(); });
    scrOut.forEach((r) => { try { r.pc.close(); } catch {} });
    scrIn.forEach((r, uid) => { try { r.pc.close(); } catch {} document.getElementById('vsa-' + uid)?.remove(); });
    scrOut.clear(); scrIn.clear();
    peers.clear(); members.clear(); meters.clear();
    if (meterTimer) { clearInterval(meterTimer); meterTimer = null; }
    if (statTimer) { clearInterval(statTimer); statTimer = null; }
    if (sig) { await window.db.removeChannel(sig); sig = null; }
    if (srvId) { try { await window.db.from('voice_sessions').delete().eq('channel_id', chan.id).eq('user_id', me.id); } catch {} }
    if (local) { local.getTracks().forEach((t) => t.stop()); local = null; }
    if (screen) { screen.getTracks().forEach((t) => t.stop()); screen = null; screenStream = null; }
    if (camTrack) { camTrack.stop(); camTrack = null; camStream = null; }
    chan = null; cam = false; sharing = false;
    stats = { res: '', fps: 0, vkbps: 0, akbps: 0, rtt: 0, codec: '', peers: [] };
    onChange(state());
  }

  function pushFlags() {
    members.set(me.id, selfProfile());
    if (chan && srvId) {
      window.db.from('voice_sessions')
        .update({ is_muted: muted, is_deafened: deaf, is_camera_on: cam, is_screen_sharing: sharing })
        .eq('channel_id', chan.id).eq('user_id', me.id).then(() => {}, () => {});
    }
    send('state', { flags: { muted, deaf, cam, sharing } });
  }

  function setMute(v) {
    muted = v ?? !muted;
    if (!muted && deaf) deaf = false;
    local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    document.querySelectorAll('audio[id^="va-"], audio[id^="vsa-"]').forEach((a) => { a.muted = deaf; });
    pushFlags(); onChange(state());
  }

  function setDeaf(v) {
    deaf = v ?? !deaf;
    if (deaf) { muted = true; local?.getAudioTracks().forEach((t) => (t.enabled = false)); }
    document.querySelectorAll('audio[id^="va-"], audio[id^="vsa-"]').forEach((a) => { a.muted = deaf; });
    pushFlags(); onChange(state());
  }

  async function toggleCam() {
    if (cam) {
      if (camTrack) { camTrack.stop(); camTrack = null; }
      camStream = null; cam = false;
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        });
        camTrack = s.getVideoTracks()[0];
        try { camTrack.contentHint = 'motion'; } catch {}
        camStream = new MediaStream([camTrack]);
        camTrack.onended = () => { cam = false; camTrack = null; camStream = null; peers.forEach(attachLocalVideo); pushFlags(); onChange(state()); };
        cam = true;
      } catch { UI.toast('Could not start your camera.', true); return; }
    }
    peers.forEach(attachLocalVideo);
    pushFlags(); onChange(state());
  }

  const screenSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  async function stopShare() {
    if (!sharing) return;
    screen?.getTracks().forEach((t) => t.stop());
    screen = null; screenStream = null; sharing = false;
    teardownScreen();
    pushFlags(); onChange(state());
  }

  /* opts: { surface: 'monitor'|'window'|'browser', quality: 'text'|'motion'|'auto', audio: bool }
     'text'  : sharp 1080p, frame rate drops first   (slides, code, docs)
     'motion': smooth 720p30, resolution drops first  (video, games)      */
  async function startShare(opts = {}) {
    if (sharing) return stopShare();
    if (!screenSupported()) { UI.toast('Screen sharing needs a desktop browser.', true); return; }
    const q = { 1080: 'text', 720: 'motion' }[opts.quality] || opts.quality || 'text';
    screenQuality = q === 'motion'
      ? { w: 1280, h: 720, kbps: 2500, hint: 'motion', degradation: 'maintain-framerate' }
      : q === 'auto'
        ? { w: 1920, h: 1080, kbps: 2000, hint: 'motion', degradation: 'balanced' }
        : { w: 1920, h: 1080, kbps: 2500, hint: 'detail', degradation: 'maintain-resolution' };

    const video = {
      frameRate: { ideal: 30, max: 30 },
      width: { ideal: screenQuality.w, max: screenQuality.w },
      height: { ideal: screenQuality.h, max: screenQuality.h },
    };
    if (opts.surface) video.displaySurface = opts.surface;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({
        video,
        audio: opts.audio === false ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
        systemAudio: opts.audio === false ? 'exclude' : 'include',
      });
    } catch (err) {
      if (err && err.name !== 'NotAllowedError') UI.toast('Could not start sharing: ' + err.message, true);
      return;
    }
    const st = screen.getVideoTracks()[0];
    try { st.contentHint = screenQuality.hint; } catch {}
    st.onended = () => stopShare();
    screenStream = new MediaStream([st]);
    sharing = true;
    for (const uid of members.keys()) if (uid !== me.id) await screenOfferTo(uid);
    pushFlags(); onChange(state());
  }

  const toggleShare = () => (sharing ? stopShare() : startShare());

  async function setManualStun(list) {
    manualStun = list && list.length ? list : null;
    iceServers = await ICE.build({ manual: manualStun });
    peers.forEach((rec) => { try { rec.pc.setConfiguration(rtcConfig()); } catch {} });
    return iceServers;
  }

  const localCam = () => (cam && camTrack && camTrack.readyState === 'live' ? camStream : null);
  const localScreen = () => (sharing && screen && screenStream ? screenStream : null);
  const peerCam = (uid) => {
    const s = peers.get(uid)?.camStream;
    return s && s.getVideoTracks().some((t) => t.readyState === 'live') ? s : null;
  };
  const peerScreen = (uid) => {
    const s = scrIn.get(uid)?.stream;
    return s && s.getVideoTracks().some((t) => t.readyState === 'live') ? s : null;
  };

  return {
    join, leave, setMute, setDeaf, toggleCam, toggleShare, startShare, stopShare,
    screenSupported, state, speaking, audioMode, setAudioMode,
    get targetFps() { return targetFps; },
    localCam, localScreen, peerCam, peerScreen, setManualStun,
    get iceServers() { return iceServers; },
  };
})();
