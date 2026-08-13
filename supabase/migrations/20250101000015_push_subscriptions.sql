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
