// Service Worker for Couples Life App
// Cache-first for app shell assets, network-first for API/external calls

const CACHE_NAME = 'couples-life-v23';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './css/design-tokens.css',
  './css/components.css',
  './css/app-shell.css',
  './css/realtime.css',
  './css/overlap-ribbon.css',
  './css/calendar-views.css',
  './css/modules.css',
  './js/app-shell.js',
  './js/calendar-module.js',
  './js/calendar-views.js',
  './js/free-windows.js',
  './js/google-sync.js',
  './js/overlap-ribbon.js',
  './js/recurrence-picker.js',
  './js/realtime-manager.js',
  './js/realtime-wiring.js',
  './js/schedule-editor.js',
  './js/schedule-patterns.js',
  './js/supabase-client.js',
  './js/ui-helpers.js',
  './manifest.json',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png'
];

// Install event — cache app shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS);
    })
  );
  // Activate immediately without waiting for existing clients to close
  self.skipWaiting();
});

// Activate event — clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  // Take control of all open clients immediately
  self.clients.claim();
});

// Local development hosts — the service worker must not serve stale assets here,
// otherwise code changes appear not to take effect until caches are cleared.
const DEV_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', ''];

function isDevHost(hostname) {
  return DEV_HOSTNAMES.includes(hostname);
}

// Fetch event — cache-first for app shell, network-first for API calls
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // On localhost, don't intercept at all — let the browser fetch normally so
  // edits are always picked up immediately during development.
  if (isDevHost(self.location.hostname)) {
    return;
  }

  // Never touch an OAuth callback. Google redirects back to the app's own URL
  // carrying ?code= and ?state=, which cache-first cannot match (the query
  // string makes it a different request from the cached shell) and must not
  // serve stale anyway — the code is single-use and expires in seconds.
  // Intercepting it produced the service worker's own "Offline" page at the
  // exact moment the sign-in came back.
  if (isAuthCallback(url)) {
    return;
  }

  // Network-first for Supabase API calls and external resources
  if (isApiOrExternal(url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for app shell assets
  event.respondWith(cacheFirst(event.request));
});

/**
 * An OAuth provider redirecting back into the app.
 *
 * Matched on the query rather than the path, because the callback lands on the
 * app's own root URL — there is no distinct route to key off.
 */
function isAuthCallback(url) {
  if (url.origin !== self.location.origin) return false;
  return url.searchParams.has('code')
    || url.searchParams.has('state')
    || url.searchParams.has('error');
}

/** Minimal escaper — the fallback page interpolates a URL and an error string. */
function escapeForHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isApiOrExternal(url) {
  // Supabase endpoints
  if (url.hostname.includes('supabase')) return true;
  // Google Fonts / Fontshare (external fonts)
  if (url.hostname.includes('fonts.googleapis.com')) return true;
  if (url.hostname.includes('fonts.gstatic.com')) return true;
  if (url.hostname.includes('fontshare.com')) return true;
  // CDN scripts
  if (url.hostname.includes('cdn.jsdelivr.net')) return true;
  // Any other external origin
  if (url.origin !== self.location.origin) return true;
  return false;
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Cache successful responses for same-origin assets
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    // Only say "offline" when the browser actually is. This used to claim it
    // unconditionally, which sent a failed OAuth redirect looking like a
    // connectivity problem when the connection was fine.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return new Response(
      `<!doctype html><meta charset="utf-8">
       <title>${offline ? 'Offline' : 'Could not load'}</title>
       <body style="font-family:system-ui;padding:2rem;line-height:1.5">
       <h1 style="font-size:1.1rem">${offline ? 'You are offline' : 'Could not load that page'}</h1>
       <p>${offline
         ? 'This page is not in the offline cache.'
         : 'The network request failed but the browser reports a connection.'}</p>
       <p style="color:#666;font-size:.9rem">${escapeForHtml(request.url)}</p>
       <p style="color:#666;font-size:.9rem">${escapeForHtml(String(error && error.message || error))}</p>
       <p><a href="./">Back to the calendar</a></p>`,
      { status: 503, statusText: 'Service Unavailable', headers: { 'Content-Type': 'text/html' } }
    );
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;

    // Only claim "offline" when the browser actually is. Reporting every
    // failed request as offline hides the real cause — an Edge Function that
    // was never deployed returns a 404 preflight, and dressing that up as a
    // connectivity problem sends you looking in entirely the wrong place.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return new Response(JSON.stringify({
      error: offline
        ? 'Offline'
        : 'Could not reach the server. If this is an Edge Function, check it is deployed.',
      detail: String(error && error.message ? error.message : error),
      url: request.url,
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ============================================================
// Web push
// ============================================================
//
// iOS 16.4+ delivers these only to a PWA added to the home screen; a Safari
// tab never receives them. Both users have it installed.

self.addEventListener('push', (event) => {
  // A push with no readable payload still has to show something: on iOS a
  // received push that displays no notification counts against the app and
  // repeated offences revoke the permission entirely.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Couples Calendar', body: 'You have an update.' };
  }

  const title = payload.title || 'Couples Calendar';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      icon: './icons/icon-192x192.png',
      badge: './icons/icon-192x192.png',
      // Collapses an earlier notification about the same day rather than
      // stacking a second one.
      tag: payload.tag || 'free-window',
      renotify: false,
      data: { url: payload.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || './';

  // Focus an already-open window rather than opening a second copy of the app.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

// A push service can rotate a subscription without asking. Without this the
// endpoint silently goes stale and notifications simply stop.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        client.postMessage({ type: 'push-subscription-changed' });
      }
    })
  );
});
