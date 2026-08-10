-- ============================================================================
-- COUPLES LIFE APP — COMPLETE DATABASE SETUP
-- ============================================================================
-- Copy this ENTIRE file's contents into the Supabase SQL Editor and click Run.
-- Safe to run more than once (idempotent).
--
-- Creates: profiles, events, user_settings, steps_log, meals, recipes,
--          dietary_preferences, pantry_items
-- Plus:    RLS policies, auto-profile trigger, realtime publication
-- ============================================================================


-- ============================================================================
-- SECTION 1: TABLES
-- ============================================================================

-- profiles — one row per authenticated user (mirrors auth.users)
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Partner',
  identity_hue integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- events — shared calendar with optional RRULE recurrence
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

-- user_settings — key/value per user (e.g. daily_step_goal)
create table if not exists public.user_settings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  setting_key   text not null,
  setting_value text not null,
  updated_at    timestamptz not null default now(),
  unique(user_id, setting_key)
);

-- steps_log — one entry per user per day
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

-- meals — multiple meals per user per day
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

-- recipes — shared recipe book
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

-- dietary_preferences — one record per user
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

-- pantry_items — shared pantry
create table if not exists public.pantry_items (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  category   text default 'other',
  quantity   text,
  expires_at date,
  added_by   uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);


-- ============================================================================
-- SECTION 2: INDEXES
-- ============================================================================

create index if not exists events_user_time_idx   on public.events(user_id, start_time);
create index if not exists events_time_range_idx  on public.events(start_time, end_time);
create index if not exists user_settings_user_key_idx on public.user_settings(user_id, setting_key);
create index if not exists steps_user_date_idx    on public.steps_log(user_id, log_date);
create index if not exists meals_user_date_idx    on public.meals(user_id, meal_date);
create index if not exists recipes_tags_idx       on public.recipes using gin(tags);


-- ============================================================================
-- SECTION 3: ENABLE ROW LEVEL SECURITY
-- ============================================================================

alter table public.profiles            enable row level security;
alter table public.events              enable row level security;
alter table public.user_settings       enable row level security;
alter table public.steps_log           enable row level security;
alter table public.meals               enable row level security;
alter table public.recipes             enable row level security;
alter table public.dietary_preferences enable row level security;
alter table public.pantry_items        enable row level security;


-- ============================================================================
-- SECTION 4: RLS POLICIES
-- Dropped first so this script can be re-run safely.
-- ============================================================================

-- PROFILES: both partners read all, edit own
drop policy if exists "couple reads profiles" on public.profiles;
create policy "couple reads profiles" on public.profiles
  for select to authenticated using (true);

drop policy if exists "insert own profile" on public.profiles;
create policy "insert own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());

drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid());

-- EVENTS: both partners read all, edit own
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

-- USER_SETTINGS: both partners read all, edit own
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

-- STEPS_LOG: both partners read all, edit own
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

-- MEALS: both partners read all, edit own
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

-- RECIPES: fully shared
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

-- DIETARY PREFERENCES: both partners read all, edit own
drop policy if exists "couple reads prefs" on public.dietary_preferences;
create policy "couple reads prefs" on public.dietary_preferences
  for select to authenticated using (true);

drop policy if exists "upsert own prefs" on public.dietary_preferences;
create policy "upsert own prefs" on public.dietary_preferences
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "update own prefs" on public.dietary_preferences;
create policy "update own prefs" on public.dietary_preferences
  for update to authenticated using (user_id = auth.uid());

-- PANTRY ITEMS: fully shared
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


-- ============================================================================
-- SECTION 5: AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================================

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


-- ============================================================================
-- SECTION 6: BACKFILL PROFILES FOR EXISTING USERS
-- Covers any accounts created before the trigger existed.
-- ============================================================================

insert into public.profiles (id, display_name)
select id, coalesce(raw_user_meta_data->>'display_name', split_part(email, '@', 1))
from auth.users
on conflict (id) do nothing;


-- ============================================================================
-- SECTION 7: ENABLE REALTIME
-- Realtime only broadcasts for tables in the supabase_realtime publication.
-- Each is wrapped so re-running does not error on already-added tables.
-- ============================================================================

do $$
begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.user_settings;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.steps_log;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.meals;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.recipes;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.pantry_items;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.dietary_preferences;
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- DONE — verification
-- ============================================================================
-- Expect 8 rows: dietary_preferences, events, meals, pantry_items,
--                profiles, recipes, steps_log, user_settings
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
