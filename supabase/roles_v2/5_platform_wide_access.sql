-- =============================================================================
-- NEXCHAT - ROLES V2, PART 5 OF 6: platform-wide access
-- Run parts 1 to 6 in order in Supabase -> SQL Editor. Safe to re-run.
-- Each part is under 100 lines so it survives copy and paste in full.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 5. Platform-wide access follows the permissions
-- -----------------------------------------------------------------------------
drop policy if exists "nx_super_servers_select" on public.servers;
create policy "nx_super_servers_select" on public.servers for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_members_select" on public.server_members;
create policy "nx_super_members_select" on public.server_members for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_channels_select" on public.channels;
create policy "nx_super_channels_select" on public.channels for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_roles_select" on public.roles;
create policy "nx_super_roles_select" on public.roles for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_member_roles_select" on public.member_roles;
create policy "nx_super_member_roles_select" on public.member_roles for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_messages_select" on public.messages;
create policy "nx_super_messages_select" on public.messages for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_messages_insert" on public.messages;
create policy "nx_super_messages_insert" on public.messages for insert
  with check (author_id = auth.uid() and public.nx_can('post_anywhere'));

drop policy if exists "nx_super_messages_delete" on public.messages;
create policy "nx_super_messages_delete" on public.messages for delete using (public.nx_can('delete_messages'));

drop policy if exists "nx_super_attachments_select" on public.message_attachments;
create policy "nx_super_attachments_select" on public.message_attachments for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_attachments_insert" on public.message_attachments;
create policy "nx_super_attachments_insert" on public.message_attachments for insert
  with check (public.nx_can('post_anywhere')
              and exists (select 1 from public.messages m where m.id = message_attachments.message_id and m.author_id = auth.uid()));

drop policy if exists "nx_super_reactions_select" on public.message_reactions;
create policy "nx_super_reactions_select" on public.message_reactions for select using (public.nx_can('view_all_servers'));

drop policy if exists "nx_super_reactions_insert" on public.message_reactions;
create policy "nx_super_reactions_insert" on public.message_reactions for insert
  with check (user_id = auth.uid() and public.nx_can('post_anywhere'));

-- Announcements and appeals
drop policy if exists "admins post announcements" on public.announcements;
create policy "admins post announcements" on public.announcements
  for insert to authenticated with check (public.nx_can('post_announcements'));

drop policy if exists "admins edit announcements" on public.announcements;
create policy "admins edit announcements" on public.announcements
  for update to authenticated using (public.nx_can('post_announcements')) with check (public.nx_can('post_announcements'));

drop policy if exists "admins delete announcements" on public.announcements;
create policy "admins delete announcements" on public.announcements
  for delete to authenticated using (public.nx_can('post_announcements'));

drop policy if exists "ban_appeals_select" on public.ban_appeals;
create policy "ban_appeals_select" on public.ban_appeals for select
  using (user_id = auth.uid() or public.nx_can('review_appeals'));

drop policy if exists "ban_appeals_update_admin" on public.ban_appeals;
create policy "ban_appeals_update_admin" on public.ban_appeals for update
  using (public.nx_can('review_appeals')) with check (public.nx_can('review_appeals'));

select 'part 5 of 6 done' as status;
