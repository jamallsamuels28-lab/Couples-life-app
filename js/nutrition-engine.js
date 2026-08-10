// ============================================================
// Nutrition engine — pure algorithms
// kiro-algorithm-spec.md §2.5, §3.2 – §3.6
// ============================================================
//
// Same arrangement as the fitness engine: formulas here, no database and no
// DOM. These are the calculations §0.2 and §0.4 are about — nothing an LLM
// wrote in prose reaches a macro figure, and every bound is enforced rather
// than assumed.
// ============================================================

/** Kilocalories per kilogram of body mass change. */
export const KCAL_PER_KG = 7700;

/** EMA smoothing factor — roughly seven-day responsiveness (§3.2). */
export const WEIGHT_ALPHA = 0.25;

/** A jump larger than this from the smoothed line is probably not real. */
export const OUTLIER_KG = 2.5;

const MACRO_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fibre', 'sugar', 'salt'];

// ------------------------------------------------------------
// §3.2 Weight smoothing
// ------------------------------------------------------------

/**
 * Exponentially smoothed body weight.
 *
 * Raw daily weight is mostly water, so every downstream figure uses the
 * smoothed line. Missing days carry the smoothed value forward rather than
 * interpolating a raw reading that was never taken — inventing data here would
 * feed straight into TDEE.
 *
 * @param {Array<{date:string, weight_kg:number}>} weighIns - any order
 * @returns {Array<{date:string, raw:number, smoothed:number, flagged:boolean}>}
 */
