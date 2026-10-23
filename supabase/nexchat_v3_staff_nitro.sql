-- NexChat: staff (owner, sudo admins, admins) give or take Nitro straight from
-- the admin panel, no request needed. Also closes a hole: anyone could switch
-- on their own Nitro, or lift their own ban, by editing their profile row.
-- Safe to run more than once.

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
