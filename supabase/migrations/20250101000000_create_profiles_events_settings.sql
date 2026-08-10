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
create policy "couple reads profiles" on public.profiles
  for select to authenticated using (true);

create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid());

create policy "insert own profile" on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- EVENTS: both partners read all events, edit only their own
create policy "couple reads events" on public.events
  for select to authenticated using (true);

create policy "insert own events" on public.events
  for insert to authenticated with check (user_id = auth.uid());

create policy "update own events" on public.events
  for update to authenticated using (user_id = auth.uid());

create policy "delete own events" on public.events
  for delete to authenticated using (user_id = auth.uid());

-- USER_SETTINGS: both partners read all, edit only their own
create policy "couple reads settings" on public.user_settings
  for select to authenticated using (true);

create policy "insert own settings" on public.user_settings
  for insert to authenticated with check (user_id = auth.uid());

create policy "update own settings" on public.user_settings
  for update to authenticated using (user_id = auth.uid());

create policy "delete own settings" on public.user_settings
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- Add tables to the realtime publication so subscriptions fire.
-- =============================================================================
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.user_settings;
