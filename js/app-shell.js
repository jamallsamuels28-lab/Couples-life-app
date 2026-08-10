// ============================================================
// App Shell — Couples Life App
// Authentication gating, navigation, routing, partner context
// ============================================================

import { supabase, validateAuthToken } from './supabase-client.js';
import { initRealtime, cleanup as cleanupRealtime } from './realtime-manager.js';
import { wireModulesToRealtime, unwireModulesFromRealtime } from './realtime-wiring.js';

// Feature modules. The steps and food modules register their own 'viewchange'
// listeners on import; the calendar module exposes an explicit initialiser.
// Without these imports the modules never load and each view stays on its
// placeholder text.
import { initCalendarModule } from './calendar-module.js';
import { initFitnessModule } from './fitness-module.js';
import './steps-module.js';
import './food-module.js';

// --- State ---
let currentUser = null;
let partner = null;
let currentView = 'calendar';

// --- Public API ---

/** Returns the authenticated user's profile or null */
export function getCurrentUser() {
  return currentUser;
}

/** Returns the partner's profile or null */
export function getPartner() {
  return partner;
}

/**
 * Verifies that the current auth session is valid (token present and not expired).
 * Returns { valid: true } on success, or { valid: false, reason: string } on failure.
 * Modules should call this before making API calls (Requirement 11.4).
 */
export async function ensureAuth() {
  return validateAuthToken();
}

/** The three tabs. Steps lives inside Fitness rather than having its own. */
export const VALID_VIEWS = ['calendar', 'fitness', 'food'];

/** Navigate to a module view without full page reload */
export function navigate(viewId) {
  // Old bookmarks and home-screen shortcuts pointing at #steps land on Fitness.
  const target = viewId === 'steps' ? 'fitness' : viewId;
  if (!VALID_VIEWS.includes(target)) return;

  currentView = target;
  window.location.hash = target;
  renderActiveView();
  updateNavActiveState();
}

// --- Initialisation ---

/** Bootstrap the app shell: check session, load profiles, render UI */
export async function init() {
  const app = document.getElementById('app');

  // Check for existing session
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();

  if (sessionError || !session) {
    redirectToLogin();
    return;
  }

  // Fetch profiles
  const loaded = await loadProfiles(session.user.id);
  if (!loaded) return;

  // Render the shell UI
  renderShell();

  // Start realtime subscriptions now that auth is confirmed
  initRealtime();

  // Wire all module event handlers to the shared realtime layer
  wireModulesToRealtime();

  // Register the calendar module's viewchange listener. Must happen before the
  // first renderActiveView() call, which dispatches that event.
  initCalendarModule();
  initFitnessModule();

  // Determine initial view from hash or default to calendar
  const hash = window.location.hash.replace('#', '');
  const requested = hash === 'steps' ? 'fitness' : hash;
  currentView = VALID_VIEWS.includes(requested) ? requested : 'calendar';
  window.location.hash = currentView;

  renderActiveView();
  updateNavActiveState();

  // Listen for hash changes (browser back/forward)
  window.addEventListener('hashchange', onHashChange);

  // Listen for auth state changes (session expiry, logout)
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED' && !session) {
      handleSessionExpiry();
    }
  });
}

// --- Auth Helpers ---

function redirectToLogin() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="auth-screen">
      <h1>Couples Life</h1>
      <p class="auth-subtitle">Sign in to continue</p>
      <form class="auth-form" id="login-form" novalidate>
        <div class="input-group">
          <label class="input-label" for="auth-email">Email</label>
          <input
            type="email"
            id="auth-email"
            class="input"
            autocomplete="username"
            required
            aria-describedby="auth-error"
          />
        </div>
        <div class="input-group mt-3">
          <label class="input-label" for="auth-password">Password</label>
          <input
            type="password"
            id="auth-password"
            class="input"
            autocomplete="current-password"
            required
            aria-describedby="auth-error"
          />
        </div>
        <button type="submit" class="auth-btn mt-3" id="login-btn">Sign In</button>
      </form>
      <div id="auth-error" class="auth-error hidden" role="alert" aria-live="polite"></div>
    </div>
  `;

  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const submitBtn = document.getElementById('login-btn');
    const errorEl = document.getElementById('auth-error');

    // Clear any previous error
    errorEl.classList.add('hidden');
    errorEl.textContent = '';

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showAuthError('Enter both your email and password.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';

    if (error) {
      showAuthError(error.message);
      return;
    }

    // Session established — re-run init to load profiles and render the shell
    init();
  });
}

function showAuthError(message) {
  const errorEl = document.getElementById('auth-error');
  if (!errorEl) return;
  errorEl.textContent = message;
  errorEl.classList.remove('hidden');

  // Add retry button if not already present
  if (!document.getElementById('retry-btn')) {
    const retryBtn = document.createElement('button');
    retryBtn.id = 'retry-btn';
    retryBtn.className = 'auth-retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => init());
    errorEl.parentElement.appendChild(retryBtn);
  }
}

function handleSessionExpiry() {
  // Clean up realtime subscriptions
  cleanupRealtime();

  // Unwire module event handlers from realtime layer
  unwireModulesFromRealtime();

  // Clear cached state
  currentUser = null;
  partner = null;
  currentView = 'calendar';

  // Clear any module-cached data from localStorage
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('app_cache_')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));

  // Return to login
  window.removeEventListener('hashchange', onHashChange);
  redirectToLogin();
}

// --- Profile Loading ---

async function loadProfiles(userId) {
  try {
    // Fetch all profiles (there are only two users in this app)
    const { data: profiles, error } = await supabase
      .from('profiles')
      .select('*');

    if (error) {
      showAuthError('Failed to load profiles. Please try again.');
      return false;
    }

    // Identify current user and partner
    currentUser = profiles.find(p => p.id === userId) || null;
    partner = profiles.find(p => p.id !== userId) || null;

    if (!currentUser) {
      showAuthError('Your profile could not be found. Contact support.');
      return false;
    }

    if (!partner) {
      showPartnerNotLinked();
      return false;
    }

    return true;
  } catch (err) {
    showAuthError('Network error loading profiles. Please try again.');
    return false;
  }
}

function showPartnerNotLinked() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="auth-screen">
      <h1>Couples Life</h1>
      <p class="partner-not-linked">
        Partner account is not linked. Both accounts must be registered before the app can load.
      </p>
      <button class="auth-retry-btn" id="retry-partner-btn">Retry</button>
    </div>
  `;
  document.getElementById('retry-partner-btn').addEventListener('click', () => init());
}

