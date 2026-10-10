-- Join a server with an invite code. Safe to re-run.
-- The Join box in the portal calls this. It adds the signed-in user to the
-- server behind the code and returns the server id. Unknown and expired codes
-- are refused.

create or replace function public.join_server_by_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_server uuid;
  v_exp timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;

  select i.server_id, i.expires_at into v_server, v_exp
  from public.invites i
  where i.code = trim(p_code)
  limit 1;

  if v_server is null then
    raise exception 'That invite code does not exist.';
  end if;
  if v_exp is not null and v_exp < now() then
    raise exception 'That invite has expired.';
  end if;

  insert into public.server_members (server_id, user_id)
  select v_server, auth.uid()
  where not exists (
    select 1 from public.server_members m
    where m.server_id = v_server and m.user_id = auth.uid()
  );

  return v_server;
end;
$$;

grant execute on function public.join_server_by_invite(text) to authenticated;
