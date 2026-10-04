-- =============================================================================
-- NEXCHAT - ROLES V2, PART 4 OF 6: staff actions (2 of 2)
-- Run parts 1 to 6 in order in Supabase -> SQL Editor. Safe to re-run.
-- Each part is under 100 lines so it survives copy and paste in full.
-- =============================================================================

-- Same rank rule: an admin can never reset the password of another admin,
-- a sudo admin or the owner, even when the owner allows password resets.
create or replace function public.admin_set_password(p_user_id uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.nx_can('reset_passwords') then raise exception 'you are not allowed to reset passwords'; end if;
  if p_user_id = auth.uid() then raise exception 'change your own password from account settings'; end if;
  if public.nx_rank(p_user_id) >= public.nx_rank(auth.uid()) then
    raise exception 'you can only reset passwords of people ranked below you';
  end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'password must be at least 8 characters'; end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
   where id = p_user_id;
  if not found then raise exception 'no such user'; end if;
  delete from auth.refresh_tokens where user_id = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;
  perform public.nx_audit('reset_password', p_user_id, null);
end;
$$;

create or replace function public.admin_user_auth(p_user_id uuid)
returns table (created_at timestamptz, last_sign_in_at timestamptz, sessions bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.nx_can('view_all_servers') or public.nx_can('reset_passwords') or public.nx_can('delete_users')) then
    raise exception 'not authorised';
  end if;
  return query
    select u.created_at, u.last_sign_in_at, (select count(*) from auth.sessions s where s.user_id = u.id)
      from auth.users u where u.id = p_user_id;
end;
$$;

create or replace function public.resolve_ban_appeal(p_appeal_id uuid, p_accept boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if not public.nx_can('review_appeals') then raise exception 'you are not allowed to review appeals'; end if;
  select user_id into v_user from public.ban_appeals where id = p_appeal_id;
  if v_user is null then raise exception 'no such appeal'; end if;
  if p_accept and public.nx_rank(v_user) >= public.nx_rank(auth.uid()) then
    raise exception 'you can only unban people ranked below you';
  end if;
  update public.ban_appeals
     set status = case when p_accept then 'accepted' else 'declined' end,
         reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
   where id = p_appeal_id;
  if p_accept then
    perform public.set_user_ban_base(v_user, false, null);
  end if;
  perform public.nx_audit(case when p_accept then 'appeal_accept' else 'appeal_decline' end, v_user, null);
end;
$$;
revoke all on function public.resolve_ban_appeal(uuid, boolean, text) from public;
grant execute on function public.resolve_ban_appeal(uuid, boolean, text) to authenticated;

select 'part 4 of 6 done' as status;
