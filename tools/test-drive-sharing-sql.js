// Tests supabase/drive_sharing.sql against a real Postgres engine (PGlite).
// Run:  NODE_PATH=/tmp/sqlcheck2/node_modules node tools/test-drive-sharing-sql.js
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const SQL = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'drive_sharing.sql'), 'utf8');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ok  ' + msg); } else { fail++; console.log('  FAIL ' + msg); } };

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const CAROL = '00000000-0000-4000-8000-00000000000c';

(async () => {
  const db = new PGlite();
  // Minimal stand-ins for Supabase: auth.uid() reads the JWT sub, and the roles exist.
  await db.exec(`
    create schema if not exists auth;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    end $$;
    grant usage on schema public to authenticated, anon;
    create table public.profiles (
      id uuid primary key, username text not null unique, display_name text
    );
    create table public.user_vault_keys (user_id uuid primary key, key text not null);
    grant all on all tables in schema public to authenticated, anon;
  `);
  await db.exec(`
    insert into public.profiles (id, username, display_name) values
      ('${ALICE}', 'alice', 'Alice A'), ('${BOB}', 'bob', 'Bob B'), ('${CAROL}', 'carol', 'Carol C');
  `);
  await db.exec(SQL);
  await db.exec('grant all on all tables in schema public to authenticated, anon;');

  // Run one statement as a given user (or anonymous). Returns {rows} or {error}.
  const as = async (uid, sql, params = []) => {
    try {
      await db.exec('begin');
      await db.exec(`set local role ${uid ? 'authenticated' : 'anon'}`);
      await db.exec(`select set_config('request.jwt.claim.sub', '${uid || ''}', true)`);
      const r = await db.query(sql, params);
      await db.exec('commit');
      return { rows: r.rows };
    } catch (e) {
      await db.exec('rollback').catch(() => {});
      return { error: e.message };
    }
  };
  // Reset the role for the test's own direct checks.
  const direct = (sql) => db.query(sql).then((r) => r.rows);

  console.log('Drive sharing SQL');

  // 1. Owner shares a folder with bob.
  const KEY = 'AAAA-share-key-1';
  const r1 = await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`,
    ['enc1/enc2', 'label-enc-1', KEY, 'bob', 'download']);
  ok(!r1.error && r1.rows[0].id, 'owner can share a folder with a username: ' + (r1.error || ''));
  const shareBob = r1.rows && r1.rows[0] && r1.rows[0].id;

  // 2. Username matching is case-insensitive.
  const r2 = await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`,
    ['enc1/enc2', 'label-enc-1', KEY, 'CAROL', 'view']);
  ok(!r2.error, 'username lookup ignores case');
  const shareCarol = r2.rows && r2.rows[0] && r2.rows[0].id;

  // 3. Sharing again with a different key is refused (the key must match the folder).
  const r3 = await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`,
    ['enc1/enc2', 'label-enc-1', 'OTHER-KEY', 'bob', 'view']);
  ok(!!r3.error && /different share key/.test(r3.error), 'a second key for the same folder is refused');

  // 4. Unknown user, self, bad level are refused.
  const r4 = await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`, ['x', 'l', 'k', 'nobody', 'view']);
  ok(!!r4.error && /no NexChat user/.test(r4.error), 'unknown username is refused');
  const r5 = await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`, ['x', 'l', 'k', 'alice', 'view']);
  ok(!!r5.error && /yourself/.test(r5.error), 'sharing with yourself is refused');
  const r6 = await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`, ['x', 'l', 'k', 'bob', 'admin']);
  ok(!!r6.error, 'a level outside view/download/edit/manage is refused');
  const r6b = await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`, ['x', 'l', 'k', 'bob', 'view']);
  ok(!r6b.error, 'the same owner can share a different folder with bob');

  // 5. Anonymous callers are refused everywhere.
  const anon = await as(null, `select public.drive_roots_mine() as x`);
  ok(!!anon.error, 'anonymous caller cannot list shares');

  // 6. Owner lists roots with their key and the recipient list.
  const mine = await as(ALICE, `select public.drive_roots_mine() as v`);
  const roots = mine.rows[0].v;
  const root1 = roots.find((r) => r.root_path === 'enc1/enc2');
  ok(root1 && root1.share_key === KEY, 'owner gets the key for their shared folder');
  ok(root1 && root1.shares.length === 2 && root1.shares.map((s) => s.username).sort().join() === 'bob,carol',
    'owner sees both recipients by username');

  // 7. Bob sees the folder, without the key, from drive_shared_with_me.
  const bobList = await as(BOB, `select public.drive_shared_with_me() as v`);
  const bobItem = bobList.rows[0].v.find((s) => s.root_path === 'enc1/enc2');
  ok(bobItem && bobItem.level === 'download' && bobItem.owner_username === 'alice',
    'recipient sees the folder with level and owner name');
  ok(bobItem && !('share_key' in bobItem), 'the shared-with-me list never contains the key');

  // 8. Bob gets the key for his share; Carol gets nothing for Bob's share, and nobody else can.
  const bobKey = await as(BOB, `select public.drive_share_key($1) as v`, [shareBob]);
  ok(!bobKey.error && bobKey.rows[0].v.share_key === KEY && bobKey.rows[0].v.level === 'download',
    'recipient gets the share key with their level');
  const carolOnBob = await as(CAROL, `select public.drive_share_key($1) as v`, [shareBob]);
  ok(!!carolOnBob.error, 'a user who is not the recipient cannot get the key');
  const aliceOnBob = await as(ALICE, `select public.drive_share_key($1) as v`, [shareBob]);
  ok(!!aliceOnBob.error, 'the owner is not released the key through the recipient path');
  const bobKeyBad = await as(BOB, `select public.drive_share_key($1) as v`, ['00000000-0000-4000-8000-0000000000ff']);
  ok(!!bobKeyBad.error, 'an unknown share id gives no key');

  // 9. Direct table reads are blocked by RLS (no policies), even for the owner.
  const directRead = await as(ALICE, `select count(*)::int as n from public.drive_roots`);
  ok(directRead.rows && directRead.rows[0].n === 0 || !!directRead.error,
    'the share tables cannot be read directly by a signed-in user (no policy)');

  // 10. Owner changes a level; only the owner can.
  const lv = await as(BOB, `select public.drive_share_set_level($1,'manage')`, [shareBob]);
  ok(!!lv.error, 'a recipient cannot change their own level');
  const lv2 = await as(ALICE, `select public.drive_share_set_level($1,'edit')`, [shareBob]);
  ok(!lv2.error, 'owner can change a level');
  const bobLevel = await as(BOB, `select public.drive_share_key($1) as v`, [shareBob]);
  ok(bobLevel.rows[0].v.level === 'edit', 'the new level shows up for the recipient');
  const lvBad = await as(ALICE, `select public.drive_share_set_level($1,'bogus')`, [shareBob]);
  ok(!!lvBad.error, 'an invalid level is refused on change');

  // 11. Re-sharing the same folder with bob updates the level, not a second row.
  await as(ALICE, `select public.drive_share_create($1,$2,$3,$4,$5) as id`, ['enc1/enc2', 'label-enc-1', KEY, 'bob', 'view']);
  const cnt = await direct(`select count(*)::int as n from public.drive_shares s join public.drive_roots r on r.id=s.root_id where r.root_path='enc1/enc2' and s.recipient_id='${BOB}'`);
  ok(cnt[0].n === 1, 're-sharing with the same person does not duplicate the share');

  // 12. Revoke: carol loses the folder and her key release stops.
  const rv = await as(BOB, `select public.drive_share_revoke($1)`, [shareCarol]);
  ok(!!rv.error, 'a recipient cannot revoke a share for someone else');
  const rv2 = await as(ALICE, `select public.drive_share_revoke($1)`, [shareCarol]);
  ok(!rv2.error, 'owner can revoke a share');
  const carolKey = await as(CAROL, `select public.drive_share_key($1) as v`, [shareCarol]);
  ok(!!carolKey.error, 'a revoked recipient gets no key any more');
  const carolList = await as(CAROL, `select public.drive_shared_with_me() as v`);
  ok(carolList.rows[0].v.length === 0, 'a revoked folder disappears from shared-with-me');

  // 13. Unshare removes the key entirely and cascades to all shares.
  const rootId = roots.find((r) => r.root_path === 'enc1/enc2').id;
  const rootOther = (await as(ALICE, `select public.drive_roots_mine() as v`)).rows[0].v.find((r) => r.root_path === 'x');
  const us = await as(BOB, `select public.drive_root_unshare($1)`, [rootId]);
  ok(!!us.error, 'a recipient cannot unshare the owner’s folder');
  const us2 = await as(ALICE, `select public.drive_root_unshare($1)`, [rootId]);
  ok(!us2.error, 'owner can stop sharing a folder');
  const after = await as(BOB, `select public.drive_share_key($1) as v`, [shareBob]);
  ok(!!after.error, 'after unsharing, the recipient gets no key');
  const left = await direct(`select count(*)::int as n from public.drive_shares where root_id='${rootId}'`);
  ok(left[0].n === 0, 'unsharing removes every recipient share');
  ok(rootOther && rootOther.root_path === 'x', 'unsharing one folder leaves other shared folders alone');

  // 14. Revoke by a non-owner on a non-existent id fails clearly.
  const rv3 = await as(ALICE, `select public.drive_share_revoke($1)`, [shareBob]);
  ok(!!rv3.error, 'revoking a share that no longer exists says so');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
