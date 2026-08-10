/**
 * Nutrition engine — kiro-algorithm-spec.md §2.5, §3.2 – §3.6
 */
import { describe, it, expect } from 'vitest';
import {
  smoothWeight,
  currentSmoothedWeight,
  bmr,
  predictedTDEE,
  measuredTDEE,
  blendedTDEE,
  setTargets,
  plateauCheck,
  macrosForGrams,
  sumMacros,
  remainingMacros,
  projectDay,
  trigramSimilarity,
  rankFoods,
  portionsFor,
  KCAL_PER_KG,
} from '../js/nutrition-engine.js';

const day = (n) => {
  const d = new Date(2026, 6, 1);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

// --- §3.2 -----------------------------------------------------

describe('smoothWeight', () => {
  it('seeds the smoothed line with the first reading', () => {
    const series = smoothWeight([{ date: day(0), weight_kg: 100 }]);
    expect(series[0].smoothed).toBe(100);
  });

  it('damps a single-day spike', () => {
    const series = smoothWeight([
      { date: day(0), weight_kg: 100 },
      { date: day(1), weight_kg: 104 },
    ]);
    // 0.25 × 104 + 0.75 × 100 = 101, not 104.
    expect(series[1].smoothed).toBe(101);
  });

  it('flags a reading that jumps more than 2.5 kg', () => {
    const series = smoothWeight([
      { date: day(0), weight_kg: 100 },
      { date: day(1), weight_kg: 103.5 },
    ]);
    expect(series[1].flagged).toBe(true);
  });

  it('still includes the flagged reading rather than discarding it', () => {
    const series = smoothWeight([
      { date: day(0), weight_kg: 100 },
      { date: day(1), weight_kg: 110 },
    ]);
    expect(series[1].smoothed).toBeGreaterThan(100);
  });

  it('does not flag ordinary daily noise', () => {
    const series = smoothWeight([
      { date: day(0), weight_kg: 100 },
      { date: day(1), weight_kg: 101 },
    ]);
    expect(series[1].flagged).toBe(false);
  });

  it('sorts unordered input before smoothing', () => {
    const series = smoothWeight([
      { date: day(2), weight_kg: 102 },
      { date: day(0), weight_kg: 100 },
      { date: day(1), weight_kg: 101 },
    ]);
    expect(series.map(s => s.raw)).toEqual([100, 101, 102]);
  });

  it('ignores unparseable weights', () => {
    expect(smoothWeight([{ date: day(0), weight_kg: 'heavy' }])).toEqual([]);
  });

  it('returns the latest smoothed value', () => {
    expect(currentSmoothedWeight([
      { date: day(0), weight_kg: 100 },
      { date: day(1), weight_kg: 104 },
    ])).toBe(101);
    expect(currentSmoothedWeight([])).toBeNull();
  });
});

// --- §3.3 -----------------------------------------------------

describe('bmr', () => {
  it('matches Mifflin-St Jeor for a man', () => {
    // 10×100 + 6.25×180 − 5×30 + 5 = 1980
    expect(bmr({ weightKg: 100, heightCm: 180, age: 30, sex: 'male' })).toBe(1980);
  });

  it('matches Mifflin-St Jeor for a woman', () => {
    // 10×70 + 6.25×165 − 5×30 − 161 = 1420.25 → 1420
    expect(bmr({ weightKg: 70, heightCm: 165, age: 30, sex: 'female' })).toBe(1420);
  });

  it('returns null on missing inputs', () => {
    expect(bmr({ weightKg: 100, heightCm: 180 })).toBeNull();
    expect(bmr({ weightKg: 0, heightCm: 180, age: 30 })).toBeNull();
  });
});

describe('predictedTDEE', () => {
  it('adds real step and training calories rather than a lifestyle multiplier', () => {
    expect(predictedTDEE({ bmrValue: 2000, stepCalories: 400, trainingCalories: 290 }))
      .toBe(Math.round(2000 * 1.15) + 400 + 290);
  });

  it('works with no activity logged', () => {
    expect(predictedTDEE({ bmrValue: 2000 })).toBe(2300);
  });

  it('returns null without a BMR', () => {
    expect(predictedTDEE({ bmrValue: null })).toBeNull();
  });
});

describe('measuredTDEE', () => {
  const weighIns = Array.from({ length: 29 }, (_, i) => ({
    date: day(i),
    // Losing roughly half a kilo a week.
    weight_kg: 100 - i * 0.07,
  }));
  const fullIntake = Array.from({ length: 29 }, (_, i) => ({ date: day(i), kcal: 2200 }));

  it('raises expenditure above intake when weight is falling', () => {
    const result = measuredTDEE({ dailyIntake: fullIntake, weighIns });
    expect(result.value).toBeGreaterThan(2200);
  });

  it('lowers expenditure below intake when weight is rising', () => {
    const gaining = weighIns.map((w, i) => ({ date: day(i), weight_kg: 100 + i * 0.07 }));
    const result = measuredTDEE({ dailyIntake: fullIntake, weighIns: gaining });
    expect(result.value).toBeLessThan(2200);
  });

  it('uses 7700 kcal per kilogram', () => {
    const flat = Array.from({ length: 29 }, (_, i) => ({ date: day(i), weight_kg: 100 }));
    const result = measuredTDEE({ dailyIntake: fullIntake, weighIns: flat });
    // No weight change means expenditure equals intake.
    expect(result.value).toBe(2200);
    expect(KCAL_PER_KG).toBe(7700);
  });

  it('refuses to report from fewer than ten logged days', () => {
    const sparse = fullIntake.slice(0, 8);
    const result = measuredTDEE({ dailyIntake: sparse, weighIns });
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/Keep logging/);
  });

  it('refuses to report below 70% coverage of the window', () => {
    const patchy = fullIntake.filter((_, i) => i % 2 === 0); // ~50%
    const result = measuredTDEE({ dailyIntake: patchy, weighIns });
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/70%/);
  });

  it('refuses to report before fourteen days of weigh-ins', () => {
    const short = weighIns.slice(0, 10);
    const result = measuredTDEE({ dailyIntake: fullIntake, weighIns: short });
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/more days/);
  });

  it('needs at least two weigh-ins', () => {
    expect(measuredTDEE({ dailyIntake: [], weighIns: [] }).value).toBeNull();
  });
});

