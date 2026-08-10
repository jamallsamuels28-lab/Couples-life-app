// ============================================================
// Food diary — data access and view (kiro-algorithm-spec.md §3)
// ============================================================
//
// Structure borrowed from MyFitnessPal, because it is the shape people already
// know: a remaining-calorie figure at the top, macro bars against target, then
// meals as sections you add into with a running subtotal each.
//
// The look is not borrowed. Same greyscale chassis and two identity hues as
// the rest of the app.
//
// The maths lives in nutrition-engine.js.
// ============================================================

import { supabase, withAuthGuard } from './supabase-client.js';
import { getCurrentUser, getPartner } from './app-shell.js';
import { escapeHtml, chevronSvg, formatNumber, localDateKey, displayName } from './ui-helpers.js';
import {
  bmr,
  predictedTDEE,
  measuredTDEE,
  blendedTDEE,
  setTargets,
  currentSmoothedWeight,
  smoothWeight,
  macrosForGrams,
  sumMacros,
  remainingMacros,
  projectDay,
  rankFoods,
  plateauCheck,
} from './nutrition-engine.js';
import { stepKcal, trainingKcal, MET } from './fitness-engine.js';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS = {
  breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks',
};

// ------------------------------------------------------------
// Data access
// ------------------------------------------------------------

export async function fetchEntries(userId, dateKey) {
  if (!userId) return { success: true, entries: [] };
  const { data, error } = await supabase
    .from('food_entries').select('*, foods(name, brand, source, verified)')
    .eq('user_id', userId).eq('entry_date', dateKey)
    .order('logged_at', { ascending: true });
  if (error) return { success: false, error: 'Could not load the diary.' };
  return { success: true, entries: data || [] };
}

export async function fetchEntryHistory(userId, days = 28) {
  if (!userId) return { success: true, entries: [] };
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await supabase
    .from('food_entries').select('*')
    .eq('user_id', userId).gte('entry_date', localDateKey(since))
    .order('logged_at', { ascending: false });
  if (error) return { success: false, error: 'Could not load history.' };
  return { success: true, entries: data || [] };
}

export async function fetchWeighIns(userId, days = 60) {
  if (!userId) return { success: true, weighIns: [] };
  const since = new Date();
  since.setDate(since.getDate() - days);
  const { data, error } = await supabase
    .from('weigh_ins').select('*')
    .eq('user_id', userId).gte('date', localDateKey(since))
    .order('date', { ascending: true });
  if (error) return { success: false, error: 'Could not load weigh-ins.' };
  return { success: true, weighIns: data || [] };
}

export async function fetchNutritionProfile(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('nutrition_profile').select('*').eq('user_id', userId).maybeSingle();
  return data || null;
}

export async function searchFoods(query, historyEntries = []) {
  const term = String(query || '').trim();
  if (term.length < 2) return { success: true, foods: [] };

  const { data, error } = await supabase
    .from('foods').select('*')
    .ilike('name', `%${term}%`)
    .limit(40);

  if (error) return { success: false, error: 'Search failed.' };

  // Personal frequency and recency come from this user's own log, not from a
  // global popularity figure — the point is to surface what they actually eat.
  const stats = new Map();
  for (const entry of historyEntries) {
    if (!entry.food_id) continue;
    const existing = stats.get(entry.food_id) || { logCount: 0, lastLoggedAt: null };
    existing.logCount++;
    if (!existing.lastLoggedAt || entry.logged_at > existing.lastLoggedAt) {
      existing.lastLoggedAt = entry.logged_at;
    }
    stats.set(entry.food_id, existing);
  }

  const enriched = (data || []).map(food => ({ ...food, ...(stats.get(food.id) || {}) }));
  return { success: true, foods: rankFoods(term, enriched).slice(0, 12) };
}

/** Barcode lookup bypasses ranking entirely — exact match or nothing (§3.6). */
export async function findByBarcode(barcode) {
  const code = String(barcode).trim();
  if (!/^\d{6,14}$/.test(code)) return { success: false, error: 'That is not a barcode.' };

  const { data, error } = await supabase
    .from('foods').select('*').eq('barcode', code).maybeSingle();
  if (error) return { success: false, error: 'Lookup failed.' };
  return { success: true, food: data || null };
}

