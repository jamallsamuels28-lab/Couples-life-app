// ============================================================
// Dietary Preferences — Couples Life App
// CRUD operations, validation, and UI for dietary preferences.
// ============================================================

import { supabase } from './supabase-client.js';
import { getCurrentUser, getPartner } from './app-shell.js';

// --- Constants ---

export const VALID_DIET_TYPES = ['flexible', 'vegetarian', 'vegan', 'keto', 'halal'];
export const MAX_ALLERGIES = 20;
export const MAX_DISLIKES = 30;

// --- Validation ---

/**
 * Validate dietary preferences data before upserting.
 * Returns { valid: boolean, errors: Record<string, string> }
 */
export function validatePreferences(prefsData) {
  const errors = {};

  // Validate diet_type
  if (prefsData.diet_type && !VALID_DIET_TYPES.includes(prefsData.diet_type)) {
    errors.diet_type = `Invalid diet type. Valid options are: ${VALID_DIET_TYPES.join(', ')}`;
  }

  // Validate allergies array length
  if (Array.isArray(prefsData.allergies) && prefsData.allergies.length > MAX_ALLERGIES) {
    errors.allergies = `Maximum ${MAX_ALLERGIES} allergies allowed`;
  }

  // Validate dislikes array length
  if (Array.isArray(prefsData.dislikes) && prefsData.dislikes.length > MAX_DISLIKES) {
    errors.dislikes = `Maximum ${MAX_DISLIKES} dislikes allowed`;
  }

  // Validate macro targets (must be positive integers if provided)
  const macroFields = ['calorie_target', 'protein_target', 'carbs_target', 'fats_target'];
  for (const field of macroFields) {
    const value = prefsData[field];
    if (value !== null && value !== undefined && value !== '') {
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0) {
        errors[field] = `${field.replace('_', ' ')} must be a positive integer`;
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

// --- Data Access ---

/**
 * Fetch the dietary preferences for a given user.
 * Returns the preferences record or null if none exists.
 */
export async function getPreferences(userId) {
  const { data, error } = await supabase
    .from('dietary_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch preferences: ${error.message}`);
  }

  return data;
}

/**
 * Validate and upsert dietary preferences for the current user.
 * Uses upsert with onConflict: 'user_id' for one-record-per-user semantics.
 * Returns { success: boolean, data?, errors? }
 */
export async function updatePreferences(prefsData) {
  const user = getCurrentUser();
  if (!user) {
    return { success: false, errors: { general: 'Not authenticated' } };
  }

  // Client-side validation
  const { valid, errors } = validatePreferences(prefsData);
  if (!valid) {
    return { success: false, errors };
  }

  // Prepare the record for upsert
  const record = {
    user_id: user.id,
    allergies: Array.isArray(prefsData.allergies) ? prefsData.allergies : [],
    dislikes: Array.isArray(prefsData.dislikes) ? prefsData.dislikes : [],
    diet_type: prefsData.diet_type || 'flexible',
    calorie_target: prefsData.calorie_target ? Number(prefsData.calorie_target) : null,
    protein_target: prefsData.protein_target ? Number(prefsData.protein_target) : null,
    carbs_target: prefsData.carbs_target ? Number(prefsData.carbs_target) : null,
    fats_target: prefsData.fats_target ? Number(prefsData.fats_target) : null,
    updated_at: new Date().toISOString()
  };

  const { data, error } = await supabase
    .from('dietary_preferences')
    .upsert(record, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) {
    return { success: false, errors: { general: `Save failed: ${error.message}` } };
  }

  return { success: true, data };
}

/**
 * Fetch both partners' dietary preferences for recipe generation.
 * Returns { user: prefs | null, partner: prefs | null }
 */
export async function getBothPreferences() {
  const user = getCurrentUser();
  const partnerProfile = getPartner();

  if (!user) {
    throw new Error('Not authenticated');
  }

  const { data, error } = await supabase
    .from('dietary_preferences')
    .select('*');

  if (error) {
    throw new Error(`Failed to fetch preferences: ${error.message}`);
  }

  const userPrefs = data?.find(p => p.user_id === user.id) || null;
  const partnerPrefs = partnerProfile
    ? data?.find(p => p.user_id === partnerProfile.id) || null
    : null;

  return { user: userPrefs, partner: partnerPrefs };
}

// --- UI Rendering ---

/**
 * Render the dietary preferences form into a container element.
 * Shows a settings section with diet type, allergies, dislikes, and macro targets.
 */
export function renderPreferencesForm(container, existingPrefs = null) {
  const prefs = existingPrefs || {
    diet_type: 'flexible',
    allergies: [],
    dislikes: [],
    calorie_target: null,
    protein_target: null,
    carbs_target: null,
    fats_target: null
  };

  container.innerHTML = `
    <section class="card dietary-prefs-section" aria-label="Dietary Preferences">
      <div class="card-header">
        <h3 class="card-title">Dietary Preferences</h3>
      </div>
      <form id="dietary-prefs-form" class="card-body" novalidate>
        <!-- Diet Type -->
        <div class="input-group">
          <label class="input-label" for="diet-type-select">Diet Type</label>
          <select id="diet-type-select" class="input" name="diet_type">
            ${VALID_DIET_TYPES.map(type =>
              `<option value="${type}" ${prefs.diet_type === type ? 'selected' : ''}>${type.charAt(0).toUpperCase() + type.slice(1)}</option>`
            ).join('')}
          </select>
          <span class="input-error-msg" id="diet-type-error" aria-live="polite"></span>
        </div>

        <!-- Allergies -->
        <div class="input-group">
          <label class="input-label" for="allergy-input">Allergies (max ${MAX_ALLERGIES})</label>
          <div class="tag-input-container" id="allergies-container">
            <div class="tag-list" id="allergies-tags"></div>
            <div class="tag-input-row">
              <input type="text" id="allergy-input" class="input" placeholder="Type an allergy and press Enter" aria-describedby="allergies-error">
              <button type="button" class="btn btn-sm btn-secondary" id="add-allergy-btn" aria-label="Add allergy">Add</button>
            </div>
          </div>
          <span class="input-error-msg" id="allergies-error" aria-live="polite"></span>
        </div>

        <!-- Dislikes -->
        <div class="input-group">
          <label class="input-label" for="dislike-input">Dislikes (max ${MAX_DISLIKES})</label>
          <div class="tag-input-container" id="dislikes-container">
            <div class="tag-list" id="dislikes-tags"></div>
            <div class="tag-input-row">
              <input type="text" id="dislike-input" class="input" placeholder="Type a dislike and press Enter" aria-describedby="dislikes-error">
              <button type="button" class="btn btn-sm btn-secondary" id="add-dislike-btn" aria-label="Add dislike">Add</button>
            </div>
          </div>
          <span class="input-error-msg" id="dislikes-error" aria-live="polite"></span>
        </div>

        <!-- Macro Targets -->
        <fieldset class="macro-targets-fieldset">
          <legend class="input-label">Daily Macro Targets</legend>
          <div class="macro-targets-grid">
            <div class="input-group">
              <label class="input-label" for="calorie-target">Calories (kcal)</label>
              <input type="number" id="calorie-target" class="input input-num" name="calorie_target" min="1" step="1" value="${prefs.calorie_target || ''}" placeholder="e.g. 2000" aria-describedby="calorie-target-error">
              <span class="input-error-msg" id="calorie-target-error" aria-live="polite"></span>
            </div>
            <div class="input-group">
              <label class="input-label" for="protein-target">Protein (g)</label>
              <input type="number" id="protein-target" class="input input-num" name="protein_target" min="1" step="1" value="${prefs.protein_target || ''}" placeholder="e.g. 150" aria-describedby="protein-target-error">
              <span class="input-error-msg" id="protein-target-error" aria-live="polite"></span>
            </div>
            <div class="input-group">
              <label class="input-label" for="carbs-target">Carbs (g)</label>
              <input type="number" id="carbs-target" class="input input-num" name="carbs_target" min="1" step="1" value="${prefs.carbs_target || ''}" placeholder="e.g. 200" aria-describedby="carbs-target-error">
              <span class="input-error-msg" id="carbs-target-error" aria-live="polite"></span>
            </div>
            <div class="input-group">
              <label class="input-label" for="fats-target">Fats (g)</label>
              <input type="number" id="fats-target" class="input input-num" name="fats_target" min="1" step="1" value="${prefs.fats_target || ''}" placeholder="e.g. 70" aria-describedby="fats-target-error">
              <span class="input-error-msg" id="fats-target-error" aria-live="polite"></span>
            </div>
          </div>
        </fieldset>

        <!-- General error -->
        <span class="input-error-msg" id="general-error" aria-live="polite"></span>

        <!-- Submit -->
        <div class="card-footer">
          <button type="submit" class="btn btn-primary" id="save-prefs-btn">Save Preferences</button>
        </div>
      </form>
    </section>
  `;

  // Initialize state
  const state = {
    allergies: [...(prefs.allergies || [])],
    dislikes: [...(prefs.dislikes || [])]
  };

  // Render initial tags
  updateTagDisplay('allergies-tags', state.allergies, state, container);
  updateTagDisplay('dislikes-tags', state.dislikes, state, container);

  // --- Event Listeners ---

  // Add allergy
  const allergyInput = container.querySelector('#allergy-input');
  const addAllergyBtn = container.querySelector('#add-allergy-btn');

  function addAllergy() {
    const value = allergyInput.value.trim();
    if (!value) return;
    if (state.allergies.length >= MAX_ALLERGIES) {
      showFieldError('allergies-error', `Maximum ${MAX_ALLERGIES} allergies allowed`, container);
      return;
    }
    if (!state.allergies.includes(value)) {
      state.allergies.push(value);
      updateTagDisplay('allergies-tags', state.allergies, state, container);
      clearFieldError('allergies-error', container);
    }
    allergyInput.value = '';
    allergyInput.focus();
  }

  addAllergyBtn.addEventListener('click', addAllergy);
  allergyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addAllergy();
    }
  });

  // Add dislike
  const dislikeInput = container.querySelector('#dislike-input');
  const addDislikeBtn = container.querySelector('#add-dislike-btn');

  function addDislike() {
    const value = dislikeInput.value.trim();
    if (!value) return;
    if (state.dislikes.length >= MAX_DISLIKES) {
      showFieldError('dislikes-error', `Maximum ${MAX_DISLIKES} dislikes allowed`, container);
      return;
    }
    if (!state.dislikes.includes(value)) {
      state.dislikes.push(value);
      updateTagDisplay('dislikes-tags', state.dislikes, state, container);
      clearFieldError('dislikes-error', container);
    }
    dislikeInput.value = '';
    dislikeInput.focus();
  }

  addDislikeBtn.addEventListener('click', addDislike);
  dislikeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDislike();
    }
  });

  // Form submission
  const form = container.querySelector('#dietary-prefs-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAllErrors(container);

    const formData = {
      diet_type: container.querySelector('#diet-type-select').value,
      allergies: state.allergies,
      dislikes: state.dislikes,
      calorie_target: container.querySelector('#calorie-target').value || null,
      protein_target: container.querySelector('#protein-target').value || null,
      carbs_target: container.querySelector('#carbs-target').value || null,
      fats_target: container.querySelector('#fats-target').value || null
    };

    const result = await updatePreferences(formData);

    if (!result.success) {
      displayErrors(container, result.errors);
    } else {
      // Show brief success indication
      const btn = container.querySelector('#save-prefs-btn');
      btn.textContent = 'Saved';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
      setTimeout(() => {
        btn.textContent = 'Save Preferences';
        btn.classList.remove('btn-secondary');
        btn.classList.add('btn-primary');
      }, 2000);
    }
  });

  return state;
}

