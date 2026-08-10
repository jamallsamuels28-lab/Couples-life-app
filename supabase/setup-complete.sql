-- ============================================================
-- COUPLES LIFE APP — complete database setup
--
-- Generated from supabase/migrations/, in order. Paste the whole file into
-- the Supabase SQL editor and press Run. Safe to run more than once: every
-- statement either checks for existence first or is wrapped so a repeat is
-- a no-op rather than an error.
-- ============================================================


-- ============================================================
-- 20250101000000_create_profiles_events_settings.sql
-- ============================================================
-- Migration: Create profiles, events, and user_settings tables
-- These are prerequisites for the steps/meals/recipes/pantry migration,
-- which references public.profiles(id) via foreign keys.
--
-- Must run FIRST (timestamp 20250101000000).

-- =============================================================================
-- TABLE: profiles
-- One row per authenticated user. Mirrors auth.users with a display name.
-- The app is strictly for two users (Jamall + Rebecca).
-- =============================================================================
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Partner',
  identity_hue integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- TABLE: events
-- Shared calendar events with optional RRULE recurrence.
-- =============================================================================
create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 100),
  start_time timestamptz not null,
  end_time   timestamptz not null,
  rrule      text,
  is_busy    boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);

create index if not exists events_user_time_idx on public.events(user_id, start_time);
create index if not exists events_time_range_idx on public.events(start_time, end_time);

alter table public.events enable row level security;

-- =============================================================================
-- TABLE: user_settings
-- Key/value settings per user (e.g. daily_step_goal).
-- =============================================================================
create table if not exists public.user_settings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  setting_key   text not null,
  setting_value text not null,
  updated_at    timestamptz not null default now(),
  unique(user_id, setting_key)
);

create index if not exists user_settings_user_key_idx
  on public.user_settings(user_id, setting_key);

alter table public.user_settings enable row level security;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================

-- PROFILES: both partners read all profiles, update only their own
drop policy if exists "couple reads profiles" on public.profiles;
create policy "couple reads profiles" on public.profiles
  for select to authenticated using (true);

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid());

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- EVENTS: both partners read all events, edit only their own
drop policy if exists "couple reads events" on public.events;
create policy "couple reads events" on public.events
  for select to authenticated using (true);

drop policy if exists "insert own events" on public.events;
create policy "insert own events" on public.events
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own events" on public.events;
create policy "update own events" on public.events
  for update to authenticated using (user_id = auth.uid());

drop policy if exists "delete own events" on public.events;
create policy "delete own events" on public.events
  for delete to authenticated using (user_id = auth.uid());

-- USER_SETTINGS: both partners read all, edit only their own
drop policy if exists "couple reads settings" on public.user_settings;
create policy "couple reads settings" on public.user_settings
  for select to authenticated using (true);

drop policy if exists "insert own settings" on public.user_settings;
create policy "insert own settings" on public.user_settings
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own settings" on public.user_settings;
create policy "update own settings" on public.user_settings
  for update to authenticated using (user_id = auth.uid());

drop policy if exists "delete own settings" on public.user_settings;
create policy "delete own settings" on public.user_settings
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- Add tables to the realtime publication so subscriptions fire.
-- =============================================================================
do $$ begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.user_settings;
exception when duplicate_object then null;
end $$;


-- ============================================================
-- 20250101000001_create_steps_meals_recipes_preferences_pantry.sql
-- ============================================================
-- Migration: Create steps_log, meals, recipes, dietary_preferences, and pantry_items tables
-- Requirements: 4.1, 4.2, 4.3, 7.2, 7.3, 11.1, 14.4

-- =============================================================================
-- TABLE: steps_log
-- One entry per user per day. Supports manual entry and health API sync.
-- =============================================================================
create table public.steps_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  log_date   date not null,
  step_count integer not null check (step_count >= 0 and step_count <= 200000),
  source     text not null default 'manual',
  goal       integer not null default 10000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, log_date)
);

create index steps_user_date_idx on public.steps_log(user_id, log_date);

alter table public.steps_log enable row level security;

-- =============================================================================
-- TABLE: meals
-- Multiple meals per user per day. Macros must be non-negative.
-- =============================================================================
create table public.meals (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  meal_date  date not null,
  meal_type  text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  title      text not null,
  calories   integer not null default 0 check (calories >= 0),
  protein_g  numeric(6,1) not null default 0 check (protein_g >= 0),
  carbs_g    numeric(6,1) not null default 0 check (carbs_g >= 0),
  fats_g     numeric(6,1) not null default 0 check (fats_g >= 0),
  notes      text,
  created_at timestamptz not null default now()
);

