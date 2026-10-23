-- NexChat two-way sync between the cloud project and the self-hosted copy.
--
-- Install the same file on both databases. Every insert, update and delete on
-- the app's tables (public.* plus auth.users and auth.identities) is queued in
-- nx_sync.changes. The worker (tools/nx-sync/sync.py) pulls each side's queue
-- with nx_sync_pull, applies it to the other side with nx_sync_apply, then
-- removes what it applied with nx_sync_ack. Rows written by nx_sync_apply are
-- not queued again, so nothing loops. All of these need the shared secret;
-- only its SHA-256 is stored here:
--   insert into nx_sync.config values ('secret_sha256', '<hex>')
--     on conflict (k) do update set v = excluded.v;
-- Schema changes (DDL) are not synced: run migrations on both sides, then run
-- this file again so new tables get their capture trigger.

create schema if not exists nx_sync;
revoke all on schema nx_sync from public, anon, authenticated;

create table if not exists nx_sync.config (k text primary key, v text not null);
create table if not exists nx_sync.changes (
  id bigserial primary key,
  at timestamptz not null default now(),
  tbl text not null,
  op text not null check (op in ('U', 'D')),
  pk jsonb not null,
  "row" jsonb
);
create table if not exists nx_sync.failed (
  id bigserial primary key,
  at timestamptz not null default now(),
  change jsonb not null,
  error text,
  tries int not null default 1
);
revoke all on all tables in schema nx_sync from public, anon, authenticated;
revoke all on all sequences in schema nx_sync from public, anon, authenticated;

create or replace function nx_sync.check_secret(p text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
     is distinct from (select v from nx_sync.config where k = 'secret_sha256') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
end $$;

-- Row trigger. TG_ARGV holds the table's primary key columns.
create or replace function nx_sync.capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  c text;
  k jsonb := '{}';
  ok jsonb := '{}';
  r jsonb;
  o jsonb;
  t text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
begin
  if coalesce(current_setting('nx_sync.applying', true), '') = 'on' then
    return null;
  end if;
  if TG_OP <> 'INSERT' then o := to_jsonb(OLD); end if;
  if TG_OP <> 'DELETE' then r := to_jsonb(NEW); end if;
  foreach c in array TG_ARGV loop
    if r is not null then k := k || jsonb_build_object(c, r -> c); end if;
    if o is not null then ok := ok || jsonb_build_object(c, o -> c); end if;
  end loop;
  if TG_OP = 'DELETE' or (TG_OP = 'UPDATE' and ok <> k) then
    insert into nx_sync.changes (tbl, op, pk) values (t, 'D', ok);
  end if;
  if TG_OP <> 'DELETE' then
    insert into nx_sync.changes (tbl, op, pk, "row") values (t, 'U', k, r);
  end if;
  return null;
end $$;

create or replace function nx_sync.apply_one(ch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t regclass := (ch ->> 'tbl')::regclass;
  pkc text;
  cols text;
  upd text;
begin
  select string_agg(quote_ident(key), ',') into pkc from jsonb_object_keys(ch -> 'pk') key;
  if ch ->> 'op' = 'D' then
    execute format('delete from %s where (%s) = (select %s from jsonb_populate_record(null::%s, $1))',
                   t, pkc, pkc, t) using ch -> 'pk';
    return;
  end if;
  select string_agg(quote_ident(attname), ',' order by attnum),
         string_agg(format('%I = excluded.%I', attname, attname), ',' order by attnum)
           filter (where not (ch -> 'pk') ? attname)
    into cols, upd
    from pg_attribute
   where attrelid = t and attnum > 0 and not attisdropped and attgenerated = ''
     and (ch -> 'row') ? attname;
  execute format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, $1) on conflict (%s) do %s',
                 t, cols, cols, t, pkc, coalesce('update set ' || upd, 'nothing')) using ch -> 'row';
end $$;

create or replace function public.nx_sync_pull(p_secret text, p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform nx_sync.check_secret(p_secret);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'tbl', tbl, 'op', op, 'pk', pk, 'row', "row") order by id)
                     from (select * from nx_sync.changes order by id limit least(greatest(p_limit, 1), 1000)) c), '[]');
end $$;

create or replace function public.nx_sync_ack(p_secret text, p_ids bigint[]) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform nx_sync.check_secret(p_secret);
  delete from nx_sync.changes where id = any (p_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- Applies changes in order. One that fails (say a foreign key whose parent
-- comes later in the batch) is retried after the rest; whatever still fails is
-- kept in nx_sync.failed and tried again on later calls, up to 20 times.
create or replace function public.nx_sync_apply(p_secret text, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  todo jsonb := coalesce(p_changes, '[]');
  failed jsonb;
  ch jsonb;
  done int := 0;
  pass int;
begin
  perform nx_sync.check_secret(p_secret);
  perform set_config('nx_sync.applying', 'on', true);
  -- Guard triggers that read the caller's role see the service role.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  with old as (delete from nx_sync.failed where id in (select id from nx_sync.failed where tries < 20 order by id limit 100)
               returning change || jsonb_build_object('_tries', tries) c, id)
  select todo || coalesce(jsonb_agg(c order by id), '[]') into todo from old;
  for pass in 1..3 loop
    failed := '[]';
    for ch in select * from jsonb_array_elements(todo) loop
      begin
        perform nx_sync.apply_one(ch);
        done := done + 1;
      exception when others then
        failed := failed || jsonb_build_array(ch || jsonb_build_object('_error', sqlerrm));
      end;
    end loop;
    exit when jsonb_array_length(failed) = 0;
    todo := failed;
  end loop;
  insert into nx_sync.failed (change, error, tries)
  select f - '_error' - '_tries', f ->> '_error', coalesce((f ->> '_tries')::int, 0) + 1
    from jsonb_array_elements(failed) f;
  return jsonb_build_object('applied', done, 'failed', jsonb_array_length(failed));
end $$;

create or replace function public.nx_sync_status(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform nx_sync.check_secret(p_secret);
  return jsonb_build_object(
    'queued', (select count(*) from nx_sync.changes),
    'oldest', (select min(at) from nx_sync.changes),
    'failed', (select count(*) from nx_sync.failed),
    'last_error', (select error from nx_sync.failed order by id desc limit 1));
end $$;

revoke all on function nx_sync.check_secret(text), nx_sync.capture(), nx_sync.apply_one(jsonb) from public, anon, authenticated;
revoke all on function public.nx_sync_pull(text, int), public.nx_sync_ack(text, bigint[]),
  public.nx_sync_apply(text, jsonb), public.nx_sync_status(text) from public, anon, authenticated;
grant execute on function public.nx_sync_pull(text, int), public.nx_sync_ack(text, bigint[]),
  public.nx_sync_apply(text, jsonb), public.nx_sync_status(text) to anon, service_role;

-- A capture trigger on every app table (and the two auth tables).
do $$
declare
  r record;
begin
  for r in
    select c.oid::regclass t,
           (select string_agg(quote_literal(a.attname), ',' order by k.ord)
              from pg_constraint co, unnest(co.conkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
             where co.conrelid = c.oid and co.contype = 'p') pk
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r'
       and (n.nspname = 'public' or c.oid in ('auth.users'::regclass, 'auth.identities'::regclass))
  loop
    if r.pk is null then
      raise notice 'nx_sync: % has no primary key, not synced', r.t;
      continue;
    end if;
    execute format('drop trigger if exists nx_sync_capture on %s', r.t);
    execute format('create trigger nx_sync_capture after insert or update or delete on %s '
                   'for each row execute function nx_sync.capture(%s)', r.t, r.pk);
  end loop;
end $$;
