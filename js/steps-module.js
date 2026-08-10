// ============================================================
// Steps Module — Couples Life App
// Manual step count logging with validation and upsert
// ============================================================

import { supabase } from './supabase-client.js';
import { getCurrentUser, getPartner } from './app-shell.js';
import { escapeHtml, displayName, chevronSvg, formatNumber, localDateKey } from './ui-helpers.js';
import { renderDeviceSyncPanel } from './device-sync.js';

// --- Constants ---
const MIN_STEPS = 0;
const MAX_STEPS = 200000;
const MIN_GOAL = 1;
const MAX_GOAL = 200000;
const DEFAULT_GOAL = 10000;

// --- Validation ---

/**
 * Validates step count value.
 * @param {number} stepCount
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateStepCount(stepCount) {
  const count = Number(stepCount);
  if (!Number.isInteger(count) || count < MIN_STEPS || count > MAX_STEPS) {
    return { valid: false, error: 'Steps must be between 0 and 200,000' };
  }
  return { valid: true };
}

/**
 * Validates that the date is not in the future (local timezone).
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateDate(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const inputDate = new Date(dateStr + 'T00:00:00');
  if (isNaN(inputDate.getTime())) {
    return { valid: false, error: 'Invalid date' };
  }

  if (inputDate > today) {
    return { valid: false, error: 'Future dates are not allowed' };
  }
  return { valid: true };
}

// --- Core API ---

/**
 * Validates and upserts a step count entry for the current user.
 * @param {string} date - ISO date string (YYYY-MM-DD)
 * @param {number} stepCount - Number of steps
 * @returns {Promise<{ success: boolean, error?: string, data?: object }>}
 */
export async function logSteps(date, stepCount) {
  // Client-side validation
  const dateValidation = validateDate(date);
  if (!dateValidation.valid) {
    return { success: false, error: dateValidation.error, field: 'date' };
  }

  const stepValidation = validateStepCount(stepCount);
  if (!stepValidation.valid) {
    return { success: false, error: stepValidation.error, field: 'steps' };
  }

  // Get authenticated user
  const user = getCurrentUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  // Upsert to Supabase
  const { data, error } = await supabase
    .from('steps_log')
    .upsert(
      {
        user_id: user.id,
        log_date: date,
        step_count: Number(stepCount),
        source: 'manual',
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,log_date' }
    )
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data };
}

// --- Health API Sync ---

/**
 * Detects whether the device supports a health API.
 * Returns 'health_connect' (Android), 'apple_health' (iOS), or null (unsupported).
 * @returns {string|null}
 */
export function detectHealthPlatform() {
  const ua = navigator.userAgent || '';
  // Check for Web Health API (navigator.health) — Health Connect on Android
  if (navigator.health && typeof navigator.health.getSteps === 'function') {
    return 'health_connect';
  }
  // Check for Apple Health bridge (webkit messageHandler pattern on iOS)
  if (
    window.webkit &&
    window.webkit.messageHandlers &&
    window.webkit.messageHandlers.healthKit
  ) {
    return 'apple_health';
  }
  return null;
}

/**
 * Requests step data from the device health API for the given date.
 * @param {string} platform - 'health_connect' or 'apple_health'
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @returns {Promise<{ steps: number }|null>}
 */
async function requestHealthData(platform, dateStr) {
  if (platform === 'health_connect') {
    // Health Connect (Android) via navigator.health
    const result = await navigator.health.getSteps({
      startDate: dateStr + 'T00:00:00',
      endDate: dateStr + 'T23:59:59'
    });
    if (result && typeof result.steps === 'number') {
      return { steps: result.steps };
    }
    return null;
  }

  if (platform === 'apple_health') {
    // Apple Health via native webkit bridge — returns a promise via callback
    return new Promise((resolve, reject) => {
      const callbackId = `healthCallback_${Date.now()}`;
      window[callbackId] = (data) => {
        delete window[callbackId];
        if (data && typeof data.steps === 'number') {
          resolve({ steps: data.steps });
        } else {
          resolve(null);
        }
      };
      try {
        window.webkit.messageHandlers.healthKit.postMessage({
          action: 'getSteps',
          date: dateStr,
          callback: callbackId
        });
        // Timeout after 10s
        setTimeout(() => {
          if (window[callbackId]) {
            delete window[callbackId];
            reject(new Error('Health API request timed out'));
          }
        }, 10000);
      } catch (e) {
        delete window[callbackId];
        reject(e);
      }
    });
  }

  return null;
}

/**
 * Compares the health-synced value with the existing entry and returns the higher one.
 * @param {number} healthSteps - Steps from health API
 * @param {number|null} existingSteps - Currently stored step count (null if no entry)
 * @returns {{ keepValue: number, source: string, changed: boolean }}
 */