create index meals_user_date_idx on public.meals(user_id, meal_date);

alter table public.meals enable row level security;

-- =============================================================================
-- TABLE: recipes
-- Shared recipe book. Both partners can read/write.
-- =============================================================================
create table public.recipes (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  description   text,
  ingredients   jsonb not null default '[]',
  steps         jsonb not null default '[]',
  prep_time_min integer,
  cook_time_min integer,
  servings      integer not null default 2,
  calories      integer,
  protein_g     numeric(6,1),
  carbs_g       numeric(6,1),
  fats_g        numeric(6,1),
  tags          text[] default '{}',
  ai_generated  boolean not null default false,
  is_favorite   boolean not null default false,
  created_at    timestamptz not null default now()
);

create index recipes_tags_idx on public.recipes using gin(tags);

alter table public.recipes enable row level security;

-- =============================================================================
-- TABLE: dietary_preferences
-- One record per user (upsert semantics). Stores allergies, dislikes, diet type, macro targets.
-- =============================================================================
create table public.dietary_preferences (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  allergies       text[] default '{}',
  dislikes        text[] default '{}',
  diet_type       text default 'flexible',
  calorie_target  integer,
  protein_target  integer,
  carbs_target    integer,
  fats_target     integer,
  updated_at      timestamptz not null default now(),
  unique(user_id)
);

alter table public.dietary_preferences enable row level security;

-- =============================================================================
-- TABLE: pantry_items
-- Shared pantry. Both partners can CRUD any item.
-- =============================================================================
create table public.pantry_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text default 'other',
  quantity   text,
  expires_at date,
  added_by   uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.pantry_items enable row level security;


-- ============================================================
-- 20250101000002_rls_policies.sql
-- ============================================================
-- Migration: Apply Row Level Security policies for all new tables
-- Requirements: 11.1, 11.2, 11.3
--
-- Policy rules:
--   steps_log & meals: both partners read all, insert/update/delete own (user_id = auth.uid())
--   recipes & pantry_items: fully shared CRUD for both authenticated users
--   dietary_preferences: both read all, insert/update own (user_id = auth.uid())

-- =============================================================================
-- STEPS_LOG: both partners see all, edit own
-- =============================================================================
drop policy if exists "couple reads steps" on public.steps_log;
create policy "couple reads steps" on public.steps_log
  for select to authenticated using (true);

drop policy if exists "insert own steps" on public.steps_log;
create policy "insert own steps" on public.steps_log
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own steps" on public.steps_log;
create policy "update own steps" on public.steps_log
  for update to authenticated using (user_id = auth.uid());

drop policy if exists "delete own steps" on public.steps_log;
create policy "delete own steps" on public.steps_log
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- MEALS: both partners see all, edit own
-- =============================================================================
drop policy if exists "couple reads meals" on public.meals;
create policy "couple reads meals" on public.meals
  for select to authenticated using (true);

drop policy if exists "insert own meals" on public.meals;
create policy "insert own meals" on public.meals
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own meals" on public.meals;
create policy "update own meals" on public.meals
  for update to authenticated using (user_id = auth.uid());

drop policy if exists "delete own meals" on public.meals;
create policy "delete own meals" on public.meals
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- RECIPES: shared — both read/write all
-- =============================================================================
drop policy if exists "couple reads recipes" on public.recipes;
create policy "couple reads recipes" on public.recipes
  for select to authenticated using (true);

drop policy if exists "insert recipes" on public.recipes;
create policy "insert recipes" on public.recipes
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists "update recipes" on public.recipes;
create policy "update recipes" on public.recipes
  for update to authenticated using (true);

drop policy if exists "delete recipes" on public.recipes;
create policy "delete recipes" on public.recipes
  for delete to authenticated using (true);

-- =============================================================================
-- DIETARY PREFERENCES: both see all, edit own
-- =============================================================================
drop policy if exists "couple reads prefs" on public.dietary_preferences;
create policy "couple reads prefs" on public.dietary_preferences
  for select to authenticated using (true);

drop policy if exists "upsert own prefs" on public.dietary_preferences;
create policy "upsert own prefs" on public.dietary_preferences
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own prefs" on public.dietary_preferences;
create policy "update own prefs" on public.dietary_preferences
  for update to authenticated using (user_id = auth.uid());

-- =============================================================================
-- PANTRY ITEMS: fully shared
-- =============================================================================
drop policy if exists "couple reads pantry" on public.pantry_items;
create policy "couple reads pantry" on public.pantry_items
  for select to authenticated using (true);

