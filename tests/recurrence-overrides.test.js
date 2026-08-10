/**
 * @vitest-environment jsdom
 *
 * Recurrence expansion — exdates and overrides (kiro-algorithm-spec.md §1.2)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn() },
  withAuthGuard: (operation) => operation(),
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-a' })),
  getPartner: vi.fn(() => ({ id: 'user-b' })),
}));

const { expandRecurrence } = await import('../js/calendar-module.js');

const rangeStart = new Date('2026-08-03T00:00:00Z');
const rangeEnd = new Date('2026-08-31T00:00:00Z');

/** Weekly Monday shift, 22:30 to 09:00 the next morning. */
const series = {
  id: 'series-1',
  user_id: 'user-a',
  title: 'AMXL night shift',
  start_time: '2026-08-03T21:30:00.000Z',
  end_time: '2026-08-04T08:00:00.000Z',
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  is_busy: true,
  exdates: [],
};

describe('expandRecurrence', () => {
  it('expands a weekly series across the range', () => {
    const instances = expandRecurrence([series], rangeStart, rangeEnd);
    expect(instances.length).toBeGreaterThanOrEqual(4);
    expect(instances.every(i => i._originalEventId === 'series-1')).toBe(true);
  });

  it('keeps the seed duration on every instance rather than re-deriving it', () => {
    // A 10.5 hour overnight shift must stay 10.5 hours on each occurrence.
    const instances = expandRecurrence([series], rangeStart, rangeEnd);
    for (const instance of instances) {
      const hours = (new Date(instance.end_time) - new Date(instance.start_time)) / 3600000;
      expect(hours).toBeCloseTo(10.5, 5);
    }
  });

  it('drops a cancelled instance listed in exdates', () => {
    const withExdate = { ...series, exdates: ['2026-08-10T21:30:00.000Z'] };
    const instances = expandRecurrence([withExdate], rangeStart, rangeEnd);
    expect(instances.some(i => i.start_time === '2026-08-10T21:30:00.000Z')).toBe(false);
  });

  it('keeps the other instances when one is cancelled', () => {
    const base = expandRecurrence([series], rangeStart, rangeEnd).length;
    const withExdate = { ...series, exdates: ['2026-08-10T21:30:00.000Z'] };
    expect(expandRecurrence([withExdate], rangeStart, rangeEnd)).toHaveLength(base - 1);
  });

  it('replaces a single instance with its override', () => {
    const override = {
      id: 'override-1',
      user_id: 'user-a',
      title: 'Shift swapped to earlies',
      start_time: '2026-08-10T06:00:00.000Z',
      end_time: '2026-08-10T14:30:00.000Z',
      override_of: 'series-1',
      original_start: '2026-08-10T21:30:00.000Z',
      is_busy: true,
    };

    const instances = expandRecurrence([series, override], rangeStart, rangeEnd);
    expect(instances.some(i => i.start_time === '2026-08-10T21:30:00.000Z')).toBe(false);
    expect(instances.some(i => i.id === 'override-1')).toBe(true);
  });

  it('does not disturb the weeks either side of an override', () => {
    const override = {
      id: 'override-1', user_id: 'user-a', title: 'Swapped',
      start_time: '2026-08-10T06:00:00.000Z', end_time: '2026-08-10T14:30:00.000Z',
      override_of: 'series-1', original_start: '2026-08-10T21:30:00.000Z', is_busy: true,
    };

    const base = expandRecurrence([series], rangeStart, rangeEnd).length;
    const withOverride = expandRecurrence([series, override], rangeStart, rangeEnd);
    expect(withOverride).toHaveLength(base);
    expect(withOverride.some(i => i.start_time === '2026-08-03T21:30:00.000Z')).toBe(true);
    expect(withOverride.some(i => i.start_time === '2026-08-17T21:30:00.000Z')).toBe(true);
  });

  it('never emits the override row as a series seed', () => {
    const override = {
      id: 'override-1', user_id: 'user-a', title: 'Swapped',
      start_time: '2026-08-10T06:00:00.000Z', end_time: '2026-08-10T14:30:00.000Z',
      override_of: 'series-1', original_start: '2026-08-10T21:30:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO', is_busy: true,
    };
    const instances = expandRecurrence([series, override], rangeStart, rangeEnd);
    // Even carrying an rrule, an override is one replacement, not a new series.
    expect(instances.filter(i => i.id === 'override-1')).toHaveLength(1);
  });

  it('passes a non-recurring event through untouched', () => {
    const single = {
      id: 'one-off', user_id: 'user-a', title: 'Physio',
      start_time: '2026-08-05T10:00:00.000Z', end_time: '2026-08-05T11:00:00.000Z',
      is_busy: true,
    };
    const instances = expandRecurrence([single], rangeStart, rangeEnd);
    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe('one-off');
  });

  it('survives an unparseable rule instead of throwing', () => {
    const broken = { ...series, rrule: 'THIS IS NOT AN RRULE' };
    const instances = expandRecurrence([broken], rangeStart, rangeEnd);
    expect(instances).toHaveLength(1);
  });
});
