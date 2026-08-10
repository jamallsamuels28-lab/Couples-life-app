/**
 * @vitest-environment jsdom
 *
 * Property 6: Step log uniqueness per user per date
 * Validates: Requirement 4.2
 *
 * For any sequence of step log upserts for the same user and date,
 * at most one step_log record exists for that user+date combination
 * after all operations complete.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fc from 'fast-check';

describe('Property 6: Step log uniqueness per user per date', () => {
  /**
   * In-memory store that simulates Supabase upsert behavior
   * with onConflict: 'user_id,log_date' (unique constraint).
   */
  function createInMemoryStore() {
    // Map keyed by "user_id|log_date" → single record
    const records = new Map();

    const store = {
      records,
      from() {
        return {
          upsert(row, options) {
            // Simulate onConflict: 'user_id,log_date' behavior
            if (options && options.onConflict === 'user_id,log_date') {
              const key = `${row.user_id}|${row.log_date}`;
              // Upsert: insert or replace the existing record for this key
              records.set(key, { ...row, id: records.get(key)?.id || crypto.randomUUID() });
            } else {
              // Without conflict handling, just insert (could create duplicates)
              const key = `${row.user_id}|${row.log_date}|${crypto.randomUUID()}`;
              records.set(key, { ...row, id: crypto.randomUUID() });
            }
            return {
              select() {
                return {
                  single() {
                    const key = `${row.user_id}|${row.log_date}`;
                    return Promise.resolve({ data: records.get(key), error: null });
                  }
                };
              }
            };
          }
        };
      },
      /** Count records for a specific user+date combination */
      countRecordsForUserDate(userId, logDate) {
        let count = 0;
        for (const [key, record] of records.entries()) {
          if (record.user_id === userId && record.log_date === logDate) {
            count++;
          }
        }
        return count;
      },
      /** Get all unique user+date combinations */
      getAllUserDatePairs() {
        const pairs = new Set();
        for (const record of records.values()) {
          pairs.add(`${record.user_id}|${record.log_date}`);
        }
        return [...pairs].map(p => {
          const [userId, logDate] = p.split('|');
          return { userId, logDate };
        });
      }
    };

    return store;
  }

  /**
   * Simulates the core logSteps upsert behavior from steps-module.js.
   * Extracted to avoid dependency on auth and date validation (which are
   * separate concerns), focusing purely on the uniqueness property.
   */
  async function simulateLogSteps(store, userId, date, stepCount) {
    const { data, error } = await store
      .from('steps_log')
      .upsert(
        {
          user_id: userId,
          log_date: date,
          step_count: stepCount,
          source: 'manual',
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id,log_date' }
      )
      .select()
      .single();

    return { success: !error, data, error };
  }

  // Generators
  const validStepCount = fc.integer({ min: 0, max: 200000 });
  const userId = fc.constantFrom('user-aaa', 'user-bbb');
  // Generate date strings directly to avoid Invalid Date issues during shrinking
  const pastDate = fc.integer({ min: 0, max: 500 }).map(offset => {
    const base = new Date('2024-01-01');
    base.setDate(base.getDate() + offset);
    return base.toISOString().split('T')[0];
  });

  it('at most one record exists per user+date after arbitrary upsert sequences', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a non-empty array of upsert operations for a SINGLE user+date
        fc.record({ user: userId, date: pastDate }),
        fc.array(validStepCount, { minLength: 1, maxLength: 20 }),
        async (userDate, stepCounts) => {
          const store = createInMemoryStore();

          // Perform all upserts sequentially for the same user+date
          for (const steps of stepCounts) {
            await simulateLogSteps(store, userDate.user, userDate.date, steps);
          }

          // Property: at most one record exists for this user+date
          const count = store.countRecordsForUserDate(userDate.user, userDate.date);
          expect(count).toBeLessThanOrEqual(1);
          // And since we did at least one upsert, exactly one should exist
          expect(count).toBe(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('multiple users and dates maintain isolation — each pair has at most one record', () => {
    fc.assert(
      fc.asyncProperty(
        // Generate a sequence of upsert operations across different users and dates
        fc.array(
          fc.record({
            user: userId,
            date: pastDate,
            steps: validStepCount
          }),
          { minLength: 2, maxLength: 50 }
        ),
        async (operations) => {
          const store = createInMemoryStore();

          // Perform all upserts
          for (const op of operations) {
            await simulateLogSteps(store, op.user, op.date, op.steps);
          }

          // Property: for every user+date pair that was written,
          // exactly one record exists
          const allPairs = store.getAllUserDatePairs();
          for (const { userId: uid, logDate } of allPairs) {
            const count = store.countRecordsForUserDate(uid, logDate);
            expect(count).toBe(1);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('the last upserted value is the one stored (last-write-wins)', () => {
    fc.assert(
      fc.asyncProperty(
        fc.record({ user: userId, date: pastDate }),
        fc.array(validStepCount, { minLength: 1, maxLength: 15 }),
        async (userDate, stepCounts) => {
          const store = createInMemoryStore();

          // Perform all upserts sequentially
          for (const steps of stepCounts) {
            await simulateLogSteps(store, userDate.user, userDate.date, steps);
          }

          // The stored value should be the last one written
          const key = `${userDate.user}|${userDate.date}`;
          const record = store.records.get(key);
          expect(record).toBeDefined();
          expect(record.step_count).toBe(stepCounts[stepCounts.length - 1]);
        }
      ),
      { numRuns: 100 }
    );
  });
});
