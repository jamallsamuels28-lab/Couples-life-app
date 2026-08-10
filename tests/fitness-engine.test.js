/**
 * Fitness engine — kiro-algorithm-spec.md §4.2 – §4.5
 */
import { describe, it, expect } from 'vitest';
import {
  estimate1RM,
  bestE1RM,
  volumeLoad,
  sessionVolume,
  weeklyVolumePerPattern,
  incrementFor,
  nextProgression,
  acwr,
  isDetraining,
  deloadCheck,
  trainingKcal,
  stepKcal,
  perLimbSummary,
  isRestricted,
  groupSessions,
  MAX_E1RM_REPS,
} from '../js/fitness-engine.js';

const set = (over = {}) => ({
  weight_kg: 100, reps: 5, rir: null, side: 'both', is_warmup: false,
  exercise_id: 'ex-1', session_id: 's-1', performed_at: '2026-08-10T18:00:00Z',
  ...over,
});

const daysAgo = (n, iso = '2026-08-10T12:00:00Z') =>
  new Date(new Date(iso).getTime() - n * 86400000).toISOString();

// --- §4.2 -----------------------------------------------------

describe('estimate1RM', () => {
  it('returns the weight itself for a single rep', () => {
    expect(estimate1RM(set({ weight_kg: 140, reps: 1 })).value).toBe(140);
  });

  it('averages Epley and Brzycki at or below ten reps', () => {
    const result = estimate1RM(set({ weight_kg: 100, reps: 5 }));
    const epley = 100 * (1 + 5 / 30);
    const brzycki = (100 * 36) / (37 - 5);
    expect(result.value).toBeCloseTo(Math.round(((epley + brzycki) / 2) * 10) / 10, 1);
  });

  it('uses Epley alone above ten reps, where Brzycki degrades', () => {
    const result = estimate1RM(set({ weight_kg: 60, reps: 12 }));
    expect(result.value).toBeCloseTo(Math.round(60 * (1 + 12 / 30) * 10) / 10, 1);
  });

  it('refuses to estimate beyond twelve reps', () => {
    const result = estimate1RM(set({ reps: 13 }));
    expect(result.reliable).toBe(false);
    expect(result.value).toBeNull();
  });

  it('adds reps in reserve and reports the figure as at-failure', () => {
    const withRir = estimate1RM(set({ weight_kg: 100, reps: 5, rir: 3 }));
    const atEight = estimate1RM(set({ weight_kg: 100, reps: 8 }));
    expect(withRir.value).toBe(atEight.value);
    expect(withRir.atFailure).toBe(true);
  });

  it('does not treat a missing RIR as failure', () => {
    expect(estimate1RM(set({ rir: null })).atFailure).toBe(false);
  });

  it('pushes a set past the reliable range once RIR is added', () => {
    // 10 reps with 3 in reserve is effectively 13 — beyond the limit.
    expect(estimate1RM(set({ reps: 10, rir: 3 })).reliable).toBe(false);
  });

  it('rejects nonsense', () => {
    expect(estimate1RM(null)).toBeNull();
    expect(estimate1RM(set({ weight_kg: 0 }))).toBeNull();
    expect(estimate1RM(set({ reps: 0 }))).toBeNull();
    expect(estimate1RM(set({ weight_kg: 'heavy' }))).toBeNull();
  });

  it('never divides by zero at the Brzycki singularity', () => {
    // 37 reps would break Brzycki; it is out of range long before that.
    expect(estimate1RM(set({ reps: 37 })).value).toBeNull();
    expect(MAX_E1RM_REPS).toBeLessThan(37);
  });
});

