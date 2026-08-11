// Service Worker for Couples Life App
// Cache-first for app shell assets, network-first for API/external calls

const CACHE_NAME = 'couples-life-v14';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './css/design-tokens.css',
  './css/components.css',
  './css/colour-picker.css',
  './css/app-shell.css',
  './css/realtime.css',
  './css/dietary-preferences.css',
  './css/overlap-ribbon.css',
  './css/calendar-views.css',
  './css/modules.css',
  './js/app-shell.js',
  './js/barcode-scanner.js',
  './js/calendar-module.js',
  './js/calendar-views.js',
  './js/colour-picker.js',
  './js/device-sync.js',
  './js/exercise-cues.js',
  './js/exercise-library.js',
  './js/dietary-preferences.js',
  './js/fitness-engine.js',
  './js/fitness-module.js',
  './js/food-diary.js',
  './js/food-module.js',
  './js/nutrition-engine.js',
  './js/free-windows.js',
  './js/nutrition-settings.js',
  './js/portion-split.js',
  './js/google-sync.js',
  './js/overlap-ribbon.js',
  './js/pantry-module.js',
  './js/recurrence-picker.js',
  './js/realtime-manager.js',
  './js/realtime-wiring.js',
  './js/recipe-book.js',
  './js/recipe-generator.js',
  './js/schedule-editor.js',
  './js/schedule-patterns.js',
  './js/steps-module.js',
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

  // Network-first for Supabase API calls and external resources
  if (isApiOrExternal(url)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for app shell assets
  event.respondWith(cacheFirst(event.request));
});

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
  } catch {
    // If both cache and network fail, return a basic offline fallback
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
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
