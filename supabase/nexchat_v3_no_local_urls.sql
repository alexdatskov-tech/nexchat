-- NexChat: a picture URL that only exists in one browser tab (blob:, file:)
-- can never be stored again, and the one that was is put right.
-- Safe to run more than once.

-- Sloka (@srgaddam4) saved her profile while her new avatar was still
-- uploading, so the tab's preview (blob:https://nex2.tunnel-aegis...) was saved
-- instead. The upload itself finished (15:59 UTC): point the avatar at it.
update public.profiles
set avatar_url = 'https://d1dncmkdpaif79.cloudfront.net/public/alexd.aero26%40gmail.com/nexchats-us1/attachments/users/fa5de857-b942-4f4b-8acf-cfd4472a00fe/mvl5nlm7-xypv-images_2.jpeg'
where username = 'srgaddam4' and avatar_url ~* '^blob:';

-- Anything else like it (none today) goes back to "no picture".
update public.profiles set avatar_url = null where avatar_url ~* '^(blob|file):';
update public.profiles set banner_url = null where banner_url ~* '^(blob|file):';
update public.profiles set banner_gif_url = null where banner_gif_url ~* '^(blob|file):';
update public.servers set icon_url = null where icon_url ~* '^(blob|file):';
update public.servers set banner_url = null where banner_url ~* '^(blob|file):';

alter table public.profiles drop constraint if exists profiles_urls_not_local;
alter table public.profiles add constraint profiles_urls_not_local check (
  coalesce(avatar_url, '') !~* '^(blob|file):'
  and coalesce(banner_url, '') !~* '^(blob|file):'
  and coalesce(banner_gif_url, '') !~* '^(blob|file):'
);

alter table public.servers drop constraint if exists servers_urls_not_local;
alter table public.servers add constraint servers_urls_not_local check (
  coalesce(icon_url, '') !~* '^(blob|file):'
  and coalesce(banner_url, '') !~* '^(blob|file):'
);
