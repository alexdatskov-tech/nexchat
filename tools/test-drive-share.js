// Tests assets/js/drive-share.js against the real Vault (AES-GCM, as the app runs it)
// and an in-memory stand-in for CloudGate. Run: node tools/test-drive-share.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

// Load vault.js the way the browser does (it attaches window.Vault).
const win = {};
const ctx = vm.createContext({
  window: win, crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob, Blob, console,
});
vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets/js/vault.js'), 'utf8'), ctx);
const Vault = win.Vault;
globalThis.window = win; // so drive-share.js finds Vault the way it does in the browser
const DS = require(path.join(ROOT, 'assets/js/drive-share.js'));

// In-memory CloudGate: folders are addressed by '/'-joined paths, files by key.
function makeDrive() {
  const dirs = new Map(); // path -> { folders:Set<enc>, files:[{key, filename, size}] }
  const store = new Map(); // object key -> Uint8Array
  let seq = 0;
  const ensure = (p) => { if (!dirs.has(p)) dirs.set(p, { folders: new Set(), files: [] }); return dirs.get(p); };
  const removeTree = (p) => {
    for (const [k, d] of [...dirs]) {
      if (k === p || k.startsWith(p + '/')) {
        for (const f of d.files) store.delete(f.key);
        dirs.delete(k);
      }
    }
  };
  const cg = {
    failUploadAt: 0, uploads: 0, failRmdir: false,
    browse: async (p) => {
      const d = ensure(p);
      return { folders: [...d.folders], files: d.files.map((f) => ({ key: f.key, filename: f.filename, size: f.size, last_modified: '' })) };
    },
    createFolder: async (p, enc) => { ensure(p).folders.add(enc); ensure(p + '/' + enc); },
    deleteFolder: async (p, enc) => {
      if (cg.failRmdir) throw new Error('network');
      removeTree(p + '/' + enc); ensure(p).folders.delete(enc);
    },
    upload: async (p, filename, blob) => {
      cg.uploads++;
      if (cg.failUploadAt && cg.uploads === cg.failUploadAt) throw new Error('upload failed');
      const key = 'obj' + (++seq);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      store.set(key, bytes);
      ensure(p).files.push({ key, filename, size: bytes.length });
      return { key };
    },
    fetchBytes: async (key) => {
      if (!store.has(key)) throw new Error('missing object ' + key);
      return store.get(key).slice().buffer;
    },
    dirs, store,
  };
  return cg;
}

// Fake database functions (the real ones are tested in test-drive-sharing-sql.js).
function makeApi() {
  const calls = [];
  const api = {
    calls, failCreate: false, failUnshare: false,
    createRoot: async (args) => { calls.push(['createRoot', args]); if (api.failCreate) throw new Error('no such user'); return 'share-1'; },
    unshareRoot: async (id) => { calls.push(['unshareRoot', id]); if (api.failUnshare) throw new Error('nope'); return null; },
  };
  return api;
}

const BASE = 'vault/u1';
const sorted = (a) => [...a].sort().join('|');