describe('bestE1RM', () => {
  it('picks the highest reliable estimate', () => {
    const best = bestE1RM([
      set({ weight_kg: 100, reps: 5 }),
      set({ weight_kg: 120, reps: 3 }),
      set({ weight_kg: 80, reps: 8 }),
    ]);
    expect(best.set.weight_kg).toBe(120);
  });

  it('ignores warm-ups', () => {
    const best = bestE1RM([
      set({ weight_kg: 200, reps: 5, is_warmup: true }),
      set({ weight_kg: 100, reps: 5 }),
    ]);
    expect(best.set.weight_kg).toBe(100);
  });

  it('excludes single-limb work from the bilateral figure', () => {
    const best = bestE1RM([
      set({ weight_kg: 100, reps: 5, side: 'both' }),
      set({ weight_kg: 200, reps: 5, side: 'left' }),
    ]);
    expect(best.set.weight_kg).toBe(100);
  });

  it('can report a single side on request', () => {
    const best = bestE1RM([
      set({ weight_kg: 100, reps: 5, side: 'both' }),
      set({ weight_kg: 30, reps: 5, side: 'left' }),
    ], { side: 'left' });
    expect(best.set.weight_kg).toBe(30);
  });

  it('returns null when nothing is comparable', () => {
    expect(bestE1RM([])).toBeNull();
    expect(bestE1RM([set({ reps: 20 })])).toBeNull();
  });
});

// --- §4.3 -----------------------------------------------------

describe('volumeLoad', () => {
  it('multiplies weight by reps', () => {
    expect(volumeLoad(set({ weight_kg: 100, reps: 5 }))).toBe(500);
  });

  it('counts a warm-up as nothing', () => {
    expect(volumeLoad(set({ is_warmup: true }))).toBe(0);
  });

  it('sums a session, warm-ups excluded', () => {
    expect(sessionVolume([
      set({ weight_kg: 60, reps: 10, is_warmup: true }),
      set({ weight_kg: 100, reps: 5 }),
      set({ weight_kg: 100, reps: 5 }),
    ])).toBe(1000);
  });
});

describe('weeklyVolumePerPattern', () => {
  it('groups by movement pattern', () => {
    const exercises = [
      { id: 'ex-1', pattern: 'squat' },
      { id: 'ex-2', pattern: 'pull_h' },
    ];
    const totals = weeklyVolumePerPattern([
      set({ exercise_id: 'ex-1', weight_kg: 100, reps: 5 }),
      set({ exercise_id: 'ex-1', weight_kg: 100, reps: 5 }),
      set({ exercise_id: 'ex-2', weight_kg: 50, reps: 10 }),
    ], exercises);
    expect(totals).toEqual({ squat: 1000, pull_h: 500 });
  });

  it('files an unknown exercise under isolation rather than dropping it', () => {
    const totals = weeklyVolumePerPattern([set({ exercise_id: 'ghost' })], []);
    expect(totals.isolation).toBe(500);
  });
});

describe('incrementFor', () => {
  it('gives lower-body compounds the larger jump', () => {
    expect(incrementFor({ lower_body: true, compound: true })).toBe(0.05);
  });

  it('gives everything else the smaller jump', () => {
    expect(incrementFor({ lower_body: false, compound: true })).toBe(0.025);
    expect(incrementFor({ lower_body: true, compound: false })).toBe(0.025);
  });
});

