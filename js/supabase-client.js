// ============================================================
// Supabase Client — Couples Life App
// ============================================================

// Supabase project credentials.
// The publishable (anon) key is safe to expose in client code — access is
// governed by Row Level Security policies, not by keeping this key secret.
// Project: couples-life (zaofuncpffumxhshoujk)
//
// Only ever the publishable key here. The sb_secret_ one bypasses row level
// security entirely; Edge Functions receive it as SUPABASE_SERVICE_ROLE_KEY
// from Supabase itself, so it never needs to appear in this repo.
const SUPABASE_URL = 'https://zaofuncpffumxhshoujk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_LoqKg3-TrTE3A3GP9BHN3Q_-g89p81n';

// Initialize the Supabase client (uses the global supabase object from CDN)
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Auth Token Guard ---

/**
 * Checks whether the current session has a valid (non-expired) JWT token.
 * Returns { valid: true, session } if valid, or { valid: false, reason } if not.
 *
 * Requirement 11.4: All API calls must include a valid JWT token;
 * reject any operation if the token is missing or expired.
 */
export async function validateAuthToken() {
  const { data: { session }, error } = await supabase.auth.getSession();

  if (error || !session) {
    return { valid: false, reason: 'No active session. Please sign in.' };
  }

  // Check token expiry (expires_at is seconds since epoch)
  if (session.expires_at) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= session.expires_at) {
      return { valid: false, reason: 'Session expired. Please sign in again.' };
    }
  }

  return { valid: true, session };
}

/**
 * Wraps an async API operation with auth token validation.
 * If the token is missing or expired, rejects immediately without executing the operation.
 * Otherwise, executes the operation and returns its result.
 *
 * @param {Function} operation - An async function that performs the API call
 * @returns {Promise<any>} The result of the operation, or throws with an auth error
 */
export async function withAuthGuard(operation) {
  const authCheck = await validateAuthToken();
  if (!authCheck.valid) {
    throw new Error(authCheck.reason);
  }
  return operation();
}

export { supabase, SUPABASE_URL, SUPABASE_ANON_KEY };
