-- SmartRing cloud schema. Run this once in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run).
--
-- Every table is keyed by user_id and protected by row-level security:
-- each signed-in user can only ever see and write their own rows.

create table if not exists public.steps_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  date text not null,                    -- local date "YYYY-MM-DD"
  total_steps integer not null default 0,
  total_calories integer not null default 0,
  total_distance_m integer not null default 0,
  buckets jsonb not null default '[]',   -- 15-minute ActivityBucket[]
  synced_at timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists public.hr_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  date text not null,
  interval_minutes integer not null default 5,
  samples jsonb not null,                -- 288 ints, 0 = no reading
  synced_at timestamptz not null default now(),
  primary key (user_id, date)
);

create table if not exists public.sleep_sessions (
  user_id uuid not null references auth.users (id) on delete cascade,
  start_ts bigint not null,              -- epoch millis
  end_ts bigint not null,
  phases jsonb not null,                 -- SleepPhase[]
  synced_at timestamptz not null default now(),
  primary key (user_id, start_ts)
);

create table if not exists public.spo2_hours (
  user_id uuid not null references auth.users (id) on delete cascade,
  ts bigint not null,                    -- epoch millis, top of hour
  min integer not null,
  max integer not null,
  primary key (user_id, ts)
);

alter table public.steps_days enable row level security;
alter table public.hr_days enable row level security;
alter table public.sleep_sessions enable row level security;
alter table public.spo2_hours enable row level security;

do $$
declare t text;
begin
  foreach t in array array['steps_days', 'hr_days', 'sleep_sessions', 'spo2_hours'] loop
    execute format(
      'create policy "own rows" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
      t
    );
  end loop;
end $$;

-- Newer Supabase projects don't auto-grant table privileges to the API roles;
-- RLS still restricts every row to its owner.
grant usage on schema public to authenticated;
grant select, insert, update, delete
  on public.steps_days, public.hr_days, public.sleep_sessions, public.spo2_hours
  to authenticated;
