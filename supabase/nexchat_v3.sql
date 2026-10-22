-- =============================================================================
-- NexChat v3: security fixes, read state and one-round-trip loading.
--
-- Paste into Supabase -> SQL editor and run. Safe to re-run: every statement
-- is idempotent. Needs roles_and_powers.sql and roles_v2 to have run first
-- (it uses nx_rank / nx_can).
--
-- 1. Profiles: is_banned, is_nitro and friends can no longer be changed by
--    the account itself (the old guard had been replaced with a no-op, so a
--    banned user could simply unban themselves).
-- 2. Memberships: joining a server or a DM only works through the
--    join_server_by_invite / open_dm / create_group_dm functions. Before,
--    anyone could insert themselves into any server or conversation.
-- 3. Friendships: requests can only be created as pending and only accepted
--    by the person they were sent to.
-- 4. Messages can't be moved to another channel / conversation by editing.
-- 5. Sending in a server channel needs the Send messages permission.
-- 6. Read state for DMs and channels, plus nx_inbox(): everything the app
--    shell needs (servers, conversations, unread counts, friendships) in a
--    single request.
-- 7. Invites honour server bans and use limits; kicks/bans can't target the
--    owner or yourself.
-- 8. Platform locks, 1:1 DMs and storage records can't be tampered with.
-- 9. Private realtime channels for calls, typing and call rings.
-- 10. Drops the unused bot tables and columns.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Privileged profile columns
-- A direct UPDATE from the browser runs as role "authenticated". Server-side
-- functions (security definer: bans, nitro approval, quota grants) run as
-- their owner and are allowed through.
-- ---------------------------------------------------------------------------
create or replace function public.protect_privileged_profile_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if new.id is distinct from old.id
       or new.username is distinct from old.username
       or new.is_banned is distinct from old.is_banned
       or new.ban_reason is distinct from old.ban_reason
       or new.is_nitro is distinct from old.is_nitro
       or new.nitro_since is distinct from old.nitro_since
       or new.created_at is distinct from old.created_at then
      raise exception 'That profile field can only be changed by staff.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_protect_profile_columns on public.profiles;
create trigger trg_protect_profile_columns
  before update on public.profiles
  for each row execute function public.protect_privileged_profile_columns();

-- ---------------------------------------------------------------------------
-- 2. Server and DM membership
-- ---------------------------------------------------------------------------
drop policy if exists server_members_insert_self on public.server_members;
drop policy if exists server_members_insert_owner on public.server_members;
create policy server_members_insert_owner on public.server_members
  for insert with check (
    user_id = auth.uid()
    and exists (select 1 from public.servers s where s.id = server_id and s.owner_id = auth.uid())
  );

drop policy if exists server_members_update on public.server_members;
create policy server_members_update on public.server_members
  for update
  using ((user_id = auth.uid()) or has_permission(server_id, auth.uid(), 16384) or is_platform_admin(auth.uid()))
  with check ((user_id = auth.uid()) or has_permission(server_id, auth.uid(), 16384) or is_platform_admin(auth.uid()));

-- Which server / person a membership row belongs to never changes.
create or replace function public.nx_lock_member_keys()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.server_id is distinct from old.server_id or new.user_id is distinct from old.user_id then
    raise exception 'Membership rows cannot be moved.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lock_member_keys on public.server_members;
create trigger trg_lock_member_keys before update on public.server_members
  for each row execute function public.nx_lock_member_keys();

-- People are added to a conversation by someone already in it, and only to
-- group chats. 1:1 chats are created by open_dm().
drop policy if exists dm_participants_insert on public.dm_participants;
create policy dm_participants_insert on public.dm_participants
  for insert with check (
    is_dm_participant(conversation_id, auth.uid())
    and exists (select 1 from public.dm_conversations c where c.id = conversation_id and c.is_group)
  );

-- ---------------------------------------------------------------------------
-- 3. Friendships
-- ---------------------------------------------------------------------------
drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert with check (user_id = auth.uid() and status = 'pending');

-- Accepting goes through accept_friend_request(); nothing updates rows directly.
drop policy if exists friendships_update on public.friendships;