describe('nextProgression', () => {
  const exercise = { lower_body: false, compound: true };

  it('adds weight when every set tops the range at RIR 1 or less', () => {
    const result = nextProgression({
      sets: [set({ weight_kg: 60, reps: 12, rir: 1 }), set({ weight_kg: 60, reps: 12, rir: 0 })],
      repRange: [8, 12],
      exercise,
    });
    expect(result.action).toBe('increase_weight');
    expect(result.weightKg).toBeGreaterThan(60);
    expect(result.targetReps).toBe(8);
  });

  it('holds the weight and adds a rep to the weakest set otherwise', () => {
    const result = nextProgression({
      sets: [set({ weight_kg: 60, reps: 12, rir: 1 }), set({ weight_kg: 60, reps: 9, rir: 1 })],
      repRange: [8, 12],
      exercise,
    });
    expect(result.action).toBe('add_rep');
    expect(result.weightKg).toBe(60);
    expect(result.targetReps).toBe(10);
  });

  it('does not add weight when the sets were left with reps in reserve', () => {
    const result = nextProgression({
      sets: [set({ weight_kg: 60, reps: 12, rir: 3 })],
      repRange: [8, 12],
      exercise,
    });
    expect(result.action).toBe('add_rep');
  });

  it('treats an unrecorded RIR as good enough rather than assuming failure', () => {
    const result = nextProgression({
      sets: [set({ weight_kg: 60, reps: 12, rir: null })],
      repRange: [8, 12],
      exercise,
    });
    expect(result.action).toBe('increase_weight');
  });

  it('rounds to the nearest 1.25 kg', () => {
    const result = nextProgression({
      sets: [set({ weight_kg: 60, reps: 12, rir: 0 })],
      repRange: [8, 12],
      exercise,
    });
    expect(result.weightKg % 1.25).toBeCloseTo(0, 5);
  });

  it('gives a squat a bigger jump than a press at the same weight', () => {
    const args = { sets: [set({ weight_kg: 100, reps: 12, rir: 0 })], repRange: [8, 12] };
    const squat = nextProgression({ ...args, exercise: { lower_body: true, compound: true } });
    const press = nextProgression({ ...args, exercise: { lower_body: false, compound: true } });
    expect(squat.weightKg).toBeGreaterThan(press.weightKg);
  });

  it('never suggests more reps than the top of the range', () => {
    const result = nextProgression({
      sets: [set({ weight_kg: 60, reps: 12, rir: 4 })],
      repRange: [8, 12],
      exercise,
    });
    expect(result.targetReps).toBeLessThanOrEqual(12);
  });

  it('ignores warm-ups when deciding', () => {
    const result = nextProgression({
      sets: [set({ weight_kg: 20, reps: 5, is_warmup: true }), set({ weight_kg: 60, reps: 12, rir: 0 })],
      repRange: [8, 12],
      exercise,
    });
    expect(result.weightKg).toBeGreaterThan(60);
  });

  it('returns nothing when there is no working set', () => {
    expect(nextProgression({ sets: [], repRange: [8, 12], exercise })).toBeNull();
  });
});

// --- §4.4 -----------------------------------------------------

describe('acwr', () => {
  const reference = new Date('2026-08-10T12:00:00Z');

  it('reports insufficient data rather than a scary number when new', () => {
    const result = acwr([], reference);
    expect(result.ratio).toBeNull();
    expect(result.band).toBe('insufficient_data');
  });

  it('sits in the optimal band when load is steady', () => {
    const sets = [];
    for (let d = 0; d < 28; d++) sets.push(set({ performed_at: daysAgo(d), weight_kg: 100, reps: 10 }));
    const result = acwr(sets, reference);
    expect(result.ratio).toBeCloseTo(1, 1);
    expect(result.band).toBe('optimal');
  });

  it('flags a spike', () => {
    const sets = [];
    for (let d = 7; d < 28; d++) sets.push(set({ performed_at: daysAgo(d), weight_kg: 20, reps: 5 }));
    for (let d = 0; d < 7; d++) sets.push(set({ performed_at: daysAgo(d), weight_kg: 200, reps: 10 }));
    const result = acwr(sets, reference);
    expect(result.ratio).toBeGreaterThan(1.5);
    expect(result.band).toBe('spiking');
  });

  it('flags a drop', () => {
    const sets = [];
    for (let d = 7; d < 28; d++) sets.push(set({ performed_at: daysAgo(d), weight_kg: 200, reps: 10 }));
    const result = acwr(sets, reference);
    expect(result.ratio).toBeLessThan(0.8);
    expect(result.band).toBe('low');
  });

  it('averages over calendar days, so rest days count', () => {
    // One heavy session in seven days, nothing else.
    const sets = [set({ performed_at: daysAgo(0), weight_kg: 100, reps: 7 })];
    const result = acwr(sets, reference);
    expect(result.acute).toBe(100);
  });

  it('ignores sets outside the 28-day window', () => {
    const sets = [set({ performed_at: daysAgo(40), weight_kg: 500, reps: 10 })];
    expect(acwr(sets, reference).chronic).toBe(0);
  });

  it('ignores sets in the future', () => {
    const sets = [set({ performed_at: daysAgo(-3), weight_kg: 500, reps: 10 })];
    expect(acwr(sets, reference).chronic).toBe(0);
  });
});

