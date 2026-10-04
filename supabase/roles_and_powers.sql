-- =============================================================================
-- NEXCHAT - ROLES & POWERS
-- Owner / Sudo Admin / Admin hierarchy, platform-wide moderation for the top
-- two ranks, and the private file vault key table.
--
-- Run once in Supabase -> SQL Editor (after announcements.sql). Safe to re-run.
--
--   rank  role         can
--   ----  -----------  -------------------------------------------------------
--    3    owner        everything; only one owner exists (alexd)
--    2    sudo         same powers as the owner, but cannot touch the owner
--    1    admin        admin panel, bans of normal users, appeals, posts
--    0    (user)
--
-- Rule for every action on another person: your rank must be STRICTLY higher
-- than theirs. So admins can't ban admins, sudo admins can ban admins but not
-- the owner or each other, and the owner can ban anyone.
--
-- Owner + sudo additionally ("super"):
--   * see every server ever created, every member list, every server channel
--     and message, and post in any channel without joining
--   * see which servers any user is in
--   * delete user accounts
--   * set a new password for a user (and sign them out everywhere)
--
-- Deliberately NOT included:
--   * reading anyone's existing password. Supabase stores only a one-way
--     bcrypt hash; the original cannot be recovered, and capturing plaintext
--     passwords would expose users' other accounts.
--   * reading private DMs and group chats.
--   * reading anyone's file vault key (see section 7).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. The role column
-- -----------------------------------------------------------------------------
alter table public.profiles add column if not exists platform_role text;

do $$ begin
  alter table public.profiles add constraint profiles_platform_role_chk
    check (platform_role is null or platform_role in ('admin', 'sudo', 'owner'));
exception when duplicate_object then null; end $$;

-- Exactly one owner, ever.
create unique index if not exists idx_profiles_single_owner
  on public.profiles ((true)) where platform_role = 'owner';

-- Existing admins keep their access as plain admins.
update public.profiles set platform_role = 'admin'
 where is_platform_admin and platform_role is null;


-- -----------------------------------------------------------------------------
-- 2. Rank helpers
-- -----------------------------------------------------------------------------
create or replace function public.nx_rank(p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select coalesce((
    select case p.platform_role
             when 'owner' then 3
             when 'sudo'  then 2
             when 'admin' then 1
             else case when p.is_platform_admin then 1 else 0 end
           end
    from public.profiles p where p.id = p_user), 0);
$$;

-- Owner or sudo admin: the platform-wide moderation powers.
create or replace function public.nx_is_super()
returns boolean language sql stable security definer set search_path = public as $$
  select public.nx_rank(auth.uid()) >= 2;
$$;

-- Keep the older helper (used by announcements.sql) true for every rank.
create or replace function public.nx_is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.nx_rank(auth.uid()) >= 1;
$$;

grant execute on function public.nx_rank(uuid)          to authenticated;
grant execute on function public.nx_is_super()          to authenticated;
grant execute on function public.nx_is_platform_admin() to authenticated;


-- -----------------------------------------------------------------------------
-- 3. Nobody grants themselves a role
--    Extends patch 7's trigger: platform_role, like is_platform_admin, can only
--    change from inside set_user_role(), which flags the transaction.
-- -----------------------------------------------------------------------------
create or replace function public.guard_platform_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.is_platform_admin is distinct from old.is_platform_admin
      or new.platform_role is distinct from old.platform_role)
     and coalesce(current_setting('nexchat.admin_grant', true), '') <> 'on' then
    raise exception 'roles can only be changed with set_user_role()';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_platform_admin on public.profiles;
create trigger trg_guard_platform_admin
  before update on public.profiles
  for each row execute function public.guard_platform_admin();

alter table public.admin_grants add column if not exists role text;


-- -----------------------------------------------------------------------------
-- 4. Make alexd the owner
--    Runs through the same flag the functions use, so the guard allows it.
-- -----------------------------------------------------------------------------
do $$
begin
  perform set_config('nexchat.admin_grant', 'on', true);
  update public.profiles set platform_role = 'admin'
   where platform_role = 'owner' and lower(username) <> 'alexd';
  update public.profiles set platform_role = 'owner', is_platform_admin = true
   where lower(username) = 'alexd';
  perform set_config('nexchat.admin_grant', 'off', true);
end $$;


-- -----------------------------------------------------------------------------
-- 5. Role changes
--    You can only change someone ranked below you, and only to a rank below
--    yours: sudo/owner manage admins, only the owner manages sudo admins.
--    The owner role itself is never handed out here.
-- -----------------------------------------------------------------------------
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_me     int := public.nx_rank(auth.uid());
  v_them   int := public.nx_rank(p_user_id);
  v_role   text := nullif(lower(trim(coalesce(p_role, ''))), 'user');
  v_new    int;
