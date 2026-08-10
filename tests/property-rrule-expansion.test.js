/**
 * Property-based test: RRULE expansion instance count
 * **Validates: Requirements 2.5**
 *
 * For any valid RRULE with a known number of occurrences within a date range,
 * expanding the recurrence must produce exactly that number of instances within the range.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { RRule } from 'rrule';

// Mock supabase-client and app-shell before importing calendar module
vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', name: 'Test' })),
  getPartner: vi.fn(() => ({ id: 'user-456', name: 'Partner' })),
}));

import { expandRecurrence } from '../js/calendar-module.js';

// --- Arbitraries ---

/** Generate a FREQ type (DAILY or WEEKLY for predictable count calculations) */
const freqArb = fc.constantFrom('DAILY', 'WEEKLY');

/** Generate a start date within a reasonable range (2024-2026) as a timestamp offset */
const startDateArb = fc.integer({
  min: new Date('2024-01-01T00:00:00Z').getTime(),
  max: new Date('2026-01-01T00:00:00Z').getTime(),
}).map(ts => {
  const d = new Date(ts);
  // Normalize to a fixed hour UTC to avoid DST edge cases
  d.setUTCHours(10, 0, 0, 0);
  return d;
});

/** Generate a range length in days (1–365) */
const rangeLengthArb = fc.integer({ min: 1, max: 365 });

/** Generate an event duration in minutes (15–120) */
const durationMinutesArb = fc.integer({ min: 15, max: 120 });

/** Generate a COUNT value for RRULE (1–100) */
const countArb = fc.integer({ min: 1, max: 100 });

describe('Property: RRULE expansion instance count', () => {
  it('RRULE with COUNT produces exactly min(COUNT, 365) instances when all fit in range', () => {
    fc.assert(
      fc.property(
        freqArb,
        startDateArb,
        rangeLengthArb,
        durationMinutesArb,
        countArb,
        (freq, startDate, rangeLengthDays, durationMin, count) => {
          // Build an RRULE with a specific COUNT
          const rruleStr = `FREQ=${freq};COUNT=${count}`;

          const eventStart = new Date(startDate);
          const eventEnd = new Date(eventStart.getTime() + durationMin * 60000);

          const event = {
            id: 'evt-test',
            title: 'Test Event',
            start_time: eventStart.toISOString(),
            end_time: eventEnd.toISOString(),
            rrule: rruleStr,
            user_id: 'user-123',
            is_busy: true,
          };

          // Make the range large enough to contain all possible occurrences
          // For DAILY with count up to 100, we need at most 100 days
          // For WEEKLY with count up to 100, we need at most 700 days
          const maxDaysNeeded = freq === 'DAILY' ? count : count * 7;
          const rangeEndOffset = Math.max(rangeLengthDays, maxDaysNeeded + 1);

          const rangeStart = new Date(eventStart.getTime() - 86400000); // 1 day before to include start
          const rangeEnd = new Date(eventStart.getTime() + rangeEndOffset * 86400000);

          const result = expandRecurrence([event], rangeStart, rangeEnd);

          // Independently compute expected count using rrule library
          const rule = RRule.fromString(
            `DTSTART:${formatRRuleDate(eventStart)}\nRRULE:${rruleStr}`
          );
          const expectedOccurrences = rule.between(rangeStart, rangeEnd, true);
          const expectedCount = Math.min(expectedOccurrences.length, 365);

          // The expanded instances must match the expected count
          expect(result.length).toBe(expectedCount);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('expanded instances never exceed the 365 cap', () => {
    fc.assert(
      fc.property(
        freqArb,
        startDateArb,
        durationMinutesArb,
        (freq, startDate, durationMin) => {
          // Use a large count or no count to potentially exceed cap
          const rruleStr = `FREQ=${freq}`;

          const eventStart = new Date(startDate);
          const eventEnd = new Date(eventStart.getTime() + durationMin * 60000);

          const event = {
            id: 'evt-cap-test',
            title: 'Cap Test',
            start_time: eventStart.toISOString(),
            end_time: eventEnd.toISOString(),
            rrule: rruleStr,
            user_id: 'user-123',
            is_busy: true,
          };

          // Very large range (3 years) to produce many instances
          const rangeStart = new Date(eventStart.getTime() - 86400000);
          const rangeEnd = new Date(eventStart.getTime() + 1100 * 86400000);

          const result = expandRecurrence([event], rangeStart, rangeEnd);

          // Must never exceed 365
          expect(result.length).toBeLessThanOrEqual(365);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('all expanded instances fall within the specified range', () => {
    fc.assert(
      fc.property(
        freqArb,
        startDateArb,
        rangeLengthArb,
        durationMinutesArb,
        countArb,
        (freq, startDate, rangeLengthDays, durationMin, count) => {
          const rruleStr = `FREQ=${freq};COUNT=${count}`;

          const eventStart = new Date(startDate);
          const eventEnd = new Date(eventStart.getTime() + durationMin * 60000);

          const event = {
            id: 'evt-range-test',
            title: 'Range Test',
            start_time: eventStart.toISOString(),
            end_time: eventEnd.toISOString(),
            rrule: rruleStr,
            user_id: 'user-123',
            is_busy: true,
          };

          const rangeStart = new Date(eventStart.getTime() - 86400000);
          const rangeEnd = new Date(rangeStart.getTime() + rangeLengthDays * 86400000);

          const result = expandRecurrence([event], rangeStart, rangeEnd);

          // Every instance's start_time must be within [rangeStart, rangeEnd)
          for (const instance of result) {
            const instanceStart = new Date(instance.start_time);
            expect(instanceStart.getTime()).toBeGreaterThanOrEqual(rangeStart.getTime());
            expect(instanceStart.getTime()).toBeLessThanOrEqual(rangeEnd.getTime());
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('each expanded instance preserves the original event duration', () => {
    fc.assert(
      fc.property(
        freqArb,
        startDateArb,
        rangeLengthArb,
        durationMinutesArb,
        countArb,
        (freq, startDate, rangeLengthDays, durationMin, count) => {
          const rruleStr = `FREQ=${freq};COUNT=${count}`;

          const eventStart = new Date(startDate);
          const eventEnd = new Date(eventStart.getTime() + durationMin * 60000);
          const expectedDurationMs = durationMin * 60000;

          const event = {
            id: 'evt-duration-test',
            title: 'Duration Test',
            start_time: eventStart.toISOString(),
            end_time: eventEnd.toISOString(),
            rrule: rruleStr,
            user_id: 'user-123',
            is_busy: true,
          };

          const rangeStart = new Date(eventStart.getTime() - 86400000);
          const rangeEnd = new Date(rangeStart.getTime() + rangeLengthDays * 86400000);

          const result = expandRecurrence([event], rangeStart, rangeEnd);

          // Every instance must have the same duration as the original event
          for (const instance of result) {
            const instanceStart = new Date(instance.start_time);
            const instanceEnd = new Date(instance.end_time);
            const actualDuration = instanceEnd.getTime() - instanceStart.getTime();
            expect(actualDuration).toBe(expectedDurationMs);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Helper ---

function formatRRuleDate(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const seconds = String(d.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}
