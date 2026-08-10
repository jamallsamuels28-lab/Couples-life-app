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
