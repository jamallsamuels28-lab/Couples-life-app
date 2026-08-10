// ============================================================
// Fitness engine — pure algorithms
// kiro-algorithm-spec.md §4.2 – §4.5
// ============================================================
//
// Kept separate from the data and UI layer on purpose: these are the formulas
// the spec warned would get quietly replaced with guesses, so they are written
// once, in isolation, and tested directly.
//
// Every derived figure here is computed on read. Nothing is stored (§0.3).
// ============================================================

const DAY_MS = 86400000;

/** Above this rep count an estimated 1RM carries more error than signal (§4.2). */
export const MAX_E1RM_REPS = 12;

/** MET values from §4.5. Gross values — the −1 correction is applied below. */
export const MET = {
  resistance_moderate: 3.5,
  resistance_vigorous: 6.0,
  walk_moderate: 3.3,
  walk_brisk: 4.3,
};

// ------------------------------------------------------------
// §4.2 Estimated 1RM
// ------------------------------------------------------------

const epley = (w, reps) => w * (1 + reps / 30);
const brzycki = (w, reps) => (w * 36) / (37 - reps);

/**
 * Estimated one-rep max.
 *
 * Brzycki is averaged in only up to 10 reps — it degrades badly above that and
 * divides by zero at 37. A single rep is not an estimate at all, it is the
 * measurement, so it is returned unchanged.
 *
 * If reps in reserve is given, the estimate is computed on reps + rir and
 * reported as an at-failure figure, because that is what the formulas assume.
 *
 * @param {Object} set - { weight_kg, reps, rir }
 * @returns {{ value:number, atFailure:boolean, reliable:boolean } | null}
 */
export function estimate1RM(set) {
  const weight = Number(set?.weight_kg);
  const reps = Number(set?.reps);
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps < 1) return null;

  // Guard the null before coercing: Number(null) is 0, which would read an
  // unrecorded RIR as "taken to failure" and inflate every estimate.
  const rirRaw = set.rir;
  const rir = (rirRaw === null || rirRaw === undefined || rirRaw === '' || !Number.isFinite(Number(rirRaw)))
    ? null
    : Number(rirRaw);
  const effectiveReps = rir === null ? reps : reps + rir;

  // Beyond the reliable range the honest answer is "we do not know".
  if (effectiveReps > MAX_E1RM_REPS) {
    return { value: null, atFailure: rir !== null, reliable: false };
  }

  let value;
  if (effectiveReps === 1) value = weight;
  else if (effectiveReps <= 10) value = (epley(weight, effectiveReps) + brzycki(weight, effectiveReps)) / 2;
  else value = epley(weight, effectiveReps);

  return {
    value: Math.round(value * 10) / 10,
    atFailure: rir !== null,
    reliable: true,
  };
}

/**
 * Best estimated 1RM across a group of sets.
 *
 * Unilateral work is excluded from bilateral comparison (§4.1): a set logged
 * as left or right is not comparable with a two-sided lift, and letting it in
 * would either flatter or wreck the number depending on which side it was.
 *
 * @param {Array<Object>} sets
 * @param {Object} [options]
 * @param {'both'|'left'|'right'} [options.side='both']
 * @returns {{ value:number, set:Object }|null}
 */
export function bestE1RM(sets, { side = 'both' } = {}) {
  let best = null;
  for (const set of sets || []) {
    if (set.is_warmup) continue;
    if ((set.side || 'both') !== side) continue;
    const estimate = estimate1RM(set);
    if (!estimate?.reliable || estimate.value === null) continue;
    if (!best || estimate.value > best.value) best = { value: estimate.value, set };
  }
  return best;
}

// ------------------------------------------------------------
// §4.3 Volume load
// ------------------------------------------------------------

/** Working sets only — warm-ups are not training volume. */
export function volumeLoad(set) {
  if (!set || set.is_warmup) return 0;
  const weight = Number(set.weight_kg);
  const reps = Number(set.reps);
  if (!Number.isFinite(weight) || !Number.isFinite(reps)) return 0;
  return weight * reps;
}

export function sessionVolume(sets) {
  return (sets || []).reduce((total, set) => total + volumeLoad(set), 0);
}

/**
 * Weekly volume grouped by movement pattern.
 * @param {Array<Object>} sets
 * @param {Array<Object>} exercises
 * @returns {Object<string, number>}
 */
export function weeklyVolumePerPattern(sets, exercises) {
  const patternById = new Map((exercises || []).map(e => [e.id, e.pattern || 'isolation']));
  const totals = {};
  for (const set of sets || []) {
    const load = volumeLoad(set);
    if (!load) continue;
    const pattern = patternById.get(set.exercise_id) || 'isolation';
    totals[pattern] = (totals[pattern] || 0) + load;
  }
  return totals;
}

// ------------------------------------------------------------
// §4.3 Double progression
// ------------------------------------------------------------

/**
 * Percentage jump when every working set has topped the rep range.
 * Lower-body compounds tolerate a bigger step than everything else.
 */