// --- Shell Rendering ---

function renderShell() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <main id="view-container" class="view-container"></main>
    <nav id="bottom-nav" class="bottom-nav" aria-label="Main navigation">
      <button class="nav-item" data-view="calendar" aria-label="Calendar">
        <svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="3" y="4" width="14" height="13" rx="2"/>
          <line x1="3" y1="8" x2="17" y2="8"/>
          <line x1="7" y1="2" x2="7" y2="5"/>
          <line x1="13" y1="2" x2="13" y2="5"/>
        </svg>
        <span class="nav-label">Calendar</span>
      </button>
      <button class="nav-item" data-view="fitness" aria-label="Fitness">
        <svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <line x1="3" y1="10" x2="17" y2="10"/>
          <rect x="4" y="7" width="2.5" height="6" rx="1"/>
          <rect x="13.5" y="7" width="2.5" height="6" rx="1"/>
        </svg>
        <span class="nav-label">Fitness</span>
      </button>
      <button class="nav-item" data-view="food" aria-label="Food">
        <svg class="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <ellipse cx="10" cy="14" rx="7" ry="4"/>
          <path d="M3 14 C3 10 7 7 10 7 C13 7 17 10 17 14"/>
          <line x1="10" y1="4" x2="10" y2="7"/>
        </svg>
        <span class="nav-label">Food</span>
      </button>
    </nav>
  `;

  // Attach navigation event listeners
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const viewId = item.getAttribute('data-view');
      navigate(viewId);
    });
  });
}

// --- Routing ---

function onHashChange() {
  const hash = window.location.hash.replace('#', '');
  // 'steps' is kept as an alias so an old bookmark or home-screen shortcut
  // still lands somewhere sensible rather than on a blank view.
  const target = hash === 'steps' ? 'fitness' : hash;
  if (['calendar', 'fitness', 'food'].includes(target) && target !== currentView) {
    currentView = target;
    renderActiveView();
    updateNavActiveState();
  }
}

function renderActiveView() {
  const container = document.getElementById('view-container');
  if (!container) return;

  // Clear existing view
  container.innerHTML = '';

  // Render the view scaffold. The heading sits OUTSIDE the mount container so it
  // survives when a module replaces the container's contents. The mount
  // container uses .view-content (a full-width stack), not .view-placeholder —
  // that class centres its children and is only for the loading message.
  const viewTitles = { calendar: 'Calendar', fitness: 'Fitness', food: 'Food' };
  const title = viewTitles[currentView];

  container.innerHTML = `
    <header class="view-header">
      <h2>${title}</h2>
    </header>
    <div class="view-content" id="${currentView}-view">
      <p class="view-placeholder-text">Loading ${title.toLowerCase()}…</p>
    </div>`;

  // Dispatch a custom event so modules can react to view changes
  window.dispatchEvent(new CustomEvent('viewchange', {
    detail: { view: currentView, user: currentUser, partner }
  }));
}

function updateNavActiveState() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    const viewId = item.getAttribute('data-view');
    if (viewId === currentView) {
      item.classList.add('active');
      item.setAttribute('aria-current', 'page');
    } else {
      item.classList.remove('active');
      item.removeAttribute('aria-current');
    }
  });
}

// --- Boot ---

// Auto-init when the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