-- ---------------------------------------------------------------------------
-- 4. Messages stay where they were posted
-- ---------------------------------------------------------------------------
create or replace function public.nx_lock_message_keys()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_table_name = 'messages' then
    if new.channel_id is distinct from old.channel_id then
      raise exception 'Messages cannot be moved.';
    end if;
  else
    if new.conversation_id is distinct from old.conversation_id then
      raise exception 'Messages cannot be moved.';
    end if;
  end if;
  if new.author_id is distinct from old.author_id or new.created_at is distinct from old.created_at then
    raise exception 'Messages cannot be re-attributed.';
  end if;
  if tg_table_name = 'messages' and current_user in ('authenticated', 'anon')
     and new.is_pinned is distinct from old.is_pinned then
    raise exception 'Use nx_set_pinned() to pin messages.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lock_message_keys on public.messages;
create trigger trg_lock_message_keys before update on public.messages
  for each row execute function public.nx_lock_message_keys();
drop trigger if exists trg_lock_message_keys on public.dm_messages;
create trigger trg_lock_message_keys before update on public.dm_messages
  for each row execute function public.nx_lock_message_keys();

drop policy if exists voice_sessions_update on public.voice_sessions;
create policy voice_sessions_update on public.voice_sessions
  for update
  using ((user_id = auth.uid()) or has_permission(server_id, auth.uid(), 4096) or has_permission(server_id, auth.uid(), 8192))
  with check ((user_id = auth.uid()) or has_permission(server_id, auth.uid(), 4096) or has_permission(server_id, auth.uid(), 8192));

-- ---------------------------------------------------------------------------
-- 5. Send messages permission (bit 2). Every @everyone role has it today.
-- ---------------------------------------------------------------------------
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.channels c
      where c.id = channel_id
        and is_server_member(c.server_id, auth.uid())
        and has_permission(c.server_id, auth.uid(), 2)
        and not channel_hidden_for(c.id, auth.uid())
    )
  );

-- Pinning needs Manage messages; authors can't pin through the update policy.
create or replace function public.nx_set_pinned(p_message uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_server uuid;
begin
  select c.server_id into v_server
  from public.messages m join public.channels c on c.id = m.channel_id
  where m.id = p_message;
  if v_server is null then raise exception 'Message not found.'; end if;
  if not (has_permission(v_server, auth.uid(), 4) or nx_can('delete_messages')) then
    raise exception 'You need the Manage messages permission to pin.';
  end if;
  update public.messages set is_pinned = coalesce(p_pinned, false) where id = p_message;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Read state + inbox
-- ---------------------------------------------------------------------------
create index if not exists idx_dm_participants_user on public.dm_participants (user_id);
create index if not exists idx_friendships_friend on public.friendships (friend_id);
create index if not exists idx_channel_read_states_user on public.channel_read_states (user_id);

-- The fields every avatar / name needs, with only the display parts of theme.
create or replace function public.nx_card(p public.profiles)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', p.id, 'username', p.username, 'display_name', p.display_name,
    'avatar_url', p.avatar_url, 'accent_color', p.accent_color,
    'is_nitro', p.is_nitro, 'banner_gif_url', p.banner_gif_url,
    'custom_status', p.custom_status, 'status', p.status,
    'platform_role', p.platform_role, 'is_platform_admin', p.is_platform_admin,
    'theme', jsonb_strip_nulls(jsonb_build_object(
      'name_style', p.theme->'name_style', 'pfp_deco', p.theme->'pfp_deco',
      'bio_deco', p.theme->'bio_deco', 'dev_mode', p.theme->'dev_mode',
      'halo_css', p.theme->'halo_css'))
  );
$$;

