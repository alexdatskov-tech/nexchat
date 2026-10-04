-- =============================================================================
-- NEXCHAT - ROLES V2, PART 1 OF 6: reset accidental admins
-- Run after roles_and_powers.sql, then parts 1 to 6 in order in
-- Supabase -> SQL Editor. Safe to re-run. Each part is under 100 lines so it
-- survives copy and paste in full.
--
-- 1. Fixes everyone showing up as Admin. A cut-off paste of
--    roles_and_powers.sql ran its update without the where line under it, so
--    every account got platform_role = admin. This puts the role back to
--    match the original admin flag (is_platform_admin), ONCE (a marker row
--    stops it from touching staff you add later), and makes sure no new
--    account can ever start out as staff again.
-- 2. Owner-controlled permissions: what Sudo Admins and Admins may do is a
--    table the owner edits from the Owner tab, enforced here in the database.
-- 3. An audit log of every staff action.
--
-- The rank rule from roles_and_powers.sql still applies on top of every
-- permission: you can only act on people ranked BELOW you. So even if the
-- owner lets admins reset passwords, an admin can never reset the password
-- of another admin, a sudo admin or the owner.
--
-- Note: comments in this file contain no apostrophes on purpose. The
-- Supabase editor treats one inside a comment as an open string.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Nobody starts out as staff
-- -----------------------------------------------------------------------------
alter table public.profiles alter column is_platform_admin set default false;

-- Whatever the sign-up path inserts, a new profile is a regular user.
create or replace function public.guard_new_profile_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('nexchat.admin_grant', true), '') <> 'on' then
    new.is_platform_admin := false;
    new.platform_role := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_new_profile_role on public.profiles;
create trigger trg_guard_new_profile_role
  before insert on public.profiles
  for each row execute function public.guard_new_profile_role();

-- One-time reset of the accidental admins.
create table if not exists public.nx_migrations (
  name   text primary key,
  ran_at timestamptz not null default now()
);
alter table public.nx_migrations enable row level security;

do $$
begin
  if not exists (select 1 from public.nx_migrations where name = 'roles_v2_reset') then
    perform set_config('nexchat.admin_grant', 'on', true);
    update public.profiles set platform_role = null where platform_role = 'admin' and not is_platform_admin;
    update public.profiles
       set platform_role = 'owner', is_platform_admin = true
     where lower(username) = 'alexd';
    perform set_config('nexchat.admin_grant', 'off', true);
    insert into public.nx_migrations (name) values ('roles_v2_reset');
  end if;
end $$;

select 'part 1 of 6 done' as status;
