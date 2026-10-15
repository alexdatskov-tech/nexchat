-- =============================================================================
-- NEXCHAT - STORAGE GROUPS AND ENDPOINTS (CloudGate)
-- Run in Supabase -> SQL Editor AFTER roles_and_powers.sql, roles_v2 parts 1-6
-- and storage_quota.sql (it uses nx_can and nx_audit). Safe to re-run.
--
-- What it adds:
--   * storage_settings   - the category NexChat stores files in, and the CDN host
--   * storage_groups     - capacity-limited groups (100 GB, 200 GB, ...), filled in order
--   * storage_endpoints  - ways into a group's storage, each with its own username and password
--   * storage_objects    - which endpoint a file was uploaded through, and how big it is
--
-- Endpoints inside one group are MIRRORS: two addresses for the same storage. So a
-- group is measured once (baseline_bytes), and its usage is that baseline plus the
-- files NexChat has tracked in the group. It is never summed per endpoint.
--
-- Access: the tables have row level security on and NO policies, so the app only
-- reaches them through the functions below. Admin functions need the
-- manage_storage permission. Client functions need a signed-in user.
--
-- Known limit: storage_client_config() returns the endpoint logins to every
-- signed-in browser, because the browser signs its own uploads. Moving the
-- signing into an Edge Function would keep the logins off the client.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Tables
-- -----------------------------------------------------------------------------
create table if not exists public.storage_settings (
  id int primary key default 1 check (id = 1),
  category text not null default 'nexchats-us1'
    check (category ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  cdn text,
  confirmed boolean not null default false,   -- set once an admin has chosen the category
  updated_at timestamptz not null default now()
);
insert into public.storage_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.storage_groups (
  id uuid primary key default gen_random_uuid(),
  position int not null default 0,
  name text not null check (length(trim(name)) between 1 and 60),
  capacity_gb numeric not null check (capacity_gb > 0),
  baseline_bytes bigint not null default 0,  -- measured usage of the group's storage before NexChat tracked files
  measured_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.storage_endpoints (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.storage_groups(id) on delete cascade,
  position int not null default 0,
  name text not null check (length(trim(name)) between 1 and 60),
  base_url text not null check (base_url ~ '^https?://'),
  username text not null,
  password text not null,
  baseline_bytes bigint not null default 0,   -- unused since mirrors share the group baseline (kept for old installs)
  measured_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.storage_objects (
  key text primary key,
  group_id uuid references public.storage_groups(id) on delete set null,
  endpoint_id uuid references public.storage_endpoints(id) on delete set null,
  size bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists storage_objects_group_idx on public.storage_objects (group_id);
create index if not exists storage_objects_endpoint_idx on public.storage_objects (endpoint_id);

-- Earlier installs measured each endpoint and summed them, which counted a mirrored
-- storage twice. Move to one baseline per group: the largest endpoint measurement
-- (they match, since they are the same storage) minus the files tracked in the group.
-- Runs once; a fresh install has nothing to move.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'storage_groups' and column_name = 'baseline_bytes') then
    alter table public.storage_groups add column baseline_bytes bigint not null default 0;
    alter table public.storage_groups add column measured_at timestamptz;
  end if;
end $$;

-- One-time carry-over: only for groups whose baseline was never measured under the new rule.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'storage_endpoints' and column_name = 'baseline_bytes')
     and not exists (select 1 from public.storage_groups where measured_at is not null) then
    update public.storage_groups g set
      baseline_bytes = greatest(0,
        coalesce((select max(e.baseline_bytes + coalesce((select sum(o.size) from public.storage_objects o where o.endpoint_id = e.id), 0))
                  from public.storage_endpoints e where e.group_id = g.id), 0)
        - coalesce((select sum(o.size) from public.storage_objects o where o.group_id = g.id), 0)),
      measured_at = (select max(e.measured_at) from public.storage_endpoints e where e.group_id = g.id)
    where exists (select 1 from public.storage_endpoints e where e.group_id = g.id and e.measured_at is not null);
  end if;
end $$;

alter table public.storage_settings enable row level security;
alter table public.storage_groups enable row level security;
alter table public.storage_endpoints enable row level security;
alter table public.storage_objects enable row level security;

-- -----------------------------------------------------------------------------
-- 2. Usage: baseline (measured) plus everything NexChat has tracked
-- -----------------------------------------------------------------------------
create or replace function public.storage_group_used(p_group uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select (
    coalesce((select g.baseline_bytes from public.storage_groups g where g.id = p_group), 0)
    + coalesce((select sum(o.size) from public.storage_objects o where o.group_id = p_group), 0)
  )::bigint;
$$;

-- -----------------------------------------------------------------------------
-- 3. Client functions (any signed-in user)
-- -----------------------------------------------------------------------------
create or replace function public.storage_client_config()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  return (
    select jsonb_build_object(
      'category', s.category,
      'cdn', s.cdn,
      'configured', s.confirmed,
      'groups', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', g.id,
          'name', g.name,
          'capacity_bytes', (g.capacity_gb * 1073741824)::bigint,
          'used_bytes', public.storage_group_used(g.id),
          'endpoints', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', e.id, 'name', e.name, 'base_url', e.base_url,
              'username', e.username, 'password', e.password
            ) order by e.position, e.created_at)
            from public.storage_endpoints e where e.group_id = g.id
          ), '[]'::jsonb)
        ) order by g.position, g.created_at)
        from public.storage_groups g
      ), '[]'::jsonb)
    )
    from public.storage_settings s where s.id = 1
  );