export function smoothWeight(weighIns) {
  const rows = (weighIns || [])
    .filter(w => Number.isFinite(Number(w.weight_kg)))
    .map(w => ({ date: String(w.date).slice(0, 10), raw: Number(w.weight_kg) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const out = [];
  let smoothed = null;

  for (const row of rows) {
    let flagged = false;
    if (smoothed === null) {
      smoothed = row.raw;
    } else {
      // The outlier is still included — excluding it would let a genuine jump
      // disappear — but it is flagged so the user can be asked.
      flagged = Math.abs(row.raw - smoothed) > OUTLIER_KG;
      smoothed = WEIGHT_ALPHA * row.raw + (1 - WEIGHT_ALPHA) * smoothed;
    }
    out.push({
      date: row.date,
      raw: row.raw,
      smoothed: Math.round(smoothed * 100) / 100,
      flagged,
    });
  }
  return out;
}

/** The most recent smoothed weight, or null. */
export function currentSmoothedWeight(weighIns) {
  const series = smoothWeight(weighIns);
  return series.length ? series[series.length - 1].smoothed : null;
}

// ------------------------------------------------------------
// §3.3 TDEE
// ------------------------------------------------------------

/**
 * Mifflin-St Jeor basal metabolic rate.
 * @returns {number|null} kcal/day
 */
export function bmr({ weightKg, heightCm, age, sex }) {
  if (![weightKg, heightCm, age].every(v => Number.isFinite(Number(v)))) return null;
  if (weightKg <= 0 || heightCm <= 0 || age <= 0) return null;
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(base + (sex === 'female' ? -161 : 5));
}

/**
 * Cold-start TDEE.
 *
 * The 1.15 covers a sedentary baseline plus the thermic effect of food. Real
 * step and training calories are added on top instead of a lifestyle
 * multiplier, which removes the largest single source of error in the classic
 * formula — a guessed "moderately active" can be 600 kcal wrong.
 */
export function predictedTDEE({ bmrValue, stepCalories = 0, trainingCalories = 0 }) {
  if (!Number.isFinite(Number(bmrValue)) || bmrValue <= 0) return null;
  return Math.round(bmrValue * 1.15 + Number(stepCalories) + Number(trainingCalories));
}

/**
 * Measured TDEE from intake and the change in smoothed weight (§3.3).
 *
 * Sign convention: losing weight means true expenditure was higher than
 * intake, so a negative delta added to mean intake raises the figure.
 *
 * The quality gate is deliberate — a confidently wrong TDEE from sparse data
 * is worse than none, because every target downstream inherits the error.
 *
 * @param {Object} params
 * @param {Array<{date:string, kcal:number}>} params.dailyIntake - days with a log
 * @param {Array<Object>} params.weighIns
 * @param {number} [params.windowDays=28]
 * @returns {{ value:number|null, loggedDays:number, reason?:string }}
 */
export function measuredTDEE({ dailyIntake, weighIns, windowDays = 28 }) {
  const series = smoothWeight(weighIns);
  if (series.length < 2) {
    return { value: null, loggedDays: 0, reason: 'Not enough weigh-ins yet.' };
  }

  const end = series[series.length - 1];
  const windowStartDate = new Date(end.date);
  windowStartDate.setDate(windowStartDate.getDate() - windowDays);
  const windowStartKey = windowStartDate.toISOString().slice(0, 10);

  // The earliest weigh-in at or after the window start anchors the delta.
  const start = series.find(row => row.date >= windowStartKey) || series[0];
  const spanDays = Math.max(
    1,
    Math.round((new Date(end.date) - new Date(start.date)) / 86400000)
  );

  const logged = (dailyIntake || []).filter(
    d => d.date >= start.date && d.date <= end.date && Number.isFinite(Number(d.kcal)) && d.kcal > 0
  );

  if (spanDays < 14) {
    return {
      value: null,
      loggedDays: logged.length,
      reason: `Needs ${14 - spanDays} more days of weigh-ins.`,
    };
  }

  if (logged.length < 10) {
    return {
      value: null,
      loggedDays: logged.length,
      reason: `Keep logging — ${10 - logged.length} more days for an accurate figure.`,
    };
  }

  // §3.3 also asks for 70% coverage of the window before trusting the mean.
  if (logged.length / spanDays < 0.7) {
    return {
      value: null,
      loggedDays: logged.length,
      reason: `Only ${logged.length} of ${spanDays} days logged — needs about 70%.`,
    };
  }

  const meanIntake = logged.reduce((sum, d) => sum + Number(d.kcal), 0) / logged.length;
  const deltaSmoothed = end.smoothed - start.smoothed;

  // DEVIATION FROM THE SPEC, deliberately.
  //
  // §3.3 writes this as `meanIntake + (ΔS × 7700 / days)` and then says in
  // prose that losing weight should raise the figure. Those two disagree: with
  // ΔS negative, a `+` lowers it. The prose is right and the formula is not.
  //
  // Physically: losing a kilo over the window means roughly 7700 kcal came out
  // of storage, so expenditure exceeded intake by that much per day averaged
  // out. Hence minus ΔS. Following the written formula would understate
  // expenditure while dieting and then drive the target lower again — the
  // exact ratchet §3.4's plateau rule exists to prevent.
  return {
    value: Math.round(meanIntake - (deltaSmoothed * KCAL_PER_KG) / spanDays),
    loggedDays: logged.length,
  };
}

/**
 * Blends predicted and measured while the measured figure earns confidence.
 * @returns {{ value:number|null, lambda:number, source:string, reason?:string }}
 */
export function blendedTDEE({ predicted, measured, loggedDays = 0 }) {
  const lambda = Math.min((loggedDays || 0) / 28, 1);

  if (measured?.value === null || measured?.value === undefined) {
    return {
      value: predicted ?? null,
      lambda: 0,
      source: 'predicted',
      reason: measured?.reason,
    };
  }
  if (!Number.isFinite(Number(predicted))) {
    return { value: measured.value, lambda: 1, source: 'measured' };
  }

  return {
    value: Math.round(lambda * measured.value + (1 - lambda) * predicted),
    lambda: Math.round(lambda * 100) / 100,
    source: lambda >= 1 ? 'measured' : 'blended',
  };
}

// ------------------------------------------------------------
// §3.4 Targets
// ------------------------------------------------------------

/**
 * Daily calorie and macro targets, with the caps and floors applied in the
 * order the spec sets out — most restrictive wins.
 *
 * These bounds are not decoration. An unbounded deficit algorithm will happily
 * recommend something harmful after a couple of bad data days (§0.4), so the
 * floors hold regardless of what the goal rate asks for.
 *
 * @returns {{targetKcal:number, proteinG:number, fatG:number, carbsG:number, capped:string|null, notes:string[]}|null}
 */
export function setTargets({
  tdee, weightKg, goalRateKgPerWeek = -0.5, sex = 'male', bmrValue, goalWeightKg,
}) {
  if (![tdee, weightKg].every(v => Number.isFinite(Number(v))) || tdee <= 0 || weightKg <= 0) {
    return null;
  }

  const notes = [];

  // A gaining goal is a surplus; the caps below only govern deficits.
  const requested = (-goalRateKgPerWeek * KCAL_PER_KG) / 7;

  let deficit = requested;
  let capped = null;

  if (requested > 0) {
    const quarterCap = tdee * 0.25;
    const bodyweightCap = (weightKg * 0.01 * KCAL_PER_KG) / 7;

    if (quarterCap < deficit) { deficit = quarterCap; capped = 'quarter_tdee'; }
    if (bodyweightCap < deficit) { deficit = bodyweightCap; capped = 'bodyweight'; }

    if (capped === 'quarter_tdee') notes.push('Deficit capped at 25% of your expenditure.');
    if (capped === 'bodyweight') notes.push('Deficit capped at 1% of bodyweight per week.');
  }

  let target = tdee - deficit;

  // Floors, applied after the caps.
  const absoluteFloor = sex === 'female' ? 1200 : 1500;
  if (Number.isFinite(Number(bmrValue)) && target < bmrValue) {
    target = bmrValue;
    notes.push('Raised to your BMR — eating below it is not a sustainable deficit.');
  }
  if (target < absoluteFloor) {
    target = absoluteFloor;
    notes.push(`Raised to the ${absoluteFloor} kcal floor.`);
  }

  target = Math.round(target);

  // Protein is anchored to a reference weight, not current weight. At 116 kg,
  // 2.0 g/kg is 232 g — neither necessary nor achievable. Against a ~105 kg
  // reference it lands at a sane 210 g.
  const refWeight = Number.isFinite(Number(goalWeightKg))
    ? Math.min(weightKg, goalWeightKg * 1.1)
    : weightKg;

  const proteinG = Math.round(refWeight * 2.0);

  let fatG = Math.round(Math.max(refWeight * 0.8, (target * 0.20) / 9));
  let carbsG = Math.round((target - proteinG * 4 - fatG * 9) / 4);

  // Carbohydrate has a practical floor too; trade fat down towards its
  // essential-intake minimum rather than leaving an unworkable split.
  const fatFloor = Math.round(refWeight * 0.8);
  while (carbsG < 50 && fatG > fatFloor) {
    fatG -= 1;
    carbsG = Math.round((target - proteinG * 4 - fatG * 9) / 4);
  }

  if (carbsG < 50) {
    notes.push('Carbohydrate is low against this target — consider a smaller deficit.');
  }

  return {
    targetKcal: target,
    proteinG,
    fatG,
    carbsG: Math.max(carbsG, 0),
    capped,
    notes,
  };
}

/**
 * Whether a plateau warrants recomputing from measured data (§3.4).
 *
 * Deliberately does not subtract a flat 200 kcal — that is how people ratchet
 * down to an intake they cannot hold. Recalculating from measured expenditure
 * is self-correcting instead.
 */
export function plateauCheck({ weighIns, loggedDays, windowDays = 21 }) {
  const series = smoothWeight(weighIns);
  if (series.length < 2) return { plateaued: false, reason: 'Not enough weigh-ins.' };

  const end = series[series.length - 1];
  const cutoff = new Date(end.date);
  cutoff.setDate(cutoff.getDate() - windowDays);
  const start = series.find(row => row.date >= cutoff.toISOString().slice(0, 10)) || series[0];

  const change = Math.abs(end.smoothed - start.smoothed);
  const compliance = (loggedDays || 0) / windowDays;

  if (compliance <= 0.8) {
    return { plateaued: false, reason: 'Logging is too patchy to call this a plateau.' };
  }
  if (change >= end.smoothed * 0.003) {
    return { plateaued: false, reason: 'Weight is still moving.' };
  }

  return {
    plateaued: true,
    reason: 'Three weeks without movement on good logging. Recompute expenditure from measured data rather than cutting calories again.',
  };
}

// ------------------------------------------------------------
// §3.5 Remaining and projection
// ------------------------------------------------------------

/** Macros for a quantity of a food, from its per-100 g figures. */
export function macrosForGrams(per100g, grams) {
  const scale = Number(grams) / 100;
  if (!Number.isFinite(scale) || scale < 0) return null;
  const out = {};
  for (const key of MACRO_KEYS) {
    const value = Number(per100g?.[key]);
    out[key] = Number.isFinite(value) ? Math.round(value * scale * 10) / 10 : 0;
  }
  return out;
}

export function sumMacros(entries) {
  const total = Object.fromEntries(MACRO_KEYS.map(k => [k, 0]));
  for (const entry of entries || []) {
    const macros = entry.macros || entry;
    for (const key of MACRO_KEYS) {
      const value = Number(macros?.[key]);
      if (Number.isFinite(value)) total[key] += value;
    }
  }
  for (const key of MACRO_KEYS) total[key] = Math.round(total[key] * 10) / 10;
  return total;
}

/**
 * What is left of the day's targets.
 * Remaining is allowed to go negative — hiding an overshoot would be dishonest.
 */
export function remainingMacros(targets, entries) {
  const consumed = sumMacros(entries);
  return {
    kcal: Math.round((targets?.targetKcal ?? 0) - consumed.kcal),
    protein: Math.round(((targets?.proteinG ?? 0) - consumed.protein) * 10) / 10,
    carbs: Math.round(((targets?.carbsG ?? 0) - consumed.carbs) * 10) / 10,
    fat: Math.round(((targets?.fatG ?? 0) - consumed.fat) * 10) / 10,
    consumed,
  };
}

/**
 * End-of-day projection (§3.5).
 *
 * The remainder is the mean of what this person usually eats *after this hour*,
 * taken from the last fortnight. That is what makes a recipe suggestion useful
 * at 15:00 rather than only once the day is already over.
 *
 * @param {Object} params
 * @param {Array<Object>} params.todayEntries
 * @param {Array<Object>} params.historyEntries - last 14 days, with logged_at
 * @param {Date} [params.now]
 * @returns {{ consumed:number, expectedRemainder:number, projectedTotal:number, basis:number }}
 */
export function projectDay({ todayEntries, historyEntries, now = new Date() }) {
  const consumed = sumMacros(todayEntries).kcal;
  const hour = now.getHours();

  const byDay = new Map();
  for (const entry of historyEntries || []) {
    const at = new Date(entry.logged_at);
    if (isNaN(at.getTime())) continue;
    if (at.getHours() < hour) continue; // only the part of the day still ahead
    const key = entry.entry_date || at.toDateString();
    const kcal = Number(entry.macros?.kcal) || 0;
    byDay.set(key, (byDay.get(key) || 0) + kcal);
  }

  const days = [...byDay.values()];
  const expectedRemainder = days.length
    ? Math.round(days.reduce((a, b) => a + b, 0) / days.length)
    : 0;

  return {
    consumed: Math.round(consumed),
    expectedRemainder,
    projectedTotal: Math.round(consumed + expectedRemainder),
    basis: days.length,
  };
}

// ------------------------------------------------------------
// §3.6 Food search ranking
// ------------------------------------------------------------

/** Cheap trigram similarity, enough for client-side reranking. */
export function trigramSimilarity(a, b) {
  const grams = (s) => {
    const padded = `  ${String(s).toLowerCase().trim()} `;
    const set = new Set();
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const g of left) if (right.has(g)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Ranks food search results (§3.6). A barcode scan never reaches this — it is
 * an exact match or a new entry.
 *
 * @param {string} query
 * @param {Array<Object>} foods - each may carry logCount and lastLoggedAt
 * @param {Date} [now]
 */
export function rankFoods(query, foods, now = new Date()) {
  const maxLogs = Math.max(1, ...(foods || []).map(f => Number(f.logCount) || 0));

  return (foods || []).map((food) => {
    const similarity = trigramSimilarity(query, food.name || '');
    const frequency = Math.log(1 + (Number(food.logCount) || 0)) / Math.log(1 + maxLogs);

    let recency = 0;
    if (food.lastLoggedAt) {
      const days = (now - new Date(food.lastLoggedAt)) / 86400000;
      if (Number.isFinite(days) && days >= 0) recency = Math.exp(-days / 30);
    }

    const score = 0.45 * similarity
      + 0.30 * frequency
      + 0.15 * recency
      + 0.10 * (food.verified ? 1 : 0);

    return { ...food, score: Math.round(score * 1000) / 1000 };
  }).sort((a, b) => b.score - a.score);
}

// ------------------------------------------------------------
// §2.5 Couples portion scaling
// ------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Splits one recipe unevenly between two people (§2.5).
 *
 * Cooking two different meals is the thing that kills shared eating, so the
 * batch is one recipe and the plates differ. Portions are returned as grams as
 * well as servings, because "1.25 servings" is not something you can put on a
 * scale.
 *
 * @param {Object} perServing - macros for one serving, must include kcal
 * @param {Object} remainingA - { kcal }
 * @param {Object} remainingB - { kcal }
 * @param {number} [totalCookedWeightG] - weight of the whole batch, if known
 */
export function portionsFor(perServing, remainingA, remainingB, totalCookedWeightG = null) {
  const perKcal = Number(perServing?.kcal);
  if (!Number.isFinite(perKcal) || perKcal <= 0) return null;

  const quarter = (v) => Math.round(clamp(v, 0.5, 2.5) * 4) / 4;
  const pA = quarter(Number(remainingA?.kcal) / perKcal);
  const pB = quarter(Number(remainingB?.kcal) / perKcal);

  const batch = Math.ceil(pA + pB);
  const leftovers = Math.round((batch - (pA + pB)) * 100) / 100;

  const scale = (portion) => {
    const out = {};
    for (const key of MACRO_KEYS) {
      const value = Number(perServing?.[key]);
      if (Number.isFinite(value)) out[key] = Math.round(value * portion * 10) / 10;
    }
    return out;
  };

  // Plate weights come from the batch, so the scale does the arithmetic.
  const plateGrams = (portion) =>
    totalCookedWeightG && batch > 0
      ? Math.round((totalCookedWeightG * portion) / batch)
      : null;

  return {
    pA,
    pB,
    batch,
    leftovers,
    macrosA: scale(pA),
    macrosB: scale(pB),
    plateGramsA: plateGrams(pA),
    plateGramsB: plateGrams(pB),
  };
}