export function resolveStepConflict(healthSteps, existingSteps, healthSource) {
  if (existingSteps === null || existingSteps === undefined) {
    // No existing entry, use health value
    return { keepValue: healthSteps, source: healthSource, changed: true };
  }
  if (healthSteps > existingSteps) {
    // Health value is higher — overwrite
    return { keepValue: healthSteps, source: healthSource, changed: true };
  }
  // Manual (existing) value is higher or equal — keep it
  return { keepValue: existingSteps, source: 'manual', changed: false };
}

/**
 * Attempts to get today's step count from the device health API.
 * On success: fetches existing entry for today, compares, upserts the higher value.
 * On failure/unsupported: returns { synced: false, reason: '...' }
 *
 * @returns {Promise<{ synced: boolean, stepCount?: number, source?: string, reason?: string }>}
 */
export async function syncFromHealthAPI() {
  const user = getCurrentUser();
  if (!user) {
    return { synced: false, reason: 'Not authenticated' };
  }

  const platform = detectHealthPlatform();
  if (!platform) {
    return {
      synced: false,
      reason: 'Your device does not support health data sync. Please enter your steps manually.'
    };
  }

  const today = localDateKey();

  // Request data from health API
  let healthData;
  try {
    healthData = await requestHealthData(platform, today);
  } catch (err) {
    return {
      synced: false,
      reason: `Health sync failed: ${err.message || 'Permission denied or unavailable'}. Your existing entry remains unchanged.`
    };
  }

  if (!healthData || typeof healthData.steps !== 'number') {
    return {
      synced: false,
      reason: 'Health sync was unsuccessful — no data returned. Your existing entry remains unchanged.'
    };
  }

  // Validate the received step count
  const stepValidation = validateStepCount(healthData.steps);
  if (!stepValidation.valid) {
    return {
      synced: false,
      reason: 'Health API returned an invalid step count. Your existing entry remains unchanged.'
    };
  }

  // Fetch existing entry for today
  const { data: existingEntry, error: fetchError } = await supabase
    .from('steps_log')
    .select('step_count, source')
    .eq('user_id', user.id)
    .eq('log_date', today)
    .maybeSingle();

  if (fetchError) {
    return {
      synced: false,
      reason: 'Failed to check existing step data. Your existing entry remains unchanged.'
    };
  }

  const existingSteps = existingEntry ? existingEntry.step_count : null;
  const { keepValue, source } = resolveStepConflict(healthData.steps, existingSteps, platform);

  // Upsert with the resolved value
  const { error: upsertError } = await supabase
    .from('steps_log')
    .upsert(
      {
        user_id: user.id,
        log_date: today,
        step_count: keepValue,
        source: source,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,log_date' }
    )
    .select()
    .single();

  if (upsertError) {
    return {
      synced: false,
      reason: 'Failed to save synced step data. Your existing entry remains unchanged.'
    };
  }

  return {
    synced: true,
    stepCount: keepValue,
    source: source
  };
}

// --- Goal Validation and Management ---

/**
 * Validates that a goal value is between 1 and 200,000 inclusive.
 * @param {number} goal
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateGoal(goal) {
  const g = Number(goal);
  if (!Number.isInteger(g) || g < MIN_GOAL || g > MAX_GOAL) {
    return { valid: false, error: `Goal must be between ${MIN_GOAL.toLocaleString()} and ${MAX_GOAL.toLocaleString()} steps` };
  }
  return { valid: true };
}

/**
 * Persists the user's daily step goal. Validates the goal before saving.
 * Goal changes apply prospectively only.
 * @param {number} goal - The new daily step goal
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function setDailyGoal(goal) {
  const validation = validateGoal(goal);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const user = getCurrentUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  const { error } = await supabase
    .from('user_settings')
    .upsert(
      {
        user_id: user.id,
        setting_key: 'daily_step_goal',
        setting_value: String(goal),
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id,setting_key' }
    );

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}

/**
 * Fetches the user's current daily step goal from the database.
 * Returns the default goal (10,000) if no custom goal is configured.
 * @param {string} userId - The user's ID
 * @returns {Promise<{ success: boolean, goal?: number, error?: string }>}
 */
export async function getDailyGoal(userId) {
  if (!userId) {
    return { success: false, error: 'User ID is required' };
  }

  const { data, error } = await supabase
    .from('user_settings')
    .select('setting_value')
    .eq('user_id', userId)
    .eq('setting_key', 'daily_step_goal')
    .maybeSingle();

  if (error) {
    return { success: false, error: error.message };
  }

  if (!data) {
    return { success: true, goal: DEFAULT_GOAL };
  }

  const goal = parseInt(data.setting_value, 10);
  if (isNaN(goal) || goal < MIN_GOAL || goal > MAX_GOAL) {
    return { success: true, goal: DEFAULT_GOAL };
  }

  return { success: true, goal };
}

// --- Streak Calculation ---

/**
 * Calculates the current and longest streak from a step log history.
 * Pure function — no DB calls, fully testable.
 *
 * @param {Array<{log_date: string, step_count: number}>} stepsLog - Sorted by log_date descending
 * @param {number} [goal=10000] - The step goal (positive integer)
 * @returns {{ currentStreak: number, longestStreak: number, lastActiveDate: Date|null }}
 */
export function calculateStreak(stepsLog, goal = DEFAULT_GOAL) {
  // ASSERT: stepsLog sorted by log_date descending
  // ASSERT: goal > 0

  if (!stepsLog || stepsLog.length === 0) {
    return { currentStreak: 0, longestStreak: 0, lastActiveDate: null };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let currentStreak = 0;
  let longestStreak = 0;
  let tempStreak = 0;
  let lastActiveDate = null;
  let expectDate = today;

  // Allow streak to start from yesterday if today not yet logged
  const firstLogDate = new Date(stepsLog[0].log_date + 'T00:00:00');
  firstLogDate.setHours(0, 0, 0, 0);

  if (firstLogDate.getTime() === today.getTime() - 86400000) {
    expectDate = new Date(today.getTime() - 86400000);
  }

  // INVARIANT: at iteration i, tempStreak = consecutive days meeting goal
  //            counting backwards from expectDate
  let streakBroken = false;

  for (let i = 0; i < stepsLog.length; i++) {
    const entry = stepsLog[i];
    const entryDate = new Date(entry.log_date + 'T00:00:00');
    entryDate.setHours(0, 0, 0, 0);

    if (entry.step_count >= goal) {
      if (!lastActiveDate) lastActiveDate = entryDate;
      tempStreak++;

      if (!streakBroken) {
        const diffDays = Math.round(
          (expectDate.getTime() - entryDate.getTime()) / 86400000
        );
        if (diffDays === 0) {
          currentStreak = tempStreak;
          expectDate = new Date(entryDate.getTime() - 86400000);
        } else {
          streakBroken = true;
          tempStreak = 1; // restart for longest calc
        }
      }
    } else {
      tempStreak = 0;
      if (!streakBroken) streakBroken = true;
    }

    longestStreak = Math.max(longestStreak, tempStreak);
  }

  // POSTCONDITION: currentStreak <= longestStreak
  return { currentStreak, longestStreak, lastActiveDate };
}

// --- Streak UI ---

/**
 * Renders the streak display into the given container.
 * @param {HTMLElement} container - The container element to render into
 * @param {{ currentStreak: number, longestStreak: number, lastActiveDate: Date|null }} streakData
 */
export function renderStreakDisplay(container, streakData) {
  const { currentStreak, longestStreak, lastActiveDate } = streakData;

  let lastActiveStr = 'Never';
  let lastActiveISO = '';
  if (lastActiveDate) {
    const y = lastActiveDate.getFullYear();
    const m = String(lastActiveDate.getMonth() + 1).padStart(2, '0');
    const d = String(lastActiveDate.getDate()).padStart(2, '0');
    lastActiveStr = `${y}-${m}-${d}`;
    lastActiveISO = lastActiveDate.toISOString();
  }

  container.innerHTML = `
    <div class="card" id="streak-card">
      <div class="card-header">
        <h3 class="card-title">Step Streak</h3>
      </div>
      <div class="card-body streak-body">
        <div class="streak-stat" aria-label="Current streak: ${currentStreak} days">
          <span class="streak-value input-num" id="current-streak-value">${currentStreak}</span>
          <span class="streak-label">Current Streak</span>
          <span class="streak-unit">days</span>
        </div>
        <div class="streak-stat" aria-label="Longest streak: ${longestStreak} days">
          <span class="streak-value input-num" id="longest-streak-value">${longestStreak}</span>
          <span class="streak-label">Longest Streak</span>
          <span class="streak-unit">days</span>
        </div>
        <div class="streak-meta">
          <span class="streak-last-active">Last goal met: <time datetime="${lastActiveISO}">${lastActiveStr}</time></span>
        </div>
      </div>
    </div>
  `;
}

// --- UI ---

/**
 * Renders the step logging form into the steps view container.
 * @param {HTMLElement} container - The container to render into
 */
export function renderStepLogForm(container) {
  const today = localDateKey();

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Log Steps</h3>
      </div>
      <div class="card-body">
        <form id="step-log-form" novalidate>
          <div class="input-group">
            <label class="input-label" for="step-date">Date</label>
            <input
              type="date"
              id="step-date"
              class="input"
              value="${today}"
              max="${today}"
              aria-describedby="step-date-error"
            />
            <span id="step-date-error" class="input-error-msg" role="alert" aria-live="polite"></span>
          </div>

          <div class="input-group mt-3">
            <label class="input-label" for="step-count">Step Count</label>
            <input
              type="number"
              id="step-count"
              class="input input-num"
              placeholder="e.g. 10000"
              min="0"
              max="200000"
              step="1"
              aria-describedby="step-count-error"
            />
            <span id="step-count-error" class="input-error-msg" role="alert" aria-live="polite"></span>
          </div>

          <div class="card-footer">
            <button type="submit" class="btn btn-primary">Log Steps</button>
            <button type="button" id="sync-health-btn" class="btn btn-secondary">Sync from Health</button>
          </div>

          <div id="step-log-success" class="toast-success-inline hidden" role="status" aria-live="polite"></div>
          <div id="step-sync-error" class="input-error-msg hidden" role="alert" aria-live="polite"></div>
        </form>
      </div>
    </div>
  `;

  // Attach form submission handler
  const form = container.querySelector('#step-log-form');
  form.addEventListener('submit', handleStepFormSubmit);

  // Attach health sync button handler
  const syncBtn = container.querySelector('#sync-health-btn');
  syncBtn.addEventListener('click', handleHealthSync);
}

/**
 * Handles the health sync button click.
 * Triggers syncFromHealthAPI and updates UI accordingly.
 * @param {Event} event
 */
async function handleHealthSync(event) {
  const form = event.target.closest('form');
  const syncBtn = event.target;
  const successEl = form.querySelector('#step-log-success');
  const syncErrorEl = form.querySelector('#step-sync-error');
  const countInput = form.querySelector('#step-count');

  // Clear previous messages
  successEl.classList.add('hidden');
  successEl.textContent = '';
  syncErrorEl.classList.add('hidden');
  syncErrorEl.textContent = '';

  // Disable button during sync
  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing…';

  const result = await syncFromHealthAPI();

  syncBtn.disabled = false;
  syncBtn.textContent = 'Sync from Health';

  if (result.synced) {
    successEl.textContent = `Synced ${result.stepCount.toLocaleString()} steps from ${result.source === 'health_connect' ? 'Health Connect' : 'Apple Health'}`;
    successEl.classList.remove('hidden');
    // Update the form's step count field to reflect the synced value
    countInput.value = result.stepCount;
  } else {
    syncErrorEl.textContent = result.reason;
    syncErrorEl.classList.remove('hidden');
  }
}

/**
 * Handles the step logging form submission.
 * Validates, shows inline errors, preserves form data on failure, shows success on success.
 * @param {Event} event
 */
async function handleStepFormSubmit(event) {
  event.preventDefault();

  const form = event.target;
  const dateInput = form.querySelector('#step-date');
  const countInput = form.querySelector('#step-count');
  const dateError = form.querySelector('#step-date-error');
  const countError = form.querySelector('#step-count-error');
  const successEl = form.querySelector('#step-log-success');
  const submitBtn = form.querySelector('button[type="submit"]');

  // Clear previous errors and success
  clearFieldError(dateInput, dateError);
  clearFieldError(countInput, countError);
  successEl.classList.add('hidden');
  successEl.textContent = '';

  const date = dateInput.value;
  const stepCount = countInput.value;

  // Validate date
  let hasError = false;
  const dateValidation = validateDate(date);
  if (!dateValidation.valid) {
    showFieldError(dateInput, dateError, dateValidation.error);
    hasError = true;
  }

  // Validate step count
  const stepValidation = validateStepCount(stepCount);
  if (!stepValidation.valid) {
    showFieldError(countInput, countError, stepValidation.error);
    hasError = true;
  }

  if (hasError) {
    // Preserve form data — do nothing to the inputs
    return;
  }

  // Disable submit while processing
  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging…';

  const result = await logSteps(date, Number(stepCount));

  submitBtn.disabled = false;
  submitBtn.textContent = 'Log Steps';

  if (result.success) {
    successEl.textContent = `Steps logged successfully for ${date}`;
    successEl.classList.remove('hidden');
  } else {
    // Show server-side error as a general form error
    if (result.field === 'date') {
      showFieldError(dateInput, dateError, result.error);
    } else if (result.field === 'steps') {
      showFieldError(countInput, countError, result.error);
    } else {
      // General error — show below the form
      showFieldError(countInput, countError, result.error);
    }
  }
}

// --- UI Helpers ---

function showFieldError(input, errorEl, message) {
  input.classList.add('input-error');
  errorEl.textContent = message;
}

function clearFieldError(input, errorEl) {
  input.classList.remove('input-error');
  errorEl.textContent = '';
}

// --- Partner Visibility ---

/** @type {object|null} Supabase realtime channel for steps_log */
let stepsRealtimeChannel = null;

/**
 * Generates an array of date strings (YYYY-MM-DD) from startDate to endDate inclusive.
 * @param {string} startDate - ISO date string (YYYY-MM-DD)
 * @param {string} endDate - ISO date string (YYYY-MM-DD)
 * @returns {string[]}
 */
export function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (current <= end) {
    dates.push(localDateKey(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Fetches step data for both partners within a date range.
 * Returns a map keyed by date with each entry containing both partners' step counts.
 * Shows 0 for any date where a partner has no logged entry.
 *
 * @param {string} startDate - ISO date string (YYYY-MM-DD)
 * @param {string} endDate - ISO date string (YYYY-MM-DD)
 * @returns {Promise<{ success: boolean, data?: Array<{date: string, userSteps: number, partnerSteps: number}>, error?: string }>}
 */
export async function fetchPartnerSteps(startDate, endDate) {
  const user = getCurrentUser();
  const partner = getPartner();

  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }
  if (!partner) {
    return { success: false, error: 'Partner not linked' };
  }

  const { data, error } = await supabase
    .from('steps_log')
    .select('user_id, log_date, step_count')
    .gte('log_date', startDate)
    .lte('log_date', endDate)
    .in('user_id', [user.id, partner.id]);

  if (error) {
    return { success: false, error: error.message };
  }

  // Build lookup by user_id+date
  const stepsByUserDate = {};
  (data || []).forEach(entry => {
    const key = `${entry.user_id}_${entry.log_date}`;
    stepsByUserDate[key] = entry.step_count;
  });

  // Generate full date range with 0 for missing entries
  const dates = getDateRange(startDate, endDate);
  const result = dates.map(date => ({
    date,
    userSteps: stepsByUserDate[`${user.id}_${date}`] ?? 0,
    partnerSteps: stepsByUserDate[`${partner.id}_${date}`] ?? 0
  }));

  return { success: true, data: result };
}

/**
 * Renders the partner comparison view showing both partners' step counts.
 * @param {HTMLElement} container - The container element to render into
 * @param {Array<{date: string, userSteps: number, partnerSteps: number}>} stepsData - The steps data
 */
export function renderPartnerComparison(container, stepsData) {
  const user = getCurrentUser();
  const partner = getPartner();
  const userName = escapeHtml(displayName(user, 'You'));
  const partnerName = escapeHtml(displayName(partner, 'Partner'));

  const rows = stepsData.map(entry => {
    const highlightClass = entry.userSteps > entry.partnerSteps
      ? 'user-higher'
      : entry.partnerSteps > entry.userSteps
        ? 'partner-higher'
        : 'tied';

    return `
      <tr class="step-comparison-row ${highlightClass}" data-date="${entry.date}">
        <td class="step-date-cell">${entry.date}</td>
        <td class="step-count-cell input-num" data-user-steps="${entry.date}">${entry.userSteps.toLocaleString()}</td>
        <td class="step-count-cell input-num" data-partner-steps="${entry.date}">${entry.partnerSteps.toLocaleString()}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <div class="card" id="partner-steps-card">
      <div class="card-header">
        <h3 class="card-title">Partner Steps</h3>
      </div>
      <div class="card-body">
        <table class="step-comparison-table" aria-label="Step comparison between partners">
          <thead>
            <tr>
              <th>Date</th>
              <th>${userName}</th>
              <th>${partnerName}</th>
            </tr>
          </thead>
          <tbody id="partner-steps-tbody">
            ${rows}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * Updates a single row in the partner comparison view when realtime data arrives.
 * @param {string} userId - The user_id that changed
 * @param {string} logDate - The date that changed (YYYY-MM-DD)
 * @param {number} stepCount - The new step count
 */
export function updatePartnerStepDisplay(userId, logDate, stepCount) {
  const user = getCurrentUser();
  const partner = getPartner();
  if (!user || !partner) return;

  const isUserRow = userId === user.id;
  const selector = isUserRow
    ? `[data-user-steps="${logDate}"]`
    : `[data-partner-steps="${logDate}"]`;

  const cell = document.querySelector(selector);
  if (cell) {
    cell.textContent = stepCount.toLocaleString();

    // Update row highlight class
    const row = cell.closest('.step-comparison-row');
    if (row) {
      const userCell = row.querySelector(`[data-user-steps="${logDate}"]`);
      const partnerCell = row.querySelector(`[data-partner-steps="${logDate}"]`);
      if (userCell && partnerCell) {
        const userSteps = parseInt(userCell.textContent.replace(/,/g, ''), 10) || 0;
        const partnerSteps = parseInt(partnerCell.textContent.replace(/,/g, ''), 10) || 0;

        row.classList.remove('user-higher', 'partner-higher', 'tied');
        if (userSteps > partnerSteps) row.classList.add('user-higher');
        else if (partnerSteps > userSteps) row.classList.add('partner-higher');
        else row.classList.add('tied');
      }
    }
  }
}

/**
 * Subscribes to the steps_log realtime channel.
 * Updates the partner display within 5 seconds when data changes.
 */
export function subscribeToStepsRealtime() {
  // Avoid duplicate subscriptions
  if (stepsRealtimeChannel) return;

  stepsRealtimeChannel = supabase
    .channel('steps_log_partner')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'steps_log' },
      (payload) => {
        const record = payload.new || payload.old;
        if (record && record.log_date && typeof record.step_count === 'number') {
          updatePartnerStepDisplay(record.user_id, record.log_date, record.step_count);
        }
      }
    )
    .subscribe();
}

/**
 * Unsubscribes from the steps_log realtime channel.
 */
export function unsubscribeFromStepsRealtime() {
  if (stepsRealtimeChannel) {
    supabase.removeChannel(stepsRealtimeChannel);
    stepsRealtimeChannel = null;
  }
}

/**
 * Activates the Steps module view — called when the steps tab is selected.
 * @param {HTMLElement} container - The #steps-view container
 */
export function activate(container) {
  if (!container) return;

  container.innerHTML = `
    <div id="steps-hero-section">
      <div class="hero">
        <span class="hero-label">Today</span>
        <div class="hero-value"><span class="hero-num">—</span></div>
      </div>
    </div>
    <div id="steps-stats-section"></div>
    <section>
      <div class="section-heading"><h3>Comparison</h3></div>
      <div id="steps-comparative-section"></div>
    </section>
    <section>
      <div class="section-heading"><h3>Streak</h3></div>
      <div id="steps-streak-section"></div>
    </section>
    <section>
      <div class="section-heading"><h3>Last 7 days</h3></div>
      <div id="steps-comparison-section"></div>
    </section>
    <details class="disclosure" id="steps-form-disclosure">
      <summary>
        <span>Log steps</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="steps-form-section"></div>
    </details>
    <details class="disclosure" id="steps-goal-disclosure">
      <summary>
        <span>Daily goal</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="steps-goal-section"></div>
    </details>
    <details class="disclosure" id="steps-device-disclosure">
      <summary>
        <span>Sync from your phone</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="steps-device-section"></div>
    </details>
  `;

  renderStepLogForm(container.querySelector('#steps-form-section'));
  renderGoalForm(container.querySelector('#steps-goal-section'));
  renderDeviceSyncPanel(container.querySelector('#steps-device-section'));

  loadStepsDashboard(container);

  // Subscribe to realtime updates
  subscribeToStepsRealtime();
}

/**
 * Fetches step history and populates the hero, tiles, comparison,
 * streak and 7-day table sections of the steps view.
 * @param {HTMLElement} container - The #steps-view container
 */
export async function loadStepsDashboard(container) {
  const user = getCurrentUser();
  if (!user) return;

  const today = new Date();
  const todayStr = toISODate(today);

  // Goal drives both the hero progress and the streak threshold
  const goalResult = await getDailyGoal(user.id);
  const goal = goalResult.success ? goalResult.goal : DEFAULT_GOAL;

  // 7 days for the comparison table and comparative stats
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 6);
  const weekResult = await fetchPartnerSteps(toISODate(weekAgo), todayStr);
  const weekData = weekResult.success ? weekResult.data : [];

  // 90 days of the user's own log for the streak calculation
  const streakStart = new Date(today);
  streakStart.setDate(streakStart.getDate() - 89);
  const { data: ownLog } = await supabase
    .from('steps_log')
    .select('log_date, step_count')
    .eq('user_id', user.id)
    .gte('log_date', toISODate(streakStart))
    .lte('log_date', todayStr)
    .order('log_date', { ascending: false });

  const streak = calculateStreak(ownLog || [], goal);
  const todayEntry = weekData.find(d => d.date === todayStr);
  const todaySteps = todayEntry ? todayEntry.userSteps : 0;
  const weekTotal = weekData.reduce((sum, d) => sum + d.userSteps, 0);
  const weekAverage = weekData.length > 0 ? Math.round(weekTotal / weekData.length) : 0;
  const remaining = Math.max(0, goal - todaySteps);
  const pctOfGoal = goal > 0 ? Math.round((todaySteps / goal) * 100) : 0;

  // --- Hero: today's steps against the goal ---
  const heroSection = container.querySelector('#steps-hero-section');
  if (heroSection) {
    heroSection.innerHTML = `
      <div class="hero">
        <span class="hero-label">Steps today</span>
        <div class="hero-value">
          <span class="hero-num">${formatNumber(todaySteps)}</span>
          <span class="hero-unit">of ${formatNumber(goal)}</span>
        </div>
        <div class="hero-sub">
          <span class="num">${pctOfGoal}%</span>
          <span class="divider">·</span>
          <span>${remaining === 0
            ? 'Goal met'
            : `<span class="num">${formatNumber(remaining)}</span> to go`}</span>
        </div>
      </div>
    `;
  }

  // --- Tiles: streak and weekly rollups ---
  const statsSection = container.querySelector('#steps-stats-section');
  if (statsSection) {
    statsSection.innerHTML = `
      <div class="stat-tiles">
        <div class="stat-tile stat-tile--a">
          <span class="stat-tile-label">Current streak</span>
          <span class="stat-tile-value">${streak.currentStreak}<small>days</small></span>
        </div>
        <div class="stat-tile stat-tile--shared">
          <span class="stat-tile-label">Longest streak</span>
          <span class="stat-tile-value">${streak.longestStreak}<small>days</small></span>
        </div>
        <div class="stat-tile stat-tile--shared">
          <span class="stat-tile-label">7-day total</span>
          <span class="stat-tile-value">${formatNumber(weekTotal)}</span>
        </div>
        <div class="stat-tile stat-tile--shared">
          <span class="stat-tile-label">Daily average</span>
          <span class="stat-tile-value">${formatNumber(weekAverage)}</span>
        </div>
      </div>
    `;
  }

  const comparativeSection = container.querySelector('#steps-comparative-section');
  if (comparativeSection) {
    renderComparativeStats(comparativeSection, getComparativeStats(weekData));
  }

  const streakSection = container.querySelector('#steps-streak-section');
  if (streakSection) {
    renderStreakDisplay(streakSection, streak);
  }

  const comparisonSection = container.querySelector('#steps-comparison-section');
  if (comparisonSection) {
    if (weekData.length > 0) {
      renderPartnerComparison(comparisonSection, weekData);
    } else {
      comparisonSection.innerHTML = `<div class="empty-state">No step data for the last 7 days yet.</div>`;
    }
  }
}

