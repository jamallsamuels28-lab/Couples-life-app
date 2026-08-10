/**
 * @vitest-environment jsdom
 */
/**
 * Property-based test: Partner comparison correctness
 * **Validates: Requirements 5.3**
 *
 * The Steps_Module SHALL display comparative statistics for the current day
 * and current week consisting of each partner's total step count and an
 * indicator identifying which partner has the higher total.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';

// Mock supabase-client and app-shell before importing steps module
vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', display_name: 'Test' })),
  getPartner: vi.fn(() => ({ id: 'user-456', display_name: 'Partner' })),
}));

import { getComparativeStats, getISOWeekBounds } from '../js/steps-module.js';

// --- Helpers ---

/** Format a Date to YYYY-MM-DD */
function toDateStr(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Get all dates (YYYY-MM-DD) within the ISO week (Mon-Sun) for a reference date */
function getDatesInISOWeek(refDate) {
  const { weekStart, weekEnd } = getISOWeekBounds(refDate);
  const dates = [];
  const current = new Date(weekStart + 'T00:00:00');
  const end = new Date(weekEnd + 'T00:00:00');
  while (current <= end) {
    dates.push(toDateStr(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// --- Arbitraries ---

/** Generate a non-negative step count (0–200,000) */
const stepsArb = fc.integer({ min: 0, max: 200000 });

/** Generate a date string within a broad range around today */
const dateArb = fc.integer({ min: -30, max: 30 }).map(offset => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toDateStr(d);
});

/** Generate a single stepsData entry */
const entryArb = fc.record({
  date: dateArb,
  userSteps: stepsArb,
  partnerSteps: stepsArb,
});

/** Generate an array of stepsData entries with unique dates */
const stepsDataArb = fc.uniqueArray(entryArb, {
  comparator: (a, b) => a.date === b.date,
  minLength: 0,
  maxLength: 60,
});

describe('Property 16: Partner comparison correctness', () => {
  it('leader is "user" when userTotal > partnerTotal (daily and weekly)', () => {
    const today = toDateStr(new Date());

    fc.assert(
      fc.property(stepsDataArb, (stepsData) => {
        const stats = getComparativeStats(stepsData);

        // Daily check
        if (stats.daily.userTotal > stats.daily.partnerTotal) {
          expect(stats.daily.leader).toBe('user');
        }

        // Weekly check
        if (stats.weekly.userTotal > stats.weekly.partnerTotal) {
          expect(stats.weekly.leader).toBe('user');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('leader is "partner" when partnerTotal > userTotal (daily and weekly)', () => {
    fc.assert(
      fc.property(stepsDataArb, (stepsData) => {
        const stats = getComparativeStats(stepsData);

        // Daily check
        if (stats.daily.partnerTotal > stats.daily.userTotal) {
          expect(stats.daily.leader).toBe('partner');
        }

        // Weekly check
        if (stats.weekly.partnerTotal > stats.weekly.userTotal) {
          expect(stats.weekly.leader).toBe('partner');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('leader is "tied" when userTotal === partnerTotal (daily and weekly)', () => {
    fc.assert(
      fc.property(stepsDataArb, (stepsData) => {
        const stats = getComparativeStats(stepsData);

        // Daily check
        if (stats.daily.userTotal === stats.daily.partnerTotal) {
          expect(stats.daily.leader).toBe('tied');
        }

        // Weekly check
        if (stats.weekly.userTotal === stats.weekly.partnerTotal) {
          expect(stats.weekly.leader).toBe('tied');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('weekly total equals sum of steps for dates within current ISO week only', () => {
    const now = new Date();
    const { weekStart, weekEnd } = getISOWeekBounds(now);

    fc.assert(
      fc.property(stepsDataArb, (stepsData) => {
        const stats = getComparativeStats(stepsData);

        // Manually compute expected weekly totals
        let expectedUserWeekly = 0;
        let expectedPartnerWeekly = 0;
        for (const entry of stepsData) {
          if (entry.date >= weekStart && entry.date <= weekEnd) {
            expectedUserWeekly += entry.userSteps;
            expectedPartnerWeekly += entry.partnerSteps;
          }
        }

        expect(stats.weekly.userTotal).toBe(expectedUserWeekly);
        expect(stats.weekly.partnerTotal).toBe(expectedPartnerWeekly);
      }),
      { numRuns: 100 }
    );
  });

  it('daily total matches exactly today\'s entry (or 0 if no entry for today)', () => {
    const today = toDateStr(new Date());

    fc.assert(
      fc.property(stepsDataArb, (stepsData) => {
        const stats = getComparativeStats(stepsData);

        // Find today's entry in the data
        const todayEntry = stepsData.find(e => e.date === today);
        const expectedUserDaily = todayEntry ? todayEntry.userSteps : 0;
        const expectedPartnerDaily = todayEntry ? todayEntry.partnerSteps : 0;

        expect(stats.daily.userTotal).toBe(expectedUserDaily);
        expect(stats.daily.partnerTotal).toBe(expectedPartnerDaily);
      }),
      { numRuns: 100 }
    );
  });
});