export function incrementFor(exercise) {
  return exercise?.lower_body && exercise?.compound !== false ? 0.05 : 0.025;
}

/**
 * The next prescription for an exercise, following double progression.
 *
 * If every working set hit the top of the range at RIR 1 or less, the weight
 * goes up and the target drops back to the bottom of the range. Otherwise the
 * weight holds and one rep is added to the weakest set — progress without
 * moving two variables at once.
 *
 * @param {Object} params
 * @param {Array<Object>} params.sets - working sets from the last session
 * @param {[number, number]} params.repRange
 * @param {Object} params.exercise
 * @param {number} [params.increment] - smallest available plate jump, kg
 * @returns {{action:string, weightKg:number, targetReps:number, reason:string}|null}
 */
export function nextProgression({ sets, repRange, exercise, increment }) {
  const working = (sets || []).filter(s => !s.is_warmup);
  if (working.length === 0) return null;

  const [lo, hi] = repRange || [8, 12];
  const weight = Number(working[0].weight_kg);
  if (!Number.isFinite(weight)) return null;

  // RIR is optional. A missing value cannot be assumed to be 0 — treating
  // "unrecorded" as "to failure" would inflate the weight on thin evidence.
  const allTopped = working.every(s =>
    Number(s.reps) >= hi && (s.rir === null || s.rir === undefined || Number(s.rir) <= 1)
  );

  if (allTopped) {
    const step = increment ?? Math.max(weight * incrementFor(exercise), 1.25);
    // Round to the nearest 1.25 kg, the smallest pair of plates most gyms have.
    const nextWeight = Math.round((weight + step) / 1.25) * 1.25;
    return {
      action: 'increase_weight',
      weightKg: nextWeight,
      targetReps: lo,
      reason: `Every set reached ${hi} reps at RIR 1 or below.`,
    };
  }

  const weakest = working.reduce((min, s) => (Number(s.reps) < Number(min.reps) ? s : min), working[0]);
  return {
    action: 'add_rep',
    weightKg: weight,
    targetReps: Math.min(Number(weakest.reps) + 1, hi),
    reason: `Hold the weight and add a rep to the ${weakest.reps}-rep set.`,
  };
}

// ------------------------------------------------------------
// §4.4 ACWR
// ------------------------------------------------------------

/**
 * Acute-to-chronic workload ratio.
 *
 * Both figures are means over *calendar* days, not training days — rest is part
 * of the load picture, and dividing by sessions instead of days would make a
 * deload look like a spike.
 *
 * @param {Array<Object>} sets - sets with performed_at
 * @param {Date} [referenceDate=new Date()]
 * @returns {{ acute:number, chronic:number, ratio:number|null, band:string, message:string }}
 */
export function acwr(sets, referenceDate = new Date()) {
  const end = referenceDate.getTime();
  const acuteStart = end - 7 * DAY_MS;
  const chronicStart = end - 28 * DAY_MS;

  let acuteTotal = 0;
  let chronicTotal = 0;

  for (const set of sets || []) {
    const at = new Date(set.performed_at).getTime();
    // Lower bounds are exclusive so the windows hold exactly 7 and 28 days.
    // Using >= counts a 29th and an 8th day and skews the ratio upward.
    if (!Number.isFinite(at) || at > end || at <= chronicStart) continue;
    const load = volumeLoad(set);
    chronicTotal += load;
    if (at > acuteStart) acuteTotal += load;
  }

  const acute = acuteTotal / 7;
  const chronic = chronicTotal / 28;

  // No training history means no ratio. Reporting 0 or Infinity here would
  // show a beginner an injury warning on their first week.
  if (chronic === 0) {
    return {
      acute: Math.round(acute),
      chronic: 0,
      ratio: null,
      band: 'insufficient_data',
      message: 'Not enough history yet — this needs about four weeks of sessions.',
    };
  }

  const ratio = acute / chronic;
  let band = 'moderate';
  let message = 'Load is climbing but still sensible.';

  if (ratio > 1.5) {
    band = 'spiking';
    message = 'Spiking load, injury risk elevated.';
  } else if (ratio < 0.8) {
    band = 'low';
    message = 'Load has dropped well below your recent average.';
  } else if (ratio <= 1.3) {
    band = 'optimal';
    message = 'Inside the productive band.';
  }

  return {
    acute: Math.round(acute),
    chronic: Math.round(chronic),
    ratio: Math.round(ratio * 100) / 100,
    band,
    message,
  };
}

/**
 * Whether the low band has persisted long enough to mean detraining rather
 * than a single quiet week (§4.4: "ACWR < 0.8 for 14d").
 */
export function isDetraining(sets, referenceDate = new Date()) {
  for (let daysAgo = 0; daysAgo < 14; daysAgo++) {
    const day = new Date(referenceDate.getTime() - daysAgo * DAY_MS);
    const result = acwr(sets, day);
    if (result.ratio === null || result.ratio >= 0.8) return false;
  }
  return true;
}