describe('blendedTDEE', () => {
  it('falls back to predicted when measured is unavailable', () => {
    const result = blendedTDEE({ predicted: 2500, measured: { value: null, reason: 'x' }, loggedDays: 3 });
    expect(result.value).toBe(2500);
    expect(result.source).toBe('predicted');
  });

  it('weights measured more heavily as logging accumulates', () => {
    const early = blendedTDEE({ predicted: 2000, measured: { value: 3000 }, loggedDays: 7 });
    const later = blendedTDEE({ predicted: 2000, measured: { value: 3000 }, loggedDays: 21 });
    expect(later.value).toBeGreaterThan(early.value);
  });

  it('uses measured alone once the window is full', () => {
    const result = blendedTDEE({ predicted: 2000, measured: { value: 3000 }, loggedDays: 28 });
    expect(result.value).toBe(3000);
    expect(result.source).toBe('measured');
  });
});

// --- §3.4 -----------------------------------------------------

describe('setTargets', () => {
  const base = { tdee: 2800, weightKg: 116, sex: 'male', bmrValue: 2000, goalWeightKg: 95 };

  it('applies the requested deficit when it is within the caps', () => {
    const result = setTargets({ ...base, goalRateKgPerWeek: -0.5 });
    expect(result.targetKcal).toBe(Math.round(2800 - (0.5 * 7700) / 7));
    expect(result.capped).toBeNull();
  });

  it('caps the deficit at 25% of expenditure', () => {
    const result = setTargets({ ...base, goalRateKgPerWeek: -1.5 });
    expect(result.targetKcal).toBeGreaterThanOrEqual(2800 * 0.75);
    expect(result.capped).toBeTruthy();
  });

  it('caps the deficit at 1% of bodyweight per week', () => {
    // A light person with a high expenditure: the bodyweight cap should bind.
    const result = setTargets({
      tdee: 3000, weightKg: 60, sex: 'female', bmrValue: 1400, goalRateKgPerWeek: -1.5,
    });
    expect(result.capped).toBe('bodyweight');
  });

  it('never sets a target below BMR', () => {
    const result = setTargets({
      tdee: 2100, weightKg: 116, sex: 'male', bmrValue: 2000, goalRateKgPerWeek: -1.0,
    });
    expect(result.targetKcal).toBeGreaterThanOrEqual(2000);
  });

  it('never goes below the absolute floor for a man', () => {
    const result = setTargets({
      tdee: 1600, weightKg: 60, sex: 'male', bmrValue: 1300, goalRateKgPerWeek: -1.0,
    });
    expect(result.targetKcal).toBeGreaterThanOrEqual(1500);
  });

  it('never goes below the absolute floor for a woman', () => {
    const result = setTargets({
      tdee: 1300, weightKg: 50, sex: 'female', bmrValue: 1100, goalRateKgPerWeek: -1.0,
    });
    expect(result.targetKcal).toBeGreaterThanOrEqual(1200);
  });

  it('anchors protein to the reference weight, not current weight', () => {
    const result = setTargets({ ...base, goalRateKgPerWeek: -0.5 });
    // 95 × 1.1 = 104.5 reference → about 209 g, not 232 g.
    expect(result.proteinG).toBeLessThan(220);
    expect(result.proteinG).toBeGreaterThan(195);
  });

  it('falls back to current weight when no goal weight is set', () => {
    const result = setTargets({ ...base, goalWeightKg: undefined, goalRateKgPerWeek: -0.5 });
    expect(result.proteinG).toBe(232);
  });

  it('keeps fat at or above the essential floor', () => {
    const result = setTargets({ ...base, goalRateKgPerWeek: -0.5 });
    expect(result.fatG).toBeGreaterThanOrEqual(Math.round(104.5 * 0.8) - 1);
  });

  it('produces a macro split that adds up to the target', () => {
    const r = setTargets({ ...base, goalRateKgPerWeek: -0.5 });
    const fromMacros = r.proteinG * 4 + r.fatG * 9 + r.carbsG * 4;
    expect(Math.abs(fromMacros - r.targetKcal)).toBeLessThan(15);
  });

  it('handles a surplus without applying deficit caps', () => {
    const result = setTargets({ ...base, goalRateKgPerWeek: 0.25 });
    expect(result.targetKcal).toBeGreaterThan(2800);
    expect(result.capped).toBeNull();
  });

  it('returns null on missing inputs', () => {
    expect(setTargets({ tdee: null, weightKg: 100 })).toBeNull();
  });
});