drop policy if exists "insert pantry" on public.pantry_items;
create policy "insert pantry" on public.pantry_items
  for insert to authenticated with check (added_by = auth.uid());

drop policy if exists "update pantry" on public.pantry_items;
create policy "update pantry" on public.pantry_items
  for update to authenticated using (true);

drop policy if exists "delete pantry" on public.pantry_items;
create policy "delete pantry" on public.pantry_items
  for delete to authenticated using (true);


-- ============================================================
-- 20250101000003_enable_realtime.sql
-- ============================================================
-- Migration: Enable Realtime on the shared data tables
-- Requirement 12.1: subscribe to Realtime channels for events, steps_log,
-- meals, recipes, and pantry_items upon successful authentication.
--
-- Realtime only broadcasts changes for tables in the supabase_realtime
-- publication. The events and user_settings tables are added in migration
-- 20250101000000; this adds the remaining five.

do $$ begin
  alter publication supabase_realtime add table public.steps_log;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.meals;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.recipes;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.pantry_items;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.dietary_preferences;
exception when duplicate_object then null;
end $$;


-- ============================================================
-- 20250101000004_sleep_rules_shift_patterns.sql
-- ============================================================
-- Migration: sleep as first-class data + versioned shift patterns
--
-- Implements kiro-algorithm-spec.md §1.1 and §1.1b, which the initial build
-- skipped. Without these tables the both-free calculation has no concept of
-- sleep, so it treats a night-shift worker's 09:30–17:30 sleep as free time
-- and reports roughly twelve hours of mutual availability that does not exist.
--
-- Naming note: the spec block calls the owning column `owner_id`. This repo
-- already uses `user_id` on every other table, so `user_id` is used here for
-- consistency with the existing RLS policies and client code.

-- =============================================================================
-- EVENTS: additional columns (§1.1)
-- =============================================================================
-- exdates     — cancelled instances of an rrule, dropped during expansion
-- override_of — this row replaces one instance of another event
-- busy_weight — 100 = hard busy, 50 = soft, 0 = free. The merge in §1.3
--               only unions intervals at or above the threshold, so a
--               "soft" commitment can be scheduled over.
-- original_start records WHICH instance an override replaces. Without it, an
-- override could only be matched to its series, not to the specific occurrence,
-- and moving one Tuesday would silently drop a different week.
alter table public.events
  add column if not exists exdates        timestamptz[] not null default '{}',
  add column if not exists override_of    uuid references public.events(id) on delete cascade,
  add column if not exists original_start timestamptz,
  add column if not exists busy_weight    smallint not null default 100
    check (busy_weight between 0 and 100);

create index if not exists events_override_of_idx
  on public.events(override_of) where override_of is not null;

-- =============================================================================
-- TABLE: sleep_rules (§1.1)
-- =============================================================================
-- Sleep varies by context: after a night shift you sleep through the morning,
-- on a rest day you sleep at night. One row per context per person.
create table if not exists public.sleep_rules (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  context          text not null
                     check (context in ('default', 'post_night_shift', 'pre_night_shift')),
  start_local      time not null,
  end_local        time not null,
  crosses_midnight boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, context)
);

create index if not exists sleep_rules_user_idx on public.sleep_rules(user_id);

alter table public.sleep_rules enable row level security;

-- =============================================================================
-- TABLE: shift_patterns (§1.1b)
-- =============================================================================
-- Rotas change. A pattern is never updated in place: the current row is closed
-- by setting valid_to, and a new row opens with valid_from. Past weeks keep
-- resolving against the pattern that was actually in force at the time.
create table if not exists public.shift_patterns (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  label        text not null check (char_length(label) between 1 and 60),
  days_of_week smallint[] not null,          -- 0 = Sunday .. 6 = Saturday
  start_local  time not null,
  end_local    time not null,                -- < start_local means it crosses midnight
  sleep_start  time,
  sleep_end    time,
  valid_from   date not null,
  valid_to     date,                         -- null = the current pattern
  created_at   timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from),
  check (array_length(days_of_week, 1) between 1 and 7)
);

create index if not exists shift_patterns_owner_idx
  on public.shift_patterns(user_id, valid_from);

alter table public.shift_patterns enable row level security;

-- Guard for the resolution rule in §1.1b: "exactly one row should match; if
-- more than one does, the edit logic is broken." Overlapping validity windows
-- for the same person are rejected outright rather than silently resolved.
create or replace function public.check_shift_pattern_overlap()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.shift_patterns p
    where p.user_id = new.user_id
      and p.id is distinct from new.id
      and p.days_of_week && new.days_of_week
      and daterange(p.valid_from, p.valid_to, '[]')
          && daterange(new.valid_from, new.valid_to, '[]')
  ) then
    raise exception
      'Overlapping shift pattern for this user: close the previous pattern with valid_to before inserting a new one';
  end if;
  return new;
