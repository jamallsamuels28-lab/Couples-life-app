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
create policy "couple reads sleep rules" on public.sleep_rules
  for select to authenticated using (true);

create policy "insert own sleep rules" on public.sleep_rules
  for insert to authenticated with check (user_id = auth.uid());

create policy "update own sleep rules" on public.sleep_rules
  for update to authenticated using (user_id = auth.uid());

create policy "delete own sleep rules" on public.sleep_rules
  for delete to authenticated using (user_id = auth.uid());

create policy "couple reads shift patterns" on public.shift_patterns
  for select to authenticated using (true);

create policy "insert own shift patterns" on public.shift_patterns
  for insert to authenticated with check (user_id = auth.uid());

create policy "update own shift patterns" on public.shift_patterns
  for update to authenticated using (user_id = auth.uid());

create policy "delete own shift patterns" on public.shift_patterns
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- REALTIME
-- =============================================================================
alter publication supabase_realtime add table public.sleep_rules;
alter publication supabase_realtime add table public.shift_patterns;
