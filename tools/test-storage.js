/* File links must never expire.

   Pins the storage contract: uploads persist a PERMANENT object URL (no
   signature in the database), every stored URL -- including old rows that
   hold a long-expired presigned link -- is re-signed at render time, and the
   signature is day-aligned so a file's URL is stable (cacheable) all day.

   npm i jsdom && node tools/test-storage.js
*/
const { JSDOM } = require('jsdom');
const fs = require('fs');
const REPO = '/home/user/nexchat';

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) { pass++; console.log('  PASS ' + n); } else { fail++; console.log('  FAIL ' + n); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'https://app.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const signed = [], puts = [], dels = [];
window.NEXCHAT_CONFIG = {};
window.__nx_tp = {
  host: 's3.us-west-4.idrivee2.com', bucket: 'robo-test',
  presign: async (key, mins, at) => { signed.push({ key, mins, at }); return `https://s3.us-west-4.idrivee2.com/robo-test/${key}?sig=${at}`; },
  put: async (key, file) => { puts.push(key); return { url: 'https://signed.example/should-not-be-stored?X-Amz-Expires=604800', type: file.type }; },
  del: async (key) => { dels.push(key); },
  mimeOf: () => 'image/png',
};
window.UI = { toast() {}, confirmDialog: async () => true };
for (const f of ['md.js', 'storage.js', 'viewer.js']) window.eval(fs.readFileSync(`${REPO}/assets/js/${f}`, 'utf8'));
const { Store, Viewer } = window;

(async () => {
  console.log('\nstorage — permanent links');
  const file = new window.Blob(['x'], { type: 'image/png' }); file.name = 'cat.png';
  const up = await Store.put('nexchat/dm/conv1/1-cat.png', file);
  ok(puts[0] === 'nexchat/dm/conv1/1-cat.png', 'upload went to the right key');
  ok(up.url === 'https://s3.us-west-4.idrivee2.com/robo-test/nexchat/dm/conv1/1-cat.png', `stores the permanent URL (${up.url})`);
  ok(!/[?&]X-Amz/i.test(up.url), 'no signature persisted');

  console.log('\nstorage — legacy expired rows recover');
  const legacy = 'https://s3.us-west-4.idrivee2.com/robo-test/nexchat/1a/2b/169-my%20file.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20250101T000000Z&X-Amz-Expires=604800&X-Amz-Signature=dead';
  ok(Store.keyOf(legacy) === 'nexchat/1a/2b/169-my file.png', 'key recovered from an old presigned URL');
  const u = await Store.sign(legacy);
  ok(signed.at(-1).key === 'nexchat/1a/2b/169-my file.png', 'freshly signed from the recovered key');
  const day = 86400000;
  ok(signed.at(-1).at % day === 0 && Date.now() - signed.at(-1).at < day, 'signature is anchored to the start of today (UTC)');
  ok(signed.at(-1).mins === 7 * 24 * 60, 'valid for the 7-day maximum');
  ok(u.includes('sig='), 'returns a loadable signed URL');

  const n = signed.length;
  await Store.sign(legacy);
  await Store.sign('https://s3.us-west-4.idrivee2.com/robo-test/nexchat/1a/2b/169-my%20file.png');
  ok(signed.length === n, 'same file is signed once and cached, old or new form');
  ok(Store.signedNow(legacy) === u, 'cached signature available synchronously');

  ok(Store.isManaged('https://cdn.example.com/a.png') === false, 'foreign URLs are left alone');
  ok(await Store.sign('https://cdn.example.com/a.png') === 'https://cdn.example.com/a.png', 'foreign URL passes through');

  console.log('\nviewer — renders stored URLs');
  const fresh = 'https://s3.us-west-4.idrivee2.com/robo-test/nexchat/dm/conv1/2-dog.png';
  const node = Viewer.render({ id: 'a1', url: fresh, file_name: 'dog.png', file_size: 10 });
  window.document.getElementById('host').appendChild(node);
  ok(node.classList.contains('att-slot'), 'unsigned file renders a placeholder first');
  await sleep(20);
  const img = node.querySelector('img');
  ok(!!img && img.getAttribute('src').startsWith('https://s3.us-west-4.idrivee2.com/robo-test/nexchat/dm/conv1/2-dog.png?sig='), 'placeholder swapped for the signed image');
  const again = Viewer.render({ id: 'a1', url: fresh, file_name: 'dog.png', file_size: 10 });
  ok(again.classList.contains('att-img'), 'second render is synchronous from cache');

  await Viewer.removeAttachment({ id: 'a1', url: fresh, _dm: true }).catch(() => {});
  ok(dels.at(-1) === 'nexchat/dm/conv1/2-dog.png', 'delete targets the object key');

  console.log('\nstorage — <img data-nx-src> hydration');
  window.document.body.insertAdjacentHTML('beforeend', `<img id="ri" ${Store.imgAttr('https://s3.us-west-4.idrivee2.com/robo-test/nexchat/roles/s1/icon.png?X-Amz-Expires=1')}>`);
  await sleep(20);
  ok(window.document.getElementById('ri').getAttribute('src')?.includes('nexchat/roles/s1/icon.png?sig='), 'role icon with an expired link is re-signed');

  console.log(fail ? `\n${pass} passed, ${fail} FAILED` : `\n*** PASS: ${pass} assertions`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