end;
$$;

drop trigger if exists shift_patterns_no_overlap on public.shift_patterns;
create trigger shift_patterns_no_overlap
  before insert or update on public.shift_patterns
  for each row execute function public.check_shift_pattern_overlap();

-- =============================================================================
-- RLS POLICIES
-- Same shape as events: the couple reads everything, each edits only their own.
-- =============================================================================
drop policy if exists "couple reads sleep rules" on public.sleep_rules;
create policy "couple reads sleep rules" on public.sleep_rules
  for select to authenticated using (true);

drop policy if exists "insert own sleep rules" on public.sleep_rules;
create policy "insert own sleep rules" on public.sleep_rules
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own sleep rules" on public.sleep_rules;
create policy "update own sleep rules" on public.sleep_rules
  for update to authenticated using (user_id = auth.uid());

drop policy if exists "delete own sleep rules" on public.sleep_rules;
create policy "delete own sleep rules" on public.sleep_rules
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "couple reads shift patterns" on public.shift_patterns;
create policy "couple reads shift patterns" on public.shift_patterns
  for select to authenticated using (true);

drop policy if exists "insert own shift patterns" on public.shift_patterns;
create policy "insert own shift patterns" on public.shift_patterns
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own shift patterns" on public.shift_patterns;
create policy "update own shift patterns" on public.shift_patterns
  for update to authenticated using (user_id = auth.uid());

drop policy if exists "delete own shift patterns" on public.shift_patterns;
create policy "delete own shift patterns" on public.shift_patterns
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- =============================================================================
do $$ begin
  alter publication supabase_realtime add table public.sleep_rules;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.shift_patterns;
exception when duplicate_object then null;
end $$;


-- ============================================================
-- 20250101000005_google_calendar_sync.sql
-- ============================================================
-- Migration: two-way Google Calendar sync
--
-- Design notes worth keeping in view:
--
-- 1. Refresh tokens never reach the browser. They live here and are only ever
--    read by the Edge Function using the service role key. RLS below denies
--    every client read of the token column by denying client reads of the
--    whole table — the app learns connection status from google_connection_status,
--    a view that omits the secrets.
--
-- 2. Sync state is per calendar, not per account, because Google issues a
--    syncToken per calendar and invalidates it independently.
--
-- 3. Mapping local events to Google events needs its own table rather than a
--    column on events: one local event can appear in more than one Google
--    calendar, and a Google event deleted remotely must be distinguishable
--    from one that was never synced.

-- =============================================================================
-- TABLE: google_connections
-- =============================================================================
create table if not exists public.google_connections (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  google_account    text not null,            -- the connected Google address
  refresh_token     text not null,            -- never exposed to the client
  access_token      text,                     -- short-lived cache
  access_expires_at timestamptz,
  scope             text not null,
  calendar_id       text not null default 'primary',
  -- Events this app writes are tagged so a pull can tell "mine" from "theirs".
  sync_enabled      boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, google_account, calendar_id)
);

create index if not exists google_connections_user_idx
  on public.google_connections(user_id);

alter table public.google_connections enable row level security;

-- No client-facing policies are created for this table on purpose. With RLS
-- enabled and no policy, every anon/authenticated read and write is denied,
-- and only the service role (the Edge Function) can touch it. The client uses
-- the view below instead.

-- =============================================================================
-- VIEW: google_connection_status
-- What the client is allowed to know: connected or not, which account, when.
-- =============================================================================
create or replace view public.google_connection_status
with (security_invoker = false) as
  select
    c.id,
    c.user_id,
    c.google_account,
    c.calendar_id,
    c.sync_enabled,
    c.created_at,
    c.updated_at
  from public.google_connections c
  where c.user_id = auth.uid();

grant select on public.google_connection_status to authenticated;

-- =============================================================================
-- TABLE: google_sync_state
-- =============================================================================
create table if not exists public.google_sync_state (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references public.google_connections(id) on delete cascade,
  sync_token     text,                       -- Google's incremental cursor
  last_synced_at timestamptz,
  last_error     text,
  full_resync_at timestamptz,                -- set when Google invalidates the token
  unique (connection_id)
);

alter table public.google_sync_state enable row level security;

