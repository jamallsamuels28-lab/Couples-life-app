/**
 * Property-based tests for the free windows engine.
 * **Validates: Requirements 3.1, 3.5**
 *
 * Replaces property-free-windows-{no-overlap,sorted,min-duration,waking-hours}.
 *
 * Those four files each ended their property with `if (!result.success) return;`
 * before asserting anything. Any change that made the function return an error
 * for every generated case — a signature change, for instance — left all four
 * passing while asserting nothing at all. The guard is gone here: a generated
 * scenario that fails validation is a bug in the generator, so it is asserted
 * against rather than skipped.
 *
 * The waking-hours property ("every window falls inside dayStartHour..dayEndHour")
 * has no successor because the invariant it encoded is the bug: availability is
 * derived from sleep and shift context now, not from a fixed band. Its
 * replacement is `no window overlaps a sleep block`.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { bothFreeWindows, materialiseSleep } from '../js/free-windows.js';

// --- Arbitraries ----------------------------------------------

const HHMM = fc.integer({ min: 0, max: 1439 }).map(
  m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
);

/** A shift pattern that is always open-ended, so exactly one row can match. */
const patternArb = fc.record({
  label: fc.constant('generated'),
  days_of_week: fc.uniqueArray(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 7 }),
  start_local: HHMM,
  end_local: HHMM,
  sleep_start: HHMM,
  sleep_end: HHMM,
  valid_from: fc.constant('2020-01-01'),
  valid_to: fc.constant(null),
}).filter(p => p.start_local !== p.end_local && p.sleep_start !== p.sleep_end);

const personArb = fc.record({
  patterns: fc.oneof(fc.constant([]), patternArb.map(p => [p])),
  sleepRules: fc.oneof(
    fc.constant([]),
    fc.record({
      context: fc.constant('default'),
      start_local: HHMM,
      end_local: HHMM,
    }).filter(r => r.start_local !== r.end_local).map(r => [r])
  ),
});

const scenarioArb = fc.tuple(
  fc.integer({
    min: new Date(2026, 0, 1).getTime(),
    max: new Date(2026, 10, 1).getTime(),
  }).map(ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d; }),
  fc.integer({ min: 1, max: 14 }),
  fc.integer({ min: 5, max: 480 }),
  personArb,
  personArb,
).chain(([rangeStart, days, minMinutes, personA, personB]) => {
  const rangeEndMs = rangeStart.getTime() + days * 86400000;

  const eventArb = fc.tuple(
    fc.integer({ min: rangeStart.getTime() - 86400000, max: rangeEndMs }),
    fc.integer({ min: 15 * 60000, max: 4 * 3600000 }),
    fc.boolean(),
  ).map(([startMs, durationMs, isBusy]) => ({
    start: new Date(startMs),
    end: new Date(startMs + durationMs),
    isBusy,
  }));

  return fc.tuple(
    fc.array(eventArb, { maxLength: 10 }),
    fc.array(eventArb, { maxLength: 10 }),
  ).map(([personAEvents, personBEvents]) => ({
    personAEvents, personBEvents, personA, personB,
    rangeStart,
    rangeEnd: new Date(rangeEndMs),
    options: { minMinutes },
  }));
});

const run = (scenario) => {
  const result = bothFreeWindows(scenario);
  // Every generated scenario is valid by construction. A failure here means the
  // generator drifted from the API, which is exactly what used to go unnoticed.
  expect(result.success).toBe(true);
  return result.windows;
};

// --- Properties -----------------------------------------------

describe('Property: free windows never overlap a busy event', () => {
  it('holds for arbitrary events from both partners', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const windows = run(scenario);
        const busy = [...scenario.personAEvents, ...scenario.personBEvents]
          .filter(e => e.isBusy);

        for (const w of windows) {
          for (const b of busy) {
            expect(w.start.getTime() < b.end.getTime() && b.start.getTime() < w.end.getTime())
              .toBe(false);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property: free windows never overlap sleep', () => {
  it('holds for arbitrary sleep patterns and rules', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const windows = run(scenario);

        for (const person of [scenario.personA, scenario.personB]) {
          const { blocks } = materialiseSleep({
            patterns: person.patterns,
            sleepRules: person.sleepRules,
            rangeStart: scenario.rangeStart,
            rangeEnd: scenario.rangeEnd,
          });
          for (const w of windows) {
            for (const b of blocks) {
              expect(w.start.getTime() < b.end && b.start < w.end.getTime()).toBe(false);
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property: windows are non-overlapping and within range', () => {
  it('holds for arbitrary scenarios', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const windows = run(scenario);
        const chronological = [...windows].sort((a, b) => a.start - b.start);

        for (const w of chronological) {
          expect(w.start.getTime()).toBeGreaterThanOrEqual(scenario.rangeStart.getTime());
          expect(w.end.getTime()).toBeLessThanOrEqual(scenario.rangeEnd.getTime());
          expect(w.end.getTime()).toBeGreaterThan(w.start.getTime());
        }
        for (let i = 1; i < chronological.length; i++) {
          expect(chronological[i].start.getTime())
            .toBeGreaterThanOrEqual(chronological[i - 1].end.getTime());
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property: every window meets the minimum duration', () => {
  it('holds for arbitrary minMinutes', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const windows = run(scenario);
        for (const w of windows) {
          expect(w.end.getTime() - w.start.getTime())
            .toBeGreaterThanOrEqual(scenario.options.minMinutes * 60000);
          expect(w.durationMinutes).toBeGreaterThanOrEqual(scenario.options.minMinutes);
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property: results are ranked by score', () => {
  it('returns windows in non-increasing score order', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const windows = run(scenario);
        for (let i = 1; i < windows.length; i++) {
          expect(windows[i - 1].score).toBeGreaterThanOrEqual(windows[i].score);
        }
      }),
      { numRuns: 100 }
    );
  });
});