// --- UI Helpers ---

function updateTagDisplay(containerId, items, state, rootEl) {
  const tagContainer = (rootEl || document).querySelector(`#${containerId}`);
  if (!tagContainer) return;

  tagContainer.innerHTML = items.map((item, index) => `
    <span class="badge tag-badge">
      ${escapeHtml(item)}
      <button type="button" class="tag-remove-btn" data-index="${index}" aria-label="Remove ${escapeHtml(item)}">
        <svg class="icon icon-sm" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
          <line x1="6" y1="6" x2="14" y2="14"/>
          <line x1="14" y1="6" x2="6" y2="14"/>
        </svg>
      </button>
    </span>
  `).join('');

  // Attach remove handlers
  tagContainer.querySelectorAll('.tag-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      items.splice(idx, 1);
      updateTagDisplay(containerId, items, state, rootEl);
    });
  });
}

function showFieldError(errorId, message, rootEl) {
  const el = (rootEl || document).querySelector(`#${errorId}`);
  if (el) {
    el.textContent = message;
  }
}

function clearFieldError(errorId, rootEl) {
  const el = (rootEl || document).querySelector(`#${errorId}`);
  if (el) {
    el.textContent = '';
  }
}

function clearAllErrors(container) {
  container.querySelectorAll('.input-error-msg').forEach(el => {
    el.textContent = '';
  });
  container.querySelectorAll('.input-error').forEach(el => {
    el.classList.remove('input-error');
  });
}

