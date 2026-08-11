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
import { createBarcodeScanner, isCameraAvailable } from './barcode-scanner.js';

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

/**
 * Turns one Open Food Facts product into a row shaped like our `foods` table.
 *
 * Shared by barcode lookup and text search so the two cannot drift apart — the
 * per-100 g figures are taken from their fields verbatim, never interpreted,
 * per §0.2. Returns null for anything with no energy figure: a product that
 * logs as zero calories is worse than no result at all, because it silently
 * flatters the day's total.
 */
function offProductToDraft(product, code) {
  const n = product?.nutriments || {};
  const per100g = {
    kcal: Number(n['energy-kcal_100g']) || 0,
    protein: Number(n.proteins_100g) || 0,
    carbs: Number(n.carbohydrates_100g) || 0,
    fat: Number(n.fat_100g) || 0,
    fibre: Number(n.fiber_100g) || 0,
    sugar: Number(n.sugars_100g) || 0,
    salt: Number(n.salt_100g) || 0,
  };
  if (per100g.kcal <= 0) return null;

  return {
    source: 'off',
    source_id: code,
    barcode: code,
    name: (product.product_name || 'Unnamed product').slice(0, 200),
    brand: (product.brands || '').split(',')[0]?.trim() || null,
    per_100g: per100g,
    serving_grams: Number(product.serving_quantity) || null,
    verified: false,
  };
}

/**
 * Free-text search against Open Food Facts.
 *
 * Results come back with `id: null` — they are not rows in our table yet. The
 * caller saves the one the user actually picks, so browsing does not fill the
 * shared food database with everything either of us ever typed.
 */
export async function searchOpenFoodFacts(query, { pageSize = 20 } = {}) {
  const term = String(query || '').trim();
  if (term.length < 3) return { success: true, foods: [] };

  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(term)}`
    + '&search_simple=1&action=process&json=1'
    + `&page_size=${pageSize}`
    + '&fields=code,product_name,brands,nutriments,serving_quantity';

  try {
    const response = await fetch(url);
    if (!response.ok) return { success: false, error: 'Could not reach the food database.' };

    const body = await response.json();
    const seen = new Set();
    const foods = [];

    for (const product of body.products || []) {
      const draft = offProductToDraft(product, String(product.code || ''));
      if (!draft || !draft.name || draft.name === 'Unnamed product') continue;

      // Supermarkets list the same item under several barcodes. Collapse on
      // name plus brand so the list is not four rows of the same yoghurt.
      const key = `${draft.name.toLowerCase()}|${(draft.brand || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      foods.push({ ...draft, id: null });
    }

    return { success: true, foods };
  } catch {
    return { success: false, error: 'Could not reach the food database.' };
  }
}

/**
 * Search the shared food table, falling back to Open Food Facts.
 *
 * The local table is authoritative and ranked personally. Remote results are
 * appended rather than merged into the ranking: they carry no log history, so
 * scoring them against foods you actually eat would be comparing a real
 * frequency against a zero and always burying the local hit.
 */