/**
 * Deload suggestion.
 *
 * Stalling under high load is fatigue and needs rest; stalling under low load
 * is a programming problem and needs a different answer. The distinction is
 * the whole point of pairing the stall check with ACWR.
 *
 * @param {Object} params
 * @param {Array<Array<Object>>} params.sessionsForLift - newest first, each an array of sets
 * @param {Array<Object>} params.allSets
 * @param {Date} [params.referenceDate]
 */
export function deloadCheck({ sessionsForLift, allSets, referenceDate = new Date() }) {
  const load = acwr(allSets, referenceDate);

  const recent = (sessionsForLift || []).slice(0, 3);
  let stalled = false;

  if (recent.length === 3) {
    const bests = recent.map(session => bestE1RM(session)?.value ?? null);
    stalled = bests.every(v => v !== null) && bests[0] <= bests[1] && bests[1] <= bests[2];
  }

  if (stalled && load.ratio !== null && load.ratio > 1.2) {
    return {
      suggest: true,
      kind: 'deload',
      message: 'Three sessions without progress while load is high. This is fatigue — take a lighter week.',
    };
  }

  if (stalled) {
    return {
      suggest: true,
      kind: 'programming',
      message: 'Three sessions without progress, but load is not high. This is a programming problem, not fatigue.',
    };
  }

  return { suggest: false, kind: null, message: load.message };
}

// ------------------------------------------------------------
// §4.5 Training energy expenditure
// ------------------------------------------------------------

/**
 * Net training calories.
 *
 * The −1 matters: gross MET calories include resting metabolism, which is
 * already counted in TDEE. Using the gross figure double-counts it and
 * silently inflates the day's allowance.
 *
 * @param {Object} params
 * @param {number} params.met
 * @param {number} params.weightKg
 * @param {number} params.hours
 * @returns {number} kcal, rounded
 */
export function trainingKcal({ met, weightKg, hours }) {
  if (![met, weightKg, hours].every(v => Number.isFinite(Number(v)))) return 0;
  if (met < 1 || weightKg <= 0 || hours <= 0) return 0;
  return Math.round((met - 1) * weightKg * hours);
}

/**
 * Net calories from steps (§5.2).
 *
 * Steps below the baseline are incidental movement already inside BMR, so
 * counting them again would inflate the day twice over.
 */
export function stepKcal({ steps, weightKg, baseline = 2000 }) {
  const count = Number(steps);
  const weight = Number(weightKg);
  if (!Number.isFinite(count) || !Number.isFinite(weight) || weight <= 0) return 0;
  const countable = Math.max(0, count - baseline);
  return Math.round(countable * 0.000385 * weight);
}

// ------------------------------------------------------------
// Per-limb rehab tracking (§4.1)
// ------------------------------------------------------------

/**
 * Splits a lift's sets by side and compares the two.
 *
 * A rehabbing limb needs its own trend line. Folding it into the bilateral
 * numbers makes the whole block look like a regression when it is recovery
 * going to plan.
 *
 * @param {Array<Object>} sets
 * @returns {{ left:Object, right:Object, both:Object, deficitPct:number|null }}
 */
export function perLimbSummary(sets) {
  const bySide = { left: [], right: [], both: [] };
  for (const set of sets || []) {
    if (set.is_warmup) continue;
    const side = set.side || 'both';
    if (bySide[side]) bySide[side].push(set);
  }

  const summarise = (group) => ({
    sets: group.length,
    volume: sessionVolume(group),
    bestE1RM: group.length ? (bestE1RM(group, { side: group[0].side || 'both' })?.value ?? null) : null,
  });

  const left = summarise(bySide.left);
  const right = summarise(bySide.right);

  // How far the weaker side sits behind the stronger, as a percentage.
  let deficitPct = null;
  if (left.bestE1RM && right.bestE1RM) {
    const strong = Math.max(left.bestE1RM, right.bestE1RM);
    const weak = Math.min(left.bestE1RM, right.bestE1RM);
    deficitPct = Math.round((1 - weak / strong) * 100);
  }

  return { left, right, both: summarise(bySide.both), deficitPct };
}

/**
 * Whether an exercise is currently off-limits for a person (§4.1).
 */
export function isRestricted(exercise, userId) {
  return Boolean(userId) && (exercise?.restricted_for || []).includes(userId);
}

/**
 * Groups sets into sessions, newest first.
 * @param {Array<Object>} sets
 * @returns {Array<{ sessionId:string, performedAt:Date, sets:Array<Object> }>}
 */
export function groupSessions(sets) {
  const bySession = new Map();
  for (const set of sets || []) {
    const key = set.session_id || new Date(set.performed_at).toDateString();
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key).push(set);
  }
  return [...bySession.entries()]
    .map(([sessionId, group]) => ({
      sessionId,
      performedAt: new Date(Math.min(...group.map(s => new Date(s.performed_at).getTime()))),
      sets: group,
    }))
    .sort((a, b) => b.performedAt - a.performedAt);
}