/**
 * Renders the daily step goal form.
 * @param {HTMLElement} container
 */
export function renderGoalForm(container) {
  if (!container) return;

  container.innerHTML = `
    <form id="step-goal-form" novalidate>
      <div class="input-group">
        <label class="input-label" for="step-goal">Daily step goal</label>
        <input
          type="number"
          id="step-goal"
          class="input input-num"
          min="${MIN_GOAL}"
          max="${MAX_GOAL}"
          step="1"
          placeholder="${DEFAULT_GOAL}"
          aria-describedby="step-goal-error"
        />
        <span id="step-goal-error" class="input-error-msg" role="alert" aria-live="polite"></span>
      </div>
      <div class="card-footer">
        <button type="submit" class="btn btn-secondary">Save goal</button>
      </div>
      <div id="step-goal-success" class="toast-success-inline hidden" role="status" aria-live="polite"></div>
    </form>
  `;

  const user = getCurrentUser();
  const input = container.querySelector('#step-goal');
  if (user) {
    getDailyGoal(user.id).then(result => {
      if (result.success && input) input.value = result.goal;
    });
  }

  container.querySelector('#step-goal-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = container.querySelector('#step-goal-error');
    const successEl = container.querySelector('#step-goal-success');
    errorEl.textContent = '';
    successEl.classList.add('hidden');

    const result = await setDailyGoal(Number(input.value));
    if (!result.success) {
      input.classList.add('input-error');
      errorEl.textContent = result.error;
      return;
    }

    input.classList.remove('input-error');
    successEl.textContent = `Goal set to ${formatNumber(input.value)} steps`;
    successEl.classList.remove('hidden');

    // Goal affects the hero and streak, so refresh the dashboard
    const view = document.getElementById('steps-view');
    if (view) loadStepsDashboard(view);
  });
}

