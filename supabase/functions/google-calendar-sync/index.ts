// Supabase Edge Function: google-calendar-sync
//
// Handles the whole Google Calendar relationship, because none of it can
// safely happen in the browser:
//
//   POST { action: 'connect', code, redirectUri }  — OAuth code exchange
//   POST { action: 'sync' }                        — two-way sync
//   POST { action: 'disconnect' }                  — revoke and forget
//   POST { action: 'status' }                      — connection summary
//
// The client secret and refresh token never leave this function. The caller is
// identified by their Supabase JWT, so a user can only ever act on their own
// connection regardless of what they put in the body.
//
// Conflict rule: last write wins, compared on timestamps. A tie resolves in
// favour of the local row, because the local row is the one the couple edited
// together in this app.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** Events this app writes carry a marker so a pull can recognise its own work. */
const APP_TAG = 'couples-life-app';

interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
}

interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  summary?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

/** Admin client. Only this function holds the service role key. */
function adminClient() {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  );
}

/** Resolves the caller from their JWT. Never trust a user id from the body. */
async function resolveUser(request: Request) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  const client = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } }
  );
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

// ------------------------------------------------------------
// OAuth
// ------------------------------------------------------------

async function exchangeCode(code: string, redirectUri: string): Promise<GoogleTokens> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    throw new Error(`Google rejected the authorisation code: ${await response.text()}`);
  }
  return response.json();
}

/**
 * Returns a usable access token, refreshing if the cached one has expired.
 * Google only returns a refresh token on first consent, so the stored one is
 * kept unless Google explicitly issues a replacement.
 */
async function accessTokenFor(admin: ReturnType<typeof adminClient>, connection: Record<string, unknown>) {
  const expiresAt = connection.access_expires_at ? new Date(connection.access_expires_at as string) : null;
  // Refresh a minute early rather than racing the expiry.
  if (connection.access_token && expiresAt && expiresAt.getTime() - 60_000 > Date.now()) {
    return connection.access_token as string;
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      refresh_token: connection.refresh_token as string,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    throw new Error('Google refused to refresh the token. The connection may have been revoked.');
  }

  const tokens: GoogleTokens = await response.json();
  await admin.from('google_connections').update({
    access_token: tokens.access_token,
    access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
  }).eq('id', connection.id as string);

  return tokens.access_token;
}

// ------------------------------------------------------------
// Mapping between the two event shapes
// ------------------------------------------------------------

function toGoogleEvent(event: Record<string, unknown>) {
  return {
    summary: event.title,
    start: { dateTime: new Date(event.start_time as string).toISOString() },
    end: { dateTime: new Date(event.end_time as string).toISOString() },
    transparency: event.is_busy ? 'opaque' : 'transparent',
    // Marks this as ours, so a later pull does not re-import our own push.
    extendedProperties: { private: { source: APP_TAG, localId: String(event.id) } },
    ...(event.rrule ? { recurrence: [`RRULE:${event.rrule}`] } : {}),
  };
}

function fromGoogleEvent(remote: GoogleEvent, userId: string) {
  // All-day events arrive as dates rather than datetimes.
  const start = remote.start?.dateTime || (remote.start?.date ? `${remote.start.date}T00:00:00Z` : null);
  const end = remote.end?.dateTime || (remote.end?.date ? `${remote.end.date}T00:00:00Z` : null);
  if (!start || !end) return null;

  return {
    user_id: userId,
    title: (remote.summary || 'Untitled').slice(0, 100),
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    is_busy: true,
    origin: 'google',
  };
}

// ------------------------------------------------------------
// Sync
// ------------------------------------------------------------

async function pushLocal(
  admin: ReturnType<typeof adminClient>,
  connection: Record<string, unknown>,
  token: string,
) {
  const calendarId = encodeURIComponent(connection.calendar_id as string);

  // Only events authored here. Pulled events are never pushed back — that is
  // the loop guard.
  const { data: events } = await admin
    .from('events')
    .select('*')
    .eq('user_id', connection.user_id as string)
    .eq('origin', 'local');

  const { data: maps } = await admin
    .from('google_event_map')
    .select('*')
    .eq('connection_id', connection.id as string);

  const byEventId = new Map((maps || []).map((m) => [m.event_id, m]));
  let pushed = 0;

  for (const event of events || []) {
    const mapping = byEventId.get(event.id);
    const localUpdated = new Date(event.updated_at).getTime();

    // Already sent this version, and Google has not changed it since.
    if (mapping && mapping.last_local_update
      && new Date(mapping.last_local_update).getTime() >= localUpdated) {
      continue;
    }

    // Remote won the conflict: it was edited more recently than the local row.
    if (mapping?.last_remote_update
      && new Date(mapping.last_remote_update).getTime() > localUpdated) {
      continue;
    }

    const url = mapping
      ? `${CALENDAR_API}/calendars/${calendarId}/events/${encodeURIComponent(mapping.google_event_id)}`
      : `${CALENDAR_API}/calendars/${calendarId}/events`;

    const response = await fetch(url, {
      method: mapping ? 'PATCH' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(toGoogleEvent(event)),
    });

    if (!response.ok) continue;
    const remote: GoogleEvent = await response.json();

    await admin.from('google_event_map').upsert({
      connection_id: connection.id,
      event_id: event.id,
      google_event_id: remote.id,
      google_etag: remote.etag,
      last_local_update: new Date(localUpdated).toISOString(),
      deleted_remotely: false,
    }, { onConflict: 'connection_id,google_event_id' });

    pushed++;
  }

  return pushed;
}

