// ============================================================
// Couples portion split — kiro-algorithm-spec.md §2.5
// ============================================================
//
// You and Rebecca will rarely have the same macros left. Two recipes is what
// kills eating together, so this cooks one and splits it unevenly.
//
// Everything is shown in grams on the plate as well as servings, because
// "1.25 servings" is not a thing a kitchen scale can weigh.
// ============================================================

import { getCurrentUser, getPartner } from './app-shell.js';
import { escapeHtml, displayName, formatNumber } from './ui-helpers.js';
import { portionsFor, remainingMacros } from './nutrition-engine.js';
import { loadNutritionContext } from './food-diary.js';

/**
 * Renders the split for a recipe.
 *
 * @param {HTMLElement} container
 * @param {Object} recipe - needs macros per serving, optionally total cooked weight
 */
export async function renderPortionSplit(container, recipe) {
  if (!container) return;

  const perServing = normaliseServing(recipe);
  if (!perServing) {
    container.innerHTML = `<p class="field-hint">This recipe has no per-serving calorie figure, so it cannot be split.</p>`;
    return;
  }

  const user = getCurrentUser();
  const partnerProfile = getPartner();
  if (!user || !partnerProfile) {
    container.innerHTML = `<p class="field-hint">Both accounts are needed to split a recipe.</p>`;
    return;
  }

  container.innerHTML = `<p class="view-placeholder-text">Working out the split…</p>`;

  const [mine, theirs] = await Promise.all([
    loadNutritionContext(user.id),
    loadNutritionContext(partnerProfile.id),
  ]);

  if (!mine.targets || !theirs.targets) {
    container.innerHTML = `
      <p class="field-hint">
        Both of you need targets set before a split means anything — otherwise
        it is just halving. Set them under "Your targets".
      </p>
    `;
    return;
  }

  const remainingA = remainingMacros(mine.targets, mine.entries);
  const remainingB = remainingMacros(theirs.targets, theirs.entries);

  const split = portionsFor(
    perServing,
    { kcal: remainingA.kcal },
    { kcal: remainingB.kcal },
    Number(recipe.total_cooked_weight_g) || null
  );

  if (!split) {
    container.innerHTML = `<p class="field-hint">Could not work out a split for this recipe.</p>`;
    return;
  }

  const nameA = displayName(user, 'You');
  const nameB = displayName(partnerProfile, 'Partner');

  container.innerHTML = `
    <div class="split-summary">
      <span>
        Cook <span class="num">${split.batch}</span> serving${split.batch === 1 ? '' : 's'}
      </span>
      ${split.leftovers > 0
        ? `<span class="divider">·</span><span><span class="num">${split.leftovers}</span> left over</span>`
        : ''}
    </div>

    <div class="plate-grid">
      ${renderPlate(nameA, split.pA, split.plateGramsA, split.macrosA, remainingA.kcal, 'a')}
      ${renderPlate(nameB, split.pB, split.plateGramsB, split.macrosB, remainingB.kcal, 'b')}
    </div>

    ${split.plateGramsA === null ? `
      <p class="field-hint">
        Add a total cooked weight to the recipe and this will give you plate
        weights in grams instead of servings.
      </p>` : `
      <p class="field-hint">
        Weigh the whole batch after cooking, then serve to those weights.
        The scale does the arithmetic, not you.
      </p>`}

    ${split.pA === 2.5 || split.pB === 2.5 || split.pA === 0.5 || split.pB === 0.5 ? `
      <p class="field-hint">
        One portion hit the limit of a realistic plate, so the split is clamped
        rather than honest to the calorie gap. Worth picking a different recipe.
      </p>` : ''}
  `;
}

function renderPlate(name, portion, grams, macros, remainingKcal, side) {
  const share = grams !== null
    ? `<span class="plate-grams num">${formatNumber(grams)}<small> g</small></span>`
    : `<span class="plate-grams num">${portion}<small> serving${portion === 1 ? '' : 's'}</small></span>`;

  return `
    <div class="plate plate--${side}">
      <span class="plate-name">${escapeHtml(name)}</span>
      ${share}
      <span class="plate-portion num">${portion} serving${portion === 1 ? '' : 's'}</span>
      <div class="plate-macros">
        <span><span class="num">${Math.round(macros.kcal)}</span> kcal</span>
        <span>P <span class="num">${macros.protein ?? 0}</span></span>
        <span>C <span class="num">${macros.carbs ?? 0}</span></span>
        <span>F <span class="num">${macros.fat ?? 0}</span></span>
      </div>
      <span class="plate-after">
        Leaves <span class="num">${formatNumber(Math.round(remainingKcal - macros.kcal))}</span> kcal
      </span>
    </div>
  `;
}

/**
 * Recipes arrive in a couple of shapes depending on whether they came from the
 * generator or the book, so normalise before doing any maths on them.
 */
export function normaliseServing(recipe) {
  // The generator returns flat fields, the recipe book a nested macros object,
  // and the Edge Function a third shape again. Accept all of them rather than
  // making the caller care.
  const macros = recipe?.macros_per_serving || recipe?.macros || recipe?.per_serving || recipe;
  if (!macros) return null;

  const kcal = Number(macros.kcal ?? macros.calories);
  if (!Number.isFinite(kcal) || kcal <= 0) return null;

  return {
    kcal,
    protein: Number(macros.protein ?? macros.protein_g) || 0,
    carbs: Number(macros.carbs ?? macros.carbs_g) || 0,
    fat: Number(macros.fat ?? macros.fats_g ?? macros.fat_g) || 0,
  };
}
