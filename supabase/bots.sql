-- Bot platform: bot accounts, developer API tokens, rate limits.
-- Paste into the Supabase SQL editor and run. Safe to re-run.
-- Run supabase/profiles_is_bot.sql first, or this file covers it too.

alter table public.profiles add column if not exists is_bot boolean not null default false;
alter table public.profiles add column if not exists is_developer boolean not null default false;
alter table public.profiles add column if not exists bot_owner_id uuid references public.profiles(id) on delete cascade;

-- One row per bot account. The bot is a normal user (profiles row + auth
-- user) that logs in with username + password. owner_id is the developer.
-- host_allowlist is for bot custom HTML later: empty means no outside calls.
create table if not exists public.bots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  host_allowlist text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.bots enable row level security;
drop policy if exists bots_owner_read on public.bots;
create policy bots_owner_read on public.bots for select to authenticated using (owner_id = auth.uid());

-- Developer API tokens, stored as SHA-256 hashes only. No policies on purpose:
-- only the Edge Function (service role) can read or write this table.
create table if not exists public.dev_tokens (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.dev_tokens enable row level security;

-- Fixed one-minute windows for API rate limits.
create table if not exists public.bot_rate (
  key text not null,
  window_start timestamptz not null,
  n int not null default 0,
  primary key (key, window_start)
);
alter table public.bot_rate enable row level security;

create or replace function public.bot_rate_take(p_key text, p_limit int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  w timestamptz := date_trunc('minute', now());
  c int;
begin
  insert into public.bot_rate (key, window_start, n) values (p_key, w, 1)
  on conflict (key, window_start) do update set n = public.bot_rate.n + 1
  returning n into c;
  delete from public.bot_rate where window_start < now() - interval '10 minutes';
  return c <= p_limit;
end;
$$;
revoke all on function public.bot_rate_take(text, int) from public, anon, authenticated;
grant execute on function public.bot_rate_take(text, int) to service_role;
