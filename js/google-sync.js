// ============================================================
// Google Calendar sync — client side
// ============================================================
//
// The browser's only jobs are: send the user to Google's consent screen, hand
// the returned code to the Edge Function, and ask for a sync. The client
// secret, refresh token and the sync itself all live server-side.
// ============================================================

import { supabase, SUPABASE_URL } from './supabase-client.js';
import { getCurrentUser } from './app-shell.js';
import { escapeHtml } from './ui-helpers.js';

// The OAuth client ID is public by design — it identifies the app, it does not
// authorise anything on its own. Replace after creating the Google Cloud
// credential (see docs/google-calendar-setup.md).
// Public by design: this identifies the app and authorises nothing on its own.
// The matching client SECRET must never appear in this repo — it lives only in
// Supabase Edge Function secrets, where the token exchange happens server-side.
export const GOOGLE_CLIENT_ID = '787807232870-l0sgqjukfi7abb53bstvremp1gesf1jh.apps.googleusercontent.com';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

const STATE_KEY = 'google-oauth-state';

// Why the last connection attempt failed. The handshake happens during page
// boot, before the sync panel exists, so a failure had nowhere to go and was
// written to console.warn — invisible on a phone. Stashed here instead and
// shown in the panel, which is where someone is looking when they wonder why
// it still says "Not connected".
const LAST_ERROR_KEY = 'google-oauth-last-error';

export function recordConnectError(message) {
  try {
    if (message) sessionStorage.setItem(LAST_ERROR_KEY, String(message));
    else sessionStorage.removeItem(LAST_ERROR_KEY);
  } catch { /* private mode */ }
}

export function lastConnectError() {
  try { return sessionStorage.getItem(LAST_ERROR_KEY); } catch { return null; }
}

// Resolved on call rather than at import time. Reading SUPABASE_URL during
// module evaluation makes this file impossible to import in any test that
// mocks supabase-client without re-exporting every constant.
const functionUrl = () => `${SUPABASE_URL}/functions/v1/google-calendar-sync`;

/** The app itself is the redirect target; the code is read from the query. */
export function redirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

// ------------------------------------------------------------
// Edge Function transport
// ------------------------------------------------------------

async function callFunction(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { success: false, error: 'Sign in first.' };

  try {
    const response = await fetch(functionUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { success: false, error: body.error || 'Sync service error.' };
    return body;
  } catch {
    return { success: false, error: 'Could not reach the sync service.' };
  }
}

export const getSyncStatus = () => callFunction('status');
export const runSync = () => callFunction('sync');
export const disconnectGoogle = () => callFunction('disconnect');

// ------------------------------------------------------------
// Automatic sync while the app is open
// ------------------------------------------------------------
//
// Not a background job. Doing this properly in the background means a
// scheduled function plus a Google watch channel with a renewing webhook, and
// for two people that is a lot of moving parts to maintain for a saving of a
// few seconds. Syncing whenever the app is actually open covers the real case:
// you open it, it is already current.

const SYNC_KEY = 'google-last-sync';
/** Do not sync more than once every five minutes. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;
let inFlight = false;

export function lastSyncedAt() {
  try {
    const value = Number(localStorage.getItem(SYNC_KEY));
    return Number.isFinite(value) && value > 0 ? new Date(value) : null;
  } catch {
    return null;
  }
}

function markSynced() {
  try { localStorage.setItem(SYNC_KEY, String(Date.now())); } catch { /* private mode */ }
}

/**
 * Syncs if it has been long enough since the last one.
 * @param {boolean} [force=false]
 */
export async function syncIfStale(force = false) {
  if (inFlight) return { success: false, skipped: 'in flight' };

  const last = lastSyncedAt();
  if (!force && last && Date.now() - last.getTime() < MIN_INTERVAL_MS) {
    return { success: false, skipped: 'too soon' };
  }

  // Nothing to do if no account is connected — and worth checking cheaply
  // rather than firing a full sync that will only error.
  const status = await getSyncStatus();
  if (!status.success || !status.connected) return { success: false, skipped: 'not connected' };

  inFlight = true;
  const result = await runSync();
  inFlight = false;

  if (result.success) {
    markSynced();
    if (result.pulled || result.pushed || result.deleted) {
      window.dispatchEvent(new CustomEvent('calendar:refresh'));
    }
    window.dispatchEvent(new CustomEvent('google:synced', { detail: result }));
  }
  return result;
}

/**
 * Starts the automatic cycle: once now, then on an interval, and again
 * whenever the tab comes back to the foreground.
 *
 * The visibility check matters on a phone — a PWA left open in the background
 * would otherwise keep firing requests for hours against a token that expires
 * weekly anyway.
 */
export function startAutoSync() {
  stopAutoSync();

  const tick = () => {
    if (document.visibilityState === 'visible') syncIfStale();
  };

  tick();
  timer = setInterval(tick, MIN_INTERVAL_MS);
  document.addEventListener('visibilitychange', tick);
}

export function stopAutoSync() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ------------------------------------------------------------
// OAuth
// ------------------------------------------------------------

/**
 * Sends the user to Google's consent screen.
 *
 * access_type=offline plus prompt=consent is what makes Google return a
 * refresh token. Without both, a returning user gets an access token only and
 * the connection dies in an hour.
 */
