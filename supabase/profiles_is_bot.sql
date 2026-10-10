-- Marks bot accounts so the member panel can group them. Safe to re-run.
alter table public.profiles add column if not exists is_bot boolean not null default false;