/**
 * Formats a Date as a local ISO date string (YYYY-MM-DD).
 * Avoids the UTC shift that toISOString() introduces for local dates.
 * @param {Date} date
 * @returns {string}
 */
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// --- Comparative Statistics ---

/**
 * Returns the ISO week boundaries (Monday–Sunday) for the given date.
 * @param {Date} refDate - Reference date
 * @returns {{ weekStart: string, weekEnd: string }} ISO date strings (YYYY-MM-DD)
 */
export function getISOWeekBounds(refDate) {
  const d = new Date(refDate);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat → convert to Mon=0
  const dayOfWeek = d.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(d);
  monday.setDate(d.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    weekStart: localDateKey(monday),
    weekEnd: localDateKey(sunday)
  };
}

/**
 * Computes comparative statistics (daily and weekly) from partner steps data.
 * @param {Array<{date: string, userSteps: number, partnerSteps: number}>} stepsData
 * @returns {{ daily: { userTotal: number, partnerTotal: number, leader: 'user'|'partner'|'tied' }, weekly: { userTotal: number, partnerTotal: number, leader: 'user'|'partner'|'tied' } }}
 */
export function getComparativeStats(stepsData) {
  const today = localDateKey();
  const { weekStart, weekEnd } = getISOWeekBounds(new Date());

  // Daily: today's step count for each partner
  let dailyUser = 0;
  let dailyPartner = 0;

  // Weekly: sum of Mon–Sun step counts for each partner
  let weeklyUser = 0;
  let weeklyPartner = 0;

  for (const entry of stepsData) {
    if (entry.date === today) {
      dailyUser = entry.userSteps;
      dailyPartner = entry.partnerSteps;
    }
    if (entry.date >= weekStart && entry.date <= weekEnd) {
      weeklyUser += entry.userSteps;
      weeklyPartner += entry.partnerSteps;
    }
  }

  const getLeader = (user, partner) => {
    if (user > partner) return 'user';
    if (partner > user) return 'partner';
    return 'tied';
  };

  return {
    daily: {
      userTotal: dailyUser,
      partnerTotal: dailyPartner,
      leader: getLeader(dailyUser, dailyPartner)
    },
    weekly: {
      userTotal: weeklyUser,
      partnerTotal: weeklyPartner,
      leader: getLeader(weeklyUser, weeklyPartner)
    }
  };
}

