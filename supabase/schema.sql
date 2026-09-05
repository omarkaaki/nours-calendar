-- ===========================================================================
--  Shift Calendar — database schema
--  Paste this whole file into Supabase → SQL Editor → Run. It is safe to run
--  more than once.
--
--  The privacy guarantee lives here, not in the app: every table has Row Level
--  Security switched on with a policy of "auth.uid() = user_id", so Postgres
--  itself refuses to hand back a row that does not belong to the person whose
--  login token made the request. Even someone holding the public anon key and
--  the source code cannot read her data.
-- ===========================================================================

-- ------------------------------------------------------------------ tables
-- The six starting shift types live here as the column default, so a profile
-- created by the trigger is already usable and the .ics feed can name shifts
-- properly. She can rename, recolour and re-time them in the app afterwards.
create table if not exists public.profiles (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  shift_types         jsonb       not null default
    '[{"id":"morning","name":"Morning","color":"#f59e0b","start":"07:00","end":"15:00"},
      {"id":"evening","name":"Evening","color":"#8b5cf6","start":"15:00","end":"23:00"},
      {"id":"night",  "name":"Night",  "color":"#4c1d95","start":"23:00","end":"07:00"},
      {"id":"oncall", "name":"On-call","color":"#ec4899","start":"","end":""},
      {"id":"off",    "name":"Off",    "color":"#94a3b8","start":"","end":""},
      {"id":"leave",  "name":"Leave",  "color":"#10b981","start":"","end":""}]'::jsonb,
  week_start          smallint    not null default 1,
  theme               text        not null default 'auto',
  timezone            text        not null default 'Asia/Beirut',
  shift_alarm_minutes integer     default 120,
  ics_token           uuid        not null default gen_random_uuid(),
  created_at          timestamptz not null default now()
);

create table if not exists public.shifts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  date             date        not null,
  type_id          text,
  start_time       time,
  end_time         time,
  unit             text,
  notes            text,
  reminder_sent_at timestamptz,
  updated_at       timestamptz not null default now(),
  unique (user_id, date)
);

create table if not exists public.events (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  title            text        not null,
  date             date        not null,
  all_day          boolean     not null default false,
  start_time       time,
  end_time         time,
  location         text,
  notes            text,
  color            text        default '#0d9488',
  remind_minutes   integer,
  reminder_sent_at timestamptz,
  updated_at       timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint   text        not null unique,
  p256dh     text        not null,
  auth       text        not null,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists shifts_user_date_idx  on public.shifts (user_id, date);
create index if not exists events_user_date_idx  on public.events (user_id, date);
create index if not exists profiles_ics_idx      on public.profiles (ics_token);
create index if not exists push_user_idx         on public.push_subscriptions (user_id);

-- ------------------------------------------------------------ row security
alter table public.profiles           enable row level security;
alter table public.shifts             enable row level security;
alter table public.events             enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "own profile"       on public.profiles;
drop policy if exists "own shifts"        on public.shifts;
drop policy if exists "own events"        on public.events;
drop policy if exists "own subscriptions" on public.push_subscriptions;

create policy "own profile" on public.profiles
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own shifts" on public.shifts
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own events" on public.events
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own subscriptions" on public.push_subscriptions
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Nothing is readable without a logged-in token.
revoke all on public.profiles, public.shifts, public.events, public.push_subscriptions from anon;

-- ------------------------------------------------ give every new user a row
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who already exists.
insert into public.profiles (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- --------------------------------- repair anything left over from an earlier run
-- A profile with no shift types would make the .ics feed label every shift with
-- its raw id ("night") instead of its name ("Night").
update public.profiles
   set shift_types =
    '[{"id":"morning","name":"Morning","color":"#f59e0b","start":"07:00","end":"15:00"},
      {"id":"evening","name":"Evening","color":"#8b5cf6","start":"15:00","end":"23:00"},
      {"id":"night",  "name":"Night",  "color":"#4c1d95","start":"23:00","end":"07:00"},
      {"id":"oncall", "name":"On-call","color":"#ec4899","start":"","end":""},
      {"id":"off",    "name":"Off",    "color":"#94a3b8","start":"","end":""},
      {"id":"leave",  "name":"Leave",  "color":"#10b981","start":"","end":""}]'::jsonb
 where shift_types is null or jsonb_array_length(shift_types) = 0;
