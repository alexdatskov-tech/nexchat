-- =============================================================================
-- NEXCHAT - ROLES V2, PART 2 OF 6: permissions and audit log
-- Run parts 1 to 6 in order in Supabase -> SQL Editor. Safe to re-run.
-- Each part is under 100 lines so it survives copy and paste in full.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2. Permissions the owner controls
-- -----------------------------------------------------------------------------
create table if not exists public.platform_role_perms (
  role    text not null check (role in ('admin', 'sudo')),
  perm    text not null,
  allowed boolean not null,
  primary key (role, perm)
);
alter table public.platform_role_perms enable row level security;

-- Defaults: sudo admins can do everything, admins handle day-to-day
-- moderation. Existing choices are never overwritten on a re-run.
insert into public.platform_role_perms (role, perm, allowed) values
  ('sudo', 'ban_users', true),          ('admin', 'ban_users', true),
  ('sudo', 'manage_roles', true),       ('admin', 'manage_roles', false),
  ('sudo', 'view_all_servers', true),   ('admin', 'view_all_servers', false),
  ('sudo', 'post_anywhere', true),      ('admin', 'post_anywhere', false),
  ('sudo', 'delete_messages', true),    ('admin', 'delete_messages', false),
  ('sudo', 'reset_passwords', true),    ('admin', 'reset_passwords', false),
  ('sudo', 'delete_users', true),       ('admin', 'delete_users', false),
  ('sudo', 'post_announcements', true), ('admin', 'post_announcements', true),
  ('sudo', 'review_appeals', true),     ('admin', 'review_appeals', true),
  ('sudo', 'view_audit', true),         ('admin', 'view_audit', false)
on conflict (role, perm) do nothing;

-- The owner can do everything; everyone else asks the table.
create or replace function public.nx_can(p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select case public.nx_rank(auth.uid())
    when 3 then true
    when 2 then coalesce((select allowed from public.platform_role_perms where role = 'sudo'  and perm = p_perm), false)
    when 1 then coalesce((select allowed from public.platform_role_perms where role = 'admin' and perm = p_perm), false)
    else false
  end;
$$;
grant execute on function public.nx_can(text) to authenticated;

-- Staff can read the table (the panel uses it to show the right buttons);
-- only the owner changes it, through set_role_perm().
drop policy if exists "role_perms_select_staff" on public.platform_role_perms;
create policy "role_perms_select_staff" on public.platform_role_perms for select
  using (public.nx_rank(auth.uid()) >= 1);
grant select on public.platform_role_perms to authenticated;


-- -----------------------------------------------------------------------------
-- 3. Audit log
-- -----------------------------------------------------------------------------
create table if not exists public.admin_audit (
  id         uuid primary key default gen_random_uuid(),
  actor_id   uuid references public.profiles(id) on delete set null,
  action     text not null,
  target_id  uuid,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_admin_audit_created on public.admin_audit (created_at desc);
alter table public.admin_audit enable row level security;

drop policy if exists "admin_audit_select" on public.admin_audit;
create policy "admin_audit_select" on public.admin_audit for select using (public.nx_can('view_audit'));
grant select on public.admin_audit to authenticated;
-- No insert policy: only the functions below write here.

create or replace function public.nx_audit(p_action text, p_target uuid, p_detail jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.admin_audit (actor_id, action, target_id, detail) values (auth.uid(), p_action, p_target, p_detail);
$$;
revoke all on function public.nx_audit(text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.set_role_perm(p_role text, p_perm text, p_allowed boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.nx_rank(auth.uid()) < 3 then raise exception 'only the owner can change role permissions'; end if;
  if p_role not in ('admin', 'sudo') then raise exception 'unknown role'; end if;
  if not exists (select 1 from public.platform_role_perms where perm = p_perm) then raise exception 'unknown permission'; end if;
  insert into public.platform_role_perms (role, perm, allowed) values (p_role, p_perm, p_allowed)
  on conflict (role, perm) do update set allowed = excluded.allowed;
  perform public.nx_audit('permission', null, jsonb_build_object('role', p_role, 'perm', p_perm, 'allowed', p_allowed));
end;
$$;
revoke all on function public.set_role_perm(text, text, boolean) from public, anon;
grant execute on function public.set_role_perm(text, text, boolean) to authenticated;

select 'part 2 of 6 done' as status;