describe('plateauCheck', () => {
  const flat = Array.from({ length: 22 }, (_, i) => ({ date: day(i), weight_kg: 100 }));

  it('calls a plateau when weight is flat and logging is good', () => {
    expect(plateauCheck({ weighIns: flat, loggedDays: 20 }).plateaued).toBe(true);
  });

  it('does not call a plateau on patchy logging', () => {
    expect(plateauCheck({ weighIns: flat, loggedDays: 10 }).plateaued).toBe(false);
  });

  it('does not call a plateau while weight is still moving', () => {
    const falling = Array.from({ length: 22 }, (_, i) => ({ date: day(i), weight_kg: 100 - i * 0.1 }));
    expect(plateauCheck({ weighIns: falling, loggedDays: 20 }).plateaued).toBe(false);
  });

  it('recommends recomputing rather than cutting calories', () => {
    expect(plateauCheck({ weighIns: flat, loggedDays: 20 }).reason).toMatch(/Recompute/);
  });
});

// --- §3.5 -----------------------------------------------------

describe('macrosForGrams', () => {
  it('scales from per-100 g figures', () => {
    const macros = macrosForGrams({ kcal: 165, protein: 31, carbs: 0, fat: 3.6 }, 150);
    expect(macros.kcal).toBe(247.5);
    expect(macros.protein).toBe(46.5);
  });

  it('treats a missing nutrient as zero rather than NaN', () => {
    expect(macrosForGrams({ kcal: 100 }, 100).fibre).toBe(0);
  });

  it('rejects a negative quantity', () => {
    expect(macrosForGrams({ kcal: 100 }, -50)).toBeNull();
  });
});