describe('isDetraining', () => {
  const reference = new Date('2026-08-10T12:00:00Z');

  it('is false when there is no history at all', () => {
    expect(isDetraining([], reference)).toBe(false);
  });

  it('is true when the ratio has been low for a fortnight', () => {
    const sets = [];
    // Training stopped 22 days ago. The acute window is seven days wide, so it
    // has to have been empty for fourteen consecutive days — which means the
    // last session was at least 21 days back.
    for (let d = 22; d < 46; d++) sets.push(set({ performed_at: daysAgo(d), weight_kg: 100, reps: 10 }));
    expect(isDetraining(sets, reference)).toBe(true);
  });

  it('is false after a single quiet week', () => {
    const sets = [];
    for (let d = 7; d < 28; d++) sets.push(set({ performed_at: daysAgo(d), weight_kg: 100, reps: 10 }));
    expect(isDetraining(sets, reference)).toBe(false);
  });
});

describe('deloadCheck', () => {
  const reference = new Date('2026-08-10T12:00:00Z');
  const flat = [
    [set({ weight_kg: 100, reps: 5 })],
    [set({ weight_kg: 100, reps: 5 })],
    [set({ weight_kg: 100, reps: 5 })],
  ];

  it('calls a stall under high load fatigue', () => {
    const allSets = [];
    for (let d = 7; d < 28; d++) allSets.push(set({ performed_at: daysAgo(d), weight_kg: 60, reps: 10 }));
    for (let d = 0; d < 7; d++) allSets.push(set({ performed_at: daysAgo(d), weight_kg: 100, reps: 10 }));
    const result = deloadCheck({ sessionsForLift: flat, allSets, referenceDate: reference });
    expect(result.suggest).toBe(true);
    expect(result.kind).toBe('deload');
  });

  it('calls a stall under normal load a programming problem', () => {
    const allSets = [];
    for (let d = 0; d < 28; d++) allSets.push(set({ performed_at: daysAgo(d), weight_kg: 100, reps: 10 }));
    const result = deloadCheck({ sessionsForLift: flat, allSets, referenceDate: reference });
    expect(result.suggest).toBe(true);
    expect(result.kind).toBe('programming');
  });

  it('suggests nothing while the lift is still improving', () => {
    const improving = [
      [set({ weight_kg: 110, reps: 5 })],
      [set({ weight_kg: 105, reps: 5 })],
      [set({ weight_kg: 100, reps: 5 })],
    ];
    const allSets = [];
    for (let d = 0; d < 28; d++) allSets.push(set({ performed_at: daysAgo(d), weight_kg: 100, reps: 10 }));
    expect(deloadCheck({ sessionsForLift: improving, allSets, referenceDate: reference }).suggest).toBe(false);
  });

  it('waits for three sessions before judging', () => {
    const allSets = [set({ performed_at: daysAgo(1) })];
    const result = deloadCheck({
      sessionsForLift: flat.slice(0, 2), allSets, referenceDate: reference,
    });
    expect(result.suggest).toBe(false);
  });
});

// --- §4.5 and §5.2 -------------------------------------------

