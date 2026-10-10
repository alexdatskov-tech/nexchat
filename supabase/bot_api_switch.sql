-- Platform switch for the Bot API (credit: andrew).
-- Paste into the Supabase SQL editor and run. Safe to re-run.
-- Run after roles_and_powers.sql (it uses nx_rank).
--
-- The bot API starts OFF. Only the owner (rank 3) can turn it on or off,
-- from Profile -> Developer. The Edge Function, the Developer tab and the
-- docs page all read this one row, so the switch is enforced on the server.

create table if not exists public.platform_features (
  key text primary key,
  enabled boolean not null default false,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

-- Insert once. Re-running this file never changes a value the owner set.
insert into public.platform_features (key, enabled, note)
values ('bot_api', false, 'Bot API by andrew. Temporarily unavailable.')
on conflict (key) do nothing;

alter table public.platform_features enable row level security;

-- Anyone may read the switch (the docs page checks it while signed out).
-- Nobody may write it directly; only the function below can.
drop policy if exists platform_features_read on public.platform_features;
create policy platform_features_read on public.platform_features
  for select to anon, authenticated using (true);

create or replace function public.set_platform_feature(p_key text, p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.nx_rank(auth.uid()) < 3 then
    raise exception 'Only the owner can change this.';
  end if;
  update public.platform_features
     set enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
   where key = p_key;
  if not found then
    raise exception 'Unknown feature.';
  end if;
  return p_enabled;
end;
$$;

revoke all on function public.set_platform_feature(text, boolean) from public, anon;
grant execute on function public.set_platform_feature(text, boolean) to authenticated;