describe('remainingMacros', () => {
  const targets = { targetKcal: 2400, proteinG: 210, carbsG: 200, fatG: 84 };

  it('subtracts what has been logged', () => {
    const remaining = remainingMacros(targets, [
      { macros: { kcal: 500, protein: 40, carbs: 30, fat: 20 } },
      { macros: { kcal: 700, protein: 60, carbs: 50, fat: 25 } },
    ]);
    expect(remaining.kcal).toBe(1200);
    expect(remaining.protein).toBe(110);
  });

  it('reports an overshoot honestly rather than clamping at zero', () => {
    const remaining = remainingMacros(targets, [{ macros: { kcal: 3000 } }]);
    expect(remaining.kcal).toBe(-600);
  });

  it('handles an empty day', () => {
    expect(remainingMacros(targets, []).kcal).toBe(2400);
  });
});

describe('projectDay', () => {
  const at = (dayOffset, hour, kcal) => ({
    entry_date: day(dayOffset),
    logged_at: new Date(2026, 6, 1 + dayOffset, hour).toISOString(),
    macros: { kcal },
  });

  it('projects the rest of the day from recent habit at this hour', () => {
    const now = new Date(2026, 6, 20, 15, 0);
    const result = projectDay({
      todayEntries: [{ macros: { kcal: 1200 } }],
      historyEntries: [at(1, 19, 800), at(2, 19, 900), at(3, 12, 500)],
      now,
    });
    // Only the 19:00 entries are still ahead at 15:00.
    expect(result.expectedRemainder).toBe(850);
    expect(result.projectedTotal).toBe(2050);
    expect(result.basis).toBe(2);
  });

  it('projects nothing late in the evening', () => {
    const result = projectDay({
      todayEntries: [{ macros: { kcal: 2000 } }],
      historyEntries: [at(1, 19, 800)],
      now: new Date(2026, 6, 20, 23, 0),
    });
    expect(result.expectedRemainder).toBe(0);
    expect(result.projectedTotal).toBe(2000);
  });

  it('says how many days the projection rests on', () => {
    expect(projectDay({ todayEntries: [], historyEntries: [], now: new Date() }).basis).toBe(0);
  });
});

// --- §3.6 -----------------------------------------------------

describe('trigramSimilarity', () => {
  it('scores an exact match highest', () => {
    expect(trigramSimilarity('chicken', 'chicken')).toBe(1);
  });

  it('scores a partial match in between', () => {
    const partial = trigramSimilarity('chicken', 'chicken breast');
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });

  it('scores unrelated words near zero', () => {
    expect(trigramSimilarity('chicken', 'yoghurt')).toBeLessThan(0.1);
  });

  it('is case-insensitive', () => {
    expect(trigramSimilarity('Chicken', 'chicken')).toBe(1);
  });
});