create or replace function public.nx_mark_dm_read(p_conv uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.dm_participants set last_read_at = now()
  where conversation_id = p_conv and user_id = auth.uid();
$$;

create or replace function public.nx_mark_channel_read(p_channel uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.channel_read_states (channel_id, user_id, updated_at)
  select p_channel, auth.uid(), now()
  where auth.uid() is not null
  on conflict (channel_id, user_id) do update set updated_at = now();
$$;

-- Unread counts for the text channels of one server (capped at 100 each).
create or replace function public.nx_channel_unreads(p_server uuid)
returns table (channel_id uuid, unread int, last_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.id,
         (select count(*)::int from (
            select 1 from public.messages m
            where m.channel_id = c.id and m.author_id <> auth.uid()
              and m.created_at > coalesce(rs.updated_at, sm.joined_at)
            limit 100) x),
         (select max(m.created_at) from public.messages m where m.channel_id = c.id)
  from public.channels c
  join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
  left join public.channel_read_states rs on rs.channel_id = c.id and rs.user_id = auth.uid()
  where c.server_id = p_server
    and c.type in ('text', 'announcement')
    and not channel_hidden_for(c.id, auth.uid());
$$;

-- Everything the app shell needs on load.
create or replace function public.nx_inbox()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_out jsonb;
begin
  if v_me is null then raise exception 'Sign in first.'; end if;

  select jsonb_build_object(
    'v', 3,
    'servers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'icon_url', s.icon_url, 'owner_id', s.owner_id,
        'theme', s.theme, 'joined_at', sm.joined_at,
        'unread', exists (
          select 1 from public.channels c
          join public.messages m on m.channel_id = c.id
          left join public.channel_read_states rs on rs.channel_id = c.id and rs.user_id = v_me
          where c.server_id = s.id and c.type in ('text', 'announcement')
            and m.author_id <> v_me
            and m.created_at > coalesce(rs.updated_at, sm.joined_at)
            and not channel_hidden_for(c.id, v_me)
        )
      ) order by sm.joined_at, s.created_at)
      from public.server_members sm
      join public.servers s on s.id = sm.server_id
      where sm.user_id = v_me
    ), '[]'::jsonb),

    'dms', coalesce((
      select jsonb_agg(r order by (r->>'sort') desc)
      from (
        select jsonb_build_object(
          'id', c.id, 'is_group', c.is_group, 'name', c.name, 'icon_url', c.icon_url,
          'created_by', c.created_by, 'created_at', c.created_at,
          'last_read_at', me.last_read_at,
          'people', coalesce((
            select jsonb_agg(public.nx_card(p) order by p.username)
            from public.dm_participants o join public.profiles p on p.id = o.user_id
            where o.conversation_id = c.id and o.user_id <> v_me
          ), '[]'::jsonb),
          'last', (
            select jsonb_build_object('id', m.id, 'author_id', m.author_id,
              'content', left(m.content, 140), 'created_at', m.created_at,
              'files', (select count(*) from public.dm_message_attachments a where a.message_id = m.id))
            from public.dm_messages m where m.conversation_id = c.id
            order by m.created_at desc limit 1
          ),
          'unread', (
            select count(*)::int from (
              select 1 from public.dm_messages m
              where m.conversation_id = c.id and m.author_id <> v_me
                and m.created_at > coalesce(me.last_read_at, me.joined_at)
              limit 100) x
          ),
          'sort', coalesce((select max(m.created_at) from public.dm_messages m where m.conversation_id = c.id), c.created_at)
        ) as r
        from public.dm_participants me
        join public.dm_conversations c on c.id = me.conversation_id
        where me.user_id = v_me
      ) t
    ), '[]'::jsonb),

    'friendships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', f.user_id, 'friend_id', f.friend_id, 'status', f.status, 'created_at', f.created_at,
        'other', public.nx_card(p)))
      from public.friendships f
      join public.profiles p on p.id = case when f.user_id = v_me then f.friend_id else f.user_id end
      where f.user_id = v_me or f.friend_id = v_me
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end $$;

-- One-time baseline so existing history doesn't light up as unread the first
-- time the new app opens. Only fills gaps, so re-running changes nothing.
update public.dm_participants set last_read_at = now() where last_read_at is null;
insert into public.channel_read_states (channel_id, user_id, updated_at)
select c.id, sm.user_id, now()
from public.server_members sm
join public.channels c on c.server_id = sm.server_id and c.type in ('text', 'announcement')
on conflict (channel_id, user_id) do nothing;