export async function searchFoods(query, historyEntries = [], { remote = true } = {}) {
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
  const local = rankFoods(term, enriched).slice(0, 12);

  // Until the table is seeded it is empty, so without this the search box
  // returns nothing for every term anyone will ever type.
  if (!remote || local.length >= 8) return { success: true, foods: local, remoteUsed: false };

  const off = await searchOpenFoodFacts(term);
  if (!off.success) {
    // A local hit plus no network still beats an error page.
    return { success: true, foods: local, remoteUsed: false, remoteError: off.error };
  }

  const localBarcodes = new Set(local.map(f => f.barcode).filter(Boolean));
  const localNames = new Set(local.map(f => (f.name || '').toLowerCase()));
  const extra = off.foods.filter(f =>
    !localBarcodes.has(f.barcode) && !localNames.has(f.name.toLowerCase())
  );

  return {
    success: true,
    foods: [...local, ...extra].slice(0, 20),
    remoteUsed: extra.length > 0,
  };
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

    // A product with no energy figure is useless here and would log as zero.
    const draft = offProductToDraft(body.product, code);
    if (!draft) {
      return { success: false, error: 'That product has no nutrition data. Add it by hand.' };
    }

    return { success: true, draft };
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
 * Validation for a hand-entered food (§0.4 — floors and caps, not optional).
 *
 * The caps are physical rather than stylistic. Nothing edible is more than
 * 100 g of protein per 100 g, and pure fat is about 900 kcal per 100 g, so a
 * figure above either is a typo — most often a per-serving number typed into a
 * per-100 g box, which would then under-count every portion logged against it.
 */
export function validateCustomFood(input = {}) {
  const errors = {};

  const name = String(input.name || '').trim();
  if (name.length < 2 || name.length > 200) {
    errors.name = 'Give it a name between 2 and 200 characters.';
  }

  const kcal = Number(input.kcal);
  if (!Number.isFinite(kcal) || kcal < 0 || kcal > 900) {
    errors.kcal = 'Calories per 100 g must be between 0 and 900.';
  }

  for (const key of ['protein', 'carbs', 'fat']) {
    const value = Number(input[key] ?? 0);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      errors[key] = 'Grams per 100 g must be between 0 and 100.';
    }
  }

  // Macros that cannot physically fit in 100 g of anything.
  const bulk = (Number(input.protein) || 0) + (Number(input.carbs) || 0) + (Number(input.fat) || 0);
  if (!errors.protein && !errors.carbs && !errors.fat && bulk > 100) {
    errors._form = `Protein, carbs and fat come to ${Math.round(bulk)} g per 100 g. Check the label.`;
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Saves a food the user typed in themselves.
 *
 * These figures come off a packet the user is holding, which is a lookup —
 * §0.2 forbids macros generated from model prose, not macros read off a label.
 * Stored unverified so it is clear the numbers were not machine-checked.
 */
export async function createCustomFood(input, userId) {
  const { valid, errors } = validateCustomFood(input);
  if (!valid) return { success: false, errors };

  const draft = {
    source: 'custom',
    name: String(input.name).trim(),
    brand: String(input.brand || '').trim() || null,
    per_100g: {
      kcal: Number(input.kcal),
      protein: Number(input.protein) || 0,
      carbs: Number(input.carbs) || 0,
      fat: Number(input.fat) || 0,
      fibre: Number(input.fibre) || 0,
      sugar: Number(input.sugar) || 0,
      salt: Number(input.salt) || 0,
    },
    serving_grams: Number(input.servingGrams) > 0 ? Number(input.servingGrams) : null,
    verified: false,
  };

  const result = await saveFood(draft, userId);
  if (!result.success) return { success: false, errors: { _form: result.error } };
  return { success: true, food: result.food };
}

/**
 * Whether this browser can scan a barcode from the camera.
 *
 * This used to test for BarcodeDetector, which Safari does not ship — so the
 * scan button never rendered on an iPhone at all. The detector is now
 * polyfilled (see barcode-scanner.js), so the question is no longer "does this
 * browser have the API" but "is there a camera we are allowed to ask for".
 */
export function canScanBarcode() {
  return isCameraAvailable();
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

// Held at module scope so a re-render can release the camera. The diary
// repaints on every food:refresh, which destroys the <video> element — but a
// destroyed element does not stop its MediaStream, so without this the camera
// light stays on after logging a scanned item.
let activeScanner = null;

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

  // About to replace the markup this scanner's <video> lives in.
  activeScanner?.stop();
  activeScanner = null;

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

  // Without a complete profile there is no honest target to show — but that is
  // no reason to stop someone logging food. This used to `return` here, which
  // took the meal sections, the add-food form and the barcode scanner with it,
  // so a partner who had not filled in their height could not record a single
  // meal. What you ate is a fact; the target is the only thing that needs the
  // profile.
  const hasTargets = Boolean(mine.targets);
  const remaining = hasTargets ? remainingMacros(mine.targets, mine.entries) : null;

  mount.innerHTML = `
    ${hasTargets
      ? `${renderRemainingCard(mine, remaining)}
         ${renderMacroBars(mine.targets, remaining)}
         ${theirs?.targets ? renderPartnerSplit(mine, theirs, partnerProfile, user) : ''}`
      : `${renderSetupPrompt(mine)}
         ${renderConsumedCard(mine.entries)}`}
    ${renderMealSections(mine.entries)}
    ${renderAddForm()}
    ${mine.plateau.plateaued ? `<div class="notice notice--warning"><p>${escapeHtml(mine.plateau.reason)}</p></div>` : ''}
    ${mine.flaggedWeighIn ? `<div class="notice"><p>Your last weigh-in jumped more than 2.5 kg from the trend. Worth checking it was the same scale at the same time of day.</p></div>` : ''}
  `;

  wireAddForm(mount, user.id, mine);
  wireEntryDeletion(mount, user.id);

  // The prompt named what was missing but gave no way to supply it. The
  // settings live in a collapsed disclosure further down the same view, which
  // is easy to miss on a phone.
  mount.querySelector('#open-nutrition-settings')?.addEventListener('click', () => {
    const disclosure = document.querySelector('#nutrition-settings-disclosure');
    if (!disclosure) return;
    disclosure.open = true;
    disclosure.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  });
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
        <p class="field-hint">
          You can log food in the meantime; only the targets are waiting.
        </p>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="open-nutrition-settings">
            Fill these in
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Today's totals with no target to compare against.
 *
 * Shown in place of the remaining-macros card when the profile is incomplete.
 * Consumed is a fact that needs no profile; "remaining" would need a target,
 * and inventing one is what §0.4 exists to prevent.
 */
function renderConsumedCard(entries) {
  const total = sumMacros(entries || []);

  return `
    <div class="card">
      <div class="card-header"><h3 class="card-title">Eaten today</h3></div>
      <div class="card-body">
        <div class="macro-grid">
          <div class="macro-item">
            <span class="macro-label">Calories</span>
            <span class="macro-value num">${Math.round(total.kcal)}</span>
          </div>
          <div class="macro-item">
            <span class="macro-label">Protein</span>
            <span class="macro-value num">${Math.round(total.protein)} g</span>
          </div>
          <div class="macro-item">
            <span class="macro-label">Carbs</span>
            <span class="macro-value num">${Math.round(total.carbs)} g</span>
          </div>
          <div class="macro-item">
            <span class="macro-label">Fat</span>
            <span class="macro-value num">${Math.round(total.fat)} g</span>
          </div>
        </div>
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
            ? `<button type="button" class="btn btn-primary" id="barcode-scan">Scan</button>`
            : ''}
        </div>
        <div class="barcode-viewport" id="barcode-viewport">
          <video id="barcode-video" class="barcode-video" playsinline muted hidden></video>
          <div class="barcode-reticle" aria-hidden="true"></div>
        </div>
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

        ${renderCustomFoodForm()}
      </div>
    </div>
  `;
}

/**
 * Hand entry, for the food that is not in any database — a market vegetable, a
 * recipe from a friend, anything from a bakery counter. Collapsed, because it
 * is the last resort rather than the first move.
 */
function renderCustomFoodForm() {
  return `
    <details class="disclosure mt-4" id="custom-food-disclosure">
      <summary><span>Add a food by hand</span>${chevronSvg()}</summary>
      <div class="disclosure-body">
        <p class="field-hint">
          Figures per 100 g, straight off the packet. Anything you add here is
          shared, so the next time either of you searches for it, it is there.
        </p>

        <div class="input-group mt-4">
          <label class="input-label" for="custom-name">Name</label>
          <input type="text" id="custom-name" class="input" placeholder="Sourdough loaf" maxlength="200" />
        </div>

        <div class="input-group mt-4">
          <label class="input-label" for="custom-brand">Brand (optional)</label>
          <input type="text" id="custom-brand" class="input" placeholder="Local bakery" />
        </div>

        <div class="field-row mt-4">
          <div class="input-group">
            <label class="input-label" for="custom-kcal">kcal / 100 g</label>
            <input type="number" id="custom-kcal" class="input num" min="0" max="900" step="1" inputmode="numeric" />
          </div>
          <div class="input-group">
            <label class="input-label" for="custom-protein">Protein (g)</label>
            <input type="number" id="custom-protein" class="input num" min="0" max="100" step="0.1" inputmode="decimal" />
          </div>
        </div>

        <div class="field-row mt-4">
          <div class="input-group">
            <label class="input-label" for="custom-carbs">Carbs (g)</label>
            <input type="number" id="custom-carbs" class="input num" min="0" max="100" step="0.1" inputmode="decimal" />
          </div>
          <div class="input-group">
            <label class="input-label" for="custom-fat">Fat (g)</label>
            <input type="number" id="custom-fat" class="input num" min="0" max="100" step="0.1" inputmode="decimal" />
          </div>
        </div>

        <div class="input-group mt-4">
          <label class="input-label" for="custom-serving">Typical serving (g, optional)</label>
          <input type="number" id="custom-serving" class="input num" min="1" max="5000" step="1" inputmode="numeric" />
        </div>

        <span id="custom-error" class="input-error-msg" aria-live="polite"></span>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary" id="custom-save">Save food</button>
          <span class="form-status" id="custom-status" aria-live="polite"></span>
        </div>
      </div>
    </details>
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

  // The rendered results, held here rather than serialised into a DOM
  // attribute and parsed back out on click.
  let currentResults = [];
  // Monotonic, so a slow request cannot overwrite the results of a faster one
  // issued after it. Open Food Facts takes about a second, local Postgres takes
  // tens of milliseconds, so deleting a character used to be able to repaint
  // the list with the results of the longer query you had already moved past.
  let searchToken = 0;
  let timer = null;

  const choose = (food) => {
    selectedFood = food;
    chosen.hidden = false;
    grams.value = food.serving_grams || 100;
    results.innerHTML = '';
    search.value = food.name;
    updatePreview();
    grams.focus();
  };

  const runSearch = async () => {
    const token = ++searchToken;
    const term = search.value.trim();

    if (term.length < 2) { results.innerHTML = ''; return; }

    results.innerHTML = `<p class="meal-empty">Searching…</p>`;
    const result = await searchFoods(term, context.history);
    if (token !== searchToken) return; // A newer keystroke owns the list now.

    if (!result.success) {
      results.innerHTML = `<p class="meal-empty">${escapeHtml(result.error || 'Search failed.')}</p>`;
      return;
    }

    currentResults = result.foods;

    if (currentResults.length === 0) {
      results.innerHTML = `
        <p class="meal-empty">
          Nothing found for “${escapeHtml(term)}”.
          <button type="button" class="link-btn" id="open-custom-food">Add it by hand</button>.
        </p>
      `;
      results.querySelector('#open-custom-food')?.addEventListener('click', () => {
        const disclosure = mount.querySelector('#custom-food-disclosure');
        if (!disclosure) return;
        disclosure.open = true;
        const name = mount.querySelector('#custom-name');
        if (name) { name.value = term; name.focus(); }
        disclosure.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      });
      return;
    }

    results.innerHTML = currentResults.map((food, index) => `
      <button type="button" class="food-result" data-index="${index}">
        <span class="food-result-name">${escapeHtml(food.name)}</span>
        <span class="food-result-detail">
          ${food.brand ? escapeHtml(food.brand) + ' · ' : ''}
          <span class="num">${Math.round(Number(food.per_100g?.kcal) || 0)}</span> kcal/100 g
          ${food.verified ? '· verified' : ''}
          ${food.id ? '' : '· not saved yet'}
        </span>
      </button>
    `).join('');

    results.querySelectorAll('[data-index]').forEach((button) => {
      button.addEventListener('click', () => {
        choose(currentResults[Number(button.dataset.index)]);
      });
    });
  };

  // Debounced so typing does not fire a query per keystroke.
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 250);
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

  const addButton = mount.querySelector('#food-add');
  addButton.addEventListener('click', async () => {
    const error = mount.querySelector('#food-error');
    const status = mount.querySelector('#food-status');
    error.textContent = '';

    if (!selectedFood) {
      error.textContent = 'Pick a food first.';
      return;
    }

    addButton.disabled = true;
    try {
      // A result straight from Open Food Facts is not a row in our table yet,
      // so it has no id for the entry's foreign key. Save it on the way past —
      // which also means the next search for it resolves locally and offline.
      if (!selectedFood.id) {
        status.textContent = 'Saving food…';
        const { id, score, logCount, lastLoggedAt, ...draft } = selectedFood;
        const saved = await saveFood(draft, userId);
        if (!saved.success) {
          status.textContent = '';
          error.textContent = saved.error;
          return;
        }
        selectedFood = saved.food;
      }

      const payload = {
        food: selectedFood,
        grams: grams.value,
        meal: mount.querySelector('#food-meal').value,
        dateKey: currentDateKey,
      };

      const { valid, errors } = validateEntry(payload);
      if (!valid) {
        status.textContent = '';
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
    } finally {
      addButton.disabled = false;
    }
  });

  wireCustomFoodForm(mount, userId, (food) => {
    choose(food);
    const disclosure = mount.querySelector('#custom-food-disclosure');
    if (disclosure) disclosure.open = false;
  });
}

/**
 * Hand entry. On save the food is selected straight away, because the reason
 * anyone opens this form is to log the thing they just typed in.
 */
function wireCustomFoodForm(mount, userId, onCreated) {
  const saveButton = mount.querySelector('#custom-save');
  if (!saveButton) return;

  const field = (id) => mount.querySelector(`#custom-${id}`);

  saveButton.addEventListener('click', async () => {
    const error = mount.querySelector('#custom-error');
    const status = mount.querySelector('#custom-status');
    error.textContent = '';
    status.textContent = '';

    const input = {
      name: field('name').value,
      brand: field('brand').value,
      kcal: field('kcal').value,
      protein: field('protein').value,
      carbs: field('carbs').value,
      fat: field('fat').value,
      servingGrams: field('serving').value,
    };

    const { valid, errors } = validateCustomFood(input);
    if (!valid) {
      error.textContent = errors._form || Object.values(errors)[0];
      return;
    }

    saveButton.disabled = true;
    status.textContent = 'Saving…';
    try {
      const result = await createCustomFood(input, userId);
      if (!result.success) {
        status.textContent = '';
        error.textContent = result.errors?._form || Object.values(result.errors || {})[0];
        return;
      }

      status.textContent = 'Saved';
      for (const id of ['name', 'brand', 'kcal', 'protein', 'carbs', 'fat', 'serving']) {
        field(id).value = '';
      }
      onCreated(result.food);
    } finally {
      saveButton.disabled = false;
    }
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
  const scanButton = mount.querySelector('#barcode-scan');
  if (!input) return;

  const stopCamera = () => {
    activeScanner?.stop();
    activeScanner = null;
    if (scanButton) scanButton.textContent = 'Scan';
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

  scanButton?.addEventListener('click', async () => {
    if (activeScanner?.isRunning()) {
      stopCamera();
      status.textContent = '';
      return;
    }

    scanButton.disabled = true;
    // The polyfill fetches a WebAssembly decoder on first use, which on a
    // phone connection is a visible pause. Saying so beats a dead button.
    status.textContent = 'Starting camera…';

    activeScanner = createBarcodeScanner({
      video,
      onStatus: (message) => { status.textContent = message; },
      onResult: (code) => {
        input.value = code;
        if (scanButton) scanButton.textContent = 'Scan';
        resolve(code);
      },
    });

    const started = await activeScanner.start();
    scanButton.disabled = false;
    if (started) {
      scanButton.textContent = 'Stop';
    } else {
      activeScanner = null;
    }
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
