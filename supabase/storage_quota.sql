-- =============================================================================
-- NEXCHAT - DRIVE STORAGE QUOTAS AND STORAGE REQUESTS
-- Run in Supabase -> SQL Editor AFTER roles_and_powers.sql and roles_v2 parts
-- 1 to 6 (it uses nx_rank, nx_can and nx_audit from those). Safe to re-run.
--
-- What it adds:
--   * profiles.drive_quota_gb  - how many GB each user may hold in My Drive
--                                (default 5). Only staff can change it.
--   * manage_storage permission - Owner decides which staff roles may change
--                                quotas and answer storage requests.
--   * storage_requests          - users ask for more space; staff approve/decline.
--   * admin_set_drive_quota()   - staff set a user quota directly.
--   * review_storage_request()  - staff approve (sets the quota) or decline.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The quota column, with a range
-- -----------------------------------------------------------------------------
alter table public.profiles add column if not exists drive_quota_gb int not null default 5;

alter table public.profiles drop constraint if exists profiles_drive_quota_gb_check;
alter table public.profiles add constraint profiles_drive_quota_gb_check
  check (drive_quota_gb between 1 and 2048);

-- Nobody can raise their own quota. The column only changes through the
-- functions below, which set the same flag the role guard uses.
create or replace function public.guard_drive_quota()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(current_setting('nexchat.quota_grant', true), '') <> 'on' then
      new.drive_quota_gb := 5;
    end if;
  elsif new.drive_quota_gb is distinct from old.drive_quota_gb
        and coalesce(current_setting('nexchat.quota_grant', true), '') <> 'on' then
    raise exception 'storage quotas can only be changed by staff';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_drive_quota on public.profiles;
create trigger trg_guard_drive_quota
  before insert or update on public.profiles
  for each row execute function public.guard_drive_quota();

-- -----------------------------------------------------------------------------
-- 2. Permission the owner controls (sudo and admin on by default)
-- -----------------------------------------------------------------------------
insert into public.platform_role_perms (role, perm, allowed) values
  ('sudo',  'manage_storage', true),
  ('admin', 'manage_storage', true)
on conflict (role, perm) do nothing;

-- -----------------------------------------------------------------------------
-- 3. Storage requests from users
-- -----------------------------------------------------------------------------
create table if not exists public.storage_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  requested_gb int not null check (requested_gb between 1 and 2048),
  reason      text check (char_length(coalesce(reason, '')) <= 1000),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  created_at  timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text
);
create unique index if not exists idx_storage_requests_one_pending
  on public.storage_requests (user_id) where status = 'pending';
alter table public.storage_requests enable row level security;
grant select, insert, update on public.storage_requests to authenticated;

-- Ask for more than you have, one open request at a time.
drop policy if exists "storage_requests_insert_own" on public.storage_requests;
create policy "storage_requests_insert_own" on public.storage_requests for insert
  with check (
    user_id = auth.uid() and status = 'pending'
    and requested_gb > (select drive_quota_gb from public.profiles where id = auth.uid())
  );

-- You see your own; staff see requests from people ranked below them.
drop policy if exists "storage_requests_select" on public.storage_requests;
create policy "storage_requests_select" on public.storage_requests for select
  using (
    user_id = auth.uid()
    or (public.nx_can('manage_storage') and public.nx_rank(auth.uid()) > public.nx_rank(user_id))
  );

-- You may withdraw your own pending request.
drop policy if exists "storage_requests_cancel_own" on public.storage_requests;
create policy "storage_requests_cancel_own" on public.storage_requests for update
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'cancelled');

-- -----------------------------------------------------------------------------
-- 4. Staff set a quota directly
--    Same rank rule as everything else: strictly below you (the owner may
--    change anyone, including themselves).
-- -----------------------------------------------------------------------------
create or replace function public.admin_set_drive_quota(p_user_id uuid, p_gb int)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_me   int := public.nx_rank(auth.uid());
  v_them int := public.nx_rank(p_user_id);
  v_old  int;
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to change storage'; end if;
  if v_me < 3 and v_me <= v_them then raise exception 'you can only change storage for people ranked below you'; end if;
  if p_gb is null or p_gb < 1 or p_gb > 2048 then raise exception 'storage must be between 1 and 2048 GB'; end if;

  select drive_quota_gb into v_old from public.profiles where id = p_user_id;
  if v_old is null then raise exception 'no such user'; end if;

  perform set_config('nexchat.quota_grant', 'on', true);
  update public.profiles set drive_quota_gb = p_gb where id = p_user_id;
  perform set_config('nexchat.quota_grant', 'off', true);

  perform public.nx_audit('storage_quota', p_user_id, jsonb_build_object('from_gb', v_old, 'to_gb', p_gb));
end;
$$;
revoke all on function public.admin_set_drive_quota(uuid, int) from public, anon;
grant execute on function public.admin_set_drive_quota(uuid, int) to authenticated;

-- -----------------------------------------------------------------------------
-- 5. Staff answer a storage request
-- -----------------------------------------------------------------------------
create or replace function public.review_storage_request(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  r     public.storage_requests;
  v_me  int := public.nx_rank(auth.uid());
begin
  select * into r from public.storage_requests where id = p_id;
  if r.id is null or r.status <> 'pending' then raise exception 'that request is no longer open'; end if;
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to review storage requests'; end if;
  if v_me < 3 and v_me <= public.nx_rank(r.user_id) then
    raise exception 'you can only review requests from people ranked below you';
  end if;

  if p_approve then
    perform set_config('nexchat.quota_grant', 'on', true);
    update public.profiles set drive_quota_gb = r.requested_gb where id = r.user_id;
    perform set_config('nexchat.quota_grant', 'off', true);
  end if;

  update public.storage_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
   where id = p_id;

  perform public.nx_audit(
    case when p_approve then 'storage_approve' else 'storage_decline' end,
    r.user_id,
    jsonb_build_object('requested_gb', r.requested_gb));
end;
$$;
revoke all on function public.review_storage_request(uuid, boolean, text) from public, anon;
grant execute on function public.review_storage_request(uuid, boolean, text) to authenticated;

-- -----------------------------------------------------------------------------
-- Verification -- runs last; if it does not appear, the paste was cut short.
-- -----------------------------------------------------------------------------
select
  (select count(*) from public.profiles where drive_quota_gb is not null)    as users_with_quota,
  (select count(*) from public.platform_role_perms where perm = 'manage_storage') as storage_perm_rows,
  to_regclass('public.storage_requests') is not null                          as storage_requests,
  exists (select 1 from pg_proc where proname = 'review_storage_request')     as review_fn;
