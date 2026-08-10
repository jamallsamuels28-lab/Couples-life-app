// ============================================================
// Realtime Wiring — Couples Life App
// Connects the shared realtime subscription layer (realtime-manager)
// to each module's event handlers. Ensures all modules receive
// realtime updates within 2 seconds of delivery.
//
// Requirements: 12.1, 12.2, 11.4
// ============================================================

import { getCurrentUser } from './app-shell.js';

// --- State ---
let wired = false;

// --- Handlers ---

/**
 * Handles realtime:meals events from the shared realtime layer.
 * Dispatches a module-level event so the food module can refresh its view.
 */
function handleMealsRealtime(event) {
  const payload = event.detail;
  if (!payload) return;

  const user = getCurrentUser();
  if (!user) return;

  // Notify the food module to refresh (partner or own changes)
  window.dispatchEvent(new CustomEvent('food:refresh', { detail: payload }));
}

/**
 * Handles realtime:recipes events from the shared realtime layer.
 * Dispatches a module-level event so the recipe book can refresh.
 */
function handleRecipesRealtime(event) {
  const payload = event.detail;
  if (!payload) return;

  window.dispatchEvent(new CustomEvent('recipes:refresh', { detail: payload }));
}

/**
 * Handles realtime:pantry_items events from the shared realtime layer.
 * Dispatches a module-level event so the pantry module can refresh.
 */
function handlePantryRealtime(event) {
  const payload = event.detail;
  if (!payload) return;

  window.dispatchEvent(new CustomEvent('pantry:refresh', { detail: payload }));
}

/**
 * Handles realtime:steps_log events from the shared realtime layer.
 * This supplements the steps module's own channel by ensuring the
 * shared layer also triggers partner step display updates.
 */
function handleStepsRealtime(event) {
  const payload = event.detail;
  if (!payload) return;

  // Dispatch a module-level event so the steps view can update
  window.dispatchEvent(new CustomEvent('steps:refresh', { detail: payload }));
}

// --- Public API ---

/**
 * Wires all modules to the shared realtime subscription layer.
 * Should be called once after auth succeeds and initRealtime() has been called.
 *
 * The realtime-manager dispatches custom events on window:
 *   realtime:events       → handled by calendar-module (already wired)
 *   realtime:steps_log    → wired here to supplement steps-module
 *   realtime:meals        → wired here for food-module
 *   realtime:recipes      → wired here for recipe-book
 *   realtime:pantry_items → wired here for pantry-module
 *
 * All handlers execute synchronously on the event dispatch, ensuring
 * UI updates propagate within the 2-second requirement.
 */
export function wireModulesToRealtime() {
  if (wired) return; // Prevent duplicate wiring

  // The calendar module already listens to 'realtime:events' directly
  // (see calendar-module.js → initCalendarModule → window.addEventListener)

  // Wire steps_log to a shared handler
  window.addEventListener('realtime:steps_log', handleStepsRealtime);

  // Wire meals to food module
  window.addEventListener('realtime:meals', handleMealsRealtime);

  // Wire recipes to recipe book
  window.addEventListener('realtime:recipes', handleRecipesRealtime);

  // Wire pantry_items to pantry module
  window.addEventListener('realtime:pantry_items', handlePantryRealtime);

  wired = true;
}

/**
 * Removes all realtime event wiring. Called on logout/session expiry.
 */
export function unwireModulesFromRealtime() {
  if (!wired) return;

  window.removeEventListener('realtime:steps_log', handleStepsRealtime);
  window.removeEventListener('realtime:meals', handleMealsRealtime);
  window.removeEventListener('realtime:recipes', handleRecipesRealtime);
  window.removeEventListener('realtime:pantry_items', handlePantryRealtime);

  wired = false;
}

/**
 * Returns whether the wiring is currently active.
 * Useful for testing.
 */
export function isWired() {
  return wired;
}