end $$;

create or replace function public.storage_record(p_key text, p_group uuid, p_endpoint uuid, p_size bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.storage_objects (key, group_id, endpoint_id, size)
  values (p_key, p_group, p_endpoint, greatest(coalesce(p_size, 0), 0))
  on conflict (key) do update set
    group_id = excluded.group_id, endpoint_id = excluded.endpoint_id, size = excluded.size;
end $$;

create or replace function public.storage_lookup(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('group_id', o.group_id, 'endpoint_id', o.endpoint_id, 'size', o.size)
  from public.storage_objects o
  where o.key = p_key and auth.uid() is not null;
$$;

create or replace function public.storage_forget(p_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  delete from public.storage_objects where key = p_key;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Admin functions (manage_storage)
-- -----------------------------------------------------------------------------
create or replace function public.storage_admin_list()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  return (
    select jsonb_build_object(
      'category', s.category,
      'cdn', s.cdn,
      'configured', s.confirmed,
      'groups', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', g.id,
          'name', g.name,
          'capacity_gb', g.capacity_gb,
          'capacity_bytes', (g.capacity_gb * 1073741824)::bigint,
          'used_bytes', public.storage_group_used(g.id),
          'baseline_bytes', g.baseline_bytes,
          'measured_at', g.measured_at,
          'tracked_bytes', coalesce((select sum(o.size) from public.storage_objects o where o.group_id = g.id), 0),
          'endpoints', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', e.id,
              'name', e.name,
              'base_url', e.base_url,
              'username', e.username,
              'password', e.password
            ) order by e.position, e.created_at)
            from public.storage_endpoints e where e.group_id = g.id
          ), '[]'::jsonb)
        ) order by g.position, g.created_at)
        from public.storage_groups g
      ), '[]'::jsonb)
    )
    from public.storage_settings s where s.id = 1
  );
end $$;