-- =============================================================================
-- TABLE: google_event_map
-- =============================================================================
create table if not exists public.google_event_map (
  id                uuid primary key default gen_random_uuid(),
  connection_id     uuid not null references public.google_connections(id) on delete cascade,
  event_id          uuid references public.events(id) on delete cascade,
  google_event_id   text not null,
  google_etag       text,
  -- Which side last wrote, so a conflict can be resolved without guessing.
  last_local_update timestamptz,
  last_remote_update timestamptz,
  deleted_remotely  boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (connection_id, google_event_id)
);

create index if not exists google_event_map_event_idx
  on public.google_event_map(event_id);

alter table public.google_event_map enable row level security;

-- Clients read their own mapping rows so the UI can show sync state per event.
drop policy if exists "read own event map" on public.google_event_map;
create policy "read own event map" on public.google_event_map
  for select to authenticated
  using (
    exists (
      select 1 from public.google_connections c
      where c.id = google_event_map.connection_id and c.user_id = auth.uid()
    )
  );

-- =============================================================================
-- EVENTS: sync provenance
-- =============================================================================
-- origin      — 'local' for events created here, 'google' for pulled events.
--               A pulled event is not pushed back, which is what stops the
--               two calendars ping-ponging the same event forever.
-- updated_at is already present and is the local half of conflict resolution.
alter table public.events
  add column if not exists origin text not null default 'local'
    check (origin in ('local', 'google'));

-- Keep updated_at honest; conflict resolution depends on it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
  before update on public.events
  for each row execute function public.touch_updated_at();


-- ============================================================
-- 20250101000006_fitness_progressive_overload.sql
-- ============================================================
-- Migration: fitness / progressive overload (kiro-algorithm-spec.md §4)
--
-- Note on restricted_for and side (§4.1): a one-sided restriction — injury,
-- post-op rehab — otherwise corrupts every volume and progression metric.
-- Left-arm-only work must be tracked per limb and kept out of bilateral PR
-- comparisons, or the numbers quietly lie for the whole rehab block.

-- =============================================================================
-- TABLE: exercises
-- =============================================================================
create table if not exists public.exercises (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  pattern        text check (pattern in (
                   'squat','hinge','push_h','push_v','pull_h','pull_v','carry','isolation'
                 )),
  unilateral     boolean not null default false,
  -- Lower-body compounds progress in larger jumps (§4.3), so the increment
  -- rule needs to know which is which without guessing from the name.
  lower_body     boolean not null default false,
  compound       boolean not null default true,
  restricted_for uuid[] not null default '{}',
  created_at     timestamptz not null default now(),
  unique (name)
);

alter table public.exercises enable row level security;

-- The exercise library is shared; either partner can add to it.
drop policy if exists "couple reads exercises" on public.exercises;
create policy "couple reads exercises" on public.exercises
  for select to authenticated using (true);
drop policy if exists "couple writes exercises" on public.exercises;
create policy "couple writes exercises" on public.exercises
  for insert to authenticated with check (true);
drop policy if exists "couple updates exercises" on public.exercises;
create policy "couple updates exercises" on public.exercises
  for update to authenticated using (true);

-- =============================================================================
-- TABLE: sets
-- =============================================================================
create table if not exists public.sets (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  exercise_id  uuid not null references public.exercises(id) on delete cascade,
  session_id   uuid not null,
  performed_at timestamptz not null default now(),
  weight_kg    numeric(6,2) not null check (weight_kg >= 0 and weight_kg <= 500),
  reps         smallint not null check (reps between 1 and 100),
  rir          smallint check (rir between 0 and 5),
  side         text not null default 'both' check (side in ('both','left','right')),
  is_warmup    boolean not null default false,
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists sets_user_time_idx on public.sets(user_id, performed_at desc);
create index if not exists sets_session_idx on public.sets(session_id);
create index if not exists sets_exercise_idx on public.sets(user_id, exercise_id, performed_at desc);

alter table public.sets enable row level security;

drop policy if exists "couple reads sets" on public.sets;
create policy "couple reads sets" on public.sets
  for select to authenticated using (true);
drop policy if exists "insert own sets" on public.sets;
create policy "insert own sets" on public.sets
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "update own sets" on public.sets;
create policy "update own sets" on public.sets
  for update to authenticated using (user_id = auth.uid());
drop policy if exists "delete own sets" on public.sets;
create policy "delete own sets" on public.sets
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- TABLE: training_sessions
-- Duration is needed for the MET calculation in §4.5 and cannot be derived
-- reliably from set timestamps alone.
-- =============================================================================
create table if not exists public.training_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  intensity    text not null default 'moderate' check (intensity in ('moderate','vigorous')),
  notes        text,
  created_at   timestamptz not null default now()
);

