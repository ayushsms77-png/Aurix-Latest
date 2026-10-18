create table if not exists public.app_flags (key text primary key, enabled boolean not null default true, message text not null default '');
alter table public.app_flags enable row level security;
create policy "flags are readable" on public.app_flags for select to anon, authenticated using (true);
revoke all on public.app_flags from anon, authenticated;
grant select on public.app_flags to anon, authenticated;
insert into public.app_flags (key, enabled, message) values ('sync_play', true, 'Sync Play is under maintenance right now. Please try again later.') on conflict (key) do nothing;
create or replace function public.server_now() returns bigint language sql volatile set search_path = '' as $$ select (extract(epoch from clock_timestamp()) * 1000)::bigint; $$;
revoke all on function public.server_now() from public;
grant execute on function public.server_now() to anon, authenticated;
