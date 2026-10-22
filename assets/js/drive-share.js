/* ---------------------------------------------------------------------------
   NexChat drive sharing: the key logic behind "share a folder from My Drive".

   Every drive item is encrypted with the owner's key K (Vault.key). When a folder
   is shared, its contents are copied into a new folder encrypted with a random
   share key S, so a recipient can read it without ever receiving K.

     - keyForDir(segs, roots, K): which key a folder's contents use. A folder
       inside a shared root uses that root's S; everything else uses K.
     - moveFolder(...): copy a folder's tree from one key to another, into a new
       folder at the same place. The old folder is removed only by the caller,
       after the new one is complete. If the copy fails, the new folder is removed
       and the old one is left untouched.
     - shareFolder / unshareFolder / addRecipient: the three user actions. They
       call the database functions in supabase/drive_sharing.sql through `api`.

   Storage and database calls are passed in (`ops`, `api`) so the same code runs
   in the browser (cloudOps / dbApi below) and in tools/test-drive-share.js.

   Known limits (tell the user, not just in code):
     - "View" and "download" can't be separated cryptographically. Anyone who
       can read the folder can save a decrypted copy.
     - Revoking only stops future key release. Stop sharing re-keys the folder
       back to K, which makes the old share key useless for new copies, but a
       recipient may already hold copies they downloaded.
   --------------------------------------------------------------------------- */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DriveShare = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Looked up on each call: vault.js may load after this file.
  const V = () => (typeof window !== 'undefined' && window.Vault) || (typeof globalThis !== 'undefined' && globalThis.Vault) || null;

  class LockedItemError extends Error {
    constructor(name) {
      super(`“${name || 'An item'}” inside this folder can’t be read with the current key, so the folder can’t be shared yet.`);
      this.name = 'LockedItemError';
    }
  }

  // Which key a folder's contents are encrypted with.
  // roots: [{ path: 'enc1/enc2', key: CryptoKey }] (path = encrypted folder names
  // from the owner's vault root, '/'-joined). The longest matching root wins.
  function keyForDir(dirSegs, roots, baseKey) {
    const p = (dirSegs || []).join('/');
    let best = null;
    for (const r of roots || []) {
      if (p === r.path || p.startsWith(r.path + '/')) {
        if (!best || r.path.length > best.path.length) best = r;
      }
    }
    return best ? best.key : baseKey;
  }

  // Copies everything directly in src (and below) into dst. src/dst: { segs, key }.
  async function copyTree(ops, src, dst) {
    const listing = await ops.list(src.segs);
    for (const f of listing.files || []) {
      const name = await V().decName(src.key, f.filename);
      if (!name) throw new LockedItemError(null);
      const bytes = await ops.read(f.key);
      const plain = await V().decBytes(src.key, bytes);
      const blob = await V().encBlob(dst.key, new Blob([plain], { type: 'application/octet-stream' }));
      await ops.upload(dst.segs, await V().encName(dst.key, name), blob);
    }
    for (const folderEnc of listing.folders || []) {
      const name = await V().decName(src.key, folderEnc);
      if (!name) throw new LockedItemError(null);
      const newEnc = await V().encName(dst.key, name);
      await ops.mkdir(dst.segs, newEnc);
      await copyTree(ops, { segs: [...src.segs, folderEnc], key: src.key }, { segs: [...dst.segs, newEnc], key: dst.key });
    }
  }

  // Copies the folder at srcSegs (encrypted with srcKey) into a new folder named
  // `name` under parentSegs, encrypted with dstKey. Returns the new folder's segs.
  async function moveFolder({ ops, parentSegs, srcSegs, srcKey, dstKey, name }) {
    const newEnc = await V().encName(dstKey, name);
    await ops.mkdir(parentSegs, newEnc);
    const dstSegs = [...parentSegs, newEnc];
    try {
      await copyTree(ops, { segs: srcSegs, key: srcKey }, { segs: dstSegs, key: dstKey });
    } catch (err) {
      await ops.rmdir(parentSegs, newEnc).catch(() => {}); // best effort; the original is untouched
      throw err;
    }
    return dstSegs;
  }

  // Shares the folder `name` (encrypted name srcEnc, under parentSegs) with one person.
  // Returns { root, leftover }. leftover is true when the old copy could not be removed;
  // the share still works, and the owner can delete the old folder by hand.
  async function shareFolder({ ops, api, K, parentSegs, srcEnc, name, recipient, level }) {
    const S = await V().newRawKey();
    const srcSegs = [...parentSegs, srcEnc];
    const newSegs = await moveFolder({ ops, parentSegs, srcSegs, srcKey: K, dstKey: S.key, name });
    const newEnc = newSegs[newSegs.length - 1];
    const rootPath = newSegs.join('/');
    try {
      await api.createRoot({
        rootPath,
        labelEnc: await V().encName(S.key, name),
        rawKey: S.raw,
        recipient,
        level,
      });
    } catch (err) {
      await ops.rmdir(parentSegs, newEnc).catch(() => {});
      throw err;
    }
    let leftover = false;
    try { await ops.rmdir(parentSegs, srcEnc); } catch { leftover = true; }
    return { root: { rootPath, rawKey: S.raw }, leftover };
  }

  // Gives another person access to a folder that is already shared (no re-key).
  async function addRecipient({ api, root, recipient, level }) {
    return api.createRoot({
      rootPath: root.root_path,
      labelEnc: root.label_enc,
      rawKey: root.share_key,
      recipient,
      level,
    });
  }

  // Stops sharing a folder. root: a row from drive_roots_mine() (root_path, label_enc, share_key, id).
  // Copies it back under K first, then removes the share, then removes the old copy.
  async function unshareFolder({ ops, api, K, root }) {
    const S = await V().importRaw(root.share_key);
    const rootSegs = root.root_path.split('/');
    const parentSegs = rootSegs.slice(0, -1);
    const srcEnc = rootSegs[rootSegs.length - 1];
    const name = await V().decName(S, root.label_enc);
    if (!name) throw new Error('This shared folder’s name can’t be read, so it can’t be unshared right now.');
    const newSegs = await moveFolder({ ops, parentSegs, srcSegs: rootSegs, srcKey: S, dstKey: K, name });
    await api.unshareRoot(root.id);
    let leftover = false;
    try { await ops.rmdir(parentSegs, srcEnc); } catch { leftover = true; }
    return { rootPath: newSegs.join('/'), leftover };
  }

  // Storage operations for the real drive. base: the owner's vault root path ('vault/<id>').
  function cloudOps(CloudGate, base) {
    const dir = (segs) => [base, ...segs].join('/');
    return {
      list: async (segs) => {
        const r = await CloudGate.browse(dir(segs));
        return { folders: r.folders || [], files: (r.files || []).map((f) => ({ key: f.key, filename: f.filename })) };
      },
      mkdir: (segs, enc) => CloudGate.createFolder(dir(segs), enc),
      rmdir: (segs, enc) => CloudGate.deleteFolder(dir(segs), enc),
      read: (key) => CloudGate.fetchBytes(key),
      upload: (segs, enc, blob) => CloudGate.upload(dir(segs), enc, blob),
    };
  }

  // Database calls for the real app (window.db is the Supabase client).
  function dbApi(db) {
    const rpc = async (fn, args) => {
      const { data, error } = await db.rpc(fn, args);
      if (error) throw new Error(error.message || 'Something went wrong.');
      return data;
    };
    return {
      createRoot: ({ rootPath, labelEnc, rawKey, recipient, level }) => rpc('drive_share_create', {
        p_root_path: rootPath, p_label_enc: labelEnc, p_key: rawKey, p_recipient: recipient, p_level: level,
      }),
      unshareRoot: (id) => rpc('drive_root_unshare', { p_root: id }),
      setLevel: (shareId, level) => rpc('drive_share_set_level', { p_share: shareId, p_level: level }),
      revoke: (shareId) => rpc('drive_share_revoke', { p_share: shareId }),
      myRoots: () => rpc('drive_roots_mine', {}),
      sharedWithMe: () => rpc('drive_shared_with_me', {}),
      shareKey: (shareId) => rpc('drive_share_key', { p_share: shareId }),
    };
  }

  return {
    LockedItemError, keyForDir, moveFolder, shareFolder, addRecipient, unshareFolder, cloudOps, dbApi,
  };
});