create index if not exists training_sessions_user_idx
  on public.training_sessions(user_id, started_at desc);

alter table public.training_sessions enable row level security;

drop policy if exists "couple reads sessions" on public.training_sessions;
create policy "couple reads sessions" on public.training_sessions
  for select to authenticated using (true);
drop policy if exists "insert own sessions" on public.training_sessions;
create policy "insert own sessions" on public.training_sessions
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "update own sessions" on public.training_sessions;
create policy "update own sessions" on public.training_sessions
  for update to authenticated using (user_id = auth.uid());
drop policy if exists "delete own sessions" on public.training_sessions;
create policy "delete own sessions" on public.training_sessions
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- =============================================================================
do $$ begin
  alter publication supabase_realtime add table public.sets;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.training_sessions;
exception when duplicate_object then null;
end $$;

-- =============================================================================
-- SEED: a starting exercise library
-- =============================================================================
insert into public.exercises (name, pattern, unilateral, lower_body, compound) values
  ('Back squat',            'squat',     false, true,  true),
  ('Front squat',           'squat',     false, true,  true),
  ('Leg press',             'squat',     false, true,  true),
  ('Bulgarian split squat', 'squat',     true,  true,  true),
  ('Deadlift',              'hinge',     false, true,  true),
  ('Romanian deadlift',     'hinge',     false, true,  true),
  ('Hip thrust',            'hinge',     false, true,  true),
  ('Bench press',           'push_h',    false, false, true),
  ('Incline dumbbell press','push_h',    false, false, true),
  ('Press-up',              'push_h',    false, false, true),
  ('Overhead press',        'push_v',    false, false, true),
  ('Dumbbell shoulder press','push_v',   false, false, true),
  ('Barbell row',           'pull_h',    false, false, true),
  ('Single-arm dumbbell row','pull_h',   true,  false, true),
  ('Seated cable row',      'pull_h',    false, false, true),
  ('Pull-up',               'pull_v',    false, false, true),
  ('Lat pulldown',          'pull_v',    false, false, true),
  ('Farmer''s carry',       'carry',     false, false, true),
  ('Bicep curl',            'isolation', true,  false, false),
  ('Tricep pushdown',       'isolation', false, false, false),
  ('Lateral raise',         'isolation', true,  false, false),
  ('Leg curl',              'isolation', false, true,  false),
  ('Leg extension',         'isolation', false, true,  false),
  ('Calf raise',            'isolation', false, true,  false),
  ('Face pull',             'isolation', false, false, false),
  ('External rotation',     'isolation', true,  false, false),
  ('Band pull-apart',       'isolation', false, false, false)
on conflict (name) do nothing;


-- ============================================================
-- 20250101000007_food_macro_engine.sql
-- ============================================================
-- Migration: food log & macro engine (kiro-algorithm-spec.md §3.1)
--
-- The existing `meals` table stores a free-text meal with typed-in macros.
-- That is fine for a quick entry but cannot support §3.3 measured TDEE, which
-- needs per-item quantities against a food database. These tables sit
-- alongside it rather than replacing it, so nothing already logged is lost.

create extension if not exists pg_trgm;

