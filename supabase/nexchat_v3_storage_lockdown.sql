-- =============================================================================
-- NexChat v3: storage lockdown. Run ONLY after the cloudgate-proxy Edge
-- Function is deployed and assets/js/config.js has CLOUDGATE.proxy set
-- (see supabase/functions/cloudgate-proxy/index.ts). Safe to re-run.
--
-- storage_client_config() stops handing endpoint logins to browsers; the
-- proxy reads them with the service role instead. Afterwards, change the
-- CloudGate password (the old one is in public git history) and update it in
-- Admin -> Storage endpoints and in the CLOUDGATE_ENDPOINTS secret.
-- =============================================================================
create or replace function public.storage_client_config()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  return (
    select jsonb_build_object(
      'category', s.category, 'cdn', s.cdn, 'configured', s.confirmed, 'proxy', true,
      'groups', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', g.id, 'name', g.name,
          'capacity_bytes', (g.capacity_gb * 1073741824)::bigint,
          'used_bytes', public.storage_group_used(g.id),
          'endpoints', coalesce((
            select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'base_url', e.base_url) order by e.position, e.created_at)
            from public.storage_endpoints e where e.group_id = g.id), '[]'::jsonb)
        ) order by g.position, g.created_at)
        from public.storage_groups g), '[]'::jsonb)
    )
    from public.storage_settings s where s.id = 1
  );
end $$;

select 'storage lockdown ok' as result;
