-- NexChat: platform announcements
-- Paste into Supabase -> SQL editor -> Run. Safe to re-run.
--
-- Platform admins (profiles.is_platform_admin) post announcements from the
-- Admin page; everyone signed in can read them. They show on Home, in the
-- megaphone panel of the left bar, and pop up live when posted.

create table if not exists public.announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 140),
  body        text not null default '' check (char_length(body) <= 8000),
  level       text not null default 'info' check (level in ('info', 'update', 'warning', 'event')),
  pinned      boolean not null default false,
  author_id   uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz
);

create index if not exists announcements_created_idx on public.announcements (created_at desc);

alter table public.announcements enable row level security;

create or replace function public.nx_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_platform_admin from public.profiles where id = auth.uid()), false);
$$;

drop policy if exists "announcements readable by members" on public.announcements;
create policy "announcements readable by members" on public.announcements
  for select to authenticated
  using (expires_at is null or expires_at > now() or public.nx_is_platform_admin());

drop policy if exists "admins post announcements" on public.announcements;
create policy "admins post announcements" on public.announcements
  for insert to authenticated
  with check (public.nx_is_platform_admin());

drop policy if exists "admins edit announcements" on public.announcements;
create policy "admins edit announcements" on public.announcements
  for update to authenticated
  using (public.nx_is_platform_admin())
  with check (public.nx_is_platform_admin());

drop policy if exists "admins delete announcements" on public.announcements;
create policy "admins delete announcements" on public.announcements
  for delete to authenticated
  using (public.nx_is_platform_admin());

-- Live delivery: add the table to the realtime publication once.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'announcements'
  ) then
    alter publication supabase_realtime add table public.announcements;
  end if;
end $$;

-- Verification: both columns should read true.
select
  to_regclass('public.announcements') is not null as announcements_table,
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'announcements') as realtime_enabled;