/**
 * Renders comparative statistics (daily and weekly) into the given container.
 * @param {HTMLElement} container - The container element to render into
 * @param {{ daily: { userTotal: number, partnerTotal: number, leader: string }, weekly: { userTotal: number, partnerTotal: number, leader: string } }} stats
 */
export function renderComparativeStats(container, stats) {
  const user = getCurrentUser();
  const partner = getPartner();
  const userName = escapeHtml(displayName(user, 'You'));
  const partnerName = escapeHtml(displayName(partner, 'Partner'));

  const renderIndicator = (leader) => {
    if (leader === 'user') return '<span class="leader-indicator user-leads" aria-label="Leading">▲</span>';
    if (leader === 'partner') return '<span class="leader-indicator partner-leads" aria-label="Leading">▲</span>';
    return '<span class="tied-indicator" aria-label="Tied">=</span>';
  };

  container.innerHTML = `
    <div class="card" id="comparative-stats-card">
      <div class="card-header">
        <h3 class="card-title">Comparison</h3>
      </div>
      <div class="card-body">
        <div class="comparative-section" id="daily-comparison">
          <h4 class="comparative-period">Today</h4>
          <div class="comparative-row ${stats.daily.leader === 'tied' ? 'tied' : ''}">
            <div class="comparative-partner">
              <span class="comparative-name">${userName}</span>
              <span class="comparative-value input-num" data-daily-user>${stats.daily.userTotal.toLocaleString()}</span>
              ${stats.daily.leader === 'user' ? renderIndicator('user') : ''}
            </div>
            <div class="comparative-vs">
              ${stats.daily.leader === 'tied' ? renderIndicator('tied') : 'vs'}
            </div>
            <div class="comparative-partner">
              <span class="comparative-name">${partnerName}</span>
              <span class="comparative-value input-num" data-daily-partner>${stats.daily.partnerTotal.toLocaleString()}</span>
              ${stats.daily.leader === 'partner' ? renderIndicator('partner') : ''}
            </div>
          </div>
        </div>
        <div class="comparative-section" id="weekly-comparison">
          <h4 class="comparative-period">This Week</h4>
          <div class="comparative-row ${stats.weekly.leader === 'tied' ? 'tied' : ''}">
            <div class="comparative-partner">
              <span class="comparative-name">${userName}</span>
              <span class="comparative-value input-num" data-weekly-user>${stats.weekly.userTotal.toLocaleString()}</span>
              ${stats.weekly.leader === 'user' ? renderIndicator('user') : ''}
            </div>
            <div class="comparative-vs">
              ${stats.weekly.leader === 'tied' ? renderIndicator('tied') : 'vs'}
            </div>
            <div class="comparative-partner">
              <span class="comparative-name">${partnerName}</span>
              <span class="comparative-value input-num" data-weekly-partner>${stats.weekly.partnerTotal.toLocaleString()}</span>
              ${stats.weekly.leader === 'partner' ? renderIndicator('partner') : ''}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// --- Listen for view changes to activate steps module ---
window.addEventListener('viewchange', (event) => {
  if (event.detail.view === 'steps') {
    const container = document.getElementById('steps-view');
    if (container) {
      activate(container);
    }
  } else {
    // Unsubscribe when leaving the steps view
    unsubscribeFromStepsRealtime();
  }
});
