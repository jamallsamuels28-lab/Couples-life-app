// ============================================================
// Food Module — Couples Life App
// Meal logging, validation, macro tracking, and UI
// ============================================================

import { supabase } from './supabase-client.js';
import { getCurrentUser } from './app-shell.js';
import { initRecipeBook, saveRecipe } from './recipe-book.js';
import { generateRecipe } from './recipe-generator.js';
import { initPantry } from './pantry-module.js';
import { initDietaryPreferences } from './dietary-preferences.js';
import { escapeHtml, chevronSvg, formatNumber, localDateKey } from './ui-helpers.js';
import { renderDiary, renderWeighInForm, initFoodDiary } from './food-diary.js';
import { renderNutritionSettings } from './nutrition-settings.js';
import { renderPortionSplit } from './portion-split.js';

// --- Constants ---

const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const MAX_TITLE_LENGTH = 100;
const MAX_MACRO_VALUE = 10000;
const MIN_MACRO_VALUE = 0;

// --- Validation ---

/**
 * Validates meal data and returns an object with field-level errors.
 * Returns { valid: boolean, errors: { [field]: string } }
 */
export function validateMeal(mealData) {
  const errors = {};

  // Title validation
  if (!mealData.title || mealData.title.trim().length === 0) {
    errors.title = 'Title is required';
  } else if (mealData.title.length > MAX_TITLE_LENGTH) {
    errors.title = 'Title must be 100 characters or fewer';
  }

  // Meal type validation
  if (!VALID_MEAL_TYPES.includes(mealData.meal_type)) {
    errors.meal_type = 'Meal type must be one of: breakfast, lunch, dinner, snack';
  }

  // Macro validation
  const macroFields = ['calories', 'protein_g', 'carbs_g', 'fats_g'];
  const macroLabels = {
    calories: 'Calories',
    protein_g: 'Protein',
    carbs_g: 'Carbs',
    fats_g: 'Fats'
  };

  for (const field of macroFields) {
    const value = Number(mealData[field]);
    if (isNaN(value) || value < MIN_MACRO_VALUE || value > MAX_MACRO_VALUE) {
      errors[field] = `${macroLabels[field]} must be between 0 and 10,000`;
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

// --- Data Operations ---

/**
 * Validates and inserts a meal record into the meals table.
 * Returns { success: boolean, data?: object, errors?: object }
 */
export async function logMeal(mealData) {
  // Client-side validation
  const validation = validateMeal(mealData);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const user = getCurrentUser();
  if (!user) {
    return { success: false, errors: { _form: 'You must be logged in to log a meal' } };
  }

  // Insert into meals table
  const { data, error } = await supabase
    .from('meals')
    .insert({
      user_id: user.id,
      meal_date: mealData.meal_date || localDateKey(),
      meal_type: mealData.meal_type,
      title: mealData.title.trim(),
      calories: Number(mealData.calories),
      protein_g: Number(mealData.protein_g),
      carbs_g: Number(mealData.carbs_g),
      fats_g: Number(mealData.fats_g),
      notes: mealData.notes || null
    })
    .select()
    .single();

  if (error) {
    return { success: false, errors: { _form: `Failed to save meal: ${error.message}` } };
  }

  return { success: true, data };
}

// --- UI Rendering ---

/**
 * Renders the meal logging form into the given container element.
 * Handles inline validation errors and preserves form data on failure.
 */
export function renderMealForm(container) {
  const today = localDateKey();

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Log a Meal</h3>
      </div>
      <div class="card-body">
        <form id="meal-form" novalidate>
          <div class="input-group">
            <label class="input-label" for="meal-title">Title</label>
            <input
              type="text"
              id="meal-title"
              name="title"
              class="input"
              placeholder="e.g. Chicken & rice bowl"
              maxlength="100"
              required
              aria-describedby="meal-title-error"
            />
            <span id="meal-title-error" class="input-error-msg" aria-live="polite"></span>
          </div>

          <div class="input-group">
            <label class="input-label" for="meal-type">Meal Type</label>
            <select id="meal-type" name="meal_type" class="input" required aria-describedby="meal-type-error">
              <option value="breakfast">Breakfast</option>
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
              <option value="snack">Snack</option>
            </select>
            <span id="meal-type-error" class="input-error-msg" aria-live="polite"></span>
          </div>

          <div class="input-group">
            <label class="input-label" for="meal-date">Date</label>
            <input
              type="date"
              id="meal-date"
              name="meal_date"
              class="input"
              value="${today}"
              required
              aria-describedby="meal-date-error"
            />
            <span id="meal-date-error" class="input-error-msg" aria-live="polite"></span>
          </div>

          <div class="input-group">
            <label class="input-label" for="meal-calories">Calories (kcal)</label>
            <input
              type="number"
              id="meal-calories"
              name="calories"
              class="input input-num"
              placeholder="0"
              min="0"
              max="10000"
              value="0"
              required
              aria-describedby="meal-calories-error"
            />
            <span id="meal-calories-error" class="input-error-msg" aria-live="polite"></span>
          </div>

          <div class="input-group">
            <label class="input-label" for="meal-protein">Protein (g)</label>
            <input
              type="number"
              id="meal-protein"
              name="protein_g"
              class="input input-num"
              placeholder="0"
              min="0"
              max="10000"
              step="0.1"
              value="0"
              required
              aria-describedby="meal-protein-error"
            />
            <span id="meal-protein-error" class="input-error-msg" aria-live="polite"></span>
          </div>

          <div class="input-group">
            <label class="input-label" for="meal-carbs">Carbs (g)</label>
            <input
              type="number"
              id="meal-carbs"
              name="carbs_g"
              class="input input-num"
              placeholder="0"
              min="0"
              max="10000"
              step="0.1"
              value="0"
              required
              aria-describedby="meal-carbs-error"
            />
            <span id="meal-carbs-error" class="input-error-msg" aria-live="polite"></span>
          </div>

          <div class="input-group">
            <label class="input-label" for="meal-fats">Fats (g)</label>
            <input
              type="number"
              id="meal-fats"
              name="fats_g"
              class="input input-num"
              placeholder="0"
              min="0"
              max="10000"
              step="0.1"
              value="0"
              required
              aria-describedby="meal-fats-error"
            />
            <span id="meal-fats-error" class="input-error-msg" aria-live="polite"></span>
          </div>

          <div class="input-group">
            <label class="input-label" for="meal-notes">Notes (optional)</label>
            <input
              type="text"
              id="meal-notes"
              name="notes"
              class="input"
              placeholder="Any additional notes"
            />
          </div>

          <div class="card-footer">
            <button type="submit" class="btn btn-primary" id="meal-submit-btn">Log Meal</button>
            <span id="meal-form-error" class="input-error-msg" aria-live="polite"></span>
          </div>
        </form>
      </div>
    </div>
  `;

  // Attach form submit handler
  const form = container.querySelector('#meal-form');
  form.addEventListener('submit', handleMealSubmit);
}

/**
 * Handles the meal form submission.
 * Validates, submits, shows inline errors or success.
 */
async function handleMealSubmit(event) {
  event.preventDefault();

  const form = event.target;
  const submitBtn = form.querySelector('#meal-submit-btn');

  // Collect form data (preserves all values in the form)
  const mealData = {
    title: form.querySelector('#meal-title').value,
    meal_type: form.querySelector('#meal-type').value,
    meal_date: form.querySelector('#meal-date').value,
    calories: form.querySelector('#meal-calories').value,
    protein_g: form.querySelector('#meal-protein').value,
    carbs_g: form.querySelector('#meal-carbs').value,
    fats_g: form.querySelector('#meal-fats').value,
    notes: form.querySelector('#meal-notes').value
  };

  // Clear previous errors
  clearFormErrors(form);

  // Disable submit while processing
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  // Attempt to log the meal
  const result = await logMeal(mealData);

  submitBtn.disabled = false;
  submitBtn.textContent = 'Log Meal';

  if (!result.success) {
    // Show inline errors adjacent to failing fields
    displayFormErrors(form, result.errors);
    return;
  }

  // Success — show brief confirmation and reset form
  showSuccessToast('Meal logged successfully');
  form.reset();

  // Restore today's date as default
  const today = localDateKey();
  form.querySelector('#meal-date').value = today;
}

/**
 * Clears all inline error messages and error styling from the form.
 */
function clearFormErrors(form) {
  // Clear error messages
  const errorMsgs = form.querySelectorAll('.input-error-msg');
  errorMsgs.forEach(el => { el.textContent = ''; });

  // Remove error styling from inputs
  const errorInputs = form.querySelectorAll('.input-error');
  errorInputs.forEach(el => { el.classList.remove('input-error'); });
}

/**
 * Displays inline error messages adjacent to each failing field.
 * Form data is preserved (not cleared) so the user can correct only invalid fields.
 */
function displayFormErrors(form, errors) {
  const fieldToErrorId = {
    title: 'meal-title-error',
    meal_type: 'meal-type-error',
    calories: 'meal-calories-error',
    protein_g: 'meal-protein-error',
    carbs_g: 'meal-carbs-error',
    fats_g: 'meal-fats-error',
    _form: 'meal-form-error'
  };

  const fieldToInputId = {
    title: 'meal-title',
    meal_type: 'meal-type',
    calories: 'meal-calories',
    protein_g: 'meal-protein',
    carbs_g: 'meal-carbs',
    fats_g: 'meal-fats'
  };

  for (const [field, message] of Object.entries(errors)) {
    // Set error message text
    const errorId = fieldToErrorId[field];
    if (errorId) {
      const errorEl = form.querySelector(`#${errorId}`);
      if (errorEl) {
        errorEl.textContent = message;
      }
    }

    // Add error styling to the input
    const inputId = fieldToInputId[field];
    if (inputId) {
      const inputEl = form.querySelector(`#${inputId}`);
      if (inputEl) {
        inputEl.classList.add('input-error');
      }
    }
  }
}

/**
 * Shows a brief success toast notification.
 */
function showSuccessToast(message) {
  // Find or create toast container
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = 'toast toast-success';
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 20 20">
      <polyline points="4 10 8 14 16 6"/>
    </svg>
    <span class="toast-message">${message}</span>
    <button class="toast-dismiss" aria-label="Dismiss">
      <svg class="icon icon-sm" viewBox="0 0 20 20">
        <line x1="5" y1="5" x2="15" y2="15"/>
        <line x1="15" y1="5" x2="5" y2="15"/>
      </svg>
    </button>
  `;

  // Dismiss on click
  toast.querySelector('.toast-dismiss').addEventListener('click', () => {
    toast.classList.add('hidden');
    setTimeout(() => toast.remove(), 200);
  });

  toastContainer.appendChild(toast);

  // Auto-dismiss after 3 seconds
  setTimeout(() => {
    toast.classList.add('hidden');
    setTimeout(() => toast.remove(), 200);
  }, 3000);
}

// --- Daily Macro Aggregation ---

/**
 * Pure function: aggregates macro totals from an array of meal objects.
 * Returns { calories, protein, carbs, fats, mealCount } with zeros if empty.
 *
 * Preconditions:
 *   - meals is an array of objects with numeric calories, protein_g, carbs_g, fats_g (all >= 0)
 * Postconditions:
 *   - Each returned field equals the sum of corresponding meal fields
 *   - mealCount equals meals.length
 *   - If meals is empty, all values are 0
 */
export function aggregateDailyMacros(meals) {
  if (!meals || meals.length === 0) {
    return { calories: 0, protein: 0, carbs: 0, fats: 0, mealCount: 0 };
  }

  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fats = 0;

  for (const meal of meals) {
    calories += Number(meal.calories) || 0;
    protein += Number(meal.protein_g) || 0;
    carbs += Number(meal.carbs_g) || 0;
    fats += Number(meal.fats_g) || 0;
  }

  return { calories, protein, carbs, fats, mealCount: meals.length };
}

/**
 * Fetches all meals for a user on a given date and returns aggregated macro totals.
 * Returns { calories, protein, carbs, fats, mealCount } with zeros if no meals exist.
 *
 * Requirements: 7.5, 7.6
 */
export async function getDailyMacros(userId, date) {
  const dateStr = date instanceof Date
    ? localDateKey(date)
    : date;

  const { data, error } = await supabase
    .from('meals')
    .select('calories, protein_g, carbs_g, fats_g')
    .eq('user_id', userId)
    .eq('meal_date', dateStr);

  if (error) {
    console.error('Failed to fetch daily macros:', error.message);
    return { calories: 0, protein: 0, carbs: 0, fats: 0, mealCount: 0 };
  }

  return aggregateDailyMacros(data || []);
}

/**
 * Renders daily macro summary into the given container element.
 * Uses IBM Plex Mono with tabular-nums via the .num class for numeric alignment.
 *
 * Requirements: 13.5 (IBM Plex Mono, tabular-nums for numeric displays)
 */
export function renderDailyMacros(container, macros) {
  const { calories, protein, carbs, fats, mealCount } = macros;

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Daily Macros</h3>
        <span class="num">${mealCount} meal${mealCount !== 1 ? 's' : ''}</span>
      </div>
      <div class="card-body">
        <div class="macro-grid">
          <div class="macro-item">
            <span class="macro-label">Calories</span>
            <span class="num macro-value">${calories} kcal</span>
          </div>
          <div class="macro-item">
            <span class="macro-label">Protein</span>
            <span class="num macro-value">${protein.toFixed(1)} g</span>
          </div>
          <div class="macro-item">
            <span class="macro-label">Carbs</span>
            <span class="num macro-value">${carbs.toFixed(1)} g</span>
          </div>
          <div class="macro-item">
            <span class="macro-label">Fats</span>
            <span class="num macro-value">${fats.toFixed(1)} g</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// --- View Activation ---

/**
 * Activates the food module view. Called when user navigates to the Food tab.
 * Renders the meal form into the food view container.
 */
export function activate() {
  const container = document.getElementById('food-view');
  if (!container) return;

  container.innerHTML = `
    <div class="dashboard-stack" id="diary-mount">
      <p class="view-placeholder-text">Loading diary…</p>
    </div>
    <details class="disclosure" id="weighin-disclosure">
      <summary>
        <span>Weigh in</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="weighin-mount"></div>
    </details>
    <details class="disclosure" id="nutrition-settings-disclosure">
      <summary>
        <span>Your targets</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="nutrition-settings-mount"></div>
    </details>
    <section>
      <div class="section-heading">
        <h3>Suggest a recipe</h3>
        <span class="section-meta">Both diets applied</span>
      </div>
      <div id="recipe-generator-section"></div>
    </section>
    <section>
      <div class="section-heading"><h3>Recipe book</h3></div>
      <div id="recipe-book-section"></div>
    </section>
    <details class="disclosure" id="meal-form-disclosure">
      <summary>
        <span>Log a meal</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="meal-form-section"></div>
    </details>
    <details class="disclosure" id="pantry-disclosure">
      <summary>
        <span>Pantry</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="pantry-section"></div>
    </details>
    <details class="disclosure" id="preferences-disclosure">
      <summary>
        <span>Dietary preferences</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="preferences-section"></div>
    </details>
  `;

  // The diary replaces the old hero and macro strip: same figures, but driven
  // by per-item entries against a food database rather than typed-in totals,
  // which is what §3.3's measured TDEE needs.
  renderDiary(container.querySelector('#diary-mount'));
  renderWeighInForm(container.querySelector('#weighin-mount'));
  renderNutritionSettings(container.querySelector('#nutrition-settings-mount'));

  renderMealForm(container.querySelector('#meal-form-section'));
  renderRecipeGenerator(container.querySelector('#recipe-generator-section'));
  initRecipeBook(container.querySelector('#recipe-book-section'));
  initPantry(container.querySelector('#pantry-section'));
  initDietaryPreferences(container.querySelector('#preferences-section'));
}

/**
 * Fetches today's meals and renders the hero calorie figure plus the
 * macro breakdown. Both read from the same aggregate.
 * @param {HTMLElement} container - The #food-view container
 */
export async function loadFoodDashboard(container) {
  const user = getCurrentUser();
  if (!user) return;

  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const todayStr = `${y}-${m}-${d}`;

  const macros = await getDailyMacros(user.id, todayStr);

  const heroSection = container.querySelector('#food-hero-section');
  if (heroSection) {
    heroSection.innerHTML = `
      <div class="hero">
        <span class="hero-label">Calories today</span>
        <div class="hero-value">
          <span class="hero-num">${formatNumber(macros.calories)}</span>
          <span class="hero-unit">kcal</span>
        </div>
        <div class="hero-sub">
          <span><span class="num">${macros.mealCount}</span> meal${macros.mealCount === 1 ? '' : 's'} logged</span>
          <span class="divider">·</span>
          <span><span class="num">${macros.protein.toFixed(0)}</span>g protein</span>
        </div>
      </div>
    `;
  }

  const macroSection = container.querySelector('#daily-macros-section');
  if (macroSection) {
    renderDailyMacros(macroSection, macros);
  }
}

// --- Listen for view changes ---

window.addEventListener('viewchange', (event) => {
  if (event.detail.view === 'food') {
    activate();
  }
});

initFoodDiary();

// ============================================================
// AI RECIPE SUGGESTION UI
// Surfaces the recipe generator: constraints in, generated
// recipe out, with the option to save it to the shared book.
// ============================================================

/**
 * Renders the recipe generation controls and result area.
 * @param {HTMLElement} container
 */
export function renderRecipeGenerator(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="card" id="recipe-generator-card">
      <div class="card-body">
        <div class="recipe-filters flex gap-3">
          <div class="input-group">
            <label class="input-label" for="gen-meal-type">Meal type</label>
            <select id="gen-meal-type" class="input">
              <option value="">Any</option>
              <option value="breakfast">Breakfast</option>
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
              <option value="snack">Snack</option>
            </select>
          </div>
          <div class="input-group">
            <label class="input-label" for="gen-max-prep">Max prep (min)</label>
            <input type="number" id="gen-max-prep" class="input input-num" min="5" max="240" step="5" placeholder="30" />
          </div>
          <div class="input-group">
            <label class="input-label" for="gen-servings">Servings</label>
            <input type="number" id="gen-servings" class="input input-num" min="1" max="12" step="1" value="2" />
          </div>
        </div>
        <div class="card-footer">
          <button type="button" class="btn btn-primary" id="generate-recipe-btn">Suggest recipe</button>
        </div>
        <div id="generate-recipe-error" class="input-error-msg" role="alert" aria-live="polite"></div>
        <div id="generated-recipe-result" aria-live="polite"></div>
      </div>
    </div>
  `;

  container.querySelector('#generate-recipe-btn')
    .addEventListener('click', () => handleGenerateRecipe(container));
}

/**
 * Runs generation with the form's constraints and renders the result.
 * @param {HTMLElement} container
 */
async function handleGenerateRecipe(container) {
  const btn = container.querySelector('#generate-recipe-btn');
  const errorEl = container.querySelector('#generate-recipe-error');
  const resultEl = container.querySelector('#generated-recipe-result');

  errorEl.textContent = '';
  resultEl.innerHTML = '';
  btn.disabled = true;
  btn.textContent = 'Thinking…';

  const constraints = {};
  const mealType = container.querySelector('#gen-meal-type').value;
  const maxPrep = container.querySelector('#gen-max-prep').value;
  const servings = container.querySelector('#gen-servings').value;
  if (mealType) constraints.mealType = mealType;
  if (maxPrep) constraints.maxPrepTime = Number(maxPrep);
  if (servings) constraints.servings = Number(servings);

  const result = await generateRecipe(constraints);

  btn.disabled = false;
  btn.textContent = 'Suggest recipe';

  if (!result.success) {
    errorEl.textContent = result.error;
    return;
  }

  renderGeneratedRecipe(resultEl, result.recipe, mealType, result.warning);
}

/**
 * Renders a generated recipe with a save action.
 * @param {HTMLElement} mount
 * @param {object} recipe
 * @param {string} mealType
 */
export function renderGeneratedRecipe(mount, recipe, mealType = '', warning = null) {
  const ingredients = Array.isArray(recipe.ingredients_resolved)
    ? recipe.ingredients_resolved
    : (Array.isArray(recipe.ingredients) ? recipe.ingredients : []);
  const steps = Array.isArray(recipe.method)
    ? recipe.method
    : (Array.isArray(recipe.steps) ? recipe.steps : []);

  // Per serving, summed from real per-100g lookups. Nothing here came from the
  // model — it supplied ingredients and grams, and that is all.
  const per = recipe.macros_per_serving || {};
  const prepMinutes = (recipe.prep_minutes ?? recipe.prep_time_min ?? 0)
    + (recipe.cook_minutes ?? 0);

  mount.innerHTML = `
    <div class="card recipe-card mt-3" id="generated-recipe-card">
      <div class="card-header">
        <h3 class="card-title">${escapeHtml(recipe.title || 'Suggested recipe')}</h3>
        <span class="num">${formatNumber(Math.round(per.kcal || 0))} kcal</span>
      </div>
      <div class="card-body">
        ${recipe.description ? `<p>${escapeHtml(recipe.description)}</p>` : ''}

        ${warning ? `<div class="notice notice--warning"><p>${escapeHtml(warning)}</p></div>` : ''}

        <div class="stat-tiles mt-3">
          <div class="stat-tile stat-tile--shared">
            <span class="stat-tile-label">Protein</span>
            <span class="stat-tile-value">${formatNumber(Math.round(per.protein || 0))}<small>g</small></span>
          </div>
          <div class="stat-tile stat-tile--shared">
            <span class="stat-tile-label">Carbs</span>
            <span class="stat-tile-value">${formatNumber(Math.round(per.carbs || 0))}<small>g</small></span>
          </div>
          <div class="stat-tile stat-tile--shared">
            <span class="stat-tile-label">Fats</span>
            <span class="stat-tile-value">${formatNumber(Math.round(per.fat || 0))}<small>g</small></span>
          </div>
          <div class="stat-tile stat-tile--shared">
            <span class="stat-tile-label">Time</span>
            <span class="stat-tile-value">${formatNumber(prepMinutes)}<small>min</small></span>
          </div>
        </div>

        <p class="field-hint">
          Per serving, computed from
          ${recipe.coverage_pct !== undefined ? `<span class="num">${recipe.coverage_pct}%</span> of the ingredients matched to` : ''}
          USDA and Open Food Facts data — not estimated by the model.
          ${recipe.fit_score !== null && recipe.fit_score !== undefined
            ? `Fit against what you have left: <span class="num">${recipe.fit_score}</span>/100.`
            : ''}
        </p>

        ${Array.isArray(recipe.unresolved) && recipe.unresolved.length ? `
          <p class="field-hint">
            Not found in any database, so excluded from the totals:
            ${recipe.unresolved.map(escapeHtml).join(', ')}.
          </p>` : ''}
        <div class="section-heading mt-3">
          <h3>Your plates</h3>
          <span class="section-meta">Cook once</span>
        </div>
        <div id="portion-split-mount"></div>

        <div class="section-heading mt-3"><h3>Ingredients</h3></div>
        <ul class="event-list">
          ${ingredients.map(i => `
            <li class="event-item">
              <span class="event-title">
                ${escapeHtml(i.item || i.name || String(i))}
                ${i.note ? `<span class="event-time">${escapeHtml(i.note)}</span>` : ''}
                ${i.resolved === false
                  ? '<span class="event-time">not in any database</span>'
                  : (i.matched_name
                      ? `<span class="event-time">matched: ${escapeHtml(i.matched_name)}</span>`
                      : '')}
              </span>
              <span class="event-time num">
                ${i.grams !== undefined ? `${Math.round(i.grams)} g` : escapeHtml(i.quantity || '')}
              </span>
            </li>
          `).join('')}
        </ul>
        <div class="section-heading mt-3"><h3>Method</h3></div>
        <ol class="free-window-list">
          ${steps.map((s, idx) => `
            <li class="free-window">
              <span class="free-window-duration">${idx + 1}</span>
              <span class="free-window-day">${escapeHtml(s)}</span>
            </li>
          `).join('')}
        </ol>
      </div>
      <div class="card-footer">
        <button type="button" class="btn btn-secondary" id="save-generated-recipe-btn">Save to recipe book</button>
        <span id="save-generated-recipe-msg" class="input-error-msg" role="status" aria-live="polite"></span>
      </div>
    </div>
  `;

  // §2.5 — one batch, two different plates, driven by what each of you has left.
  renderPortionSplit(mount.querySelector('#portion-split-mount'), recipe);

  mount.querySelector('#save-generated-recipe-btn').addEventListener('click', async (event) => {
    const saveBtn = event.target;
    const msgEl = mount.querySelector('#save-generated-recipe-msg');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';

    const saved = await saveRecipe({ ...recipe, meal_type: mealType || null, ai_generated: true });

    saveBtn.disabled = false;
    saveBtn.textContent = 'Save to recipe book';

    if (!saved.success) {
      msgEl.textContent = saved.error;
      return;
    }

    msgEl.textContent = 'Saved';
    const bookMount = document.getElementById('recipe-book-section');
    if (bookMount) initRecipeBook(bookMount);
  });
}