begin
  if v_me < 1 then raise exception 'not authorised'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'no such user'; end if;
  if p_user_id = auth.uid() then raise exception 'you cannot change your own role'; end if;
  if v_role is not null and v_role not in ('admin', 'sudo') then raise exception 'unknown role'; end if;
  v_new := case v_role when 'sudo' then 2 when 'admin' then 1 else 0 end;
  if v_them >= v_me then raise exception 'you can only change people ranked below you'; end if;
  if v_new  >= v_me then raise exception 'you can only grant roles below your own'; end if;

  perform set_config('nexchat.admin_grant', 'on', true);
  update public.profiles set platform_role = v_role, is_platform_admin = (v_role is not null)
   where id = p_user_id;
  perform set_config('nexchat.admin_grant', 'off', true);

  insert into public.admin_grants (user_id, granted, actor_id, role)
  values (p_user_id, v_role is not null, auth.uid(), coalesce(v_role, 'user'));
end;
$$;
revoke all on function public.set_user_role(uuid, text) from public;
grant execute on function public.set_user_role(uuid, text) to authenticated;

-- The old entry point, kept for older clients, now follows the same rules.
create or replace function public.set_user_admin(p_user_id uuid, p_admin boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.set_user_role(p_user_id, case when p_admin then 'admin' else 'user' end);
end;
$$;
revoke all on function public.set_user_admin(uuid, boolean) from public;
grant execute on function public.set_user_admin(uuid, boolean) to authenticated;


-- -----------------------------------------------------------------------------
-- 6. Bans follow the hierarchy
--    The existing set_user_ban (from the original schema) is kept as
--    set_user_ban_base so whatever it already does still happens; the new
--    set_user_ban checks rank first.
-- -----------------------------------------------------------------------------
do $$ begin
  if to_regprocedure('public.set_user_ban_base(uuid,boolean,text)') is null then
    if to_regprocedure('public.set_user_ban(uuid,boolean,text)') is not null then
      alter function public.set_user_ban(uuid, boolean, text) rename to set_user_ban_base;
    else
      execute $f$
        create function public.set_user_ban_base(p_user_id uuid, p_banned boolean, p_reason text default null)
        returns void language plpgsql security definer set search_path = public as $b$
        begin
          update public.profiles
             set is_banned = p_banned, ban_reason = case when p_banned then p_reason else null end
           where id = p_user_id;
        end; $b$;
      $f$;
    end if;
  end if;
end $$;
revoke all on function public.set_user_ban_base(uuid, boolean, text) from public, anon, authenticated;

create or replace function public.set_user_ban(p_user_id uuid, p_banned boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.nx_rank(auth.uid()) < 1 then raise exception 'not authorised'; end if;
  if p_user_id = auth.uid() then raise exception 'you cannot ban yourself'; end if;
  if public.nx_rank(p_user_id) >= public.nx_rank(auth.uid()) then
    raise exception 'you can only ban people ranked below you';
  end if;
  perform public.set_user_ban_base(p_user_id, p_banned, p_reason);
end;
$$;
revoke all on function public.set_user_ban(uuid, boolean, text) from public;
grant execute on function public.set_user_ban(uuid, boolean, text) to authenticated;


-- -----------------------------------------------------------------------------
-- 7. Owner / sudo account tools
-- -----------------------------------------------------------------------------

-- Delete an account. auth.users cascades to profiles and everything that
-- references it (the same path delete_my_account() relies on).
create or replace function public.admin_delete_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_is_super() then raise exception 'not authorised'; end if;
  if p_user_id = auth.uid() then raise exception 'use account settings to delete your own account'; end if;
  if public.nx_rank(p_user_id) >= public.nx_rank(auth.uid()) then
    raise exception 'you can only delete people ranked below you';
  end if;
  delete from auth.users where id = p_user_id;
end;
$$;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- Set a new password and end every existing session. The old password is
-- never read (it cannot be: only its bcrypt hash exists).
create or replace function public.admin_set_password(p_user_id uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.nx_is_super() then raise exception 'not authorised'; end if;
  if p_user_id = auth.uid() then raise exception 'change your own password from account settings'; end if;
  if public.nx_rank(p_user_id) >= public.nx_rank(auth.uid()) then
    raise exception 'you can only reset people ranked below you';
  end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'password must be at least 8 characters'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = p_user_id;
  if not found then raise exception 'no such user'; end if;
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;
end;
$$;
revoke all on function public.admin_set_password(uuid, text) from public, anon;
grant execute on function public.admin_set_password(uuid, text) to authenticated;

-- Sign-in metadata for the user drawer (no secrets).
create or replace function public.admin_user_auth(p_user_id uuid)
returns table (created_at timestamptz, last_sign_in_at timestamptz, sessions bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.nx_is_super() then raise exception 'not authorised'; end if;
  return query
    select u.created_at, u.last_sign_in_at,
           (select count(*) from auth.sessions s where s.user_id = u.id)
      from auth.users u where u.id = p_user_id;
end;
$$;
revoke all on function public.admin_user_auth(uuid) from public, anon;
grant execute on function public.admin_user_auth(uuid) to authenticated;


-- -----------------------------------------------------------------------------
-- 8. Owner / sudo can see and post in every server without joining
--    Permissive policies are OR'ed with the existing ones, so members keep
--    exactly the access they had. DMs are intentionally left out.
-- -----------------------------------------------------------------------------
drop policy if exists "nx_super_servers_select" on public.servers;
create policy "nx_super_servers_select" on public.servers for select using (public.nx_is_super());

drop policy if exists "nx_super_members_select" on public.server_members;
create policy "nx_super_members_select" on public.server_members for select using (public.nx_is_super());

drop policy if exists "nx_super_channels_select" on public.channels;
create policy "nx_super_channels_select" on public.channels for select using (public.nx_is_super());

drop policy if exists "nx_super_roles_select" on public.roles;
create policy "nx_super_roles_select" on public.roles for select using (public.nx_is_super());

drop policy if exists "nx_super_member_roles_select" on public.member_roles;
create policy "nx_super_member_roles_select" on public.member_roles for select using (public.nx_is_super());

drop policy if exists "nx_super_messages_select" on public.messages;
create policy "nx_super_messages_select" on public.messages for select using (public.nx_is_super());

drop policy if exists "nx_super_messages_insert" on public.messages;
create policy "nx_super_messages_insert" on public.messages for insert
  with check (author_id = auth.uid() and public.nx_is_super());

drop policy if exists "nx_super_messages_delete" on public.messages;
create policy "nx_super_messages_delete" on public.messages for delete using (public.nx_is_super());

drop policy if exists "nx_super_attachments_select" on public.message_attachments;
create policy "nx_super_attachments_select" on public.message_attachments for select using (public.nx_is_super());

drop policy if exists "nx_super_attachments_insert" on public.message_attachments;
create policy "nx_super_attachments_insert" on public.message_attachments for insert
  with check (public.nx_is_super()
              and exists (select 1 from public.messages m where m.id = message_attachments.message_id and m.author_id = auth.uid()));

drop policy if exists "nx_super_reactions_select" on public.message_reactions;
create policy "nx_super_reactions_select" on public.message_reactions for select using (public.nx_is_super());

drop policy if exists "nx_super_reactions_insert" on public.message_reactions;
create policy "nx_super_reactions_insert" on public.message_reactions for insert
  with check (user_id = auth.uid() and public.nx_is_super());


-- -----------------------------------------------------------------------------
-- 9. Private file vault keys
--    One random AES key per user, used in the browser to encrypt their files
--    before they leave the device. Readable by that user only -- not even the
--    owner or sudo admins get a policy here.
-- -----------------------------------------------------------------------------
create table if not exists public.user_vault_keys (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  key        text not null,
  created_at timestamptz not null default now()
);
alter table public.user_vault_keys enable row level security;
revoke all on public.user_vault_keys from anon;
grant select, insert on public.user_vault_keys to authenticated;

drop policy if exists "vault_keys_select_own" on public.user_vault_keys;
create policy "vault_keys_select_own" on public.user_vault_keys for select using (user_id = auth.uid());

drop policy if exists "vault_keys_insert_own" on public.user_vault_keys;
create policy "vault_keys_insert_own" on public.user_vault_keys for insert with check (user_id = auth.uid());
-- No update/delete policy: a key is never swapped out from under its files.


-- -----------------------------------------------------------------------------
-- Verification -- runs last; if it doesn't appear, the paste was truncated.
-- -----------------------------------------------------------------------------
select
  (select username from public.profiles where platform_role = 'owner')            as owner,
  (select count(*) from public.profiles where platform_role = 'sudo')             as sudo_admins,
  (select count(*) from public.profiles where platform_role = 'admin')            as admins,
  to_regprocedure('public.set_user_ban_base(uuid,boolean,text)') is not null      as ban_wrapped,
  to_regprocedure('public.admin_delete_user(uuid)') is not null                   as delete_fn,
  to_regprocedure('public.admin_set_password(uuid,text)') is not null             as password_fn,
  to_regclass('public.user_vault_keys') is not null                               as vault_table;
