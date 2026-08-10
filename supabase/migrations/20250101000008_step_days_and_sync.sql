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

create policy "couple reads step days" on public.step_days
  for select to authenticated using (true);
create policy "insert own step days" on public.step_days
  for insert to authenticated with check (user_id = auth.uid());
create policy "update own step days" on public.step_days
  for update to authenticated using (user_id = auth.uid());
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
alter publication supabase_realtime add table public.step_days;
