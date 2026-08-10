/**
 * @vitest-environment jsdom
 *
 * Property-based test: Streak calculation invariants
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
 *
 * For any step log history and positive goal value:
 * (a) currentStreak <= longestStreak
 * (b) if currentStreak > 0, then today or yesterday has a step count >= goal
 * (c) both values are non-negative integers
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock supabase-client and app-shell before importing steps module
vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', name: 'Test' })),
  getPartner: vi.fn(() => ({ id: 'user-456', name: 'Partner' })),
}));

import { calculateStreak } from '../js/steps-module.js';

// --- Arbitraries ---

/**
 * Generate a date string (YYYY-MM-DD) within the last N days from today.
 * We use a window of up to 365 days in the past to create realistic logs.
 */
function dateArb(maxDaysBack = 365) {
  return fc.integer({ min: 0, max: maxDaysBack }).map(daysBack => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - daysBack);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  });
}

/**
 * Generate a step count (0 to 200,000).
 */
const stepCountArb = fc.integer({ min: 0, max: 200000 });

/**
 * Generate a positive goal value (1 to 200,000).
 */
const goalArb = fc.integer({ min: 1, max: 200000 });

/**
 * Generate a step log entry: { log_date, step_count }.
 */
const stepLogEntryArb = fc.tuple(dateArb(), stepCountArb).map(([log_date, step_count]) => ({
  log_date,
  step_count,
}));

/**
 * Generate an array of step log entries, deduplicated by date and sorted descending.
 * This matches the expected input format for calculateStreak.
 */
const stepsLogArb = fc.array(stepLogEntryArb, { minLength: 0, maxLength: 60 }).map(entries => {
  // Deduplicate by date (keep first occurrence, simulating upsert behavior)
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    if (!seen.has(entry.log_date)) {
      seen.add(entry.log_date);
      deduped.push(entry);
    }
  }
  // Sort by log_date descending
  deduped.sort((a, b) => b.log_date.localeCompare(a.log_date));
  return deduped;
});

// --- Property Tests ---

describe('Property: Streak calculation invariants', () => {
  it('currentStreak is always less than or equal to longestStreak', () => {
    fc.assert(
      fc.property(stepsLogArb, goalArb, (stepsLog, goal) => {
        const result = calculateStreak(stepsLog, goal);
        expect(result.currentStreak).toBeLessThanOrEqual(result.longestStreak);
      }),
      { numRuns: 100 }
    );
  });

  it('if currentStreak > 0, then today or yesterday has step_count >= goal', () => {
    fc.assert(
      fc.property(stepsLogArb, goalArb, (stepsLog, goal) => {
        const result = calculateStreak(stepsLog, goal);

        if (result.currentStreak > 0) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const yesterday = new Date(today.getTime() - 86400000);

          const todayStr = formatDate(today);
          const yesterdayStr = formatDate(yesterday);

          // Find entries for today or yesterday that meet the goal
          const recentGoalMet = stepsLog.some(
            entry =>
              (entry.log_date === todayStr || entry.log_date === yesterdayStr) &&
              entry.step_count >= goal
          );

          expect(recentGoalMet).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('both currentStreak and longestStreak are non-negative integers', () => {
    fc.assert(
      fc.property(stepsLogArb, goalArb, (stepsLog, goal) => {
        const result = calculateStreak(stepsLog, goal);

        // Non-negative
        expect(result.currentStreak).toBeGreaterThanOrEqual(0);
        expect(result.longestStreak).toBeGreaterThanOrEqual(0);

        // Integer
        expect(Number.isInteger(result.currentStreak)).toBe(true);
        expect(Number.isInteger(result.longestStreak)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// --- Helpers ---

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
