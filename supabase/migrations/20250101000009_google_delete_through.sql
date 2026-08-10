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