create or replace function public.storage_admin_set_category(p_category text, p_cdn text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  if p_category is null or p_category !~ '^[a-z0-9][a-z0-9_-]{0,62}$' then
    raise exception 'category must be lowercase letters, numbers, - or _ (up to 63 characters)';
  end if;
  insert into public.storage_settings (id, category, cdn, confirmed, updated_at)
  values (1, p_category, nullif(trim(coalesce(p_cdn, '')), ''), true, now())
  on conflict (id) do update set
    category = excluded.category, cdn = excluded.cdn, confirmed = true, updated_at = now();
  perform public.nx_audit('storage_category', null, jsonb_build_object('category', p_category));
end $$;

create or replace function public.storage_admin_save_group(p_id uuid, p_name text, p_capacity_gb numeric)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'give the group a name'; end if;
  if p_capacity_gb is null or p_capacity_gb <= 0 then raise exception 'capacity must be more than 0 GB'; end if;
  if p_id is null then
    insert into public.storage_groups (position, name, capacity_gb)
    values ((select coalesce(max(position), 0) + 1 from public.storage_groups), trim(p_name), p_capacity_gb)
    returning id into v_id;
  else
    update public.storage_groups set name = trim(p_name), capacity_gb = p_capacity_gb
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'group not found'; end if;
  end if;
  perform public.nx_audit('storage_group_save', null,
    jsonb_build_object('id', v_id, 'name', trim(p_name), 'capacity_gb', p_capacity_gb));
  return v_id;
end $$;

create or replace function public.storage_admin_delete_group(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  delete from public.storage_groups where id = p_id;
  perform public.nx_audit('storage_group_delete', null, jsonb_build_object('id', p_id));
end $$;

-- The password is only written when a new one is given; blank keeps the old one.
create or replace function public.storage_admin_save_endpoint(
  p_id uuid, p_group uuid, p_name text, p_base_url text, p_username text, p_password text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_base text;
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  v_base := rtrim(trim(coalesce(p_base_url, '')), '/');
  if v_base !~ '^https?://[^/]+' then raise exception 'the endpoint address must start with https://'; end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'give the endpoint a name'; end if;
  if p_username is null or length(trim(p_username)) = 0 then raise exception 'enter the username for this endpoint'; end if;

  if p_id is null then
    if p_group is null or not exists (select 1 from public.storage_groups where id = p_group) then
      raise exception 'choose the group this endpoint belongs to';
    end if;
    if p_password is null or p_password = '' then raise exception 'enter the password for this endpoint'; end if;
    insert into public.storage_endpoints (group_id, position, name, base_url, username, password)
    values (p_group,
            (select coalesce(max(position), 0) + 1 from public.storage_endpoints where group_id = p_group),
            trim(p_name), v_base, trim(p_username), p_password)
    returning id into v_id;
  else
    update public.storage_endpoints set
      name = trim(p_name),
      base_url = v_base,
      username = trim(p_username),
      password = case when coalesce(p_password, '') = '' then password else p_password end
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'endpoint not found'; end if;
  end if;

  perform public.nx_audit('storage_endpoint_save', null,
    jsonb_build_object('id', v_id, 'name', trim(p_name), 'base_url', v_base));
  return v_id;
end $$;

create or replace function public.storage_admin_delete_endpoint(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  delete from public.storage_endpoints where id = p_id;
  perform public.nx_audit('storage_endpoint_delete', null, jsonb_build_object('id', p_id));
end $$;

-- Order = the order given. Groups fill first-to-last; endpoints fail over first-to-last.
create or replace function public.storage_admin_reorder_groups(p_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  update public.storage_groups g set position = u.ord::int
  from unnest(p_ids) with ordinality as u(id, ord)
  where g.id = u.id;
end $$;

create or replace function public.storage_admin_reorder_endpoints(p_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  update public.storage_endpoints e set position = u.ord::int
  from unnest(p_ids) with ordinality as u(id, ord)
  where e.id = u.id;
end $$;

-- The app measures an endpoint's real usage (GET /api/stats) and sends it here.
-- The endpoint is a way into its group's storage, so the group takes the measurement.
-- Files NexChat already tracked in the group are subtracted, so nothing is counted twice.
create or replace function public.storage_admin_set_baseline(p_endpoint uuid, p_measured bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_group uuid; v_base bigint;
begin
  if not public.nx_can('manage_storage') then raise exception 'you are not allowed to manage storage'; end if;
  select e.group_id into v_group from public.storage_endpoints e where e.id = p_endpoint;
  if v_group is null then raise exception 'endpoint not found'; end if;
  update public.storage_endpoints set measured_at = now() where id = p_endpoint;
  update public.storage_groups g set
    baseline_bytes = greatest(0, coalesce(p_measured, 0)
      - coalesce((select sum(o.size) from public.storage_objects o where o.group_id = g.id), 0)),
    measured_at = now()
  where g.id = v_group
  returning g.baseline_bytes into v_base;
  return v_base;
end $$;