/**
 * Falls back to Open Food Facts when a barcode is not in our own table.
 *
 * Their per-100 g figures are used directly rather than asking a model to
 * interpret the label — §0.2 is explicit that any macro figure reaching the
 * database must come from a lookup, never from generated prose. The row is
 * stored unverified so it is clear where it came from.
 */
export async function lookupOpenFoodFacts(barcode) {
  const code = String(barcode).trim();
  if (!/^\d{6,14}$/.test(code)) return { success: false, error: 'That is not a barcode.' };

  try {
    const response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${code}?fields=product_name,brands,nutriments,serving_quantity`
    );
    if (!response.ok) return { success: false, error: 'Not found in the food database.' };

    const body = await response.json();
    if (body.status !== 1 || !body.product) {
      return { success: false, error: 'Not found in the food database.' };
    }

    const n = body.product.nutriments || {};
    const per100g = {
      kcal: Number(n['energy-kcal_100g']) || 0,
      protein: Number(n.proteins_100g) || 0,
      carbs: Number(n.carbohydrates_100g) || 0,
      fat: Number(n.fat_100g) || 0,
      fibre: Number(n.fiber_100g) || 0,
      sugar: Number(n.sugars_100g) || 0,
      salt: Number(n.salt_100g) || 0,
    };

    // A product with no energy figure is useless here and would log as zero.
    if (per100g.kcal <= 0) {
      return { success: false, error: 'That product has no nutrition data. Add it by hand.' };
    }

    return {
      success: true,
      draft: {
        source: 'off',
        source_id: code,
        barcode: code,
        name: (body.product.product_name || 'Unnamed product').slice(0, 200),
        brand: (body.product.brands || '').split(',')[0]?.trim() || null,
        per_100g: per100g,
        serving_grams: Number(body.product.serving_quantity) || null,
        verified: false,
      },
    };
  } catch {
    return { success: false, error: 'Could not reach the food database.' };
  }
}

/** Saves a looked-up product so the next scan is instant. */
export async function saveFood(draft, userId) {
  return withAuthGuard(async () => {
    const { data, error } = await supabase
      .from('foods').insert({ ...draft, created_by: userId }).select().single();
    if (error) return { success: false, error: 'Could not save the food.' };
    return { success: true, food: data };
  });
}

/**
 * Whether this browser can scan a barcode from the camera.
 * Safari on iOS does not ship BarcodeDetector, so manual entry is not a
 * fallback for the unlucky — it is the main path for half the phones involved.
 */
export function canScanBarcode() {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

export function validateEntry({ food, grams, meal }) {
  const errors = {};
  if (!food?.id) errors.food = 'Pick a food first.';
  const amount = Number(grams);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) {
    errors.grams = 'Enter an amount between 1 and 5000 g.';
  }
  if (!MEALS.includes(meal)) errors.meal = 'Pick a meal.';
  return { valid: Object.keys(errors).length === 0, errors };
}

export async function logEntry({ food, grams, meal, dateKey }, userId) {
  const { valid, errors } = validateEntry({ food, grams, meal });
  if (!valid) return { success: false, errors };

  return withAuthGuard(async () => {
    const row = {
      id: crypto.randomUUID(),
      user_id: userId,
      food_id: food.id,
      entry_date: dateKey || localDateKey(),
      logged_at: new Date().toISOString(),
      meal,
      grams: Number(grams),
      // Snapshotted, so correcting a food later cannot rewrite history (§3.1).
      macros: macrosForGrams(food.per_100g, grams),
    };
    const { data, error } = await supabase.from('food_entries').insert(row).select().single();
    if (error) return { success: false, errors: { _form: 'Could not save the entry.' } };
    return { success: true, entry: data };
  });
}

export async function deleteEntry(entryId, userId) {
  return withAuthGuard(async () => {
    const { error } = await supabase
      .from('food_entries').delete().eq('id', entryId).eq('user_id', userId);
    if (error) return { success: false, error: 'Could not remove the entry.' };
    return { success: true };
  });
}

export async function logWeighIn(weightKg, userId, dateKey) {
  const value = Number(weightKg);
  if (!Number.isFinite(value) || value <= 20 || value >= 400) {
    return { success: false, error: 'Enter a weight between 20 and 400 kg.' };
  }
  return withAuthGuard(async () => {
    const { error } = await supabase.from('weigh_ins').upsert({
      user_id: userId, date: dateKey || localDateKey(), weight_kg: value,
    }, { onConflict: 'user_id,date' });
    if (error) return { success: false, error: 'Could not save the weigh-in.' };
    return { success: true };
  });
}

// ------------------------------------------------------------
// Assembling the day
// ------------------------------------------------------------

/**
 * Everything the diary needs for one person on one day: targets derived from
 * measured expenditure where the data supports it, predicted where it does not.
 *
 * @param {string} userId
 * @param {string} dateKey
 * @returns {Promise<Object>}
 */
export async function loadNutritionContext(userId, dateKey = localDateKey()) {
  const [entryResult, historyResult, weighInResult, profile] = await Promise.all([
    fetchEntries(userId, dateKey),
    fetchEntryHistory(userId),
    fetchWeighIns(userId),
    fetchNutritionProfile(userId),
  ]);

  const entries = entryResult.success ? entryResult.entries : [];
  const history = historyResult.success ? historyResult.entries : [];
  const weighIns = weighInResult.success ? weighInResult.weighIns : [];

  const weightKg = currentSmoothedWeight(weighIns);
  const age = profile?.birth_date
    ? Math.floor((Date.now() - new Date(profile.birth_date)) / (365.25 * 86400000))
    : null;

  const bmrValue = bmr({
    weightKg, heightCm: profile?.height_cm, age, sex: profile?.sex,
  });

  // Daily intake series, needed for the measured figure.
  const byDate = new Map();
  for (const entry of history) {
    const key = entry.entry_date;
    byDate.set(key, (byDate.get(key) || 0) + (Number(entry.macros?.kcal) || 0));
  }
  const dailyIntake = [...byDate.entries()].map(([date, kcal]) => ({ date, kcal }));

  const measured = measuredTDEE({ dailyIntake, weighIns });
  // Activity is folded into the predicted figure only; the measured one already
  // contains it by construction, and adding it twice would inflate the target.
  const predicted = predictedTDEE({
    bmrValue,
    stepCalories: weightKg ? stepKcal({ steps: 0, weightKg }) : 0,
    trainingCalories: 0,
  });

  const tdee = blendedTDEE({ predicted, measured, loggedDays: measured.loggedDays });

  const targets = tdee.value && weightKg
    ? setTargets({
        tdee: tdee.value,
        weightKg,
        goalRateKgPerWeek: profile?.goal_rate_kg_per_week ?? -0.5,
        sex: profile?.sex || 'male',
        bmrValue,
        goalWeightKg: profile?.goal_weight_kg,
      })
    : null;

  return {
    entries,
    history,
    weighIns,
    profile,
    weightKg,
    bmrValue,
    tdee,
    targets,
    dailyIntake,
    plateau: plateauCheck({ weighIns, loggedDays: dailyIntake.length }),
    projection: projectDay({ todayEntries: entries, historyEntries: history }),
    flaggedWeighIn: smoothWeight(weighIns).slice(-1)[0]?.flagged || false,
  };
}

// ------------------------------------------------------------
// View
// ------------------------------------------------------------

let selectedFood = null;
let currentDateKey = localDateKey();

export function activateFoodDiary(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="dashboard-stack" id="diary-mount">
      <p class="view-placeholder-text">Loading diary…</p>
    </div>
    <details class="disclosure" id="weighin-disclosure">
      <summary><span>Weigh in</span>${chevronSvg()}</summary>
      <div class="disclosure-body" id="weighin-mount"></div>
    </details>
  `;

  renderDiary(container.querySelector('#diary-mount'));
  renderWeighInForm(container.querySelector('#weighin-mount'));
}

export async function renderDiary(mount) {
  if (!mount) return;
  const user = getCurrentUser();
  const partnerProfile = getPartner();
  if (!user) {
    mount.innerHTML = `<div class="empty-state">Sign in to see your diary.</div>`;
    return;
  }

  const [mine, theirs] = await Promise.all([
    loadNutritionContext(user.id, currentDateKey),
    partnerProfile ? loadNutritionContext(partnerProfile.id, currentDateKey) : null,
  ]);

  if (!mine.targets) {
    mount.innerHTML = renderSetupPrompt(mine);
    return;
  }

  const remaining = remainingMacros(mine.targets, mine.entries);

  mount.innerHTML = `
    ${renderRemainingCard(mine, remaining)}
    ${renderMacroBars(mine.targets, remaining)}
    ${theirs?.targets ? renderPartnerSplit(mine, theirs, partnerProfile, user) : ''}
    ${renderMealSections(mine.entries)}
    ${renderAddForm()}
    ${mine.plateau.plateaued ? `<div class="notice notice--warning"><p>${escapeHtml(mine.plateau.reason)}</p></div>` : ''}
    ${mine.flaggedWeighIn ? `<div class="notice"><p>Your last weigh-in jumped more than 2.5 kg from the trend. Worth checking it was the same scale at the same time of day.</p></div>` : ''}
  `;

  wireAddForm(mount, user.id, mine);
  wireEntryDeletion(mount, user.id);
}

function renderSetupPrompt(context) {
  const missing = [];
  if (!context.weightKg) missing.push('a weigh-in');
  if (!context.profile?.height_cm) missing.push('your height');
  if (!context.profile?.sex) missing.push('sex');
  if (!context.profile?.birth_date) missing.push('date of birth');

  return `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Set up your targets</h3></div>
      <div class="card-body">
        <p class="field-hint">
          Targets need ${escapeHtml(missing.join(', '))} before they mean anything.
          A guessed calorie target is worse than none — every macro below it
          inherits the error.
        </p>
      </div>
    </div>
  `;
}

/**
 * The headline number. A ring rather than a bar, because remaining calories is
 * the one figure people check twenty times a day and a ring reads at a glance.
 */
function renderRemainingCard(context, remaining) {
  const target = context.targets.targetKcal;
  const consumed = remaining.consumed.kcal;
  const pct = Math.min(Math.max(consumed / target, 0), 1);
  const circumference = 2 * Math.PI * 52;
  const over = remaining.kcal < 0;

  return `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Today</h3>
        <span class="section-meta num">${escapeHtml(currentDateKey)}</span>
      </div>
      <div class="card-body diary-hero">
        <svg class="kcal-ring" viewBox="0 0 120 120" role="img"
          aria-label="${Math.round(consumed)} of ${target} kcal used">
          <circle cx="60" cy="60" r="52" fill="none" stroke="var(--surface-2)" stroke-width="8"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="${over ? 'var(--ink)' : 'var(--id-a)'}"
            stroke-width="8" stroke-linecap="round"
            stroke-dasharray="${(circumference * pct).toFixed(1)} ${circumference.toFixed(1)}"
            transform="rotate(-90 60 60)"/>
        </svg>
        <div class="kcal-figures">
          <span class="kcal-remaining num">${formatNumber(Math.abs(remaining.kcal))}</span>
          <span class="kcal-label">kcal ${over ? 'over' : 'left'}</span>
          <span class="kcal-detail">
            <span class="num">${formatNumber(Math.round(consumed))}</span> of
            <span class="num">${formatNumber(target)}</span>
          </span>
        </div>
      </div>
      <div class="card-body diary-projection">
        <span>
          On your usual pattern you will finish around
          <span class="num">${formatNumber(context.projection.projectedTotal)}</span> kcal
        </span>
        <span class="field-hint">
          ${context.projection.basis > 0
            ? `Based on ${context.projection.basis} recent day${context.projection.basis === 1 ? '' : 's'}.`
            : 'No pattern yet — this sharpens up after a fortnight of logging.'}
          Expenditure is ${escapeHtml(context.tdee.source)}${context.tdee.reason ? ` — ${escapeHtml(context.tdee.reason)}` : ''}.
        </span>
      </div>
    </div>
  `;
}

function renderMacroBars(targets, remaining) {
  const rows = [
    { key: 'protein', label: 'Protein', target: targets.proteinG, left: remaining.protein },
    { key: 'carbs', label: 'Carbs', target: targets.carbsG, left: remaining.carbs },
    { key: 'fat', label: 'Fat', target: targets.fatG, left: remaining.fat },
  ];

  return `
    <div class="card mt-4">
      <div class="card-header"><h3 class="card-title">Macros</h3></div>
      <div class="card-body">
        ${rows.map(row => {
          const used = row.target - row.left;
          const pct = row.target > 0 ? Math.min(Math.max(used / row.target, 0), 1) * 100 : 0;
          return `
            <div class="macro-row">
              <span class="macro-label">${row.label}</span>
              <span class="macro-bar"><i style="width:${pct.toFixed(1)}%"></i></span>
              <span class="macro-figures num">${Math.round(used)} / ${row.target} g</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderPartnerSplit(mine, theirs, partnerProfile, user) {
  const mineLeft = remainingMacros(mine.targets, mine.entries).kcal;
  const theirsLeft = remainingMacros(theirs.targets, theirs.entries).kcal;

  return `
    <div class="card mt-4">
      <div class="card-header">
        <h3 class="card-title">Between you</h3>
      </div>
      <div class="card-body split-row">
        <div class="split-side split-side--a">
          <span class="split-name">${escapeHtml(displayName(user, 'You'))}</span>
          <span class="split-value num">${formatNumber(mineLeft)}</span>
          <span class="split-label">kcal left</span>
        </div>
        <div class="split-side split-side--b">
          <span class="split-name">${escapeHtml(displayName(partnerProfile, 'Partner'))}</span>
          <span class="split-value num">${formatNumber(theirsLeft)}</span>
          <span class="split-label">kcal left</span>
        </div>
      </div>
      <div class="card-body">
        <p class="field-hint">
          Cook one meal and split it unevenly rather than making two — the
          recipe suggester works out the plate weights from these figures.
        </p>
      </div>
    </div>
  `;
}

function renderMealSections(entries) {
  return `
    <div class="card mt-4">
      <div class="card-header"><h3 class="card-title">Diary</h3></div>
      <div class="card-body">
        ${MEALS.map(meal => {
          const mealEntries = entries.filter(e => e.meal === meal);
          const subtotal = sumMacros(mealEntries);
          return `
            <section class="meal-section">
              <div class="meal-head">
                <span class="meal-name">${MEAL_LABELS[meal]}</span>
                <span class="meal-total num">${formatNumber(Math.round(subtotal.kcal))} kcal</span>
              </div>
              ${mealEntries.length === 0
                ? `<p class="meal-empty">Nothing logged</p>`
                : mealEntries.map(entry => `
                    <div class="meal-entry">
                      <div class="meal-entry-main">
                        <span class="meal-entry-name">${escapeHtml(entry.foods?.name || 'Food')}</span>
                        <span class="meal-entry-detail">
                          <span class="num">${Math.round(entry.grams)}</span> g
                          ${entry.foods?.brand ? `· ${escapeHtml(entry.foods.brand)}` : ''}
                          ${entry.foods?.source ? `· ${escapeHtml(entry.foods.source)}` : ''}
                          ${entry.foods?.verified ? '· verified' : ''}
                        </span>
                      </div>
                      <span class="meal-entry-kcal num">${Math.round(Number(entry.macros?.kcal) || 0)}</span>
                      <button type="button" class="meal-entry-remove" data-remove="${escapeHtml(entry.id)}"
                        aria-label="Remove ${escapeHtml(entry.foods?.name || 'entry')}">×</button>
                    </div>
                  `).join('')}
            </section>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderAddForm() {
  return `
    <div class="card mt-4">
      <div class="card-header"><h3 class="card-title">Add food</h3></div>
      <div class="card-body">
        <div class="input-group">
          <label class="input-label" for="food-search">Search</label>
          <input type="search" id="food-search" class="input" placeholder="Chicken breast" autocomplete="off" />
        </div>

        <div class="barcode-row">
          <input type="text" id="barcode-input" class="input num" inputmode="numeric"
            placeholder="Or type a barcode" aria-label="Barcode" />
          <button type="button" class="btn btn-secondary" id="barcode-lookup">Look up</button>
          ${canScanBarcode()
            ? `<button type="button" class="btn btn-secondary" id="barcode-scan">Scan</button>`
            : ''}
        </div>
        <video id="barcode-video" class="barcode-video" playsinline muted hidden></video>
        <span id="barcode-status" class="form-status" aria-live="polite"></span>

        <div id="food-results" class="food-results" aria-live="polite"></div>

        <div id="food-chosen" class="food-chosen" hidden>
          <div class="field-row">
            <div class="input-group">
              <label class="input-label" for="food-grams">Amount (g)</label>
              <input type="number" id="food-grams" class="input num" min="1" max="5000" step="1" inputmode="numeric" />
            </div>
            <div class="input-group">
              <label class="input-label" for="food-meal">Meal</label>
              <select id="food-meal" class="input">
                ${MEALS.map(m => `<option value="${m}">${MEAL_LABELS[m]}</option>`).join('')}
              </select>
            </div>
          </div>
          <div id="food-preview" class="set-estimate" aria-live="polite"></div>
          <span id="food-error" class="input-error-msg" aria-live="polite"></span>
          <div class="form-actions">
            <button type="button" class="btn btn-primary" id="food-add">Add to diary</button>
            <span class="form-status num" id="food-status" aria-live="polite"></span>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------
// Behaviour
// ------------------------------------------------------------

function wireAddForm(mount, userId, context) {
  const search = mount.querySelector('#food-search');
  const results = mount.querySelector('#food-results');
  const chosen = mount.querySelector('#food-chosen');
  const grams = mount.querySelector('#food-grams');
  const preview = mount.querySelector('#food-preview');
  if (!search) return;

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    // Debounced so typing does not fire a query per keystroke.
    timer = setTimeout(async () => {
      const result = await searchFoods(search.value, context.history);
      if (!result.success) { results.innerHTML = ''; return; }
      if (result.foods.length === 0) {
        results.innerHTML = search.value.trim().length >= 2
          ? `<p class="meal-empty">Nothing found. Add it as a custom food.</p>` : '';
        return;
      }
      results.innerHTML = result.foods.map(food => `
        <button type="button" class="food-result" data-food='${escapeHtml(JSON.stringify(food))}'>
          <span class="food-result-name">${escapeHtml(food.name)}</span>
          <span class="food-result-detail">
            ${food.brand ? escapeHtml(food.brand) + ' · ' : ''}
            <span class="num">${Math.round(Number(food.per_100g?.kcal) || 0)}</span> kcal/100 g
            ${food.verified ? '· verified' : ''}
          </span>
        </button>
      `).join('');

      results.querySelectorAll('[data-food]').forEach((button) => {
        button.addEventListener('click', () => {
          selectedFood = JSON.parse(button.dataset.food);
          chosen.hidden = false;
          grams.value = selectedFood.serving_grams || 100;
          results.innerHTML = '';
          search.value = selectedFood.name;
          updatePreview();
          grams.focus();
        });
      });
    }, 250);
  });

  const updatePreview = () => {
    if (!selectedFood) { preview.textContent = ''; return; }
    const macros = macrosForGrams(selectedFood.per_100g, grams.value);
    if (!macros) { preview.textContent = ''; return; }
    preview.innerHTML = `
      <span class="num">${Math.round(macros.kcal)}</span> kcal ·
      P <span class="num">${macros.protein}</span> ·
      C <span class="num">${macros.carbs}</span> ·
      F <span class="num">${macros.fat}</span>
    `;
  };
  grams.addEventListener('input', updatePreview);

  wireBarcode(mount, userId, (food) => {
    selectedFood = food;
    chosen.hidden = false;
    grams.value = food.serving_grams || 100;
    search.value = food.name;
    results.innerHTML = '';
    updatePreview();
  });

  mount.querySelector('#food-add').addEventListener('click', async () => {
    const error = mount.querySelector('#food-error');
    const status = mount.querySelector('#food-status');
    error.textContent = '';

    const payload = {
      food: selectedFood,
      grams: grams.value,
      meal: mount.querySelector('#food-meal').value,
      dateKey: currentDateKey,
    };

    const { valid, errors } = validateEntry(payload);
    if (!valid) {
      error.textContent = Object.values(errors)[0];
      return;
    }

    status.textContent = 'Saving…';
    const result = await logEntry(payload, userId);
    if (!result.success) {
      status.textContent = '';
      error.textContent = result.errors?._form || Object.values(result.errors || {})[0];
      return;
    }

    selectedFood = null;
    window.dispatchEvent(new CustomEvent('food:refresh'));
  });
}

/**
 * Barcode entry, by camera where the browser supports it and by keypad
 * everywhere else. Our own table first, then Open Food Facts, then a plain
 * "add it by hand" — never a guessed macro.
 */
function wireBarcode(mount, userId, onFound) {
  const input = mount.querySelector('#barcode-input');
  const status = mount.querySelector('#barcode-status');
  const video = mount.querySelector('#barcode-video');
  if (!input) return;

  let stream = null;
  let scanning = false;

  const stopCamera = () => {
    scanning = false;
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.hidden = true;
  };

  const resolve = async (code) => {
    status.textContent = 'Looking up…';

    const local = await findByBarcode(code);
    if (local.success && local.food) {
      status.textContent = '';
      onFound(local.food);
      return;
    }

    const remote = await lookupOpenFoodFacts(code);
    if (!remote.success) {
      status.textContent = `${remote.error} Search for it by name instead.`;
      return;
    }

    // Cache it so the next scan of the same product is instant and offline.
    const saved = await saveFood(remote.draft, userId);
    status.textContent = saved.success ? '' : 'Found it, but could not save it for next time.';
    onFound(saved.success ? saved.food : { ...remote.draft, id: null });
  };

  mount.querySelector('#barcode-lookup')?.addEventListener('click', () => {
    stopCamera();
    const code = input.value.trim();
    if (!/^\d{6,14}$/.test(code)) {
      status.textContent = 'A barcode is 6 to 14 digits.';
      return;
    }
    resolve(code);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      mount.querySelector('#barcode-lookup').click();
    }
  });

  mount.querySelector('#barcode-scan')?.addEventListener('click', async () => {
    if (scanning) { stopCamera(); status.textContent = ''; return; }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
    } catch {
      status.textContent = 'No camera access. Type the number instead.';
      return;
    }

    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => undefined);

    const detector = new window.BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
    });
    scanning = true;
    status.textContent = 'Point at the barcode…';

    const tick = async () => {
      if (!scanning) return;
      try {
        const codes = await detector.detect(video);
        if (codes.length) {
          const value = codes[0].rawValue;
          input.value = value;
          stopCamera();
          resolve(value);
          return;
        }
      } catch {
        // A frame that fails to decode is normal; keep going.
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function wireEntryDeletion(mount, userId) {
  mount.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await deleteEntry(button.dataset.remove, userId);
      if (!result.success) { button.disabled = false; return; }
      window.dispatchEvent(new CustomEvent('food:refresh'));
    });
  });
}

export function renderWeighInForm(mount) {
  if (!mount) return;
  mount.innerHTML = `
    <div class="input-group">
      <label class="input-label" for="weighin-value">Weight (kg)</label>
      <input type="number" id="weighin-value" class="input num" step="0.1" min="20" max="400" inputmode="decimal" />
    </div>
    <p class="field-hint">
      Daily weight is mostly water, so the app tracks a smoothed line rather
      than the raw number. Same scale, same time of day, ideally first thing.
    </p>
    <span id="weighin-error" class="input-error-msg" aria-live="polite"></span>
    <div class="form-actions">
      <button type="button" class="btn btn-primary" id="weighin-save">Save</button>
      <span class="form-status num" id="weighin-status" aria-live="polite"></span>
    </div>
  `;

  mount.querySelector('#weighin-save').addEventListener('click', async () => {
    const user = getCurrentUser();
    const error = mount.querySelector('#weighin-error');
    const status = mount.querySelector('#weighin-status');
    error.textContent = '';
    status.textContent = 'Saving…';

    const result = await logWeighIn(mount.querySelector('#weighin-value').value, user?.id, currentDateKey);
    if (!result.success) {
      status.textContent = '';
      error.textContent = result.error;
      return;
    }
    status.textContent = 'Saved';
    window.dispatchEvent(new CustomEvent('food:refresh'));
  });
}

export function initFoodDiary() {
  window.addEventListener('food:refresh', () => {
    const container = document.getElementById('food-view');
    const mount = container?.querySelector('#diary-mount');
    if (mount) renderDiary(mount);
  });
}
