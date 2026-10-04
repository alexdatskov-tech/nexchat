/* Vault: client-side encryption for each user's private drive.

   Every user has one random 256-bit AES key, stored in
   public.user_vault_keys under a row-level policy that lets only that user
   read it (not even the owner/sudo admins have a policy). Files and file /
   folder names are encrypted with AES-GCM in the browser before they reach
   CloudGate, so the bucket -- which anyone holding the shared API login can
   list -- only ever sees ciphertext.

   File format:   "NXV1" | iv (12 bytes) | AES-GCM ciphertext + tag (16)
   Name format:   "n1." + base64url(iv | ciphertext + tag)                  */
window.Vault = (function () {
  const MAGIC = new Uint8Array([0x4e, 0x58, 0x56, 0x31]); // NXV1
  const OVERHEAD = MAGIC.length + 12 + 16;
  const te = new TextEncoder(), td = new TextDecoder();
  let keyP = null, keyUser = null;

  const b64u = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64u = (s) => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out;
  };
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  /* Fetch (or create, on first use) the user's key. */
  function key(userId) {
    if (keyP && keyUser === userId) return keyP;
    keyUser = userId;
    keyP = (async () => {
      const read = () => window.db.from('user_vault_keys').select('key').eq('user_id', userId).maybeSingle();
      let { data, error } = await read();
      if (error) {
        if (/does not exist|schema cache|PGRST205/i.test(error.message || '') || error.code === 'PGRST205' || error.code === '42P01') {
          throw Object.assign(new Error('The drive isn’t set up yet. Run supabase/roles_and_powers.sql in Supabase.'), { setup: true });
        }
        throw error;
      }
      if (!data) {
        const ins = await window.db.from('user_vault_keys').insert({ user_id: userId, key: b64u(rand(32)) });
        // Another tab may have created it a moment earlier; theirs wins.
        if (ins.error && !/duplicate|unique/i.test(ins.error.message || '')) throw ins.error;
        ({ data, error } = await read());
        if (error || !data) throw error || new Error('Could not create your drive key.');
      }
      return crypto.subtle.importKey('raw', unb64u(data.key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    })();
    keyP.catch(() => { keyP = null; });
    return keyP;
  }

  async function encName(k, name) {
    const iv = rand(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, te.encode(name)));
    const all = new Uint8Array(12 + ct.length); all.set(iv); all.set(ct, 12);
    return 'n1.' + b64u(all);
  }

  // null when the name isn't ours (not encrypted, or a different key).
  async function decName(k, enc) {
    if (!enc || !enc.startsWith('n1.')) return null;
    try {
      const all = unb64u(enc.slice(3));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.subarray(0, 12) }, k, all.subarray(12));
      return td.decode(pt);
    } catch { return null; }
  }

  async function encBlob(k, blob) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, await blob.arrayBuffer());
    return new Blob([MAGIC, iv, ct], { type: 'application/octet-stream' });
  }

  async function decBytes(k, buf) {
    const u = new Uint8Array(buf);
    if (u.length < OVERHEAD || MAGIC.some((b, i) => u[i] !== b)) throw new Error('This file isn’t encrypted with your key.');
    try {
      return await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(4, 16) }, k, u.subarray(16));
    } catch { throw new Error('This file couldn’t be decrypted. It may be damaged.'); }
  }

  const plainSize = (stored) => Math.max(0, stored - OVERHEAD);

  return { key, encName, decName, encBlob, decBytes, plainSize, OVERHEAD };
})();