function displayErrors(container, errors) {
  // Map error keys to DOM element IDs
  const fieldMap = {
    diet_type: { error: 'diet-type-error', input: 'diet-type-select' },
    allergies: { error: 'allergies-error', input: null },
    dislikes: { error: 'dislikes-error', input: null },
    calorie_target: { error: 'calorie-target-error', input: 'calorie-target' },
    protein_target: { error: 'protein-target-error', input: 'protein-target' },
    carbs_target: { error: 'carbs-target-error', input: 'carbs-target' },
    fats_target: { error: 'fats-target-error', input: 'fats-target' },
    general: { error: 'general-error', input: null }
  };

  for (const [field, message] of Object.entries(errors)) {
    const mapping = fieldMap[field];
    if (mapping) {
      showFieldError(mapping.error, message);
      if (mapping.input) {
        const inputEl = container.querySelector(`#${mapping.input}`);
        if (inputEl) {
          inputEl.classList.add('input-error');
        }
      }
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Initialize the dietary preferences section in the food view.
 * Fetches existing preferences and renders the form.
 */
export async function initDietaryPreferences(container) {
  const user = getCurrentUser();
  if (!user) return;

  try {
    const prefs = await getPreferences(user.id);
    renderPreferencesForm(container, prefs);
  } catch (err) {
    container.innerHTML = `
      <div class="card">
        <p class="input-error-msg">Failed to load dietary preferences. Please try again.</p>
      </div>
    `;
  }
}
