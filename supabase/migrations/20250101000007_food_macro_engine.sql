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
create policy "couple reads foods" on public.foods
  for select to authenticated using (true);
create policy "couple writes foods" on public.foods
  for insert to authenticated with check (true);
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

create policy "couple reads food entries" on public.food_entries
  for select to authenticated using (true);
create policy "insert own food entries" on public.food_entries
  for insert to authenticated with check (user_id = auth.uid());
create policy "update own food entries" on public.food_entries
  for update to authenticated using (user_id = auth.uid());
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

create policy "couple reads weigh ins" on public.weigh_ins
  for select to authenticated using (true);
create policy "insert own weigh ins" on public.weigh_ins
  for insert to authenticated with check (user_id = auth.uid());
create policy "update own weigh ins" on public.weigh_ins
  for update to authenticated using (user_id = auth.uid());
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

create policy "couple reads nutrition profile" on public.nutrition_profile
  for select to authenticated using (true);
create policy "insert own nutrition profile" on public.nutrition_profile
  for insert to authenticated with check (user_id = auth.uid());
create policy "update own nutrition profile" on public.nutrition_profile
  for update to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- =============================================================================
alter publication supabase_realtime add table public.food_entries;
alter publication supabase_realtime add table public.weigh_ins;
