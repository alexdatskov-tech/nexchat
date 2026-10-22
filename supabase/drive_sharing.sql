-- =============================================================================
-- NEXCHAT - SHARING MY DRIVE FOLDERS AND FILES
-- Run in Supabase -> SQL Editor AFTER roles_and_powers.sql (it needs profiles and
-- user_vault_keys). Safe to re-run.
--
-- How it works
--   * A shared folder ("root") is re-encrypted under its own share key when it is
--     shared, so the owner's private key never has to leave the owner.
--   * drive_roots holds one share key per shared folder. drive_shares holds one
--     row per recipient and their permission level.
--   * The share key is released ONLY by the functions below, and only to the
--     owner or to a recipient of that folder. The tables have row level security
--     on and NO policies, so nothing can read them directly.
--
-- Levels (stored and checked here): view, download, edit, manage.
--   Reading needs the share key, so every level can read. Edit (upload, rename,
--   delete inside the folder) must be enforced server-side: the write path
--   (an Edge Function that checks drive_shares before it calls storage) is NOT
--   built yet. Until it is, a recipient who has the key could write directly, so
--   do not treat edit or manage as enforced yet.
--
-- Trust note: share keys are stored like user_vault_keys are today - readable by
-- whoever has direct database access, and protected everywhere else by these
-- functions.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.drive_roots (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  root_path  text not null,            -- encrypted folder path under the owner's vault, '/'-joined
  label_enc  text not null,            -- the folder's name, encrypted with the share key
  share_key  text not null,            -- AES-GCM 256 key, base64url
  created_at timestamptz not null default now(),
  unique (owner_id, root_path)
);

create table if not exists public.drive_shares (
  id           uuid primary key default gen_random_uuid(),
  root_id      uuid not null references public.drive_roots(id) on delete cascade,
  owner_id     uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  level        text not null check (level in ('view', 'download', 'edit', 'manage')),
  created_at   timestamptz not null default now(),
  unique (root_id, recipient_id),
  check (owner_id <> recipient_id)
);
create index if not exists drive_shares_recipient_idx on public.drive_shares (recipient_id);

alter table public.drive_roots enable row level security;
alter table public.drive_shares enable row level security;

-- -----------------------------------------------------------------------------
-- 2. Owner functions
-- -----------------------------------------------------------------------------
-- Shares a folder with someone, or changes their level if it is already shared.
-- The folder must already be encrypted under p_key (the client does that first).
create or replace function public.drive_share_create(
  p_root_path text, p_label_enc text, p_key text, p_recipient text, p_level text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_root record; v_to uuid; v_share uuid;
begin
  if v_me is null then raise exception 'sign in first'; end if;
  if p_root_path is null or length(p_root_path) = 0 then raise exception 'choose a folder to share'; end if;
  if p_label_enc is null or p_key is null then raise exception 'the folder is not ready to share yet'; end if;
  if p_level not in ('view', 'download', 'edit', 'manage') then raise exception 'unknown permission level'; end if;

  select p.id into v_to from public.profiles p where lower(p.username) = lower(trim(coalesce(p_recipient, '')));
  if v_to is null then raise exception 'there is no NexChat user called %', p_recipient; end if;
  if v_to = v_me then raise exception 'you can’t share a folder with yourself'; end if;

  select r.id, r.share_key into v_root from public.drive_roots r
  where r.owner_id = v_me and r.root_path = p_root_path;
  if not found then
    insert into public.drive_roots (owner_id, root_path, label_enc, share_key)
    values (v_me, p_root_path, p_label_enc, p_key)
    returning id, share_key into v_root;
  elsif v_root.share_key <> p_key then
    raise exception 'this folder already has a different share key; reload and try again';
  end if;

  insert into public.drive_shares (root_id, owner_id, recipient_id, level)
  values (v_root.id, v_me, v_to, p_level)
  on conflict (root_id, recipient_id) do update set level = excluded.level
  returning id into v_share;
  return v_share;
end $$;

-- The owner's own shared folders, with their key (the owner needs it to write).
create or replace function public.drive_roots_mine()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'root_path', r.root_path,
      'label_enc', r.label_enc,
      'share_key', r.share_key,
      'shares', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', s.id, 'recipient_id', s.recipient_id,
          'username', p.username, 'level', s.level
        ) order by p.username)
        from public.drive_shares s join public.profiles p on p.id = s.recipient_id
        where s.root_id = r.id
      ), '[]'::jsonb)
    ) order by r.created_at)
    from public.drive_roots r where r.owner_id = auth.uid()
  ), '[]'::jsonb);
