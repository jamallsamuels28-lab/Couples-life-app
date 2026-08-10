// Supabase Edge Function: ingest-steps
//
// Receives a day's step count from an iOS Shortcuts personal automation
// (kiro-algorithm-spec.md §5.1). A Shortcut cannot hold a Supabase session, so
// it authenticates with a long-lived device token instead.
//
//   POST { token, date, steps }        — from the phone
//   POST { action: 'issue', label }    — from the app, with a normal JWT
//   POST { action: 'revoke', id }      — from the app, with a normal JWT
//
// Security notes:
//   - The token is only ever stored as a SHA-256 digest. A database leak gives
//     an attacker the ability to write step counts for nobody.
//   - The plaintext token is returned exactly once, at issue time.
//   - Lookup is by digest, so the token itself never appears in a query log.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

function adminClient() {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  );
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function resolveUser(request: Request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const client = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } }
  );
  const { data, error } = await client.auth.getUser();
  return error || !data?.user ? null : data.user;
}

/** YYYY-MM-DD, and not a date the phone could not plausibly have. */
function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (isNaN(date.getTime())) return null;

  // A day in the future, or more than a month back, is a misconfigured
  // Shortcut rather than real data.
  const now = Date.now();
  if (date.getTime() > now + 86400000) return null;
  if (date.getTime() < now - 31 * 86400000) return null;
  return value;
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  const admin = adminClient();
  const action = String(body.action || 'ingest');

  try {
    // --- Token management, from the app, with a real session ---
    if (action === 'issue' || action === 'revoke' || action === 'list') {
      const user = await resolveUser(request);
      if (!user) return json({ error: 'Sign in required.' }, 401);

      if (action === 'issue') {
        const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        const digest = await sha256(token);

        const { data, error } = await admin.from('device_tokens').insert({
          user_id: user.id,
          label: String(body.label || 'iPhone').slice(0, 40),
          token_digest: digest,
        }).select('id, label, created_at').single();

        if (error) return json({ error: 'Could not create the token.' }, 500);
        // Returned once and never again — there is no way to read it back.
        return json({ success: true, token, device: data });
      }

      if (action === 'revoke') {
        const { error } = await admin.from('device_tokens')
          .update({ revoked: true })
          .eq('id', String(body.id || ''))
          .eq('user_id', user.id);
        if (error) return json({ error: 'Could not revoke the token.' }, 500);
        return json({ success: true });
      }

      const { data } = await admin.from('device_tokens')
        .select('id, label, last_used_at, revoked, created_at')
        .eq('user_id', user.id);
      return json({ success: true, devices: data || [] });
    }

    // --- Ingest, from the phone, with a device token ---
    const token = String(body.token || '');
    if (token.length < 32) return json({ error: 'Missing or malformed token.' }, 401);

    const digest = await sha256(token);
    const { data: device } = await admin
      .from('device_tokens')
      .select('id, user_id, revoked')
      .eq('token_digest', digest)
      .maybeSingle();

    if (!device || device.revoked) return json({ error: 'Token not recognised.' }, 401);

    const date = validDate(body.date);
    if (!date) return json({ error: 'date must be YYYY-MM-DD within the last month.' }, 400);

    const steps = Number(body.steps);
    if (!Number.isFinite(steps) || steps < 0 || steps > 200000) {
      return json({ error: 'steps must be a number between 0 and 200000.' }, 400);
    }

    // Upsert, so the automation running twice in a day is harmless.
    const { error } = await admin.from('step_days').upsert({
      user_id: device.user_id,
      date,
      steps: Math.round(steps),
      source: 'ios_shortcut',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,date' });

    if (error) return json({ error: 'Could not save the step count.' }, 500);

    await admin.from('device_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', device.id);

    return json({ success: true, date, steps: Math.round(steps) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    return json({ error: message }, 500);
  }
});
