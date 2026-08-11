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
