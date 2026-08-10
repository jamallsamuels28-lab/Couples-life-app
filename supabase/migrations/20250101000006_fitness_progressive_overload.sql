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
create policy "couple reads exercises" on public.exercises
  for select to authenticated using (true);
create policy "couple writes exercises" on public.exercises
  for insert to authenticated with check (true);
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

create policy "couple reads sets" on public.sets
  for select to authenticated using (true);
create policy "insert own sets" on public.sets
  for insert to authenticated with check (user_id = auth.uid());
create policy "update own sets" on public.sets
  for update to authenticated using (user_id = auth.uid());
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

create policy "couple reads sessions" on public.training_sessions
  for select to authenticated using (true);
create policy "insert own sessions" on public.training_sessions
  for insert to authenticated with check (user_id = auth.uid());
create policy "update own sessions" on public.training_sessions
  for update to authenticated using (user_id = auth.uid());
create policy "delete own sessions" on public.training_sessions
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- =============================================================================
alter publication supabase_realtime add table public.sets;
alter publication supabase_realtime add table public.training_sessions;

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