/**
 * Deletes, in Google, the events that were deleted here.
 *
 * A trigger flags the mapping row on local delete and detaches it from the
 * event, so the Google id survives long enough for this pass to use it.
 * A 404 or 410 means it is already gone, which is success, not failure.
 */
async function pushDeletions(
  admin: ReturnType<typeof adminClient>,
  connection: Record<string, unknown>,
  token: string,
) {
  const calendarId = encodeURIComponent(connection.calendar_id as string);

  const { data: pending } = await admin
    .from('google_event_map')
    .select('*')
    .eq('connection_id', connection.id as string)
    .eq('pending_delete', true);

  let deleted = 0;

  for (const mapping of pending || []) {
    const response = await fetch(
      `${CALENDAR_API}/calendars/${calendarId}/events/${encodeURIComponent(mapping.google_event_id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );

    if (response.ok || response.status === 404 || response.status === 410) {
      await admin.from('google_event_map').delete().eq('id', mapping.id);
      deleted++;
    }
    // Anything else (rate limit, transient 5xx) keeps the flag for next time.
  }

  return deleted;
}

async function pullRemote(
  admin: ReturnType<typeof adminClient>,
  connection: Record<string, unknown>,
  token: string,
) {
  const calendarId = encodeURIComponent(connection.calendar_id as string);

  const { data: syncState } = await admin
    .from('google_sync_state')
    .select('*')
    .eq('connection_id', connection.id as string)
    .maybeSingle();

  const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
  if (syncState?.sync_token) {
    params.set('syncToken', syncState.sync_token);
  } else {
    // First run: a bounded window, not the user's entire calendar history.
    const from = new Date();
    from.setMonth(from.getMonth() - 1);
    params.set('timeMin', from.toISOString());
  }

  let response = await fetch(
    `${CALENDAR_API}/calendars/${calendarId}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  // 410 means the sync token expired; Google requires a full resync.
  if (response.status === 410) {
    await admin.from('google_sync_state').upsert({
      connection_id: connection.id,
      sync_token: null,
      full_resync_at: new Date().toISOString(),
    }, { onConflict: 'connection_id' });

    const retry = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
    const from = new Date();
    from.setMonth(from.getMonth() - 1);
    retry.set('timeMin', from.toISOString());
    response = await fetch(
      `${CALENDAR_API}/calendars/${calendarId}/events?${retry}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
  }

  if (!response.ok) {
    throw new Error(`Google refused the event list: ${response.status}`);
  }

  const payload = await response.json();
  const items: GoogleEvent[] = payload.items || [];
  let pulled = 0;

  for (const remote of items) {
    const isOurs = remote.extendedProperties?.private?.source === APP_TAG;

    const { data: mapping } = await admin
      .from('google_event_map')
      .select('*')
      .eq('connection_id', connection.id as string)
      .eq('google_event_id', remote.id)
      .maybeSingle();

    // Deleted in Google.
    if (remote.status === 'cancelled') {
      if (mapping?.event_id) {
        await admin.from('events').delete().eq('id', mapping.event_id);
        await admin.from('google_event_map')
          .update({ deleted_remotely: true, event_id: null })
          .eq('id', mapping.id);
        pulled++;
      }
      continue;
    }

    const shaped = fromGoogleEvent(remote, connection.user_id as string);
    if (!shaped) continue;
    const remoteUpdated = remote.updated ? new Date(remote.updated).getTime() : Date.now();

    if (mapping?.event_id) {
      const { data: localEvent } = await admin
        .from('events').select('updated_at').eq('id', mapping.event_id).maybeSingle();

      // Local edited more recently — leave it alone, the push pass will win.
      if (localEvent && new Date(localEvent.updated_at).getTime() >= remoteUpdated) continue;

      await admin.from('events')
        .update({ title: shaped.title, start_time: shaped.start_time, end_time: shaped.end_time })
        .eq('id', mapping.event_id);
      await admin.from('google_event_map').update({
        google_etag: remote.etag,
        last_remote_update: new Date(remoteUpdated).toISOString(),
      }).eq('id', mapping.id);
      pulled++;
      continue;
    }

    // An event we pushed but whose mapping we lost — do not duplicate it.
    if (isOurs && remote.extendedProperties?.private?.localId) continue;

    // Second guard, independent of the mapping table. If an event with the
    // same owner, title and exact times is already here, this is the same
    // event arriving again rather than a new one — adopt it and write the
    // missing mapping instead of inserting a copy.
    //
    // Belt and braces on purpose: the mapping is the real mechanism, but it
    // failing silently is precisely what produced duplicates, and this catches
    // the case whatever the cause.
    const { data: existing } = await admin
      .from('events')
      .select('id')
      .eq('user_id', shaped.user_id)
      .eq('title', shaped.title)
      .eq('start_time', shaped.start_time)
      .eq('end_time', shaped.end_time)
      .limit(1)
      .maybeSingle();

    if (existing) {
      await admin.from('google_event_map').upsert({
        connection_id: connection.id,
        event_id: existing.id,
        google_event_id: remote.id,
        google_etag: remote.etag,
        last_remote_update: new Date(remoteUpdated).toISOString(),
      }, { onConflict: 'connection_id,google_event_id' });
      continue;
    }

    const { data: inserted } = await admin
      .from('events').insert(shaped).select('id').single();

    if (inserted) {
      // The mapping is what stops this event being pulled in again on the next
      // run. Its result used to be discarded: if the write failed, the event
      // row survived with nothing linking it to its Google id, so every
      // subsequent sync saw an unmapped remote event and inserted another copy.
      // One extra duplicate per sync, forever — doubles, then triples.
      //
      // upsert rather than insert, because a mapping left behind by an earlier
      // partial run would otherwise collide and fail for good.
      const { error: mapError } = await admin.from('google_event_map').upsert({
        connection_id: connection.id,
        event_id: inserted.id,
        google_event_id: remote.id,
        google_etag: remote.etag,
        last_remote_update: new Date(remoteUpdated).toISOString(),
      }, { onConflict: 'connection_id,google_event_id' });

      if (mapError) {
        // Roll the event back rather than leave an orphan that will be
        // recreated on every future sync. Losing one pull is recoverable;
        // an unmapped event is not, it just multiplies.
        await admin.from('events').delete().eq('id', inserted.id);
        continue;
      }
      pulled++;
    }
  }

  await admin.from('google_sync_state').upsert({
    connection_id: connection.id,
    sync_token: payload.nextSyncToken || syncState?.sync_token || null,
    last_synced_at: new Date().toISOString(),
    last_error: null,
  }, { onConflict: 'connection_id' });

  return pulled;
}

// ------------------------------------------------------------
// Request handling
// ------------------------------------------------------------

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let user;
  try {
    user = await resolveUser(request);
  } catch {
    return json({ error: 'Could not verify your session.' }, 401);
  }
  if (!user) return json({ error: 'Sign in required.' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const admin = adminClient();
  const action = String(body.action || '');

  try {
    if (action === 'connect') {
      const code = String(body.code || '');
      const redirectUri = String(body.redirectUri || '');
      if (!code || !redirectUri) return json({ error: 'Missing code or redirect URI.' }, 400);

      const tokens = await exchangeCode(code, redirectUri);
      if (!tokens.refresh_token) {
        // Happens when the user has consented before. Forcing consent again is
        // the only way to get a refresh token back.
        return json({
          error: 'Google did not return a refresh token. Remove this app at '
            + 'myaccount.google.com/permissions and connect again.',
        }, 400);
      }

      const profile = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }).then(r => r.json()).catch(() => ({}));

      const { data: connection, error } = await admin.from('google_connections').upsert({
        user_id: user.id,
        google_account: profile.email || 'unknown',
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        scope: tokens.scope,
        calendar_id: 'primary',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,google_account,calendar_id' }).select('id, google_account').single();

      if (error) return json({ error: 'Could not save the connection.' }, 500);
      return json({ success: true, connection });
    }

    const { data: connection } = await admin
      .from('google_connections')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (action === 'status') {
      return json({
        success: true,
        connected: Boolean(connection),
        account: connection?.google_account || null,
      });
    }

    if (!connection) return json({ error: 'No Google account connected.' }, 400);

    if (action === 'disconnect') {
      // Best effort: if Google has already forgotten the token, still clean up.
      await fetch(`${GOOGLE_REVOKE_URL}?token=${connection.refresh_token}`, { method: 'POST' })
        .catch(() => undefined);
      await admin.from('google_connections').delete().eq('id', connection.id);
      return json({ success: true });
    }

    if (action === 'sync') {
      if (!connection.sync_enabled) return json({ error: 'Sync is paused.' }, 400);

      const token = await accessTokenFor(admin, connection);

      // Deletions first, so a pull cannot re-import an event that was deleted
      // here a moment ago and then immediately re-delete it.
      const deleted = await pushDeletions(admin, connection, token);
      // Then pull: a remote edit newer than the local row should win, and the
      // push pass afterwards skips anything the pull just settled.
      const pulled = await pullRemote(admin, connection, token);
      const pushed = await pushLocal(admin, connection, token);

      return json({ success: true, pushed, pulled, deleted, syncedAt: new Date().toISOString() });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    await admin.from('google_sync_state')
      .update({ last_error: message })
      .eq('connection_id', body.connectionId as string ?? '')
      .then(() => undefined, () => undefined);
    return json({ error: message }, 500);
  }
});
