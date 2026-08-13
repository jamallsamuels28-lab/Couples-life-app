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
create table if not exists public.steps_log (
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

create index if not exists steps_user_date_idx on public.steps_log(user_id, log_date);

alter table public.steps_log enable row level security;

-- =============================================================================
-- TABLE: meals
-- Multiple meals per user per day. Macros must be non-negative.
-- =============================================================================
create table if not exists public.meals (
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

create index if not exists meals_user_date_idx on public.meals(user_id, meal_date);

alter table public.meals enable row level security;

-- =============================================================================
-- TABLE: recipes
-- Shared recipe book. Both partners can read/write.
-- =============================================================================
create table if not exists public.recipes (
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

create index if not exists recipes_tags_idx on public.recipes using gin(tags);

alter table public.recipes enable row level security;

-- =============================================================================
-- TABLE: dietary_preferences
-- One record per user (upsert semantics). Stores allergies, dislikes, diet type, macro targets.
-- =============================================================================
create table if not exists public.dietary_preferences (
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
create table if not exists public.pantry_items (
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
create policy "couple reads food cache" on public.food_cache
  for select to authenticated using (true);



-- ============================================================
-- 20250101000011_recipe_favorites.sql
-- ============================================================

-- Per-person recipe favourites.
--
-- Favourites lived in localStorage, keyed per user. That made them
-- per-browser rather than per-person: favouriting a recipe on the laptop left
-- it unfavourited on the phone, and clearing site data wiped the lot.
--
-- `recipes.is_favorite` already existed but was never read or written by any
-- code, and could not do this job anyway — it is one boolean on a row shared
-- by both partners, so it can only express "one of us likes this", not which.

create table if not exists public.recipe_favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  recipe_id  uuid not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, recipe_id)
);

create index if not exists recipe_favorites_user_idx
  on public.recipe_favorites(user_id);

alter table public.recipe_favorites enable row level security;

drop policy if exists "couple reads recipe favourites" on public.recipe_favorites;
create policy "couple reads recipe favourites" on public.recipe_favorites
  for select to authenticated using (true);

drop policy if exists "insert own recipe favourites" on public.recipe_favorites;
create policy "insert own recipe favourites" on public.recipe_favorites
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "delete own recipe favourites" on public.recipe_favorites;
create policy "delete own recipe favourites" on public.recipe_favorites
  for delete to authenticated using (user_id = auth.uid());

comment on column public.recipes.is_favorite is
  'Superseded by public.recipe_favorites, which records favourites per person. Not read or written by the app.';

do $$ begin
  alter publication supabase_realtime add table public.recipe_favorites;
exception when duplicate_object then null;
end $$;


-- ============================================================
-- 20250101000013_exercise_library.sql
-- ============================================================

-- Migration: exercise library metadata (kiro-algorithm-spec.md §4.1)
--
-- The exercises table held only what the progression maths needs: pattern,
-- unilateral, lower_body, compound. That is enough to compute an e1RM and
-- rank a lift, and not enough to answer "what should I do for shoulders" or
-- "how is this meant to look". With 27 seeded rows it was a lookup list, not
-- a library.
--
-- These columns are reference material. Nothing here feeds a calculation, so
-- an exercise with no image or a thin description still logs and progresses
-- exactly as before — deliberately, so importing third-party data can never
-- move a training number.

alter table public.exercises
  -- ExRx-style taxonomy: browse by body part, then narrow by equipment.
  add column if not exists category          text,
  add column if not exists primary_muscles   text[] not null default '{}',
  add column if not exists secondary_muscles text[] not null default '{}',
  add column if not exists equipment         text[] not null default '{}',
  add column if not exists description       text,
  add column if not exists image_url         text,
  add column if not exists video_url         text,
  -- Provenance. Imported rows carry their licence and author so attribution
  -- survives in the data rather than living only in a comment nobody reads.
  add column if not exists source            text not null default 'builtin',
  add column if not exists source_id         text,
  add column if not exists license           text,
  add column if not exists license_author    text;

-- Browsing is always "show me everything for this body part", so the index
-- follows the taxonomy rather than the name.
create index if not exists exercises_category_idx
  on public.exercises(category) where category is not null;

create index if not exists exercises_primary_muscles_idx
  on public.exercises using gin (primary_muscles);

create index if not exists exercises_equipment_idx
  on public.exercises using gin (equipment);

-- Name search, matching how foods are searched.
create index if not exists exercises_name_trgm
  on public.exercises using gin (name gin_trgm_ops);

-- An imported exercise is identified by (source, source_id) so re-running the
-- seed updates rather than duplicates. The existing unique constraint on name
-- cannot do this: two legitimate variants can share a name across sources.
create unique index if not exists exercises_source_ref_idx
  on public.exercises(source, source_id)
  where source_id is not null;

comment on column public.exercises.source is
  'builtin for the original hand-seeded rows, wger for imported ones.';
comment on column public.exercises.license is
  'Licence of the imported description/images. Must be honoured when displaying them.';


-- ============================================================
-- 20250101000014_seed_exercise_library.sql
-- ============================================================

-- Migration: seed the exercise library from wger
--
-- GENERATED by scripts/build-exercise-seed.mjs — do not hand-edit. Re-run the
-- script to regenerate.
--
-- Source: https://wger.de (open exercise database, fetched via its public API)
-- Licences present: CC-BY-SA 4, CC0, CC-BY-SA 3
-- Each row carries its own license and license_author, which must be honoured
-- wherever its description or image is displayed. CC-BY-SA in particular
-- requires attribution and share-alike on the text.
--
-- NOT sourced from ExRx.net: that content is copyrighted and the site refuses
-- automated access. Its taxonomy — browse by body part, narrow by equipment —
-- is a structure rather than an expression, and is what this follows.
--
-- Exercises kept: 722 of 863 fetched
-- With a description: 700 · with an image: 232 · with a video: 45
-- By category: Legs 166, Back 128, Arms 121, Abs 102, Shoulders 90, Chest 75, Cardio 31, Calves 9
-- Skipped 128: no primary muscle
-- Skipped 13: no usable name
--
-- pattern and unilateral are INFERRED from the exercise name, because wger
-- records neither. Both feed real maths — §4.3 picks the load increment from
-- pattern, §4.4 totals volume by it, and §4.1 keeps unilateral sets out of
-- bilateral PR comparisons — so check the ones you actually train. They are
-- heuristics over names, not facts from the source.
-- Inferred unilateral: 42

insert into public.exercises
  (name, pattern, unilateral, lower_body, compound,
   category, primary_muscles, secondary_muscles, equipment,
   description, image_url, video_url, source, source_id, license, license_author)
values
  ('Step Jack', null, false, false, true, 'Cardio', '{"Quads"}', '{"Shoulders","Glutes","Obliquus externus abdominis","Abs"}', '{"Bodyweight"}', 'The Step Jack is a low-impact plyometric-style move that provides cardiovascular benefits without the joint stress of jumping. It works the entire body, specifically targeting the legs, core, and shoulders. This move is ideal for beginners, individuals with joint sensitivities, or as a dynamic warm-up to gradually elevate the heart rate.
Notes (Instructions):

​Stand upright with your feet together and arms at your sides.
​Step your right foot out to the side while simultaneously swinging both arms up above your head.
Bring your right foot back to the center and lower your arms.
​Immediately repeat the movement, stepping out with your left foot.
​Continue alternating sides at a steady, rhythmic pace.', 'https://wger.de/media/exercise-images/1962/74041371-1019-4f89-9ebe-cec792484a46.png', null, 'wger', '2f10d91f-6c12-471b-bb9e-80840a56ce01', 'CC-BY-SA 4', 'Anon#2'),
  ('Slow Squat', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Hamstrings","Glutes","Abs"}', '{"Bodyweight"}', '​A tempo-based squat that uses controlled movement to increase muscle tension and improve lower-body stability.

​Lower: Descend slowly for 3 seconds.
​Pause: Hold at the bottom for 1 second.
​Stand: Return to the starting position at a normal pace.
Form: Keep your chest up and weight in your heels.', 'https://wger.de/media/exercise-images/1963/db285682-1ab3-4be0-ae00-5117ecce1ee6.png', null, 'wger', '2398e14f-02a6-4fdc-9f69-029e52dfe033', 'CC-BY-SA 4', 'Anon#2'),
  ('Wide Push-Up', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Abs","Triceps"}', '{"Bodyweight"}', '​A push-up variation with a wider hand placement to increase the emphasis on the outer chest muscles and shoulders.

​Setup: Place hands wider than shoulder-width apart on the floor.
Lower: Descend until your chest nearly touches the floor, keeping your core tight.
​Push: Drive through your palms to return to the start position.
​Form: Don''t let your lower back sag; keep a straight line from head to heels.', null, null, 'wger', '1842e1be-ac67-4f34-a527-4ca2b72d8e11', 'CC-BY-SA 4', 'Anon#2'),
  ('Marching High Knees', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Calves","Glutes","Abs"}', '{"Bodyweight"}', 'A low-impact cardio and mobility exercise that strengthens the hip flexors and improves balance.

​Movement: Stand tall and lift one knee toward your chest as high as comfortable.
​Arms: Swing the opposite arm forward as you lift your knee, similar to a walking motion.
​Core: Keep your abs engaged to maintain an upright posture.
​Pace: Perform the movement with control, alternating legs rhythmically.', 'https://wger.de/media/exercise-images/1965/03c08a42-dedb-4a46-8d15-acaf497a35a2.png', null, 'wger', 'fad49a13-b2a0-4b1f-b262-29b32248257d', 'CC-BY-SA 4', 'Anon#2'),
  ('Band Terminal Knee extension', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{"Resistance band"}', 'This is an end range strengthening exercise for the knee extensors. Start by looping a band around the back of one knee and anchoring the other end to a stable surface in front of you. Stand in a split stance with the banded knee bent and placed as the front leg. Straighten the knee to pull against the bands resistance and maintain a contraction in your quadriceps for up to 5 seconds before releasing.', 'https://wger.de/media/exercise-images/2494/02f1ae86-d374-4b5a-b314-a76c487ea1e9.png', null, 'wger', '3096b34e-1781-4f99-8187-d9acac8e712b', 'CC-BY-SA 4', 'Rehab Hero'),
  ('Lento avanti seduto', 'pull_h', false, false, false, 'Back', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'slow controlled seated forward exercise with dumbbells', null, null, 'wger', '85cb0a1b-250e-400b-892b-50186dac0777', 'CC-BY-SA 4', 'Cf'),
  ('Single-arm dumbbell shoulder press', 'push_v', true, false, true, 'Shoulders', '{"Shoulders"}', '{"Abs","Serratus anterior","Trapezius","Triceps"}', '{"Dumbbell"}', 'Press the dumbbell vertically overhead in a controlled motion until your arm is fully extended, without locking the elbow. Slowly lower the dumbbell back to the starting position at shoulder height.', 'https://wger.de/media/exercise-images/1968/cd92e973-a0d9-4e5f-9011-5369012598d3.png', null, 'wger', '9dfce8f0-39fc-4204-9f84-500ec42074e9', 'CC-BY-SA 4', 'evtimovgeorg'),
  ('Kettlebell sumo high pull', 'pull_h', false, false, true, 'Back', '{"Trapezius"}', '{"Shoulders","Hamstrings","Glutes","Quads"}', '{"Kettlebell"}', 'A compound exercise combining elements of a sumo deadlift and a high pull. It targets the posterior chain, particularly the glutes, hamstrings, and upper back. The sumo stance increases hip engagement, while the high pull adds an explosive element, promoting power development.

Stand upright overtop of a kettlebell with your feet wider than shoulder-width apart angled out slightly.
Maintain a braced core and neutral spine throughout the exercise.
Hinge your hips backward and extend your arms to grab ahold the kettlebell with a double overhand grip.
With you lower legs nearly vertical to the ground, extend your hips to raise the kettlebell with your elbows high keeping it close to your body.
Once the kettlebell has reached shoulder height, lower back to the starting position.', null, null, 'wger', '03960339-fe14-4670-a7b3-4974b859ed37', 'CC-BY-SA 4', 'wgerpott'),
  ('Single Arm Plank to Row', 'pull_h', true, false, true, 'Back', '{"Shoulders","Biceps","Brachialis","Lats","Obliquus externus abdominis","Abs","Serratus anterior"}', '{}', '{"Kettlebell"}', 'Start position as row, extend to plank and back. Finish with row and repeat', 'https://wger.de/media/exercise-images/1022/f74644fa-f43e-46bd-8603-6e3a2ee8ee2d.jpg', null, 'wger', '768e0703-a04d-4d97-89ce-a49cd6be2b06', 'CC-BY-SA 4', null),
  ('Hip Airplane', 'squat', false, true, true, 'Legs', '{"Glutes"}', '{"Hamstrings","Calves","Soleus"}', '{"Kettlebell"}', 'Stand on one leg and lean your upper body slightly forward while keeping your back straight. Extend the free leg behind you so that your torso and leg form roughly one line. Slowly open your hip to the side by rotating your pelvis and upper body in a controlled way. Then close the hip again and return to the starting position.

The movement should mainly come from the hip. Keep your standing foot stable and avoid letting your knee collapse inward.', null, null, 'wger', '553fb643-32f0-447f-aecb-cdf75398d742', 'CC-BY-SA 4', 'TobiasFalk'),
  ('YTW Raises', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Bodyweight"}', 'The YTW exercise for scapular retraction is designed to strengthen the inter-scapular muscles between your shoulder blades, to help retract or pull your shoulders back, helping to maintain proper upright posture.', null, null, 'wger', '142fcef5-63a7-4d30-81e4-bc9d7073fe99', 'CC-BY-SA 4', 'probablyforging'),
  ('Kettlebell Swing', 'hinge', false, true, true, 'Legs', '{"Shoulders","Glutes"}', '{"Quads","Abs","Trapezius"}', '{"Kettlebell"}', 'While kettlebell swings are a full-body workout, they mostly target the muscles along the posterior chain (back of the body). The main muscles used are the glutes, hamstrings, spinal erectors, and muscles of the upper back.', 'https://wger.de/media/exercise-images/960/da4d0560-da89-4bb5-b91f-746458fb04ad.png', null, 'wger', 'd813ef7c-b10a-4c5c-ba55-6b9518e7ff4c', 'CC-BY-SA 4', 'clafal'),
  ('Box squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads","Soleus"}', '{}', '{"Bodyweight"}', 'Set up the box: Position the box behind you, about 3 feet from a squat rack if you''re using a barbell. Choose a height that allows you to squat down and gently tap your glutes on the box with your back straight.
Stand with proper form: Stand with your feet shoulder-width apart, toes pointed slightly outward. Engage your core and keep your back neutral. If using a barbell, rack it at shoulder height.
Lower down: Sit back as if going to sit on a chair, bending your knees and lowering your hips towards the box. Keep your core tight and back straight throughout the movement.
Controlled descent: Descend in a controlled manner until your glutes gently touch the box. Don''t plop down.
Pause and press up: Briefly pause at the bottom with your back straight and core engaged. Then, press through your heels to drive yourself back up to the starting position.

Improvements in coordination, balance and endurance, toning of the leg and buttock muscles and an overall increase in bone density eliminating the risk of osteoporosis.', 'https://wger.de/media/exercise-images/977/3124c091-6395-4377-96c5-56048b627ceb.png', null, 'wger', '151434a5-c046-459f-a3a9-c3125075856f', 'CC-BY-SA 4', 'clafal'),
  ('Commando pull-ups', 'pull_h', false, false, true, 'Back', '{"Shoulders","Biceps","Lats","Trapezius"}', '{}', '{"Pull-up bar"}', 'variation of the pull-up exercise, it is performed with a grip of one hand supine and one hand prone, do not twist the torso to get back to the front, the head passes once to one side, once to the other.', null, null, 'wger', 'e872658a-3bac-4d9e-bcf2-15919ebea43a', 'CC-BY-SA 4', 'clafal'),
  ('Incline Bench Reverse Fly', 'push_h', false, false, false, 'Back', '{"Shoulders","Trapezius"}', '{}', '{"Dumbbell","Incline bench"}', 'The incline dumbbell reverse fly is an upper-body exercise targeting the posterior or rear deltoids, as well as the postural muscles of the upper back. Because it targets such small muscles, this exercise is usually performed with light weight for high reps, such as 10-15 reps per set or more.', 'https://wger.de/media/exercise-images/828/2e959dab-f39b-4c7c-9063-eb43064ab5eb.png', null, 'wger', '70c99a4e-3340-4993-a7f1-2d2709dada1a', 'CC-BY-SA 4', 'cshep442'),
  ('Body-Ups', 'isolation', false, false, true, 'Arms', '{"Triceps"}', '{"Shoulders","Abs"}', '{"Bodyweight"}', 'Assume a plank position on the ground. You should be supporting your bodyweight on your toes and forearms, keeping your torso straight. Your forearms should be shoulder-width apart. This will be your starting position.
Pressing your palms firmly into the ground, extend through the elbows to raise your body from the ground. Keep your torso rigid as you perform the movement.
Slowly lower your forearms back to the ground by allowing the elbows to flex.
Repeat as needed.', null, null, 'wger', 'd551f24d-44fe-4761-9448-edf14d627827', 'CC-BY-SA 4', 'cal.zabel'),
  ('Speed Deadlift', 'hinge', false, true, true, 'Legs', '{"Hamstrings","Glutes"}', '{"Quads","Trapezius"}', '{}', 'Deadlift with short (less than one 1min) rest between sets.', null, null, 'wger', 'b1051c3e-78a9-4b73-899c-c700098cf1a8', 'CC-BY-SA 4', 'MrSteele'),
  ('Pullup on fingerboard', 'pull_v', false, false, true, 'Arms', '{"Biceps","Lats"}', '{"Brachialis","Trapezius"}', '{"Bodyweight"}', 'Pullup on a choosen edge of a fingerboard / hangboard', null, null, 'wger', 'a540925e-fe66-47cc-ae28-ecdce408fb6d', 'CC-BY-SA 4', 'marcelbader'),
  ('Glute-Ham Raise', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{"Glutes"}', '{"Bench"}', 'Kneel on a glute-ham developer or have a partner hold your ankles. Keeping hips straight, lower your torso toward the floor under control, then curl back up by contracting the hamstrings and glutes.', null, null, 'wger', '537b41a8-870b-4b45-b8a5-e9672c6a359b', 'CC0', 'personal use'),
  ('Easy Continuous Swim (Freestyle)', null, false, false, true, 'Cardio', '{"Shoulders","Lats","Chest"}', '{"Hamstrings","Calves","Glutes","Quads","Abs","Triceps"}', '{}', 'Swim freestyle at a relaxed, steady pace without stopping — think conversation pace, not racing. Focus on smooth, even strokes rather than speed or breathing technique; this is just to get your body moving and your heart rate up.', null, null, 'wger', 'ddf4111d-907d-4d6c-b583-58323b96ca03', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Lying Dumbbell Row SS Seated Shrug', 'pull_h', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Biceps"}', '{"Dumbbell"}', 'laying on the stomach on a bench with slight angle', null, null, 'wger', 'dab7400b-e86e-4224-bcea-4a915dc928e0', 'CC-BY-SA 4', 'novadani'),
  ('Biceps with TRX', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Bodyweight"}', 'Grab the handles of the TRX straps, lean your body back, arms and legs extended, with your body positioned in a single straight line. (This is an arm exercise, not an abdominal one.)', 'https://wger.de/media/exercise-images/958/947ac249-475d-44ed-bed3-8dc433374f59.png', null, 'wger', '596b9d2d-0f01-41a0-97e1-1839ffdb824d', 'CC-BY-SA 4', 'clafal'),
  ('TRX Rows', 'pull_h', false, false, true, 'Back', '{"Shoulders","Biceps","Lats"}', '{}', '{"Bodyweight"}', 'This exercise serves as a lead-up to Pull Ups.', 'https://wger.de/media/exercise-images/959/53a5e008-bc31-4ee0-9463-69a858c2ec18.png', null, 'wger', 'e2599e86-d8b0-434e-8a48-aa3c2df7e790', 'CC-BY-SA 4', 'clafal'),
  ('Suspended crossess', null, false, false, false, 'Cardio', '{"Chest"}', '{}', '{"Bodyweight"}', 'Suspension exercise with trx for chest training', 'https://wger.de/media/exercise-images/927/7b392101-9c47-4693-935e-a88b1887eec5.jpg', null, 'wger', 'e0d9e9ef-09ee-4d26-9504-622093810414', 'CC-BY-SA 4', null),
  ('Forearm Plank (Core L1)', 'isolation', false, false, false, 'Abs', '{"Calves"}', '{}', '{"Bodyweight"}', 'Vasco custom forearm plank - foundational anterior core stability exercise. Teaches full-body tension, breath control, and anti-extension. Prerequisite for all advanced core work.', null, null, 'wger', '0c6764f2-fb86-43f1-bd35-04a35f74d5e4', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Step-ups', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Calves"}', '{"Bench"}', 'Starting position:

Stand facing a chair.

Steps:

Step up onto the chair.
Step off the chair.
Repeat.', 'https://wger.de/media/exercise-images/981/f9377a7e-eb58-4cca-b805-2d36863aeb03.png', null, 'wger', '9e6dae29-5d03-440a-bdf1-2cb25a5179c2', 'CC-BY-SA 4', null),
  ('Push-up rotations', 'push_h', false, false, true, 'Arms', '{"Chest","Triceps"}', '{"Shoulders","Obliquus externus abdominis"}', '{"Bodyweight"}', 'Starting position:

Get into the starting push-up position, with your hands and toes touching the ground and back, arms and legs straight. To get to this position, you can lie down on your stomach, place your hands facing down next to your head, and lifting your arms up until they are straight.

Steps:

Perform a standard push-up:

1.a Bend arms until chest almost touches the ground, making sure the back is straight.1.b Use your arms to lift yourself back up to starting position.

Rotate your body to the side so that the back is straight, the bottom hand supporting the body is fully extended, and only the bottom hand and foot touch the floor.
Repeat, changing sides at step 2 each time.', null, null, 'wger', 'a9633731-1d86-4b4a-996f-33a1dee0b0e1', 'CC-BY-SA 4', null),
  ('Kneeling kickbacks', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Starting position:

Get down on all fours.

Steps:

Push one foot back until fully extended, concentrating on the gluteus muscles.
Stay for one second, then return to the initial position.
Repeat, alternating feet.', 'https://wger.de/media/exercise-images/990/de20457c-914a-45c9-8cf9-0ad9739759a1.png', null, 'wger', '6ddea666-5a57-4ac0-926f-01f8cfdaa4fd', 'CC-BY-SA 4', null),
  ('Tricep Pushdown on Cable', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'The cable rope push-down is a popular exercise targeting the triceps muscles. It''s easy to learn and perform, making it a favorite for everyone from beginners to advanced lifters. It is usually performed for moderate to high reps, such as 8-12 reps or more per set, as part of an upper-body or arm-focused workout.', 'https://wger.de/media/exercise-images/805/7a437824-e2cc-46e1-804a-674f0ea31d25.png', null, 'wger', 'ea63d85c-8579-4dda-b99f-c4c8930f9af6', 'CC-BY-SA 4', 'cshep442'),
  ('Straight Bar Cable Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Cable machine"}', 'Standing upright in front of Cable Tower using a straight bar', 'https://wger.de/media/exercise-images/912/e10a034f-6370-4dd6-b1c2-416b27844529.png', null, 'wger', '36274d27-3812-4b8c-80e2-ab59acf82c4d', 'CC-BY-SA 4', 'novadani'),
  ('Mentzer Pulldown', 'pull_v', false, false, false, 'Arms', '{"Biceps"}', '{"Lats"}', '{"Cable machine","Incline bench"}', 'Close grip front facing Pull down, while focusing on Biceps, Increases activation of biceps over the whole range, Avoid activating Lats.', 'https://wger.de/media/exercise-images/1971/729af526-19a0-4d3d-a258-196c7575d139.jpg', null, 'wger', 'c4185277-1d30-4684-9bc0-024ab7f2336a', 'CC-BY-SA 4', 'Mike Mentzer'),
  ('Single-Arm Lat Pulldown', 'pull_v', true, false, true, 'Back', '{"Lats","Trapezius"}', '{"Biceps","Brachialis"}', '{"Cable machine"}', 'Sit at the lat pulldown machine and grab the single handle with a neutral grip. Keep your torso stable, your chest lifted, and your shoulder blades slightly retracted. Start with your arm fully extended overhead, then pull the handle down toward your upper chest following a controlled, slightly diagonal path. Focus on engaging the latissimus dorsi while keeping the shoulder depressed and avoiding any torso rotation. Slowly return to the starting position, maintaining full control throughout the movement.', null, null, 'wger', 'b86fd8df-e726-4998-a7ee-000de0f70bf0', 'CC-BY-SA 4', 'evtimovgeorg'),
  ('Tricep Pull-Down', 'pull_v', false, false, false, 'Arms', '{"Triceps"}', '{"Chest"}', '{"Resistance band"}', 'Secure Band above you.

Stand facing band, with feet hip-width apart.
Bend your knees slightly to engage your core.
Keep your chest up, pin your shoulder blades back, and tuck your elbows tightly to the sides of your torso.
Exhale and pull the band straight down toward your thighs.
Inhale and slowly control the band as you let your arms return upwards to their starting position.', null, null, 'wger', '42cdddc2-970e-445c-a766-f6562bf63069', 'CC-BY-SA 4', 'G. Johnson'),
  ('Posterior Pelvic Tilt', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Glutes","Obliquus externus abdominis"}', '{"Bodyweight"}', 'Lie on your back with knees bent, feet flat on the floor. Flatten your lower back against the floor by tilting your pelvis posteriorly, engaging your abs and glutes. Hold 5 seconds, release. This retrains pelvic positioning to counter anterior pelvic tilt.', null, null, 'wger', '0e8fd83f-4e97-4749-b5fd-da9d0e85e97a', 'CC-BY-SA 4', 'Raj'),
  ('Low row', 'pull_h', false, false, true, 'Back', '{"Trapezius"}', '{"Biceps","Lats"}', '{}', 'Based on Low Row Sel. by Technogym. In this version, you use it with two arms.', null, null, 'wger', 'bbcf5019-a57f-4e67-bd44-98cba129a0b7', 'CC-BY-SA 4', 'lbroggi'),
  ('Pulley (low, with triangle)', 'pull_h', false, false, true, 'Back', '{"Biceps","Lats"}', '{"Trapezius"}', '{}', 'This exercise is based on Technogym Pulley Sel. Hold the triangle with both hands and bring the weight towards your belly.', null, null, 'wger', '1bda9167-805e-4c7d-aafc-57cdcf5b6d7d', 'CC-BY-SA 4', 'lbroggi'),
  ('Abductors', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{}', 'Based on Abductors Sel. by Technogym.
Position yourself on the machine and open your legs as much as possible.
Return slowly to the original position.', null, null, 'wger', 'd02f6fe0-8ae3-4251-8f94-a63e38249a55', 'CC-BY-SA 4', 'lbroggi'),
  ('Adductors', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{}', 'Based on Adductor Sel. by Technogym.
Sit on the machine and set the rest position to a comfortable opening angle.
Close your legs.
Gently return to the rest position.', null, null, 'wger', '701d9cee-0797-4177-8556-252de669b56c', 'CC-BY-SA 4', 'lbroggi'),
  ('Adductor Side Plank', 'squat', false, true, false, 'Legs', '{"Hamstrings","Glutes"}', '{}', '{"Bench"}', 'Set up next to a bench in a 90° angle on your side. One leg goes up on the bench with the side of your calf touching it. The other leg goes below the bench. Forearm closer to the ground is at a 90° angle, hand pointing front. Now push off the floor with the forearm closer to the ground, upper side of your body should be completely straight, level with the bench (it''s a side plank after all). Hold that position.', null, null, 'wger', '1c60ade0-1e8c-475b-b2d3-bfdf313987f4', 'CC-BY-SA 4', 'hurr99'),
  ('Bear Walk 2', 'push_h', false, false, true, 'Chest', '{"Shoulders","Calves","Chest","Abs","Serratus anterior","Soleus","Triceps"}', '{"Glutes","Lats","Obliquus externus abdominis","Quads","Trapezius"}', '{"Bodyweight"}', '-Rest your weight on your palms and the balls of your feet, not dissimilar to normal pushup position

-Move by stepping with your R palm and L foot, then your L palm and R foot. Basically, walk like a lumbering bear.

-Move as fast as you can. Measure your reps/sets in either distance (i.e. 40 yards) or time (i.e. 45 seconds)

-Works your Pecs, Deltoids, Triceps, Traps, Lats, Abs and Lower Back, Hip Flexors, Quads, Glutes and Calves', null, null, 'wger', 'b7267f90-8706-442b-b918-507e16092b8e', 'CC-BY-SA 4', 'nate303303'),
  ('One-handed kettlebell curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Kettlebell"}', 'Standing with the kettlebell in one hand and bent at the elbow, start from a fully extended position until your hand reaches shoulder height. To perform the movement correctly, try not to push with your back or body.', 'https://wger.de/media/exercise-images/975/41d9267a-99bc-4e94-b1c4-0e39fe7a968f.png', null, 'wger', 'd7d4fc16-08cd-4568-87e7-d9e4e2f77393', 'CC-BY-SA 4', 'clafal'),
  ('Medicine ball booklet crunch', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Using a medicine ball as an overload will make the exercise heavier.', 'https://wger.de/media/exercise-images/976/94649ea6-bf58-4fd9-90c1-b2ec96ee20cd.png', null, 'wger', '346634cf-3896-4c10-bd66-28fb69d02573', 'CC-BY-SA 4', 'clafal'),
  ('Knee Raises', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Pull-up bar"}', 'The 90° leg raise on the bar is a very intense exercise that involves all the abdominal muscles.', 'https://wger.de/media/exercise-images/978/d3ffe51f-7eb8-4cc9-9eae-105847af3005.png', null, 'wger', 'f4991a98-6422-4884-8ad3-43412f91fac1', 'CC-BY-SA 4', 'clafal'),
  ('Barbell Ab Rollout', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{}', '{"Barbell"}', 'Place a barbell on the floor at your feet.

Bending at the waist, grip the barbell with a shoulder with overhand grip.

With a slow controlled motion, roll the bar out so that your back is straight.

Roll back up raising your hips and butt as you return to the starting position.', 'https://wger.de/media/exercise-images/41/34b37423-269f-43d4-9d29-d2a90eeaa6b4.png', null, 'wger', 'a6bced3c-72f5-42a3-9438-5569d46f49fd', 'CC-BY-SA 4', 'sevae'),
  ('Elliptical', null, false, false, true, 'Cardio', '{"Glutes","Quads","Trapezius"}', '{"Biceps","Abs","Triceps"}', '{"Bodyweight"}', 'It improves muscle toning, strengthens the leg muscles (quads, glutes, calves), helps vascularisation and increases resistance. The elliptical is also very useful if you aim to lose weight. Teste', null, null, 'wger', '95a300de-2ad8-492e-9364-13766d9e7618', 'CC-BY-SA 4', 'clafal'),
  ('Reverse Nordic Curl', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Glutes","Abs"}', '{}', 'Natural Leg Extension is alternative to Leg Extension machine with no equipment.', 'https://wger.de/media/exercise-images/909/159222d9-c1e4-46ae-89ee-6a2dfaab978d.png', null, 'wger', '6cbdd70c-0691-4288-b58a-24001384f1b3', 'CC-BY-SA 4', 'karly'),
  ('Leg raises pull up bar', 'pull_v', false, false, true, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis","Quads"}', '{"Pull-up bar"}', 'with a firm grip with both hands on the bar, raise your outstretched legs, until you reach a 90° angle with your torso.', 'https://wger.de/media/exercise-images/979/27097a3a-5749-428d-b94c-6082afe390f6.png', null, 'wger', 'b2025776-2397-4de7-a49e-296321169481', 'CC-BY-SA 4', 'clafal'),
  ('Bent High Pulls', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{}', '{"Dumbbell"}', 'Bend over slightly while holding two dumbbells. Pull the dumbbells up to your chest, keeping your elbows as high as you can.', 'https://wger.de/media/exercise-images/79/da58dfbf-748a-461b-891e-3d6bc9cc4be2.png', null, 'wger', '01271ea0-088c-4e2b-95ad-876af7127057', 'CC-BY-SA 3', 'lakerbeezel'),
  ('Reverse Clamshell', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Lie on your side with your hips and knees bent, keeping your knees stacked on top of each other. Keep your feet together at first, then keep your knees touching while lifting your top foot upward. Slowly lower the foot back down with control.

Move only through the hip and avoid rolling your pelvis backward. The movement should be small, controlled, and focused on hip rotation.', null, null, 'wger', 'cf6bf132-fe21-4b70-8f73-006545246f05', 'CC-BY-SA 4', 'TobiasFalk'),
  ('Deadbug', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{}', 'Lie on your back, with your hips and knees bent to 90°. Raise both arms toward the ceiling. Pull your lower back to the floor to eliminate the gap. Start by pressing one leg out, and tapping the heel to the floor. "As you extend one leg, exhale as much as you can, keeping your lower back glued to the floor," Dunham says. When you can’t exhale any more, pull your knee back to the starting position. Make this more difficult by holding weight in your hands, or by lowering opposite arm and leg.', null, null, 'wger', 'd4db2355-4c99-4d80-a179-6aeced7c7fed', 'CC-BY-SA 4', 'Metin'),
  ('Hip Raise, Lying', 'pull_h', false, false, false, 'Back', '{"Glutes"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Lying down on your back, with your feet flat on the floor. Raise your hips up evenly as high as you can and hold for as long as you can.', null, null, 'wger', '541941e0-0fa5-4474-a382-9baf04948f8d', 'CC-BY-SA 4', 'James Mackay'),
  ('Barbell Lunges Walking', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Calves"}', '{"Barbell"}', null, null, 'https://wger.de/media/exercise-video/802/85d1d7f8-c3c5-47e8-9b26-56896919e6e7.MOV', 'wger', '072a9fa8-1028-47b3-b958-d8052c6b8661', 'CC-BY-SA 4', null),
  ('Lunges', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Starting position:

Stand with back straight.

Steps:

Take a large step forward with your left leg.
Bring your pelvis down until you almost touch the floor with your right knee.
Bring your pelvis back up.
Return to the starting position by stepping back.
Repeat, switching legs each time.', 'https://wger.de/media/exercise-images/984/5c7ffe68-e7b2-47f3-a22a-f9cc28640432.png', null, 'wger', '3284fd27-5402-4821-9c32-29066d4e2667', 'CC-BY-SA 4', null),
  ('Kick with Board', null, false, false, true, 'Cardio', '{"Glutes","Quads"}', '{"Hamstrings","Calves","Abs"}', '{}', 'Hold a kickboard with both hands, arms extended in front of you, face in the water (lift head forward to breathe when needed). Kick from your hips, not your knees, keeping your legs mostly straight with a slight bend and a steady, compact flutter kick. This builds leg endurance and keeps your body horizontal without needing to worry about your arms.', null, null, 'wger', '57d1a6fc-fc28-43a7-9beb-0e851a47a976', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Hollow Hold', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Gym mat"}', 'Get on a mat and lie on your back. Contract your abs, stretch your arms and legs and raise them (your head and shoulders are also be raised). Make sure your lower back remains in contact with the mat.', 'https://wger.de/media/exercise-images/297/b10d3341-baa8-49ab-b462-5b3529389aac.png', null, 'wger', 'd059c63d-0a81-48a3-912a-44070c0def2e', 'CC0', 'Behrooz'),
  ('Blaze', null, false, false, true, 'Cardio', '{"Shoulders","Glutes","Chest","Quads"}', '{"Biceps","Hamstrings","Lats","Abs"}', '{"Bench","Dumbbell","Kettlebell"}', 'BLAZE is a full-body HIIT workout. Designed to supercharge your cardio fitness and strength. Delivered in its own purpose-built studio, BLAZE is a unique mix of martial arts, intense cardio and strength training.', null, null, 'wger', '24f988e7-51eb-44f5-92f2-d4e0199c2269', 'CC-BY-SA 4', 'ricwheatley'),
  ('Dumbbells on Scott Machine', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', null, null, null, 'wger', 'fe328b2b-cc6d-4f12-a2c6-85ce374217c7', 'CC-BY-SA 3', 'wger.de'),
  ('Chin Up', 'pull_v', false, false, true, 'Back', '{"Biceps","Lats"}', '{"Brachialis","Trapezius"}', '{"Pull-up bar"}', 'The chin-up (also known as a chin or chinup) is a strength training exercise. People frequently do this exercise with the intention of strengthening muscles such as the latissimus dorsi and biceps, which extend the shoulder and flex the elbow, respectively. In this maneuver, the palms are faced towards the body. It is a form of pull-up in which the range of motion is established in relation to a person''s chin.', 'https://wger.de/media/exercise-images/152/6c1a7459-266d-491a-bd50-7cbaea2bc771.png', null, 'wger', '87e6abc5-a701-442a-b4fb-bb2a7598a754', 'CC0', 'BFad07'),
  ('Bulgarian split squats left', 'squat', true, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Stand tall in front of a chair and take a large step. Put the upper part of one of your feet on the chair.
Bend the front knee, balancing with arms until the back knee almost touches the ground.
Push back to the starting position and repeat.', 'https://wger.de/media/exercise-images/988/6283b258-a4d7-4833-84f7-a38987022d3d.png', null, 'wger', '7ce489d2-1948-46de-aa80-277b2ca737aa', 'CC-BY-SA 4', null),
  ('Bulgarian split squats right', 'squat', true, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Stand tall in front of a chair and take a large step. Put the upper part of one of your feet on the chair.
Bend the front knee, balancing with arms until the back knee almost touches the ground.
Push back to the starting position and repeat.', null, null, 'wger', '44afe80f-1ab2-4149-adbf-d8e0ece990ce', 'CC-BY-SA 4', null),
  ('Split squats left', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Starting position:

Stand with your back straight. Take a large step forward with your left leg.

Steps:

Bring your pelvis down until you almost touch the floor with your right knee.
Bring your pelvis back up.
Repeat.', null, null, 'wger', '80d83f98-efe5-4d87-a403-c0feadc8650f', 'CC-BY-SA 4', null),
  ('Split squats right', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Starting position:

Stand with your back straight. Take a large step forward with your right leg.

Steps:

Bring your pelvis down until you almost touch the floor with your left knee.
Bring your pelvis back up.
Repeat.', null, null, 'wger', '1d8599d8-59a5-4faf-a9cf-b81639cbf68b', 'CC-BY-SA 4', null),
  ('Reverse lunges', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Starting position:

Stand straight, feet hip-width apart.

Steps:

Step backward with one leg so it can bend comfortably to a 90 degree angle.
Slowly bend both knees to form 90 degree angles.
Return to the starting position.
Repeat, alternating legs.', 'https://wger.de/media/exercise-images/999/d0931eb3-8db0-4049-bb08-aa4036072056.jfif', null, 'wger', '616f9026-1a1d-4ed8-b068-cfbb81b6a000', 'CC-BY-SA 4', null),
  ('Floor dips', 'isolation', false, false, true, 'Arms', '{"Triceps"}', '{"Shoulders","Chest"}', '{"Bodyweight"}', 'Starting position:

Sit with your arms behind you, supporting your back.Your fingers should point forward.Your knees should be bent, feet together.

Steps:

Raise your hips off the ground, straightening your arms.
Bend your elbows, bringing your hips down.
Straighten your arms, returning to the previous position.
Repeat steps 2 and 3.

Notes:

The exercise''s difficulty depends on how high you bring your hips.', 'https://wger.de/media/exercise-images/1000/553266a8-a972-48c5-a014-b12afac66f65.png', null, 'wger', 'cf79d9fb-ffce-4648-a64f-27e4274e4c20', 'CC-BY-SA 4', null),
  ('High plank', 'push_h', false, false, true, 'Chest', '{"Abs"}', '{"Shoulders","Obliquus externus abdominis","Triceps"}', '{"Bodyweight"}', 'Starting position:

Get into the high plank position:your hands and toes should be touching the ground, your back, arms and legs should be straight.To get to this position, you can lie down on your stomach, place your hands facing down next to your head, and lifting your arms up until they are straight.

Steps:

Maintain the starting position for the entire duration of the exercise.', null, null, 'wger', 'b2b40a54-e42b-49ec-97da-4c929ae41d42', 'CC-BY-SA 4', null),
  ('Facepull', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{}', '{"Cable machine"}', 'Attach a rope to a pulley station set at about chest level.

Step back so you''re supporting the weight with arms completely outstretched and assume a staggered (one foot forward) stance. Bend the knees slightly for a stable base.

Retract the scapulae (squeeze your partner''s finger with your shoulder blades) and pull the center of the rope slightly up towards the face. A good cue is to think about pulling the ends of the rope apart, not just pulling back.

As you near your face, externally rotate so your knuckles are facing the ceiling.

Hold for one second at the top position and slowly lower.', null, 'https://wger.de/media/exercise-video/222/245a824b-cd39-45f2-b251-2c0b7efead0d.MOV', 'wger', 'd7a418d4-d0cb-4f85-8a7c-1e9d97152cbd', 'CC-BY-SA 4', 'abeworld'),
  ('Kettlebell deadlifts', 'pull_h', false, false, true, 'Back', '{"Hamstrings","Glutes"}', '{"Quads","Trapezius"}', '{"Kettlebell"}', 'Starting position:

Stand hip-width apart, with your kettlebell centered between your ankles. Your back should be straight, your head facing forward.

Steps:

Hinge at the hips and slightly bend at the knees to put your hands on the kettlebell handles. Your back should be straight as you perform the movement.
Grab the kettlebell handles, with your hands pushing in opposite directions as if to pull the handle apart.
While contacting your abs and glutes, stand straight up.
Hinge at the hips again to bring the kettlebell back down, similarly to step 1.
Repeat from step 3.

Tips:

Be sure you''re performing the movements correctly, as doing otherwise can lead to injury. For example, do not squat instead of hinging at the hips, do not round your back while reaching for the kettlebell, and do not lean back while standing up.', 'https://wger.de/media/exercise-images/1003/772d6e47-3865-4944-9255-7435d0b06782.png', null, 'wger', '9b5f8c6e-2436-4ded-aea9-8c698b0c8768', 'CC-BY-SA 4', null),
  ('Alternating bicep curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Dumbbell"}', 'Starting position:

Start standing up with dumbbells in each hand, your back straight and feet hip-width apart. Your arms should be relaxed, pointing down. Your knees should be slightly bent, your abs contracted, and your shoulders down.

Steps:

Bend one arm at the elbow, bringing the dumbbell up to your shoulder. Your upper arm should remain motionless during this movement.
Bring the dumbbell back down until your arm is in its original relaxed position.
Repeat, switching arms.', 'https://wger.de/media/exercise-images/1012/8270fdb8-28f1-4eff-b410-af8642085b3f.png', null, 'wger', 'a136959c-b0c8-49d3-99b9-0a5f41abf00e', 'CC-BY-SA 4', null),
  ('Cable Woodchoppers', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{}', '{"Cable machine"}', 'Set cable pulley slightly lower than chest height. Keep body facing forward with hips stable. Grab the pulley handle, fully extend your arms and bring your arms forward and across your body. Hold for 1 second at the end of the movement and slowly return to starting position.', null, null, 'wger', 'c867836d-2929-4977-b23c-014bc21ec08d', 'CC-BY-SA 3', 'robhoyt'),
  ('Hercules Pillars', 'isolation', false, false, true, 'Arms', '{"Biceps","Brachialis","Triceps"}', '{"Shoulders"}', '{"Cable machine"}', 'Grab two cables stand in the middle so both have tension and hold', null, null, 'wger', '8381f40c-3168-4d98-af60-6a89800dd308', 'CC-BY-SA 3', 'GrosseHund'),
  ('Reverse EZ Bar Cable Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Cable machine","SZ-Bar"}', 'Standing in front of cable tower using a SZ Bar', null, null, 'wger', '960697af-9a0e-4bfd-a8ba-989718b6b5c7', 'CC-BY-SA 4', 'novadani'),
  ('Single-arm cable pushdown', 'isolation', true, false, false, 'Arms', '{"Triceps"}', '{"Abs"}', '{"Cable machine"}', 'Single-arm cable pushdown is a unilateral isolation exercise that targets the triceps brachii. By working one arm at a time, it helps correct strength imbalances between sides while also engaging the core for stability.
Starting position:
Stand facing the cable machine with your feet shoulder-width apart. Attach a single handle to the high pulley. Grab the handle with one hand using an overhand grip (pronated), with your elbow bent at approximately 90° and tucked close to your body. Keep your core braced and your back straight.
Execution:
Push the handle downward in a controlled motion by extending your elbow until your arm is fully extended. Hold the contraction for 1 second at the bottom, then slowly return to the starting position.', null, null, 'wger', '83af8d94-319b-456b-92d8-75cec821a195', 'CC-BY-SA 4', 'evtimovgeorg'),
  ('Machine Leg Flexion', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Cable machine"}', 'Adjust the back seat or pad so your knees align with the side pivot axis.Place the lower roller pad against your lower calves, just above the back of your ankles.Lower the upper thigh restraint pad so your legs stay firmly on the seat.Pick a light weight on the stack with the pin.', 'https://wger.de/media/exercise-images/2495/5978ac7d-f4d4-4807-87e6-03e457485191.png', null, 'wger', 'c690034b-400c-4da8-8c71-37afac81ec3f', 'CC-BY-SA 4', 'Me'),
  ('Bird Dog (Core L1)', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Vasco custom bird dog - foundational contralateral limb coordination and lumbar stability. Teaches hip dissociation from spine, glute activation, and scapular control.', null, null, 'wger', '6d45afed-05c4-42a2-994b-5ef62a9d0aed', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Nordic Curl', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{"Glutes"}', '{}', 'The Nordic hamstring curl is one of the best lower-body exercises to build posterior leg strength, improve knee health, and prevent injury.', null, null, 'wger', '9b0f7101-b78a-4c47-b680-fbef15469a8a', 'CC-BY-SA 4', 'karly'),
  ('Reverse Preacher Curl (Close Grip)', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"SZ-Bar"}', 'Sitting reverse on a Biceps Bench with a close grip', null, null, 'wger', 'edc44b1a-35d7-4c37-ab20-05842fb40576', 'CC-BY-SA 4', 'novadani'),
  ('Smith Machine Slight Incline Press', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{}', '* Execution * Start position:

Unrack the bar and hold it above your upper chest with arms fully extended.
Keep your shoulder blades retracted and pressed into the bench.
Lowering phase (eccentric):
Slowly bring the bar down to just below your collarbone or upper chest.
Maintain control — don’t bounce the bar.
Pressing phase (concentric):
Push the bar upward in a straight line until your arms are fully extended.
Focus on squeezing your upper chest at the top.
Lock and repeat:
Complete your reps, then safely rack the bar back into the hooks.', 'https://wger.de/media/exercise-images/925/67dbb1c9-b378-46f9-adb6-1f55b3d3007a.png', null, 'wger', 'ef2df6a2-41df-4a25-b2e0-4808dc2c3305', 'CC-BY-SA 4', 'novadani'),
  ('Chest Press', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{}', 'Adjust the seat height so that the grips are parallel to your chest.
Use your legs to push the foot forward pedal.
Bring the handles to the start position.
Keep your back in contact with the back pad, press outwards.
Press the handles away from your chest and exhale.
Allow the handles to come in gently until they reach your chest.
Allow the handles to return to your chest as you inhale.', 'https://wger.de/media/exercise-images/129/b263c968-e067-4750-916a-d8758a7df23e.webp', null, 'wger', '5c414175-fe72-455a-ba8f-a0575cf792bd', 'CC-BY-SA 3', 'wger.de'),
  ('Cross-Bench Dumbbell Pullovers', 'push_h', false, false, true, 'Chest', '{"Lats","Chest","Serratus anterior"}', '{}', '{"Dumbbell"}', 'Grasp a moderately weighted dumbbell so your palms are flat against the underside of the top plates and your thumbs are around the bar. Lie on your back across a flat bench so only your upper back and shoulders are in contact with the bench. Your feet should be set about shoulder-width apart and your head should hang slightly downward. With the dumbbell supported at arm''s length directly about your chest, bend your arms about 15 degrees and keep them bent throughout the movement. Slowly lower the dumbbell backward and downward in a semicircle arc to as low a position as is comfortably possible. Raise it slowly back along the same arc to the starting point, and repeat for the required number of repetitions.', 'https://wger.de/media/exercise-images/161/b9b1803e-2817-40bf-8ac7-e398ca86d8b4.png', null, 'wger', '6e00afb6-272d-44a2-8ae3-e7fa41b50f06', 'CC-BY-SA 3', 'powerade69'),
  ('Cycling', null, false, false, true, 'Cardio', '{"Obliquus externus abdominis","Trapezius"}', '{"Hamstrings","Brachialis","Glutes","Lats","Quads"}', '{"Bodyweight"}', 'Cycling, also called bicycling or biking, is the use of bicycles for transport, recreation, exercise or sport. People engaged in cycling are referred to as cyclists, bicyclists, or bikers. Apart from two-wheeled bicycles, cycling also includes the riding of unicycles, tricycles, quadracycles, recumbent and similar human-powered vehicles.', null, null, 'wger', '8dedde58-a5dc-4a23-ad20-fd7cf524f8b5', 'CC0', 'BFad07'),
  ('Machine chest fly', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{}', 'seated machine, straight back, slow exercise', 'https://wger.de/media/exercise-images/926/ae9deb5d-a1e9-4c30-b1e3-c128ba5d4969.png', null, 'wger', '1e827ef8-0a01-4b26-9e26-eff9d200acca', 'CC-BY-SA 4', 'novadani'),
  ('Hyperextensions', 'pull_h', false, false, false, 'Back', '{"Trapezius"}', '{}', '{}', 'Lie on the hyperextension pillow with your navel at the front edge, allowing your upper body to hang freely. Tighten all your back muscles and raise your torso until you''re horizontal, but no higher. Lower yourself slowly, maintaining a steady flow of muscles.', 'https://wger.de/media/exercise-images/128/Hyperextensions-1.png', null, 'wger', '37f6bd56-815a-4975-99af-05e749fae4b2', 'CC-BY-SA 3', 'wger.de'),
  ('High Knee Jumps', null, false, false, true, 'Cardio', '{"Hamstrings","Calves","Quads","Soleus"}', '{"Obliquus externus abdominis","Abs","Serratus anterior"}', '{}', 'Start with legs slightly wider than shoulder width
Drop into a bodyweight squat
As you hit the bottom of the squat, explode upwards into a jump while simultaneously tucking your knees into your chest midflight. Remain tucked until the apex of your jump.
Land on both feet, making sure your knees are not locked so as to avoid excessive strain upon your joints. Collect yourself into the next rep as quickly but under control as possible.', 'https://wger.de/media/exercise-images/285/4141e8b2-d9f2-4597-8ef0-7768127fd0ec.png', null, 'wger', '3edbb63e-f326-4bd0-8af3-2d5deabb864f', 'CC-BY-SA 4', 'nate303303'),
  ('Bus Drivers', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{}', 'Sitting with a Weight Plate, used as wheel, in both hands; raised slightly below eye level', 'https://wger.de/media/exercise-images/915/fe8ebece-dff8-4700-b84c-9110e2e074f5.png', null, 'wger', '3d85bdce-e1a9-48a2-b14d-8032820ebf25', 'CC-BY-SA 4', 'novadani'),
  ('Hip Thrust', 'hinge', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Barbell","Bench"}', 'The bar should go directly on your upper thigh, directly below your crotch. Your feet should be directly under your knees. Push your hips up so that you form a straight line from your knees to your shoulders. Use a pad for comfort.', null, 'https://wger.de/media/exercise-video/294/45bacf4b-1bb6-4d47-8bd1-9f00eddd4019.MOV', 'wger', '19a289c0-33af-4055-bb34-3570c2975d3d', 'CC-BY-SA 4', 'Bret Contreras'),
  ('High Pull', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Glutes"}', '{}', 'Use a light barbell, perform explosive lift up starting from underneath knee cap level. Lift/raise explosively using hips, at shoulder level. Tempo: 2111', null, null, 'wger', 'b526b17b-408d-4da2-8940-ceaf9dae9d93', 'CC-BY-SA 3', 'Mahoney'),
  ('Clamshell to Reverse Clamshell', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Lie on your side with your hips and knees bent, keeping your legs stacked. Lift your top knee into a clamshell position and keep the leg elevated throughout the movement. From there, alternate between opening the knee upward and lifting the foot upward, moving through hip external and internal rotation.

Keep the movement slow and controlled. Do not let the top leg rest on the bottom leg between repetitions.', null, null, 'wger', 'f77b7cc6-e163-4f92-afa8-5ec431f32588', 'CC-BY-SA 4', 'TobiasFalk'),
  ('Bobbing Exhale Drill', null, false, false, false, 'Cardio', '{"Abs"}', '{}', '{}', 'Stand in chest-deep water. Take a breath, submerge your face fully, and exhale slowly and completely through your nose and/or mouth the whole time you''re underwater — a gentle humming sound can help keep the exhale steady and controlled. Once you''re empty of air, lift your head, take a fresh breath, and go back under. Repeat continuously. The goal is training your body that all your exhaling happens underwater, so all you need to do at the surface is inhale.', null, null, 'wger', 'c4b2ed05-38d5-47fc-9ad1-c23f09fddd61', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Muscle up', 'pull_h', false, false, true, 'Back', '{"Biceps","Lats"}', '{"Shoulders","Triceps"}', '{"Pull-up bar"}', 'The body is then explosively pulled up by the arms in a radial pull-up, with greater speed than a regular pull-up. When the bar approaches the upper chest, the wrists are swiftly flexed to bring the forearms above the bar. The body is leaned forward, and the elbows are straightened by activating the triceps. The routine is considered complete when the bar is at the level of the waist and the arms are fully straight.

To dismount, the arms are bent at the elbow, and the body is lowered to the floor, and the exercise can be repeated.

As a relatively advanced exercise, muscle-ups are typically first learned with an assistive kip. The legs swing (kip) up and provide momentum to assist in the explosive upward force needed to ascend above the bar. More advanced athletes can perform a strict variation of the muscle-up which is done slowly, without any kip. This variation begins with a still dead hang and uses isometric muscle contraction to ascend above the bar in a slow, controlled fashion.', null, null, 'wger', '0027b172-a83e-4f79-af47-483302a22c02', 'CC-BY-SA 4', 'arson'),
  ('Side plank right', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Starting position:

Lie down on your side, with your bottom elbow at a right angle, arm sticking out. Lift your pelvis off the floor by lifting your bottom shoulder up, keeping the forearm on the floor; your head, pelvis, and feet should be in a straight line.

Steps:

Hold this position.', null, null, 'wger', '5e2761cf-839e-435e-bedb-35e132dcb5ce', 'CC-BY-SA 4', null),
  ('Reverse Curl', 'isolation', false, false, false, 'Arms', '{"Biceps","Brachialis"}', '{}', '{"Barbell","Dumbbell"}', 'The reverse-grip barbell curl is a variation on the biceps curl where the palms face downward. The switch from an underhand to an overhand grip brings the forearm and brachialis muscles more into the exercise.', null, null, 'wger', '2cd5e3c6-a8c0-456a-ab47-5e7b3a435407', 'CC0', 'BFad07'),
  ('Roman Chair Crunch', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{}', 'Crunches on roman chair. Keep your torso straight, abs tight, and don''t come up all the way vertical or lie flat to keep constant tension on your abs.', null, null, 'wger', 'af2f774c-296c-4d14-8e4a-fad77175ae37', 'CC-BY-SA 3', 'MaddieBeasley'),
  ('Pistol squats right', 'squat', true, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Calves","Abs"}', '{"Bodyweight"}', 'Stand on one leg, with your other leg straight and slightly forward.
Bend one knee slowly, descending into a squat and keeping your back and your other leg straight.
Slowly raise yourself from the squat, straightening the bent knee and keeping the other leg straight.
Repeat.', null, null, 'wger', 'ec9dca8d-1456-430a-abed-70b8bab4779a', 'CC-BY-SA 4', null),
  ('Calf raises, right leg', 'isolation', false, true, false, 'Calves', '{"Calves"}', '{"Soleus"}', '{"Bodyweight"}', 'Stand on the floor or on the edge of a step to increase the range of movement.
Raise one foot.
Lift your heel until you''re standing on your toes.
(variable) Stay in this position for three seconds
Slowly lower your foot until you almost touch the ground with your heel - don''t slam your foot!', null, null, 'wger', '04ba9a37-4725-43f0-a0b6-767cdab9a79e', 'CC-BY-SA 4', null),
  ('Cable Cross-over', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Shoulders"}', '{"Cable machine"}', 'Begin with cables at about shoulder height, one in each hand. Take a step forward so that one foot is in front of the other, for stability, and so that there is tension on the cables. Bring hands together in front of you. Try to make your hands overlap (so that the cables cross) a few inches.', 'https://wger.de/media/exercise-images/71/Cable-crossover-2.png', null, 'wger', 'b16e3e5d-8401-4d2b-919c-15b536f9ec5e', 'CC-BY-SA 3', 'wger.de'),
  ('Long-Pulley, Narrow', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Brachialis"}', '{"Cable machine"}', 'The exercise is the same as the regular long pulley, but with a narrow grip:

Sit down, put your feet on the supporting points and grab the bar with a wide grip. Pull the weight with a rapid movement towards your belly button, not upper. Keep your arms and elbows during the movement close to your body. Your shoulders are pulled together. Let the weight slowly down till your arms are completely stretched.', null, null, 'wger', '77c98954-b50d-46f0-9912-3981f856d5a6', 'CC-BY-SA 3', 'wger.de'),
  ('Overhand Cable Curl', 'isolation', false, false, false, 'Abs', '{"Biceps"}', '{}', '{"Cable machine"}', 'Hands at shoulder height, curl arms in toward head, then back out.', null, null, 'wger', 'c7058ff8-ca3b-4822-abdb-6341ce37c4d1', 'CC-BY-SA 3', 'ThisGirl0819'),
  ('Straight Bar Cable Front Raise', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine","SZ-Bar"}', 'Back to cable tower, cable between legs, SZ Bar', null, null, 'wger', 'ca16aa3c-9b43-4d81-ae60-1e225163b767', 'CC-BY-SA 4', 'novadani'),
  ('Rope Pullover/row', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine","Incline bench"}', 'Set up bench in front of cable row machine. Lean over bench to do a row/pullover with rope that targets lats. See picture.', 'https://wger.de/media/exercise-images/1634/9a4704d3-1b25-43e3-b244-3885f4d3db87.png', null, 'wger', '148f2ffc-05e2-486b-874f-2a401337a1c6', 'CC-BY-SA 4', 'Rottekongen'),
  ('Single arm row', 'pull_h', true, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine","Incline bench"}', 'Sitting on the ground, use a high cable in a single grip, to do lat pulldowns with a focus on a long stretch in the lats.', 'https://wger.de/media/exercise-images/1637/a1fbe83a-a3e5-49f6-a2c2-5d5b533c2be8.png', null, 'wger', '81dd44b3-67b3-4198-9e57-c2a80b3c4102', 'CC-BY-SA 4', 'Rottekongen'),
  ('Long-Pulley (low Row)', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Brachialis"}', '{"Cable machine"}', 'Sit down, put your feet on the supporting points and grab the bar with a wide grip. Pull the weight with a rapid movement towards your belly button, not upper. Keep your arms and elbows during the movement close to your body. Your shoulders are pulled together. Let the weight slowly down till your arms are completely stretched.', 'https://wger.de/media/exercise-images/143/Cable-seated-rows-2.png', null, 'wger', 'a7e6c20a-6ddc-4401-9935-ace2d02e3995', 'CC-BY-SA 3', 'wger.de'),
  ('Wall Push-ups (Vasco L1)', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Obliquus externus abdominis"}', '{"Bodyweight"}', 'Vasco custom beginner wall push-up for zero-equipment home training. Part of 7-day Push/Pull/Core/Lower/Full/Recovery/Rest periodization. 6:30 AM wake, 1hr sessions. Stoic discipline focus.', null, null, 'wger', '37895cdd-aa94-43b5-8b76-4494b7ffeac2', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Side Plank (Core L1)', 'isolation', false, false, true, 'Abs', '{"Shoulders","Lats","Chest"}', '{"Biceps","Brachialis","Obliquus externus abdominis"}', '{"Bodyweight"}', 'Vasco custom side plank - foundational lateral core stability. Targets obliques, QL, and hip abductors. Essential for spinal stability and rotational control.', null, null, 'wger', '2caf3474-9855-4d0b-a50f-dbc08772b151', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Barbell Clean and press', 'push_v', false, false, false, 'Shoulders', '{"Shoulders","Chest"}', '{}', '{"Dumbbell"}', 'This exercise involves lifting a barbell from the ground to the shoulders, then pressing it overhead. It is a compound movement that targets multiple muscle groups, including the legs, back, shoulders, and arms. It is often used in strength and conditioning programs to improve overall power and athleticism.', 'https://wger.de/media/exercise-images/1638/046c09b0-c35d-48d0-a552-39dd49f956d2.webp', null, 'wger', 'e9e7372c-b5c1-45d9-ae5c-b1aa0fc2e2ce', 'CC-BY-SA 4', 'Rottekongen'),
  ('Smith Press', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Incline bench"}', 'Sitting almost 90 degree angle, smith machine', 'https://wger.de/media/exercise-images/916/9bf7555a-fec6-43a9-b343-aae496744e5e.png', null, 'wger', 'cbf4cf16-f188-4a60-a223-aa50b163f4b7', 'CC-BY-SA 4', 'novadani'),
  ('Isometric Wipers', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Abs"}', '{"Bodyweight"}', 'Assume push-up position, with hands slightly wider than shoulder width.

Shift body weight as far as possible to one side, allowing the elbow on that side to flex.

Reverse the motion, moving completely over to the other side.

Return to the starting position, and repeat for the desired number of repetitions.', null, null, 'wger', '2f5032de-df6d-406b-b709-9223ef5c3e24', 'CC-BY-SA 4', 'cal.zabel'),
  ('Jumping Jacks', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{}', 'A jumping jack or star jump, also called side-straddle hop in the US military, is a physical jumping exercise performed by jumping to a position with the legs spread wide and the hands going overhead, sometimes in a clap, and then returning to a position with the feet together and the arms at the sides', 'https://wger.de/media/exercise-images/320/6c9124b6-3551-47a8-9c22-20141c8b9c53.png', null, 'wger', '4d255f25-f199-401a-bc81-7ffab1d0ed24', 'CC-BY-SA 4', 'student1234'),
  ('Landmine press', 'push_v', false, false, true, 'Shoulders', '{"Shoulders"}', '{"Chest","Triceps"}', '{"Barbell"}', null, null, null, 'wger', '91c47c8b-6290-4885-8921-df9aa7958c00', 'CC-BY-SA 4', 'Torsten Linnecke'),
  ('Quadriped Arm and Leg Raise', 'pull_h', false, false, true, 'Back', '{"Shoulders","Glutes","Serratus anterior","Trapezius"}', '{"Lats"}', '{"Bodyweight"}', 'In this exercise, the back muscles and the muscles of the back of the leg and back of the arm are activated by lifting the crossed arm and leg at the same time in the crawling position. It also improves balance and proprioception. The movement is done symmetrically.

Get into a crawling posture.2. Draw your abdomen in, then raise your right leg and left arm.3. You should keep your abdomen in for 8 seconds.4. After 8 seconds, slowly lower your arm and leg.5. Then release your muscle.', 'https://wger.de/media/exercise-images/957/0fd94587-6021-4763-856e-7227f5fcba2a.png', null, 'wger', '80c167b9-3749-48a1-8686-fc2163a1e7fb', 'CC-BY-SA 4', 'utkb'),
  ('Prone Scapular Retraction - Arms at Side', 'pull_h', false, false, false, 'Back', '{"Trapezius"}', '{}', '{}', 'Lying on stomach with head on towel.

Stretch arms straight out to your sides.

Slowly lift your arms, pulling your shoulderblades together, hold for 3 seconds.', null, null, 'wger', '9cb69afc-7a44-4a22-b9a9-7bde8aca5b11', 'CC-BY-SA 4', 'donaddon'),
  ('Pike Push Ups', 'isolation', false, false, false, 'Arms', '{"Chest"}', '{"Triceps"}', '{"Bodyweight"}', 'Push Up performed from a pike position (optional to have feet elevated).', 'https://wger.de/media/exercise-images/454/447f3c17-405f-46e0-b138-65c2a8caaab0.png', null, 'wger', '3b96a05b-9705-48da-b43e-6e098234bb35', 'CC-BY-SA 4', 'Nash'),
  ('Seated Dumbbell Side Lateral', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'seated slightly leaned forward at beginning of exercise', null, null, 'wger', '6d010eae-2e36-4ec6-b191-c0373f237bb4', 'CC-BY-SA 4', 'novadani'),
  ('T-Bar row', 'pull_h', false, false, false, 'Back', '{"Lats","Trapezius"}', '{}', '{"Barbell"}', 'bent over with triangle grip, slightly bent knees', null, null, 'wger', '1eeccede-29c5-4f38-9ba7-d77c7c47993d', 'CC-BY-SA 4', 'novadani'),
  ('Dumbbell Bent Over Face Pull', 'pull_h', false, false, true, 'Back', '{"Shoulders","Lats"}', '{"Trapezius"}', '{"Dumbbell"}', 'This exercise involves using dumbbells to perform a bent over face pull, which targets the upper back and shoulders. The movement involves pulling the weights towards the face while keeping the elbows high and squeezing the shoulder blades together.', 'https://wger.de/media/exercise-images/1639/8927346e-f5ca-4795-bdf1-5ac9309401e7.webp', null, 'wger', '51ab6376-eb3e-42dc-ad48-46166c94adac', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Wall-Hold Rotation', null, false, false, false, 'Cardio', '{"Obliquus externus abdominis"}', '{"Abs"}', '{}', 'Hold the pool wall or edge with one hand, body horizontal at the surface, legs kicking gently behind you. Keep your face in the water, exhaling continuously, then rotate your head to the side — not lifting it up — so one goggle stays in the water while the other clears the surface. Take a quick breath, then rotate your face back down to neutral. This isolates the head-rotation motion without any arm strokes to think about.', null, null, 'wger', '9a5d36b8-7fa5-4705-8e9b-fafa211a13d6', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Turkish Get-Up', 'isolation', false, false, true, 'Abs', '{"Shoulders","Glutes","Obliquus externus abdominis","Serratus anterior"}', '{}', '{"Dumbbell"}', 'Starting on back, move to the standing position with dumbbell in one hand. Switch hands between reps.', null, null, 'wger', '309bfd2b-1af4-49db-b64b-d7d7c7dd39bb', 'CC-BY-SA 4', 'dookie1481'),
  ('Weighted Step-ups', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Calves"}', '{}', 'box step ups w/ barbell and 45''s on each side', null, null, 'wger', '591992cb-48ee-4b39-b790-e05b4a2c11e3', 'CC0', 'jigglychipmunk'),
  ('Dumbbell Hang Power Cleans', 'pull_h', false, false, true, 'Back', '{"Hamstrings","Glutes"}', '{"Calves","Quads","Trapezius"}', '{"Dumbbell"}', 'On your feet, stand tall with your dumbbells, holding them at your sides. Hinge at the hips to lower them to your knees (picture 1). Stand back up with a slight jump, using the momentum to pull the dumbbells up on to your shoulders (picture 2). Stand up straight, then lower under control to your sides and repeat. Keep this fast and explosive; if your heart rate doesn’t hit the roof, you’re doing them wrong.', 'https://wger.de/media/exercise-images/1087/d85f4e02-b20c-457c-bdfb-0b00e2d14150.jpg', null, 'wger', 'f0f53b8e-0136-4195-baf3-781903651359', 'CC-BY-SA 4', 'philip'),
  ('Dumbbell sumo deadlift', 'hinge', false, true, true, 'Legs', '{"Hamstrings","Glutes"}', '{"Quads","Trapezius"}', '{"Dumbbell"}', 'Lower your dumbbell to the ground between your legs. Assume a wide stance and with a straight back squat down. With the dumbbell standing upright, grip it by the top of the ‘head’ (picture 1).Keeping your chest up and core braced, push the floor away, driving back upwards to a standing position (picture 2). Repeat. If you can easily achieve 20-30 reps, use two dumbbells.', 'https://wger.de/media/exercise-images/1088/9f66b288-ce8f-4154-ba80-78fee267263c.jpg', null, 'wger', '0c30c543-e2cc-499b-bc31-8c28db445ed2', 'CC-BY-SA 4', 'philip'),
  ('Trunk Rotation With Cable', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Lats"}', '{"Cable machine"}', 'Seated trunk rotation with cable', null, null, 'wger', '90e9f590-7d68-4afb-9f95-8429246ea4aa', 'CC-BY-SA 4', 'Robertcoop'),
  ('Seated Cable Mid Trap Shrug', 'pull_h', false, false, false, 'Back', '{"Trapezius"}', '{}', '{"Cable machine"}', 'seated straight back, slight hold at top', null, null, 'wger', 'ad3716b1-5fc9-45aa-9de4-9a1c0153915d', 'CC-BY-SA 4', 'novadani'),
  ('Modified pulldown', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine","Incline bench"}', 'With an inclined bench in front of the pulldown machine, use a close-grip to do latfocused pulldowns.', 'https://wger.de/media/exercise-images/1635/b8c34e3a-7474-41ea-99e3-8d7fdb1e12d6.png', null, 'wger', '5851e2b1-3a80-42ff-91da-530e6b143a34', 'CC-BY-SA 4', 'Rottekongen'),
  ('DB Floor Press (5kg Single Arm)', 'push_h', true, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Obliquus externus abdominis"}', '{"Dumbbell"}', 'Vasco custom single-arm DB floor press for 5kg dumbbell home training. Unilateral work for symmetry and core anti-rotation. Part of Monday Push day.', null, null, 'wger', '2dd388dd-e7fa-44f1-9973-6f9c1185e0a4', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Hollow Body Hold (Core L1)', null, false, false, true, 'Cardio', '{"Calves","Glutes","Obliquus externus abdominis"}', '{"Shoulders","Biceps","Brachialis","Lats"}', '{"Bodyweight"}', 'Vasco custom hollow body hold - foundational anti-extension core stability. Teaches global anterior chain tension, breath control under load, and positional awareness for gymnastics/calisthenics.', null, null, 'wger', '2b165c5c-403f-43e5-b28d-83c8b914505b', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Curl with kettlebell two hands', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Kettlebell"}', 'Stand upright and grip the kettlebell with both hands. Perform the elbow flexion motion, starting from a fully extended position until your hand reaches shoulder height. Spread your legs a little for stability and, to perform the exercise correctly, try not to push with your back or body in general. Change the weight of the kettlebell to adjust the difficulty.', null, null, 'wger', '3de523ee-d359-4044-a792-6de22eef0495', 'CC-BY-SA 4', null),
  ('Doorway Pectoral Stretch', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Bodyweight"}', 'Place the forearm vertically on a door frame or stationary object at head height
Step forward past the arm, keeping it still against the object to stretch the chest', null, null, 'wger', 'adbb1d4c-962b-4a26-a353-9c47a2b37a93', 'CC-BY-SA 4', 'Croak6728'),
  ('Incline Bench Press - MP', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{}', null, 'https://wger.de/media/exercise-images/61/Close-grip-bench-press-1.png', null, 'wger', '60e9a0c0-5458-46cd-ab41-7d7b85225cf8', 'CC-BY-SA 3', 'wger.de'),
  ('Side Dumbbell Trunk Flexion', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Dumbbell"}', 'AKA dumbbell side bends. Stand in line with the hips with slightly bent knees, maintain the natural curvature of the spine, hand stretched by the body, grip the barbell with one hand. Make slow and controlled torso side flexions till you reach the angle of approximately 45°.', null, null, 'wger', 'cf1f0fed-6310-4210-8f7d-22e375e6c60c', 'CC-BY-SA 3', 'GiglioRosso'),
  ('Skipping - Standard', null, false, false, false, 'Cardio', '{"Calves"}', '{}', '{}', 'Do a single, double footed jump for each swing of the rope.

Work on a smooth, rhythmical movement, bouncing lightly on the balls of your feet.', null, null, 'wger', 'e60125f0-3a88-4707-815f-fe0e2b4be3c4', 'CC-BY-SA 4', 'Cerin'),
  ('Side Bends on Machine', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Dumbbell"}', null, null, null, 'wger', '919bb48a-42fe-4a11-9078-ea2b5087c49f', 'CC-BY-SA 3', 'klabautermann'),
  ('Tricep Dumbbell Kickback', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Dumbbell"}', 'Start with a dumbbell in each hand and your palms facing your torso. Keep your back straight with a slight bend in the knees and bend forward at the waist. Your torso should be almost parallel to the floor. Make sure to keep your head up. Your upper arms should be close to your torso and parallel to the floor. Your forearms should be pointed towards the floor as you hold the weights. There should be a 90-degree angle formed between your forearm and upper arm. This is your starting position.
Now, while keeping your upper arms stationary, exhale and use your triceps to lift the weights until the arm is fully extended. Focus on moving the forearm.
After a brief pause at the top contraction, inhale and slowly lower the dumbbells back down to the starting position.
Repeat the movement for the prescribed amount of repetitions.

Variations: This exercise can be executed also one arm at a time much like the one arm rows are performed.

Also, if you like the one arm variety, you can use a low pulley handle instead of a dumbbell for better peak contraction. In this case, the palms should be facing up (supinated grip) as opposed to the torso (neutral grip).', null, 'https://wger.de/media/exercise-video/655/69e8c1e5-55b2-4da6-8166-092c24b16735.MOV', 'wger', '5915fabe-c941-4dac-b196-bc4e8c7ce57b', 'CC-BY-SA 3', 'http://www.bodybuilding.com/'),
  ('Superman', 'pull_h', false, false, false, 'Back', '{"Glutes","Lats"}', '{}', '{"Gym mat"}', 'Lay flat on your stomach with your arms extended in front of you on the ground as your legs are lying flat. Lift both your arms and legs at the same time, as if you were flying, and contract the lower back. Make sure that you are breathing and, depending on your fitness level, hold the movement for at least two to five seconds per repetition.', null, null, 'wger', '66c90ca7-23d8-47b1-820f-dc0c8140603b', 'CC-BY-SA 4', 'baldurmen'),
  ('Triceps on Machine', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{}', 'Sit down and hold the bar firmly with your hands. Now press the weight upwards (don''t fully extend your arms) and lower it slowly again. As with other triceps exercises, it''s important not to move your upper arms.', null, null, 'wger', '6c671e43-497f-4863-8d78-b592f3b5e7c6', 'CC-BY-SA 3', 'wger.de'),
  ('Power Clean', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Barbell"}', 'Olympic weight lifting', null, null, 'wger', '52dec48d-25a4-4a78-b66b-ad6a773e143a', 'CC-BY-SA 3', 'wger.de'),
  ('Upper External Oblique', 'push_h', false, false, false, 'Chest', '{"Obliquus externus abdominis"}', '{}', '{"Pull-up bar"}', 'Exercise for upper external oblique muscles', null, null, 'wger', '6fc4815a-8852-4e89-a10b-bd36a9029dbb', 'CC-BY-SA 3', 'http://www.carinatum.com/'),
  ('Wall Slides', 'pull_h', false, false, true, 'Back', '{"Biceps","Hamstrings","Chest","Trapezius","Triceps"}', '{}', '{"Bodyweight"}', 'Stand with heels, shoulders, back of head, and hips touching the wall. Start with biceps straight out and elbows at a 90 degree angle. Straighten the arms while remaining againstthe wall without arching the back off of the wall, mimicking a shoulder press movement.', null, null, 'wger', 'f1946fd4-793d-47a5-b66f-599b7f53695d', 'CC-BY-SA 4', 'Whythebigpaws'),
  ('Overhead Press', 'push_v', false, false, false, 'Chest', '{"Shoulders"}', '{}', '{"Barbell"}', null, null, null, 'wger', 'f4467e9a-9bb1-4e93-bec6-10a5d7738ffb', 'CC-BY-SA 4', 'Vazco'),
  ('Elevated prayer stretch', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Bench"}', 'Starting position:
Kneel in front of a bench, far enough so that your torso can fit between your knees and the bench. With your back straight, place your elbows on the bench, with palms together, hands pointing up.
Steps:

On exhale, stretch your chest down toward the floor without moving your lower back. At the same time, bring your hands toward your shoulders, keeping palms together and elbows on the bench.
Hold for a few seconds.
On inhale, relax your back to return to the starting position.

Repeat.', null, null, 'wger', '302e02df-4270-4a0b-8c5d-b743cdb06fc9', 'CC-BY-SA 4', 'tinman'),
  ('Hindu Pushups', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Chest"}', '{"Triceps"}', '{}', 'Exercise to strengthen the shoulders and pectorals. Its name is due to the fact that it begins in the Yoga position "Dog Facing Down", passing to "Cobra" but without resting the legs or torso on the ground to finally end with a normal flexion. The exercise can also be performed backwards (back to the starting position). As a variation, after doing the push-up, the hip can be raised to return to downward facing dog.', 'https://wger.de/media/exercise-images/1080/c4bf7ba1-6058-4d14-928f-7187885d5d57.webp', null, 'wger', '476c1d96-6590-4f86-98f0-3f12808fab53', 'CC-BY-SA 4', 'Imobard'),
  ('Close-grip Press-ups', 'push_h', false, false, true, 'Chest', '{"Brachialis","Lats","Chest","Trapezius"}', '{"Shoulders","Biceps","Triceps"}', '{"Bodyweight"}', 'Drop into a strong plank position, bringing your hands close together until they''re almost touching. (picture 1)Bend your elbows to slowly bring your chest to the floor (picture 2). Keep your elbows close to your body as you push back up explosively. Repeat. Ensure you take your time lowering on each rep, keeping your form sharp.', 'https://wger.de/media/exercise-images/1086/b2ee8d9b-0480-4992-8494-c223b37c2696.jpg', null, 'wger', '44cfa56c-d8c2-4f2c-8b5a-f29810fd60e7', 'CC-BY-SA 4', 'philip'),
  ('Medicine ball twist', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Swiss Ball"}', 'In a seated position, the torso is rotated from side to side without forcing, approaching the knees and making the ball touch the ground from time to time', 'https://wger.de/media/exercise-images/1089/49f51716-535d-41dd-aeb5-cff5bb906bc1.jpeg', null, 'wger', '66c7eb38-77b5-4d2f-810f-cddd8d97d5a3', 'CC-BY-SA 4', 'clafal'),
  ('Vpushup', 'isolation', false, false, true, 'Abs', '{"Chest","Quads","Abs","Triceps"}', '{}', '{"Bodyweight"}', 'Lift your body off the ground by pushing your arms upwards', null, null, 'wger', '36b6919a-0e9d-49c6-891b-28fb55ae88ad', 'CC-BY-SA 4', 'clafal'),
  ('Plank Shoulder Taps', 'isolation', false, false, true, 'Abs', '{"Shoulders","Glutes","Abs"}', '{"Lats"}', '{"Gym mat"}', 'In the correct plank position, place your feet slightly wider than shoulder-width apart. alternately lift and touch the opposite shoulder with one hand.', 'https://wger.de/media/exercise-images/1091/50c8912d-54ef-46c9-99d1-633b6196aa1e.jpg', null, 'wger', '75d730d0-3b26-4a25-8f1a-7119a98e02ef', 'CC-BY-SA 4', 'clafal'),
  ('Dumbbell Front Squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Shoulders","Abs"}', '{"Dumbbell"}', 'This exercise involves holding a dumbbell in each hand at shoulder height and performing a squat. It targets the lower body muscles, including the quads, hamstrings, and glutes, while also engaging the core and upper body.', 'https://wger.de/media/exercise-images/1640/bdea82f1-15ef-4649-8b5a-1303cfc178e7.webp', null, 'wger', '4621b41f-0d32-4033-acff-dc079c792606', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Walking', null, false, false, true, 'Cardio', '{"Hamstrings","Calves","Glutes","Lats","Obliquus externus abdominis","Quads","Abs"}', '{}', '{"Bodyweight"}', 'Walking outdoor or indoor, try keeping a pace of at list 100 steps per minute.', null, null, 'wger', '2e00d8e5-19a2-42ad-a954-f06a56f56561', 'CC-BY-SA 4', null),
  ('Wide-grip supinated lat pulldown', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Downward movement
• Pull the bar down so that it passes close to your chin and touches the upper part of your chest.
• Keep the rest of your body still.', null, null, 'wger', 'd33f3b19-436f-48a2-aff6-946582c94bdb', 'CC-BY-SA 4', 'Franpol'),
  ('Kettlebell One Legged Deadlift', 'hinge', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Dumbbell","Kettlebell"}', 'This exercise involves holding a kettlebell in one hand and standing on one leg while bending forward to touch the kettlebell to the ground. It targets the hamstrings, glutes, and lower back while also improving balance and stability.', 'https://wger.de/media/exercise-images/1641/68d9488d-2596-420f-be0f-52aa70732c83.webp', null, 'wger', '20b17b71-6d91-4b56-978a-04b7f94c04cc', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Dumbbell Hip Thrust', 'hinge', false, true, false, 'Legs', '{"Glutes","Quads"}', '{}', '{"Dumbbell"}', 'This exercise involves sitting on the ground with a dumbbell resting on the hips, then thrusting the hips upward while squeezing the glutes. It is a great exercise for strengthening the glutes and improving hip mobility.', 'https://wger.de/media/exercise-images/1642/a81ad922-caf5-47f8-99b4-640cb0717436.webp', null, 'wger', 'af77220c-098c-47c2-9f8c-92a651998903', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Side-Kick Breathing (Kickboard)', null, false, false, true, 'Cardio', '{"Glutes"}', '{"Shoulders","Hamstrings","Obliquus externus abdominis","Quads"}', '{}', 'Push off the wall on your side (not flat on your stomach), one arm extended forward holding the board or just extended, kicking continuously. Keep your head in a neutral position looking at the bottom of the pool, and when you need air, rotate your head sideways (one ear stays in the water, other faces up) to breathe, then rotate back to neutral. Swim a length like this, then repeat on the other side. This teaches the exact head position and rotation you''ll use once full stroke breathing comes in.', null, null, 'wger', '6ec2d684-8091-4da9-8814-8a3052d0a302', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Horizontal traction isometry', 'pull_h', false, false, true, 'Back', '{"Lats","Chest"}', '{"Shoulders","Biceps"}', '{"Pull-up bar"}', 'Perform a timed isometric pull-up on the bar', null, null, 'wger', '8ccd5844-4b46-475d-b36f-5f58ca496840', 'CC-BY-SA 4', 'clafal'),
  ('2 Handed Kettlebell Swing', 'hinge', false, false, true, 'Abs', '{"Hamstrings","Glutes"}', '{"Quads","Abs"}', '{"Kettlebell"}', 'Two Handed Russian Style Kettlebell swing', null, null, 'wger', '1b020b3a-3732-4c7e-92fd-a0cec90ed69b', 'CC-BY-SA 4', 'deusinvictus'),
  ('Weighted Crunch', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{}', '{"Dumbbell"}', 'The Weighted Crunch is a variation of the classic crunch exercise that involves adding resistance (a weight) to increase the intensity of the abdominal work.

Lay down
(Optional) Bend your knees to add difficulty
(Optional) Bend your knees and let your feet rest on a bench or a box or something (90 degree angle on knees)
Lift your head and torso while bending your back forward (if you don''t it''s a sit-up and also involves some back muscles). The higher you go, the more you should feel your abs contracting.
Go back to starting position an repeat', 'https://wger.de/media/exercise-images/1648/63ae02d6-6dd9-4e9e-84da-d4905e78a33c.jpg', null, 'wger', '8d333b94-148c-48f8-9154-8b13279500d1', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Dumbbell Side Bend', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{}', '{"Dumbbell"}', 'This exercise involves holding a dumbbell in one hand and bending sideways to work the oblique muscles on the side of the body. It can be done standing or seated and is often used as a core strengthening exercise.', 'https://wger.de/media/exercise-images/1650/1d7a5336-ec0b-4898-a474-78ba32789bf3.webp', null, 'wger', '3e9b3bb0-7958-4836-89a5-ed0c5f7eeb03', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Dumbbell Rear Lunge', 'squat', true, true, true, 'Legs', '{"Glutes","Quads"}', '{"Soleus"}', '{"Dumbbell"}', 'This exercise involves holding a dumbbell in each hand and stepping back into a lunge position, then returning to standing. It primarily targets the glutes, hamstrings, and quadriceps.', 'https://wger.de/media/exercise-images/1651/04ab2679-a04d-4d05-9c85-0d36e898328c.webp', null, 'wger', '75e34967-b0ec-40d5-811e-b474b234a7a9', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Remo maquina agarre estrecho', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{}', 'Remo en máquina con barra en agarre estrecho', 'https://wger.de/media/exercise-images/1119/9b138ad2-5b80-42a8-bfff-93a960444ffe.png', null, 'wger', 'ace5d444-6a41-44bc-a4b6-548bb18cfc9b', 'CC-BY-SA 4', 'Franpol'),
  ('Dumbbell Side Squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{}', 'This exercise involves holding a dumbbell in one hand and performing a squat while stepping to the side. It targets the legs, glutes, and core muscles.', 'https://wger.de/media/exercise-images/1653/c10c4e17-1e14-4cf9-930b-cc3a614f15dd.webp', null, 'wger', '412ba9ab-ae29-4411-9bbc-74af1263494c', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Machine Lateral Raise', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Gym mat"}', 'The machine lateral raise is an isolation exercise that targets the medial (side) deltoid muscle to build wider, more defined shoulders. The machine''s fixed path of motion provides greater stability than dumbbells, making it ideal for beginners or those who want to focus solely on muscle activation.', 'https://wger.de/media/exercise-images/1654/aa724a58-b3b5-4522-b278-1155416236a5.jpg', null, 'wger', '3d2adf99-8fe9-45cb-b669-c5b18242e282', 'CC-BY-SA 4', 'roneydya'),
  ('Remo maquina agarre estrecho supino', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{}', 'Remo en máquina o polea con agarre cerrado supino', 'https://wger.de/media/exercise-images/1120/df9a5256-e977-44d0-bc9c-b53253faeb22.png', null, 'wger', '443fec2e-dcca-46fe-ab4a-9a8beb50891e', 'CC-BY-SA 4', 'Franpol'),
  ('Pike Push-ups (Vasco L1)', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Vasco custom pike push-up for shoulder development in beginner home training. Bodyweight only. Part of Monday Push day.', null, null, 'wger', 'd6bed527-8cd4-4ff0-bb83-761a25b8f3a3', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Prisoner Squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Stand upright with your chest slightly raised, your feet hip-width apart and your toes pointing straight ahead.
Bring your hands to the back of your head with your fingers slightly interlaced and your elbows pointing to the side. Push your hips back and bend your knees, keeping your upper body as upright as possible. 
Push your knees outwards, they must never point towards each other. If your upper body moves slightly forward, make sure that it does not bend. Always keep your elbows level with your ears by tensing the muscles between your shoulder blades. If you are flexible enough, you can sink down until your buttocks touch your calves.
However, make sure that you do not bend your spine. 
Before this happens, reverse the movement and use your heels and glutes to push yourself upwards with so much momentum that your feet lift off briefly and you do a little hop. 
If necessary, correct the position of your feet, arms and upper body before you move on to the next repetition.
Translated with www.DeepL.com/Translator (free version)', null, null, 'wger', 'f9866335-e489-404b-84b5-248fb8512702', 'CC-BY-SA 4', 'lxmx'),
  ('Dumbbell Romanian Deadlift', 'hinge', false, true, false, 'Legs', '{"Hamstrings","Glutes"}', '{}', '{"Dumbbell"}', 'This exercise involves holding a dumbbell in each hand and bending forward at the hips while keeping the back straight, then returning to a standing position. It primarily targets the hamstrings and glutes.', 'https://wger.de/media/exercise-images/1652/0306c8c0-70cc-45d4-92de-6fa72ceaa834.webp', null, 'wger', '65d12ecf-54b8-466d-a412-e55c396cad69', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Cable Concentration Curl', 'isolation', false, false, false, 'Arms', '{"Biceps","Brachialis"}', '{}', '{"Cable machine"}', 'The concentration curl is a classic exercise for building the biceps one arm at a time. It can be performed bent over or kneeling, but is more often performed seated on a bench. It''s great for emphasizing the biceps peak and is often used to finish a biceps workout', 'https://wger.de/media/exercise-images/1109/00b0a0bf-c14a-4f13-bb14-62c09030a1aa.png', null, 'wger', 'b1bf02cf-17b2-4bfc-a5b0-4ff7a2768dbb', 'CC-BY-SA 4', 'cshep442'),
  ('Close-grip supinated lat pulldown', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Downward movement
• Pull the bar down so that it passes close to your chin and touches the upper part of your chest.
• Keep the rest of your body still.', 'https://wger.de/media/exercise-images/1127/4942b7c0-6bda-4983-88e5-86547c3d445e.png', null, 'wger', '4eb41bfb-cbeb-4683-b9c6-902ee7e028e0', 'CC-BY-SA 4', 'Franpol'),
  ('Incline Skull Crush', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{}', 'Siting in a 45 Degree Angle, using DB to do Incline Skull Crush', null, null, 'wger', '76a2f8a6-374b-42c8-b8ac-e8d64612f046', 'CC-BY-SA 4', 'novadani'),
  ('Cable glute extension', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Cable machine"}', 'This exercise lets you work the upper, or larger, part of the glutes. For that reason, it should never be missing from your routine of isolated exercises for training the glutes.
Stand in front of a cable machine and locate the low pulley. Then attach the ankle strap to work on the low pulley. As for your posture, you should stay upright at all times. Pay special attention to your back to keep it straight and avoid injury.
It is advisable to hold on to the machine for better balance. With the leg that is holding the weight of the cable, perform a slow stretch backward without bending the knee.', 'https://wger.de/media/exercise-images/1131/3bcf3024-2dcc-4995-9694-55aa2c2e4a9a.png', null, 'wger', '19a9f67b-60f5-4367-9134-b805f3e73956', 'CC-BY-SA 4', 'Franpol'),
  ('Neutral-grip chest pulldown', 'pull_v', false, false, true, 'Back', '{"Biceps","Lats","Serratus anterior"}', '{}', '{"Cable machine"}', 'The lat pulldown is an important exercise for strengthening the back and improving posture, which can contribute to a healthier life. To perform this exercise correctly and avoid injury, it is important to follow a few key steps:

Position yourself in front of the cable machine with your knees slightly bent and your feet on the floor.

Grip the cable handle with your palms facing each other and your hands shoulder-width apart.

Pull the handle down until it touches or comes close to your chest, holding the position for one or two seconds.

Slowly raise the handle back to the starting position, making sure to keep your arms and hands straight and your back straight throughout the movement.', 'https://wger.de/media/exercise-images/1136/5778a8e9-c606-4843-89c8-9d9469eeb6e4.PNG', null, 'wger', 'eaa7927e-6ea0-4fd5-bbcd-525fe90a184b', 'CC-BY-SA 4', 'Franpol'),
  ('High-pulley pullover', 'pull_h', false, false, false, 'Back', '{"Lats","Serratus anterior"}', '{}', '{"Cable machine"}', 'Stand facing the machine, feet slightly apart, gripping the bar with an overhand grip, arms extended, hands shoulder-width apart.

Keeping your back fixed and your abdominal muscles contracted, inhale and bring the bar down to your thighs while keeping your arms extended (or your elbows slightly bent).
Exhale at the end of the movement.', 'https://wger.de/media/exercise-images/1137/42f22229-c0a0-4bfc-aca6-66fe5e1ab10d.PNG', null, 'wger', 'e87b76b8-2960-4225-9146-47f78bf8c630', 'CC-BY-SA 4', 'Franpol'),
  ('Rowing Machine', null, false, false, true, 'Cardio', '{"Shoulders","Biceps","Hamstrings","Brachialis","Calves","Glutes","Lats","Obliquus externus abdominis","Quads","Abs","Serratus anterior","Soleus","Trapezius"}', '{}', '{"Bodyweight"}', 'Sit on a rowing machine with your back straight.', null, null, 'wger', 'f6d8e157-c233-4a22-9c1a-83cb8f613ea5', 'CC-BY-SA 4', 'Boertie'),
  ('Seated Bench Press', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Bench"}', 'Set up the chest press machine so that the grips are aligned with your lower chest when you sit down. Make sure you''re sitting with your back flat against the seat. Grab a handle in each hand, stick your chest out, and keep your head against the headrest. Breathe deeply and slowly push the handles forward until your arms are almost fully extended. Pause just before the lockout, then slowly return the handles to the starting position. Pause just before the handles come to a complete stop and perform another repetition.', null, null, 'wger', '117df66c-bc8d-43cc-9903-0be2a0864486', 'CC-BY-SA 4', 'colundrum'),
  ('Bent Over Rowing Reverse', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Biceps"}', '{"Barbell"}', 'The same as regular rowing, but holding a reversed grip (your palms pointing forwards):

Grab the barbell with a wide grIp (slightly more than shoulder wide) and lean forward. Your upper body is not quite parallel to the floor, but forms a slight angle. The chest''s out during the whole exercise.

Pull now the barbell with a fast movement towards your belly button, not further up. Go slowly down to the initial position. Don''t swing with your body and keep your arms next to your body.', 'https://wger.de/media/exercise-images/110/Reverse-grip-bent-over-rows-1.png', null, 'wger', '2f0ddf9a-f520-4c55-8883-f0d4a789f481', 'CC-BY-SA 3', 'wger.de'),
  ('Incline bench pulldown', 'push_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Lying face down on the incline bench facing the cable machine, perform the pulldown.', 'https://wger.de/media/exercise-images/1138/6c35fd79-ef35-4cf3-abf5-9c969457b8d4.PNG', null, 'wger', '4e941b0d-4b2f-4393-89cf-6a5e9b69252e', 'CC-BY-SA 4', 'Franpol'),
  ('Seated rear delt rise', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Dumbbell"}', 'Seated, bent 45 deg forward. Arms fully stretched out, raise arms up to shoulder height and back down', 'https://wger.de/media/exercise-images/1098/fa5328a2-64cb-4afb-a283-b3d948ddaf3f.jpg', null, 'wger', 'c302fd80-ce74-4202-9eee-30834872cffb', 'CC-BY-SA 4', 'philip'),
  ('Dynamic side hold', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Kettlebell"}', 'Sling a rubber band on a kettlebell and lift the kettlebell by the rubber band. Let it hang by your side and stand on one leg, switch leg while continuing hold. Repeat with other hand', null, null, 'wger', '45d89ca5-f5c7-4e56-9833-fd160cd2666d', 'CC-BY-SA 4', 'philip'),
  ('Wall balls', 'squat', false, true, true, 'Legs', '{"Shoulders","Glutes","Quads"}', '{"Biceps","Chest","Abs","Trapezius"}', '{"Swiss Ball"}', 'Get a medicine ball, shoulder width stance, squat, thrust the ball as high as possible against the wall and catch', 'https://wger.de/media/exercise-images/1100/ab203e0c-8220-4537-987c-871eb259d687.jpg', null, 'wger', 'f20ab712-f953-4705-8710-9681392ddd07', 'CC-BY-SA 4', 'philip'),
  ('Triceps Pushdown', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'Triceps pushdown on cable using lat bar.', 'https://wger.de/media/exercise-images/1185/c5ca283d-8958-4fd8-9d59-a3f52a3ac66b.jpg', null, 'wger', '6ebb138e-bb0a-402e-84e5-68fe0896e897', 'CC-BY-SA 4', 'anto.kreegyr'),
  ('Alternate back lunges', 'squat', false, true, false, 'Legs', '{"Glutes","Quads"}', '{}', '{"Bodyweight"}', 'The posterior muscles of the buttocks, hamstrings, soleus and gastrocnemius are trained more', null, null, 'wger', '5831bcbb-28a7-4bd5-930d-a740acccf747', 'CC-BY-SA 4', 'clafal'),
  ('Walking bridge', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Shoulders","Biceps","Glutes","Lats"}', '{"Bodyweight"}', 'from a standing position with knees slightly bent and hands resting on the floor. From here, proceed forward with your hands keeping your buttocks contracted and without losing control of your lower back.', null, null, 'wger', 'f636ae1c-f678-48fe-96b3-1a9ae81f43ce', 'CC-BY-SA 4', 'clafal'),
  ('One Arm Bent Row', 'pull_h', true, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{"Cable machine"}', 'One arm bent over row on cable with a machine', 'https://wger.de/media/exercise-images/1186/1987a039-cf35-437e-bbdc-40c53dd7d053.jpg', null, 'wger', '6b6c69bc-0b1e-4b2f-ab61-4945eb18047e', 'CC-BY-SA 4', 'anto.kreegyr'),
  ('Seated Knee Tuck', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Sit on floor or mat. Place arms slightly behind you. Raise legs. Now extend your legs and pull them back.', 'https://wger.de/media/exercise-images/1105/36776818-799a-40bf-9eca-aebb3aa5008f.png', null, 'wger', '371cfda2-1de6-419a-b40c-fc98fd3f7e41', 'CC-BY-SA 4', 'utkb'),
  ('Pallof Press', 'isolation', false, false, true, 'Abs', '{"Shoulders","Glutes","Obliquus externus abdominis","Abs","Serratus anterior","Trapezius"}', '{"Chest","Triceps"}', '{"Cable machine"}', 'The Pallof press is an anti-rotation exercise that trains the larger and smaller muscles around the spine to resist rotation.

Stand parallel to the cable machine or to the anchor point to the
resistance band and clasp with the handle or band with both hands.
Make sure your torso is front on and bring your hands to the center of your chest and slowly press out.
Slowly return your hands to the chest and repeat.', 'https://wger.de/media/exercise-images/1194/074e1766-4208-4a67-a211-9721772d99b0.png', null, 'wger', 'e56f2970-e4c9-45eb-8e8c-52abb590e7a6', 'CC-BY-SA 4', 'prevail90'),
  ('Push-Ups | Incline', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Bench","Incline bench"}', 'Inclined push-ups primarily target the chest muscles (pectoralis major and minor), but also work the triceps, shoulders, and core to a lesser extent. Because the upper body is elevated, the incline push-up places less emphasis on the triceps compared to regular push-ups, which may be beneficial for individuals looking to specifically target their chest muscles.', null, null, 'wger', '4aa7e2a7-86ad-4322-978f-ff8b391f556c', 'CC-BY-SA 4', 'anon1337'),
  ('Push-Ups | Decline', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{"Bench","Incline bench"}', 'Decline push-ups are another modified version of the traditional push-up that target the upper body muscles in a different way. To perform a decline push-up, elevate your feet on an elevated surface, such as a bench, chair, or step, while placing your hands on the ground in a push-up position. Lower your body towards the ground while maintaining a straight line from your shoulders to your ankles, and then push back up to the starting position.
Unlike the inclined push-up, the decline push-up places more emphasis on the shoulders and triceps, while still engaging the chest muscles to a lesser extent. By elevating your feet, you increase the difficulty of the exercise by placing more weight on your upper body, forcing your shoulders and triceps to work harder to push your body back up. The decline push-up can be a great way to challenge your upper body strength and improve your ability to perform other push-up variations. As with any exercise, be sure to use proper form and start with a height that is appropriate for your strength and fitness level.', 'https://wger.de/media/exercise-images/1112/81f40bee-4adf-4317-8476-1a87706e3031.png', null, 'wger', '50037aaf-34f1-4018-b504-206623b77c46', 'CC-BY-SA 4', 'anon1337'),
  ('Push-Ups | Parallettes', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{}', 'Parallettes push-ups are a variation of the traditional push-up that are performed with the hands on parallel bars, known as parallettes. To perform a parallettes push-up, assume a push-up position with your hands on the parallettes and your feet on the ground. Lower your body towards the ground while keeping your elbows close to your sides, and then push back up to the starting position.
Parallettes push-ups place more emphasis on the chest and shoulders compared to traditional push-ups, as they allow for a greater range of motion in the shoulder joint. This increased range of motion can also help to improve shoulder stability and mobility. Additionally, parallettes push-ups engage the core muscles more than traditional push-ups, as the instability of the parallettes requires greater activation of the core muscles to maintain proper form.
The added challenge of balancing on the parallettes also requires greater upper body strength and control, making parallettes push-ups a more advanced variation of the traditional push-up. They can be a great way to challenge yourself and add variety to your upper body workout routine. As always, be sure to use proper form and start with a level that is appropriate for your strength and fitness level.', null, null, 'wger', 'bd141adb-b9ad-4038-b11f-1db8665f72bc', 'CC-BY-SA 4', 'anon1337'),
  ('Machine glute extension', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{}', 'A GHD hip extension is one of the best exercises for the glutes. While the exercise mainly targets the glutes, it is also excellent for the lower back, the calves and the hamstrings.', null, null, 'wger', 'ab872d04-ca20-4341-b3c9-76763b25ef42', 'CC-BY-SA 4', 'Franpol'),
  ('Arabesque', 'squat', false, true, false, 'Legs', '{"Hamstrings","Glutes"}', '{}', '{"Bodyweight"}', 'Take all your weight onto one leg and you''re going to maintain that position, keeping your hips and pelvis level the whole time. With your back in a neutral position you want to tilt yourself forward kicking your leg back up and then slowly with your glutes bring yourself back up to neutral.', 'https://wger.de/media/exercise-images/1141/c7be1cd1-46c5-4a86-a114-5f0fe861c3e0.jpg', null, 'wger', '7dd7a735-c1fe-4ca0-a6e8-e825d897b065', 'CC-BY-SA 4', 'cleen'),
  ('Back extensión', 'pull_h', false, false, false, 'Back', '{"Lats","Serratus anterior"}', '{}', '{}', 'Espalda en maquina de extensión con peso', 'https://wger.de/media/exercise-images/1143/6e21cb6c-da09-4bcd-b9d2-1ef75237b763.png', null, 'wger', 'deebd257-f84d-4879-9dc4-353ee0ea534f', 'CC-BY-SA 4', 'Franpol'),
  ('Alternating Biceps Curls With Dumbbell', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Hold two dumbbells, the arms are streched, the hands are on your
side, the palms face inwards. Bend one arm at a time and bring the weight with a
fast movement up. At the same time, rotate your arms by 90 degrees at
the very beginning of the movement. At the highest point, rotate a
little the weights further outwards. Without a pause, bring the arm back down, slowly, and do the same with the other arm.

Don''t allow your body to swing during the exercise, all work is done
by the biceps, which are the only mucles that should move (pay attention
to the elbows).', 'https://wger.de/media/exercise-images/1192/651a4535-8210-4dbd-8f06-61d95fdd9963.png', null, 'wger', '94238bef-15ee-42b6-8035-79854b3c6e65', 'CC-BY-SA 4', 'Franpol'),
  ('Russian Twist', 'isolation', false, false, true, 'Abs', '{"Lats","Obliquus externus abdominis","Abs"}', '{}', '{"Dumbbell","Gym mat","Swiss Ball"}', 'Hold a dumbbell, barbell weight or something else that is heavy with both hands, but make sure it is not too heavy and you are able to keep in form.
Lean back to a 45-degree angle from the floor. For an extra challenge, lift your feet off the floor.
Rotate your arms to one side to the same level as your chest, touch the floor for a little extra challenge, and then do the same to the other side. When you''re back in your original position after doing both sides it will count as 1 rep.', 'https://wger.de/media/exercise-images/1193/70ca5d80-3847-4a8c-8882-c6e9e485e29e.png', null, 'wger', '10510fb5-6ebd-4ddc-b03e-423b15deceea', 'CC-BY-SA 4', 'lion'),
  ('Side Slides + Squats', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Calves","Glutes"}', '{"Bodyweight"}', 'With feet a little wider than shoulder-width apart and staying low to mimic a defensive position, you should step with their lead leg and push off with their plant leg.
After three slides, rotate your body for 180 degree on the guiding (/outer) leg and do a squat. Continue.', null, null, 'wger', 'cd7bbafc-4092-4194-aa20-e380f1fe45f0', 'CC-BY-SA 4', 'Insight'),
  ('Wall Drills', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Calves"}', '{"Bodyweight"}', 'Exercises for strengthening knee and leg musculature.

Lateral Wall Drills March - https://youtu.be/9RiTlJ6Mmek
Lateral Wall Drills OPEN - https://youtu.be/ADRlN8-Wfdg
Lateral Wall Drills CROSS - https://youtu.be/hGH2sj0Tzu4', null, null, 'wger', '36a309ba-7dd1-43c9-9efc-788c7cd9fbd6', 'CC-BY-SA 4', 'Insight'),
  ('Inverted Rows', 'push_h', false, false, true, 'Chest', '{"Biceps","Lats"}', '{"Chest","Abs","Trapezius"}', '{"Bodyweight"}', 'Maintain a straight body, retract your shoulder blades, and pull your
chest to the bar for an effective back and upper body workout.', 'https://wger.de/media/exercise-images/1198/864906ac-4ac7-4e52-a886-c6bb97950a9f.jpg', null, 'wger', '8d56eb18-b000-41ff-8b31-c74df3a4b34b', 'CC-BY-SA 4', 'Gavru'),
  ('Dragon squat', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Hamstrings","Calves","Glutes"}', '{"Bodyweight"}', 'Start standing with your feet hip-width apart. Cross your right foot behind you to the left corner and back of the room while bending both knees. Return and repeat, alternating sides. Keep your hips and shoulders forward as you cross your feet and bend your knees.', null, null, 'wger', '8c132ea0-7885-474f-8514-0909ae22bdf6', 'CC-BY-SA 4', 'cynomops'),
  ('Calf raises, left leg', 'isolation', false, true, false, 'Calves', '{"Calves"}', '{}', '{"Bodyweight"}', 'Stand on the floor or on the edge of a step to increase the range of movement.
Raise one foot.
Lift your heel until you''re standing on your toes.
(variable) Stay in this position for three seconds
Slowly lower your foot until you almost touch the ground with your heel - don''t slam your foot!', null, null, 'wger', 'db4eaf0f-f4d4-4e63-b9fb-258985bc2858', 'CC-BY-SA 4', 'wakanda90'),
  ('Full Sit Outs', 'isolation', false, false, true, 'Abs', '{"Glutes","Obliquus externus abdominis","Abs"}', '{}', '{"Bodyweight"}', '(A) Get in high plank position on your hands and toes.(B) Shift your weight to your left hand as you turn your body to the right; bend your right leg behind you and extend your right arm up. Return to the center and repeat on the opposite side. Continue, alternating sides.Make it easier: Don’t raise your arm after you bend your leg behind you.Make it harder: Balance with your arm and leg extended for two counts.', null, null, 'wger', 'e5a62151-5350-4c86-8a19-3e9ca7bf0f38', 'CC-BY-SA 4', 'http://www.realsimple.com/health/fitness-exercise/'),
  ('Reverse Snow Angel', 'pull_h', false, false, true, 'Back', '{"Trapezius"}', '{"Shoulders","Hamstrings","Glutes","Obliquus externus abdominis","Abs"}', '{"Bodyweight"}', 'Lay flat on your stomach with your arms extended in front of you on the ground as your legs are lying flat. Lift both your arms and move them to your side slowly. Then, move them back.', null, null, 'wger', '603895ca-20a0-4272-a62b-293d14220390', 'CC-BY-SA 4', 'mike6426'),
  ('Exercise Band Dorsiflexion', 'squat', false, true, false, 'Legs', '{"Soleus"}', '{}', '{"Resistance band"}', 'This exercise uses an exercise band. It targets the Soleus and Tibialis anterior.', null, null, 'wger', '29a361d5-1300-4fb4-90d6-d6350bec9cb9', 'CC-BY-SA 4', 'erikocobra'),
  ('Exercise Band Plantarflexion', 'squat', false, true, false, 'Legs', '{"Calves"}', '{"Soleus"}', '{"Resistance band"}', 'Banded plantarflexion is a great way to bridge the gap between plantarflexion range of motion and the more strenuous calf raises in weight bearing. This can help strengthen the calf muscles, load the Achilles tendon, and improve plantarflexion range of motion.', null, null, 'wger', '70c97a79-5e88-4549-a74c-0e5190a5c048', 'CC-BY-SA 4', 'erikocobra'),
  ('Knee push-ups', 'isolation', false, false, true, 'Arms', '{"Shoulders","Chest"}', '{"Serratus anterior","Triceps"}', '{"Bodyweight"}', 'Start by kneeling on the floor, keeping your knees together. Place your hands on the floor in front of you, slightly wider than shoulder-width apart.
Make sure your body forms a straight line from head to knees. Hands should be positioned below shoulders.
Lower your torso towards the ground, bending your elbows while keeping your trunk stable. Keep your knees in contact with the floor.
Push through your hands to return to the starting position. Be sure to maintain contraction of chest, shoulder and arm muscles at the top of the movement.
Perform the desired number of repetitions, controlling the movement and maintaining good form.', null, null, 'wger', '2b61df61-f71e-4b8f-9f95-6a565238a8ae', 'CC-BY-SA 4', 'PaukOne'),
  ('Australian pull-ups', 'isolation', false, false, true, 'Arms', '{"Shoulders","Biceps","Lats"}', '{"Trapezius"}', '{"Bodyweight"}', 'Lie down under a high bar or suspension bar, positioned at an appropriate height.
Position yourself on your back under the bar, gripping the bar with a supinated grip (palms facing you).
Adjust your position so that your body is aligned straight from head to toe. Arms should be fully extended, shoulders stabilized, and legs aligned with the rest of the body.
Bend your elbows and pull your chest towards the bar, contracting your back muscles. Imagine you''re trying to bring your shoulder blades together.
Hold the contraction at the top of the movement for a moment to maximize muscle activation.
Slowly return to the starting position, extending your elbows.', null, null, 'wger', '4037fc14-d7a9-4901-8341-6538e415adc4', 'CC-BY-SA 4', 'PaukOne'),
  ('Shoulder Dumbbell Pendular Exercise', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Lats","Chest","Trapezius"}', '{}', '{"Dumbbell"}', 'Lean forward to rest your hand on a chair or other object, holding a dumbbell in the other hand
Gently swing the dumbbell in a circular motion', null, null, 'wger', 'e237611c-2730-4d0c-891b-bb29d3d15297', 'CC-BY-SA 4', 'Croak6728'),
  ('Stroke-and-Roll Drill', null, false, false, true, 'Cardio', '{"Shoulders","Obliquus externus abdominis"}', '{"Lats","Abs"}', '{}', 'Push off, swim a few strokes, and every breath roll fully onto your back for 2-3 breaths, then roll back into freestyle. This teaches you to rotate your body as a unit rather than just turning your head, and helps remove the fear of not having your face in the water.', null, null, 'wger', '1c17c370-dd74-46c4-b4f2-039c510af058', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Dumbbell Single-leg Hip Thrust', 'hinge', true, true, true, 'Legs', '{"Glutes"}', '{"Hamstrings","Quads"}', '{"Dumbbell"}', 'The single-leg hip thrust is performed by placing your upper back on a weight bench, raising one leg, and extending the hip of the other leg to achieve an isolated contraction of the glute.
By working each side separately, you can fully isolate your glutes unilaterally, providing maximal training stimulus.', null, null, 'wger', '7cc24acf-3fc9-4d14-a461-cd00d1d18f0e', 'CC-BY-SA 4', 'carlos3c'),
  ('Shoulder External Rotation with Dumbbell', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Brachialis"}', '{"Trapezius"}', '{"Dumbbell"}', 'Lie on your side holding a dumbbell in your upper hand
Tuck your elbow into your side and rest the hand in front of you
Rotate the shoulder so the hand raises up
Lower the hand down', null, null, 'wger', '2eead109-098e-4c59-bdef-f580a6a82748', 'CC-BY-SA 4', 'Croak6728'),
  ('Claps over the head', 'isolation', false, false, false, 'Arms', '{"Shoulders"}', '{}', '{"Bodyweight"}', 'Stand with your feet shoulder width apart. Raise your arms and clap over your head', 'https://wger.de/media/exercise-images/1223/bf20836a-23b0-4f50-8b98-cfdd97684527.webp', null, 'wger', 'ecf9c0e2-a1d0-4e6e-90e9-5c029e98f2c9', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Dumbbell drag curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Hold a dumbbell in each hand with your palms facing forward. Pull your elbows back and lift the dumbbells to your chest height. Slowly lower the dumbbell and repeat the exercise.', null, null, 'wger', '2418b290-801c-45fd-a990-fc9f234ab1e5', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Leg Extension', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{}', 'The leg extension is a resistance weight training exercise that targets the quadriceps muscle in the legs. The exercise is done using a machine called the Leg Extension Machine. There are various manufacturers of these machines and each one is slightly different. Most gym and weight rooms will have the machine in their facility. The leg extension is an isolated exercise targeting one specific muscle group, the quadriceps. It should not be considered as a total leg workout, such as the squat or deadlift. The exercise consists of bending the leg at the knee and extending the legs, then lowering them back to the original position.', 'https://wger.de/media/exercise-images/369/78c915d1-e46d-4d30-8124-65d68664c3ef.png', null, 'wger', '62170477-90ec-463c-907e-9e523abc0a15', 'CC0', 'BFad07'),
  ('Incline Shoulder Press Up', 'push_v', false, false, false, 'Chest', '{"Shoulders","Chest"}', '{}', '{"Bench"}', 'Place your hands on the bench in a press up position
Push your chest away from the bench to separate your shoulder blades
Keeping your elbows straight, lower your chest towards the bench so your shoulder blades move closer together
Push your chest away from the bench again', null, null, 'wger', '743690d3-dbfb-417a-a049-8b77fd5df31b', 'CC-BY-SA 4', 'Croak6728'),
  ('Dumbbell wide bicep curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Hold a dumbbell in each hand with your hands slightly wider than shoulder-width apart and palms facing forward.
Bend your elbows and lift the dumbbells to your shoulders. Slowly return and repeat.', 'https://wger.de/media/exercise-images/1225/39a0b7e7-9780-425d-84f5-56d10d1690ac.gif', null, 'wger', 'fd38d854-a244-4646-842b-ef1e0fbfede8', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Dumbbell bicep curl to press', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Bend your elbows and lift the dumbbells to your shoulders.
Push the dumbbells over your head while rotating your arms to make your palms face forward. Reverse it to lower down. Repeat the exercise.', 'https://wger.de/media/exercise-images/1226/a6154dbd-67a0-4a36-8748-0f5af3865e83.jpg', null, 'wger', '8675ea3b-0e8b-4a08-9e82-4525ec91dd23', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Shoulder width three-point push-up', 'push_h', false, false, true, 'Arms', '{"Chest"}', '{"Shoulders","Abs","Triceps"}', '{"Bodyweight"}', 'Get into a push-up position with your shoulders directly above your hands and your feet hip-width apart. Draw your belly button in towards your spine and tighten your abdominal muscles. Lift your left foot about five centimetres off the floor. Point your toes straight down. Do not move your hips. Your body forms a straight line from your head to your heels throughout the exercise. Now bend your elbows, lower your chest to the floor and push yourself back up. Repeat the exercise on the other side.', null, null, 'wger', '716286dd-05b1-4f87-8b3b-a0c559bcafc4', 'CC-BY-SA 4', 'lxmx'),
  ('Dumbbell rear delt row', 'pull_h', false, false, true, 'Shoulders', '{"Shoulders","Brachialis","Trapezius"}', '{}', '{"Dumbbell"}', 'Hold a dumbbell in each hand. Bend at your hips to make your back almost parallel to the floor. Let your arms hang down. Keep your arms in line with your shoulders. bend and lift your elbows out to the sides until your upper arms are parallel to the floor. Slowly return and repeat', 'https://wger.de/media/exercise-images/1227/57415c3c-2963-4130-9f6f-79f6a96113b6.gif', null, 'wger', 'adb6067f-fd48-4a25-a9b4-0793c5f158fa', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Finger Pushup', 'push_h', false, false, true, 'Arms', '{"Chest"}', '{"Shoulders","Abs","Triceps"}', '{"Bodyweight"}', 'Hand Positioning:

Start in a plank position with your hands directly beneath your shoulders.
Spread your fingers wide apart, placing them firmly on the ground.

Finger Placement:

Gradually lift your palms off the ground, shifting the weight onto your fingers.
Focus on distributing the load evenly across your fingertips and thumbs.

Body Alignment:

Maintain a straight line from head to heels to engage your core.
Keep your body in a controlled and stable position throughout the exercise.

Lowering Phase:

Slowly bend your elbows, lowering your chest towards the ground.
Ensure controlled movement, maintaining stability on your fingertips.

Pushing Up:

Press through your fingertips to straighten your arms, returning to the starting position.
Emphasize the engagement of your fingers and thumbs throughout the push-up.', 'https://wger.de/media/exercise-images/1217/590e65db-de60-4727-b7eb-55f80af56043.png', null, 'wger', '676e8149-863e-4174-a09a-a327b247c00d', 'CC-BY-SA 4', null),
  ('Dumbbell close grip bench press', 'push_h', false, false, false, 'Arms', '{"Chest","Triceps"}', '{}', '{"Dumbbell"}', 'Lie down with your back on a flat bench. Hold a dumbbell in each hand. Raise your arms towards the ceiling with your palms facing each other and dumbbells pressed together.
Slowly lower the dumbbells to your chest, then slowly push them back. Repeat the exercise.', null, null, 'wger', '428112f3-3918-45ba-870a-dc58cf3959cf', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Snatch', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Barbell"}', 'Stand with your feet at hip width and your shins against the bar. Grasp the bar at double shoulder width and, keeping your lower back flat, drive your heels into the floor to begin lifting the bar. When it''s above your knees, explosively extend your hips and shrug your shoulders. Let the momentum carry the weight overhead.', null, null, 'wger', '8161de8b-7802-46c0-9bd4-db60f39b7677', 'CC0', 'Mens Fitness'),
  ('Standing biceps stretch right', 'isolation', false, false, true, 'Arms', '{"Shoulders","Biceps","Chest"}', '{}', '{"Bodyweight"}', 'Stand with your right arm close to a wall. Extend your right arm and put your right hand on the wall, then gently turn your body to the left.', 'https://wger.de/media/exercise-images/1233/d7d6f9e1-7834-4cca-bd3b-f9def33ff44d.png', null, 'wger', '671568f9-6653-4e11-ac71-3f34c74329a0', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Triceps stretch left', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Bodyweight"}', 'Put your left hand on your back, use your right hand to grab your left elbow and gently pull it. Hold this position for a few seconds.', 'https://wger.de/media/exercise-images/1230/9fd1e2fd-f2c4-432d-b3ae-5e5f24085777.webp', null, 'wger', 'aa72741d-17ae-410e-b49a-1df7aaf0afe1', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Sitting Calf Stretch (Dorsiflexion)', 'squat', false, true, false, 'Legs', '{"Calves","Soleus"}', '{}', '{"Bodyweight"}', 'This is a light stretch for the calf that is great for rehab.', 'https://wger.de/media/exercise-images/1274/bcffdf52-3c36-4b0c-b787-fb84f20bf82d.png', null, 'wger', '9f9bfa54-4702-4eb1-a72a-0fc12c846c72', 'CC-BY-SA 4', 'erikocobra'),
  ('Cable External Rotation', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'Steps:

Start off placing an extension band around a post or in a secure position where it will not release and is at elbow level.
Position yourself to the side of the band and with your hand that is opposite of the band, reach out and grab the handle.
Bring the band to your chest keeping your elbow bent in a 90 degree angle then slowly rotate your arm in a backhand motion so that the band externally rotates out
Continue out as far as possible so that you feel a stretch in your shoulders, hold for a count and then return back to the starting position.
Repeat for as many reps and sets as desired.', null, null, 'wger', 'dc3a2072-abc3-4ef9-b8e6-f5ae6b11bc7f', 'CC-BY-SA 3', 'lauroernesto'),
  ('Triceps stretch right', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Bodyweight"}', 'Put your right hand on your back, use your left hand to grab your right elbow and gently pull it. Hold this position for a few seconds.', 'https://wger.de/media/exercise-images/1231/b10457ce-5fa5-4d20-a32f-3c7100c6a9d9.webp', null, 'wger', '1b9968f4-a00b-4157-8847-1c3c7dbb0d5a', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Standing biceps stretch left', 'isolation', false, false, true, 'Arms', '{"Shoulders","Biceps","Chest"}', '{}', '{"Bodyweight"}', 'Stand with your left arm close to a wall. Extend your left arm and put your left hand on the wall, then gently turn your body to the right.', 'https://wger.de/media/exercise-images/1232/2b6de046-5806-49e3-bf36-b6fae16af021.png', null, 'wger', 'a569e8c3-218f-40db-9d71-e155c68cb26e', 'CC-BY-SA 4', 'Lynn_McIntyre'),
  ('Seated Cable Row', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{"Cable machine"}', 'Take a seat on the machine with your feet planted, a little wider than shoulder width. Drive the heels, and squeeze the glutes. Grab onto the cable handle.
Sit up tall with a slight bend through the knees. Tighten up the abs and low back to maintain a perpendicular angle to the floor with your torso.
Roll the shoulders back and down. Squeeze them together as you row, thinking about pinching a pencil in between them. As you do this, pull the handle back towards you, landing right above your belly button.
Pause here for a moment before returning the handle, still squeezing the shoulder blades. Once you''ve returned the weight to the stack, then allow the shoulder blades to relax, without pulling the torso forward.
Repeat the movement.', 'https://wger.de/media/exercise-images/1117/2555c4c3-a84d-47db-b83b-cbf721f12e45.png', null, 'wger', '0ecfec6f-5d0f-4e8a-8d37-f6203a8923b8', 'CC-BY-SA 4', 'Franpol'),
  ('Low Pulley Cable Fly', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Shoulders"}', '{"Cable machine"}', 'Adjust the cable machine: Set the pulley to the lowest setting possible.
Choose your handles: You can use neutral grip handles (palms facing each other) or straight handles depending on your preference. Neutral grip might be easier on your wrists.
Stand with proper form: Stand with your feet shoulder-width apart, knees slightly bent, and core engaged. Maintain a slight arch in your lower back throughout the exercise.
Grip the handles: Grab the handles with your chosen grip and step back a small step or two until there''s slight tension on the cables.
Initiate the movement: Keep your elbows slightly bent throughout the exercise. Imagine you''re giving someone a big hug. Squeeze your chest muscles as you bring your hands together in front of your chest.
Control the movement: Focus on squeezing your chest muscles rather than using your arms to pull the handles.
Peak contraction: Briefly hold the squeeze at the top of the movement with your hands together at chest level.
Return slowly: Slowly release the tension and return the handles back down to the starting position with your arms slightly extended but not locked out.', null, null, 'wger', 'd5116fbd-bf14-492a-86b3-140035cb48b2', 'CC-BY-SA 4', 'FEFFO'),
  ('Cable Chest Press - Decline', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Cable machine"}', 'Single arm chest press done with the cable machine. Use the other arm to brace bodyweight to focus on strength of the press, rather than balancing of the body. Start with the hand as close to the chest as possible, and then press against the cable at a slight decline and aiming towards the center of your chest.', null, null, 'wger', 'b2865908-b93e-4507-ada4-a5bb9317566c', 'CC-BY-SA 4', 'Shiladree'),
  ('Neck extension', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Cable machine","SZ-Bar"}', 'Unilateral triceps exercise with your back to the pulley, with the pulley at the top', null, null, 'wger', 'd27a93fa-7066-477c-a475-c6b6170831db', 'CC-BY-SA 4', 'polloperro'),
  ('Remo alto polea alta', 'pull_h', false, false, true, 'Back', '{"Obliquus externus abdominis","Serratus anterior","Triceps"}', '{}', '{"Cable machine"}', 'High pulley row with support using a single grip', null, null, 'wger', '9cfb8d32-579e-4e0a-945f-74e3788fbe43', 'CC-BY-SA 4', 'polloperro'),
  ('Frog stand', 'isolation', false, false, true, 'Abs', '{"Shoulders","Biceps","Brachialis","Abs"}', '{}', '{"Bodyweight"}', 'Starting position:
Stand with your feet shoulder-width apart and your toes pointing forward, facing a wall or bench for support if needed.
Bend your knees into a squat position.
Place your hands on the ground in front of you, shoulder-width apart, with your fingers spread wide.
Make sure your elbows are under your shoulders and your body forms a straight line from your head to your heels.
Upward phase:
Push with your feet and hands to lift your body off the ground.
Straighten your legs and arms, keeping your body aligned.
Engage your core and glutes to maintain the position.
If needed, rest your knees on the wall or bench for assistance.', null, null, 'wger', '00eae665-ff78-4373-9c43-f44a4a1b43e0', 'CC-BY-SA 4', 'clafal'),
  ('Standing Calf Stretch', 'squat', false, true, false, 'Legs', '{"Calves"}', '{}', '{"Bodyweight"}', 'This stretch targets the gastrocnemius (the chief muscle of the calf of the leg, which flexes the knee and foot). It is easy to perform anywhere. All you need is a wall or a chair.', 'https://wger.de/media/exercise-images/1239/5026373a-a7b4-4e26-a0aa-c46634205196.jpg', null, 'wger', 'f36dfa40-7586-4721-a434-1fd878232c62', 'CC-BY-SA 4', 'erikocobra'),
  ('Bag training', null, false, false, true, 'Cardio', '{"Shoulders","Chest","Trapezius"}', '{"Biceps","Hamstrings","Calves","Lats","Obliquus externus abdominis","Abs"}', '{"Bodyweight"}', 'Bag training improves muscle definition of: deltoids; rear deltoids; triceps; biceps, as well as being a great cardio exercise', null, null, 'wger', 'd301d901-a2c6-4916-b09e-07ab7a3c8519', 'CC-BY-SA 4', 'clafal'),
  ('Standing Soleus Stretch', 'squat', false, true, false, 'Legs', '{"Soleus"}', '{}', '{"Bodyweight"}', 'This stretch targets the Soleus part of your calf. It may be performed with a wall or chair.', null, null, 'wger', '56631e7a-471a-469c-958a-c3ff78b1e73c', 'CC-BY-SA 4', 'erikocobra'),
  ('Incline Push-ups (Vasco L2)', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Bodyweight"}', 'Vasco custom incline push-up progression for beginner home training. Bridges wall push-ups to floor push-ups. Part of Monday Push day.', null, null, 'wger', '2cc5644d-a8d7-49f5-8978-db0f2184864e', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Double Leg Calf Raise', 'squat', false, true, false, 'Legs', '{"Calves","Soleus"}', '{}', '{"Bodyweight"}', 'The double leg heel raise is important to strengthen and create control and stability around the ankle and knee, and provide balance and control for the hip and pelvis.', 'https://wger.de/media/exercise-images/1243/53d4fabe-c994-4907-873f-8d82813a9832.png', null, 'wger', '58ca3e51-ea64-4771-a74a-a74d29f5c40c', 'CC-BY-SA 4', 'erikocobra'),
  ('Yoga exercise: Cow-cat', 'pull_h', false, false, true, 'Back', '{"Shoulders","Lats","Trapezius"}', '{"Obliquus externus abdominis","Abs"}', '{"Gym mat"}', 'First get into the four-footed stance. The hands are underneath the shoulders. The fingers are fanned out wide and ensure a stable stance. It is best to rest your front body weight on your thumbs and index fingers. Now place your legs hip-width apart on the yoga mat. Your thighs should be vertically below your hips. Make sure that your weight is evenly distributed between your hands and knees. Your head is an extension of your spine and you are looking down at your mat. Your back is in a neutral position. Breathe in deeply and start with the cat. With the next exhalation, round your back vertebra by vertebra. Try to pull yourself as far as possible towards the ceiling. Pull your head towards your chest and tilt your pelvis. Now inhale deeply and move into the opposite position, cow pose. Bend your back down, pull your shoulders back slightly and lift your head as far as is comfortable for you. Your gaze is directed upwards. Breathe out consciously and switch back to the cat. With the next exhalation, switch back to cow. Repeat the exercise a few times and make sure that you are in the flow.', null, null, 'wger', '8ca01d32-2e86-49a1-a130-b99219432e42', 'CC-BY-SA 4', 'damnlost'),
  ('Front Lever', 'isolation', false, false, false, 'Abs', '{"Lats","Abs"}', '{}', '{"Bodyweight"}', 'The front lever is a figure where the body is kept in a horizontal position parallel to the floor.', null, null, 'wger', 'f41ac754-45a0-443b-afe5-e624e215229f', 'CC-BY-SA 4', 'clafal'),
  ('TRX roll out', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis","Serratus anterior"}', '{"Bodyweight"}', 'Hold the handles in your hands, extend your arms and keep them parallel at chest height. The movement you need to perform is to open your arms in line with your shoulders while leaning your body forward. Try not to extend your shoulders beyond 90°, and keep your abdominal muscles and glutes contracted. Muscles involved: transverse abdominis, rectus abdominis and spinal erectors.', null, null, 'wger', '069711c7-565a-4abb-90a7-614f66dd9dc3', 'CC-BY-SA 4', 'cynomops'),
  ('Ice cream maker', 'isolation', false, false, false, 'Abs', '{"Lats"}', '{"Abs"}', '{"Bodyweight"}', 'From the final phase of a pull-up, we push ourselves back with our shoulders until we reach the front lever position. From there, we pull ourselves back up to the starting position.', null, null, 'wger', '662b9911-fa55-4564-b830-fdb6a046b162', 'CC-BY-SA 4', 'clafal'),
  ('Front lever pull-up', 'pull_v', false, false, true, 'Abs', '{"Biceps","Lats","Abs"}', '{"Shoulders"}', '{"Pull-up bar"}', 'in the front lever position, with legs extended or easier if collected, pull by bringing the chest closer to the bar.', null, null, 'wger', 'b61dff58-6e47-4671-853b-208e7cd0ced4', 'CC-BY-SA 4', 'clafal'),
  ('Front lever tuck', 'pull_h', false, false, true, 'Back', '{"Shoulders","Biceps","Lats"}', '{"Triceps"}', '{"Pull-up bar"}', 'The muscles involved in the Front Lever, most subjected to stress, are mainly the extensors such as: the latissimus dorsi, the teres major, the posterior deltoid and the long head of the biceps.', null, null, 'wger', 'e79616cb-f5fb-4b10-b99d-09d43774e142', 'CC-BY-SA 4', 'clafal'),
  ('TRX Obliques', 'isolation', false, false, true, 'Abs', '{"Obliquus externus abdominis","Abs","Serratus anterior"}', '{"Shoulders","Chest"}', '{}', 'Place your feet in the stirrups and assume a high plank with your hands directly beneath your shoulders.
Pull your knees to your right elbow, then push them back out and to the centre.', null, null, 'wger', '6679b2ad-91b7-4a75-9230-3ae1101bdd50', 'CC-BY-SA 4', 'cynomops'),
  ('TRX hammer curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{}', 'Place the grips as if they were a continuation of the straps. We will position our arms stretched forward and our body leaning back, completely straight. The biceps muscles will activate as you bend your elbows to bring your body towards the straps. The contraction movement will end with a slight outward movement of the hands, due to the grip we are using.', null, null, 'wger', 'f36a9fd0-7bd2-42a4-85fa-902b7cf3be45', 'CC-BY-SA 4', 'cynomops'),
  ('TRX gorilla biceps curl', 'isolation', false, false, false, 'Arms', '{"Brachialis"}', '{"Biceps"}', '{}', 'We''ll stand facing the TRX straps and grab them with our fists facing each other, facing forward, with our arms fully extended at about shoulder-width apart. We''ll keep our body straight, backward, as in the previous exercises, since we''ll be lifting our body toward the TRX straps by activating our biceps. Our body will be straight, with our feet flat on the floor. This time, we''ll place our arms open to the sides and at chest height. The movement we''ll perform is a contraction toward our chest. To achieve this, we''ll bend our elbows so that, by activating our biceps, we can pull our body toward the straps.', null, null, 'wger', 'f9329ed4-8185-49a6-a0bb-e0f21c6cc3d8', 'CC-BY-SA 4', 'cynomops'),
  ('Trx Single Arm Bicep Curl', 'isolation', true, false, true, 'Arms', '{"Biceps","Brachialis"}', '{"Shoulders","Trapezius"}', '{}', 'Step 1: Stand comfortably and grasp the handles of the suspension system. Step 2: Lean back resting your weight on one arm, keepng the spine neutral. Step 3: Slowly curl to pull your body weight to the up position. Supinate the arm and squeeze as you approach the end position. Step 4: Lower yourself back down and repeat.', null, null, 'wger', '7f2628bf-6381-4228-9840-b75cbcc843a1', 'CC-BY-SA 4', 'cynomops'),
  ('TRX Tricep Extension', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{}', 'Attach the TRX or other suspension system overhead, having the handles hanging at chest level or slightly lower. Experiment to see what height allows you to set up in the best way.
Stand in front of the handles and grab them with your palms facing down.
Engage your abs, squeeze your glutes, take a breath and lean forward, lifting your heels off the floor. Keep your elbows straight.
Take another breath and lower yourself slowly by bending your elbows.
Go down until your elbows are at a 90-degree angle (to the point where your wrists are above your elbows). Hold the position for a moment.
Extend your arms by engaging your triceps and bring yourself to the starting position as you exhale.', null, null, 'wger', 'de8a3db6-2b05-4c4e-977b-b61342718356', 'CC-BY-SA 4', 'cynomops'),
  ('TRX dips', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{"Chest"}', '{}', 'Start with the hands on the suspension trainer and feet on the ground.
Your hands should be under your shoulders with the feet slightly in front.
Lower yourself by bringing the hips between the handles and flexing the elbows.
Extend the elbows to come back to the starting position and repeat.', null, null, 'wger', '8019be2c-47a3-475f-8e16-a2fca761a8fe', 'CC-BY-SA 4', 'cynomops'),
  ('Pullover', 'pull_h', false, false, false, 'Back', '{"Chest"}', '{"Lats"}', '{"Dumbbell"}', 'Doubling as a back and chest exercise, the Dumbbell Pullover can train both your pecs and lats.', null, null, 'wger', '9ccd53e0-8392-4e61-91aa-e4e5f4ea339c', 'CC-BY-SA 4', '3leh'),
  ('Biceps Close Grip Pull Down', 'pull_v', false, false, true, 'Arms', '{"Biceps"}', '{"Shoulders","Lats"}', '{}', 'On a lat pull down machine, hold the bar keeping your hands relatively close. Use an underhand grip (I.E.: the back of your hand must be facing the machine). Then pull down the bar in a straight line towards the ground. Make sure your biceps are the main drivers of the motion. You will probably feel your shoulders and lats working, but make sure your biceps are working more.', null, null, 'wger', '8bb42000-834f-48ab-af5c-0c31d94e0181', 'CC-BY-SA 4', 'daniel.escada'),
  ('Isometria trazioni impugnatura inversa', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{"Pull-up bar"}', 'Trazioni in isometria con impugnatura inversa', null, null, 'wger', '5fd01c23-6c54-40cb-9a67-87c7a325baee', 'CC-BY-SA 4', 'clafal'),
  ('Incline Chest-Supported Dumbbell Row', 'pull_h', false, false, true, 'Back', '{"Biceps","Lats","Trapezius"}', '{}', '{"Bench","Dumbbell"}', 'Set up an adjustable bench at a 45-degree angle.
Lay on your stomach with your head hanging just above the edge of the bench.
Grab a dumbbell in each hand and set up with a good posture – core and lats engaged and shoulders neutral.
Row the dumbbells toward the top of the stomach and squeeze the back at the top of the rep.
Finally, lower the dumbbells back to the starting position and repeat until all reps are completed.', 'https://wger.de/media/exercise-images/1283/e7262f70-7512-408a-8d00-4c499ef632fc.jpg', null, 'wger', '51a2d520-b510-4b6e-bd65-9fc40365e8de', 'CC-BY-SA 4', 'carlos3c'),
  ('Pseudo Planche Push-up', 'push_h', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Chest"}', '{"Bodyweight"}', 'You should have the shoulder line in front of your wrists an perform a push-up, maintaining the shoulder in the same position', null, null, 'wger', 'c38b0f69-7f01-4f0f-82cc-e33cdc658f9e', 'CC-BY-SA 4', 'vdrb'),
  ('Talons fesses', null, false, false, false, 'Cardio', '{"Calves"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Touch your heels to your buttocks, while remaining static or moving', 'https://wger.de/media/exercise-images/1285/1ab8005d-41e4-4505-9a7d-5277d59bb3cd.jpg', null, 'wger', '42657bd4-bf4e-4429-8e6a-2f5f585aa22a', 'CC-BY-SA 4', 'painDpice'),
  ('Dynamic Planche', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Start in a plank position, with your hands directly under your shoulders and your feet hip-width apart.
Engage your core to keep your body in a straight line from head to toe.
From this position, bend your knees slightly and jump with both feet inward, bringing them as close to your core as possible
As soon as your feet touch the ground, push off forcefully to jump again and return to the starting plank position.
Continue repeating this jumping motion, maintaining control and core stability throughout the exercise.
Make sure to keep your breathing steady while jumping, breathing deeply and controlling your breathing.
Keep your gaze fixed on the ground to maintain proper spinal alignment.
Repeat the jumps for the desired length of time or the number of repetitions recommended for your workout program.
To finish the exercise, rest by releasing the plank position, then stretch if necessary to loosen your muscles.', null, null, 'wger', '73dbe7a5-e8f3-48fd-814e-bc3378c15be2', 'CC-BY-SA 4', 'painDpice'),
  ('Reach ups', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Bodyweight"}', 'To perform this exercise, lie on your back with your arms extended overhead. Then, contract your abdominals and lift your torso off the floor while reaching your arms toward the ceiling to "reach" as high as possible. Slowly return to the starting position, controlling the movement. Reach ups strengthen the abdominal muscles and improve the flexibility of the spine. They can be incorporated into a variety of training routines to work on core strength and stability.', null, null, 'wger', '6c21c09b-90c8-4e43-a43c-ed566f812784', 'CC-BY-SA 4', 'painDpice'),
  ('Dynamic side plank', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Bodyweight"}', 'The dynamic side plank involves positioning yourself on your side, supported on one elbow and the side of your foot, then dipping your hips up and down while keeping your body in a straight line.', null, null, 'wger', '81c6b9ef-7cb7-4328-8cb4-47ae8ecc42be', 'CC-BY-SA 4', 'painDpice'),
  ('Seated Dumbbell Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Dumbbell"}', 'Seated Dumbbell Curls are an effective bicep workout that isolates the muscles by stabilizing the upper body, reducing momentum that can detract from the exercise’s effectiveness. This exercise is performed sitting down with a dumbbell in each hand, focusing on controlled movement to maximize engagement of the bicep muscles.', null, null, 'wger', '19fba43a-8363-4da3-82c6-d8a14628b5e7', 'CC-BY-SA 4', 'sTiKyt'),
  ('Reverse Grip Barbell Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Barbell"}', 'Hold the barbell with an overhand grip (palms facing down) approximately shoulder-width apart. Ensure your back is straight, shoulders slightly pulled back, and arms fully extended.
Curl the barbell upwards towards your chest in a controlled motion, keeping your elbows close to your body. The motion should be smooth without any swinging or momentum use.
Once the barbell is at chest level, pause briefly to maximize contraction in the biceps and forearms.
Slowly lower the barbell back to the starting position with a controlled movement, fully extending your arms.', 'https://wger.de/media/exercise-images/1290/c05818bf-1c81-46df-9f24-42e354265388.png', null, 'wger', 'dd6e8753-a574-476e-900a-b794eb592e7b', 'CC-BY-SA 4', 'sTiKyt'),
  ('Reverse-grip pull-ups', 'isolation', false, false, true, 'Abs', '{"Biceps","Lats"}', '{"Abs"}', '{"Pull-up bar"}', 'Pull-ups on the bar with your thumbs pointing outward.', null, null, 'wger', '2acb5ba1-caa3-4204-9903-ff0095b032ba', 'CC-BY-SA 4', 'clafal'),
  ('One armed push-ups', 'isolation', false, false, true, 'Abs', '{"Chest","Triceps"}', '{"Shoulders","Abs"}', '{"Bodyweight"}', 'Perform push-ups with one hand, alternating the sides', null, null, 'wger', '8911c37d-8907-4077-b883-86a7c5fcb606', 'CC-BY-SA 4', 'clafal'),
  ('Cable Tri Extension - Internal Rotation', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'single arm exercise with cable held at opposite shoulder with elbow bent. Turn towards the cable, and the straighten the elbow across the body.', null, null, 'wger', '07ded945-de5d-4e77-b13c-17d51a2f0007', 'CC-BY-SA 4', 'Shiladree'),
  ('Preacher Curl - Internally Rotated', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Single arm curl that can be done using a dumbbell and a preacher bench, or a preacher curl machine. Turn body towards the weight', null, null, 'wger', '4baa4962-64bd-434f-b2ed-0c3c88099841', 'CC-BY-SA 4', 'Shiladree'),
  ('JM Press', 'isolation', false, false, true, 'Arms', '{"Triceps"}', '{"Biceps","Chest"}', '{"Barbell"}', 'The JM press keeps your shoulders stationary, relying on the elbow flexion and extension to move the weight using your triceps strength. That means you get all the benefits of the best triceps-strengthening exercises without overtaxing that delicate shoulder joint. Classic win-win!', null, null, 'wger', '67c2fe41-f1e9-4f75-b2cb-72d1f2e092f7', 'CC-BY-SA 4', 'Epiphany8424'),
  ('Helms Row', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{"Trapezius"}', '{"Dumbbell"}', 'Setup: Place your chest on the end of a bench, using a towel or anything soft to keep your chest protected. You want your chest to be in contact with the bench around the nipple line. Your back should be almost parallel to the floor
Execution: When you’re starting the exercise, focus on pulling your elbows back until you feel maximum tightness in the lats.
If you want to get some trap activation with the exercise, relax your shoulder blades when the weights are hanging down and then retract them as you start the rep.', null, null, 'wger', 'e781dae5-90b8-4105-8aa6-82d278ac5ff5', 'CC-BY-SA 4', 'carlos3c'),
  ('Meadows Row', 'pull_h', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Biceps","Abs"}', '{"Barbell"}', 'The Meadows row is a unilateral row performed with a landmine setup, overhand grip, and staggered stance. Lean your torso forward and grip the barbell. Rest the other forearm on the forward leg. Start this movement by driving the elbow behind you while retracting the shoulder-blade. Keep the working shoulder down. Pull toward your back hip until the elbow is level with your torso.', null, null, 'wger', '28b65190-cae2-4d15-8f4e-dde0d9cc4d4b', 'CC-BY-SA 4', 'carlos3c'),
  ('Front Plank', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis","Chest","Quads","Serratus anterior"}', '{"Bodyweight"}', 'The plank is a bodyweight exercise. As a multi-functional movement, the plank not only targets your abdominal muscles but also the spine and hip. Plank strengthens and tightens your entire body, improves your posture and balance, reduces body fat, and can help boost your metabolism.
Exercises such as the “plank pose” help strengthen the stamina of stabilizing abdominal muscles. It can also help relieve back pain associated with a weakening of the function of the stabilizing muscles of the body.
Planks are a versatile exercise that targets many of the most important muscle groups in the body, so they can be applied by anyone to improve endurance and overall body strength.', null, null, 'wger', 'dd9dcfd2-879f-422a-ad06-d2c187c58d1f', 'CC-BY-SA 4', 'hektkaso'),
  ('One Arm Overhead Cable Tricep Extension', 'isolation', true, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'Set the pulley at the bottom of the cable machine and grab onto it without using any attachments. Extend the cable directly overhead.

While keeping your back straight and upper arm stationary, lower the cable behind your head until you feel a good stretch in your triceps, and then extend it back upward until your elbow is locked out.', null, null, 'wger', '5ed12527-c8be-4e86-8f2a-cf9dd4781f5b', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Recovery Bobbing', null, false, false, false, 'Cardio', '{"Abs"}', '{}', '{}', 'Same motion as the Bobbing Exhale Drill, but done in slightly deeper water (so you''re not touching the bottom) and at a slower, more relaxed pace — think of it as a recovery/reset exercise rather than a hard drill. Use it between harder drills to reset your breathing rhythm and calm down if you''re feeling rushed or out of sync.', null, null, 'wger', '6705ec92-c6c6-4b2c-b919-bddb8177bf98', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Curl - With Shoulder Elevated', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Place elbow so that it is about level with the shoulder. Curl the wieght to your shoulder. Focus on the stretch in the eccentric part of the curl', null, null, 'wger', '9828f705-350b-4afd-86c4-fcc0e8a0fb4b', 'CC-BY-SA 4', 'Shiladree'),
  ('Single-leg hamstring curl', 'squat', true, true, false, 'Legs', '{"Hamstrings"}', '{"Glutes"}', '{"Bodyweight"}', 'Specifically, the muscles involved are: biceps femoris, semimembranosus and semitendinosus.', null, null, 'wger', 'caccd791-ff30-452a-816e-790edadb78cd', 'CC-BY-SA 4', 'clafal'),
  ('Jumping Jack HD', null, false, false, true, 'Cardio', '{"Quads"}', '{"Glutes","Obliquus externus abdominis","Abs"}', '{"Bodyweight"}', 'Jumping jack are a plyometric exercise. Plyometrics are explosive aerobic moves that increase speed, quickness, and power and they work your whole body.
Jumping jack target the arm, shoulder, abdominal muscles, hip muscles and hip flexors and also work on the thighs, knee tendons and quadriceps.
Jumps are beneficial to your health because they combine cardiovascular conditioning with strength work. Since jumps elevate your heart rate, they can also improve your cardiovascular fitness.', null, null, 'wger', '89443e49-e5be-4b67-a5f6-e3f5ff80f6ea', 'CC-BY-SA 4', 'hektkaso'),
  ('Dumbbell Hex Press', 'push_h', false, false, true, 'Chest', '{"Chest","Triceps"}', '{"Shoulders"}', '{"Dumbbell"}', 'Engage the muscles
Position your feet wide
Controlled movement
Slow movement
Bring the weights toward your lower chest/stomach', 'https://wger.de/media/exercise-images/1353/138cb483-7d4d-4519-b029-63e4269810a6.webp', null, 'wger', '587af8f1-516b-44c3-8660-70f262e1bef8', 'CC-BY-SA 4', 'Anastasious'),
  ('Single Leg RDL', 'hinge', true, true, false, 'Legs', '{"Hamstrings"}', '{"Glutes"}', '{"Bodyweight"}', 'Stand upright and hold weights in both hands if using loads.
Brace your core and lift one leg off the ground.
Keep your back straight, hinge at the hips while lowering your torso forward, ensuring you don’t rotate your hips.
Lower until you feel a stretch in your standing leg''s hamstring, then return to standing position. Repeat on both sides.', null, null, 'wger', '957ca37c-b6d7-4c30-8ba9-9512b0fa2659', 'CC-BY-SA 4', 'admin'),
  ('High Knee Skips HD', null, false, false, true, 'Cardio', '{"Obliquus externus abdominis","Abs"}', '{"Biceps","Glutes","Quads","Triceps"}', '{"Bodyweight"}', 'You can use this exercise both as a dynamic warm-up before training and add it to your cardio training routine to burn fat.
High knee skips are a plyometric exercise. Plyometrics are explosive aerobic moves that increase speed, quickness, and power and they work your whole body.
High knee skips target the oblique, leg muscles, hip muscles and hip flexors and also work on the thighs, knee tendons, quadriceps and shoulders.
Jumps are beneficial to your health because they combine cardiovascular conditioning with strength work. Since jumps elevate your heart rate, they can also improve your cardiovascular fitness.', null, null, 'wger', '32942c8c-0572-4d8b-9aec-48cb026fda1f', 'CC-BY-SA 4', 'hektkaso'),
  ('Bench Dips On Floor HD', 'push_h', false, false, true, 'Arms', '{"Biceps","Brachialis","Triceps"}', '{"Shoulders","Chest","Soleus","Trapezius"}', '{"Bodyweight"}', 'Triceps dips on floor are a compound exercise as they worked multiple muscle groups simultaneously. Although this bodyweight exercise mainly targets the triceps, it also hits your chest and front of your shoulder.
Triceps dips on floor are one of the most effective exercises to increase arm strength and also build lean muscle in your upper arms.
Triceps dips on floor are a closed kinetic chain exercise and express that you do the movements around a fixed point. It increases compression force on your joints thereby improving stability.', null, null, 'wger', 'fbeb1fd5-d259-4a85-a993-03569d8146dc', 'CC-BY-SA 4', 'hektkaso'),
  ('Dumbbell Split Squat', 'squat', true, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Calves"}', '{"Dumbbell"}', 'Controlled execution
No momentum
Execute slowly', null, null, 'wger', '8a3e08ab-4e97-4aee-897a-60d8693b9b43', 'CC-BY-SA 4', 'Anastasious'),
  ('Dumbbell Deadlift', 'hinge', false, true, true, 'Legs', '{"Hamstrings","Glutes"}', '{"Quads","Trapezius"}', '{"Dumbbell"}', 'Controlled execution
Don''t use momentum
Slow execution', null, null, 'wger', 'b199baca-7353-4dee-bbcf-620f96dba5b4', 'CC-BY-SA 4', 'Anastasious'),
  ('Bodyweight lunge HD', 'squat', true, true, true, 'Legs', '{"Quads"}', '{"Glutes","Soleus"}', '{"Bodyweight"}', 'Bodyweight lunges are an effective calisthenic exercise for
strengthening the lower body, improving balance and stability, and
developing functional strength. They are a popular choice for bodyweight workouts, home workouts, and can also be included as part of a larger strength training routine.', null, null, 'wger', 'f9a0a918-3c0c-464e-bbba-1bd309d4a519', 'CC-BY-SA 4', 'hektkaso'),
  ('Lateral Push Off', 'squat', false, true, false, 'Legs', '{"Calves"}', '{"Hamstrings"}', '{"Bodyweight"}', 'Push off the ground and land on one leg and regain balance before jumping to the other leg', 'https://wger.de/media/exercise-images/1325/d8372291-6725-452a-9711-6321c061e354.jpg', null, 'wger', '45e44940-d4a0-4c66-8cbb-7afe785d5610', 'CC-BY-SA 4', 'cleen'),
  ('Low-Cable Cross-Over - NB', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Shoulders"}', '{"Cable machine"}', 'The low-cable cross-over is an isolation movement that uses a cable stack to target the upper portion of the pectoral muscles. It is common in upper-body and chest-focused muscle-building workouts, often in combination with presses or flyes from other angles to target all portions of the chest.', 'https://wger.de/media/exercise-images/1296/c42782fe-337a-44f4-9079-7f6dedab4885.png', null, 'wger', 'ac6e6a09-5175-4fea-9e56-e2ff3c00b0f2', 'CC-BY-SA 4', 'JackSparrow'),
  ('Leg Swings (Front–Back)', 'squat', false, true, true, 'Legs', '{"Hamstrings"}', '{"Glutes","Quads"}', '{"Bodyweight"}', 'Stand tall next to a wall or stable support. Swing one leg forward and backward in a controlled motion, keeping the torso upright and the core engaged. Alternate legs after completing the repetitions.', null, null, 'wger', '1fae7d45-0731-4640-8809-94c76b836571', 'CC-BY-SA 4', 'Jhonatan'),
  ('High-Cable Cross Tricep Extention - NB', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'The high-cable cross tricep extension is an isolation exercise for targeting the triceps,
particularly the long head. It utilizes cables and handles grasped with opposite hands, allowing for a unique pressing motion that can be effective for building tricep strength. Unlike exercises that use a straight bar or rope, this variation can be more comfortable on your wrists and elbows', 'https://wger.de/media/exercise-images/1298/ec4b83ec-5a8f-4303-9050-99ec4389bc2a.png', null, 'wger', '4ef75e13-c058-4410-91c0-2f2d2df98130', 'CC-BY-SA 4', 'JackSparrow'),
  ('Seated Hip Abduction', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Starting Position:

Adjust the seat height so that your knees are aligned with the pivot point of the machine.
Sit with your back flat against the backrest, maintaining good posture.
Place the outside of your thighs against the machine''s padded levers.
Position your feet flat on the footrests or platform of the machine.
Grasp the handles or sides of the seat for stability.
Ensure your spine is neutral and your core is slightly engaged.

Movement:

Exhale as you slowly push your legs outward against the resistance pads.
Focus on initiating the movement from your hips, not your knees.
Continue opening your legs until you feel a strong contraction in your outer hips and thighs.
Hold the fully abducted position briefly (1-2 seconds) to maximize muscle engagement.
Inhale as you slowly control the return of your legs to the starting position, resisting the weight throughout the movement.
Avoid allowing the weight stack to touch down between repetitions to maintain constant tension on the muscles.
Repeat for the desired number of repetitions, maintaining control throughout the set.', null, null, 'wger', 'b144ac00-ec0c-4c43-898f-b2ac65048d98', 'CC-BY-SA 4', 'Iko'),
  ('Cable Lateral Raises (Single Arm)', 'push_v', true, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'The single arm cable lateral raise is a variation of the lateral raise and an exercise used to build the muscles of the shoulders.

Position a cable at the lowest position possible and attach a single handle.
Reach across your body and grab the handle with a neutral grip.
Keep the elbow slightly bent and pull the handle across your body and raise laterally.
Slowly lower the handle back to the starting position under control.', 'https://wger.de/media/exercise-images/1378/7c1fcf34-fb7e-45e7-a0c1-51f296235315.jpg', null, 'wger', '81942f3d-d92c-431c-b9d0-0da12918d1e4', 'CC-BY-SA 4', 'carlos3c'),
  ('Lat Pulldown - Cross Body Single Arm', 'pull_v', true, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Sit at lat pulldown machine with body at a diagonal angle so that only one leg is under the pad. Pull the cable down with the opposite arm. this will force the cable to across your body while pulling down. Emphasises the stretch of the lat.', null, null, 'wger', '5a096571-4eae-472e-8849-fe5647035e2c', 'CC-BY-SA 4', 'Shiladree'),
  ('Cable Chest Press - Incline', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Cable machine"}', 'Single arm chest press done with the cable machine. Use the other arm to brace bodyweight to focus on strength of the press, rather than balancing of the body. Start with the hand as close to the chest as possible, and then press against the cable at a slight incline and aiming towards the center of your chest.', null, null, 'wger', 'e22c4320-7753-49c6-b7f7-4be21b025fb6', 'CC-BY-SA 4', 'Shiladree'),
  ('Cable Triceps Press', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'A single arm exercise that starts with the hand close to the chest with with the elbows bent, and the elbow flared out. Press forward and down against the cable straightening the elbow.', null, null, 'wger', '5aee8ae1-2752-4868-af62-e3c79954d811', 'CC-BY-SA 4', 'Shiladree'),
  ('Triceps Overhead (Dumbbell)', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Dumbbell"}', 'Keep the elbows fixed
Engage the muscles
Don''t use momentum
Controlled movement
Slow movement
Don''t overextend', 'https://wger.de/media/exercise-images/1336/ebf88217-df26-4ef7-94cb-f0c2220c6abe.webp', null, 'wger', '19133a0d-e6b2-4d57-8a84-8aac3d962a99', 'CC-BY-SA 4', 'Anastasious'),
  ('Shoulder Raise (Dumbbell)', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'Engage the muscles
Don''t use momentum
Controlled movement
Slow movement
Always keep the arms bent
Don''t overextend', 'https://wger.de/media/exercise-images/1338/9d157b4d-5af0-43c1-bd34-f52144ba1b54.webp', null, 'wger', '9a644b0e-8691-4216-b2cc-f058f58ec96d', 'CC-BY-SA 4', 'Anastasious'),
  ('Wall Angels', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{"Shoulders"}', '{}', 'The Wall Angels exercise primarily targets the upper back and shoulder muscles, helping improve posture, shoulder mobility, and scapular control.', null, null, 'wger', '2eb61587-85d1-494f-b2fb-a92dd108b3d3', 'CC-BY-SA 4', 'bbayuwega'),
  ('Seated figure four', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bench"}', 'Seat on a bench. Feet flat on the ground. Place your left ankle over your right knee. Your right knee stays flat. Keep your back straight. Gently push your left knee down.', null, null, 'wger', '73144238-414e-438f-8b0c-832a6591aa2f', 'CC-BY-SA 4', 'ricardodavidrd'),
  ('Double Kettlebell Clean and Press', 'isolation', false, false, true, 'Arms', '{"Shoulders","Biceps","Brachialis","Quads","Trapezius","Triceps"}', '{"Hamstrings","Glutes","Lats","Abs"}', '{"Kettlebell"}', 'Full-body muscles building exercise. This exercise provides a huge range of benefits in terms of strength & size and is extremely functional.', null, null, 'wger', 'fe249e2f-5856-420f-8a34-1b02c7fde141', 'CC-BY-SA 4', 'm4k3r'),
  ('Double Kettlebell Front Squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Calves","Abs"}', '{"Kettlebell"}', 'The kettlebell front squat is a compound, multi-joint exercise that works several muscle groups.', null, null, 'wger', 'a030a4e9-970c-4442-b0b3-e49b42143de0', 'CC-BY-SA 4', 'm4k3r'),
  ('Box jumps', null, false, false, false, 'Cardio', '{"Glutes"}', '{"Calves"}', '{"Bodyweight"}', 'Jump from a standing position onto the box, stretch your body, then step down again (do not jump)', null, null, 'wger', '002c6a4f-28ac-4b07-8e94-053e5b05d52b', 'CC-BY-SA 4', 'tekknokrat@gmx.de'),
  ('Rotary Torso Machine', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{}', 'Slow and Steady
Not too much weight', null, null, 'wger', '849f2fa6-42f9-4c59-90f6-275c8ada6725', 'CC-BY-SA 4', '6LXBO'),
  ('Recumbent Bike', null, false, false, true, 'Cardio', '{"Hamstrings","Calves","Glutes","Quads"}', '{}', '{}', 'For this exercise Recumbent Bike is needed. You just sit on it, set level and time and start the workout', null, null, 'wger', '12f88134-0f7a-4fb7-8bd9-436aa80d8b7c', 'CC-BY-SA 4', 'pera_perkan'),
  ('Torso Twist', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Standing Torso Twist WorkoutTarget your core and improve flexibility with this dynamic standing exercise! The Standing Torso Twist Workout involves twisting your torso while keeping your feet and hips stable, engaging your obliques, and stretching your entire upper body. This movement helps to:Strengthen core musclesIncrease flexibility in the spine and torsoImprove posture and balanceEnhance overall athletic performancePerform 3 sets of 10-15 reps, twisting to each side, to feel the benefits of this effective and efficient workout!', 'https://wger.de/media/exercise-images/1377/12e7a231-d36a-4992-bf57-ff7bfe0f3ae4.jpg', null, 'wger', '56a03260-2901-4b28-bd41-a030185f985a', 'CC-BY-SA 4', 'brucem'),
  ('Upper Back', 'pull_h', false, false, true, 'Back', '{"Shoulders","Trapezius"}', '{"Biceps","Lats"}', '{}', 'Upper Back is suitable for building up the core muscles with a special focus on the deltoid and rhomboid muscles and the upper back muscles', null, null, 'wger', 'df18b577-0610-4804-a993-161024da67db', 'CC-BY-SA 4', 'phpi'),
  ('Bodyweight Squat HD', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Calves","Glutes","Obliquus externus abdominis","Abs","Soleus"}', '{"Bodyweight"}', 'Squat is a type of bodyweight exercise. It is one of the most popular exercises for strength and muscle growth. Squat is particularly effective for focusing on the muscles of the leg and hips.
Squat are an easy exercise for beginners to do. It can help strengthen leg muscles, tighten hip muscles and burn calories to lose weight.
It tightens the butt and legs. Squats are very effective for firming and strengthening your legs by acting on the gluteus,hip flexors, quadriceps, hamstrings and inner thigh muscles. Also, bodyweight squats can help shape your glutes and butt.', null, null, 'wger', 'edc3f6b7-96b0-4967-90d7-bba9d7d442cb', 'CC-BY-SA 4', 'admin'),
  ('Pullover Machine', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Chest","Triceps"}', '{}', 'Pullover machine, sitting, elbows on pads', null, null, 'wger', 'ad20ef5e-e360-4859-9110-668ee0c24721', 'CC-BY-SA 4', 'Paul@Chemistry'),
  ('Zottman curl', 'isolation', false, false, false, 'Arms', '{"Biceps","Brachialis"}', '{}', '{"Dumbbell"}', 'With your palms facing forward, curl the weights up to your shoulders. Turn your hands so that that your palms downwards and slowly return the weights back down. Finally face your palms back forward.', null, null, 'wger', '9564ab2d-2534-4b47-bdf7-f2f653aae3de', 'CC-BY-SA 4', 'meldun'),
  ('Thruster', 'squat', false, true, false, 'Legs', '{"Shoulders"}', '{"Trapezius"}', '{"Barbell"}', 'Start by doing a front squat
At the top position, push the bar above your head (similar to a press)
Lower the bar to the shoulders', null, null, 'wger', '51420ded-5c17-4ce0-b005-89f1b67b7c65', 'CC0', 'BeLikeWater'),
  ('Hamstring Kicks', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{"Glutes"}', '{"Bodyweight"}', 'Stand with your feet hip-width apart and extend one arm in front of you. Swing that leg up in front of you and back down while keeping your leg as straight as possible and your toes pointed up.Repeat with the other leg.', 'https://wger.de/media/exercise-images/1387/a2cf7eda-5540-4105-b30e-1c2f2679a6c7.png', null, 'wger', '66aef559-02e8-4f35-91f6-600f103e9cbf', 'CC-BY-SA 4', 'captive0592'),
  ('Toe Touch', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes"}', '{"Calves"}', '{"Bodyweight"}', 'Stand with your feet closer together. Hinge at your hips and lower your upper body towards your toes. Reach your hands towards your feet, try to touch your toes, the ground, or as far down your legs as you can comfortably go.', null, null, 'wger', 'a51de8df-4101-45cb-8da5-de230d9bac1d', 'CC-BY-SA 4', 'captive0592'),
  ('Dumbbell Thruster', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{"Shoulders"}', '{"Dumbbell"}', 'Start with the dumbbells resting on your shoulders and squat down. Push
into standing and raise the dumbbells into an overhead position. Bring
the dumbbells back to your shoulders and repeat.', null, null, 'wger', 'ae6a522e-db10-45ba-9642-987468d8a4de', 'CC-BY-SA 4', 'meldun'),
  ('Glute Bridge Single-Arm Press', 'hinge', true, false, true, 'Arms', '{"Chest"}', '{"Shoulders","Biceps","Hamstrings","Glutes","Triceps"}', '{"Dumbbell"}', 'With one dumbbell in hand, perform a glute bridge. Now hold the dumbbell above your chest, this is the rep starting position. Lower the dumbbell so that your elbow touches the floor or is roughly 45 degrees below your shoulder if using a bench. Push the dumbbell back into the starting position.', null, null, 'wger', '8c4a9c16-294b-40e5-ba6d-50ae523704ba', 'CC-BY-SA 4', 'meldun'),
  ('Bear crawl pull through', 'hinge', false, false, true, 'Abs', '{"Shoulders","Glutes","Quads","Abs"}', '{"Hamstrings","Calves","Trapezius"}', '{"Dumbbell"}', 'Place a dumbbell at around hip level and assume a bear crawl position. Push the knees off the floor and hold.

With the opposite hand reach for the dumbbell and pull it to the other side. Place your hand back on the floor and repeat with your other hand.', null, null, 'wger', 'b4dc15da-4d4d-4a93-a30a-74aaf99192ff', 'CC-BY-SA 4', 'meldun'),
  ('Triceps Dips (Assisted)', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{"Chest"}', '{}', 'Assisted triceps dips is a gym work out exercise that targets triceps and also involves chest.', null, null, 'wger', '3dd0db1c-450a-46d1-ad46-d7854bdc26ed', 'CC-BY-SA 4', 'matpn'),
  ('Elephant Walks', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{"Calves"}', '{"Bodyweight"}', 'Hinge at your hips until you feel a stretch behind your knees. Bend one leg while the other is straight then fluidly bend the other knee while straightening the first knee.', null, null, 'wger', '34cce09a-edb3-4140-892a-1cf70da8d98b', 'CC-BY-SA 4', 'captive0592'),
  ('Good Morning', 'hinge', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Bodyweight"}', 'Stand with your feet more than shoulder-width apart (wider stance) and place your hands on your hips. Hinge at your hips and lower your upper body towards the ground while keeping your back straight then come back up.', 'https://wger.de/media/exercise-images/1392/a02c9c7d-f42d-43e0-9946-1b99b014daee.png', null, 'wger', '77a56810-d050-4083-9501-d648f773376a', 'CC-BY-SA 4', 'captive0592'),
  ('Single Leg Hamstring Stretch', 'squat', true, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Bodyweight"}', 'Sit on the ground with one leg straight out in front of you and the other leg bent in toward you. Reach forward with both hands, trying to touch the toes of your straight leg.', null, null, 'wger', '45cd73d7-98ac-4451-849a-a645fcfe9bee', 'CC-BY-SA 4', 'captive0592'),
  ('Sit & Reach', 'pull_h', false, false, false, 'Back', '{"Hamstrings"}', '{}', '{"Gym mat"}', 'Sit on the ground with your legs extended straight in front of you. Reach both hands forward, trying to reach past your toes or as far as you can go. Return to the starting position and repeat.', null, null, 'wger', '5a5e8883-b185-40ff-b292-9e433d13b5e7', 'CC-BY-SA 4', 'captive0592'),
  ('Crossbody Leg Swings', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Bodyweight"}', 'Hold onto a wall or something near you for support. Swing one leg across the front of your body, then back and out to the side. Repeat while slowly increasing your range of motion.', null, null, 'wger', 'bb948d34-8948-4995-9e59-003d7b6fc1b2', 'CC-BY-SA 4', 'captive0592'),
  ('Standing Pancake', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Bodyweight"}', 'Stand and open your legs as wide as possible into a straddle position. Then bend at the hips, pushing them back while keeping your back straight.', null, null, 'wger', 'af59f161-147a-49ba-85c8-6c9f4e5ffe63', 'CC-BY-SA 4', 'captive0592'),
  ('Hamstring Chokes', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Bodyweight"}', 'Sit on the ground and bend one leg, bringing your knee toward you. Place your hand behind your hamstring and gently pull your leg toward your chest, feeling a stretch in the back of your thigh. Straighten your leg, extending up toward the ceiling.', null, null, 'wger', '638756b5-a957-48f4-93ca-8994cead818f', 'CC-BY-SA 4', 'captive0592'),
  ('Crossbody Hamstring Stretch', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Bodyweight"}', 'While standing, cross one leg behind the other (keep this leg straight). Reach downward and try to touch the toes of that leg. Slightly bend the other leg so that you can bend down.', null, null, 'wger', '4f38cc2e-5904-4ef5-b811-e729105cfd3b', 'CC-BY-SA 4', 'captive0592'),
  ('Preacher Curl - Externally Rotated', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Single arm curl that can be done using a dumbbell and a preacher bench, or a preacher curl machine. Turn body away from the weight', null, null, 'wger', '7cd76565-8a8f-4658-98f1-253af9d8bb39', 'CC-BY-SA 4', 'Shiladree'),
  ('Plank-to-Elbow Extension', 'isolation', false, false, true, 'Abs', '{"Shoulders","Abs","Triceps"}', '{"Obliquus externus abdominis","Chest"}', '{"Bodyweight"}', 'The Plank-to-Elbow Extension is a dynamic exercise that combines the plank with an elbow extension movement', null, null, 'wger', 'e75629ed-4991-4a48-984c-b297f3f9fb58', 'CC-BY-SA 4', 'clafal'),
  ('Cool-Down Swim', null, false, false, true, 'Cardio', '{"Shoulders","Lats","Chest"}', '{"Glutes","Abs","Triceps"}', '{}', 'Swim at an easy, unhurried pace — freestyle, backstroke, or just floating/gliding — with zero focus on technique or drills. The only goal here is to let your heart rate come down gradually and your muscles relax before you get out of the pool.', null, null, 'wger', '1544c78d-fe6d-423d-876e-0ba1998063c6', 'CC-BY-SA 4', 'Imported from swim plan'),
  ('Plank Jacks', 'isolation', false, false, true, 'Abs', '{"Glutes","Obliquus externus abdominis","Abs"}', '{"Calves","Quads"}', '{"Bodyweight"}', 'Jumping jacks from the plank position.', null, null, 'wger', '4f5de647-eb73-4394-84a7-469d02a96de8', 'CC-BY-SA 4', 'jayninja'),
  ('Cossack squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Calves","Abs"}', '{}', 'The Cossack Squat is a multi-joint exercise that works mainly on the legs and buttocks, but also involves stabilizing muscles. It is an excellent exercise for improving strength, mobility and stability in a functional way.', null, null, 'wger', '96a899ee-16a4-457d-8f66-efdd39fd38a0', 'CC-BY-SA 4', 'clafal'),
  ('Wall-sit', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Calves","Abs"}', '{}', 'The Wall Sit (or wall chair) is an isometric exercise that mainly involves the leg muscles, improving muscular endurance and stability. Here are the main and secondary muscles activated during the exercise.', null, null, 'wger', '3f8ad988-1aee-48ca-ad37-44e39ae1715d', 'CC-BY-SA 4', 'clafal'),
  ('Dragon-flag', 'isolation', false, false, true, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{"Shoulders","Glutes","Lats","Triceps"}', '{}', 'Keep your body completely rigid throughout the movement, avoiding sagging in your lower back.
Use a firm grip to stabilize your upper body.
Start with simpler versions (such as with bent knees) to build strength and control.', null, null, 'wger', 'f5ad82a8-adf8-4795-9874-1f6d183c56ed', 'CC-BY-SA 4', 'clafal'),
  ('Plank with Alternating Leg Lift', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'In a plank position, lift one leg alternately.', null, null, 'wger', '94f2dea6-b336-41b2-a438-3ab7b13adbf7', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Heel Touches', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Bodyweight"}', 'Starting Position:

Lie on your back on an exercise mat.
Bend your knees, keeping your feet flat on the floor and hip-width apart.
Place your arms along your sides, palms facing inward, just off the floor.

Engage Core:

Lift your head, shoulders, and upper back slightly off the ground.
Keep your neck neutral and chin slightly tucked.

Perform the Movement:

Side-bend to the right, reaching your right hand toward your right heel.
Return to the center, then side-bend to the left, reaching your left hand toward your left heel.
Continue alternating sides in a controlled manner.

Breathing:

Exhale as you reach toward your heel and inhale as you return to the center.', null, null, 'wger', 'cfe3f20e-d078-4e6c-91fc-37da62f5ac0a', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Bicycle crunches', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Bicycle crunches are a core exercise performed on the floor. Lie on your back with your hands behind your head and legs extended. Lift your shoulders off the ground, bring one knee toward your chest, and twist your torso so your opposite elbow meets the knee. Alternate sides in a pedaling motion, ensuring controlled movements and engaging your core throughout the exercise.', null, null, 'wger', 'fcf5039b-7784-4f82-830a-b213b597a646', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Cable Press Around', 'push_h', false, false, true, 'Chest', '{"Shoulders","Chest","Triceps"}', '{"Biceps","Serratus anterior"}', '{"Cable machine"}', 'Set the cable pulley at chest height and attach a D-handle bar. Grab
the handle with a neutral grip and hold it next to your chest with your
elbow fully flexed and tight to your side. Turn away from the pulley so
your torso is at 45 degrees.

Hold the other side of the functional trainer with your corresponding hand. Assume a staggered stance for better balance.

While keeping your chest proud, extend your elbow at 45 degrees
across your midline while keeping your arm parallel to the floor. Stop
shy of lockout and contract your chest at the top of the range of motion
(ROM).', null, null, 'wger', '70479b75-0df4-4ac2-a324-4a44b148304c', 'CC-BY-SA 4', 'Expenses7000'),
  ('Hack Squats', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Hamstrings","Calves","Glutes"}', '{}', 'Hack squats target the lower body and are performed on a hack squat machine or with a barbell. For the machine variation, position yourself on the platform with your shoulders under the pads and feet slightly forward. Push through your heels to lift the weight, then bend your knees to lower the platform in a controlled motion until your thighs are parallel to the ground. Push back up to the starting position. For the barbell variation, hold the bar behind your legs with your arms extended and perform a squat-like motion.', null, null, 'wger', 'f462df26-3264-48c2-b5aa-2374d0670c24', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Dumbbell Crunches', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Dumbbell"}', 'Dumbbell crunches are a weighted variation of traditional crunches designed to target the abdominal muscles more intensely. Lie flat on your back with your knees bent and feet flat on the floor. Hold a dumbbell with both hands close to your chest or above your head. Lift your shoulders and upper back off the ground in a crunching motion, engaging your core. Slowly lower yourself back to the starting position. Ensure controlled movements throughout the exercise to prevent strain.', null, null, 'wger', 'b48e4d9d-f7fc-4619-85fb-6dabe5d7c999', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Cross-Body Cable Y-Raise', 'pull_h', false, false, true, 'Back', '{"Shoulders","Lats","Trapezius"}', '{}', '{"Cable machine"}', 'Attach a D-Bar to the cable machine. Perform a motion akin to drawing a sword from across your body.', null, null, 'wger', '37314b67-1aad-4405-aa88-70846d5f035d', 'CC-BY-SA 4', 'Expenses7000'),
  ('Bent over Cable Flye', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Cable machine"}', 'Holding your upper body at an approximate 105° angle.', null, null, 'wger', '7ef2e00e-067c-48e0-9b42-3d622e0df8a4', 'CC-BY-SA 4', 'Expenses7000'),
  ('1-Arm Half-Kneeling Lat Pulldown', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Attach a D-Handle to a high pully. And use your lat muscles to pull the weight single handedly.', null, null, 'wger', 'a8a4ea81-9531-48e1-b6dc-f7621c7b9283', 'CC-BY-SA 4', 'Expenses7000'),
  ('Cable Shrug-In', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{}', '{"Cable machine"}', 'Attach two D-Handles to two low cables and shrug in using your upper traps.', null, null, 'wger', '05853a58-4426-450c-9b06-bfa461a767bf', 'CC-BY-SA 4', 'Expenses7000'),
  ('Reverse Cable Flye', 'push_h', false, false, false, 'Back', '{"Shoulders"}', '{"Trapezius"}', '{"Cable machine"}', 'Attach D-Handles to two cable pulleys in the upper position. Grab the left on with your right hand and vice-versa.', null, null, 'wger', '39c13706-6a8c-4ab5-b605-b9b716665a20', 'CC-BY-SA 4', 'Expenses7000'),
  ('Drag Pushdown', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine","SZ-Bar"}', 'Starting
position for this rope pushdown is standing facing a cable machine with
the handles of a rope attachment in both hands and feet shoulder width
apart.
Hinge
forward slightly at the hips maintaining an upright chest and bring the
shoulders and elbows behind the body so that when you push down on the
cable attachments, you can get a fully contracted triceps long head.
Drag
the cable machine rope attachment as close to the body as possible and
straighten your elbows until lockout.', null, null, 'wger', '02b96dc1-d1d9-4fc7-b54c-82dda1691485', 'CC-BY-SA 4', 'Moffi'),
  ('Omni Cable Cross-over', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Cable machine","SZ-Bar"}', 'Adjust the weights based on the
motion. When pulling from top to bottom, increase the weight by 20% to 40%
more than the bottom-to-top motion. This accounts for the fact that when
operating from top down, the upper chest muscles are naturally weaker than
the lower chest muscles. So, adjust your weight stack to
compensate.

Position one cable at a high
setting and the other at the lowest level setting. Get into a staggered
stance in between the cable towers.
For the cable set low, pull it
upward and across your body. This effectively targets the upper chest.
For the cable set high, draw it
downward and across your body. This will primarily engage the lower chest.

Once you’re done, swap the
positions of the cables. Change the previously high cable to the lowest
position and vice versa. Repeat the exercise sequence, ensuring you’re
targeting both chest regions effectively.', null, null, 'wger', 'ac00021c-12f9-4827-8003-ea07de980b76', 'CC-BY-SA 4', 'Moffi'),
  ('Rocking Triceps Pushdown', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine","SZ-Bar"}', 'Set your feet below the rope and lean your upper body towards the rope. Set one foot back. Push down the rope and lean your entire body back onto the rear foot as you push down to get your hands behind your body. Don''t forget to bring your chest to the front during the pushdown. As you release the rope slowly, lean your body back onto the front foot.', null, null, 'wger', '0dfe655e-ee2e-4c49-a279-c672d5591613', 'CC-BY-SA 4', 'Moffi'),
  ('Biceps Curl Machine', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{}', 'The biceps curl machine is designed to isolate the biceps muscles and provide a controlled range of motion. Sit on the machine with your back against the pad and adjust the seat so your arms are aligned with the machine''s handles or pads. Grip the handles firmly, keeping your elbows fixed in place, and curl the handles upward by contracting your biceps. Slowly lower the handles to the starting position, maintaining control throughout the movement.', null, null, 'wger', 'e68f6d51-fe02-4175-b277-dec0c1521f36', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Toe Taps', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Toe taps are a core-focused exercise performed lying on your back. Lie flat with your arms by your sides and your legs raised to a tabletop position (knees bent at 90 degrees). Slowly lower one foot to gently tap the floor, keeping your core engaged and your lower back pressed into the ground. Return to the starting position and alternate legs. This exercise strengthens the core while minimizing strain on the lower back.', null, null, 'wger', '33728393-2b84-4d39-8b68-462222e004e3', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Standing Side Crunches', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Bodyweight"}', 'Standing side crunches are a dynamic exercise that targets the obliques while improving balance and stability. Stand upright with your feet shoulder-width apart and hands behind your head or holding a dumbbell in one hand. Lean your torso to one side, contracting your obliques, while bringing your elbow toward your hip (or crunching toward the weight if using a dumbbell). Return to the starting position and alternate sides or perform all repetitions on one side before switching.', null, null, 'wger', '864b0a80-5d29-4d87-9144-f6ee6f5087b9', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Alternating High Cable Row', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Start
by putting the attachment in a high position on the cable station and step back about 1m from the attachment. Grab
the cable pulley handle in your left hand at about head height with your elbow slightly bent. Step back with your left foot.
Pull
your elbow joint in toward the torso twisting slightly and perform a
single-arm row. Engage the lats as you twist.
Return
to the starting position with cable pulley and left foot and grab the cable pulley handle in the right
hand. Repeat this motion on the opposite side with your right foot stepped back.', null, null, 'wger', '45251627-5f89-4858-bf0c-8884a21cbb1f', 'CC-BY-SA 4', 'Moffi'),
  ('Table Bodyweight Rows (Vasco L1)', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{"Bodyweight"}', 'Vasco custom table bodyweight row for horizontal pulling in home training. Zero equipment except sturdy table. Part of Tuesday Pull day.', null, null, 'wger', 'a7a1e96f-2f34-48eb-93ad-75c08e9e2721', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Dumbbell Shoulder Rotations', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'Dumbbell shoulder rotations are designed to strengthen the rotator cuff muscles and improve shoulder stability and mobility.

External Rotation: Hold a dumbbell in one hand, keeping your elbow bent at 90 degrees and close to your body. Rotate your forearm outward, away from your body, keeping your elbow stationary. Slowly return to the starting position.
Internal Rotation: Hold a dumbbell in one hand, keeping your elbow bent at 90 degrees and close to your body. Rotate your forearm inward, toward your body, and slowly return to the starting position. Perform the exercise with controlled movements to avoid strain.', null, null, 'wger', '5a9f4fa4-6b71-4bc7-a284-e76e43e3106a', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Plate Pinch Hold', 'isolation', false, false, false, 'Arms', '{"Shoulders"}', '{}', '{}', 'The plate pinch hold is a grip strength exercise designed to target the forearms and improve grip endurance. Select one or two weight plates (smooth-edged plates work best) and pinch them together between your thumb and fingers. Hold the plates with your arm straight down by your side or extended slightly in front of you. Maintain the hold for as long as you can, keeping your shoulders relaxed and your grip firm. This exercise can be done for time or repetitions.', null, null, 'wger', '493fb1ac-c45a-4b18-bcbb-58b809881e6f', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Reverse Wood Chops', 'pull_h', false, false, true, 'Back', '{"Glutes","Lats"}', '{"Shoulders","Biceps","Obliquus externus abdominis","Quads","Abs"}', '{"Bodyweight"}', 'Attach a looping resistance band to a rack below knee height
Grip the other end of the band like holding a baseball bat with both hands
Stretch the band facing it
Start with your hands at the side of your hips, knees bent
Rotate your hips while moving your hands towards over the top of your opposite shoulder
Imagine the motion as striking a baseball with a bat', null, null, 'wger', '6f5d4373-66d1-4acd-a16f-ba0e636fe979', 'CC-BY-SA 4', 'M9'),
  ('Lat Pull DB', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{"Glutes"}', '{"Dumbbell"}', 'Bend upper body forward
Move dumbbells near your body with slightly bent arms towards your back', null, null, 'wger', '90dea8b9-4cf8-430e-8633-e08df1dd900b', 'CC-BY-SA 4', 'M9'),
  ('Scapula Pulls', 'pull_h', false, false, false, 'Back', '{"Lats","Trapezius"}', '{}', '{"Pull-up bar"}', 'Hang straight on a pull-up bar
Pull shoulder blades together, moving the body slightly up', null, null, 'wger', '2a983b8f-b77e-4f8f-8335-0e5caecd715f', 'CC-BY-SA 4', 'M9'),
  ('Pin Bench Press BB', 'push_h', false, false, false, 'Chest', '{"Chest","Triceps"}', '{}', '{"Barbell"}', 'Set security pins to about the height of your sticking point
Lower the bar, rest on the pins for 1s while holding tension
Move bar up with maximum force', null, null, 'wger', 'abd2854b-114a-4584-8746-30bd40127863', 'CC-BY-SA 4', 'M9'),
  ('Pin Squat', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{"Abs"}', '{"Barbell"}', 'Set security pins to about the height of your sticking point
Lower the bar, rest on the pins for 2s keeping tension
Stand up with maximum force', null, null, 'wger', '96f9d74a-7bf4-4ec1-9cd6-c62c13cf7b67', 'CC-BY-SA 4', 'M9'),
  ('Clean', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Lats","Abs"}', '{"Barbell"}', 'Regular olympic lift clean.
Pull bar from ground, catch on shoulders performing a front squat.', null, null, 'wger', 'a8f76beb-b6d8-430b-8e45-cc03d4959043', 'CC-BY-SA 4', 'M9'),
  ('Pin OHP', 'push_v', false, false, false, 'Shoulders', '{"Shoulders","Triceps"}', '{}', '{"Barbell"}', 'Set security pins to the height of your lower chin
Rest bar on pins keeping tension
Raise bar over head', null, null, 'wger', 'a33ba0c7-1680-4e42-a84e-aecc18c5d75b', 'CC-BY-SA 4', 'M9'),
  ('Push OHP', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Glutes","Quads"}', '{"Triceps"}', '{"Barbell"}', 'Rest bar in front on your shoulders
Bend knees while keeping upper body straight
Extend legs pushing the bar overhead with force', null, null, 'wger', 'a535b8f1-2024-4c5c-b323-f711cbf9773c', 'CC-BY-SA 4', 'M9'),
  ('Incline OHP DB', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Triceps"}', '{"Dumbbell"}', 'Sit on a bench with 45° incline
Ellbows 45° out
Move dumbbells down until upper arms are parallel to shoulders
Move dumbbells up, meeting overhead', null, null, 'wger', 'f89b3662-f911-4aab-9402-cfa6d47cea2b', 'CC-BY-SA 4', 'M9'),
  ('Kreis Press DB', 'push_v', false, false, true, 'Shoulders', '{"Shoulders"}', '{"Biceps","Chest","Abs","Triceps"}', '{"Dumbbell"}', 'Sit on a bench with 45° incline
Hold dumbbells overhead
Move dumbbells down as if doing overhead press
Rotate dumbbells palms facing up and extend your arms in front of your body
Move hands together until dumbbells meet, keep arms extended
Reverse the motion until dumbbells are overhead again
This is one repetition', null, null, 'wger', 'b4e78b5a-6141-4fc9-a6f7-cba13ce6559b', 'CC-BY-SA 4', 'M9'),
  ('Shoulder Raise Side and Front DB', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'Stand while holding dumbbells beside body
Keep arms almost fully extended
Without momentum raise dumbbells to the side of your body until shoulder height, palms facing down
Lower dumbbells beside body, palms facing inwards
Immediately raise dumbbells in front of your body until shoulder height, palms facing down
Down again
This is one repetition', null, null, 'wger', 'c146fa3c-35a4-4e6e-9000-e12a9ee19cbd', 'CC-BY-SA 4', 'M9'),
  ('Jerk OL', 'push_v', false, false, true, 'Shoulders', '{"Shoulders"}', '{"Glutes","Quads","Triceps"}', '{"Barbell"}', 'Olympic lift jerk

Hold bar in front on shoulders like push press
Bend and extend knees pushing bar up while diving under the bar
Catch bar overhead with straight arms using lunge
Move feet parallel while holding bar in lockout', null, null, 'wger', '85c28424-ab47-40d4-9a27-e1b9bfb01e7c', 'CC-BY-SA 4', 'M9'),
  ('Clean and Jerk OL', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Hamstrings","Glutes","Quads"}', '{"Lats","Abs","Trapezius","Triceps"}', '{"Barbell"}', 'Olympic lift clean and jerk.
Combination of clean and jerk in one motion.', null, null, 'wger', '8c509754-c86f-4c1b-bfa9-29c906ffc409', 'CC-BY-SA 4', 'M9'),
  ('Snatch OL', 'pull_h', false, false, true, 'Back', '{"Shoulders","Hamstrings","Glutes","Quads"}', '{"Lats"}', '{"Barbell"}', 'Olympic lift snatch

Pull barbell from ground to overhead lockout using a wide grip and overhead squat.
Move bar slowly until cleared knees then explosively extend hips, pull bar up and dive under the bar
Catch bar overhead with straight arms
Push head forward during lockout', null, null, 'wger', '127033e0-46c5-44a6-825b-fbecfe60ed9a', 'CC-BY-SA 4', 'M9'),
  ('Seated W Curl', 'isolation', false, false, false, 'Arms', '{"Biceps","Brachialis"}', '{}', '{"Bench","Dumbbell"}', 'Sit on bench with 60° incline
Hold dumbbells beside body near the ground, palms facing outwards, arms fully extended
Move dumbbells up using only biceps and without momentum', 'https://wger.de/media/exercise-images/1448/2184e68c-32b5-413f-a7c1-4a2d1bb98c35.png', null, 'wger', 'ecc46519-94b8-4ecc-b5b8-973e753e98a6', 'CC-BY-SA 4', 'M9'),
  ('ClimbMill', null, false, false, true, 'Cardio', '{"Quads"}', '{"Hamstrings","Glutes"}', '{}', 'The ClimbMill, also known as a stair climber, is a cardio-focused machine that simulates climbing stairs. It provides an effective way to improve endurance while strengthening the lower body. To use the machine, step onto the moving stairs, maintain an upright posture, and use the handrails for balance if needed. Adjust the speed and intensity to match your fitness level. This exercise helps improve cardiovascular health, burns calories, and enhances lower body muscle endurance.', null, null, 'wger', '2536b8cd-a287-48ee-b8da-58d8bd595f43', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Cobra Stretch', 'pull_h', false, false, false, 'Back', '{"Abs"}', '{"Chest"}', '{"Bodyweight"}', 'The Cobra Stretch is a back extension exercise that helps improve spinal flexibility and relieve lower back tension. To perform, lie face down on the floor with your hands placed under your shoulders. Press your palms into the floor and lift your chest while keeping your hips on the ground. Keep your elbows slightly bent and your shoulders relaxed. Hold the stretch for a few seconds, then slowly lower yourself back down. This exercise is beneficial for improving posture and reducing lower back stiffness.', null, null, 'wger', 'd8d1b919-94e1-4e91-b37e-29bb8a479740', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Torso rotation stretch', 'push_h', false, false, false, 'Chest', '{"Obliquus externus abdominis"}', '{"Chest"}', '{"Bodyweight"}', 'The torso rotation stretch helps improve spinal mobility and relieves tension in the lower back and obliques. It can be performed standing or seated.

Standing Variation: Stand upright with your feet shoulder-width apart. Place your hands on your hips or extend your arms in front of you. Slowly rotate your torso to one side, keeping your hips stable. Hold for a few seconds, then rotate to the opposite side.
Seated Variation: Sit on a chair with your feet flat on the floor. Place one hand on the outside of your opposite thigh and gently twist your torso toward that side. Hold the stretch before switching sides.', null, null, 'wger', '1e9b886f-0dbe-4434-829e-7159bcc40692', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Knee to Chest Stretch', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{"Hamstrings"}', '{"Bodyweight"}', 'The knee to chest stretch is a simple yet effective exercise for relieving lower back tension and improving hip mobility. To perform, lie flat on your back with your legs extended. Bring one knee toward your chest, wrapping your hands around your shin or behind your thigh. Gently pull the knee closer to your chest while keeping the other leg straight on the floor. Hold the stretch for 15–30 seconds, then switch sides. For a deeper stretch, both knees can be pulled toward the chest simultaneously.', 'https://wger.de/media/exercise-images/1452/85a6b9de-4eec-445b-8ebb-f1950b076aba.png', null, 'wger', '492e90a5-1ecb-4a06-8e9d-26a00042560e', 'CC-BY-SA 4', 'hpmbala@gmail.com'),
  ('Towel Superman', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{"Shoulders"}', '{}', 'In this exercise, you lie flat on your stomach, hold a
towel with your arms extended in front of you, and pull it apart to
create tension. Then, you move it forward and back under your stomach.
This exercise targets the back and shoulder muscles as well as core
stability.', null, null, 'wger', 'f44cf553-067e-4f3a-b35b-e16549c1d055', 'CC-BY-SA 4', 'Yderkone'),
  ('No Leg Drive Dumbbell Chest Press', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{"Bench","Dumbbell"}', 'Set up for a normal Dumbbell chest press but lift your leg ups straight or put them on another bench to remove the leg drive.', null, null, 'wger', '10b0684c-1c48-4be6-913e-19bf1419107b', 'CC-BY-SA 4', 'Expenses7000'),
  ('Punches', 'isolation', false, false, false, 'Arms', '{"Shoulders","Triceps"}', '{}', '{"Bodyweight"}', 'stand stable and throw normal straight punches', null, null, 'wger', 'adf81065-407c-4dd7-8ec5-920cc5944d58', 'CC-BY-SA 4', 'lh1701'),
  ('Dumbbell Underhand Dead Row', 'pull_h', false, false, false, 'Arms', '{"Biceps"}', '{"Lats"}', '{"Dumbbell"}', 'The Dumbbell Underhand Dead Row will involve the back, which means you can try a bit heavier weight. The catch is that you need to be able to control the weight for all the reps.

Start by holding a pair of dumbbells with your feet shoulder-wide apart and your knees slightly bent.
Hinge at your hips to lower your torse forward until it''s almost parallel to the floor, keeping your back flat and maintaining a slight bend in your knees.
Exhale as you row the dumbbells to your sides up to chest height, leading with your elbows until your upper arms are just past parallel to the floor and the dumbbells are at ribcage level.
Slowly lower to the starting position and repeat. Keep your back flat all the time.', null, null, 'wger', '1dca10f9-a976-4a09-ab85-b95fafaa1a28', 'CC-BY-SA 4', 'Moffi'),
  ('Pause Hack Squats', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Hamstrings","Calves","Glutes"}', '{}', 'Hack Squats but with a 1-2s pause at the bottom of the movement. This makes sure that there is no more elastic energy stored in the muscles.', null, null, 'wger', '1b329beb-fcda-4471-ba70-eea62da410dd', 'CC-BY-SA 4', 'Expenses7000'),
  ('Spider Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Incline bench"}', 'To get the most out of DB Spider Curls, you need an
adjustable weight bench set at a 45-degree incline. This inclined position
allows your arms to hang freely, putting them in an extended start position
with elbows slightly in front of your torso, which is the key to maintaining
low-level isometric tension throughout the movement pattern.

Lie face-down on an adjustable
weight bench with your chest fully supported, holding a pair of dumbbells.
Keep a neutral head position
and don’t crane your neck.
Let your arms hang straight
down with your palms facing forward (for a standard Spider Curl) or palms
facing inward for a Hammer Curl exercise variation.
Keep a stable foot position on
the floor to maintain balance and control.
Start the curl motion by
flexing your biceps muscles and lifting the pair of dumbbells or curl bar
toward your shoulders.
Keep your elbow flexion
controlled. Your arms should stay locked in position with no unnecessary
movement.
Squeeze hard at the top for 1-2 seconds. This
is where maximum tension hits the biceps muscle fibers.
Lower the weight under control
for 3-4 seconds to keep muscles under tension for the entire range of
motion.', null, null, 'wger', 'b3049397-a1d1-4442-9113-3532bcd1f278', 'CC-BY-SA 4', 'Moffi'),
  ('Calf Raise using Hack Squat Machine', 'squat', false, true, false, 'Legs', '{"Calves","Soleus"}', '{}', '{}', 'Ideally using a trapeze addon, Lift the weight up using your calves by getting on your toes.', null, null, 'wger', 'efeccb1b-73c0-4303-8542-bb4f45ef831a', 'CC-BY-SA 4', 'Expenses7000'),
  ('Incline Close Grip Barbell Bench Press', 'push_h', false, false, true, 'Arms', '{"Triceps"}', '{"Shoulders","Chest"}', '{"Barbell"}', 'Narrower grip than regular bench press, just outside shoulder width.', null, null, 'wger', 'fca05168-7212-42ec-8927-efb1e8dd0971', 'CC-BY-SA 4', 'Expenses7000'),
  ('Floor Skull Crusher', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"SZ-Bar"}', 'Allowing you to safely load more weight than a regular skull crusher, lie on the floor and rest the weight on the floor in between each repetition.', null, null, 'wger', '6b68043c-a900-41f4-89fb-ea5c8193f216', 'CC-BY-SA 4', 'Expenses7000'),
  ('Kroc Row', 'pull_h', false, false, false, 'Back', '{"Lats","Trapezius"}', '{}', '{}', 'Dumbbell rows with looser technique but heavier weight.', null, null, 'wger', '84b38ac6-9628-4f80-8940-204047fa2544', 'CC-BY-SA 4', 'Expenses7000'),
  ('W-Raise', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Bodyweight"}', 'This challenging exercise is a variation of reverse crunches that is made up of three parts in which we’re basically drawing an upside down ‘W’ with our legs.
Start position is lying face up flat on the floor with legs extended at the low point of the outer leg of the ‘W’. Keeping a strong core and legs straight, go up, rise your hips and then slowly lower your legs down halfway. Then, lifting your legs back up to the top, rise your hips again, maintaining that straight line, use your core strength to finally come back all the way down to the other outer leg of the W. Then you reverse the ‘W’ to return to the start.', null, null, 'wger', '8b494562-012e-4944-be65-9b168f0c8c41', 'CC-BY-SA 4', 'Moffi'),
  ('Black Widow Knee Slides', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{}', 'In
this bottom-up rotation exercise movement, you’ll cross your knee over and
drive it into that opposite elbow. Start in high plank position (or tabletop
position) with hands directly beneath your shoulders. Lift the left knee toward
the right arm and slide it up the forearm to get more of that posterior pelvic
tilt and engagement of the abdominal muscles. Then do the opposite side,
bringing your right knee toward your left hand.', null, null, 'wger', '64ebb7a5-15ec-48dd-8f82-47cdb022f215', 'CC-BY-SA 4', 'Moffi'),
  ('Butterfly Sit Up', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Bodyweight"}', 'In
this midrange exercise your arm muscles provide you with a little bit of
momentum to help to get you off the ground. You also open them up in overhead
position which engages the upper back. Start
lying with feet flat on the ground, knees at an angle, arms crossed in towards your chest. Using
your ab muscles, bring your upper body off the ground as you open your arms
into goal post position, then slowly lower yourself back down to return to
starting position.', null, null, 'wger', '1bb3bbaf-2dc2-4651-95db-71faf5304075', 'CC-BY-SA 4', 'Moffi'),
  ('Seated Corkscrew', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Bodyweight"}', 'To
do this abs and obliques exercise, start with your hands back behind your body
and bring your knees in and across, really trying to contract the obliques.
Then extend your legs back out to starting position and repeat toward the
opposite side of the abs.
Beginners
might find that they can’t even get through the first 45 seconds of this
challenging reverse crunches variation. That’s ok because it gives you a
place to start and something to improve upon.', null, null, 'wger', 'e9891a94-b1d4-47f4-a82b-c1aa82121abb', 'CC-BY-SA 4', 'Moffi'),
  ('Levitation Crunch', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'For
this top down movement, we’re trying to move the upper torso without moving the
lower torso. Start lying on the ground with feet flat on the floor and crossed
arms above your head with hands behind head. Lift upper body up and clear your
shoulder blades off the ground and then hold and pause at the top for a one or
two count. Try to make the upper abs work and hold that contraction for 10 good
quality reps.', null, null, 'wger', '9816dc3a-9739-4c70-bce0-4131f889e4f2', 'CC-BY-SA 4', 'Moffi'),
  ('Sit Up Elbow Thrust', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Bodyweight"}', 'This
is a top down rotation movement, and it’s a bit more
explosive, too.
Lying with knees bent and feet on the floor, sit up and then drive your left elbow across your entire body toward the right, then come back
to center and then finally lower yourself down. Then hit the other side.', 'https://wger.de/media/exercise-images/1479/0305d98e-0887-4c0c-8992-7c220814efc2.webp', null, 'wger', '5af00591-2d77-4ea6-a347-825ad18beff1', 'CC-BY-SA 4', 'Moffi'),
  ('Lying Triceps Extensions', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Barbell","Dumbbell"}', 'Starting position for this
practical triceps exercise is lying on a standard bench holding a barbell or two dumbbells in both hands with an overhand grip, hands at shoulder width apart.
Begin with arms over your upper
chest and elbows bent back at about a 45-degree angle.
First bend at the elbows and
then allow the upper arm to drop back, bringing the barbell/dumbbells behind your
head and down toward the floor. In terms of upper arm position, the barbell/dumbbells should never be fully above your head, but instead behind it, to
ensure that you’re targeting the triceps.
Keep the shoulder blades tucked
under, the elbows tight in toward your head and your core active during
this entire movement.', null, null, 'wger', '8a356e9a-0058-4f60-b8d7-89147c3c371f', 'CC-BY-SA 4', 'Moffi'),
  ('Dumbbell Cheat Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Starting position is standing
with feet shoulder width apart.
Hands should take an underhand
or supinated grip on the dumbbells holding them with hands shoulder
width apart.
Keeping elbows tucked into your
sides throughout the entire movement, use momentum to curl the dumbbells,
squeezing your biceps at the top of the movement.
Slowly lower to return to the
starting position. Keep the core tight throughout the exercise.

Cheating
through the concentric curling portion of this challenging exercise gives us a
great opportunity to increase time under tension and create eccentric overload
with heavier weight when we lower.', null, null, 'wger', '31a58615-d3ae-4233-9c50-9143c899ce8c', 'CC-BY-SA 4', 'Moffi'),
  ('Bizeps Curls Trifecta', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'This exercise is a mixture of three different curls: the Supinated Cross Body Curl, the Pronated Cross Body Curl and the No Money Curl. You
alternate between three curl variations that each accomplish different goals,
and you’ll keep the set going beyond the usual 8-12 rep range which gives
us that intensity.

For the Supinated Cross Body
Curl, supinate the forearm with palms facing toward the ceiling and
forearms coming across the body. Lift the inner-facing weight of the dumbbell towards your shoulder.
For the Pronated Cross Body
Curl, pronate the forearm with palms facing toward the floor (pronated
grip or overhand grip) and forearms coming across the body. Lift the inner-facing weight of the dumbbell towards your shoulder.
For the No Money Curl, you’ll
curl the dumbbell as you outwardly rotate the shoulder. Lift the inner-facing weight of the dumbbell towards your outer side of the shoulder.', null, null, 'wger', 'da6ab4d8-edd2-428d-b194-fb15948d3fd5', 'CC-BY-SA 4', 'Moffi'),
  ('Hyper Y W Combo', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{}', 'Use a glute-ham raise or a
stability ball for this exercise and a light weight plate in each hand.
Raise your torso to form a straight line with your legs and raise the
arms outward slightly beyond a 90-degree angle into a W position to hit
the rotator cuff muscles, and then lower back to the starting position.
Then raise up again with arms
in a Y position to activate the lower traps.', null, null, 'wger', 'ebe7d74b-78a8-4757-9310-6fb22b23aa58', 'CC-BY-SA 4', 'Moffi'),
  ('Lying Triceps Kickback', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Dumbbell","Incline bench"}', 'Set the bench to an 60deg angle. Stand still and rest your upper body on the inclined bench, ensuring a nearly straight line of your entire body. Squeeze your shoulder blades together, so that your elbows are located behind your torso with your upper arms nearly parallel to the floor. Lift the dumbbells until your arms form a straight line. Slowly lower the dumbbells back to the initial position. Initial position corresponds to an rectangular position of upper and lower arms.', null, null, 'wger', '9c979645-78d1-44be-92a0-7940430a6a98', 'CC-BY-SA 4', 'Moffi'),
  ('Barbell Romanian Deadlift (RDL)', 'hinge', false, false, false, 'Back', '{"Hamstrings","Glutes"}', '{}', '{"Barbell"}', 'Execution

Hinge at the hips:

Push your hips backward, keeping a slight bend in the knees (soft knees).
Lower the barbell along the front of your thighs/shins while maintaining a neutral spine.
Keep the bar close to your body.', null, null, 'wger', '72129e4f-df97-4869-9561-33a1ba3c9186', 'CC-BY-SA 4', 'daiben'),
  ('DB Upper Chest Variation', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Shoulders"}', '{"Dumbbell"}', 'Dumbbell in hand in a curl fashion, lean body into the arm to help the dumbbell up above the chest, next to the head, to activate chest and delt combo', null, null, 'wger', '4b23738a-67a8-41af-996d-abc53a7c3f97', 'CC-BY-SA 4', 'JohnPreston'),
  ('DB Underhand bench press', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Shoulders"}', '{"Bench","Dumbbell"}', 'Underhand grip DB, perform a normal bench press movement, keeping the elbows close to the chest', null, null, 'wger', '7b40813b-80a3-42cc-8938-0c5199ef7620', 'CC-BY-SA 4', 'JohnPreston'),
  ('Elbows Tucked DB Bench Press', 'push_h', false, false, false, 'Arms', '{"Triceps"}', '{"Chest"}', '{"Bench","Dumbbell"}', 'Elbows Tucked DB Bench Press, chest press movement focusing on the triceps. DB stays parallel with body', null, null, 'wger', '732a9a7f-fb45-41ea-94a3-6a7246a699f6', 'CC-BY-SA 4', 'JohnPreston'),
  ('Lateral Walk', 'pull_h', false, false, false, 'Back', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Lateral walks, also known as side steps or squat walks, are a type of exercise where you move sideways in a squatting position. They can be performed with or without resistance bands. These exercises strengthen the hip abductors, glutes, and other stabilizing muscles.', null, null, 'wger', 'c5015ed9-042b-42d3-9dac-13759ea9571e', 'CC-BY-SA 4', 'cozyGalvinism'),
  ('Alternative DB Gorilla rows', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Dumbbell"}', 'Slightly bent down and knees to mimic a gorilla position and pull/row up the DBs to the chest. DB stay straight (thumbs pointing up)', null, null, 'wger', '81015468-545f-4170-9b46-701afe77848e', 'CC-BY-SA 4', 'JohnPreston'),
  ('DB Cross Body Hammer Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Dumbbell cross body biceps curls, works on the braccialis', null, null, 'wger', '038f7cb1-6aa3-4c48-a19d-a31993f7b0d8', 'CC-BY-SA 4', 'JohnPreston'),
  ('Dumbbell Frog Press', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Dumbbell"}', 'Similar to hip thrust, but with feet put up together, lifting the butt off the ground in a frog like position.', null, null, 'wger', 'b407768d-d519-47b8-818a-44c9761a8be6', 'CC-BY-SA 4', 'JohnPreston'),
  ('Dumbbell Bradford press', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'From a front hold of the DBs in a OHP, press above the head, bring back towards the rear of the shoulders, down, and press back forward.', null, null, 'wger', '82f19d1c-f12b-49f0-bfdd-24239f93eabc', 'CC-BY-SA 4', 'JohnPreston'),
  ('Toes to bar', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Lats","Obliquus externus abdominis"}', '{"Pull-up bar"}', 'The name "Toes to Bar" says it all: This exercise, in which you hang from a pull-up bar, involves bringing your toes toward the bar, pointing toward your face. This really works your abdominal muscles. "Toes to Bar" is popular in functional fitness programs like Freeletics and CrossFit, and is an effective exercise for six-pack training.', null, null, 'wger', '42d09639-a5a6-4aa6-b115-e4c96b1d3735', 'CC-BY-SA 4', 'florian.bussmann'),
  ('High-Incline Smith Machine Press', 'push_h', false, false, true, 'Chest', '{"Shoulders","Chest","Triceps"}', '{}', '{}', 'Set the bench to a 45-60° incline. Touch the upper chest with the bar.', null, null, 'wger', 'ecba2395-f364-4e5f-a34c-04f178c8b822', 'CC-BY-SA 4', 'Expenses7000'),
  ('Kong Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'This exercise is somewhat similar to a cable curl and a cable crossover. But instead of a chest/biceps exercise, this exercise targets the brachialis muscle, responsible for that broad arm when viewed from a front view.
During the exercise, maintain a pronated forearm position with starting position of approx. 45 degree pronated. Start with slightly bend elbows and alternately curl until your hands (your thumb first) meet your upper middle chest (similar to how Kong hits his chest, thus the name of this exercise).', null, null, 'wger', '329d2adc-4b2c-4bb2-95d7-f5f6fedb9b96', 'CC-BY-SA 4', 'Moffi'),
  ('Drop Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Drop curls in a modified position at a slow pace effectively engage the brachialis for arm width.
Starting position is with both arms in a slight angle towards each other at chest height with a dumbbell in each hand. Lower one dumbbell close to full extended arm position slowly and in a controlled manner during the first half of the curl, then curl it back up to starting position, while the other dumbbell stays at its starting position. Now lower the other dumbbell down. This keeps tension on the brachialis. As we pass the 90deg mark on our way down, the biceps will take over the work.', null, null, 'wger', '15ee508d-fbd7-4acf-ab44-e35525582693', 'CC-BY-SA 4', 'Moffi'),
  ('Leg Press Toe Press', 'squat', false, true, false, 'Legs', '{"Calves"}', '{}', '{}', 'Move the leg press using your calves by placing your feet at the bottom of the platform.', null, null, 'wger', '0cc9c8ed-57f1-42c3-a4c4-6e57e6a1b878', 'CC-BY-SA 4', 'Expenses7000'),
  ('Handstand', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{}', 'Handstand free standing by pressing arms into the ground and contracting core and glutes', null, null, 'wger', '35008ce6-74ca-40db-b965-44a1eccfa061', 'CC-BY-SA 4', 'Fittness69'),
  ('Overhead Triceps Extension', 'isolation', false, false, false, 'Arms', '{"Trapezius"}', '{}', '{"SZ-Bar"}', 'Overhead Triceps Extension with EZ Bar – Quick Guide

The overhead position emphasizes the long head of the triceps (because it''s stretched under load), the exercise does engage all three triceps heads (long, lateral, and medial) to some degree during extension.

Setup:
Sit on a bench (or stand) and hold an EZ bar with a narrow, overhand
grip. Lift the bar overhead, arms fully extended. Keep your core tight
and elbows close to your head.
Execution:
Slowly lower the bar behind your head by bending your elbows until they
reach ~90°. Keep elbows pointed forward (not flaring out).
Finish: Extend your arms back up to the starting position, squeezing your triceps at the top.

Tips:

Control the movement to avoid straining your shoulders.
Use a moderate weight for full range of motion.
Keep your back straight and avoid arching.', 'https://wger.de/media/exercise-images/1519/fab7f641-27d4-40b5-8edd-1a0a137bfd94.gif', null, 'wger', 'c5797bdf-1aa1-4d51-9775-c929ec5a2aaf', 'CC-BY-SA 4', 'benjamin.yildiz@proton.me'),
  ('Incline Static Hold', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Dumbbell"}', 'Execution

Hold Position:

Lower the dumbbells a few inches above your chest — about the midpoint of a normal incline press.
This is where your upper chest is under maximum tension.

Static Hold:

Hold the position for 20–45 seconds while keeping the chest tight.
Breathe slowly but stay tense — do not relax your chest or shoulders.

End the set:

After the hold, carefully bring the dumbbells down and rest.', null, null, 'wger', '88afb956-8d4a-45b3-8c7c-c23719316bfe', 'CC-BY-SA 4', 'daiben'),
  ('Flat Machine Press', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Bench"}', 'Execution

Start position:

Elbows bent at roughly 90°, hands just outside your chest.
Keep wrists straight and aligned with your forearms.

Pressing phase (concentric):

Push the handles forward until your arms are almost fully extended — don’t lock out.
Focus on squeezing your chest at the end of the movement.

Returning phase (eccentric):

Slowly bring the handles back toward your chest, feeling the stretch in your pecs.
Maintain tension — don’t let the weight stack touch down between reps.', null, null, 'wger', '03f7fc27-e64f-4417-ab0c-a52adac60fda', 'CC-BY-SA 4', 'daiben'),
  ('Sled Push', null, false, false, true, 'Cardio', '{"Calves","Glutes","Quads"}', '{"Shoulders","Hamstrings","Triceps"}', '{}', 'Load the sled with 25% of your maximum load. If you don’t know this, choose a weight you can push for 10 minutes with short breaks. Beginners may choose to push the sled with no weight.
Stand behind the sled and grab the poles with a high-grip hand position.
Engage your core muscles and start pushing the sled forward as fast as you can, powering through your entire leg. Extend your hips and knees as you move the sled forward. Your foot stance should resemble your natural running position.', null, null, 'wger', '32cc7175-3fda-4c7e-900f-8766c22e3b2b', 'CC-BY-SA 4', 'flanny'),
  ('Battle Ropes', null, false, false, true, 'Cardio', '{"Hamstrings","Glutes","Lats","Obliquus externus abdominis","Quads","Abs"}', '{"Shoulders","Biceps","Chest","Trapezius","Triceps"}', '{}', 'Hold the ends of the rope at arm''s length in front of your hips with your hands shoulder-width apart.
Brace your core and begin alternately raising and lowering each arm explosively.
Keep alternating arms for three to four sets of 1 to 2 minutes.', null, null, 'wger', 'a5d1f45b-ff07-45d7-a699-a654f9328934', 'CC-BY-SA 4', 'flanny'),
  ('Ball Slams', null, false, false, true, 'Cardio', '{"Lats","Obliquus externus abdominis","Abs"}', '{"Shoulders","Glutes"}', '{}', 'Stand with your feet about shoulder-width apart, your knees and hips slightly bent, holding the ball in both hands at chest height. Engage your core, and keep a good posture.
Extend your knees and drive your hips forward while simultaneously lifting the ball. Aim for being as tall as possible, the ball overhead, arms up, hips slightly forward, and on your toes from the force of your drive.
Use your core and arms to slam the medicine ball straight down between your feet with as much force as possible. Press your hips back and bend your knees to further power the slam. Exhale as you slam the ball down.
Squat down to pick up the ball from the floor, then immediately move into the next slam by repeating the movement. Repeat for reps or time.', null, null, 'wger', 'a1e8759d-72b9-422f-87a8-9d316fa18498', 'CC-BY-SA 4', 'flanny'),
  ('Ski Machine', null, false, false, true, 'Cardio', '{"Calves","Lats","Trapezius","Triceps"}', '{"Hamstrings","Glutes","Quads","Abs"}', '{}', 'Start standing on the platform with your feet hip-width apart.
Reach overhead to grip the handles with your palms facing in.
Soften your knees, then simultaneously drive your butt back as if you''re closing a door behind you while pulling your arms straight down past your hips until your hands pass by the side of your knees.
Next, bring your arms back overhead while thrusting your hips forward until you''re standing with your arms fully extended.
Repeat for reps, time or distance.', null, null, 'wger', 'e29d9914-6b02-490b-8f3a-f9fe8f21993c', 'CC-BY-SA 4', 'flanny'),
  ('Pendulum Squat', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Hamstrings","Glutes"}', '{"Bodyweight"}', 'Place your feet in the middle of the plate at about shoulder width. Tense your torso. Keep your neck relaxed.', null, null, 'wger', 'ffdb4806-d64e-474b-8ce5-8df9a57fb9c7', 'CC-BY-SA 4', 'schweezer'),
  ('Glute Drive', 'squat', false, true, true, 'Legs', '{"Glutes"}', '{"Hamstrings","Quads"}', '{}', 'Lie down on the back pad and strap yourself in with the waistband. Position yout feet shoulder-length apart. They should be slightly splayed.', null, null, 'wger', 'ce21d3a2-cdc5-410c-9970-c25029ca3769', 'CC-BY-SA 4', 'schweezer'),
  ('Lying Dumbbell Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Bench","Dumbbell"}', 'Take a
dumbbell in each hand and lie backwards on a bench, similar to a classic chest press.
Let your arms hang down at your sides, with the dumbbells possibly touching the
floor. Now start to lift the dumbbells upwards until your forearms are
perpendicular to the ceiling. Slowly lower the dumbbells until they almost
touch the floor again. Keep your ellbows in place to minimize cheating.', null, null, 'wger', '861f7396-f34e-486c-a903-3c326086f920', 'CC-BY-SA 4', 'Moffi'),
  ('Pull-Ups (Wide Grip)', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Bodyweight"}', 'Execution

Pulling phase (concentric):

Drive your elbows down and slightly back, pulling your chest toward the bar.
Focus on leading with your chest, not your chin.
Keep your shoulders depressed (avoid shrugging).

Top position:

Chin should clear the bar (or at least reach bar level).
Pause for a brief squeeze in your lats.', null, null, 'wger', 'be4eb0b6-2c39-4ff5-b57d-419f1687c90f', 'CC-BY-SA 4', 'daiben'),
  ('Barbell Row (Overhand)', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Barbell"}', 'Execution

Starting position:

Hold the barbell with arms fully extended toward the floor.
Maintain tension in your lats and back muscles.', null, null, 'wger', '6ce25688-ae91-4dc7-9b17-0b66a47151fa', 'CC-BY-SA 4', 'daiben'),
  ('Barbell Row (Underhand)', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Barbell"}', 'Execution

Starting position:

Hold the barbell with arms fully extended toward the floor.
Maintain tension in your lats and back muscles.', null, null, 'wger', '3c2b5e2d-bd9d-43e8-8b5f-e6363331faa1', 'CC-BY-SA 4', 'daiben'),
  ('Delt Stretch', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Bodyweight"}', 'Stretch your deltoids for a certain period of time.', null, null, 'wger', '6a448382-0ea9-4f41-8a83-0b7cd7d8a2bf', 'CC-BY-SA 4', 'Expenses7000'),
  ('Pull-up Isometric Hold', 'pull_v', false, false, true, 'Back', '{"Biceps","Lats","Trapezius"}', '{}', '{"Pull-up bar"}', 'Hold the pull-up movement in any position', null, null, 'wger', '5e3a322b-98dd-4197-b16f-4ac72c42c223', 'CC-BY-SA 4', 'DiscoCop'),
  ('One-Arm Heavy Row', 'pull_h', true, false, false, 'Back', '{"Lats"}', '{}', '{"Dumbbell"}', 'Execution

Rowing phase (concentric):

Pull the dumbbell toward your lower chest or waist, leading with your elbow.
Keep your torso stable — avoid twisting or rotating your shoulders.
Pause at the top and squeeze your lats.', null, null, 'wger', 'd8ec22e5-8575-483f-bd66-5203fd4bfe84', 'CC-BY-SA 4', 'daiben'),
  ('Patadas traseras', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Bench","Dumbbell"}', 'The dumbbell kickback is a popular strength training exercise that targets the triceps muscles in the back of your upper arms. It helps strengthen and tone the triceps, contributing to overall arm strength and aesthetics.

Among the exercises that work the arm muscles, kickback and its variations are very effective. You can easily apply these exercises with dumbbells, cables or resistance bands.', null, null, 'wger', '17dd0986-5248-410d-89a4-9268282d103b', 'CC-BY-SA 4', 'Mariano_O'),
  ('Tuck L-sit', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Brachialis","Chest","Quads","Trapezius","Triceps"}', '{"Bench"}', 'The tuck L-sit is a bodyweight hold where you support yourself on parallel bars, parallettes, or the floor with straight arms while pulling your knees toward your chest. Your hips stay lifted, your spine stays tall, and your feet hover off the ground. The goal is to keep your core tight, shoulders depressed, and arms locked out while maintaining the tucked position. It’s a core-intensive, shoulder-stabilizing static hold often used as a progression toward the full L-sit.', null, null, 'wger', '9396a728-3da4-4390-ae4d-882395805008', 'CC-BY-SA 4', 'clafal'),
  ('Bretzel stretch', 'pull_h', false, false, true, 'Back', '{"Glutes"}', '{"Hamstrings","Lats","Chest"}', '{"Bodyweight"}', 'How to Perform the Bretzel Stretch Starting Position: Lie on your back on a flat surface, such as a mat. Bend your knees and place your feet flat on the ground. Leg Positioning: Lift your right leg and cross it over your left leg, placing your right foot on the outside of your left knee. Your left leg should remain flat on the ground. Arm Positioning: Extend your left arm out to the side at shoulder height, keeping it straight. Use your right hand to gently pull your right knee towards the floor on the left side of your body. Stretching: As you pull your knee down, try to keep your left shoulder flat on the ground. You should feel a stretch in your hip, lower back, and possibly your chest. Hold the Position: Maintain this position for 20-30 seconds, breathing deeply and relaxing into the stretch. Switch sides and repeat the process.', null, null, 'wger', 'a94c635d-096c-45a8-a68c-64941d0b6ba4', 'CC-BY-SA 4', 'mountain.potato'),
  ('Archer Pull Up', 'pull_v', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{}', 'An archer pull-up is an advanced bodyweight exercise that strengthens your back and biceps, serving as a progression towards a one-arm pull-up. It gets its name from the "bow-drawing" position your body takes at the top.Here''s how to do it:1. Grip: Grasp a pull-up bar with a wider-than-shoulder-width overhand grip.2. Starting Position: Hang with arms fully extended, engaging your core and keeping your shoulder blades pulled down.3. The Pull: Pull your body up towards one hand, similar to a regular pull-up. At the same time, extend the other arm out to the side, keeping it as straight as possible. Your chin should come towards the hand that is pulling.4. Hold & Lower: Briefly hold the top position where one arm is bent and pulling, and the other is extended. Slowly lower yourself back to the starting position with control.5. Alternate: Repeat the movement, pulling up towards the opposite hand.The key to this exercise is to keep the assisting arm as straight as possible to maximise the load on the working arm. This makes it a challenging but effective exercise for unilateral pulling strength.', null, null, 'wger', '56808c52-050e-4c24-9f27-2657f0462499', 'CC-BY-SA 4', 'Antsy6277'),
  ('Larsen Press', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Barbell"}', 'Put your legs up on a separate Bench and press with no leg drive', null, null, 'wger', '87f30f6d-dc8a-4b26-8c4f-640b66ecacf0', 'CC-BY-SA 4', 'Expenses7000'),
  ('Bulgarian Squat with Dumbbells', 'squat', true, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Dumbbell"}', 'The Bulgarian split squat consists of performing a squat on one leg with the rear foot resting on a raised platform. Elevating your back leg on a bench creates instability and increases the range of motion of the exercise.', 'https://wger.de/media/exercise-images/1706/0c5243cc-2539-4005-aee0-d3a8c5d3a32c.jfif', null, 'wger', '60d2c34b-43a1-48a3-b43b-160e4c0157f2', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Stair Master', null, false, false, true, 'Cardio', '{"Hamstrings","Calves","Glutes","Quads"}', '{}', '{"Bodyweight"}', 'cardio and lower-body strength machine designed to simulate climbing stairs. It provides a low-impact, high-intensity workout that targets the legs, glutes, and core while improving cardiovascular endurance.', null, null, 'wger', 'b3e433ed-0247-46b3-be77-9f2738a09a48', 'CC-BY-SA 4', 'MisterPinnacle'),
  ('High Row', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Kneeling down on one leg and pulling cable down while driving elbow into the lats.', null, null, 'wger', 'f80468f2-7c5d-45c5-9470-46a88c1a75c2', 'CC-BY-SA 4', 'aahuja'),
  ('Elevación lateral polea', 'pull_h', false, false, false, 'Back', '{"Shoulders"}', '{}', '{"Incline bench"}', 'Lateral elevation unilateral using a polea', null, null, 'wger', 'a2fa24ba-597f-4746-b9b0-fbabae6396e6', 'CC-BY-SA 4', 'polloperro'),
  ('Bayesian Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Cable machine"}', 'Cable curl with stretched shoulder (backwards)', null, null, 'wger', '06968051-a818-489c-9fbb-ddb94a001245', 'CC-BY-SA 4', 'aahuja'),
  ('Cable Tricep Kickback', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'Grab onto the handle, and pull your elbow up and back slightly above
your torso. Keep your upper arm to be parallel to the ground for the
duration of the set', null, null, 'wger', '1ea73578-08a5-4f3e-9255-3c58b29b170d', 'CC-BY-SA 4', 'Expenses7000'),
  ('Butchers Block Stretch', 'push_v', false, false, false, 'Shoulders', '{"Lats"}', '{"Trapezius"}', '{"Bench"}', 'Kneel down with the hands together
Rest the elbows on a bench in front of you and lower the chest down
Keep the elbows bent with good posture and hold', null, null, 'wger', '4885c051-154b-4a9b-a0fe-ccb70a652fa4', 'CC-BY-SA 4', 'Croak6728'),
  ('Clap Push-UP', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Abs","Triceps"}', '{"Bodyweight"}', 'The clap push-up is an explosive upper body movement that builds power and fast-twitch muscle strength. It adds a plyometric challenge to the traditional push-up by requiring the hands to leave the ground mid-rep.

Start in a strong push-up position with your hands slightly wider than shoulder-width and core engaged
Lower your body explosively and push off the ground with enough force to lift your hands.
Quickly clap your hands together at chest level before returning them to the floor.
Land with soft elbows to absorb the impact and immediately move into the next rep', 'https://wger.de/media/exercise-images/1554/49207a62-8799-4b47-8c0b-7bde02926f3d.png', null, 'wger', 'fdeb0973-121f-494d-8b94-54f1d7ba003f', 'CC-BY-SA 4', 'Settebello'),
  ('Sleeper Stretch', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Trapezius"}', '{"Bodyweight"}', 'Lie on your side so that you are resting a little weight on your shoulder blade to keep it still
Extend your arm to 90 degrees in front of you, resting on the floor/mat
Lift your hand with your elbow so that your fingers point to the ceiling and your palm points towards your feet
Keeping your elbow still, gently lower your palm toward the floor', null, null, 'wger', '90f12b1b-b33e-4d83-9f9e-e26d3a4b8e0b', 'CC-BY-SA 4', 'Croak6728'),
  ('Neutral Grip Lat Pulldown', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Lat pull downs with a neutral grip on the bar.', null, null, 'wger', '3cad7b92-a16b-45dc-a53e-d6a01a158f8e', 'CC-BY-SA 4', 'Expenses7000'),
  ('Devil’s Press', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Glutes","Chest"}', '{"Hamstrings","Lats","Obliquus externus abdominis","Triceps"}', '{"Dumbbell"}', 'The Devil’s Press is a hybrid movement combining a dumbbell burpee and a double dumbbell snatch. It’s a full-body, high-intensity exercise that develops strength, power, and metabolic conditioning.

Start with a dumbbell in each hand and perform a burpee, letting your chest touch the ground while holding the dumbbells.
Explosively jump your feet forward and swing the dumbbells between your legs.
Drive the dumbbells overhead in one continuous motion, locking out your arms.
Lower the dumbbells with control to return to the starting position and repeat', 'https://wger.de/media/exercise-images/1556/a23c820b-e08b-4911-a6a4-80f16c15d2e0.png', null, 'wger', 'bb9b994e-426f-4693-9d16-3f8d5a9c72b8', 'CC-BY-SA 4', 'Settebello'),
  ('Overhead Cable Tricep Extension', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'Use rope handle with your back against the cable machine. Straighten your arms until they are filly extended and reverse the motion resisting on the negative.', null, null, 'wger', 'f2e17c8d-7285-4fd5-bfe8-26f407802850', 'CC-BY-SA 4', 'Expenses7000'),
  ('Cable Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Cable machine"}', 'Bicep Curls using cables. Can be seated or standing', null, null, 'wger', '479ef6f0-5274-4da7-b5ad-67528ff3c8fd', 'CC-BY-SA 4', 'Brigade7938'),
  ('Cable Fly Middle Chest', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Cable machine"}', 'Execution

Start position: Arms extended out to your sides (a big “T” shape), feeling a stretch in your chest.

Movement: Bring your hands together in front of your chest in a wide hugging motion.

Focus on squeezing your chest at the center.
Do not lock your elbows or turn it into a press.

Return: Slowly open your arms back to the start, maintaining tension on the chest.', null, null, 'wger', '5b4fb3ec-53a1-4525-a58a-c070798ea86e', 'CC-BY-SA 4', 'daiben'),
  ('Cable Fly Upper Chest', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Cable machine"}', 'Execution

Start position:

Arms down and slightly behind your body, elbows slightly bent.
Feel a light stretch across your chest.

Movement:

Bring your hands upward and together in front of your upper chest — roughly at chin to collarbone level.
Use a smooth, controlled motion (avoid jerking).
Squeeze your chest at the top for 1–2 seconds.

Return:

Slowly let your arms move back down and out to the sides, keeping control and tension.', null, null, 'wger', 'b16a28c4-40bf-42d4-94b3-bf3f56fab743', 'CC-BY-SA 4', 'daiben'),
  ('Cable Fly Lower Chest', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Cable machine"}', 'Execution

Start position:

Arms extended out to your sides in a “Y” shape.
Feel a stretch in your chest (slight bend in elbows — don’t lock them).

Movement:

Bring your hands downward and together in front of your lower chest or upper abs, in a smooth arc motion.
Squeeze your chest hard at the bottom for 1–2 seconds.

Return:

Slowly raise your arms back up along the same path until you feel a good stretch in your chest.
Maintain control — don’t let the weights pull you back too quickly.', null, null, 'wger', 'ae695660-7cee-4601-8241-edd3e2a6d896', 'CC-BY-SA 4', 'daiben'),
  ('Jalón al pecho con agarre ancho', 'pull_h', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Biceps","Brachialis"}', '{"Cable machine"}', 'The lat pulldown is a pulling exercise that primarily targets the latissimus dorsi muscles (commonly known as “lats”) in your back. It involves pulling a cable bar or handle down towards your chest while seated on a machine specifically designed for this exercise. The lat pulldown is typically performed with a wide grip, but can also be done with a narrow grip or underhand grip to target different muscle groups in the back and arms. It is a popular exercise for building upper body strength and improving posture.', null, null, 'wger', 'c9de4551-f1bc-4490-98f4-c9f87c2a2cac', 'CC-BY-SA 4', 'Mariano_O'),
  ('DB Single-Arm Row (5kg)', 'pull_h', true, false, true, 'Back', '{"Lats"}', '{"Biceps","Brachialis"}', '{"Dumbbell"}', 'Vasco custom single-arm DB row for 5kg dumbbell home training. Unilateral horizontal pull. Part of Tuesday Pull day.', null, null, 'wger', 'ef7d621e-ddb2-490f-ae2b-e73dd509d396', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Bird Dog', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Shoulders","Glutes"}', '{"Bodyweight"}', 'The Bird Dog is a core stability exercise that enhances balance, coordination, and spinal alignment. It’s a low-impact movement ideal for strengthening the posterior chain and improving overall functional control.

Begin on all fours with hands under shoulders and knees under hips, keeping your spine neutral.
Extend your right arm forward and left leg backward simultaneously, keeping hips square.
Pause briefly at full extension while engaging your core and glutes.
Return to the starting position and repeat on the opposite side', 'https://wger.de/media/exercise-images/1572/3d14e761-a73d-49da-8804-f3016a7573ff.png', null, 'wger', '6349365e-e901-4280-a1b7-65734986f47d', 'CC-BY-SA 4', 'Settebello'),
  ('Ab wheel', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis","Serratus anterior"}', '{"Bodyweight"}', 'Starting Position: Kneel on the floor with the ab wheel in front of you.
Grip the Wheel: Hold the handles firmly.
Roll Out: Slowly roll the wheel forward, extending your body while keeping your core tight.
Return: Pull the wheel back towards your knees, maintaining tension in your core.', 'https://wger.de/media/exercise-images/1573/a9ab402b-61ef-4d60-b91a-df52bf7f41a9.jpg', null, 'wger', '203a6fee-7436-4313-858f-c1e364136793', 'CC-BY-SA 4', 'lhegedus'),
  ('Snap Down', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{"Calves","Abs"}', '{}', 'Begin in a standing position with your
arms up over your head and your toes pushing into the ground raising
your heels up becoming as tall as you can. From this position, perform a
small hop with both feet slightly coming off of the ground. As you
land, bend your knees and begin to hinge forward at your hips absorbing
the landing. Return to the starting position and repeat. 
You should feel the muscles in your lower body working. 
Start with your arms and knees fully
straightened out. Keep a stable balance as you land and briefly hold
that end position, don’t go too fast and become off balanced. Keep your
chest up. 
For a detailed video on landing mechanics, click here: https://youtu.be/RThUCYRDyZw', null, null, 'wger', 'c8f951dd-94e0-4548-bbed-3b7bc883f7ba', 'CC-BY-SA 4', 'mountain.potato'),
  ('Hip hinge', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes"}', '{"Calves","Quads","Abs"}', '{"Barbell"}', 'Hip Hinge Exercise DescriptionThe hip hinge is a fundamental movement pattern that involves bending at the hips while keeping the spine neutral. It is commonly used in exercises like deadlifts, kettlebell swings, and good mornings. To perform a hip hinge: Starting Position: Stand with your feet hip-width apart and a slight bend in your knees. Hinge at the Hips: Push your hips back while maintaining a straight back. Your torso should lean forward, and your chest should stay up. Lowering Phase: Continue to hinge until your torso is nearly parallel to the ground, or until you feel a stretch in your hamstrings. Return to Standing: Drive through your heels and thrust your hips forward to return to the starting position.', null, null, 'wger', 'e4c9bfde-cf06-4c24-9c56-c0bbc13c49b5', 'CC-BY-SA 4', 'mountain.potato'),
  ('Perpendicular Unilateral Landmine Row', 'pull_h', true, false, false, 'Shoulders', '{"Shoulders","Trapezius"}', '{}', '{"Barbell"}', 'Using a landmine attachment with the barbell running at 90 degrees to either side, hinge slightly at the hips and grip the barbell by the plate sleeve. Raise the barbell to chest height, with your upper arm parallel to the floor at the top of the movement.', null, null, 'wger', '7ae1aca7-cdd4-4a81-b22c-f31778462b6b', 'CC-BY-SA 4', 'CptnFatbeard'),
  ('Trap press', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{}', '{"Barbell","Bench","Dumbbell"}', 'Laying flat with arm pointing straight upwards, elbow fully extended, use only your shoulder to raise the weight as high as comfortable and back to rest.', 'https://wger.de/media/exercise-images/1581/b71a6710-5798-4639-ac5a-22a2cdae2036.jpg', null, 'wger', '41b9f5a5-73de-414d-b08a-54025eccedc6', 'CC-BY-SA 4', 'CptnFatbeard'),
  ('Side-laying interior rotation', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{}', '{"Barbell","Bench","Dumbbell"}', 'Laying on your side and using the arm closest to the bench, maintain a 90 degree bend at the elbow and allow the weight to fall towards the ground past the bench as low as comfortable. Bring the weight up using only rotation of the shoulder to the opposing shoulder.', 'https://wger.de/media/exercise-images/1582/5094fe30-eea2-4269-b0de-4b8a20558fd7.png', null, 'wger', 'd9c1f78c-7bf6-4e6a-92e4-7bf4ed4a0a67', 'CC-BY-SA 4', 'CptnFatbeard'),
  ('Supine press', 'pull_h', false, false, false, 'Back', '{"Trapezius"}', '{}', '{"Barbell","Bench"}', 'Take a close grip and push perpendicular to the bench. Keep back flat.', null, null, 'wger', '2c31daac-17b1-4cc9-b1c1-f34266ee2038', 'CC-BY-SA 4', 'CptnFatbeard'),
  ('March or jog in place', null, false, false, true, 'Cardio', '{"Hamstrings","Calves","Glutes","Quads"}', '{"Shoulders","Biceps","Obliquus externus abdominis","Abs","Triceps"}', '{"Bodyweight"}', 'Low-impact cardiovascular exercise that simulates running without moving, ideal for warming up, improving endurance, or training in small spaces.', null, null, 'wger', '564dc73e-e8d4-4fd1-85ab-64dce4dd3ea0', 'CC-BY-SA 4', 'MrAlfaRobot'),
  ('Leg and hip stretch', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{"Lats"}', '{"Bodyweight"}', 'Gentle movements to improve the flexibility of the lower body and release tension in the hips.', null, null, 'wger', '505d6a28-1e24-4349-ab2b-49af3300e08e', 'CC-BY-SA 4', 'MrAlfaRobot'),
  ('Arm and neck stretch', 'isolation', false, false, true, 'Abs', '{"Shoulders","Trapezius","Triceps"}', '{"Lats","Serratus anterior"}', '{"Bodyweight"}', 'Relieves tension in the upper body, especially useful for people with office jobs or prolonged postures.', null, null, 'wger', 'b48cd640-dd9f-4557-a4db-8cd33d5655a6', 'CC-BY-SA 4', 'MrAlfaRobot'),
  ('Deep breathing (standing or seated)', 'push_h', false, false, false, 'Chest', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Bodyweight"}', 'A conscious breathing technique to improve oxygenation, reduce stress and connect with the present moment.', null, null, 'wger', 'fae44c34-2e85-4d22-8fb8-7b14faf14719', 'CC-BY-SA 4', 'MrAlfaRobot'),
  ('Smith Machine Split Squat', 'squat', true, true, false, 'Legs', '{"Hamstrings","Quads"}', '{}', '{"Barbell"}', 'The "Smith Machine Split Squat" is a strength exercise
performed on the Smith machine, ideal for targeting the legs and glutes.
It involves placing one foot forward and the other back, lowering the
body until the front thigh is parallel to the ground while the bar
slides vertically along the machine. This exercise helps improve
stability, correct muscle imbalances, and reduces stress on the back,
providing a safe environment for strength training.', 'https://wger.de/media/exercise-images/1593/9815fcd6-cf40-4ddd-9b38-2eac25973de1.gif', null, 'wger', 'b382dcb2-60a8-412d-b0ee-6afe9c9f36d7', 'CC-BY-SA 4', 'workout@rooven.anonaddy.me'),
  ('Pull-Ups (Neutral Grip)', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{}', 'Execution

Pulling phase (concentric):

Drive your elbows down and back, pulling your chest toward your hands.
Keep your shoulders depressed and retracted (avoid shrugging).
Focus on squeezing your lats and upper back at the top.

Top position:

Chin should clear or reach the level of your hands.
Pause briefly and contract your lats hard.', null, null, 'wger', '1f490456-b426-4b89-b70c-e155c3571422', 'CC-BY-SA 4', 'daiben'),
  ('Horizontal Shoulder Flexion Stretch', 'push_v', false, false, false, 'Shoulders', '{"Chest"}', '{"Shoulders"}', '{"Bodyweight"}', 'Raise your arm out to the side, placing your hand on a wall or doorway beside you at shoulder height
Turn your body away from your arm to stretch the chest, as far as is comfortable', null, null, 'wger', 'ca4c8872-e53c-47ca-bc33-448b9ba9360f', 'CC-BY-SA 4', 'Croak6728'),
  ('Jalon caballero unialteral', 'pull_h', false, false, false, 'Back', '{"Brachialis","Obliquus externus abdominis"}', '{}', '{"Dumbbell"}', 'Pull performed in knight''s stance', null, null, 'wger', 'dcd81ab4-1e6f-4123-b4a5-3364195faf7b', 'CC-BY-SA 4', 'polloperro'),
  ('Reverse Fly Standing', 'push_h', false, false, false, 'Shoulders', '{"Shoulders","Trapezius"}', '{}', '{"Cable machine"}', 'Stand with a good posture holding a cable in each hand opposite the machine
Starting with the hands in front of your chest pull the arms out to
your side into the shape of a T with the elbows nearly straight
Slowly release the arms forward to the start
Repeat with the arms moving into the shape of a Y
Repeat with the arms in the shape of a W
Repeat with the arms in the shape of an L by your side', null, null, 'wger', '440cf10c-effb-4b63-a6e0-182fe47376f6', 'CC-BY-SA 4', 'Croak6728'),
  ('Dumbbell Scaption', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{"Shoulders"}', '{"Dumbbell"}', 'Starting position:

Stand upright with your feet shoulder-width apart.

Hold a dumbbell in each hand with a neutral grip (palms facing each other).

Keep a slight bend in your elbows, shoulders relaxed and shoulder blades pulled back.

Execution:

Slowly raise the dumbbells forward and slightly to the side, at about a 30–45° angle from your body (between a front raise and a lateral raise).

Lift until your arms are about shoulder height (do not go overhead).

Pause for a second at the top and feel the activation in your shoulders and scapular stabilizers.

Lower the dumbbells back down under control to the starting position.

Breathing:

Inhale as you lower the dumbbells.

Exhale as you lift them.

Common mistakes:

Using dumbbells that are too heavy (causing jerky movements).

Lifting above shoulder height (puts unnecessary stress on the shoulder joint).

Arching the lower back instead of keeping the movement controlled at the shoulders.

Purpose of the exercise:

Activates the lower trapezius, serratus anterior, and scapular stabilizers.

Helps correct posture and improve shoulder balance.', null, null, 'wger', 'd420baf8-977b-499e-8f91-416374227b91', 'CC-BY-SA 4', 'zdelko'),
  ('Leg curl with elastic', 'isolation', false, true, false, 'Calves', '{"Calves"}', '{"Hamstrings"}', '{"Resistance band"}', 'Standing position: Place the band under your feet in the middle of your foot and grasp it with a hammer grip.', null, null, 'wger', 'ca514fad-c6ce-47b0-93a0-dc73a3507099', 'CC-BY-SA 4', 'clafal'),
  ('Sliding Lateral Lunge', 'squat', true, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{"Calves","Obliquus externus abdominis"}', '{"Barbell"}', 'Stand upright with your feet hip-width apart, holding a kettlebell close to your chest in goblet position. Place one foot on a slider, gliding disc, or towel. Keep your chest tall and core engaged. Slowly slide the foot outward to the side while bending the opposite knee, lowering your hips into a lateral lunge. Keep the working leg’s knee aligned with the toes and avoid letting it collapse inward. The non-working leg remains straight and slides smoothly along the floor. Push through the heel of the bent leg to return to the starting position while maintaining control of the kettlebell.', 'https://wger.de/media/exercise-images/1604/7695428e-bfed-4021-b987-498d93153995.png', null, 'wger', '55bb8725-a7c9-48a0-b192-ec6c9db6f9bc', 'CC-BY-SA 4', 'RiccaBaro'),
  ('Copenhagen Adduction Exercise', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Obliquus externus abdominis","Serratus anterior","Trapezius"}', '{"Bench"}', 'Lie on your side with the elbow placed directly under the shoulder, similar to a side plank position. Place the upper leg on a bench with the inside of the foot or ankle resting on it. Lift your hips and hold your body in a straight line while keeping the lower leg off the floor. The exercise strongly activates the adductors of the upper leg while also challenging the core and hip stabilizers.', null, null, 'wger', 'dbed4613-e1d5-483f-90ae-6db5d593911e', 'CC-BY-SA 4', 'RiccaBaro'),
  ('Arm Raises (T/Y/I)', 'isolation', false, false, true, 'Arms', '{"Shoulders","Lats","Serratus anterior","Trapezius"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Stand upright with feet hip-width apart, core engaged, and arms relaxed at your sides. From this position, perform three different arm raises to target the shoulders and upper back:

T Raise: Lift your arms straight out to the sides until they are parallel to the floor, forming a “T” shape.
Y Raise: Lift your arms upward at about a 45° angle from your body to form a “Y” shape.
I Raise: Raise your arms straight overhead, close together, forming an “I” shape.

Maintain a neutral spine, avoid arching your lower back, and move slowly with control. Focus on squeezing your shoulder blades together and keeping your shoulders down away from your ears.', null, null, 'wger', 'e62d52fa-32f9-4747-9005-f88f05dc8334', 'CC-BY-SA 4', 'WiNNiE'),
  ('Typewriter Pull-ups', 'pull_h', false, false, true, 'Back', '{"Biceps","Lats"}', '{"Trapezius"}', '{"Bodyweight"}', 'Hang from a pull-up bar with an overhand grip, slightly wider than shoulder-width. Pull yourself up until your chin is above the bar. At the top position, instead of going straight down, shift your body to one side by extending one arm while keeping the other arm bent. Move smoothly from one side to the other, like a typewriter motion, before lowering yourself back down. This exercise increases time under tension and strengthens the lats, biceps, and shoulders while building unilateral pulling strength.', null, null, 'wger', '075bff87-f676-4d9d-92b4-39d557453fc7', 'CC-BY-SA 4', 'tenebrizz'),
  ('Bodyweight Biceps Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Bodyweight"}', 'Set up under a straight bar (around waist or chest height). Grip the bar with your palms facing you (supinated grip), hands about shoulder-width apart. Lean back with straight arms so that your body is at an angle to the ground. Keeping your elbows high and close to the bar, pull your upper body toward the bar by flexing your elbows, similar to a biceps curl. Lower yourself back down in a controlled manner. Keep your core tight and movement slow to maximize tension on the biceps.', null, null, 'wger', 'a94623fc-518f-4a74-947b-febd086264bf', 'CC-BY-SA 4', 'tenebrizz'),
  ('Glute Kickback (Machine)', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{}', 'Drive through your heel, not your toes, to hit the glute.

Don’t hyperextend your lower back at the top.', null, null, 'wger', '66ed6788-a1d8-49a2-af4d-397107fbf5fb', 'CC-BY-SA 4', 'barry'),
  ('Seated Row (Machine)', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Trapezius"}', '{}', 'Keep your chest up and squeeze your shoulder blades at the end.

Don’t hunch forward or round your back during the pull.', 'https://wger.de/media/exercise-images/1725/f0ebd44e-b8e1-400c-b598-ca371f3a07af.png', null, 'wger', '9bcc7b4f-4172-4db7-be95-d7b659c486f5', 'CC-BY-SA 4', 'barry'),
  ('Kettlebell sumo deadlift', 'hinge', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{}', '{"Kettlebell"}', 'Place your feet wider than shoulder-width apart, pointing your toes outward.
Keep your back straight, shoulders back, and chest up.
The knees must follow the same direction as the toes and not move forward.
When going up, it is advisable to contract your glutes to maximize the effectiveness of the exercise..', 'https://wger.de/media/exercise-images/1612/3dc33f57-2786-4305-8b91-e011d7055923.jpg', null, 'wger', '5cbaa028-114d-4a15-9a95-70d9b3146f30', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Rubber band glute kickback', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Resistance band"}', 'A rubber band glute kickback is an exercise performed on hands and knees, where you anchor a resistance band to your foot and kick your heel back and up, squeezing your glute at the top of the movement, while maintaining a stable core and flat back to target and strengthen the gluteal muscles.', 'https://wger.de/media/exercise-images/1613/a851fe9d-771f-44da-82f0-799e02ae3fd1.jpg', null, 'wger', '4221c8af-b3ca-4a53-9176-bd66e46d10f2', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Dumbbell donkey kick', 'squat', false, true, false, 'Legs', '{"Hamstrings","Glutes"}', '{}', '{"Dumbbell"}', 'The dumbbell donkey kick is an effective exercise for working the glute and hamstring muscles. This exercise is usually performed on all fours, using a dumbbell to add resistance. The steps for performing it correctly are described below.
Starting position: Get on all fours on a mat, with your hands aligned under your shoulders and your knees aligned under your hips.
Placing the dumbbell: Take a dumbbell and place it behind the knee of the leg you are going to lift. Make sure it is held securely to prevent it from falling during the exercise.
Exercise:
Inhale and, as you exhale, lift the leg with the dumbbell upward, keeping the knee bent at a 90-degree angle.
Raise the leg until it is parallel to the floor, feeling the contraction in the glutes.
Hold the position for one second at the top and then slowly lower the leg back to the starting position.
Repetitions: Perform 10 to 15 repetitions per leg, making sure to maintain good form throughout the exercise.
Sets: Complete 2 to 3 sets, depending on your fitness level.', 'https://wger.de/media/exercise-images/1616/97e6fd98-2ca6-486f-b9b2-f0499fe38044.jpg', null, 'wger', '2539f907-0c10-4af5-807c-48cd15fd0878', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Seated Dumbbell Calf Raise', 'isolation', false, true, false, 'Calves', '{"Calves"}', '{}', '{"Dumbbell"}', 'The seated dumbbell calf raise is a targeted exercise for strengthening the lower leg muscles. It follows the same movement pattern as the machine version: you place the weight on your knees, and by extending and flexing your ankles, you move the weight.', 'https://wger.de/media/exercise-images/1620/edd40e39-e337-4460-a8dd-6127d40ddd16.jpeg', null, 'wger', '6995c30a-037f-4de3-ac4a-45384a1f38f9', 'CC-BY-SA 4', 'AlucardEvil40'),
  ('Face pulls with yellow/green band', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{"Trapezius"}', '{"Resistance band"}', 'Face pulls with band – standing horizontal pull. Grab the band at face height, pull elbows high and wide towards your face while squeezing shoulder blades together. Trains upper back, rear shoulders and improves posture.', 'https://wger.de/media/exercise-images/1732/d13b9adb-968e-4f73-95e6-b16690bcf616.jpg', null, 'wger', '7bf4e131-d4a3-44c0-8fca-9e10002492e7', 'CC-BY-SA 4', '54str'),
  ('Isometric Squat to Failure', 'squat', false, true, false, 'Legs', '{"Glutes","Quads"}', '{}', '{"Bodyweight"}', 'sometric Squat to Failure: A Strength Training Technique

Definition

The isometric squat to failure is a variation of the squat exercise where you hold a static squat position at a specific angle, maintaining the position until your muscles can no longer sustain the contraction.', 'https://wger.de/media/exercise-images/1733/4ef77069-beb2-4504-a4f3-b181d5f35212.png', null, 'wger', '06cb77ba-e56d-4422-bc14-77cc367c9fd8', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Single-Leg Lunge with Kettlebell:', 'squat', true, true, true, 'Legs', '{"Calves","Glutes","Quads"}', '{}', '{"Kettlebell"}', 'How to do a single-leg kettlebell lunge

Preparation: Stand with your feet together. Hold the kettlebell with both hands by the handle, keeping it close to your chest, or hold it with one hand (on the same side as the working leg).

Step and Lower: Take a large step forward (or backward, which is safer for your knees) with one leg, lowering your hips until both knees form a 90-degree angle.

Focus: Shift your weight onto your front (or bent) leg, keeping your back straight and your torso upright.

Return: Push off with your front leg to return to the starting position.', 'https://wger.de/media/exercise-images/1734/782e2fbb-1267-476d-a817-14f3b83e0564.png', null, 'wger', 'ff6c2fb1-5105-49ba-babe-c0d403940269', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Single-leg side glute press', 'squat', true, true, true, 'Legs', '{"Calves","Glutes","Quads"}', '{}', '{"Incline bench"}', 'The Single-Leg Side Glute Press is a leg press machine variation where you angle your body sideways on the pad, placing one foot high and slightly angled to press the weight, powerfully targeting the outer glute (gluteus medius/minimus) and hamstrings for balanced leg development and stability, requiring focus on pushing through the heel and maintaining control without locking out.

How to Perform:

Setup: Sit in the leg press machine, rotate your body to one hip, placing one foot high on the platform at about a 45-degree angle with toes pointed slightly out/forward.

Positioning: Keep your hip, knee, and ankle aligned, and ensure your lower back stays on the pad.

Descent: Slowly lower the weight, allowing your knee to bend deeply (near 90 degrees), feeling a stretch in your glute and hamstring.

Press: Drive through your heel (not your toes) to press the weight back up, squeezing your glutes and hamstrings, stopping just before your leg fully extends.

Control: Avoid bouncing and don''t let your lower back lift off the pad; maintain tension throughout the movement.', 'https://wger.de/media/exercise-images/1735/43bca7d9-2333-43f3-8554-2d0b39fa2a07.png', null, 'wger', 'd28cf04f-4077-484b-82ed-abaea8d4053d', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Straight-Arm Pulldown (Cable)', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Keep arms straight but not locked, pulling with your lats, not your shoulders.

Don’t let your shoulders shrug up during the movement.', 'https://wger.de/media/exercise-images/1726/2e7e541b-5f55-405a-ae78-3e71b3f42db4.png', null, 'wger', 'a45123c6-34c2-43cf-b6bf-914a8f40995a', 'CC-BY-SA 4', 'barry'),
  ('Neutral-grip pull-ups or TRX rows', 'isolation', false, false, false, 'Arms', '{"Lats"}', '{"Biceps"}', '{"Pull-up bar"}', 'Pull-Up: Vertical Pull — Focuses more on the Lats (back width).

TRX Row: Horizontal Pull — Focuses more on the Rhomboids/Traps (mid-back thickness and posture).', 'https://wger.de/media/exercise-images/1738/0529acdf-ede8-42a2-a3e5-8d0c57b7a0e1.jpg', null, 'wger', '15fda45b-108b-4b28-bfe5-d0e55a0914bf', 'CC-BY-SA 4', '54str'),
  ('Machine Side Lateral Raises', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{}', 'Machine side lateral raises are an isolation exercise for the side (lateral) deltoids, performed on a machine for stability, targeting the outer shoulder by lifting pads or handles out to the sides to shoulder height, then lowering slowly, keeping elbows slightly bent and traps down to focus on the delts. This exercise helps build shoulder width by preventing swinging and providing constant tension, making it great for beginners or as a finisher.

How to Perform Machine Lateral Raises

Setup: Adjust the seat so your shoulders align with the machine''s pivot point, your chest is against the pad (or back if facing out), and your arms are at a 90-degree angle with the pads/handles.

Starting Position: Grip the handles with a relaxed grip, elbows slightly bent, and shoulders down (depressed) away from your ears.

Lifting Phase: Exhale and lift your arms out to the sides, moving your upper arms laterally, until they are parallel to the floor.

Peak Contraction: Pause briefly at the top, squeezing the side delts, but don''t shrug your shoulders up.

Lowering Phase: Inhale and slowly lower the weight back down with control, resisting the weight on the way down.', 'https://wger.de/media/exercise-images/1744/cb9263c4-39fc-4261-8d30-a5d6d57841c1.jpg', null, 'wger', 'dc87b735-016c-410b-915c-e3521fea4be7', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Side Straight-Arm Pulldown (Cable)', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Keep your torso still, pulling the handle down along your side using the outer lat.

Don’t twist your body or rotate your torso to cheat the rep.', null, null, 'wger', '0dd4dde7-9712-4c06-8ebe-16bc7a0b1917', 'CC-BY-SA 4', 'barry'),
  ('Smith machine squat', 'squat', false, true, false, 'Legs', '{"Glutes","Quads"}', '{}', '{}', 'Technique and Execution

The Smith machine squat is a variation of the traditional barbell squat that uses a guided, fixed-path barbell. Here''s a detailed breakdown of the proper technique:

Starting Position

Foot Placement: Position feet slightly forward of the bar, about shoulder-width apart

Bar Position: Rest the bar on your upper trapezius/shoulders, similar to a traditional back squat

Stance: Feet can be slightly angled outward for natural hip rotation

Squat Movement

Unrack the bar by rotating it to release from the safety hooks

Slowly lower your body by bending knees and hips

Descend until thighs are parallel to the ground (or slightly below)

Pause briefly at the bottom of the movement

Drive through your heels to return to the starting position

Benefits and Considerations

Advantages

Reduced Balance Requirements: Fixed bar path makes it easier for beginners

Controlled Movement: Less risk of improper form compared to free weight squats

Isolation: Allows focused leg muscle development', 'https://wger.de/media/exercise-images/1747/af9647dd-04ec-4adf-9c07-4e33edb77277.jpg', null, 'wger', 'f3ef220b-a070-449c-a463-876d30cd9b14', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Windshield Wipers', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{"Pull-up bar"}', 'Hang from a pull-up bar, raise your legs to the ceiling. Move lower body from left to right with straight legs like a windshield wiper', null, null, 'wger', '026d2939-9156-408b-bf11-21cfa8278851', 'CC-BY-SA 4', 'Happy'),
  ('Assisted chin-ups', 'pull_h', false, false, true, 'Back', '{"Biceps","Lats"}', '{"Brachialis","Trapezius"}', '{}', 'Chin-ups with machine assistance (counterweights)', null, null, 'wger', 'e4bbd8d8-20e1-4174-b785-2590d2a1a7ad', 'CC-BY-SA 4', null),
  ('Shrimp Squad', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings","Calves"}', '{"Bodyweight"}', 'Single leg squad where one leg is behind you.', null, null, 'wger', '43eeec70-df51-4cad-9bef-a35261b0caaf', 'CC-BY-SA 4', 'Happy'),
  ('L-Sit Pull-ups', 'isolation', false, false, true, 'Arms', '{"Lats"}', '{"Biceps","Brachialis","Abs"}', '{"Bodyweight"}', 'L-Sit Pull-ups train both upper body and core muscles.', null, null, 'wger', '547217ec-cb9e-4713-8bab-2d8bfb160667', 'CC-BY-SA 4', 'Happy'),
  ('Plank Reach', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Shoulders","Obliquus externus abdominis"}', '{"Bodyweight"}', 'Position your body in plank position, keeping your eyes on the ground. Raise one arm in front of you and return it. Repeat with the other arm. Raise and return slowly while keeping your body as still as possible.', null, null, 'wger', '12418067-6cb5-44db-8973-b5be25c0146b', 'CC-BY-SA 4', null),
  ('Chair dips', 'push_v', false, false, true, 'Shoulders', '{"Triceps"}', '{"Shoulders","Chest"}', '{"Bodyweight"}', 'Starting position:

Sit down on the front edge of a chair, back straight, hands holding the front edge. Still holding the edge of the chair, arms extended, lift your butt and walk forward slightly so that it is a few inches from the chair.

Steps:

Slowly lower your body, keeping the back straight, until your arms are at a right angle.

Raise your body again to the initial position, arms extended.

Repeat.', null, null, 'wger', 'aa22b0b7-795d-47a6-8c0b-fdd0f6b9c8fc', 'CC-BY-SA 4', 'tinman'),
  ('Unilateral Cable row', 'pull_h', true, false, false, 'Back', '{"Lats","Serratus anterior"}', '{}', '{"Bench","Cable machine"}', 'Put a vertical seated bench in front of the cable row machine.position it so that you can focus on one side, and then do slow pulls focusing on the lateral muscles and ensuring tention in those muscles when in a stretched position.', 'https://wger.de/media/exercise-images/1621/ca1bc68d-9c36-4dd3-8ec4-496c57b5c564.jpg', null, 'wger', 'c1a9297d-6786-45dc-9047-5539fb61db9c', 'CC-BY-SA 4', 'Rottekongen'),
  ('Shoulder Internal Rotation (Cable)', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'Keep your elbow tucked to your side like it''s superglued there.

Don’t rotate your torso — only your forearm should move.', null, null, 'wger', 'dadecc94-6322-4c66-93b5-9cb44ec79e46', 'CC-BY-SA 4', 'barry'),
  ('Shoulder External Rotation (Cable)', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'Keep elbow fixed at your side and rotate forearm outward smoothly.

Don’t let your wrist or elbow drift upward — stay in one plane.', null, null, 'wger', 'b283cd47-9a1c-4004-9bf5-220560ef0a16', 'CC-BY-SA 4', 'barry'),
  ('Side Lateral Raise (Cable)', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Lift with your elbows leading, not your hands.

Don’t shrug your shoulders; keep traps quiet.', null, null, 'wger', 'dba57084-d148-4b22-bb90-2fdd3a845ca4', 'CC-BY-SA 4', 'barry'),
  ('Front Raise (Cable)', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'Raise the handle in a slight arc with controlled movement.

Don’t swing your torso to start the rep.', null, null, 'wger', 'be9dfe16-9fc3-463d-a9cd-7aade27ef571', 'CC-BY-SA 4', 'barry'),
  ('Cable Front Raise with a small bar', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'The Cable Front Raise with a small bar isolates your anterior deltoids (front shoulders) by providing constant tension, requiring you to stand facing away from a low pulley, grab the bar with an overhand grip, and lift it in front of you to shoulder height with slightly bent arms, avoiding swinging and keeping your core tight for controlled movement up and down. Use a light-to-moderate weight, focusing on slow, controlled reps to feel the muscle work, not momentum.

How to Perform the Cable Front Raise (Bar)

Setup: Attach a small straight bar to a low cable pulley. Set the weight to a light or moderate setting.

Starting Position: Stand with your back to the machine, holding the bar with an overhand grip (palms facing down) at hip level, arms extended but not locked. Feet shoulder-width apart, core braced, shoulders back and down.

The Lift: Exhale and slowly raise the bar straight up in front of you, keeping a slight bend in your elbows, until your hands reach shoulder height (or slightly below).

The Hold: Pause briefly at the top, squeezing your front delts.

The Lower: Inhale as you slowly and controllably lower the bar back to the starting position, maintaining tension.', 'https://wger.de/media/exercise-images/1745/9c92843a-6b90-428b-a868-9af4b11bad38.jpg', null, 'wger', '6e03ecb3-6bfe-4b34-be9d-e5c33e820cc6', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Cable pull through', 'hinge', false, true, true, 'Legs', '{"Glutes"}', '{"Hamstrings","Calves","Quads","Soleus"}', '{"Cable machine"}', 'The Cable Pull Through is a lower-body exercise that targets the glutes and hamstrings using a "hip hinge" motion. To perform it, attach a rope to the lowest pulley setting, face away from the machine with the rope between your legs, and step forward to create tension. Keeping your back flat and knees slightly soft, push your hips backward as if trying to close a door behind you until you feel a deep stretch in your hamstrings.

To finish the rep, explosively drive your hips forward to return to a standing position, squeezing your glutes hard at the top. It is vital to remember that this is not a squat; your knees should not bend deeply, and your arms should remain straight and relaxed, acting only as hooks for the rope. This movement provides constant tension on the glutes while placing less stress on the lower back than a traditional deadlift.', null, null, 'wger', '821e289e-bd39-4410-b436-6f2a43bc3649', 'CC-BY-SA 4', 'manuher89'),
  ('Side lateral raise - Front (Cable)', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'in a cablerack do a side lateral raise with cable in front of you, with focus in tension on the back of your shoulder.', null, null, 'wger', '7f9c13ab-1718-4f8a-8636-232f05f5f640', 'CC-BY-SA 4', null),
  ('Side lateral raise - Back (Cable)', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'on a cable rack do a side lateral raise with the cable behind you. focus on tension in the front of the shoulder.', null, null, 'wger', '065ff3ca-a9e8-4339-997e-d65556d9ebf3', 'CC-BY-SA 4', null),
  ('Reverse crunch', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Lay down
Place your hands near your butt (often slightly in front or under or both)
Raise your legs, but about 70% of the way you should be able to also raise your pelvis
(optional/variable) Hold 1/2 seconds at the top
Go back to starting position', null, null, 'wger', '5d8d3581-bce5-4a28-868f-8b299eaedbdd', 'CC-BY-SA 4', 'eufvksruh'),
  ('Legend Incline Bench Press', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{}', 'incline bench press on LeverEdge machine.', null, null, 'wger', 'e4804b7c-50af-4947-821f-3750718ffe65', 'CC-BY-SA 4', null),
  ('Face Pulls (Bodyweight Doorframe/Towel)', 'pull_h', false, false, true, 'Back', '{"Shoulders","Trapezius","Triceps"}', '{}', '{"Bodyweight"}', 'Vasco custom face pull variation using doorframe or towel for rear delt development. Zero equipment. Part of Tuesday Pull day.', null, null, 'wger', '52093ce1-2544-4b48-ad15-6e02de9b576d', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Single-Leg Deadlift with Dumbbell', 'hinge', true, true, false, 'Legs', '{"Hamstrings","Glutes"}', '{}', '{"Dumbbell"}', 'Starting Position: Stand upright with a slight bend in your knees, holding a dumbbell in one or both hands. Shift your weight onto your supporting leg (e.g., your right leg) and lift your non-supporting foot slightly off the floor.

The Hinge: Keeping your back flat and core engaged, hinge at your hips, pushing your glutes backward. As your torso lowers, extend your non-supporting leg straight back behind you for balance, keeping your hips square to the floor. The dumbbell(s) should lower toward the ground along the line of your supporting leg.

Range of Motion: Continue lowering your torso until it is nearly parallel to the floor, or you feel an intense stretch in your supporting hamstring, ensuring your back remains neutral throughout the movement.

Return to Start: Pause at the bottom, then contract your glutes and hamstrings to slowly raise your torso back to the starting position. Your non-supporting leg should return in line with the supporting one.

Switch Sides: After completing your desired number of repetitions on one side, switch your weight and repeat the movement on the other leg.', 'https://wger.de/media/exercise-images/1736/aa724cc5-c485-4f3e-9d2a-0c6ae4baefbe.png', null, 'wger', 'a630de17-9170-434c-b486-96a6b8705506', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Single Leg Glute Bridge', 'hinge', true, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'A glute bridge, where you use just one leg at a time.', null, null, 'wger', '68f1efb8-e7d2-4a79-99bb-65f128e10a11', 'CC-BY-SA 4', 'Happy'),
  ('Machine Hip Abduction', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{}', 'Technique and Execution

Starting Position

Seated Positioning: Sit in the machine with back against the pad

Leg Placement: Inner thighs against the machine''s padded resistance points

Adjust Machine: Set seat position to align your hip joint with the machine''s pivot point

Movement Technique

Start with legs together or slightly pressed against the inner pads

Slowly push legs outward, spreading them apart

Move until maximum comfortable lateral range is reached

Pause briefly at the outer point of the movement

Slowly return to the starting position with controlled movement

Biomechanical Breakdown

Muscle Engagement

Primary Activation: Gluteus Medius (side hip muscle)

Stabilization: Engages core and lower back muscles

Functional Movement: Mimics lateral leg movement used in walking, sports, and daily activities

Benefits

Strength and Stability

Improves Hip Stability

Reduces Risk of Knee Injuries

Enhances Lateral Movement Capabilities

Targets Often-Neglected Muscle Groups', 'https://wger.de/media/exercise-images/1748/923a3ff7-c269-49bd-9f03-697151a40f06.jpg', null, 'wger', 'b5726562-82ed-451a-89d8-8c8b13c5019a', 'CC-BY-SA 4', 'Tierrasverdes'),
  ('Deficit Push ups', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Bodyweight"}', 'Pushup on blocks or grips, so you can dip lower than the hands in the decent.', null, null, 'wger', 'b7dd3766-f660-45dc-bbe1-10e15e2f7cee', 'CC-BY-SA 4', 'Rottekongen'),
  ('Frog Stretch', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Get on your hands and knees.
Widen your knees outwards, and drop to your elbows.
Without moving your elbows or knees, start to rock forwards and backwards, trying to get your bum closer to your feet.', null, null, 'wger', 'a37001e9-b4b3-45db-8ee3-046f40350efa', 'CC-BY-SA 4', 'Croak6728'),
  ('Landmine Rotation', 'isolation', false, false, true, 'Abs', '{"Obliquus externus abdominis"}', '{"Shoulders","Abs"}', '{"Barbell"}', 'Start with landmine barbell straight up by using your shoulders to push it up above you. Then, from that position, bring it your side to target your abdominals and return to starting position.', null, null, 'wger', '73c1e130-fba9-473b-a093-a5712e2ae34d', 'CC-BY-SA 4', 'aboksz'),
  ('Floor Glider Hamstring Curls', 'push_v', false, false, true, 'Shoulders', '{"Hamstrings"}', '{"Calves","Glutes"}', '{}', 'Lie on back with heels on floor gliders or towels. Lift hips into a bridge, then slide heels toward glutes while keeping hips elevated. Slowly return to the starting position while maintaining the hip bridge.', null, null, 'wger', 'd6b2ac1d-4363-45e9-8fdb-9fba0a47b27d', 'CC-BY-SA 4', null),
  ('Double-Leg Abdominal Press', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Gym mat"}', 'Lie on your back with knees and hips bent at 90 degrees (tabletop).

Place your hands on your thighs just above your knees. Push your hands against your knees as hard as possible while using your abs to pull your knees toward your hands.

Hold for 10 seconds of maximum effort. Your abs should be shaking.', null, null, 'wger', 'f0823bb5-3f18-48d4-98de-cbe38f9fd8ff', 'CC-BY-SA 4', 'beagle'),
  ('Suitcase Carry', 'carry', true, false, true, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs","Trapezius"}', '{"Dumbbell"}', 'Walk forward and backward with holding dumbbell on one side without leaning to counter the weight.', null, null, 'wger', 'b6c19c36-34be-4d9f-8c07-8bdf9ab3ba1a', 'CC-BY-SA 4', 'aboksz'),
  ('Supino inclinado', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{}', 'Inclinado 90 graus e movimentos leves e precisos', null, null, 'wger', '86237d20-f4e3-49a6-bf28-9e4660377bc9', 'CC-BY-SA 4', null),
  ('Unilateral cross body cable pull down', 'pull_v', true, false, false, 'Shoulders', '{"Lats"}', '{"Shoulders"}', '{"Cable machine"}', 'on a cable rack place cable high, and with a straight arm pull that cable across you from high to low. focus on tension in back shoulder.', null, null, 'wger', 'd788811b-be46-485a-b8a0-0d9ba7f4cf85', 'CC-BY-SA 4', null),
  ('Behind the Back Cable Lateral Raise', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Trapezius"}', '{"Cable machine"}', 'Lateral raises have long been a staple for building capped delts, and lifters use everything from dumbbells and bands to machines and single-arm variations to make them grow.', null, null, 'wger', '57018827-f344-4627-88e5-03e4f2f49859', 'CC-BY-SA 4', 'LEBRERO'),
  ('High-Cable Lateral Raise', 'push_v', false, false, true, 'Shoulders', '{"Shoulders"}', '{"Lats","Serratus anterior"}', '{"Cable machine"}', 'Stand next to a cable machine with the pulley set to waist height.

Grab the opposite-side handle with the hand farthest from the
pulley, keeping your palm facing in.

Keep your core engaged, chest lifted, and shoulders relaxed. Maintain a slight bend in the elbow throughout the lift.

Lift your arm out to the side until your elbow reaches shoulder height, keeping your wrist aligned with your elbow.

Briefly pause at the top, then slowly lower the handle back to your side with control. Repeat for the desired reps.', null, null, 'wger', '47b244f0-ebc6-4498-9d9f-7e7bff47322e', 'CC-BY-SA 4', 'Deflation'),
  ('DB Hammer Curls (5kg)', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Dumbbell"}', 'Vasco custom single-arm hammer curl for 5kg dumbbell. Targets brachialis for arm thickness. Part of Tuesday Pull day.', null, null, 'wger', '6e5e15f0-5722-46d6-ad89-719c581da436', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Trap Bar Squat', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Hamstrings"}', '{}', 'A combination of squat and deadlift principles with the use of a hex/trap bar, easing stress on the lower back by better centering the weight.', null, null, 'wger', 'd18407c2-75d0-43d8-8bbc-dfbb256b6b2f', 'CC-BY-SA 4', 'kmcalderwood'),
  ('Ankle dorsiflexion rocks', 'squat', false, true, false, 'Legs', '{"Calves","Soleus"}', '{}', '{"Bodyweight"}', 'Move your knee forward, keeping your heel on the ground. Hold the position for a couple of seconds and return to the starting position.', 'https://wger.de/media/exercise-images/1804/691c69b8-c3db-4177-8435-dd3a97d88542.webp', null, 'wger', 'fa5252d3-973c-4b35-9324-a02460545283', 'CC-BY-SA 4', 'Davidgj32'),
  ('Parallel Bar Hold', 'isolation', false, false, true, 'Arms', '{"Shoulders","Chest","Triceps"}', '{"Lats","Obliquus externus abdominis","Abs"}', '{}', 'Stand between a set of parallel bars.
Place your hands, knuckles outwards, on the bars.
Push down on your hands to lift yourself off the floor.
Hold yourself in this position with your arms straight for the required time.', null, null, 'wger', '934856f3-6eb3-4b37-9536-0ff67a6aa036', 'CC-BY-SA 4', 'Croak6728'),
  ('Reverse Hyperextension', 'hinge', false, true, false, 'Legs', '{"Hamstrings","Glutes"}', '{}', '{"Bench"}', 'Lie face-down on a bench with your legs hanging off the edge.

Bend your hips so your thighs are vertical, bending your knees at the same time so your shins stay horizontal.
Straighten out your legs so they are not bent and your toes are pointing backwards horizontally.
Return to the original position, and repeat.', null, null, 'wger', '682ea312-af02-450a-9880-fea7bf8e854a', 'CC-BY-SA 4', 'Croak6728'),
  ('Sphinx', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Lie on your stomach flat, legs extended and the backs of your feet on
the ground. Bring your forearms under your shoulders, elbows directly
underneath. Then press your hands into the floor to lift your chest.
Draw your shoulder blades together, open your collarbones, and direct
your gaze forward, while keeping the lower back relaxed.', null, null, 'wger', '23d2b2ce-4ae7-441a-a122-9f6784f15aa6', 'CC-BY-SA 4', 'Joculari'),
  ('Dumbell Tate Press', 'isolation', false, false, true, 'Arms', '{"Triceps"}', '{"Shoulders","Chest"}', '{"Bench","Dumbbell"}', 'Set Up: Lie flat with a dumbbell in each hand. Extend your arms straight up over your chest as if you were at the top of a dumbbell bench press
Starting Position: Position the dumbbells so they are touching or very close together with a pronated grip (palms facing your feet and thumbs facing each other)
Lowering: Without moving your upper arms or shoulders, bend your elbows and flare them outward to the sides. Lower the inner ends of the dumbbells toward the center of your chest
Touch and Pause: Gently touch the dumbbells to your chest. Do not rest the weight on your body; maintain constant tension in your triceps
Press: Forcefully extend your elbows to return the dumbbells to the starting position. Focus on "pushing your pinkies toward the sky" to maximize triceps engagement

https://www.youtube.com/watch?v=IgSjoXbpy1M&t=2', null, null, 'wger', '2affa71f-7308-4448-af57-dc44b424090e', 'CC-BY-SA 4', 'beagle'),
  ('Chest-Supported Rear Delt Raise', 'pull_h', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Trapezius"}', '{"Bench","Dumbbell"}', '"The Y"Position: Set an incline bench to 30-45 degrees. Lie face-down with your chest supported, keeping your head neutral or looking slightly down to avoid neck strain.Grip: Hold light dumbbells with a neutral or thumbs-up grip (thumb pointing to the ceiling).Movement: With straight or slightly bent elbows, raise the dumbbells up and out in a "Y" shape. Focus on moving the shoulders and shoulder blades rather than just lifting the arms.Top Position: Squeeze the shoulder blades together and reach high, ensuring the arms are angled to form a "Y".Control: Lower the dumbbells slowly to the starting position.', null, null, 'wger', '25cbc266-aa84-44f5-989b-53c9cc8fdc77', 'CC-BY-SA 4', 'beagle'),
  ('Band pull-apart with external rotation', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Resistance band"}', 'Stand tall with your feet shoulder-width apart, chest out, and shoulders back.

Hold the resistance band with both hands, palms facing up or facing each other, depending on the band type.

Bend your elbows at a 90-degree angle and glue your upper arms to your sides.

The band should have some tension in the starting position, with your hands closer together in front of your stomach.

Rotate Outward: While keeping your elbows tucked into your sides, slowly move your hands away from each other, stretching the band.

Squeeze: Squeeze your shoulder blades together and down as you rotate your hands outward.

Range of Motion: Rotate your hands as far outward as you comfortably can without allowing your elbows to leave your sides.

Hold: Hold the end position for 1–2 seconds to maximize muscle engagement.

Return: Slowly and with control, bring your hands back to the starting position.', null, null, 'wger', '83650b79-add8-4846-b114-b4f28d96495a', 'CC-BY-SA 4', 'beagle'),
  ('Abdominal Draw-In', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Lie
on your back with knees bent. Gently pull your belly button toward your
spine without moving your hips or holding your breath.', null, null, 'wger', '793b0e5f-8dea-48a6-84c8-9123b59c2721', 'CC-BY-SA 4', 'beagle'),
  ('Landmine Squat to Press', 'squat', false, true, true, 'Legs', '{"Shoulders","Glutes","Quads"}', '{"Hamstrings","Abs"}', '{"Barbell"}', 'Bar Position: Anchor one end of a barbell in a landmine attachment or a secure corner.
Stance: Stand facing the barbell with feet slightly wider than shoulder-width. Turn your toes out 10–35 degrees to allow for better pelvic movement and depth.
Grip: Cup the free end of the barbell with both hands (fingers interlaced or overlapping) and hold it at mid-chest level, just below the collarbone.

Descent: Brace your core and sit back into a squat, keeping your chest up and weight on your heels.
Depth: Lower until your thighs are at least parallel to the floor. A good reference is when your elbows touch the tops of your thighs or just inside your knees.
Posture: Ensure your back remains flat and your spine neutral throughout the movement.

Drive: Powerfully drive through your heels to stand up. Use the momentum from your legs to "thrust" the weight upward.
Extension: In one fluid motion, press the bar overhead until your arms are fully extended. At the top, your biceps should be near your ears.
The "Lean": As you reach the top of the press, lean slightly forward into the bar to encourage proper upward rotation of the shoulder blades and avoid lower back arching.

Slowly lower the barbell back to chest height in a controlled manner before immediately beginning the next repetition.', null, null, 'wger', '67bca611-d9f1-4855-9e02-ecc8d7d688e9', 'CC-BY-SA 4', 'beagle'),
  ('Barbell Step Back Lunge', 'squat', true, true, false, 'Legs', '{"Quads"}', '{}', '{"Barbell"}', 'Step 1: Stand with your feet hip-width apart, holding a barbell on your upper back.
Step 2: Keep your back straight, chest up, and core engaged.
Step 3: Take a step back with one leg and lower your body by bending both knees. Ensure that your back knee nearly touches the ground.
Step 4: Push off your back foot to return to the starting position.
Step 5: Repeat the movement with the other leg.
Continue alternating between legs for the desired repetitions.', 'https://wger.de/media/exercise-images/1830/3b6c547c-ab3d-4472-93cf-561710279eab.jpg', null, 'wger', '928eeae3-d849-4605-a470-048ca259a8c5', 'CC-BY-SA 4', null),
  ('Hammerstrength Decline Chest Press', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{}', 'Sit upright in a hammerstrength decline chest press machine while squeezing your shoulder blades together and placing your heels firmly on the ground underneath your knees.
The back pad should be contact with your head, shoulders, and butt at all times.
Grab ahold of the handles with an overhand grip just outside shoulder-width apart just below your chest.
Keeping your core braced by breathing into your stomach and flexing the abdominal muscles, push through your palms to extend your elbows while keeping them at a 45 degree angle from your torso.
Once your arms are fully extended, return to the starting position.', 'https://wger.de/media/exercise-images/1831/2d9d509f-707b-4132-961e-91a2459ca198.jpg', null, 'wger', '920692b2-0842-428a-b925-ba0daf6b41db', 'CC-BY-SA 4', null),
  ('Trap-3 Raise', 'pull_h', false, false, false, 'Back', '{"Trapezius"}', '{}', '{"Bodyweight"}', 'Hinge forwards and bend your knees slightly. Depress and retract the shoulder you will use. Rest the other hand on your knee.
Raise your hand about 15 degrees overhead, maintaining the position of your shoulder.', null, null, 'wger', '62f90b5c-7451-4fd0-91ae-4dd93c51aa41', 'CC-BY-SA 4', 'Croak6728'),
  ('External Rotation Stretch', 'push_v', false, false, false, 'Shoulders', '{"Shoulders","Trapezius"}', '{}', '{"Barbell"}', 'Sit with your feet pressed against each other, and one knee raised all the way out to the side of your body.
Place your elbow on your raised knee, bend it at 90 degrees, and point your hand directly forward, holding your barbell/dumbbell.
Keep your shoulder depressed and retracted, raise your hand until your forearm is vertical, as if you were about to wave at someone like a robot.
Lower your hand to the original position and repeat.', 'https://wger.de/media/exercise-images/1835/ca4a0b7e-9fdd-4173-843a-f0392824abe1.jpg', null, 'wger', 'a4413bcc-dcd1-4332-a09a-fee94a265e22', 'CC-BY-SA 4', 'Croak6728'),
  ('Banded Shoulder Drills', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Chest","Trapezius"}', '{}', '{"Resistance band"}', 'Attach a resistance band to something solid behind you. Stand away from it, holding it in your hand so it is taut.
See the attached youtube video: https://www.youtube.com/watch?v=zdwEWchSjrI .', null, null, 'wger', '4c317795-c301-4081-9f96-6036682f80c1', 'CC-BY-SA 4', 'Croak6728'),
  ('Seated Shoulder Extension Stretch', 'push_v', false, false, false, 'Shoulders', '{"Lats","Chest"}', '{}', '{"Bodyweight"}', 'Sit with your hands behind you, shoulder width apart.
Lock your elbows.
Scoot your feet and hips out forwards, lowering your shoulders down towards ground.
Go as far as possible to obtain a good stretch.

See the video: https://www.youtube.com/watch?v=ihUAbG0e8zw', null, null, 'wger', 'a00b852c-0d2b-4b4a-bbc2-ef538f211b6c', 'CC-BY-SA 4', 'Croak6728'),
  ('Horse Stance (Side Splits)', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Stand as for a squat, with your feet wide and your toes pointed slightly outwards.
Gently squat into a deep, wide squat - your hips should be below your knees.
Hold for 3 to 5 seconds.
Come up under control, and repeat as needed.', null, null, 'wger', '36411665-4a87-4ab5-b5d3-e4eaa2802a62', 'CC-BY-SA 4', 'Croak6728'),
  ('Calves foam roller', 'squat', false, true, false, 'Legs', '{"Calves"}', '{}', '{"Bodyweight"}', 'Move your calves slowly over the foam roller', 'https://wger.de/media/exercise-images/1854/ccd3c18e-c864-426f-8176-15dce14305e3.webp', null, 'wger', '05b36227-a331-45b8-b1d5-5c7293c2df17', 'CC-BY-SA 4', 'Davidgj32'),
  ('Foam Roller Iliotibial band', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{"Bodyweight"}', 'Slide on the Foam Roller over your iliotibial band. Is english terrible checker', 'https://wger.de/media/exercise-images/1857/92291128-cc7e-4f70-9663-80840c516fc9.jpg', null, 'wger', '4d96e62c-e4ac-45be-9428-b97f18ca26d9', 'CC-BY-SA 4', 'Davidgj32'),
  ('Foam Roller quadriceps', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{"Bodyweight"}', 'Slide the Foam Roller over your quadriceps. Is english, please', 'https://wger.de/media/exercise-images/1858/058b6fdb-8093-4b6d-a504-cbf869f3e3d3.jpg', null, 'wger', 'b8ffa641-55e7-4761-ad5d-8336bb3ab3d4', 'CC-BY-SA 4', 'Davidgj32'),
  ('Foam Roller Gluteus', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Slide on the Foam Roller over your gluteus. Is english please', 'https://wger.de/media/exercise-images/1859/2465d5eb-c249-454d-93eb-58aa13bdc080.webp', null, 'wger', '164a31e9-ce70-4339-aee5-4ea7a3bdd246', 'CC-BY-SA 4', 'Davidgj32'),
  ('Banded Scapular Retraction', 'pull_h', false, false, false, 'Back', '{"Shoulders","Trapezius"}', '{}', '{"Resistance band"}', 'Attach one end of resistance band to wall/upright/... at shoulder height. Insert arm into the loop, at the tricep. Step back until band is pulled straight. Pull back elbow and shoulder against the resistance of the band.', null, null, 'wger', 'add364ed-4444-4752-9a22-d85d58199fe5', 'CC-BY-SA 4', 'hurr99'),
  ('Incline DB Y-Raise', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Trapezius"}', '{"Dumbbell"}', 'Set
an incline bench to a 45-degree angle and sit facing the bench, chest
against the pad, with a dumbbell in each hand, palms facing each other.
Position your feet firmly on the ground for stability and let your arms hang down naturally with a slight bend in your elbows.
Engage your core and keep your back straight throughout the movement.
Raise your arms forward and out to form a Y shape, keeping the movement controlled and your elbows slightly bent.
Lift until your arms are roughly parallel to the floor and in line with your ears.
Pause
briefly at the top of the movement to engage your shoulder muscles
fully, then slowly lower your arms back down to the starting position.
Ensure
the movement is slow and controlled during both the ascent and descent
to maximize engagement of the deltoids and supporting muscles.
Repeat for the desired number of repetitions, maintaining proper form throughout.', null, null, 'wger', '16bd91ca-a9fe-47fc-b3a8-a9d70549e929', 'CC-BY-SA 4', 'Deflation'),
  ('Clamshell', 'isolation', false, false, false, 'Abs', '{"Glutes","Abs"}', '{}', '{"Bodyweight"}', 'Position
Side plank with the elbow and the forearm on the ground and the legs slightly bent.

Execution
Lift your upper knee while keeping your feet close together, like a “shell opening,” then slowly return to the starting position. Keep your core stable and your hips aligned.', null, null, 'wger', 'ca3ca5d0-5231-4420-ad06-fa3d32693a1b', 'CC-BY-SA 4', 'teus_ergaster'),
  ('Banded Clamshell', 'squat', false, true, true, 'Legs', '{"Glutes","Abs"}', '{"Quads"}', '{"Resistance band"}', 'Position
Side plank with the elbow and the forearm on the ground and the legs slightly bent. Stretch a doubled-up resistance band between your thighs, just above the knee.

Execution
Lift
your upper knee while keeping your feet close together, like a “shell
opening,” then slowly return to the starting position. Keep your core
stable and your hips aligned.', null, null, 'wger', '8cc84753-e638-4c43-91c6-51c097813ca4', 'CC-BY-SA 4', 'Croak6728'),
  ('Standing Pancake Good Morning', 'hinge', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Bodyweight"}', 'Stand with your feet wider than shoulder-width apart and toes pointed slightly outward. Place your hands on the back of your head. Hinge at your hips and lower your upper body towards the ground, keeping your back straight and chest open.', null, null, 'wger', 'aa3c2791-74f7-4fed-a812-297ff454e2f9', 'CC-BY-SA 4', 'captive0592'),
  ('Seated Pancake Good Morning', 'hinge', false, true, false, 'Legs', '{"Glutes"}', '{}', '{"Bodyweight"}', 'Sit with your legs completely straight (knees locked), spread wide in a straddle position.
Place your hands on the back of your neck.
Hinge your torso and head towards the floor.', null, null, 'wger', '96583e33-e643-486d-95e9-67d0d5935b05', 'CC-BY-SA 4', 'Croak6728'),
  ('Shinbox IR Stretch', 'squat', false, true, false, 'Legs', '{"Glutes","Obliquus externus abdominis"}', '{}', '{"Bodyweight"}', 'Starting Position: Sit on the floor with both hips and knees bent at 90-degree angles.
Leg Placement:
Place one leg in front of you (external rotation) and the other leg out
to the side/behind you (internal rotation). The shins and knees should
remain flat on the ground.
The Movement:
Keeping your hips square, hinge your torso forward or tilt it laterally
(side-to-side) toward the front leg to deepen the stretch.
Target Areas:
Stretches the glutes and piriformis (front leg) and the hip flexors and
quads (back leg). Engages the core and obliques during lateral flexion.
Goal: Improves hip mobility, specifically internal and external rotation, and relieves lower back tension.', null, null, 'wger', 'ceb58be5-2927-48c5-bb2d-4cc42b0a60e2', 'CC-BY-SA 4', 'teus_ergaster'),
  ('YTWL Exercise', 'push_v', false, false, false, 'Shoulders', '{"Shoulders","Trapezius"}', '{}', '{"Dumbbell","Incline bench"}', 'Purpose: Improves shoulder stability, posture, and scapular (shoulder blade) control. Often used in physical therapy and warm-ups.
Starting Position:
Stand with feet shoulder-width apart. Hinge forward at the hips (like a
deadlift) keeping your back flat, or lie face down on an incline bench.
Keep your thumbs pointing up throughout.
Y (Arms up):
Extend both arms straight forward and upward at a 135-degree angle from
your body, forming a "Y". Squeeze your shoulder blades together at the
top.
T (Arms out): Open your arms straight out to the sides, perpendicular to your body, forming a "T". Focus on pinching your shoulder blades.
W (Arms bent): Pull your elbows back, bending them to 90 degrees, and squeeze your shoulder blades to form a "W". Keep your wrists firm.
L (Arms rotated):
Start with elbows bent at 90 degrees and close to your body. Rotate
your forearms outward (external rotation) like a goalpost, forming an
"L" or a gate.
Key Focus:
Movements should be slow and controlled. Always lead with the thumbs
and think about moving the shoulder blades, not just the arms.', null, null, 'wger', '5986cd29-11ff-43f4-af65-fc48dec62156', 'CC-BY-SA 4', 'teus_ergaster'),
  ('Supine Hip Abduction', 'squat', false, true, false, 'Legs', '{"Glutes","Quads"}', '{}', '{"Dumbbell"}', 'Starting Position:
Lie on your back (supine) on a mat, with your legs extended and
relaxed. Arms can be placed alongside your body or out to the sides for
stability.
The Movement:
Slightly lift one leg off the floor (keeping it straight or with a
slight bend). Move it laterally outward, away from the other leg, as if
stepping over a small obstacle.
Range of Motion:
Move the leg as far as comfortable without lifting your pelvis or
rotating your torso, feeling a stretch in the inner thigh and hip.
Return: Slowly bring the leg back to the starting position with controlled movement.
Goal: Improves lateral hip mobility (abduction) and strengthens the pelvic stabilizer muscles.', null, null, 'wger', '2fe15ae4-085b-4116-8d73-2a120cc2a231', 'CC-BY-SA 4', 'teus_ergaster'),
  ('Dumbbell snatch', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{}', '{"Dumbbell"}', 'Key Steps to Execute Correctly:

Setup: Place the dumbbell between your feet, with your shoulders above your hips, chest up, and back flat.

The Pull: Explosively extend your hips, knees, and ankles (triple extension) to drive the dumbbell upward, keeping your elbow high and the dumbbell close to your body.

The Catch: Quickly flex your hips and knees to drop under the dumbbell and receive it overhead with your arm locked in position, landing in a half-squat stance.

Common Mistakes: Using your arms too much to lift the weight instead of your legs, having a low elbow during the pull phase, and misaligning your shoulder, elbow, and wrist in the final position. For beginners, it’s recommended to start with light loads, focus on technique, and perform 3 to 5 sets of 3 to 5 reps per arm.', 'https://wger.de/media/exercise-images/1947/4201a9c0-f9e4-48ca-80f1-b46c7ffe5640.webp', null, 'wger', '51fe0871-1390-4755-bd04-01a93e32f533', 'CC-BY-SA 4', 'Aleid'),
  ('1 Leg Box Squat', 'squat', false, true, false, 'Legs', '{"Hamstrings","Quads"}', '{}', '{"Bodyweight"}', 'This exercise requires a sturdy box or a chair. Simple stand ~6 inches in front of it and balance yourself on one leg. From here, begin squatting down in a smooth controlled motion while keeping your other leg straight out in front of you for balance. Slowly sit down on the box, pause for a 1 count and push back up with the working leg, while never letting your other leg touch the ground.', null, null, 'wger', 'c463f618-2777-4836-9c57-92a46d87cf1b', 'CC-BY-SA 4', 'jesusd'),
  ('Overhead Barbell Press', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Barbell"}', 'Setup: Stand with feet together and grip the bar slightly wider than shoulders.
Position: Rest the bar on your upper chest.
Press: Brace your core and push the bar straight up until your arms lock out.
Finish: Control the bar back down to your chest.
https://youtu.be/ZXpdJOLNoWw?si=u27cGyODoblXHBu1', 'https://wger.de/media/exercise-images/1893/7dbad19e-0616-41fd-9d7d-3e21649c0eea.png', null, 'wger', '2500c212-6f14-4a8d-a997-04e9e7c04116', 'CC-BY-SA 4', 'nishant0712'),
  ('Clean and Press', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Quads"}', '{"Barbell"}', 'The First Pull: Lift the bar from the floor to knee-height by driving with the legs, keeping the angle of your back constant.
The "Power" Position: As the bar reaches mid-thigh, explosively shrug and extend your hips to create vertical momentum.
The Quick Elbow Turnover: In the catch phase, rotate your elbows rapidly under the bar to create a "shelf" on your front deltoids.
The Vertical Press: Press the bar in a straight line; your head should shift slightly forward once the bar clears your forehead to reach full lockout.', 'https://wger.de/media/exercise-images/1901/046f0f42-0ed5-48c5-a9ee-41de25e3b6a0.png', null, 'wger', '2a125f64-1d10-4926-95ad-33a48e61b3d6', 'CC-BY-SA 4', 'nishant0712'),
  ('Weighted push-ups', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Bodyweight"}', 'Setup: Begin in a standard plank position with a weight plate balanced securely on your upper back.
Alignment: Maintain a straight line from your head to your heels, engaging your core to prevent your back from sagging.
Execution: Lower your body until your chest nearly touches the floor, keeping your elbows at a forty-five degrees.
Ascent: Press through your palms to return to the starting position, fully extending your arms.', 'https://wger.de/media/exercise-images/1902/d0c3f170-543c-4be4-bc70-5c6dc606406c.png', null, 'wger', '37abbe32-2fab-4818-8355-fffcff2dc3e3', 'CC-BY-SA 4', 'nishant0712'),
  ('Pec Deck', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{}', 'Pectoral issolation exercise - full range of motion is best with full contraction and slow negative', null, null, 'wger', '71b9da1a-ac07-49c8-8b2d-7179032181fd', 'CC-BY-SA 4', null),
  ('Hip Bridge', 'squat', false, true, true, 'Legs', '{"Glutes","Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Get into bridge position, balance yourself on heels and start extending legs unilaterally.

Keep hip extended as much as possible.', null, null, 'wger', '6b127132-cc0b-4b40-ac8c-177a28ccb6e2', 'CC-BY-SA 4', 'cybro'),
  ('Unilateral Lunges', 'squat', true, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{"Bodyweight"}', 'No stops during movement, hands on the hips.', null, null, 'wger', '2dd1cf54-b8e3-4769-9455-48120d7cc427', 'CC-BY-SA 4', 'cybro'),
  ('Butterfly Superman', 'pull_h', false, false, false, 'Back', '{"Trapezius"}', '{}', '{"Bodyweight"}', 'Lie on stomach, intertwine fingers behind the head and start raising your head and raise elbows as far as they go.', null, null, 'wger', 'de06856d-109d-4bef-acab-0918028cea36', 'CC-BY-SA 4', 'cybro'),
  ('Leg Wheel', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'Lay on the back and lift legs in perpendicular fashion, keeping the knees together.

Start making small circles in one direction with both of your knees with very small range of motion, focusing on abs and keeping your back in contact with the floor.', null, null, 'wger', '19d10f51-3e53-4d8f-b283-1d8d9a7d3543', 'CC-BY-SA 4', 'cybro'),
  ('Kneeling Superman', 'pull_h', false, false, true, 'Back', '{"Hamstrings","Trapezius"}', '{"Abs"}', '{"Bodyweight"}', 'Push one foot back until leg fully extended, concentrating on the having the foot high and pushed back as if pulled.

Extend arm forward with focus having the shoulder high up.

Unilateral and static hold.', null, null, 'wger', '00f4a2b1-b1ac-49e6-a657-1d27e46522fd', 'CC-BY-SA 4', 'cybro'),
  ('Cat Plank', 'squat', false, true, true, 'Legs', '{"Quads","Abs"}', '{"Shoulders"}', '{"Bodyweight"}', 'On your fours and raise the knees of the floor ever so slightly. 
Curl your back out and push back from your shoulders as to resemble a cat making itself look large.', null, null, 'wger', 'b02825ca-bbe4-4a07-a162-2b7a6c0a662b', 'CC-BY-SA 4', 'cybro'),
  ('Core Rotation', 'isolation', false, false, true, 'Abs', '{"Quads","Abs"}', '{"Obliquus externus abdominis","Serratus anterior"}', '{"Bodyweight"}', 'Sit back, raise feet above the ground with knees bent and start rotating left and right with hands touching the ground every move.', null, null, 'wger', '1b140999-e1fa-49b5-9f2b-690bac959db3', 'CC-BY-SA 4', 'cybro'),
  ('Unilateral Hip Thrust', 'hinge', true, true, false, 'Legs', '{"Glutes"}', '{"Abs"}', '{"Bodyweight"}', 'Extend one leg while laying down and start raising your body with one leg touching the ground through the heel.', null, null, 'wger', '139e3d1a-ccd5-46cd-b953-8db6cea7b005', 'CC-BY-SA 4', 'cybro'),
  ('Isometria alle parallele', 'push_v', false, false, false, 'Shoulders', '{"Chest","Trapezius"}', '{}', '{}', 'The parallel bars isometric hold is a static upper-body exercise performed on dip bars (parallel bars). Instead of moving up and down like in a traditional dip, you hold a fixed position under tension.', null, null, 'wger', '7a1e0cd7-0076-4d4d-b05f-1d114235f199', 'CC-BY-SA 4', null),
  ('Tuck planche', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Abs","Serratus anterior"}', '{"Obliquus externus abdominis","Chest","Triceps"}', '{"Bodyweight"}', 'Basic calisthenics progression for the full planche', 'https://wger.de/media/exercise-images/1916/e7d97b4b-9fe4-4378-aea3-5a9d93b6eb8d.png', null, 'wger', '3e9973f6-c218-4dd4-850b-da6f4f1622bb', 'CC-BY-SA 4', 'ISSACS'),
  ('Barbell Silverback Shrug', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{}', '{"Barbell"}', 'Stand with your feet shoulder width apart holding the barbell with both hands in front just past shoulder width.
Bend forward at the hips with a slight bend in your knees, keeping your back straight.
Engage your shoulder blades, as if you are trying to touch them together.
Release the shrug.
Description taken from MuscleWiki', null, null, 'wger', '64b50772-c73d-4833-8518-947a648fa623', 'CC-BY-SA 4', null),
  ('Wide-grip Pulldown', 'pull_v', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Brachialis","Serratus anterior","Trapezius"}', '{"Cable machine"}', 'Starting position:

Arms extended overhead, feeling a stretch in your lats.
Keep your shoulders depressed (don’t shrug upward).

Pulling phase (concentric):

Pull the bar down to your upper chest or collarbone area by driving your elbows down and back.
Keep your chest lifted and squeeze your shoulder blades together at the bottom.', null, null, 'wger', '55b9d286-c4cc-4a29-97ad-58cb13c2bb7e', 'CC-BY-SA 3', 'tuckerm'),
  ('Inverted Lat Pull Down', 'pull_v', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Biceps","Brachialis","Obliquus externus abdominis","Abs","Serratus anterior"}', '{"Pull-up bar"}', 'The Inverted Lat Pull Down (most commonly known as the Reverse Grip Lat Pull Down) is a variation of the standard exercise that uses an underhand (supinated) grip with hands at shoulder-width. This position shifts more emphasis to the lower lats and increases biceps involvement, often allowing for a greater range of motion and a deeper squeeze at the bottom of the movement.', null, null, 'wger', '1639425c-7dc6-4776-b039-47ef14a328ee', 'CC-BY-SA 4', 'amaesc'),
  ('Assisted Pull-Up', 'pull_v', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Shoulders","Biceps","Abs","Serratus anterior"}', '{"Resistance band"}', 'The Assisted Pull-Up is a compound vertical pulling exercise performed on a machine with a counterweight platform or by using resistance bands. It mimics the mechanics of a standard pull-up but reduces the total weight you have to lift, making it an excellent tool for building functional strength and perfecting your technique.', null, null, 'wger', '8bc4c616-e76b-4291-9074-186ecbbb3cfd', 'CC-BY-SA 4', 'amaesc'),
  ('Tricep Rope Pushdowns', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{"Lats"}', '{"Cable machine"}', 'Setup: Stand facing the cable, feet shoulder-width apart, with a slight forward lean.
Grip: Hold the rope with palms facing each other and elbows tucked tight to your ribs.
Execution: Push the rope down until arms are fully straight, pulling the ends apart at the bottom.
Control: Keep upper arms still and return to the start with a slow, controlled motion.', 'https://wger.de/media/exercise-images/1900/a8243245-8f8f-4e2b-93ca-694d416cb11d.png', null, 'wger', 'fc608f0e-d754-4911-ae59-8856952e7064', 'CC-BY-SA 4', 'nishant0712'),
  ('Dumbbell Curl', 'isolation', false, false, true, 'Arms', '{"Biceps","Brachialis"}', '{"Shoulders","Abs"}', '{"Dumbbell"}', 'The Dumbbell Curl is a classic isolation exercise for the arms. Unlike the Hammer Curl, it involves rotating your wrists (supination) as you lift the weights, which allows for a full contraction of the biceps.', null, null, 'wger', '99846da5-5dc8-4de1-ba55-ae2b4c03c30d', 'CC-BY-SA 4', 'amaesc'),
  ('Pullback', 'pull_h', false, false, true, 'Back', '{"Biceps","Lats"}', '{"Brachialis"}', '{"Cable machine"}', 'Set weight and grip for the cables in the cage. Take a few steps away, bend over, pull and extend the back at the same time.', null, null, 'wger', '289bd40b-e3dd-4217-8670-e475771a0ea7', 'CC-BY-SA 4', 'cybro'),
  ('Abdominal Crunch', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis","Serratus anterior"}', '{"Gym mat"}', 'The Abdominal Crunch is a classic core isolation exercise performed on the floor or a mat. Unlike a full sit-up, it involves a smaller range of motion where you only lift your shoulders and upper back off the ground, keeping your lower back pressed firmly against the floor.', null, null, 'wger', '2ac901e6-f0c2-416f-998f-e01e00fe0aa1', 'CC-BY-SA 4', 'amaesc'),
  ('Belt Squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Hamstrings"}', '{}', 'Belt Squat: a squat variation done with a belt attached to a loading machine or platform so the weight is supported at the hips instead of on the spine. It mainly trains the quads and glutes, with much less lower-back fatigue than a barbell squat. Use a full range of motion, keep the torso upright, and drive through the mid-foot.', null, null, 'wger', 'e9f3446f-ca98-4bf2-817c-0dacd123cecd', 'CC-BY-SA 4', null),
  ('Arnold Shoulder Press', 'push_v', false, false, true, 'Shoulders', '{"Shoulders"}', '{"Trapezius","Triceps"}', '{"Dumbbell"}', 'Very common shoulder exercise.

As shown here: https://www.youtube.com/watch?v=vj2w851ZHRM', null, null, 'wger', 'f24cb758-9c0d-42d4-ad9e-6025c527dd13', 'CC-BY-SA 3', 'trzr23'),
  ('Barbell Lunges Standing', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{"Barbell"}', 'Put barbell on the back of your shoulders. Stand upright, then take the first step forward. Step should bring you forward so that your supporting legs knee can touch the floor. Then stand back up and repeat with the other leg.

Remember to keep good posture.', null, 'https://wger.de/media/exercise-video/46/200d9889-322f-476a-a47b-f15a1a97934a.MOV', 'wger', '04e7d7e4-f8d2-406d-97df-3df3bceec22c', 'CC-BY-SA 4', 'Mikko Ruohola'),
  ('Barbell Hack Squats', 'squat', false, true, true, 'Legs', '{"Quads"}', '{"Hamstrings","Glutes"}', '{"Barbell"}', 'Perform leg squats with barbell behind your legs', null, null, 'wger', 'dae6f6ed-9408-4e62-a59a-1a33f4e8ab36', 'CC-BY-SA 4', 'BePieToday'),
  ('Barbell Triceps Extension', 'isolation', false, false, true, 'Arms', '{"Triceps"}', '{"Shoulders","Chest"}', '{"Barbell"}', 'Position barbell overhead with narrow overhand grip.

Lower forearm behind upper arm with elbows remaining overhead. Extend forearm overhead. Lower and repeat.', 'https://wger.de/media/exercise-images/50/695ced5c-9961-4076-add2-cb250d01089e.png', null, 'wger', '13234b53-ea0c-41f1-9069-776865ea8eff', 'CC-BY-SA 4', 'sevae'),
  ('Dumbbell Push-Up', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{"Dumbbell"}', 'Normal Push-ups on Dumbbells, this brings a further range of movement', null, null, 'wger', '68e5eae7-7fd0-4d69-9b50-d0df15feac91', 'CC-BY-SA 4', null),
  ('Legend Chest Press', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{}', 'Plate-loaded chest press machine from Legend Fitness LeverEdge line.', null, null, 'wger', '2e96e572-ddb4-4251-a812-ccf03ea677a6', 'CC-BY-SA 4', null),
  ('3008 Abdominal Crunch', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Bodyweight"}', 'This is especially for the gym80 device 3008 Abdominal Crunch.', null, null, 'wger', '7870ad8d-a0c1-4e3a-a4fe-a237908eba9b', 'CC-BY-SA 4', null),
  ('Seated Cable chest fly', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Cable machine"}', 'Place a bench between two cable pulleys and adjust the pulleys so they are at chest/shoulder height when you are seated.
Grab the handles with a neutral grip and lean against the upright backrest.
Bring your arms together in front of your chest in a controlled motion, focusing on squeezing your chest muscles. Keep your elbows slightly bent throughout the movement.
Pause briefly at the top position.
Slowly lower your arms back to the starting position while maintaining control of the movement.
Repeat for reps.', 'https://wger.de/media/exercise-images/1922/eb750ee5-3220-4128-aef1-5e2f1ccff40a.webp', null, 'wger', '139772c6-e401-4281-8aa6-c7ff7fb49f6a', 'CC-BY-SA 4', 'shushu'),
  ('Seated V-Grip Row', 'pull_h', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Shoulders","Biceps","Abs","Serratus anterior"}', '{"Cable machine"}', 'The Seated V-Grip Row is a compound pulling exercise performed on a cable machine using a close-grip "V" handle. While seated with your feet braced, you pull the handle toward your midsection, focusing on back thickness and mid-back development.', null, null, 'wger', 'b2ca4a13-6fe2-4c4f-85b2-dcb5af28d2be', 'CC-BY-SA 4', 'amaesc'),
  ('Dead Bug (Core L1)', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Vasco custom dead bug - foundational deep core stability and anti-extension. Teaches lumbar-pelvic dissociation, breath-coordination, and proximal stability for distal mobility. Prerequisite for all core training.', null, null, 'wger', '816d8bff-73c0-436c-8479-e0145f2324fc', 'CC-BY-SA 4', 'Vasco Custom'),
  ('Biceps Curls With Dumbbell', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Dumbbell"}', 'Hold two dumbbells, the arms are streched, the hands are on your side, the palms face inwards. Bend the arms and bring the weight with a fast movement up. At the same time, rotate your arms by 90 degrees at the very beginning of the movement. At the highest point, rotate a little the weights further outwards. Without a pause, bring them down, slowly.

Don''t allow your body to swing during the exercise, all work is done by the biceps, which are the only mucles that should move (pay attention to the elbows).', 'https://wger.de/media/exercise-images/81/Biceps-curl-1.png', 'https://wger.de/media/exercise-video/92/8bfb917c-3d0d-49b9-8073-5d7e01c1b894.MOV', 'wger', '1ae6a28d-10e7-4ecf-af4f-905f8193e2c6', 'CC-BY-SA 3', 'wger.de'),
  ('Bent Over Rowing', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Biceps"}', '{"Barbell"}', 'Holding a barbell with a pronated grip (palms facing down), bend your knees slightly and bring your torso forward, by bending at the waist, while keeping the back straight until it is almost parallel to the floor. Tip: Make sure that you keep the head up. The barbell should hang directly in front of you as your arms hang perpendicular to the floor and your torso. This is your starting position.
Now, while keeping the torso stationary, breathe out and lift the barbell to you. Keep the elbows close to the body and only use the forearms to hold the weight. At the top contracted position, squeeze the back muscles and hold for a brief pause.
Then inhale and slowly lower the barbell back to the starting position.
Repeat for the recommended amount of repetitions.', 'https://wger.de/media/exercise-images/109/Barbell-rear-delt-row-1.png', null, 'wger', '4af6dbd9-8991-484b-9810-68f117c21edf', 'CC-BY-SA 3', 'wger.de'),
  ('Bent Over Dumbbell Rows', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Bench","Dumbbell"}', 'With dumbbells in hand, bend at the hip until hands hang just below the knees (similar to straight-legged-deadlift starting position). Keep upper body angle constant while contracting your lats to pull you ellbows back pinching the shoulder blades at the top. Try not to stand up with every rep, check hands go below knees on every rep.', 'https://wger.de/media/exercise-images/81/a751a438-ae2d-4751-8d61-cef0e9292174.png', null, 'wger', '94a5c406-7bcd-47f3-9687-bdf92a763932', 'CC-BY-SA 4', 'sebk'),
  ('Biceps Curls With SZ-bar', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"SZ-Bar"}', 'Hold the SZ-bar shoulder-wide, the back is straight, the shoulders slightly back, the arms are streched. Bend the arms, bringing the weight up, with a fast movement. Without pausing, let down the bar with a slow and controlled movement.

Don''t allow your body to swing during the exercise, all work is done by the biceps, which are the only mucles that should move (pay attention to the elbows).', 'https://wger.de/media/exercise-images/94/6dee2f60-aea2-4f2d-9bf6-aef50c4f9483.png', null, 'wger', '42227131-9b1e-4220-b082-c523f0651057', 'CC-BY-SA 3', 'wger.de'),
  ('Benchpress Dumbbells', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{"Bench","Dumbbell"}', 'Setup and Starting Position: Sit at the end of a flat bench with a dumbbell resting vertically against each thigh. Carefully lean back while driving the dumbbells toward your chest with your knees.

The “Leg Drive” and Posture: Plant your feet firmly on the floor. Retract your shoulder blades (press them together against the bench) and maintain a slight natural lumbar curve.

Starting Position: Push the dumbbells toward the ceiling. Your wrists should be aligned with your elbows. Rotate the dumbbells slightly inward (about 45 degrees) so that your elbows do not splay out too far to the sides, thereby protecting your shoulders.

Eccentric Phase (Lowering): Lower the dumbbells in a controlled manner toward the sides of your chest. Your elbows should lower at an angle of about 45–60 degrees relative to your body. Feel the stretch in the lower part of your chest.

Concentric Phase (Lift): Push the weight upward in a slight arc (toward the center), without letting the dumbbells collide at the top or fully locking out your elbows to maintain muscle tension. Exhale as you lift.

Translated with DeepL.com (free version)', 'https://wger.de/media/exercise-images/97/Dumbbell-bench-press-1.png', 'https://wger.de/media/exercise-video/75/080c799b-8afd-4130-8d72-9cef0cd79f54.MOV', 'wger', '28321cf3-70e6-48a4-ade1-d11382180cb3', 'CC-BY-SA 3', 'wger.de'),
  ('Biceps Curls With Barbell', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Barbell"}', 'Hold the Barbell shoulder-wide, the back is straight, the shoulders slightly back, the arms are streched. Bend the arms, bringing the weight up, with a fast movement. Without pausing, let down the bar with a slow and controlled movement.

Don''t allow your body to swing during the exercise, all work is done by the biceps, which are the only mucles that should move (pay attention to the elbows).', 'https://wger.de/media/exercise-images/74/Bicep-curls-1.png', 'https://wger.de/media/exercise-video/91/483f4bff-e108-41f1-8e7b-0caf24952552.MOV', 'wger', '7b99a081-6b1a-4aa5-b86a-5a935d083a35', 'CC-BY-SA 3', 'wger.de'),
  ('Decline Bench Leg Raise', 'push_h', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Incline bench"}', 'Setup: Lie on a decline bench with your head at the top and grip the handles.
The Start: Extend legs fully, keeping them slightly elevated to engage your core.
The Lift: Raise your legs toward the ceiling using your abs, not momentum.
The Squeeze: Pause and contract your lower abdominals at the top.
The Return: Lower your legs slowly to the starting position with control.', 'https://wger.de/media/exercise-images/1889/bc51ef67-0c12-4340-a36c-42ef722778dd.png', null, 'wger', '9ac4813e-79a6-4a4d-ab93-9cfa5bf7b8fa', 'CC-BY-SA 4', 'nishant0712'),
  ('Bench Press', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{"Barbell","Bench"}', 'Lay down on a bench, the bar should be directly above your eyes, the knees are somewhat angled and the feet are firmly on the floor. Concentrate, breath deeply and grab the bar more than shoulder wide. Bring it slowly down till it briefly touches your chest at the height of your nipples. Push the bar up.

If you train with a high weight it is advisable to have a spotter that can help you up if you can''t lift the weight on your own.

With the width of the grip you can also control which part of the chest is trained more:

wide grip: outer chest muscles
narrow grip: inner chest muscles and triceps', 'https://wger.de/media/exercise-images/192/Bench-press-1.png', 'https://wger.de/media/exercise-video/73/2bdb390c-312c-4497-a722-5eed2c823e5a.MOV', 'wger', '3717d144-7815-4a97-9a56-956fb889c996', 'CC-BY-SA 3', 'sistab2'),
  ('Bench Press Narrow Grip', 'push_h', false, false, true, 'Arms', '{"Triceps"}', '{"Shoulders","Chest"}', '{"Barbell","Bench"}', 'Setup: Lie flat on the bench and grip the bar at shoulder-width (closer than a standard bench press).
Descent: Lower the bar with control to your lower chest.
Form: Keep your elbows tucked in tight against your torso—do not let them flare out.
Ascent: Press the bar straight back up, squeezing your triceps at the top.', 'https://wger.de/media/exercise-images/88/Narrow-grip-bench-press-1.png', null, 'wger', '3db63138-a047-4a4d-b616-1a0b7dfca105', 'CC-BY-SA 3', 'wger.de'),
  ('Lateral Rows on Cable, One Armed', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Cable machine"}', 'Set cable at waist height, start with arm across your belly and move han over and out too other side, one arm at the time.', 'https://wger.de/media/exercise-images/349/9d969203-9cb6-4d47-9c31-fef53bfe1de5.png', 'https://wger.de/media/exercise-video/349/9896d82e-d8b6-48af-bdd5-b8545dc523e9.MOV', 'wger', '57263316-6f34-4539-952b-b07e09bac3ba', 'CC-BY-SA 3', 'wger.de'),
  ('Decline Bench Press Barbell', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Barbell","Bench"}', 'Lay down on a decline bench, the bar should be directly above your eyes, the knees are somewhat angled and the feet are firmly on the floor. Concentrate, breath deeply and grab the bar more than shoulder wide. Bring it slowly down till it briefly touches your chest at the height of your nipples. Push the bar up.', 'https://wger.de/media/exercise-images/100/Decline-bench-press-1.png', null, 'wger', 'bcd801f0-9a38-4615-a91c-900153c8c234', 'CC-BY-SA 3', 'wger.de'),
  ('Decline Bench Press Dumbbell', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Bench","Dumbbell"}', 'Take two dumbbells and sit on a decline bench, the feet are firmly on the floor, the head is resting the bench. Hold the weights next to the chest, at the height of your nipples and press them up till the arms are stretched. Let the weight slowly and controlled down.', null, null, 'wger', 'dda69c96-62d4-4690-aa07-a4a0f6ceb63a', 'CC-BY-SA 3', 'wger.de'),
  ('Seated Hip Adduction', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{}', '{}', 'Starting Position: Sit on the machine with your knees inward and against the pads. Pull the pin to release the pads. Grab the handles on the sides.b', 'https://wger.de/media/exercise-images/12/4a42cc6f-648d-40cc-a72a-c49dd47e1667.webp', 'https://wger.de/media/exercise-video/12/5148c579-5df2-4618-9a7b-a2e29ac4dd7d.MOV', 'wger', '53906cd1-61f1-4d56-ac60-e4fcc5824861', 'CC-BY-SA 3', 'flori'),
  ('Abdominal Stabilization', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Gym mat"}', null, null, null, 'wger', '03db11cc-8079-463c-9399-6f346b100ce6', 'CC-BY-SA 3', 'andikeller'),
  ('Handstand Pushup', 'push_v', false, false, true, 'Shoulders', '{"Shoulders","Triceps"}', '{"Trapezius"}', '{"Bodyweight"}', 'The handstand push-up (press-up) - also called the vertical push-up (press-up) or the inverted push-up (press-up) also called commandos- is a type of push-up exercise where the body is positioned in a handstand. For a true handstand, the exercise is performed free-standing, held in the air. To prepare the strength until one has built adequate balance, the feet are often placed against a wall, held by a partner, or secured in some other way from falling. Handstand pushups require significant strength, as well as balance and control if performed free-standing.', 'https://wger.de/media/exercise-images/282/f6121ac9-330e-4ed7-8219-91ce246bf871.png', null, 'wger', '7704e810-c05d-47cc-a384-265e0231a497', 'CC0', 'BFad07'),
  ('Dips', 'push_h', false, false, false, 'Chest', '{"Chest","Triceps"}', '{}', '{"Bodyweight"}', 'A dip is an upper-body strength exercise. Narrow, shoulder-width dips primarily train the triceps, with major synergists being the anterior deltoid, the pectoralis muscles (sternal, clavicular, and minor), and the rhomboid muscles of the back (in that order).[1] Wide arm training places additional emphasis on the pectoral muscles, similar in respect to the way a wide grip bench press would focus more on the pectorals and less on the triceps.', 'https://wger.de/media/exercise-images/194/34600351-8b0b-4cb0-8daa-583537be15b0.png', 'https://wger.de/media/exercise-video/194/d039ec90-474d-47a9-a3ad-bf0b00828c82.MP4', 'wger', '09dd3e3c-e53a-4e2c-a2e3-645d334f53e2', 'CC0', 'BFad07'),
  ('Fly With Dumbbells, Decline Bench', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Bench","Dumbbell"}', 'The exercise is the same as with a regular bench:

Take two dumbbells and lay on a bench, make sure the feet are firmly on the ground and your back is not arched, but has good contact with the bench. The arms are stretched in front of you, about shoulder wide. Bend now the arms a bit and let them down with a half-circle movement to the side. Without changing the angle of the elbow bring them in a fluid movement back up.', null, null, 'wger', '55d0a5ec-b147-40c3-aa77-314e61c93689', 'CC-BY-SA 3', 'wger.de'),
  ('Ball crunches', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{}', null, null, null, 'wger', '36391719-d4ad-4e0f-991f-8eafd5947108', 'CC-BY-SA 4', 'Konsumopfer'),
  ('Biceps Curl With Cable', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Cable machine"}', 'Stand around 30 - 40cm away from the cable, the feet are firmly on the floor. Take the bar and lift the weight with a fast movements. Lower the weight as with the dumbbell curls slowly and controlled.', 'https://wger.de/media/exercise-images/129/Standing-biceps-curl-1.png', 'https://wger.de/media/exercise-video/95/ab770931-47d3-44fd-aef0-ac7a64c3b794.MOV', 'wger', 'bcb7020c-8678-496d-8f4d-aad0e233a5bd', 'CC-BY-SA 3', 'wger.de'),
  ('Fly With Cable', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Cable machine"}', 'cable machine, two steps forward, straight back', 'https://wger.de/media/exercise-images/122/Incline-cable-flyes-1.png', null, 'wger', '07c5b9f4-2be5-4a3d-b6d2-16235da1ae3a', 'CC-BY-SA 3', 'wger.de'),
  ('Hammercurls on Cable', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Cable machine"}', 'Take a cable in your hands (palms parallel, point to each other), the body is straight. Bend the arms and bring the weight up with a fast movement. Without any pause bring it back down with a slow, controlled movement, but don''t stretch completely your arms.

Don''t swing your body during the exercise, the biceps should do all the work here. The elbows are at your side and don''t move.', 'https://wger.de/media/exercise-images/138/Hammer-curls-with-rope-1.png', 'https://wger.de/media/exercise-video/275/af1fff93-eb58-4ba7-97a4-b38ee67853b4.MOV', 'wger', '04365177-e078-489b-983a-8ac61b7346f1', 'CC-BY-SA 3', 'wger.de'),
  ('Glute Bridge', 'hinge', false, true, false, 'Legs', '{"Glutes"}', '{"Hamstrings"}', '{}', 'Lie on you back with your hips and knees flexed, feet on the ground. From this position, raise your butt off of the ground to a height where your body makes a straight line from your knees to your shoulders. To make the exercise more intense, you can add weight by letting a barbell rest on your hips as you complete the motion, or you can put your feet on a slightly higher surface such as a step or a bench.', null, null, 'wger', 'ceb0c2d0-06ac-4a49-89e7-8d7b1c1e5672', 'CC-BY-SA 4', 'tdprice12'),
  ('Close-grip Lat Pull Down', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{}', 'Grip the pull-down bar with your hands closer than shoulder width apart, with your palms facing away from you. Lean back slightly. Pull the bar down towards your chest, keeping your elbows close to your sides as you come down. Pull your shoulders back at the end of the motion.', 'https://wger.de/media/exercise-images/158/0d51a0f2-622f-434b-beb8-1a003c54712a.png', null, 'wger', '63fbb8e5-6ebc-4def-8844-3e65e097213b', 'CC-BY-SA 3', 'tuckerm'),
  ('Braced Squat', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{}', 'Stand with feet slightly wider than shoulder-width apart, while standing as tall as you can.

Grab a weight plate and hold it out in front of your body with arms straight out. Keep your core tight and stand with a natural arch in your back.

Now, push hips back and bend knees down into a squat as far as you can. Hold for a few moments and bring yourself back up to the starting position.', null, null, 'wger', '8c6428f3-d41d-4ffc-8444-bb9b823bc42b', 'CC-BY-SA 4', 'sevae'),
  ('Calf Press Using Leg Press Machine', 'squat', false, true, false, 'Calves', '{"Calves","Soleus"}', '{}', '{}', 'Put the balls of your feet on an extended leg press pad. Use your calves to press the weight by flexing your feet/toes into a pointed position, and releasing back into a relaxed position.

This exercise builds mass and strength in the Gastrocnemius and Soleus muscles as well, if not better, than any calf exercise.', 'https://wger.de/media/exercise-images/146/8b284904-d072-4381-a256-4c81d8fd9c1f.png', null, 'wger', '0d79f259-3b28-4258-8a08-cffec062a710', 'CC-BY-SA 4', 'nate303303'),
  ('Calf Raises on Hackenschmitt Machine', 'isolation', false, true, false, 'Calves', '{"Calves"}', '{"Soleus"}', '{}', 'Place yourself on the machine with your back firmly against the backrest, the feet are on the platform for calf raises. Check that the feet are half free and that you can completely stretch the calf muscles down.

With straight knees pull up your weight as much as you can. Go with a fluid movement down till the calves are completely stretched. Repeat.', null, null, 'wger', '95a9cc46-270e-45f2-8a17-5665a23ff70b', 'CC-BY-SA 3', 'wger.de'),
  ('Butterfly Narrow Grip', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{}', 'The movement is the same as with a regular butterfly, only that the grip is narrow:

Sit on the butterfly machine, the feet have a good contact with the floor, the upper arms are parallel to the floor. Press your arms together till the handles are practically together (but aren''t!). Go slowly back. The weights should stay all the time in the air.', null, null, 'wger', '80ff0a3a-ae45-497d-8c27-2b12e3b6e1b8', 'CC-BY-SA 3', 'wger.de'),
  ('Butterfly', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Shoulders"}', '{}', 'Sit on the butterfly machine, the feet have a good contact with the floor, the upper arms are parallel to the floor. Press your arms together till the handles are practically together (but aren''t!). Go slowly back. The weights should stay all the time in the air.', 'https://wger.de/media/exercise-images/98/Butterfly-machine-2.png', null, 'wger', '99449eae-0eae-44ab-a57f-fc094bbdda13', 'CC-BY-SA 3', 'wger.de'),
  ('Crunches on Machine', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{}', 'The procedure is very similar as for regular crunches, only with the additional weight of the machine. Sit on the machine, put both feet firmly on the ground. Grab the to the weights, cables, etc. and do a rolling motion forwards (the spine should ideally lose touch vertebra by vertebra). Slowly return to the starting position.', null, null, 'wger', '401989e0-64c3-459d-bc47-2c171ab4f41d', 'CC-BY-SA 3', 'wger.de'),
  ('Incline Crunches', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Incline bench"}', 'Lay down on your back on a inclined bench, feet are on one end of the bench. Ask a partner or use some other help (barbell, etc.) to keep them fixed, your hands are behind your head. From this position move your upper body up till your head or elbows touch your knees. Do this movement by rolling up your back.', 'https://wger.de/media/exercise-images/56/Decline-crunch-1.png', null, 'wger', '7de7b8a8-313d-465f-bb22-8527ae45110a', 'CC-BY-SA 3', 'wger.de'),
  ('Butterfly Reverse', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{}', null, null, null, 'wger', 'a6605e9c-887d-45e0-8282-617a8ec5fea2', 'CC-BY-SA 3', 'wger.de'),
  ('Crunches', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Serratus anterior"}', '{"Gym mat"}', 'Lay down on your back a soft surface, the feet are on the floor. Ask a partner or use some other help (barbell, etc.) to keep them fixed, your hands are behind your head. From this position move your upper body up till your head or elbows touch your knees. Do this movement by rolling up your back.', 'https://wger.de/media/exercise-images/91/Crunches-1.png', null, 'wger', 'b186f1f8-4957-44dc-bf30-d0b00064ce6f', 'CC-BY-SA 3', 'wger.de'),
  ('Crunches With Legs Up', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{}', 'On your back, legs extended straight up, reach toward your toes with your hands and lift your shoulder blades off the ground and back.', null, null, 'wger', 'b7ff64bc-7a7c-4dbc-af6f-fabc20425f5f', 'CC-BY-SA 4', 'krisbbb'),
  ('Flutter Kicks', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{}', '{}', '-Laying on the back, lift your straightened legs from the ground at a 45 degree angle.

-As your Left foot travels downward and nearly touches the floor, your Right foot should seek to reach a 90 degree angle, or as close to one as possible.

-Bring your R foot down until it nearly touches the floor, and bring your L foot upwards. Maintain leg rigidity throughout the exercise. Your head should stay off the ground, supported by tightened upper abdominals.

-(L up R down, L down R up, x2) ^v, v^, ^v, v^ = 1 rep

-Primarily works the Rectus Abdominus, the hip flexors and the lower back. Secondarily works the Obliques. Emphasis placed on the lower quadrant of the abs.', null, null, 'wger', 'fdc550b6-ec58-4023-ba62-b54045e9a10d', 'CC-BY-SA 4', 'nate303303'),
  ('Deadlifts', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{"Glutes"}', '{"Barbell"}', 'Stand firmly, with your feet slightly more than shoulder wide apart. Stand directly behind the bar where it should barely touch your shin, your feet pointing a bit out. Bend down with a straight back, the knees also pointing somewhat out. Grab the bar with a shoulder wide grip, one overhand, one underhand (mixed grip).

Pull the weight up. At the highest point make a slight hollow back and pull the bar back. Hold 1 or 2 seconds that position. Go down, making sure the back is not bent. Once down you can either go back again as soon as the weights touch the floor, or make a pause, depending on the weight.', 'https://wger.de/media/exercise-images/184/1709c405-620a-4d07-9658-fade2b66a2df.jpeg', null, 'wger', 'ee8e8db4-2d82-49e1-ab7f-891e9a354934', 'CC-BY-SA 3', 'wger.de'),
  ('Dumbbell Goblet Squat', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{"Dumbbell"}', 'Grasp dumbbell with both hands at the sides of the upper plates. Hold dumbbell in front of chest, close to torso. Place feet about shoulderwide apart, keep knees slightly bent.

Squat down until thighs are parallel to floor. Keep back straight, bend and move hips backward to keep knees above feet. Return, keep knees slightly flexed. Repeat.

Keep bodyweight on heels and look ahead or slightly above to keep back straight.', 'https://wger.de/media/exercise-images/203/1c052351-2af0-4227-aeb0-244008e4b0a8.jpeg', null, 'wger', 'b7c6a444-90ea-4f5b-9fea-748311606eaa', 'CC-BY-SA 4', 'ataraxie67'),
  ('Dumbbell Lunges Standing', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{"Dumbbell"}', '.', null, 'https://wger.de/media/exercise-video/205/c167ac34-ddbc-4e1b-8edf-1192e9d00e22.MOV', 'wger', '2f1a2707-e7ff-46ac-9112-3e31e6e961ee', 'CC-BY-SA 3', 'wger.de'),
  ('Dumbbell Lunges Walking', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{"Dumbbell"}', 'Starting Position: Stand with feet hip-width apart and hands either on your hips or holding dumbbells at your sides.
The Stride: Take a wide step forward with your right leg.
The Descent: Lower your hips until both knees are bent at approximately 90-degree angles.
The Transition: Drive through your front heel to stand up, bringing your back foot forward to step directly into the next lunge.', 'https://wger.de/media/exercise-images/113/Walking-lunges-1.png', 'https://wger.de/media/exercise-video/206/47a65c45-6fd1-4181-b71a-3a6c882e516b.MOV', 'wger', 'dcc6e237-a8bb-4eca-bbc5-7fb852636f6a', 'CC-BY-SA 3', 'wger.de'),
  ('Fly With Dumbbells', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Dumbbell"}', 'Take two dumbbells and lay on a bench, make sure the feet are firmly on the ground and your back is not arched, but has good contact with the bench. The arms are stretched in front of you, about shoulder wide. Bend now the arms a bit and let them down with a half-circle movement to the side. Without changing the angle of the elbow bring them in a fluid movement back up.', 'https://wger.de/media/exercise-images/238/2fc242d3-5bdd-4f97-99bd-678adb8c96fc.png', null, 'wger', '95d226ad-3bf7-4cd6-aa64-2f26b526d8b6', 'CC-BY-SA 3', 'wger.de'),
  ('Dumbbell Incline Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{"Brachialis"}', '{"Dumbbell"}', 'Setup: Set an adjustable bench to an incline of approximately 45 to 60 degrees.
Starting Position: Sit back against the bench with a dumbbell in each hand. Let your arms hang straight down toward the floor with your palms facing forward (supinated grip).
The Curl: Keeping your upper arms stationary and shoulders pinned back against the bench, exhale and curl the weights upward toward your shoulders.
Peak Contraction: Squeeze your biceps hard at the top of the movement, ensuring your elbows do not swing forward.
The Descent: Inhale and slowly lower the dumbbells back to the starting position, maintaining full control and feeling the stretch in the biceps.', null, null, 'wger', '43e85cb8-51d0-4892-b1bf-80a3cb111ff6', 'CC-BY-SA 4', 'ExRx'),
  ('Dumbbell Triceps Extension', 'isolation', false, false, true, 'Arms', '{"Triceps"}', '{"Shoulders","Chest"}', '{"Dumbbell"}', 'Position one dumbbell over head with both hands under inner plate (heart shaped grip).

With elbows over head, lower forearm behind upper arm by flexing elbows. Flex wrists at bottom to avoid hitting dumbbell on back of neck. Raise dumbbell over head by extending elbows while hyperextending wrists. Return and repeat.', null, 'https://wger.de/media/exercise-video/211/85f6eb25-a76c-409e-9af9-497794ac0dfb.MOV', 'wger', 'd8bddb58-91b0-4d7b-8ec1-cd742584b607', 'CC-BY-SA 3', 'tuninx'),
  ('Dips Between Two Benches', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Bench"}', 'Put two benches so far appart, that you can hold onto one with your hands and are just able to reach the other with your feet. The legs stay during the exercise completely stretched. With your elbows facing back, bend them as much as you can. Push yourself up, but don''t stretch out the arms.', 'https://wger.de/media/exercise-images/83/Bench-dips-1.png', null, 'wger', '7c8eb1ac-2d7e-4ca7-919a-1848ba38e0f4', 'CC-BY-SA 3', 'wger.de'),
  ('Front Raises with Plates', 'push_v', false, false, false, 'Shoulders', '{"Shoulders","Trapezius"}', '{}', '{}', 'The plate front raise is a variation of the dumbbell front raise where the lifter holds a weight plate between two hands, rather than using a dumbbell, barbell, or other weight. It can provide variety in a shoulder-focused muscle-building workout, or as part of an upper body or full-body circuit.

While standing straight, hold a barbell plate in both hands at the 3 and 9 o''clock positions. Your palms should be facing each other and your arms should be extended and locked with a slight bend at the elbows and the plate should be down near your waist in front of you as far as you can go. Tip: The arms will remain in this position throughout the exercise. This will be your starting position.
Slowly raise the plate as you exhale until it is a little above shoulder level. Hold the contraction for a second. As you inhale, slowly lower the plate back down to the starting position.
Repeat for the recommended amount of repetitions.', null, null, 'wger', '68e0dbba-2d1e-4a56-8378-8824c1de3342', 'CC-BY-SA 3', 'Marius'),
  ('Hanging Leg Raises', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Pull-up bar"}', 'Hanging from bar or straps, bring legs up with knees extended or flexed', null, null, 'wger', '9b993e99-8701-43f0-84d6-689123183880', 'CC-BY-SA 3', 'robhoyt'),
  ('Front Raises', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Barbell","Dumbbell"}', 'To execute the exercise, the lifter stands with their feet shoulder width apart and weights or resistance handles held by their side with a pronated (overhand) grip.

The movement is to bring the arms up in front of the body to eye level and with only a slight bend in the elbow. This isolates the anterior deltoid muscle (front of the shoulder) and uses the anterior deltoid to lift the weight.

When lifting it is important to keep the body still so the anterior deltoid is fully utilised; if the weight cannot be lifted by standing still then it is too heavy and a lower weight is needed. It is important to keep a slight bend in the elbow when lifting as keeping the elbow locked will add stress to the elbow joint and could cause injury.

A neutral grip, similar to that used in the hammer curl, can also be used. With this variation the weight is again raised to eye level, but out to a 45 degree angle from the front of the body. This may be beneficial for those with shoulder injuries, particularly those related to the rotator cuff.', 'https://wger.de/media/exercise-images/256/b7def5bc-2352-499b-b9e5-fff741003831.png', null, 'wger', '9c35594c-bbcc-4656-bdcb-376814c90e96', 'CC-BY-SA 3', 'Manu, wikipedia'),
  ('Hindu Squats', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{}', 'Start with your feet shoulder width apart and arms slightly behind your back.

As you descend towards the floor, raise your heels off the ground, while keeping your back as vertical as possible.

Upon attaining the bottom position, touch the hands to the heels.

Then stand up ending with the heels on the ground, arms extended in front of the chest then rowing into the start position.', null, null, 'wger', '1d610575-eed0-42cf-8737-29788a372af6', 'CC-BY-SA 4', 'Vilhelmo'),
  ('Front Squats', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{"Abs"}', '{"Barbell"}', 'This variation of the squat trains the hamstrings and gluteus maximus. It also works the back extensors and abductors.', 'https://wger.de/media/exercise-images/191/Front-squat-1-857x1024.png', 'https://wger.de/media/exercise-video/257/ad8ac7d9-b04d-415f-ae0e-837942ce2840.MOV', 'wger', 'd677de4c-5bd9-412a-91f1-857116a666a2', 'CC-BY-SA 3', 'sistab2'),
  ('Hammer Curls', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Start: Hold dumbbells at your sides with palms facing your torso.
Curl: Lift the weights toward your shoulders while maintaining the neutral grip (like holding a hammer).
Squeeze: Contract the biceps at the top without moving your elbows forward.
Lower: Slowly return to the starting position with full control.', 'https://wger.de/media/exercise-images/86/Bicep-hammer-curl-1.png', 'https://wger.de/media/exercise-video/272/df069052-2173-4f24-855f-a0eebe729f24.MOV', 'wger', 'c0d9fe98-f4fe-49f3-8037-05e1984e7d2d', 'CC-BY-SA 3', 'wger.de'),
  ('Skullcrusher Dumbbells', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Bench","Dumbbell"}', 'Hold the dumbbells and lay down on a flat bench in such a way that around 1/4 of your head is over the edge. Stretch arms straight up and then lean dumbbells away from your toes to a 10-20 degree angle. Keep upper arm at this angle throughout exercise. Dumbbell shall not be amed at your head, but away over your head. This will maximise gain from exercise with load on triceps all the time.

Pay attention to your elbows and arms: only the triceps are doing the work, the rest of the arms should not move.', null, 'https://wger.de/media/exercise-video/245/c253303e-9160-4f1f-b4fe-daf1e6c8661d.MOV', 'wger', '893c07ea-2e24-49b6-92e4-d0033eedec62', 'CC-BY-SA 3', 'wger.de'),
  ('Skullcrusher SZ-bar', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Bench","SZ-Bar"}', 'Hold the SZ-bar and lay down on a flat bench in such a way that around 1/4 of your head is over the edge. Stretch your arms with the bar and bend them so that the bar is lowered. Just before it touches your forehead, push it up.

Pay attention to your elbows and arms: only the triceps are doing the work, the rest of the arms should not move.', 'https://wger.de/media/exercise-images/84/Lying-close-grip-triceps-press-to-chin-1.png', 'https://wger.de/media/exercise-video/246/75eb8c88-922e-45c5-8be3-ac073f62b63f.MP4', 'wger', '95a7e546-e8f8-4521-a76b-983d94161b25', 'CC-BY-SA 3', 'wger.de'),
  ('Front Pull narrow', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Brachialis"}', '{"Barbell","SZ-Bar"}', null, null, null, 'wger', '5b4b94ca-f429-4394-9477-c00be8f2bb04', 'CC-BY-SA 3', 'wger.de'),
  ('Front pull wide', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Biceps","Brachialis"}', '{"Barbell","SZ-Bar"}', null, null, null, 'wger', '6260e3aa-e46b-4b4b-8ada-58bfd0922d3a', 'CC-BY-SA 3', 'wger.de'),
  ('Leg Curls (laying)', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{}', 'Lay on a bench and put your calves behind the leg holder (better if they are hold on around the lower calves). Hold a grip on the bars to make sure the body is firmly in place. Bend your legs bringing the weight up, go slowly back. During the exercise the body should not move, all work is done by the legs.', 'https://wger.de/media/exercise-images/154/lying-leg-curl-machine-large-1.png', 'https://wger.de/media/exercise-video/365/becaf013-5044-40d0-bae9-7ed60c973737.MOV', 'wger', '3bc8b411-a28d-4e1c-a6d1-769e18fe9881', 'CC-BY-SA 3', 'wger.de'),
  ('Lat Pull Down (Leaning Back)', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{}', 'Lean Back, Pull into chest', null, null, 'wger', '8c496646-baa8-4ed3-97b1-702e213fdeca', 'CC-BY-SA 3', 'drthurlow'),
  ('Lat Pull Down (Straight Back)', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{}', '{}', 'The lat pull down is an exercise used to build the muscles of the back. While the exercise will primarily target the lats, you will also notice a fair amount of bicep and middle back activation.', null, null, 'wger', 'fff05d7a-f374-4c8a-9885-39f49076918f', 'CC-BY-SA 3', 'drthurlow'),
  ('Leg Curls (sitting)', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{}', null, 'https://wger.de/media/exercise-images/117/seated-leg-curl-large-1.png', 'https://wger.de/media/exercise-video/366/43df4b79-d4c3-4fbf-bcb5-e0d825b84120.MOV', 'wger', '440a5184-de58-4a86-a7ba-76ddeafaa855', 'CC-BY-SA 3', 'wger.de'),
  ('Lateral Raises', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'This exercise works the deltoid muscle of the shoulder. The movement starts with the arms straight, and the hands holding weights at the sides or in front of the body. Body is in a slight forward-leaning position with hips and knees bent a little. Arms are kept straight or slightly bent, and raised through an arc of movement in the coronal plane that terminates when the hands are at approximately shoulder height. Weights are lowered to the starting position, completing one rep. When using a cable machine the individual stands with the coronal plane in line with the pulley, which is at or near the ground.[9] The exercise can be completed one shoulder at a time (with the other hand used to stabilize the body against the weight moved), or with both hands simultaneously if two parallel pulleys are available.', 'https://wger.de/media/exercise-images/148/lateral-dumbbell-raises-large-2.png', 'https://wger.de/media/exercise-video/348/de69928a-8a35-4096-821c-1f46de5e0e03.MOV', 'wger', '63375f5b-2d81-471c-bea4-fc3d207e96cb', 'CC-BY-SA 3', 'wger.de'),
  ('Leg Curl', 'squat', false, true, false, 'Legs', '{"Hamstrings","Glutes"}', '{}', '{}', 'The leg curl, also known as the hamstring curl, is an isolation exercise that targets the hamstring muscles. The exercise involves flexing the lower leg against resistance towards the buttocks. Other exercises that can be used to strengthen the hamstrings are the glute-ham raise and the deadlift.', 'https://wger.de/media/exercise-images/364/b318dde9-f5f2-489f-940a-cd864affb9e3.png', null, 'wger', '48836f44-efcd-4471-a456-5f024936025a', 'CC0', 'BFad07'),
  ('Lateral-to-Front Raises', 'push_v', false, false, false, 'Shoulders', '{"Shoulders","Trapezius"}', '{}', '{"Dumbbell"}', '-(1) Perform a lateral raise, pausing at the top of the lift (2).

-Instead of lowering the weight, bring it to the front of your body so that you appear to be at the top position of a front raise. You will do this by using a Pec Fly motion, maintaining straight arms. (3)

-Now lower the weight to your quadriceps, or, in other words, lower the dumbbells as though you are completing a Front Raise repetition. (4)

-Reverse the motion: Perform a front raise (5), at the apex of the lift use a Reverse Fly motion to position the weights at the top of a Lateral Raise (6), and finally, lower the weights until your palms are essentially touching the sides of your thighs (7). THIS IS ONE REP.

(1) l front view(2) -l- FV (3) l- side view (4) l SV/FV (5) l- SV (6) -l- FV (7) l FV/SV', null, null, 'wger', 'dac3c714-f0c6-4d97-8283-17be7dd77b65', 'CC-BY-SA 4', 'nate303303'),
  ('Squats on Multipress', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{}', null, null, 'https://wger.de/media/exercise-video/341/0cbfeace-dda9-4166-8424-f51358e88a4f.MOV', 'wger', '316aca47-6f5b-40b7-b04f-f69e68387354', 'CC-BY-SA 3', 'wger.de'),
  ('Incline Dumbbell Fly', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{"Dumbbell","Incline bench"}', 'Use inclined bench. Hold dumbbells straight out to your sides, elbows slightly bent. Bring arms together above you, keeping angle of elbows fixed.', null, null, 'wger', '55ff32e6-24ab-4303-9b50-176d60d48796', 'CC-BY-SA 3', 'tuckerm'),
  ('One Arm Triceps Extensions on Cable', 'isolation', true, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', null, null, 'https://wger.de/media/exercise-video/803/99e0001f-217a-4b11-823c-014d24a5415e.MOV', 'wger', 'f8d69dd4-3c35-49c7-8cbe-f0132eca4c52', 'CC-BY-SA 4', null),
  ('Cable Rear Delt Fly', 'push_h', false, false, true, 'Shoulders', '{"Shoulders","Trapezius"}', '{"Triceps"}', '{"Cable machine"}', 'The reverse cable fly, also known as the cable rear delt fly, is a deltoid muscle strengthening and definition exercise. It’s one of the best isolation exercises for your back and posterior deltoid.This workout targets your posterior (back) deltoids while using a range of upper body muscles.

Adjust the weight and the pulleys to the right height. You should be able to see the pulleys because they should be above your head.
With your right hand, grab the left pulley, and with your left hand, grab the right pulley, crossing them in front of you. This is where you’ll begin your journey.
Start the movement by moving your arms back and forth while keeping your arms straight.
Pause at the finish of the move for a brief moment before returning the handles to their starting positions.', 'https://wger.de/media/exercise-images/822/74affc0d-03b6-4f33-b5f4-a822a2615f68.png', null, 'wger', '5d244235-cd56-472a-876e-6e530a899ef2', 'CC-BY-SA 4', 'cshep442'),
  ('Kettlebell Swings', 'squat', false, true, false, 'Legs', '{"Glutes"}', '{"Hamstrings"}', '{"Kettlebell"}', 'Hold the kettlebell securely in both hands. Keep your back flat throughout the move, avoiding any rounding of the spine.Keeping your knees "soft", hinge your hips backwards, letting the kettlebell swing between your knees.

You want to bend from the hips as far as you can without letting your back round forwards. Then, snap your hips forwards quickly and standing up straight, locking your body in an upright posture.

The speed you do this will cause your arms and the kettlebell to swing up in front of you. Don''t try to lift the kettlebell with your arms. The snapping forwards of your hips will cause the kettlebell to swing forwards through momentum. Depending on the weight of the kettlebell and the speed of your hip movement, your arms will swing up to about shoulder height. At the top of this swing, let your hips hinge backwards again as the kettlebell swings back down to between your legs and the start of the next repetition.', null, null, 'wger', '8b311259-4f67-4dbf-9574-8c38faa92160', 'CC-BY-SA 3', 'J120290,cerin'),
  ('Leverage Machine Iso Row', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{}', 'Adjust seat height so that the handles are at the bottom of your pectorals or just below.', null, null, 'wger', 'fd595232-b9ad-4216-bba1-92298f993ea9', 'CC-BY-SA 3', 'tuckerm'),
  ('Negative Crunches', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{}', 'Sit yourself on the decline bench and fix your legs. Cross your arms over the chest and bring with a rolling movement your upper body up, go now without a pause and with a slow movement down again. Don''t let your head move during the exercise.', 'https://wger.de/media/exercise-images/93/Decline-crunch-1.png', null, 'wger', 'cbc5fbc9-9bca-4766-941d-4b6903d4a521', 'CC-BY-SA 3', 'wger.de'),
  ('Diamond push ups', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Bodyweight"}', 'Start: Get into a plank. Place hands close together under your chest so thumbs and index fingers form a diamond shape.

Lower: Bend your elbows to lower your chest toward your hands. Keep your body straight.

Push: Push back up until arms are fully extended.

New note Keep elbows close to your body and core tight.', null, null, 'wger', 'de22963a-5d42-4999-860e-377f64359432', 'CC-BY-SA 4', 'notdefine'),
  ('Leg Raises, Standing', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Serratus anterior"}', '{}', 'Put your forearms on the pads on the leg raise machine, the body is hanging freely. Lift now your legs with a fast movement as high as you can, make a short pause of 1sec at the top, and bring them down again. Make sure that during the exercise your body does not swing, only the legs should move.', null, null, 'wger', '5f514f9e-6bd9-408e-85b2-c25eb04af33b', 'CC-BY-SA 3', 'wger.de'),
  ('Leverage Machine Chest Press', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{}', '{}', 'Be sure to adjust seat height so that the handles are towards the bottom of your pectorals.', null, null, 'wger', '82aec7f9-ee03-4b24-8994-f6bde07c6a41', 'CC-BY-SA 3', 'tuckerm'),
  ('Leg Raises, Lying', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Serratus anterior"}', '{"Gym mat"}', 'Lay down on a bench and hold onto the recliner with your hands to keep you stable. Hold your legs straight and lift them till they make an angle of about 45°. Make a short pause of 1 sec. and go slowly down to the initial position. To increase the intensity you can make a longer pause of 7 sec. every 5th time.', 'https://wger.de/media/exercise-images/125/Leg-raises-2.png', null, 'wger', '9e34bc01-9cec-4ee2-a9bb-9c937a471c24', 'CC-BY-SA 3', 'wger.de'),
  ('Leg Raise', 'squat', false, true, false, 'Legs', '{"Obliquus externus abdominis","Abs"}', '{}', '{}', 'The leg raise is a strength training exercise which targets the iliopsoas (the anterior hip flexors). Because the abdominal muscles are used isometrically to stabilize the body during the motion, leg raises are also often used to strengthen the rectus abdominis muscle and the internal and external oblique muscles.', null, null, 'wger', 'c2078aac-e4e2-4103-a845-6252a3eb795e', 'CC0', 'BFad07'),
  ('Low Box Squat - Wide Stance', 'squat', false, true, false, 'Legs', '{"Glutes","Quads"}', '{}', '{"Barbell"}', 'Unrack the bar and set your stance wide, beyond your hips. Push your hips back and sit down to a box that takes you below parallel. Sit completely down, do not touch and go. Then explosively stand up. Stay tight in your upper back and torso throughout the movement.', null, null, 'wger', '183e7279-f052-4c70-8381-bbbda3bb9afe', 'CC-BY-SA 4', 'taylorbarbell'),
  ('Leg Curls (standing)', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{}', null, 'https://wger.de/media/exercise-images/118/standing-leg-curls-large-1.png', 'https://wger.de/media/exercise-video/367/6c24960c-20ab-4ef9-90f8-cf53e630ccec.MOV', 'wger', '49189e88-40b6-4c0d-a784-0cc3abbb8e75', 'CC-BY-SA 3', 'wger.de'),
  ('Leg Press on Hackenschmidt Machine', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{}', null, 'https://wger.de/media/exercise-images/130/Narrow-stance-hack-squats-1-1024x721.png', 'https://wger.de/media/exercise-video/375/effa7a81-dbdd-4014-83ee-ddf0fd835301.MOV', 'wger', '18104387-4567-4c1e-8d03-db0b274646dd', 'CC-BY-SA 3', 'wger.de'),
  ('Leg Presses (narrow)', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{}', 'The exercise is very similar to the wide leg press:

Sit on the machine and put your feet on the platform so far apart that you could just put another foot in between them. The feet are parallel and point up.

Lower the weight so much, that the knees form a right angle. Push immediately the platform up again, without any pause. When in the lower position, the knees point a bit outwards and the movement should be always fluid.', 'https://wger.de/media/exercise-images/373/60e2aa21-1910-40d3-9fed-babfee06dd48.png', null, 'wger', '5f0b757c-0d6a-430b-9d5e-3bfba202878e', 'CC-BY-SA 3', 'wger.de'),
  ('Leg Presses (wide)', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{}', 'Sit on the machine and put your feet on the platform, a bit more than shoulder wide. The feet are turned outwards by a few degrees.

Lower the weight so much, that the knees form a right angle. Push immediately the platform up again, without any pause. When in the lower position, the knees point a bit outwards and the movement should be always fluid.', null, 'https://wger.de/media/exercise-video/374/5336822a-7803-45b3-a880-f2bbf37a28f2.MOV', 'wger', '661287d4-d1dc-485c-896b-73f90b000536', 'CC-BY-SA 3', 'wger.de'),
  ('Pendelay Rows', 'pull_h', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Biceps","Triceps"}', '{"Barbell"}', 'Back excercise with a barbell with a starting position which is in a bent over position with the back paralell to the ground. The barbell is on the ground at chest level.For the movement grab the barbell at shoulder width grip and pull towards your chest without losing the bent over position and without moving anything but your arms', null, null, 'wger', '748e9635-7958-4a41-b1ed-93de74c7ef72', 'CC-BY-SA 3', 'Nallitnas'),
  ('Rack Deadlift', 'hinge', false, false, false, 'Back', '{"Glutes"}', '{"Biceps"}', '{}', 'Deadlift to be done using a Smith machine or a free rack. Bar or barbell hould be just right under the knee cap level. Lift using the glutes and through the heels, then come back to starting postion with a control movement of 2 seconds.

This exercise targets mainly the lower back and glutes.', 'https://wger.de/media/exercise-images/161/Dead-lifts-2.png', null, 'wger', 'a6c2a970-a621-4e03-be1d-4a29118b1687', 'CC-BY-SA 3', 'Mahoney'),
  ('Push Press', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{"Glutes"}', '{}', 'Clean your dumbbells onto your shoulders, palms facing in. Take a breath and brace your core. (picture 1)Dip at the knees and use your legs to help (picture 2) press your dumbbells overhead. Lower under control with a slow tempo to your shoulders and repeat.', 'https://wger.de/media/exercise-images/478/70a2d72c-a822-45f3-8de2-54ea85951b84.jpg', null, 'wger', '4284336c-6cfa-4c4d-a440-26b30db035d1', 'CC-BY-SA 3', 'sistab2'),
  ('Pause Bench', 'push_h', false, false, false, 'Chest', '{"Chest"}', '{"Triceps"}', '{"Barbell","Bench"}', 'Lower the bar to your chest and pause (but do not rest) there for 2 seconds. Press back up. use the same weight you would on bench press, but perform only single reps. Total the number of reps you did in one set of bench press (if you did 3 sets of 8 do 8 sinlge pause bench reps.', null, null, 'wger', '6441ff9e-037e-48d9-8800-67b430dc8e37', 'CC0', 'Mens Fitness'),
  ('Pistol Squat', 'squat', true, true, true, 'Legs', '{"Hamstrings","Glutes"}', '{"Shoulders","Biceps","Brachialis"}', '{}', 'Stand with feet hip-width apart, toes pointed forward, and chest tall.
Extend your leg straight out; extend both arms in front of you, at shoulder level. Brace your core and look straight ahead.
Slowly squat down.
(optional) pause at the bottom.

Keep your (free) leg and arms extended for the whole duration.', 'https://wger.de/media/exercise-images/456/3b681e59-377b-40db-9113-ca5873ce084b.jpg', null, 'wger', 'fe04cf35-1af5-4b51-89d4-c38d7eaa0db1', 'CC-BY-SA 3', 'minifigmaster125'),
  ('Pull Ups on Machine', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Biceps","Trapezius"}', '{}', null, null, 'https://wger.de/media/exercise-video/477/2e23bb52-2782-40c8-bf88-fa2d2e2a9a0d.MOV', 'wger', '7f834f07-fa7b-46b6-8ffa-45930b0602db', 'CC-BY-SA 3', 'wger.de'),
  ('Pull-ups', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Biceps","Trapezius"}', '{"Pull-up bar"}', 'Grab the pull up bar with a wide grip, the body is hanging freely. Keep your chest out and pull yourself up till your chin reaches the bar or it touches your neck, if you want to pull behind you. Go with a slow and controlled movement down, always keeping the chest out.', 'https://wger.de/media/exercise-images/475/b0554016-16fd-4dbe-be47-a2a17d16ae0e.jpg', 'https://wger.de/media/exercise-video/475/83067ffe-ccb9-4e22-8507-5131b211ce74.MOV', 'wger', '8e420408-0682-4ab6-89f5-2681e54c7ce0', 'CC-BY-SA 3', 'wger.de'),
  ('Plank', 'isolation', false, false, true, 'Abs', '{"Obliquus externus abdominis","Abs"}', '{"Biceps","Quads","Triceps"}', '{"Bodyweight"}', 'Get into a position on the floor supporting your weight on your forearms and toes. Arms are bent and directly below the shoulder.

Keep your body straight at all times and hold this position as long as possible. To increase difficulty an arm or leg can be raised while performing this exercise.', 'https://wger.de/media/exercise-images/458/b7bd9c28-9f1d-4647-bd17-ab6a3adf5770.png', null, 'wger', 'c9e57bbe-e839-44c6-861d-1c8dd2845e36', 'CC-BY-SA 3', 'YYCfit / BFad07'),
  ('Scissors', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{}', 'Scissors is an abdominal exercise that strengthens the transverse abdominals, helping flatten your belly and strengthen your entire core. Scissors is not only a core strength move, but it is also a great stretch for your hamstrings and your lower back. Everyone is looking for new ways to work the core, to flatten the belly and to improve flexibility. If you learn how to do Scissors you will get everything rolled together in one move.', null, null, 'wger', 'e28b0685-7a8f-4343-9c0b-63b38386d30b', 'CC-BY-SA 4', 'vkylamba'),
  ('Rowing seated, narrow grip', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{}', 'Tighten muscles
Controlled movement
Slow movement
Keep upper body upright
Do not lean back
Pull toward chest', 'https://wger.de/media/exercise-images/512/b938437e-ff00-4679-9036-acb41bb28bbd.png', 'https://wger.de/media/exercise-video/512/fff4c294-93f0-4926-b3a2-bf59ad4afaa5.MOV', 'wger', '00fcf603-b0d0-48d2-9b5e-c7f0d510d46c', 'CC-BY-SA 3', 'wger.de'),
  ('Reverse Bar Curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"SZ-Bar"}', 'Hold bar with reverse (or "overhand") grip, palms facing the floor.', null, null, 'wger', '834c639f-4c82-404d-909f-4c75275465a0', 'CC-BY-SA 3', 'tuckerm'),
  ('Renegade Row', 'pull_h', false, false, false, 'Back', '{"Lats","Trapezius"}', '{}', '{"Dumbbell"}', 'Get into pushup position gripping some dumbbells. Perform one pushup, then drive your left elbo up, bringing the dumbell up to your body. Return the dumbell to starting position.

Perform another pushup and then row with the other arm to complete one rep.', null, null, 'wger', '2b6c09f7-dbf1-45ea-baf6-9a12e0b12396', 'CC0', 'fletchgraham'),
  ('Rowing, T-bar', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Shoulders","Biceps","Brachialis"}', '{}', 'The execution of this exercise is very similar to the regular bent over rowing, only that the bar is fixed here.

Grab the barbell with a wide grip (slightly more than shoulder wide) and lean forward. Your upper body is not quite parallel to the floor, but forms a slight angle. The chest''s out during the whole exercise. Pull now the barbell with a fast movement towards your belly button, not further up. Go slowly down to the initial position. Don''t swing with your body and keep your arms next to your body.', 'https://wger.de/media/exercise-images/106/T-bar-row-1.png', null, 'wger', '32c129f7-cc28-4ebc-8465-e4fa62e220b1', 'CC-BY-SA 3', 'wger.de'),
  ('Seated Triceps Press', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Bench","Dumbbell"}', 'Sit down on a back (better with back support). Take a dumbbell firmly with both hands and hold it with extended arms over your head. With your palms facing upward and holding the weight of the dumbbell, slowly lower the weight behind your head.', null, null, 'wger', 'cc5bf1a3-29b5-4c5a-8600-5e35c79ab4bf', 'CC-BY-SA 4', 'richmr2174@gmail.com'),
  ('Row', 'pull_h', false, false, true, 'Back', '{"Lats","Trapezius"}', '{"Quads"}', '{"Barbell","Dumbbell","Pull-up bar"}', 'In strength training, rowing (or a row, usually preceded by a qualifying adjective — for instance a seated row) is an exercise where the purpose is to strengthen the muscles that draw the rower''s arms toward the body (latissimus dorsi) as well as those that retract the scapulae (trapezius and rhomboids) and those that support the spine (erector spinae). When done on a rowing machine, rowing also exercises muscles that extend and support the legs (quadriceps and thigh muscles). In all cases, the abdominal and lower back muscles must be used in order to support the body and prevent back injury.', null, null, 'wger', '4b7cb037-0789-4014-ab6f-a451716b7538', 'CC0', 'BFad07'),
  ('Rowing, Lying on Bench', 'push_h', false, false, false, 'Back', '{"Lats"}', '{}', '{}', null, null, null, 'wger', '88dbcc74-0304-4fcf-8a47-92d14a484b0a', 'CC-BY-SA 3', 'wger.de'),
  ('Ring Dips', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{}', 'Dips peformed on gymnastic rings.', null, null, 'wger', '7671b16c-5023-4663-b00d-86dd018e024f', 'CC-BY-SA 4', 'Nash'),
  ('Shoulder Press, on Machine', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Triceps"}', '{}', null, 'https://wger.de/media/exercise-images/53/Shoulder-press-machine-2.png', 'https://wger.de/media/exercise-video/543/dbfd396b-1aab-4a64-a50b-2c31ff0a2cf7.MOV', 'wger', '5912d7ed-6a0e-4b4c-b30a-fc9f3f890fc1', 'CC-BY-SA 3', 'wger.de'),
  ('Reverse Grip Bench Press', 'push_h', false, false, true, 'Chest', '{"Chest","Triceps"}', '{"Shoulders"}', '{"Barbell","Bench"}', 'Upper chest focuses exercise that also works triceps', null, null, 'wger', '1b95d961-1d5c-4ded-b25e-c090295ffe37', 'CC-BY-SA 4', 'bl0sh'),
  ('Incline Bench Press - Barbell', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{"Barbell","Incline bench"}', 'To do slowly, tempo is 4010', 'https://wger.de/media/exercise-images/41/Incline-bench-press-1.png', 'https://wger.de/media/exercise-video/538/4349a6f6-4cee-4c09-828b-c5e7fc2c1ff1.MOV', 'wger', '275fb49f-975c-4d6e-9d63-2c86ed740f40', 'CC-BY-SA 3', 'wger.de'),
  ('Splinter Sit-ups', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{}', '{}', 'Lie on your back with your legs straight and arms at your sides, keeping your elbows bent at 90 degrees. As you sit up, twist your upper body to the right and bring your left knee toward your right elbow while you swing your left arm back. Lower your body to the starting position, and repeat to your right. That''s 1 rep.', null, null, 'wger', 'eaf6f39e-d46d-4460-b5a9-71e814b18f89', 'CC-BY-SA 3', 'djblitzd'),
  ('Shoulder Press, on Multi Press', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{}', 'The exercise is basically the same as with a free barbell:

Sit on a bench, the back rest should be almost vertical. Take a bar with a shoulder wide grip and bring it down to chest height. Press the weight up, but don''t stretch the arms completely. Go slowly down and repeat.', null, null, 'wger', '141bc870-56be-4749-a3b9-e56d5d5618b4', 'CC-BY-SA 3', 'wger.de'),
  ('Sit-ups', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{}', 'Sit on a mat, your calves are resting on a bench, the knees make a right angle. Hold your hands behind your neck. Go now up with a rolling movement of your back, you should feel how the individual vertebrae lose contact with the mat. At the highest point, contract your abs as much as you can and hold there for 2 sec. Go now down, unrolling your back.', null, null, 'wger', 'f38e9c23-031d-44d0-ac27-7f1026212c73', 'CC-BY-SA 3', 'wger.de'),
  ('Shoulder Press, Dumbbells', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'Sit on a bench, the back rest should be almost vertical. Take two dumbbells and bring them up to shoulder height, the palms and the elbows point during the whole exercise to the front. Press the weights up, at the highest point they come very near but don''t touch. Go slowly down and repeat.', 'https://wger.de/media/exercise-images/123/dumbbell-shoulder-press-large-1.png', 'https://wger.de/media/exercise-video/567/64f33c19-1d96-4b7c-af17-6c6a4941c614.MOV', 'wger', '87affa4b-395b-437c-9581-2bd20ea5aa7c', 'CC-BY-SA 3', 'wger.de'),
  ('Shoulder Press, Barbell', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Barbell"}', 'Sit on a bench, the back rest should be almost vertical. Take a barbell with a shoulder wide grip and bring it up to chest height. Press the weight up, but don''t stretch the arms completely. Go slowly down and repeat.', 'https://wger.de/media/exercise-images/119/seated-barbell-shoulder-press-large-1.png', null, 'wger', '8b0a0371-c0a9-42a7-aab7-68d520542fb2', 'CC-BY-SA 3', 'wger.de'),
  ('Single-arm Preacher Curl', 'isolation', true, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Sit on the preacher curl bench and perform a bicep curl with a dumbbell in one hand. Your other hand can be at rest, or beneath your curling arm''s elbow.', null, 'https://wger.de/media/exercise-video/584/109e8d5d-62a4-40ad-8813-2ccef5bc751f.MOV', 'wger', 'c85e6137-2577-4e28-82c2-427407d534eb', 'CC-BY-SA 3', 'tuckerm'),
  ('Sitting Calf Raises', 'isolation', false, true, false, 'Calves', '{"Soleus"}', '{"Calves"}', '{}', 'Sit on a bench for calf raises and check that the feet are half free and that you can completely stretch the calf muscles down. Pull your calves up, going as far (up) as you can. Make at the highest point a short pause of 1 or 2 seconds and go down.', null, 'https://wger.de/media/exercise-video/590/a325ae2e-686b-4a1f-aff2-ba37fa3fa157.MOV', 'wger', '6e46833d-fd83-4c1a-90af-eb3f3a917199', 'CC-BY-SA 3', 'wger.de'),
  ('Side to Side Push Ups', 'push_h', false, false, true, 'Chest', '{"Shoulders","Obliquus externus abdominis","Chest","Triceps"}', '{}', '{}', '-start in push up position

-lean the body weight to the right side, and complete a push up with the chest over the right hand

-come back to the centered position

-on rep 2, lean to the left side', null, null, 'wger', '9374fdaf-411f-4ae6-8f0c-21cc2d3dc667', 'CC-BY-SA 4', 'nate303303'),
  ('Smith Machine Close-grip Bench Press', 'push_h', false, false, false, 'Arms', '{"Triceps"}', '{"Chest"}', '{}', 'Perform a standard bench press on the smith machine, but have your hands on the bar about shoulder width apart, and keep your elbows close to your body.', null, null, 'wger', '092d0fbb-0409-470e-a087-beb9a378f3f7', 'CC-BY-SA 3', 'tuckerm'),
  ('Side Crunch', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Gym mat"}', 'Hold weight in one hand. Bend side ways to the knee. Pull upo to upright position using your obliquus.', 'https://wger.de/media/exercise-images/176/Cross-body-crunch-1.png', null, 'wger', '2f8ee51b-f493-47f7-8b2a-1da16c128f73', 'CC-BY-SA 3', 'kwrindy'),
  ('Shrugs, Barbells', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Barbell"}', 'Take a barbell and stand with a straight body, the arms are hanging freely in front of you. Lift from this position the shoulders as high as you can, but don''t bend the arms during the movement. On the highest point, make a short pause of 1 or 2 seconds before returning slowly to the initial position.

When training with a higher weight, make sure that you still do the whole movement!', 'https://wger.de/media/exercise-images/150/Barbell-shrugs-1.png', null, 'wger', '270e108d-3cd2-45a9-807b-c357317eb15c', 'CC-BY-SA 3', 'wger.de'),
  ('Shrugs on Multipress', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{"Triceps"}', '{}', null, null, 'https://wger.de/media/exercise-video/575/a7d99f2b-86fc-433a-8ab1-83144c802296.MOV', 'wger', '6199b3c7-3ccb-47fa-89bb-ef7fef12c0e3', 'CC-BY-SA 3', 'wger.de'),
  ('Shrugs, Dumbbells', 'push_v', false, false, false, 'Shoulders', '{"Shoulders"}', '{}', '{"Dumbbell"}', 'Stand with straight body, the hands are hanging freely on the side and hold each a dumbbell. Lift from this position the shoulders as high as you can, but don''t bend the arms during the movement. On the highest point, make a short pause of 1 or 2 seconds before returning slowly to the initial position.

When training with a higher weight, make sure that you still do the whole movement!', 'https://wger.de/media/exercise-images/151/Dumbbell-shrugs-2.png', null, 'wger', '72a945ec-3a7f-424b-9a05-1616ef7dce91', 'CC-BY-SA 3', 'wger.de'),
  ('Shoulder Shrug', 'push_v', false, false, false, 'Shoulders', '{"Trapezius"}', '{}', '{"Bodyweight"}', 'The shoulder shrug (usually called simply the shrug) is an exercise in weight training used to develop the upper trapezius muscle. The lifter stands erect, hands about shoulder width apart, and raises the shoulders as high as possible, and then lowers them, while not bending the elbows, or moving the body at all. The lifter may not have as large a range of motion as in a normal shrug done for active flexibility. It is usually considered good form if the slope of the shoulders is horizontal in the elevated position.', 'https://wger.de/media/exercise-images/570/68b4a33f-40f1-4dda-b56c-a2e20ed13903.jpg', 'https://wger.de/media/exercise-video/570/bd1f14a3-9d2b-4ec0-b6b9-e82d739f7e60.MOV', 'wger', 'f956977e-cc05-4db2-a387-ba6140b1ef34', 'CC0', 'BFad07'),
  ('Side Plank', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Works your obliques and helps stabilize your spine. Lie on your side and support your body between your forearm and knee to your feet.', null, null, 'wger', 'e1b99153-0102-47fc-b0cd-c21509827b0b', 'CC-BY-SA 4', 'http://www.bodybuilding.com/'),
  ('Sumo Squats', 'squat', false, true, false, 'Legs', '{"Glutes","Quads"}', '{}', '{"Bodyweight"}', 'Stand with your feet wider than your shoulders, with your toes pointed out at a 45 degree angle and barbell on your shoulder.

While keeping your back straight, descend slowly by bending at the knees and hips as if you are sitting down (squatting).

Lower yourself until your quadriceps and hamstrings are parallel to the floor.

Return to the starting position by pressing upwards and extending your legs while maintaining an equal distribution of weight on your forefoot and heel.', null, null, 'wger', '0a5a7661-1e24-4c15-bb2b-503672141307', 'CC-BY-SA 4', 'sophialj'),
  ('Squat Thrust', 'squat', false, true, true, 'Legs', '{"Glutes","Quads","Abs","Soleus"}', '{}', '{"Bodyweight"}', 'The burpee, or squat thrust, is a full body exercise used in strength training and as an aerobic exercise. The basic movement is performed in four steps and known as a four-count burpee: Begin in a standing position. Move into a squat position with your hands on the ground. (count 1) Kick your feet back into a plank position, while keeping your arms extended. (count 2) Immediately return your feet into squat position. (count 3) Stand up from the squat position (count 4)', null, null, 'wger', '30ac081b-fb79-4253-9457-8efc07568790', 'CC0', 'BFad07'),
  ('Stiff-legged Deadlifts', 'squat', false, true, false, 'Legs', '{"Hamstrings"}', '{"Glutes"}', '{"Barbell"}', 'Keep legs straight
Keep back straight', null, null, 'wger', '22c59ede-970b-43e1-bb51-ac1c2be0b0e0', 'CC-BY-SA 3', 'tuckerm'),
  ('Standing Calf Raises', 'isolation', false, true, false, 'Calves', '{"Calves"}', '{"Soleus"}', '{}', 'Get onto the calf raises machine, you should able to completely push your calves down. Stand straight, don''t make a hollow back and don''t bend your legs. Pull yourself up as high as you can. Make a small pause of 1 - 2 seconds and go slowly down.', 'https://wger.de/media/exercise-images/622/9a429bd0-afd3-4ad0-8043-e9beec901c81.jpeg', 'https://wger.de/media/exercise-video/622/35b7b625-77fd-4c09-8c57-3ad0f2f23175.MOV', 'wger', '7ce443b6-eb84-4f65-b05f-461c1cc8bcc0', 'CC-BY-SA 3', 'wger.de'),
  ('Squat Jumps', 'squat', false, true, false, 'Legs', '{"Quads"}', '{}', '{}', 'Jump wide, then close', null, null, 'wger', '5c0824dc-f2fb-4d19-a1e5-7c33219ad51d', 'CC-BY-SA 3', 'OGhTebfCxhexZXuf35mUxV9C--A'),
  ('Squats', 'squat', false, true, false, 'Legs', '{"Quads"}', '{"Glutes"}', '{"Barbell"}', 'Place a barbell in a rack just below shoulder-height. Dip under the bar to put it behind the neck across the top of the back, and grip the bar with the hands wider than shoulder-width apart. Lift the chest up and squeeze the shoulder blades together to keep the straight back throughout the entire movement. Stand up to bring the bar off the rack and step backwards, then place the feet so that they are a little wider than shoulder-width apart. Sit back into hips and keep the back straight and the chest up, squatting down so the hips are below the knees. From the bottom of the squat, press feet into the ground and push hips forward to return to the top of the standing position.', null, null, 'wger', 'a2f5b6ef-b780-49c0-8d96-fdaff23e27ce', 'CC-BY-SA 3', 'wger.de'),
  ('Underhand Lat Pull Down', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{"Biceps"}', '{}', 'Grip the pull-down bar with your palms facing you and your hands closer than shoulder-width apart. Lean back slightly and keep your back straight. Pull the bar down towards your chest, pulling your shoulders back slightly at the end of the motion.', null, null, 'wger', '76965848-9776-4be5-b879-e3c97033b80f', 'CC-BY-SA 3', 'tuckerm'),
  ('Upright Row w/ Dumbbells', 'pull_h', false, false, true, 'Shoulders', '{"Shoulders","Trapezius"}', '{"Biceps"}', '{"Dumbbell"}', 'Hold a dumbbell in each hand in front of your body. Keep your palms towards your body. Lift you hands straight up until your hands are under your chin, then lower them. Repeat the exercise.', 'https://wger.de/media/exercise-images/694/119e6823-6960-4341-a9e1-aaf78d7fb57c.png', null, 'wger', '01976085-6701-45ea-b152-5c46ba60550d', 'CC-BY-SA 4', 'koreyhinton'),
  ('Sumo Deadlift', 'hinge', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{"Trapezius"}', '{}', 'Begin with a bar loaded on the ground. Approach the bar so that the bar intersects the middle of the feet. The feet should be set very wide, near the collars. Bend at the hips to grip the bar. The arms should be directly below the shoulders, inside the legs, and you can use a pronated grip, a mixed grip, or hook grip. Relax the shoulders, which in effect lengthens your arms.
Take a breath, and then lower your hips, looking forward with your head with your chest up. Drive through the floor, spreading your feet apart, with your weight on the back half of your feet. Extend through the hips and knees.
As the bar passes through the knees, lean back and drive the hips into the bar, pulling your shoulder blades together.
Return the weight to the ground by bending at the hips and controlling the weight on the way down.', 'https://wger.de/media/exercise-images/630/b0f0c7d8-5878-4d9e-b820-21acc013741d.webp', null, 'wger', '0c2d9b74-3d1e-481f-a7bf-3b3532f7d6b0', 'CC-BY-SA 4', 'magdy'),
  ('Leg Press', 'squat', false, true, true, 'Legs', '{"Hamstrings","Calves","Glutes","Quads"}', '{}', '{}', 'The leg press is a weight training exercise in which the individual pushes a weight or resistance away from them using their legs.', 'https://wger.de/media/exercise-images/371/d2136f96-3a43-4d4c-9944-1919c4ca1ce1.webp', 'https://wger.de/media/exercise-video/371/6aae16b4-01b9-4eb4-935c-3250f84d2c59.MOV', 'wger', '66a42396-c207-44da-bc75-758a89d32404', 'CC0', 'BFad07'),
  ('Preacher Curls', 'isolation', false, false, false, 'Arms', '{"Brachialis"}', '{}', '{"SZ-Bar"}', 'Place the EZ curl bar on the rest handles in front of the preacher bench. Lean over the bench and grab the EZ curl bar with palms up. Sit down on the preacher bench seat so your upper arms rest on top of the pad and your chest is pressed against the pad. Lower the weight until your elbows are extended and arms are straight. Bring the weights back up to the starting point by contracting biceps. Repeat', 'https://wger.de/media/exercise-images/193/Preacher-curl-3-1.png', 'https://wger.de/media/exercise-video/465/b64ca95b-c677-4f3b-bb50-f75edc81aa74.MOV', 'wger', 'dd52fb99-9426-4a78-b446-20a8e3e4ec47', 'CC-BY-SA 3', 'cgoob883'),
  ('Standing Bicep Curl', 'isolation', false, false, false, 'Arms', '{"Biceps","Brachialis"}', '{}', '{"Dumbbell"}', 'Stand holding dumbbells at shoulder width apart. Face forearm upward and keep upper arm still while raising each dumbbell up to your shoulder.', null, null, 'wger', 'eb61c7a1-e1c9-4c44-a8ce-2bbe98a39857', 'CC0', 'BFad07'),
  ('Military Press mit SZ-Bar', 'push_v', false, false, true, 'Shoulders', '{"Shoulders"}', '{"Trapezius","Triceps"}', '{"SZ-Bar"}', 'On an SZ-bar grip your hands on the outside of each bend and stand with your arms straight down, palms facing your legs. Pull the bar (bending your arms at the elbow) to your chest, and the push the bar above your head (arms as straight as possible). Return the bar to your chest by dropping your arms at the elbows. Return the bar to it''s origional position (stand with your arms straight down, palms facing your legs.)', 'https://wger.de/media/exercise-images/418/fa2a2207-43cb-4dc0-bc2a-039e32544790.png', null, 'wger', '7b1e458f-1857-4c2f-8463-7d67d4b2db93', 'CC-BY-SA 3', 'mbozi1'),
  ('Romanian Deadlift', 'hinge', false, true, true, 'Legs', '{"Hamstrings","Glutes"}', '{"Trapezius"}', '{"Barbell"}', 'DL from top to pos 2: https://www.youtube.com/watch?v=WtWtjViRsKo', null, 'https://wger.de/media/exercise-video/507/307e7276-a14d-4ea0-b579-f5b0dbc6f5af.MOV', 'wger', '2e7ffff9-e603-4b28-98c8-31d1a6ce8cd9', 'CC-BY-SA 4', 'pjwirth'),
  ('Incline Plank With Alternate Floor Touch', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{"Obliquus externus abdominis"}', '{"Bodyweight"}', 'Perform the plank with legs elevated, feet on a gymball. Once stabilised, slowly move one foot sideways off the ball, then make it touch the floor, then come back to starting position. Alternate with the other foot.

This is a core exercise.', null, null, 'wger', 'aae91ecf-ffa4-4730-812c-cb00e423f91c', 'CC-BY-SA 3', 'Mahoney'),
  ('Shotgun Row', 'pull_h', false, false, false, 'Back', '{"Lats"}', '{}', '{"Cable machine"}', 'Attach a single handle to a low cable.
After selecting the correct weight, stand a couple feet back with a wide-split stance. Your arm should be extended and your shoulder forward. This will be your starting position.
Perform the movement by retracting the shoulder and flexing the elbow. As you pull, supinate the wrist, turning the palm upward as you go.
After a brief pause, return to the starting position.', null, null, 'wger', '169896b2-90e3-4497-9d73-56bee4a34697', 'CC-BY-SA 4', 'cal.zabel'),
  ('Straight-arm Pull Down (bar Attachment)', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{"Triceps"}', '{"Cable machine"}', 'Use the straight bar attachment on a high pulley. Grasp the two ends of the bar with your palms facing downward and your arms straight out in front of you. Pull your hands down towards your hips, while keeping your arms straight, then raise them back up to the starting position.', null, null, 'wger', '0f5fc602-afb6-4500-87da-f115f3ef3f47', 'CC-BY-SA 3', 'tuckerm'),
  ('Straight-arm Pull Down (rope Attachment)', 'pull_v', false, false, false, 'Back', '{"Lats"}', '{"Triceps"}', '{"Cable machine"}', 'Use the rope attachment on a high pulley. Grasp the two ends of the rope with your arms straight out in front of you. Pull your hands down towards your hips, while keeping your arms straight, then raise them back up to the starting position.', null, null, 'wger', '2f7149c3-77ce-4313-a59c-aef82b5a730a', 'CC-BY-SA 3', 'tuckerm'),
  ('Triceps Extensions on Cable With Bar', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'Grab the bar, stand with your feet shoulder wide, keep your back straight and lean forward a little. Push the bar down, making sure the elbows don''t move during the exercise. Without pause go back to the initial position.', null, null, 'wger', 'f00630d6-578f-487f-8bf5-39c96366ccb8', 'CC-BY-SA 3', 'wger.de'),
  ('V-Bar Pulldown', 'pull_v', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{"Cable machine"}', 'Pulldowns using close grip v-bar.', null, null, 'wger', 'd847301e-1613-4987-85cd-61d3ff9d7ef8', 'CC-BY-SA 4', 'apeschel'),
  ('Calf raises, one legged', 'isolation', false, true, false, 'Calves', '{"Calves"}', '{}', '{}', null, null, null, 'wger', '4e752292-051a-4043-8f80-a390c23875e6', 'CC-BY-SA 4', 'McMarcel13'),
  ('Upright Row, SZ-bar', 'pull_h', false, false, true, 'Shoulders', '{"Shoulders","Trapezius"}', '{"Biceps"}', '{"SZ-Bar"}', 'Stand straight, your feet are shoulder-width apart. Hold the SZ-bar with an overhand grip on your thighs, the arms are stretched. Lift the bar close to the body till your chin. The elbows point out so that at the highest point they form a V. Make here a short pause before going slowly down and repeating the movement.', 'https://wger.de/media/exercise-images/693/05c91bd2-7814-40b6-b2d1-51ae942b8321.png', null, 'wger', '5d40c67d-be59-4092-9c9c-301ca5310e2b', 'CC-BY-SA 3', 'wger.de'),
  ('Wall Pushup', 'push_h', false, false, true, 'Arms', '{"Shoulders","Chest","Triceps"}', '{"Glutes","Abs","Serratus anterior","Trapezius"}', '{"Bodyweight"}', 'Pushup against a wall', null, null, 'wger', '51a80676-92d8-4f91-b51a-4666888e40db', 'CC-BY-SA 3', 'Dexter'),
  ('Upright Row, on Multi Press', 'pull_h', false, false, true, 'Shoulders', '{"Shoulders","Trapezius"}', '{"Biceps"}', '{}', 'The movements are basically the same as with an SZ-bar, but you use the bar on the multi press:

Stand straight, your feet are shoulder-width apart. Hold the bar with an overhand grip on your thighs, the arms are stretched. Lift the bar close to the body till your chin. The elbows point out so that at the highest point they form a V. Make here a short pause before going slowly down and repeating the movement.', 'https://wger.de/media/exercise-images/691/297d4ce1-7e9e-4adb-8f5c-7d54054be885.jpg', null, 'wger', '738137c0-5387-4215-b457-ea7af113b3ba', 'CC-BY-SA 3', 'wger.de'),
  ('Dumbbell Concentration Curl', 'isolation', false, false, false, 'Arms', '{"Brachialis"}', '{"Biceps"}', '{"Dumbbell"}', 'Sit on bench. Grasp dumbbell between feet. Place back of upper arm to inner thigh. Lean into leg to raise elbow slightly.', null, null, 'wger', '46e0f60c-fdc0-489a-82e4-a5b7476a5c21', 'CC-BY-SA 3', 'http://www.exrx.net/WeightExercises/Brachialis/DBC'),
  ('Incline Bench Press - Dumbbell', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Triceps"}', '{"Dumbbell","Incline bench"}', 'This is a variation of the flat bench press designed to emphasize the clavicular head of the pectoralis major (the upper portion). By tilting the torso, the angle of the push changes, shifting more tension to the upper chest and shoulders, which helps achieve a more aesthetic, balanced, and three-dimensional development of the torso.

Bench Adjustment and Preparation: Set the bench to an incline of between 30 and 45 degrees (an incline greater than 45° will place too much strain on the shoulders and reduce the stimulus to the chest). Sit down with a dumbbell on each thigh.

Starting position: Lean back, resting your back against the bench, while using your knees one after the other to push the dumbbells upward to shoulder height.

Anatomical Stabilization: Plant your feet firmly on the floor. Retract your scapulas (bring your shoulder blades together and press them into the bench) to protect your shoulders and stabilize the load.

Eccentric Phase (Lowering): Lower the dumbbells slowly and in a controlled manner toward the upper part of your chest. Your elbows should not splay out to the sides (90°); maintain a safe angle of about 45 to 60 degrees relative to your torso.

Concentric Phase (Lift): Push the dumbbells vertically upward as you exhale. Follow a slightly converging path (without letting them touch at the top). Stop the movement just before locking out your elbows to maintain muscle tension in the upper pectoral.', 'https://wger.de/media/exercise-images/16/Incline-press-1.png', 'https://wger.de/media/exercise-video/537/b9c937e9-daeb-42a9-be8e-7a77e368478c.MOV', 'wger', '57e17672-52b9-43cf-8d0d-4b3f06a0c0d0', 'CC-BY-SA 3', 'wger.de'),
  ('Wall Squat', 'squat', false, true, false, 'Legs', '{"Hamstrings","Quads"}', '{}', '{"Bodyweight"}', 'Find a nice flat piece of wall and stand with your back leaning against the wall. Slowly slide down the wall while moving your feet away from it, until your thighs are parallel to the ground and both your knees and your hips are bent at a 90° angle. Cross your arms in front of your chest and hold this position for 30 seconds.

Variant: put a big inflated rubber ball (like a small basketball) between your knees and squeeze the ball while holding the squat position', null, null, 'wger', '46ee5805-512a-43a2-944c-97f7744b0078', 'CC0', 'Blablabla'),
  ('Alternating dumbbell hammer curl', 'isolation', false, false, false, 'Arms', '{"Biceps"}', '{}', '{"Dumbbell"}', 'Stand with your knees slightly bent and your back straight. Hold a dumbbell in each hand, using a neutral grip at your sides.', 'https://wger.de/media/exercise-images/1567/0a8c155c-a48e-47e8-9df3-e39f025c6cad.png', null, 'wger', 'eb9476ac-2c00-4f49-a40f-f81682161a75', 'CC-BY-SA 4', 'Mariano_O'),
  ('Straddle L-Sit', 'isolation', false, false, true, 'Abs', '{"Abs"}', '{"Lats","Chest","Quads","Serratus anterior"}', '{"Bodyweight"}', 'With your legs in a sitting saddle position, push your body upwards off the ground. Your legs should be horizontal and point straight outwards. Your arms should be between your legs.

Hold isometrically as long as required.', null, null, 'wger', 'd2cf769a-9271-41ae-90fc-aef813e41740', 'CC-BY-SA 4', 'Croak6728'),
  ('L-sit', 'isolation', false, false, true, 'Abs', '{"Lats","Chest","Abs"}', '{"Quads","Triceps"}', '{"Bodyweight"}', 'Sit on the ground with your legs together and your arms by your sides. Push your body off the ground using your hands, maintaining the same sitting position so that your legs are straight and your feet do not touch the floor.

Hold for as long as required.', null, null, 'wger', '16202754-f567-4d23-a866-2c9cc8eba71d', 'CC-BY-SA 4', 'Croak6728'),
  ('L-Sit (Foot Supported)', 'isolation', false, false, true, 'Abs', '{"Lats","Chest","Abs","Serratus anterior"}', '{"Quads","Triceps"}', '{"Bodyweight"}', 'As with an L-sit, but allow your feet to touch the floor to support the some of the weight of your legs.', null, null, 'wger', 'a092afaf-aa5a-4384-b407-a6b52cf1c008', 'CC-BY-SA 4', 'Croak6728'),
  ('Overhead Squat', 'squat', false, true, true, 'Legs', '{"Glutes","Quads"}', '{"Shoulders","Hamstrings","Trapezius"}', '{}', 'The barbell is held overhead in a wide-arm snatch grip; however, it is also possible to use a closer grip if balance allows.', null, null, 'wger', 'bc45125b-58da-4ee9-8895-16a7b930b789', 'CC-BY-SA 4', 'geraldbaeck'),
  ('Rowing with TRX band', 'pull_h', false, false, true, 'Back', '{"Lats"}', '{"Biceps","Trapezius"}', '{"Bodyweight"}', 'Rowing with resistance bands - Bodyweight Exercise', null, null, 'wger', '8766d43c-e035-4c37-b824-b94dce5bf710', 'CC-BY-SA 4', 'Skadi'),
  ('Crunches With Cable', 'isolation', false, false, false, 'Abs', '{"Abs"}', '{}', '{"Cable machine"}', 'Take the cable on your hands and hold it next to your temples. Knee down and hold your upper body straight and bend forward. Go down with a fast movement, rolling your back in (your ellbows point to your knees). Once down, go slowly back to the initial position.', null, null, 'wger', '29175281-afaf-4ffd-85e8-cfc38493e304', 'CC-BY-SA 3', 'wger.de'),
  ('Triceps Extensions on Cable', 'isolation', false, false, false, 'Arms', '{"Triceps"}', '{}', '{"Cable machine"}', 'Grab the cable, stand with your feet shoulder wide, keep your back straight and lean forward a little. Push the bar down, making sure the elbows don''t move during the exercise. Rotate your hands outwards at the very end and go back to the initial position without pause.', 'https://wger.de/media/exercise-images/659/a60452f1-e2ea-43fe-baa6-c1a2208d060c.png', 'https://wger.de/media/exercise-video/659/1f2eb3b6-3185-429f-8330-26dc88f39aff.MOV', 'wger', '3188868c-84e2-4a3b-b7dc-f79d8650988d', 'CC-BY-SA 3', 'wger.de'),
  ('Dumbbell Floor Press', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Biceps","Triceps"}', '{"Dumbbell"}', 'Grab your dumbbells and lay flat on your back with your knees bent and your feet flat on the ground (use a bench if you have one). Press the weights up, locking out your elbows (A). Lower them slowly until your upper arms are resting on the floor (B) close to your body. Pause here before explosively pressing back up. Squeeze your chest hard and repeat.', 'https://wger.de/media/exercise-images/1084/91dd5a95-1c45-46f2-a074-de41b6ad599b.jpg', null, 'wger', 'e4966cb8-9089-4595-9c78-99a27821e6ff', 'CC-BY-SA 4', 'admin'),
  ('Side bend', 'isolation', false, false, false, 'Abs', '{"Obliquus externus abdominis"}', '{"Abs"}', '{"Dumbbell"}', 'With a weight in one hand, extend that arm down and bend the other arm, resting your hand on your head. Now move the hand holding the weight by rotating your torso up and down.', 'https://wger.de/media/exercise-images/1188/43e714e4-b736-4f3a-8ab4-97821fdff86a.jpg', null, 'wger', 'd36fdd3c-9a35-4643-a3fd-57db78c866d6', 'CC-BY-SA 4', null),
  ('Barbell Full Squat', 'squat', false, true, true, 'Legs', '{"Hamstrings","Glutes","Quads"}', '{"Calves","Abs"}', '{"Barbell"}', 'The barbell full squat is a compound exercise that targets multiple muscle groups in the lower body, including the quadriceps, hamstrings, and glutes.
Proper form is crucial for maximizing results and preventing injuries during the barbell full squat. This includes maintaining a shoulder-width stance, creating whole body tension, controlling your descent, and maintaining proper depth and knee positioning.
Assistance moves such as the front squat, goblet squat, split squat, and Bulgarian split squat can help improve your performance in the barbell full squat by targeting specific muscle groups and improving overall technique.
To achieve new personal records in your back squat, gradually increase weight over time, vary rep ranges and sets to stimulate muscle growth, and prioritize rest and recovery between training sessions.', 'https://wger.de/media/exercise-images/1801/60043328-1cfb-4289-9865-aaf64d5aaa28.jpg', null, 'wger', '5d0e0a8b-1940-4034-b4ae-b965859f1ff0', 'CC-BY-SA 4', 'fabrice'),
  ('Push-Up', 'push_h', false, false, true, 'Chest', '{"Chest"}', '{"Shoulders","Abs","Triceps"}', '{"Bodyweight"}', 'The push-up is a fundamental bodyweight exercise that targets the chest, arms, and shoulders while engaging the core for stability. It requires no equipment and is excellent for building upper body strength.

Instructions:

Start in a plank position with hands placed slightly wider than shoulder-width, feet together, and body in a straight line from head to heels.
Engage your core and lower your body by bending your elbows, keeping them close to your body or flared slightly outward.
Lower until your chest nearly touches the ground while maintaining a neutral spine.
Push through your palms to return to the starting position, fully extending your arms.', 'https://wger.de/media/exercise-images/1551/a6a9e561-3965-45c6-9f2b-ee671e1a3a45.png', null, 'wger', 'f5b84269-18af-4464-a61f-b767cbcd81dc', 'CC-BY-SA 4', 'Settebello'),
  ('Kickstand RDL', 'hinge', false, true, false, 'Legs', '{"Hamstrings"}', '{}', '{"Barbell"}', 'use non-working leg''s toes to help with balance and perform an RDL.', null, null, 'wger', '107ea68a-d976-49ed-be75-3b0cf253c36a', 'CC-BY-SA 4', 'eriktrinkle'),
  ('Single Leg Extension', 'squat', true, true, false, 'Legs', '{"Quads"}', '{}', '{}', null, null, null, 'wger', '046fce45-69f2-46f7-a5b6-79a25a485af1', 'CC-BY-SA 3', 'wger.de')
on conflict (name) do update set
  category          = excluded.category,
  primary_muscles   = excluded.primary_muscles,
  secondary_muscles = excluded.secondary_muscles,
  equipment         = excluded.equipment,
  description       = excluded.description,
  image_url         = excluded.image_url,
  video_url         = excluded.video_url,
  source            = excluded.source,
  source_id         = excluded.source_id,
  license           = excluded.license,
  license_author    = excluded.license_author;


-- ============================================================
-- 20250101000015_push_subscriptions.sql
-- ============================================================

-- Migration: web push subscriptions
--
-- The free-window engine knows more about your availability than any
-- off-the-shelf calendar, because it accounts for shifts and sleep. But it only
-- speaks when someone opens the app. This is the table that lets it speak
-- first.
--
-- iOS 16.4+ supports web push, but ONLY for a PWA added to the home screen —
-- a Safari tab cannot subscribe. Both users have it installed, so this works,
-- but it explains why the UI must ask people to install before offering it.

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  -- The endpoint URL is the subscription's identity as far as the push service
  -- is concerned, so it is what uniqueness is keyed on. One person legitimately
  -- has several: phone, tablet, desktop.
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  -- Set when a push service returns 404/410, meaning the subscription is dead.
  -- Kept rather than deleted so a re-subscribe can be told apart from a first
  -- one when working out why somebody stopped receiving anything.
  failed_at   timestamptz,
  unique (endpoint)
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions(user_id) where failed_at is null;

alter table public.push_subscriptions enable row level security;

-- Deliberately NOT readable by the partner. Everything else in this app is
-- shared by design, but a push endpoint is a device identifier: it says which
-- devices someone owns and when they were registered. Nothing in the product
-- needs that, so nobody gets it.
drop policy if exists "read own push subscriptions" on public.push_subscriptions;
create policy "read own push subscriptions" on public.push_subscriptions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "insert own push subscriptions" on public.push_subscriptions;
create policy "insert own push subscriptions" on public.push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "delete own push subscriptions" on public.push_subscriptions;
create policy "delete own push subscriptions" on public.push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- What has already been announced, so a daily digest cannot repeat itself and
-- a rota edit cannot fire fifty times.
--
-- §1.3 windows are derived, never stored as truth, so this records only the
-- fact that a notification went out for a given day — not the windows
-- themselves, which are recomputed on read like everything else.
create table if not exists public.push_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  -- The local calendar day the notification was about, not when it was sent.
  subject_date date not null,
  kind         text not null default 'free_window',
  sent_at      timestamptz not null default now(),
  -- One notification per person per subject day per kind. This is the whole
  -- anti-spam mechanism, enforced by the database rather than by remembering
  -- to check in application code.
  unique (user_id, subject_date, kind)
);

create index if not exists push_log_user_sent_idx
  on public.push_log(user_id, sent_at desc);

alter table public.push_log enable row level security;

drop policy if exists "read own push log" on public.push_log;
create policy "read own push log" on public.push_log
  for select to authenticated using (user_id = auth.uid());
