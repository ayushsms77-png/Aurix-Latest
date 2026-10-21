-- Kill-switch for the Video view in the full player (app reads it; ON when missing/unreachable).
insert into public.app_flags (key, enabled, message)
values ('video_play', true, 'Video is under maintenance right now.')
on conflict (key) do nothing;