describe('trainingKcal', () => {
  it('subtracts resting metabolism so TDEE is not double-counted', () => {
    // Gross would be 3.5 × 116 × 1 = 406; net is 2.5 × 116 = 290.
    expect(trainingKcal({ met: 3.5, weightKg: 116, hours: 1 })).toBe(290);
  });

  it('scales with duration', () => {
    expect(trainingKcal({ met: 6, weightKg: 100, hours: 0.5 })).toBe(250);
  });

  it('returns zero for nonsense', () => {
    expect(trainingKcal({ met: 0, weightKg: 100, hours: 1 })).toBe(0);
    expect(trainingKcal({ met: 3.5, weightKg: -5, hours: 1 })).toBe(0);
    expect(trainingKcal({})).toBe(0);
  });
});

describe('stepKcal', () => {
  /** The spec's own sanity check: 116 kg, 13,500 steps should be roughly 600. */
  it('matches the figure the spec anchors to', () => {
    const kcal = stepKcal({ steps: 13500, weightKg: 116, baseline: 0 });
    expect(kcal).toBeGreaterThan(550);
    expect(kcal).toBeLessThan(650);
  });

  it('does not produce the gross figure', () => {
    expect(stepKcal({ steps: 13500, weightKg: 116, baseline: 0 })).toBeLessThan(1000);
  });

  it('ignores incidental steps below the baseline', () => {
    expect(stepKcal({ steps: 1500, weightKg: 116 })).toBe(0);
  });

  it('counts only the steps above the baseline', () => {
    const above = stepKcal({ steps: 5000, weightKg: 100, baseline: 2000 });
    const raw = stepKcal({ steps: 3000, weightKg: 100, baseline: 0 });
    expect(above).toBe(raw);
  });
});

// --- Per-limb (§4.1) -----------------------------------------

describe('perLimbSummary', () => {
  it('tracks each side separately', () => {
    const summary = perLimbSummary([
      set({ side: 'left', weight_kg: 10, reps: 10 }),
      set({ side: 'right', weight_kg: 16, reps: 10 }),
      set({ side: 'both', weight_kg: 40, reps: 10 }),
    ]);
    expect(summary.left.sets).toBe(1);
    expect(summary.right.sets).toBe(1);
    expect(summary.both.volume).toBe(400);
  });

  it('reports how far the weaker side trails', () => {
    const summary = perLimbSummary([
      set({ side: 'left', weight_kg: 10, reps: 5 }),
      set({ side: 'right', weight_kg: 20, reps: 5 }),
    ]);
    expect(summary.deficitPct).toBe(50);
  });

  it('gives no deficit when only one side has been trained', () => {
    expect(perLimbSummary([set({ side: 'left' })]).deficitPct).toBeNull();
  });

  it('ignores warm-ups', () => {
    expect(perLimbSummary([set({ side: 'left', is_warmup: true })]).left.sets).toBe(0);
  });
});

describe('isRestricted', () => {
  it('is true when the person is listed', () => {
    expect(isRestricted({ restricted_for: ['user-a'] }, 'user-a')).toBe(true);
  });

  it('is false otherwise', () => {
    expect(isRestricted({ restricted_for: ['user-b'] }, 'user-a')).toBe(false);
    expect(isRestricted({}, 'user-a')).toBe(false);
    expect(isRestricted({ restricted_for: ['user-a'] }, null)).toBe(false);
  });
});

describe('groupSessions', () => {
  it('groups by session and orders newest first', () => {
    const sessions = groupSessions([
      set({ session_id: 'a', performed_at: '2026-08-01T10:00:00Z' }),
      set({ session_id: 'b', performed_at: '2026-08-08T10:00:00Z' }),
      set({ session_id: 'a', performed_at: '2026-08-01T10:30:00Z' }),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].sessionId).toBe('b');
    expect(sessions[1].sets).toHaveLength(2);
  });

  it('uses the earliest set as the session time', () => {
    const sessions = groupSessions([
      set({ session_id: 'a', performed_at: '2026-08-01T11:00:00Z' }),
      set({ session_id: 'a', performed_at: '2026-08-01T10:00:00Z' }),
    ]);
    expect(sessions[0].performedAt.toISOString()).toBe('2026-08-01T10:00:00.000Z');
  });
});
