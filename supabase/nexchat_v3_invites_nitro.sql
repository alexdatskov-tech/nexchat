-- NexChat: custom invite codes + staff-given Nitro (one script).
-- Paste it all into the Supabase SQL editor and run it. It runs as one
-- transaction: everything applies, or nothing does. Safe to run more than once.
--
-- Part 1, invites
--  * A random code is always made by the database (8 characters). Only the
--    server owner, someone with Manage Server, or platform staff can choose
--    one: 3 to 32 letters, numbers or dashes, stored lower-case.
--  * Custom invites can be edited (code, expiry, max uses) by the same people.
--  * Joining checks expiry, max uses and bans, and counts the use.
--
-- Part 2, Nitro
--  * Staff (owner, sudo admins, admins) give or take Nitro from the admin
--    panel, no request needed.
--  * Closes a hole: anyone could switch on their own Nitro, or lift their own
--    ban, by editing their profile row.

begin;

-- =========================================================== part 1: invites
alter table public.invites add column if not exists custom boolean not null default false;

-- 1. what a new or edited invite may contain
create or replace function public.nx_invite_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  if tg_op = 'UPDATE' then
    -- only the code, expiry and max uses of a custom invite change; a use is
    -- counted by join_server_by_invite alone
    new.id := old.id; new.server_id := old.server_id; new.created_by := old.created_by;
    new.custom := old.custom; new.created_at := old.created_at;
    if coalesce(current_setting('nx.invite_use', true), '') <> '1' then new.uses := old.uses; end if;
    if not old.custom then new.code := old.code; end if;
  else
    new.uses := 0;
  end if;

  if new.custom then
    if tg_op = 'INSERT' or new.code is distinct from old.code then
      select owner_id into v_owner from public.servers where id = new.server_id;
      if not (v_owner = auth.uid() or public.has_permission(new.server_id, auth.uid(), 128) or public.nx_can('view_all_servers')) then
        raise exception 'Only the server owner (or someone with Manage Server) can choose an invite code.' using errcode = '42501';
      end if;
      new.code := lower(trim(new.code));
      if new.code !~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' then
        raise exception 'An invite code is 3 to 32 letters, numbers or dashes (not at the start or end).' using errcode = '22023';
      end if;
    end if;
  elsif tg_op = 'INSERT' then
    new.code := substr(md5(gen_random_uuid()::text), 1, 8);
  end if;

  if new.max_uses is not null and new.max_uses < 1 then new.max_uses := null; end if;
  return new;
end $$;

drop trigger if exists invites_guard on public.invites;
create trigger invites_guard before insert or update on public.invites
  for each row execute function public.nx_invite_guard();

-- 2. editing custom invites
drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (custom and (
    exists (select 1 from public.servers s where s.id = server_id and s.owner_id = auth.uid())
    or public.has_permission(server_id, auth.uid(), 128) or public.nx_can('view_all_servers')))
  with check (custom);

-- 3. is a code still free? (the create form checks while you type)
create or replace function public.nx_invite_code_free(p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.invites where code = lower(trim(p_code)));
$$;
revoke all on function public.nx_invite_code_free(text) from public, anon;
grant execute on function public.nx_invite_code_free(text) to authenticated;

-- 4. joining: expiry, max uses and bans checked, the use counted
create or replace function public.join_server_by_invite(p_code text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v public.invites%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;

  select * into v from public.invites where code = lower(trim(p_code)) for update;
  if not found then select * into v from public.invites where code = trim(p_code) for update; end if;
  if not found then raise exception 'That invite code does not exist.'; end if;

  if exists (select 1 from public.server_members where server_id = v.server_id and user_id = auth.uid()) then
    return v.server_id;   -- already in: nothing to use up
  end if;
  if v.expires_at is not null and v.expires_at < now() then raise exception 'That invite has expired.'; end if;
  if v.max_uses is not null and v.uses >= v.max_uses then raise exception 'That invite has been used up.'; end if;
  if exists (select 1 from public.server_bans where server_id = v.server_id and user_id = auth.uid()) then
    raise exception 'You are banned from this server.';
  end if;

  insert into public.server_members (server_id, user_id) values (v.server_id, auth.uid()) on conflict do nothing;
  perform set_config('nx.invite_use', '1', true);
  update public.invites set uses = uses + 1 where id = v.id;
  perform set_config('nx.invite_use', '', true);
  return v.server_id;
end $$;

-- ============================================================ part 2: Nitro
-- 1. Nitro and bans can't be changed by editing a profile from the app. The
--    database's own functions (approving a request, set_user_ban, this file's
--    admin_set_nitro) run as the owner, so they still can. Deliberately NOT
--    security definer: current_user has to be whoever made the change.
create or replace function public.nx_guard_profile_privileges() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.is_nitro := false; new.nitro_since := null; new.is_banned := false; new.ban_reason := null;
  elsif new.is_nitro is distinct from old.is_nitro or new.nitro_since is distinct from old.nitro_since
     or new.is_banned is distinct from old.is_banned or new.ban_reason is distinct from old.ban_reason then
    raise exception 'Nitro and bans are changed by NexChat staff only.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_profile_privileges on public.profiles;
create trigger trg_guard_profile_privileges before insert or update on public.profiles
  for each row execute function public.nx_guard_profile_privileges();

-- 2. give or take Nitro (any staff rank). Giving it also approves a pending request.
create or replace function public.admin_set_nitro(p_user_id uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_was boolean;
begin
  if public.nx_rank(auth.uid()) < 1 then
    raise exception 'Only NexChat staff can give Nitro.' using errcode = '42501';
  end if;
  select is_nitro into v_was from public.profiles where id = p_user_id;
  if not found then raise exception 'That user doesn''t exist.'; end if;

  update public.profiles
     set is_nitro = p_on, nitro_since = case when p_on then coalesce(nitro_since, now()) else null end
   where id = p_user_id;
  if p_on then
    update public.nitro_requests
       set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = coalesce(review_note, 'Given by staff')
     where user_id = p_user_id and status = 'pending';
  end if;

  if v_was is distinct from p_on then
    perform public.nx_audit(case when p_on then 'nitro_given' else 'nitro_removed' end, p_user_id, '{}'::jsonb);
  end if;
end $$;

revoke all on function public.admin_set_nitro(uuid, boolean) from public, anon;
grant execute on function public.admin_set_nitro(uuid, boolean) to authenticated;

commit;
