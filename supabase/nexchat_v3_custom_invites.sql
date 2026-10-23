-- NexChat: custom invite codes, and invites that really honour "max uses".
-- Safe to run more than once.
--
--  * A random code is always made by the database (8 characters). Only the
--    server owner, someone with Manage Server, or platform staff can choose
--    one: 3 to 32 letters, numbers or dashes, stored lower-case.
--  * Custom invites can be edited (code, expiry, max uses) by the same people.
--  * Joining checks expiry, max uses and bans, and counts the use.

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