grant execute on function public.nx_inbox() to authenticated;
grant execute on function public.nx_channel_unreads(uuid) to authenticated;
grant execute on function public.nx_mark_channel_read(uuid) to authenticated;
grant execute on function public.nx_mark_dm_read(uuid) to authenticated;
grant execute on function public.nx_set_pinned(uuid, boolean) to authenticated;
grant execute on function public.nx_card(public.profiles) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Invites respect bans and use limits; kicks and bans can't hit the owner
-- ---------------------------------------------------------------------------
create or replace function public.join_server_by_invite(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invites%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  select * into v_inv from public.invites where code = trim(p_code) limit 1 for update;
  if v_inv.id is null then raise exception 'That invite code does not exist.'; end if;
  if v_inv.expires_at is not null and v_inv.expires_at < now() then raise exception 'That invite has expired.'; end if;
  if exists (select 1 from public.server_members m where m.server_id = v_inv.server_id and m.user_id = auth.uid()) then
    return v_inv.server_id;
  end if;
  if exists (select 1 from public.server_bans b where b.server_id = v_inv.server_id and b.user_id = auth.uid()) then
    raise exception 'You are banned from that server.';
  end if;
  if v_inv.max_uses is not null and v_inv.max_uses > 0 and coalesce(v_inv.uses, 0) >= v_inv.max_uses then
    raise exception 'That invite has been used up.';
  end if;
  insert into public.server_members (server_id, user_id) values (v_inv.server_id, auth.uid()) on conflict do nothing;
  update public.invites set uses = coalesce(uses, 0) + 1 where id = v_inv.id;
  return v_inv.server_id;
end $$;

create or replace function public.kick_member(p_server_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.has_permission(p_server_id, auth.uid(), 32) or public.is_platform_admin(auth.uid())) then
    raise exception 'not authorized';
  end if;
  if p_user_id = auth.uid() then raise exception 'You can''t kick yourself; leave the server instead.'; end if;
  if exists (select 1 from public.servers s where s.id = p_server_id and s.owner_id = p_user_id) then
    raise exception 'The server owner can''t be kicked.';
  end if;
  delete from public.server_members where server_id = p_server_id and user_id = p_user_id;
  insert into public.audit_log (server_id, actor_id, action, target_id) values (p_server_id, auth.uid(), 'kick_member', p_user_id);
end $$;

create or replace function public.ban_member(p_server_id uuid, p_user_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.has_permission(p_server_id, auth.uid(), 64) or public.is_platform_admin(auth.uid())) then
    raise exception 'not authorized';
  end if;
  if p_user_id = auth.uid() then raise exception 'You can''t ban yourself.'; end if;
  if exists (select 1 from public.servers s where s.id = p_server_id and s.owner_id = p_user_id) then
    raise exception 'The server owner can''t be banned.';
  end if;
  insert into public.server_bans (server_id, user_id, banned_by, reason)
  values (p_server_id, p_user_id, auth.uid(), p_reason)
  on conflict (server_id, user_id) do update set reason = excluded.reason, banned_by = excluded.banned_by;
  delete from public.server_members where server_id = p_server_id and user_id = p_user_id;
  insert into public.audit_log (server_id, actor_id, action, target_id, details)
  values (p_server_id, auth.uid(), 'ban_member', p_user_id, jsonb_build_object('reason', p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- 8. Records that only staff (or nobody) may flip from the browser
-- ---------------------------------------------------------------------------
-- A server's platform lock is set by staff; owners can't lift it themselves.
create or replace function public.nx_lock_server_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('authenticated', 'anon') and new.is_platform_locked is distinct from old.is_platform_locked
     and not public.nx_is_platform_admin() then
    raise exception 'Only NexChat staff can lock or unlock a server.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lock_server_fields on public.servers;
create trigger trg_lock_server_fields before update on public.servers
  for each row execute function public.nx_lock_server_fields();

-- A 1:1 DM can't be turned into a group (that would let either side add people).
create or replace function public.nx_lock_dm_fields()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_group is distinct from old.is_group or new.created_by is distinct from old.created_by then
    raise exception 'That conversation setting can''t be changed.';
  end if;
  return new;
end $$;
drop trigger if exists trg_lock_dm_fields on public.dm_conversations;
create trigger trg_lock_dm_fields before update on public.dm_conversations
  for each row execute function public.nx_lock_dm_fields();

-- Storage usage records belong to whoever uploaded the file.
alter table public.storage_objects add column if not exists owner_id uuid references public.profiles(id) on delete set null;
create or replace function public.storage_record(p_key text, p_group uuid, p_endpoint uuid, p_size bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into public.storage_objects (key, group_id, endpoint_id, size, owner_id)
  values (p_key, p_group, p_endpoint, greatest(coalesce(p_size, 0), 0), auth.uid())
  on conflict (key) do update set group_id = excluded.group_id, endpoint_id = excluded.endpoint_id, size = excluded.size
  where public.storage_objects.owner_id is null or public.storage_objects.owner_id = auth.uid() or public.nx_rank(auth.uid()) >= 1;
end $$;
create or replace function public.storage_forget(p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  delete from public.storage_objects
  where key = p_key and (owner_id is null or owner_id = auth.uid() or public.nx_rank(auth.uid()) >= 1);
end $$;

-- ---------------------------------------------------------------------------
-- 9. Private realtime channels (calls, typing, call rings)
-- The app joins these with { private: true }; Realtime checks the policies
-- below when a channel is joined. Topics:
--   nx-presence            everyone signed in
--   nx-call:<user id>      only that user listens; people who share a DM or a
--                          friendship with them may ring
--   voice:dm-<conv id>     participants of that conversation
--   voice:<channel id>     members of that channel's server (and staff who
--                          can view every server)
--   chat:dm:<conv id>      participants (typing indicators)
--   chat:channel:<id>      members of the server
--   nx-inbox:<user id>     that user (database change feed)
--   srv:<server id>        members of that server (database change feed)
-- Once every client runs v3, turn OFF "Allow public access" in
-- Realtime -> Settings so only these private channels exist.
-- ---------------------------------------------------------------------------
create or replace function public.nx_topic_ok(p_topic text, p_write boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_id uuid;
  v_rest text;
  uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if v_me is null or p_topic is null then return false; end if;
  if p_topic = 'nx-presence' then return true; end if;
  if p_topic = 'nx-inbox:' || v_me::text then return true; end if;
  if p_topic like 'srv:%' then
    v_rest := substr(p_topic, 5);
    if v_rest !~ uuid_re then return false; end if;
    return public.is_server_member(v_rest::uuid, v_me) or public.nx_can('view_all_servers');
  end if;

  if p_topic like 'nx-call:%' then
    v_rest := substr(p_topic, 9);
    if v_rest !~ uuid_re then return false; end if;
    v_id := v_rest::uuid;
    if v_id = v_me then return true; end if;
    if not p_write then return false; end if;
    return exists (select 1 from public.dm_participants a join public.dm_participants b on b.conversation_id = a.conversation_id
                   where a.user_id = v_me and b.user_id = v_id)
        or exists (select 1 from public.friendships f where f.status = 'accepted'
                   and ((f.user_id = v_me and f.friend_id = v_id) or (f.user_id = v_id and f.friend_id = v_me)));
  end if;

  if p_topic like 'voice:dm-%' or p_topic like 'chat:dm:%' then
    v_rest := case when p_topic like 'voice:dm-%' then substr(p_topic, 10) else substr(p_topic, 9) end;
    if v_rest !~ uuid_re then return false; end if;
    return public.is_dm_participant(v_rest::uuid, v_me);
  end if;

  if p_topic like 'voice:%' or p_topic like 'chat:channel:%' then
    v_rest := case when p_topic like 'voice:%' then substr(p_topic, 7) else substr(p_topic, 14) end;
    if v_rest !~ uuid_re then return false; end if;
    return exists (
      select 1 from public.channels c
      where c.id = v_rest::uuid
        and ((public.is_server_member(c.server_id, v_me) and not public.channel_hidden_for(c.id, v_me))
             or public.nx_can('view_all_servers'))
    );
  end if;

  return false;
end $$;
grant execute on function public.nx_topic_ok(text, boolean) to authenticated;

drop policy if exists nx_realtime_read on realtime.messages;
create policy nx_realtime_read on realtime.messages for select to authenticated
  using (realtime.messages.extension in ('broadcast', 'presence') and public.nx_topic_ok((select realtime.topic()), false));
drop policy if exists nx_realtime_write on realtime.messages;
create policy nx_realtime_write on realtime.messages for insert to authenticated
  with check (realtime.messages.extension in ('broadcast', 'presence') and public.nx_topic_ok((select realtime.topic()), true));

-- ---------------------------------------------------------------------------
-- 10. Remove leftovers nothing uses any more
-- The bot platform was removed from the app; permission_flags, nx_migrations
-- and custom_emojis were never used. (The bot-api Edge Function can be
-- deleted from Supabase -> Edge Functions too.)
-- ---------------------------------------------------------------------------
drop function if exists public.bot_rate_take(text, integer);
drop table if exists public.bot_rate;
drop table if exists public.dev_tokens;
drop table if exists public.bots;
drop table if exists public.permission_flags;
drop table if exists public.nx_migrations;
drop table if exists public.custom_emojis;
alter table public.profiles drop column if exists bot_owner_id;
alter table public.profiles drop column if exists is_bot;
alter table public.profiles drop column if exists is_developer;

select 'nexchat_v3 ok' as result;