export function startGoogleAuth() {
  if (!GOOGLE_CLIENT_ID) {
    return { success: false, error: 'No Google client ID configured yet.' };
  }

  // CSRF guard: Google echoes this back and it must match.
  const state = crypto.randomUUID();
  try { sessionStorage.setItem(STATE_KEY, state); } catch { /* private mode */ }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  window.location.assign(`${AUTH_ENDPOINT}?${params}`);
  return { success: true };
}

/**
 * Completes the flow if the current URL carries a Google authorisation code.
 * Safe to call on every boot; it no-ops when there is no code.
 */
export async function completeGoogleAuth() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const returnedState = params.get('state');
  const error = params.get('error');

  if (!code && !error) return { handled: false };

  // Clean the URL either way, so a refresh cannot replay a spent code.
  const clean = window.location.pathname;
  window.history.replaceState({}, '', clean);

  if (error) {
    const message = `Google returned: ${error}`;
    recordConnectError(message);
    return { handled: true, success: false, error: message };
  }

  let expectedState = null;
  try { expectedState = sessionStorage.getItem(STATE_KEY); } catch { /* private mode */ }
  try { sessionStorage.removeItem(STATE_KEY); } catch { /* private mode */ }

  if (!expectedState || expectedState !== returnedState) {
    const error = 'The sign-in response did not match this browser session. Try connecting again.';
    recordConnectError(error);
    return { handled: true, success: false, error };
  }

  const result = await callFunction('connect', { code, redirectUri: clean ? `${window.location.origin}${clean}` : redirectUri() });
  recordConnectError(result.success ? null : (result.error || 'The connection could not be completed.'));
  return { handled: true, ...result };
}

// ------------------------------------------------------------
// UI
// ------------------------------------------------------------

/**
 * Renders the connect / sync panel.
 * @param {HTMLElement} container
 */
export async function renderGoogleSyncPanel(container) {
  if (!container) return;
  if (!getCurrentUser()) {
    container.innerHTML = `<div class="empty-state">Sign in to connect a calendar.</div>`;
    return;
  }

  container.innerHTML = `<p class="view-placeholder-text">Checking connection…</p>`;

  const status = await getSyncStatus();

  if (!GOOGLE_CLIENT_ID) {
    container.innerHTML = `
      <div class="notice">
        <p>Google sync is built but not configured. Add the OAuth client ID to
        <span class="num">js/google-sync.js</span> and set the secrets on the
        Edge Function — the steps are in
        <span class="num">docs/google-calendar-setup.md</span>.</p>
      </div>
    `;
    return;
  }

  const connected = status.success && status.connected;

  container.innerHTML = `
    <div class="sync-panel">
      <div class="sync-row">
        <div class="sync-main">
          <span class="sync-label">Google Calendar</span>
          <span class="sync-detail">
            ${connected
              ? escapeHtml(status.account || 'Connected')
              : 'Not connected — your shifts stay inside this app'}
          </span>
        </div>
        <span class="sync-state ${connected ? 'is-on' : ''}">${connected ? 'Connected' : 'Off'}</span>
      </div>

      ${!connected && lastConnectError() ? `
        <p class="input-error-msg">${escapeHtml(lastConnectError())}</p>
      ` : ''}

      ${connected ? `
        <p class="field-hint">
          Syncs on its own while the app is open, at most every five minutes.
          ${lastSyncedAt()
            ? `Last synced <span class="num">${escapeHtml(formatSyncTime(lastSyncedAt()))}</span>.`
            : 'Not synced yet on this device.'}
        </p>
      ` : ''}

      <div class="form-actions">
        ${connected
          ? `<button type="button" class="btn btn-primary" data-sync>Sync now</button>
             <button type="button" class="btn btn-secondary" data-disconnect>Disconnect</button>`
          : `<button type="button" class="btn btn-primary" data-connect>Connect Google Calendar</button>`}
        <span class="form-status num" data-sync-status aria-live="polite"></span>
      </div>

      ${connected ? `
        <p class="field-hint">
          Events you create here appear in Google, and Google events appear here.
          Whichever side was edited most recently wins. Shift patterns are not
          pushed — they are a rota, not a list of appointments.
        </p>
      ` : ''}
    </div>
  `;

  wireSyncPanel(container);
}

/** Relative for anything today, plain date beyond that. */
function formatSyncTime(date) {
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString('en-GB');
}

function wireSyncPanel(container) {
  const status = container.querySelector('[data-sync-status]');

  container.querySelector('[data-connect]')?.addEventListener('click', () => {
    const result = startGoogleAuth();
    if (!result.success) status.textContent = result.error;
  });

  container.querySelector('[data-sync]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    status.textContent = 'Syncing…';

    // Forced, because pressing the button should always do something.
    const result = await syncIfStale(true);
    button.disabled = false;

    if (!result.success) {
      status.textContent = result.error || 'Sync failed.';
      return;
    }
    status.textContent = `${result.pulled} in, ${result.pushed} out`
      + (result.deleted ? `, ${result.deleted} removed` : '');
  });

  container.querySelector('[data-disconnect]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    status.textContent = 'Disconnecting…';

    const result = await disconnectGoogle();
    button.disabled = false;

    if (!result.success) {
      status.textContent = result.error || 'Could not disconnect.';
      return;
    }
    renderGoogleSyncPanel(container);
  });
}
