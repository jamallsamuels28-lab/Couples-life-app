/**
 * Shift patterns & sleep rules — kiro-algorithm-spec.md §1.1, §1.1b
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const supabaseMock = { from: vi.fn() };
vi.mock('../js/supabase-client.js', () => ({
  supabase: supabaseMock,
  withAuthGuard: (operation) => operation(),
}));

const {
  validatePattern,
  previousDay,
  personSchedule,
  supersedePattern,
  DAY_NAMES,
} = await import('../js/schedule-patterns.js');

const validPattern = {
  label: 'Nights Sun-Wed',
  days_of_week: [0, 1, 2, 3],
  start_local: '22:30',
  end_local: '09:00',
  sleep_start: '09:30',
  sleep_end: '17:30',
  valid_from: '2026-01-01',
};

describe('DAY_NAMES', () => {
  it('is Sunday-first to match days_of_week', () => {
    expect(DAY_NAMES[0]).toBe('Sun');
    expect(DAY_NAMES[6]).toBe('Sat');
  });
});

describe('validatePattern', () => {
  it('accepts a complete pattern', () => {
    expect(validatePattern(validPattern).valid).toBe(true);
  });

  it('accepts an overnight shift, where the end is before the start', () => {
    const result = validatePattern({ ...validPattern, start_local: '22:30', end_local: '06:00' });
    expect(result.valid).toBe(true);
  });

  it('accepts a pattern with no sleep window', () => {
    const result = validatePattern({ ...validPattern, sleep_start: null, sleep_end: null });
    expect(result.valid).toBe(true);
  });

  it('rejects a half-specified sleep window', () => {
    const result = validatePattern({ ...validPattern, sleep_end: null });
    expect(result.valid).toBe(false);
    expect(result.errors.sleep_start).toBeTruthy();
  });

  it('rejects an empty label', () => {
    expect(validatePattern({ ...validPattern, label: '   ' }).errors.label).toBeTruthy();
  });

  it('rejects no working days', () => {
    expect(validatePattern({ ...validPattern, days_of_week: [] }).errors.days_of_week).toBeTruthy();
  });

  it('rejects a day index outside 0–6', () => {
    expect(validatePattern({ ...validPattern, days_of_week: [7] }).errors.days_of_week).toBeTruthy();
  });

  it('rejects identical start and end times', () => {
    const result = validatePattern({ ...validPattern, start_local: '09:00', end_local: '09:00' });
    expect(result.errors.end_local).toBeTruthy();
  });

  it('rejects a malformed time', () => {
    expect(validatePattern({ ...validPattern, start_local: '25:00' }).errors.start_local).toBeTruthy();
  });

  it('rejects a missing valid_from', () => {
    expect(validatePattern({ ...validPattern, valid_from: '' }).errors.valid_from).toBeTruthy();
  });
});

describe('previousDay', () => {
  it('steps back one day', () => {
    expect(previousDay('2026-08-10')).toBe('2026-08-09');
  });

  it('steps back across a month boundary', () => {
    expect(previousDay('2026-08-01')).toBe('2026-07-31');
  });

  it('steps back across a year boundary', () => {
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(previousDay('2028-03-01')).toBe('2028-02-29');
  });

  it('returns null for nonsense', () => {
    expect(previousDay('not-a-date')).toBeNull();
    expect(previousDay(null)).toBeNull();
  });
});

describe('personSchedule', () => {
  const patterns = [{ user_id: 'a' }, { user_id: 'b' }];
  const rules = [{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'b' }];

  it('splits rows by owner', () => {
    const result = personSchedule(patterns, rules, 'a');
    expect(result.patterns).toHaveLength(1);
    expect(result.sleepRules).toHaveLength(2);
  });

  it('returns empty collections for a missing user', () => {
    expect(personSchedule(patterns, rules, null)).toEqual({ patterns: [], sleepRules: [] });
  });
});

describe('supersedePattern', () => {
  beforeEach(() => {
    supabaseMock.from.mockReset();
  });

  /** Minimal chainable stub for update().eq().eq() and insert().select().single(). */
  function stubTable({ updateError = null, insertError = null } = {}) {
    const calls = { updates: [], inserts: [] };
    supabaseMock.from.mockImplementation(() => ({
      update: (values) => {
        calls.updates.push(values);
        const chain = { eq: () => chain, then: undefined, error: updateError };
        // Await-able terminal: .eq().eq() resolves to { error }
        chain.eq = () => ({ eq: () => Promise.resolve({ error: updateError }), ...chain });
        return chain;
      },
      insert: (values) => {
        calls.inserts.push(values);
        return {
          select: () => ({
            single: () => Promise.resolve({
              data: insertError ? null : { id: 'new-id', ...values },
              error: insertError,
            }),
          }),
        };
      },
    }));
    return calls;
  }

  it('closes the old pattern the day before the new one starts', async () => {
    const calls = stubTable();
    const result = await supersedePattern('old-id', validPattern, '2026-09-01', 'user-a');

    expect(result.success).toBe(true);
    // Never updates the pattern in place — only sets valid_to on the old row.
    expect(calls.updates).toEqual([{ valid_to: '2026-08-31' }]);
    expect(calls.inserts[0].valid_from).toBe('2026-09-01');
    expect(calls.inserts[0].valid_to).toBeNull();
  });

  it('rejects an invalid pattern before touching the database', async () => {
    const calls = stubTable();
    const result = await supersedePattern('old-id', { ...validPattern, label: '' }, '2026-09-01', 'user-a');

    expect(result.success).toBe(false);
    expect(calls.updates).toHaveLength(0);
    expect(calls.inserts).toHaveLength(0);
  });

  it('rejects an unparseable effective date', async () => {
    stubTable();
    const result = await supersedePattern('old-id', validPattern, 'soon', 'user-a');
    expect(result.success).toBe(false);
  });

  it('reopens the old pattern if the insert fails, so no gap is left', async () => {
    const calls = stubTable({ insertError: { message: 'boom' } });
    const result = await supersedePattern('old-id', validPattern, '2026-09-01', 'user-a');

    expect(result.success).toBe(false);
    // First closes, then rolls the closure back.
    expect(calls.updates).toEqual([{ valid_to: '2026-08-31' }, { valid_to: null }]);
  });

  it('explains an overlap rejection in plain English', async () => {
    const calls = stubTable({ insertError: { message: 'Overlapping shift pattern for this user' } });
    const result = await supersedePattern('old-id', validPattern, '2026-09-01', 'user-a');

    expect(result.success).toBe(false);
    expect(result.errors._form).toMatch(/overlaps/i);
    expect(calls.updates).toHaveLength(2);
  });
});