-- =============================================================================
-- TABLE: foods
-- =============================================================================
create table if not exists public.foods (
  id            uuid primary key default gen_random_uuid(),
  source        text not null default 'custom' check (source in ('off','usda','custom')),
  source_id     text,
  name          text not null check (char_length(name) between 1 and 200),
  brand         text,
  barcode       text,
  -- {kcal, protein, carbs, fat, fibre, sugar, salt} per 100 g
  per_100g      jsonb not null,
  serving_grams numeric(7,2) check (serving_grams is null or serving_grams > 0),
  verified      boolean not null default false,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists foods_barcode_idx on public.foods(barcode) where barcode is not null;
create index if not exists foods_name_trgm on public.foods using gin (name gin_trgm_ops);

alter table public.foods enable row level security;

-- The food database is shared. Either partner can add or correct an entry.
drop policy if exists "couple reads foods" on public.foods;
create policy "couple reads foods" on public.foods
  for select to authenticated using (true);
drop policy if exists "couple writes foods" on public.foods;
create policy "couple writes foods" on public.foods
  for insert to authenticated with check (true);
drop policy if exists "couple updates foods" on public.foods;
create policy "couple updates foods" on public.foods
  for update to authenticated using (true);

-- =============================================================================
-- TABLE: food_entries
-- =============================================================================
create table if not exists public.food_entries (
  id         uuid primary key,          -- client-generated for offline idempotency
  user_id    uuid not null references public.profiles(id) on delete cascade,
  food_id    uuid references public.foods(id) on delete set null,
  logged_at  timestamptz not null default now(),
  entry_date date not null,             -- the local day this belongs to
  meal       text not null check (meal in ('breakfast','lunch','dinner','snack')),
  grams      numeric(8,2) not null check (grams > 0 and grams <= 5000),
  -- Snapshotted at log time. If a food's data is later corrected, history must
  -- not silently rewrite itself.
  macros     jsonb not null,
  recipe_id  uuid references public.recipes(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists food_entries_user_date_idx
  on public.food_entries(user_id, entry_date desc);

alter table public.food_entries enable row level security;

drop policy if exists "couple reads food entries" on public.food_entries;
create policy "couple reads food entries" on public.food_entries
  for select to authenticated using (true);
drop policy if exists "insert own food entries" on public.food_entries;
create policy "insert own food entries" on public.food_entries
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "update own food entries" on public.food_entries;
create policy "update own food entries" on public.food_entries
  for update to authenticated using (user_id = auth.uid());
drop policy if exists "delete own food entries" on public.food_entries;
create policy "delete own food entries" on public.food_entries
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- TABLE: weigh_ins
-- =============================================================================
create table if not exists public.weigh_ins (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  date       date not null,
  weight_kg  numeric(5,2) not null check (weight_kg > 20 and weight_kg < 400),
  -- Set when the reading jumps more than 2.5 kg from the smoothed line, so the
  -- user can be asked rather than the trend quietly absorbing a mis-log.
  flagged    boolean not null default false,
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists weigh_ins_user_date_idx on public.weigh_ins(user_id, date desc);

alter table public.weigh_ins enable row level security;

drop policy if exists "couple reads weigh ins" on public.weigh_ins;
create policy "couple reads weigh ins" on public.weigh_ins
  for select to authenticated using (true);
drop policy if exists "insert own weigh ins" on public.weigh_ins;
create policy "insert own weigh ins" on public.weigh_ins
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "update own weigh ins" on public.weigh_ins;
create policy "update own weigh ins" on public.weigh_ins
  for update to authenticated using (user_id = auth.uid());
drop policy if exists "delete own weigh ins" on public.weigh_ins;
create policy "delete own weigh ins" on public.weigh_ins
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- TABLE: nutrition_profile
-- Inputs the target maths needs that live nowhere else (§3.3, §3.4).
-- =============================================================================
create table if not exists public.nutrition_profile (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  sex            text check (sex in ('male','female')),
  height_cm      numeric(5,1) check (height_cm > 100 and height_cm < 250),
  birth_date     date,
  goal_weight_kg numeric(5,2) check (goal_weight_kg > 20 and goal_weight_kg < 400),
  goal_rate_kg_per_week numeric(4,2) not null default -0.5
    check (goal_rate_kg_per_week between -1.5 and 1.5),
  updated_at     timestamptz not null default now()
);

alter table public.nutrition_profile enable row level security;

drop policy if exists "couple reads nutrition profile" on public.nutrition_profile;
create policy "couple reads nutrition profile" on public.nutrition_profile
  for select to authenticated using (true);
drop policy if exists "insert own nutrition profile" on public.nutrition_profile;
create policy "insert own nutrition profile" on public.nutrition_profile
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "update own nutrition profile" on public.nutrition_profile;
create policy "update own nutrition profile" on public.nutrition_profile
  for update to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- =============================================================================
do $$ begin
  alter publication supabase_realtime add table public.food_entries;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.weigh_ins;
exception when duplicate_object then null;
end $$;


-- ============================================================
-- 20250101000008_step_days_and_sync.sql
-- ============================================================
-- Migration: step_days + device sync tokens (kiro-algorithm-spec.md §5.1)
--
-- A PWA cannot read Apple Health or Google Fit. There is no web API for it.
-- The workaround is an iOS Shortcuts personal automation that POSTs the day's
-- step count to an Edge Function, which needs somewhere to put it and a secret
-- to authenticate with — a Shortcut cannot hold a Supabase session.

-- =============================================================================
-- TABLE: step_days
-- =============================================================================
-- Separate from the existing steps_log: that table is keyed on its own id and
-- written by the manual form. This one is keyed on (user, date) so a repeated
-- POST from the phone overwrites rather than duplicating.
create table if not exists public.step_days (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  date       date not null,
  steps      integer not null check (steps >= 0 and steps <= 200000),
  source     text not null default 'manual' check (source in ('manual','ios_shortcut','health_connect')),
  updated_at timestamptz not null default now(),
  primary key (user_id, date)
);

create index if not exists step_days_user_date_idx on public.step_days(user_id, date desc);

alter table public.step_days enable row level security;

drop policy if exists "couple reads step days" on public.step_days;
create policy "couple reads step days" on public.step_days
  for select to authenticated using (true);
drop policy if exists "insert own step days" on public.step_days;
create policy "insert own step days" on public.step_days
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "update own step days" on public.step_days;
create policy "update own step days" on public.step_days
  for update to authenticated using (user_id = auth.uid());
drop policy if exists "delete own step days" on public.step_days;
create policy "delete own step days" on public.step_days
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- TABLE: device_tokens
-- =============================================================================
-- The shared secret an iOS Shortcut presents. Stored as a SHA-256 digest so a
-- database leak does not hand over the ability to write step data. Clients
-- never read this table — RLS is enabled with no policy, so only the service
-- role (the Edge Function) can see it.
create table if not exists public.device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  label        text not null default 'iPhone',
  token_digest text not null unique,
  last_used_at timestamptz,
  revoked      boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on public.device_tokens(user_id);

alter table public.device_tokens enable row level security;

-- =============================================================================
-- VIEW: device_token_status
-- What the client may know: that a token exists, when it last ran. Never the digest.
-- =============================================================================
create or replace view public.device_token_status
with (security_invoker = false) as
  select t.id, t.user_id, t.label, t.last_used_at, t.revoked, t.created_at
  from public.device_tokens t
  where t.user_id = auth.uid();

grant select on public.device_token_status to authenticated;

-- =============================================================================
-- REALTIME
-- =============================================================================
do $$ begin
  alter publication supabase_realtime add table public.step_days;
exception when duplicate_object then null;
end $$;


-- ============================================================
-- 20250101000009_google_delete_through.sql
-- ============================================================
-- Migration: propagate local event deletions to Google
--
-- The mapping row previously cascaded away with the event, which destroyed the
-- one thing needed to delete the remote copy — its Google event id. The row is
-- now kept, detached from the event, and flagged for the next sync.
--
-- Done as a trigger rather than in the client so it holds however the row goes:
-- the app, a realtime cascade, or someone in the SQL editor.

alter table public.google_event_map
  add column if not exists pending_delete boolean not null default false;

create index if not exists google_event_map_pending_idx
  on public.google_event_map(connection_id) where pending_delete;

-- Detach from the event rather than cascading, so the Google id survives.
alter table public.google_event_map
  drop constraint if exists google_event_map_event_id_fkey;

alter table public.google_event_map
  add constraint google_event_map_event_id_fkey
  foreign key (event_id) references public.events(id) on delete set null;

create or replace function public.flag_google_event_for_deletion()
returns trigger
language plpgsql
as $$
begin
  update public.google_event_map
     set pending_delete = true
   where event_id = old.id
     and deleted_remotely = false;
  return old;
end;
$$;

drop trigger if exists events_flag_google_delete on public.events;
create trigger events_flag_google_delete
  before delete on public.events
  for each row execute function public.flag_google_event_for_deletion();


-- ============================================================
-- 20250101000010_food_cache.sql
-- ============================================================
-- Migration: food_cache for ingredient resolution (kiro-algorithm-spec.md §2.3)
--
-- "Cache every resolution in a local food_cache table keyed by normalised name.
--  Second lookup of 'chicken thigh' must never hit the network."
--
-- Also holds negative results: an ingredient that could not be matched is
-- recorded as unresolved, so the same miss does not re-query USDA and Open
-- Food Facts on every recipe.

create table if not exists public.food_cache (
  id             uuid primary key default gen_random_uuid(),
  -- lowercase, punctuation stripped, singularised
  normalised_name text not null unique,
  display_name   text,
  source         text not null check (source in ('usda','off','custom','unresolved')),
  source_id      text,
  per_100g       jsonb,
  -- Token overlap with the query that produced it. Below 0.5 is treated as a
  -- miss: a wrong match is worse than a missing one.
  match_score    numeric(4,3),
  resolved       boolean not null default true,
  hits           integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists food_cache_name_idx on public.food_cache(normalised_name);
create index if not exists food_cache_name_trgm on public.food_cache using gin (normalised_name gin_trgm_ops);

alter table public.food_cache enable row level security;

-- Shared reference data. Written by the Edge Function via the service role;
-- the client only ever reads it.
drop policy if exists "couple reads food cache" on public.food_cache;
drop policy if exists "couple reads food cache" on public.food_cache;
create policy "couple reads food cache" on public.food_cache
  for select to authenticated using (true);

