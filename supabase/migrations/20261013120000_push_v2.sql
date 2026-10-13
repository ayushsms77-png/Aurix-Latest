-- Aurix push notifications v2.
--
-- Design: NO Edge Functions and NO cron. The app registers its push token by calling
-- one database function (register_device) through the REST API with the PUBLISHABLE key.
-- The "Noxy" admin website reads/writes everything with the SECRET key (server side only).
--
-- Access model: RLS is ON for every table, anon/authenticated have NO table grants.
-- The only thing anon can do is run register_device(), which validates and rate-limits.

create table if not exists public.devices (
  id               uuid primary key default gen_random_uuid(),
  expo_push_token  text not null unique
                   check (expo_push_token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$'),
  name             text check (name is null or char_length(name) between 1 and 40),
  platform         text not null default 'android' check (platform in ('android','ios')),
  app_version      text check (char_length(app_version) <= 32),
  active           boolean not null default true,
  disabled_reason  text,
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists devices_active_idx on public.devices (active) where active;
create index if not exists devices_created_idx on public.devices (created_at);

-- One row per message sent from Noxy. audience = 'all' or the device name at send time.
create table if not exists public.notification_messages (
  id            uuid primary key default gen_random_uuid(),
  title         text not null check (char_length(title) between 1 and 65),
  body          text not null check (char_length(body) between 1 and 200),
  audience      text not null default 'all',
  status        text not null default 'sending'
                check (status in ('sending','sent','partial','failed')),
  sent_count    integer not null default 0,
  error_count   integer not null default 0,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  updated_at    timestamptz not null default now()
);
create index if not exists notification_messages_created_idx on public.notification_messages (created_at desc);

-- One row per (message, device). device_id becomes NULL if a device row is ever deleted,
-- so history is never wiped by cleaning devices.
create table if not exists public.notification_deliveries (
  id              bigint generated always as identity primary key,
  message_id      uuid not null references public.notification_messages(id) on delete cascade,
  device_id       uuid references public.devices(id) on delete set null,
  ticket_id       text,
  status          text not null check (status in ('ok','error')),
  error           text,
  receipt_status  text not null default 'pending' check (receipt_status in ('pending','ok','error','unknown')),
  receipt_error   text,
  created_at      timestamptz not null default now(),
  checked_at      timestamptz
);
create index if not exists deliveries_message_idx on public.notification_deliveries (message_id);
create index if not exists deliveries_receipt_idx
  on public.notification_deliveries (created_at) where receipt_status = 'pending' and ticket_id is not null;

-- Server-side switches (read by register_device). registration_enabled = 'true' | 'false'.
create table if not exists public.push_settings (
  key    text primary key,
  value  text not null
);
insert into public.push_settings (key, value) values ('registration_enabled', 'true')
  on conflict (key) do nothing;

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists devices_touch on public.devices;
create trigger devices_touch before update on public.devices
  for each row execute function public.touch_updated_at();
drop trigger if exists messages_touch on public.notification_messages;
create trigger messages_touch before update on public.notification_messages
  for each row execute function public.touch_updated_at();

-- The ONLY thing the app (anon) can call. Validates input, rate-limits, then upserts.
--   returns {"ok":true}                                        saved
--   returns {"ok":false,"reason":"rate_limited","retry_after":N}  too soon / too many new devices
--   returns {"ok":false,"reason":"disabled","retry_after":86400}  switched off in push_settings
--   raises invalid_token (HTTP 400)                              malformed token
create or replace function public.register_device(
  p_token text,
  p_platform text default 'android',
  p_app_version text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled text;
  v_last    timestamptz;
  v_wait    integer;
  v_recent  integer;
begin
  select value into v_enabled from public.push_settings where key = 'registration_enabled';
  if coalesce(v_enabled, 'false') <> 'true' then
    return jsonb_build_object('ok', false, 'reason', 'disabled', 'retry_after', 86400);
  end if;

  if p_token is null or p_token !~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$' then
    raise exception 'invalid_token' using errcode = '22023';
  end if;
  p_platform := case when p_platform = 'ios' then 'ios' else 'android' end;
  p_app_version := left(p_app_version, 32);

  select last_seen_at into v_last from public.devices where expo_push_token = p_token;
  if found then
    -- A known token may be written at most once per 15 minutes.
    if v_last > now() - interval '15 minutes' then
      v_wait := greatest(1, ceil(extract(epoch from (v_last + interval '15 minutes' - now())))::integer);
      return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after', v_wait);
    end if;
  else
    -- Flood guard: at most 30 NEW devices per hour.
    select count(*) into v_recent from public.devices where created_at > now() - interval '1 hour';
    if v_recent >= 30 then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after', 3600);
    end if;
  end if;

  insert into public.devices (expo_push_token, platform, app_version, active, disabled_reason, last_seen_at)
  values (p_token, p_platform, p_app_version, true, null, now())
  on conflict (expo_push_token) do update
    set platform = excluded.platform,
        app_version = excluded.app_version,
        active = true,
        disabled_reason = null,
        last_seen_at = now();
  return jsonb_build_object('ok', true);
end $$;

alter table public.devices                 enable row level security;
alter table public.notification_messages   enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.push_settings           enable row level security;

revoke all on public.devices, public.notification_messages,
              public.notification_deliveries, public.push_settings from anon, authenticated;
revoke execute on function public.touch_updated_at() from public, anon, authenticated;
revoke execute on function public.register_device(text, text, text) from public;
grant  execute on function public.register_device(text, text, text) to anon, authenticated;
