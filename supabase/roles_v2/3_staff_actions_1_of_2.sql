-- =============================================================================
-- NEXCHAT - ROLES V2, PART 3 OF 6: staff actions (1 of 2)
-- Run parts 1 to 6 in order in Supabase -> SQL Editor. Safe to re-run.
-- Each part is under 100 lines so it survives copy and paste in full.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 4. Staff actions now check permissions as well as rank
-- -----------------------------------------------------------------------------
create or replace function public.set_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_me   int := public.nx_rank(auth.uid());
  v_them int := public.nx_rank(p_user_id);
  v_role text := nullif(lower(trim(coalesce(p_role, ''))), 'user');
  v_new  int;
begin
  if not public.nx_can('manage_roles') then raise exception 'you are not allowed to change roles'; end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then raise exception 'no such user'; end if;
  if p_user_id = auth.uid() then raise exception 'you cannot change your own role'; end if;
  if v_role is not null and v_role not in ('admin', 'sudo') then raise exception 'unknown role'; end if;
  v_new := case v_role when 'sudo' then 2 when 'admin' then 1 else 0 end;
  if v_them >= v_me then raise exception 'you can only change people ranked below you'; end if;
  if v_new  >= v_me then raise exception 'you can only grant roles below your own'; end if;

  perform set_config('nexchat.admin_grant', 'on', true);
  update public.profiles set platform_role = v_role, is_platform_admin = (v_role is not null) where id = p_user_id;
  perform set_config('nexchat.admin_grant', 'off', true);

  insert into public.admin_grants (user_id, granted, actor_id, role)
  values (p_user_id, v_role is not null, auth.uid(), coalesce(v_role, 'user'));
  perform public.nx_audit('role', p_user_id, jsonb_build_object('role', coalesce(v_role, 'user')));
end;
$$;

create or replace function public.set_user_ban(p_user_id uuid, p_banned boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_can('ban_users') then raise exception 'you are not allowed to ban accounts'; end if;
  if p_user_id = auth.uid() then raise exception 'you cannot ban yourself'; end if;
  if public.nx_rank(p_user_id) >= public.nx_rank(auth.uid()) then
    raise exception 'you can only ban people ranked below you';
  end if;
  perform public.set_user_ban_base(p_user_id, p_banned, p_reason);
  perform public.nx_audit(case when p_banned then 'ban' else 'unban' end, p_user_id,
                          case when p_reason is null then null else jsonb_build_object('reason', p_reason) end);
end;
$$;

create or replace function public.admin_delete_user(p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not public.nx_can('delete_users') then raise exception 'you are not allowed to delete accounts'; end if;
  if p_user_id = auth.uid() then raise exception 'use account settings to delete your own account'; end if;
  if public.nx_rank(p_user_id) >= public.nx_rank(auth.uid()) then
    raise exception 'you can only delete people ranked below you';
  end if;
  select username into v_name from public.profiles where id = p_user_id;
  perform public.nx_audit('delete_user', p_user_id, jsonb_build_object('username', v_name));
  delete from auth.users where id = p_user_id;
end;
$$;

select 'part 3 of 6 done' as status;
