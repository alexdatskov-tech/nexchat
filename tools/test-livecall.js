// Unit test for the live-call watch in voice.js, with a fake realtime client.
const fs = require('fs');
const { JSDOM } = require('jsdom');
const assert = require('node:assert/strict');
const REPO = require('path').resolve(__dirname, '..');

const channels = new Map();   // topic -> fake channel
const removed = [];
function fakeChannel(topic) {
  const ch = {
    topic, handlers: [], presence: {}, subscribed: false,
    on(type, filter, fn) { if (type === 'presence') this.presenceFn = fn; return this; },
    subscribe(cb) { this.subscribed = true; cb?.('SUBSCRIBED'); return this; },
    presenceState() { return this.presence; },
    track() { return Promise.resolve(); },
    send() { return Promise.resolve(); },
  };
  channels.set(topic + '#' + channels.size, ch);
  return ch;
}
const db = {
  channel(topic) { return fakeChannel(topic); },
  removeChannel(ch) { removed.push(ch.topic); return Promise.resolve(); },
  from() { return { upsert() { return Promise.resolve(); }, delete() { return { eq() { return { eq() { return Promise.resolve(); } }; } }; } }; },
};

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://app.test/dms.html' });
const w = dom.window;
w.db = db;
w.UI = { toast() {} };
w.eval(fs.readFileSync(REPO + '/assets/js/voice.js', 'utf8'));
const V = w.Voice;

// Watch two calls: one live with two people, one empty.
V.watch(['dm-1', 'dm-2']);
const find = (topic) => [...channels.values()].filter((c) => c.topic === 'voice:' + topic);
assert.equal(find('dm-1').length, 1, 'watch opens one presence channel per id');
assert.equal(find('dm-2').length, 1);
find('dm-1')[0].presence = { a: [{}], b: [{}] };
find('dm-1')[0].presenceFn();
find('dm-2')[0].presence = {};
find('dm-2')[0].presenceFn();
assert.equal(JSON.stringify([...V.live().entries()]), JSON.stringify([['dm-1', 2]]), 'only live calls are reported');

// Listeners hear about changes.
let heard = null;
V.onLive((m) => { heard = [...m.entries()]; });
find('dm-2')[0].presence = { c: [{}] };
find('dm-2')[0].presenceFn();
assert.equal(JSON.stringify(heard.sort()), JSON.stringify([['dm-1', 2], ['dm-2', 1]]), 'listeners get the new map');

// Dropping an id from the watch set closes its channel.
V.watch(['dm-2']);
assert.ok(removed.includes('voice:dm-1'), 'unwatched call channel removed');
assert.equal(V.live().has('dm-1'), false);

// Joining a call stops watching it (we become a participant).
// join() needs the mic, so stub it: getUserMedia returns a fake track.
w.navigator.mediaDevices = {
  getUserMedia: async () => ({ getAudioTracks: () => [{ enabled: true, stop() {}, getSettings: () => ({}) }], getTracks: () => [], getVideoTracks: () => [] }),
};
w.ICE = { build: async () => [] };
w.RTCPeerConnection = class { constructor() {} close() {} addTransceiver() { return { sender: {}, receiver: {} }; } getTransceivers() { return []; } };
w.MediaStream = class { getTracks() { return []; } getAudioTracks() { return []; } addTrack() {} };
w.localStorage = { getItem() { return null; }, setItem() {} };
w.me = null;
(async () => {
  const profile = { id: 'me', username: 'alexd', display_name: 'alexd' };
  await V.join({ id: 'dm-2', name: 'x' }, null, profile, () => {}, () => {}, () => {});
  assert.equal(removed.includes('voice:dm-2'), true, 'joined call is no longer watched');
  // Leaving puts it back on the watch list.
  await V.leave();
  assert.ok(find('dm-2').length >= 2, 'after leaving the call is watched again');
  console.log('PASS live-call watch: presence counts, listeners, unwatch, join/leave');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
