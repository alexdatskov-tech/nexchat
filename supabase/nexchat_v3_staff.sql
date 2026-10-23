-- NexChat: platform staff (who can see every server) can make invites for any
-- server and join one without an invite. Safe to run more than once.

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert with check (
  created_by = auth.uid()
  and (public.has_permission(server_id, auth.uid(), 256) or public.nx_can('view_all_servers'))
);

drop policy if exists invites_select_members on public.invites;
create policy invites_select_members on public.invites for select using (
  public.is_server_member(server_id, auth.uid()) or public.nx_can('view_all_servers')
);

create or replace function public.nx_staff_join(p_server uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.nx_can('view_all_servers') then
    raise exception 'Only platform staff can join a server without an invite.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.servers where id = p_server) then
    raise exception 'That server doesn''t exist.';
  end if;
  if exists (select 1 from public.server_bans where server_id = p_server and user_id = auth.uid()) then
    raise exception 'You are banned from this server.';
  end if;
  insert into public.server_members (server_id, user_id) values (p_server, auth.uid()) on conflict do nothing;
end $$;

revoke all on function public.nx_staff_join(uuid) from public, anon;
grant execute on function public.nx_staff_join(uuid) to authenticated;
