-- =============================================================================
-- NEXCHAT - ROLES V2, PART 6 OF 6: rank-up requests and check
-- Run parts 1 to 6 in order in Supabase -> SQL Editor. Safe to re-run.
-- Each part is under 100 lines so it survives copy and paste in full.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 6. Rank-up requests
--    Staff never raise their own rank. An admin asks for Sudo Admin here and
--    someone allowed to grant it (only the owner, by the rank rule) decides.
-- -----------------------------------------------------------------------------
create table if not exists public.rank_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        text not null check (role in ('admin', 'sudo')),
  reason      text check (char_length(coalesce(reason, '')) <= 1000),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  created_at  timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  review_note text
);
create unique index if not exists idx_rank_requests_one_pending on public.rank_requests (user_id) where status = 'pending';
alter table public.rank_requests enable row level security;
grant select, insert, update on public.rank_requests to authenticated;

-- Ask only for the next rank above your own.
drop policy if exists "rank_requests_insert_own" on public.rank_requests;
create policy "rank_requests_insert_own" on public.rank_requests for insert
  with check (user_id = auth.uid() and status = 'pending'
              and case role when 'admin' then 1 when 'sudo' then 2 end = public.nx_rank(auth.uid()) + 1);

-- You see your own; reviewers see what they could grant.
drop policy if exists "rank_requests_select" on public.rank_requests;
create policy "rank_requests_select" on public.rank_requests for select
  using (user_id = auth.uid()
         or (public.nx_can('manage_roles')
             and public.nx_rank(auth.uid()) > case role when 'admin' then 1 when 'sudo' then 2 end));

-- You may withdraw your own pending request.
drop policy if exists "rank_requests_cancel_own" on public.rank_requests;
create policy "rank_requests_cancel_own" on public.rank_requests for update
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'cancelled');

create or replace function public.review_rank_request(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  r      public.rank_requests;
  v_need int;
begin
  select * into r from public.rank_requests where id = p_id;
  if r.id is null or r.status <> 'pending' then raise exception 'that request is no longer open'; end if;
  v_need := case r.role when 'admin' then 1 when 'sudo' then 2 end;
  if not public.nx_can('manage_roles') or public.nx_rank(auth.uid()) <= v_need then
    raise exception 'you cannot grant that role';
  end if;
  if p_approve then perform public.set_user_role(r.user_id, r.role); end if;
  update public.rank_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
   where id = p_id;
  perform public.nx_audit(case when p_approve then 'rankup_approve' else 'rankup_decline' end, r.user_id, jsonb_build_object('role', r.role));
end;
$$;
revoke all on function public.review_rank_request(uuid, boolean, text) from public, anon;
grant execute on function public.review_rank_request(uuid, boolean, text) to authenticated;


-- -----------------------------------------------------------------------------
-- Verification -- runs last; if it does not appear, the paste was cut short.
-- -----------------------------------------------------------------------------
select
  (select username from public.profiles where platform_role = 'owner')       as owner,
  (select count(*) from public.profiles where is_platform_admin)             as staff_now,
  (select count(*) from public.profiles where not is_platform_admin)         as regular_users,
  exists (select 1 from public.nx_migrations where name = 'roles_v2_reset')  as reset_done,
  (select count(*) from public.platform_role_perms)                          as permission_rows,
  to_regclass('public.admin_audit') is not null                              as audit_log,
  to_regclass('public.rank_requests') is not null                            as rank_requests;