end $$;

create or replace function public.drive_share_set_level(p_share uuid, p_level text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_level not in ('view', 'download', 'edit', 'manage') then raise exception 'unknown permission level'; end if;
  update public.drive_shares set level = p_level where id = p_share and owner_id = auth.uid();
  if not found then raise exception 'share not found'; end if;
end $$;

create or replace function public.drive_share_revoke(p_share uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  delete from public.drive_shares where id = p_share and owner_id = auth.uid();
  if not found then raise exception 'share not found'; end if;
end $$;

-- Stops sharing a folder altogether. The caller moves the contents back under the
-- owner's key first, so the old share key no longer decrypts anything.
create or replace function public.drive_root_unshare(p_root uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  delete from public.drive_roots where id = p_root and owner_id = auth.uid();
  if not found then raise exception 'shared folder not found'; end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Recipient functions
-- -----------------------------------------------------------------------------
-- Folders shared with me (no keys in the answer).
create or replace function public.drive_shared_with_me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'share_id', s.id,
      'root_id', r.id,
      'owner_id', r.owner_id,
      'owner_username', o.username,
      'owner_display_name', o.display_name,
      'root_path', r.root_path,
      'label_enc', r.label_enc,
      'level', s.level
    ) order by s.created_at desc)
    from public.drive_shares s
    join public.drive_roots r on r.id = s.root_id
    join public.profiles o on o.id = r.owner_id
    where s.recipient_id = auth.uid()
  ), '[]'::jsonb);
end $$;

-- The share key for a folder shared with me. Only the recipient gets it.
create or replace function public.drive_share_key(p_share uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_row record;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select r.owner_id, r.root_path, r.label_enc, r.share_key, s.level into v_row
  from public.drive_shares s join public.drive_roots r on r.id = s.root_id
  where s.id = p_share and s.recipient_id = auth.uid();
  if not found then raise exception 'that folder isn’t shared with you'; end if;
  return jsonb_build_object(
    'owner_id', v_row.owner_id,
    'root_path', v_row.root_path,
    'label_enc', v_row.label_enc,
    'share_key', v_row.share_key,
    'level', v_row.level);
end $$;

-- Grants run last so a failed statement above never leaves them half applied.
revoke all on function public.drive_share_create(text, text, text, text, text) from public, anon;
revoke all on function public.drive_roots_mine() from public, anon;
revoke all on function public.drive_share_set_level(uuid, text) from public, anon;
revoke all on function public.drive_share_revoke(uuid) from public, anon;
revoke all on function public.drive_root_unshare(uuid) from public, anon;
revoke all on function public.drive_shared_with_me() from public, anon;
revoke all on function public.drive_share_key(uuid) from public, anon;
grant execute on function public.drive_share_create(text, text, text, text, text) to authenticated;
grant execute on function public.drive_roots_mine() to authenticated;
grant execute on function public.drive_share_set_level(uuid, text) to authenticated;
grant execute on function public.drive_share_revoke(uuid) to authenticated;
grant execute on function public.drive_root_unshare(uuid) to authenticated;
grant execute on function public.drive_shared_with_me() to authenticated;
grant execute on function public.drive_share_key(uuid) to authenticated;