(async () => {
  console.log('Drive sharing: keys and copying');

  // ---- keyForDir ----------------------------------------------------------
  {
    const K = (await Vault.newRawKey()).key, S = (await Vault.newRawKey()).key;
    const roots = [{ path: 'a/b', key: S }];
    ok(DS.keyForDir([], roots, K) === K, 'the drive root uses the owner key');
    ok(DS.keyForDir(['a'], roots, K) === K, 'a folder above a shared root uses the owner key');
    ok(DS.keyForDir(['a', 'b'], roots, K) === S, 'the shared folder itself uses its share key');
    ok(DS.keyForDir(['a', 'b', 'c', 'd'], roots, K) === S, 'folders below a shared root use its share key');
    ok(DS.keyForDir(['a', 'bb'], roots, K) === K, 'a similar name is not treated as inside the share');
    const nested = [{ path: 'a', key: K }, { path: 'a/b', key: S }];
    ok(DS.keyForDir(['a', 'b', 'x'], nested, K) === S, 'the deepest matching root wins');
  }

  // ---- the owner's drive before sharing ------------------------------------
  const K = (await Vault.newRawKey()).key;
  const cg = makeDrive();
  const ops = DS.cloudOps(cg, BASE);
  const photosEnc = await Vault.encName(K, 'Photos');
  await cg.createFolder(BASE, photosEnc);
  const enc = (t) => new Blob([new TextEncoder().encode(t)]);
  // Top-level file, outside the folder we will share.
  await cg.upload(BASE, await Vault.encName(K, 'notes.txt'), await Vault.encBlob(K, enc('top secret')));
  await cg.upload(BASE + '/' + photosEnc, await Vault.encName(K, 'a.txt'), await Vault.encBlob(K, enc('hello world')));
  const tripEnc = await Vault.encName(K, 'trip');
  await cg.createFolder(BASE + '/' + photosEnc, tripEnc);
  const bigBytes = new Uint8Array(5000); for (let i = 0; i < bigBytes.length; i++) bigBytes[i] = (i * 31) & 255;
  await cg.upload(BASE + '/' + photosEnc + '/' + tripEnc, await Vault.encName(K, 'b.bin'), await Vault.encBlob(K, new Blob([bigBytes])));
  const deepEnc = await Vault.encName(K, 'deep');
  await cg.createFolder(BASE + '/' + photosEnc + '/' + tripEnc, deepEnc);
  await cg.upload(BASE + '/' + photosEnc + '/' + tripEnc + '/' + deepEnc, await Vault.encName(K, 'c.txt'), await Vault.encBlob(K, new Blob([new TextEncoder().encode('deep file')])));

  // ---- share Photos -----------------------------------------------------------
  console.log('Sharing a folder');
  const api = makeApi();
  const shared = await DS.shareFolder({ ops, api, K, parentSegs: [], srcEnc: photosEnc, name: 'Photos', recipient: 'bob', level: 'download' });
  ok(api.calls.length === 1 && api.calls[0][0] === 'createRoot', 'one share is created for the new root');
  const args = api.calls[0] && api.calls[0][1];
  ok(args && args.recipient === 'bob' && args.level === 'download', 'the recipient and level are passed through');
  ok(args && args.rootPath === shared.root.rootPath && args.rootPath !== photosEnc, 'the new root has a new encrypted path');
  ok(!shared.leftover, 'the old copy was removed');
  const baseFolders = [...cg.dirs.get(BASE).folders];
  ok(baseFolders.length === 1 && baseFolders[0] === shared.root.rootPath, 'only the new copy is left at the drive root');
  ok(!cg.dirs.has(BASE + '/' + photosEnc) && !cg.dirs.has(BASE + '/' + photosEnc + '/' + tripEnc), 'the old folder tree is gone');

  // The recipient's view: keys from the database (here, the raw key from createRoot).
  const S = await Vault.importRaw(shared.root.rawKey);
  const roots = [{ path: shared.root.rootPath, key: S }];
  const newSegs = shared.root.rootPath.split('/');
  ok(DS.keyForDir(newSegs, roots, K) === S, 'the shared folder is read with its share key');
  ok((await Vault.decName(S, args.labelEnc)) === 'Photos', 'the folder name decrypts with the share key');
  ok((await Vault.decName(K, args.labelEnc)) === null, 'the folder name does not decrypt with the owner key');

  const list = await cg.browse(BASE + '/' + shared.root.rootPath);
  const names = [];
  for (const f of list.files) names.push(await Vault.decName(S, f.filename));
  ok(names.join() === 'a.txt', 'inside the share, file names decrypt with the share key');
  ok((await Vault.decName(K, list.files[0].filename)) === null, 'inside the share, file names do not decrypt with the owner key');
  const aBytes = await Vault.decBytes(S, await cg.fetchBytes(list.files[0].key));
  ok(new TextDecoder().decode(aBytes) === 'hello world', 'a shared file decrypts to the original text');

  const tripList = await cg.browse(BASE + '/' + shared.root.rootPath + '/' + list.folders[0]);
  const tripName = await Vault.decName(S, list.folders[0]);
  ok(tripName === 'trip', 'a subfolder name decrypts with the share key');
  const bin = await Vault.decBytes(S, await cg.fetchBytes(tripList.files[0].key));
  ok(bin.byteLength === bigBytes.length && Buffer.compare(Buffer.from(bin), Buffer.from(bigBytes)) === 0, 'a 5000-byte file in a subfolder survives the copy byte for byte');
  const deepSegs = [...newSegs, list.folders[0]];
  const deepList = await cg.browse(BASE + '/' + deepSegs.join('/'));
  const deepFolder = deepList.folders[0];
  ok(DS.keyForDir([...deepSegs, deepFolder], roots, K) === S, 'deeper folders use the share key');
  const deepFile = await cg.browse(BASE + '/' + [...deepSegs, deepFolder].join('/'));
  const deepBytes = await Vault.decBytes(S, await cg.fetchBytes(deepFile.files[0].key));
  ok(new TextDecoder().decode(deepBytes) === 'deep file', 'a file three folders down survives the copy');

  const top = await cg.browse(BASE);
  ok(top.files.length === 1 && (await Vault.decName(K, top.files[0].filename)) === 'notes.txt', 'the owner’s top-level file is untouched and still under the owner key');

  // ---- the owner adds a file to the shared folder later ----------------------
  console.log('Owner writes into the shared folder');
  const writeKey = DS.keyForDir(newSegs, roots, K);
  await cg.upload(BASE + '/' + shared.root.rootPath, await Vault.encName(writeKey, 'later.txt'), await Vault.encBlob(writeKey, new Blob([new TextEncoder().encode('new file')])));
  const again = await cg.browse(BASE + '/' + shared.root.rootPath);
  const laterNames = [];
  for (const f of again.files) laterNames.push(await Vault.decName(S, f.filename));
  ok(laterNames.sort().join() === 'a.txt,later.txt', 'a file added after sharing decrypts with the share key, next to the copied one');

  // ---- sharing fails cleanly -------------------------------------------------
  console.log('Failures leave the original alone');
  {
    const cg2 = makeDrive();
    const ops2 = DS.cloudOps(cg2, BASE);
    const K2 = (await Vault.newRawKey()).key;
    const enc2 = await Vault.encName(K2, 'Work');
    await cg2.createFolder(BASE, enc2);
    for (let i = 0; i < 3; i++) {
      await cg2.upload(BASE + '/' + enc2, await Vault.encName(K2, 'f' + i + '.txt'), await Vault.encBlob(K2, new Blob([new TextEncoder().encode('v' + i)])));
    }
    const before = sorted((await cg2.browse(BASE)).folders);

    // Upload fails halfway through the copy.
    cg2.uploads = 0; cg2.failUploadAt = 2;
    const api2 = makeApi();
    let err = null;
    try { await DS.shareFolder({ ops: ops2, api: api2, K: K2, parentSegs: [], srcEnc: enc2, name: 'Work', recipient: 'bob', level: 'view' }); } catch (e) { err = e; }
    ok(!!err && /upload failed/.test(err.message), 'a failed copy is reported');
    ok(api2.calls.length === 0, 'no share is created when the copy fails');
    ok(sorted((await cg2.browse(BASE)).folders) === before, 'the half-made copy is removed');
    const still = await cg2.browse(BASE + '/' + enc2);
    ok(still.files.length === 3, 'the original folder still has all its files');
    cg2.failUploadAt = 0;

    // The database refuses the share after the copy was made.
    api2.failCreate = true;
    err = null;
    try { await DS.shareFolder({ ops: ops2, api: api2, K: K2, parentSegs: [], srcEnc: enc2, name: 'Work', recipient: 'nobody', level: 'view' }); } catch (e) { err = e; }
    ok(!!err && /no such user/.test(err.message), 'a refused share (unknown user) is reported');
    ok(sorted((await cg2.browse(BASE)).folders) === before, 'a refused share leaves no extra copy');

    // A locked item (name encrypted with another key) stops the share.
    const other = (await Vault.newRawKey()).key;
    await cg2.upload(BASE + '/' + enc2, await Vault.encName(other, 'mystery.txt'), await Vault.encBlob(other, new Blob([new TextEncoder().encode('?')])));
    api2.failCreate = false;
    err = null;
    try { await DS.shareFolder({ ops: ops2, api: api2, K: K2, parentSegs: [], srcEnc: enc2, name: 'Work', recipient: 'bob', level: 'view' }); } catch (e) { err = e; }
    ok(!!err && err.name === 'LockedItemError', 'an item that can’t be read stops the share with a clear error');
    ok(sorted((await cg2.browse(BASE)).folders) === before, 'and leaves nothing behind');
  }

  // ---- old copy can’t be removed ----------------------------------------------
  {
    const cg3 = makeDrive();
    const ops3 = DS.cloudOps(cg3, BASE);
    const K3 = (await Vault.newRawKey()).key;
    const enc3 = await Vault.encName(K3, 'Solo');
    await cg3.createFolder(BASE, enc3);
    await cg3.upload(BASE + '/' + enc3, await Vault.encName(K3, 'one.txt'), await Vault.encBlob(K3, new Blob([new TextEncoder().encode('1')])));
    const api3 = makeApi();
    cg3.failRmdir = false;
    const origDelete = cg3.deleteFolder;
    cg3.deleteFolder = async (p, e) => { if (p === BASE && e === enc3) throw new Error('network'); return origDelete(p, e); };
    const res = await DS.shareFolder({ ops: ops3, api: api3, K: K3, parentSegs: [], srcEnc: enc3, name: 'Solo', recipient: 'bob', level: 'edit' });
    ok(res.leftover === true && api3.calls.length === 1, 'if the old copy can’t be removed, the share still goes ahead and says so');
    cg3.deleteFolder = origDelete;
  }

  // ---- add a recipient, then stop sharing ------------------------------------------
  console.log('Adding a recipient and stopping a share');
  {
    const api4 = makeApi();
    const folderCountBefore = [...cg.dirs.keys()].length;
    await DS.addRecipient({ api: api4, root: { root_path: shared.root.rootPath, label_enc: args.labelEnc, share_key: shared.root.rawKey }, recipient: 'carol', level: 'view' });
    const c = api4.calls[0][1];
    ok(c.rootPath === shared.root.rootPath && c.rawKey === shared.root.rawKey && c.recipient === 'carol', 'adding a recipient reuses the same key and folder (no re-key)');
    ok([...cg.dirs.keys()].length === folderCountBefore, 'adding a recipient copies nothing');

    const api5 = makeApi();
    const res = await DS.unshareFolder({
      ops, api: api5, K,
      root: { id: 'root-1', root_path: shared.root.rootPath, label_enc: args.labelEnc, share_key: shared.root.rawKey },
    });
    ok(api5.calls.length === 1 && api5.calls[0][0] === 'unshareRoot' && api5.calls[0][1] === 'root-1', 'stopping a share calls unshare for that root');
    ok(res.leftover === false, 'the S-encrypted copy is removed');
    const back = [...cg.dirs.get(BASE).folders];
    ok(back.length === 1, 'one folder is left at the top');
    const backSegs = [back[0]];
    ok((await Vault.decName(K, back[0])) === 'Photos', 'the folder is back under the owner key');
    ok(DS.keyForDir(backSegs, [], K) === K, 'after stopping, nothing is read with a share key');
    const bl = await cg.browse(BASE + '/' + back[0]);
    const bnames = [];
    for (const f of bl.files) bnames.push(await Vault.decName(K, f.filename));
    ok(bnames.sort().join() === 'a.txt,later.txt', 'the files are back under the owner key');
    let stale = null;
    try { await Vault.decBytes(S, await cg.fetchBytes(bl.files[0].key)); } catch (e) { stale = e; }
    ok(!!stale, 'the old share key can’t read the copied files any more');
    const subList = await cg.browse(BASE + '/' + back[0]);
    ok(subList.folders.length === 1 && (await Vault.decName(K, subList.folders[0])) === 'trip', 'the subfolder is back under the owner key');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
