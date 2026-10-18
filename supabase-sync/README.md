# Sync Play Supabase project (separate from ../supabase = notifications)
Run the migration once in the SYNC project. No room/playlist tables exist; rooms live only in Realtime.
Turn Sync Play OFF:  update public.app_flags set enabled=false where key='sync_play';
Turn ON:             update public.app_flags set enabled=true  where key='sync_play';
Edit `message` for the maintenance text. Realtime > Settings: "Allow public access" must be ON.
