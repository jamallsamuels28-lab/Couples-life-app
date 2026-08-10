// ============================================================
// Realtime Manager — Couples Life App
// Subscribes to Supabase Realtime channels, monitors connection,
// shows offline indicator, handles reconnection logic
// ============================================================

import { supabase } from './supabase-client.js';

// --- Constants ---
const SUBSCRIBED_TABLES = ['events', 'steps_log', 'meals', 'recipes', 'pantry_items'];
const OFFLINE_DISPLAY_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 3;

// --- State ---
let channels = [];
let offlineTimer = null;
let reconnectAttempts = 0;
let isConnected = true;
let indicatorEl = null;

// --- Public API ---

/**
 * Initialise realtime subscriptions after auth succeeds.
 * Subscribes to Postgres Changes on all five tables and
 * begins monitoring the WebSocket connection state.
 */
export function initRealtime() {
  subscribeToTables();
  monitorConnection();
}

/**
 * Unsubscribe from all channels and clean up indicators.
 * Called on logout.
 */
export function cleanup() {
  channels.forEach(ch => supabase.removeChannel(ch));
  channels = [];
  reconnectAttempts = 0;
  isConnected = true;
  clearOfflineTimer();
  removeIndicator();
}

// --- Subscriptions ---

function subscribeToTables() {
  SUBSCRIBED_TABLES.forEach(table => {
    const channel = supabase
      .channel(`realtime:${table}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        (payload) => {
          // Dispatch a custom event for each table change
          window.dispatchEvent(new CustomEvent(`realtime:${table}`, {
            detail: payload
          }));
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          handleConnectionRestored();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          handleConnectionLost();
        }
      });

    channels.push(channel);
  });
}

// --- Connection Monitoring ---

function monitorConnection() {
  // Use browser online/offline events as a supplementary signal
  window.addEventListener('online', handleOnlineEvent);
  window.addEventListener('offline', handleOfflineEvent);
}

function handleOnlineEvent() {
  // Browser says we're online — attempt to reconcile
  attemptReconnect();
}

function handleOfflineEvent() {
  handleConnectionLost();
}

// --- Connection State Handlers ---

function handleConnectionLost() {
  if (!isConnected) return; // already tracking

  isConnected = false;
  reconnectAttempts = 0;

  // Show offline indicator after the 3-second delay (requirement 12.3)
  offlineTimer = setTimeout(() => {
    showOfflineIndicator();
  }, OFFLINE_DISPLAY_DELAY_MS);

  // Start reconnection attempts
  scheduleReconnect();
}

function handleConnectionRestored() {
  if (isConnected) return; // already connected

  isConnected = true;
  reconnectAttempts = 0;
  clearOfflineTimer();
  removeIndicator();

  // Dispatch reconnected event so modules can refetch data
  window.dispatchEvent(new CustomEvent('realtime:reconnected'));
}

function scheduleReconnect() {
  // Supabase client handles low-level WebSocket reconnection,
  // but we track attempts for the persistent error threshold
  const attemptReconnection = () => {
    if (isConnected) return;

    reconnectAttempts++;

    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      showPersistentError();
      return;
    }

    // Resubscribe channels to trigger reconnection
    channels.forEach(ch => {
      try {
        ch.subscribe();
      } catch (_) {
        // channel may already be subscribing
      }
    });

    // Schedule next attempt with exponential backoff (2s, 4s, 8s)
    const delay = Math.pow(2, reconnectAttempts) * 1000;
    setTimeout(() => {
      if (!isConnected) {
        attemptReconnection();
      }
    }, delay);
  };

  // First reconnect attempt after a short delay
  setTimeout(attemptReconnection, 2000);
}

function attemptReconnect() {
  if (isConnected) return;

  // Re-subscribe all channels
  channels.forEach(ch => {
    try {
      ch.subscribe();
    } catch (_) {
      // ignore if already subscribing
    }
  });
}

// --- UI: Offline Indicator ---

function showOfflineIndicator() {
  if (indicatorEl) return; // already showing

  const nav = document.querySelector('.bottom-nav');
  if (!nav) return;

  indicatorEl = document.createElement('div');
  indicatorEl.className = 'realtime-offline-indicator';
  indicatorEl.setAttribute('role', 'status');
  indicatorEl.setAttribute('aria-live', 'polite');
  indicatorEl.innerHTML = `
    <svg class="offline-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
      <line x1="2" y1="2" x2="18" y2="18"/>
      <path d="M4 8 C6 5 10 4 14 5"/>
      <path d="M6 12 C8 10 12 10 14 12"/>
      <circle cx="10" cy="16" r="1" fill="currentColor" stroke="none"/>
    </svg>
    <span class="offline-text">Offline</span>
  `;

  nav.parentElement.insertBefore(indicatorEl, nav);
}

function showPersistentError() {
  removeIndicator();

  const nav = document.querySelector('.bottom-nav');
  if (!nav) return;

  indicatorEl = document.createElement('div');
  indicatorEl.className = 'realtime-offline-indicator realtime-error-persistent';
  indicatorEl.setAttribute('role', 'alert');
  indicatorEl.innerHTML = `
    <svg class="offline-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="10" cy="10" r="8"/>
      <line x1="10" y1="6" x2="10" y2="11"/>
      <circle cx="10" cy="14" r="0.8" fill="currentColor" stroke="none"/>
    </svg>
    <span class="offline-text">Connection lost</span>
    <button class="realtime-refresh-btn" aria-label="Refresh page">Refresh</button>
  `;

  nav.parentElement.insertBefore(indicatorEl, nav);

  // Attach refresh handler
  const refreshBtn = indicatorEl.querySelector('.realtime-refresh-btn');
  refreshBtn.addEventListener('click', () => {
    window.location.reload();
  });
}

function removeIndicator() {
  if (indicatorEl) {
    indicatorEl.remove();
    indicatorEl = null;
  }
}

// --- Utilities ---

function clearOfflineTimer() {
  if (offlineTimer) {
    clearTimeout(offlineTimer);
    offlineTimer = null;
  }
}