describe('rankFoods', () => {
  const now = new Date(2026, 6, 20);

  it('puts the closer name first, all else equal', () => {
    const ranked = rankFoods('chicken breast', [
      { name: 'Chicken thigh' },
      { name: 'Chicken breast' },
    ], now);
    expect(ranked[0].name).toBe('Chicken breast');
  });

  it('lifts a food the person logs often', () => {
    const ranked = rankFoods('chicken', [
      { name: 'Chicken breast', logCount: 0 },
      { name: 'Chicken breast fillet', logCount: 80 },
    ], now);
    expect(ranked[0].logCount).toBe(80);
  });

  it('lifts a recently logged food over a stale one', () => {
    // Identical names, so recency is the only thing separating them.
    const ranked = rankFoods('oats', [
      { id: 'stale', name: 'Oats', lastLoggedAt: new Date(2025, 0, 1).toISOString() },
      { id: 'fresh', name: 'Oats', lastLoggedAt: new Date(2026, 6, 19).toISOString() },
    ], now);
    expect(ranked[0].id).toBe('fresh');
  });

  it('still lets a much closer name outrank a recently logged one', () => {
    // Name similarity carries nearly half the weight, so it should dominate.
    const ranked = rankFoods('oats', [
      { id: 'exact', name: 'Oats' },
      { id: 'loose', name: 'Oats rolled jumbo porridge', lastLoggedAt: now.toISOString() },
    ], now);
    expect(ranked[0].id).toBe('exact');
  });

  it('gives verified entries a nudge', () => {
    const ranked = rankFoods('milk', [
      { name: 'Milk', verified: false },
      { name: 'Milk', verified: true },
    ], now);
    expect(ranked[0].verified).toBe(true);
  });

  it('handles an empty list', () => {
    expect(rankFoods('anything', [])).toEqual([]);
  });
});

// --- §2.5 -----------------------------------------------------

describe('portionsFor', () => {
  const perServing = { kcal: 600, protein: 45, carbs: 50, fat: 20 };

  it('splits one recipe unevenly by remaining calories', () => {
    const result = portionsFor(perServing, { kcal: 750 }, { kcal: 450 });
    expect(result.pA).toBe(1.25);
    expect(result.pB).toBe(0.75);
  });

  it('rounds to a quarter serving', () => {
    const result = portionsFor(perServing, { kcal: 700 }, { kcal: 500 });
    expect((result.pA * 4) % 1).toBe(0);
    expect((result.pB * 4) % 1).toBe(0);
  });

  it('clamps to a realistic plate', () => {
    const big = portionsFor(perServing, { kcal: 9000 }, { kcal: 100 });
    expect(big.pA).toBe(2.5);
    expect(big.pB).toBe(0.5);
  });

  it('cooks a whole number of servings and reports the leftovers', () => {
    const result = portionsFor(perServing, { kcal: 750 }, { kcal: 450 });
    expect(result.batch).toBe(2);
    expect(result.leftovers).toBe(0);

    const uneven = portionsFor(perServing, { kcal: 750 }, { kcal: 600 });
    expect(uneven.batch).toBe(3);
    expect(uneven.leftovers).toBeCloseTo(0.75, 2);
  });

  it('scales each plate\'s macros by its portion', () => {
    const result = portionsFor(perServing, { kcal: 750 }, { kcal: 450 });
    expect(result.macrosA.protein).toBe(56.3);
    expect(result.macrosB.protein).toBe(33.8);
  });

  it('gives plate weights so the scale does the arithmetic', () => {
    const result = portionsFor(perServing, { kcal: 750 }, { kcal: 450 }, 1000);
    // Batch of 2 from 1000 g: 1.25 servings is 625 g, 0.75 is 375 g.
    expect(result.plateGramsA).toBe(625);
    expect(result.plateGramsB).toBe(375);
  });

  it('omits plate weights when the batch weight is unknown', () => {
    expect(portionsFor(perServing, { kcal: 750 }, { kcal: 450 }).plateGramsA).toBeNull();
  });

  it('returns null without a per-serving calorie figure', () => {
    expect(portionsFor({ protein: 40 }, { kcal: 700 }, { kcal: 500 })).toBeNull();
  });
});
