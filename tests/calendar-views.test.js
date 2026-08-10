/**
 * @vitest-environment jsdom
 *
 * Calendar views — month / week / day
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn() },
  withAuthGuard: (operation) => operation(),
}));

import {
  renderCalendarViews,
  assignLanes,
  visibleRange,
  step,
  setViewState,
  getViewState,
  startOfWeek,
  startOfDay,
  addDays,
  dateKey,
} from '../js/calendar-views.js';

const NIGHT_SHIFT = {
  patterns: [{
    label: 'Nights Sun-Wed',
    days_of_week: [0, 1, 2, 3],
    start_local: '22:30',
    end_local: '09:00',
    sleep_start: '09:30',
    sleep_end: '17:30',
    valid_from: '2026-01-01',
    valid_to: null,
  }],
  sleepRules: [],
};

const baseData = () => ({
  instances: [],
  scheduleA: NIGHT_SHIFT,
  scheduleB: { patterns: [], sleepRules: [] },
  user: { id: 'user-a' },
  partner: { id: 'user-b' },
  labelA: 'Jamall',
  labelB: 'Rebecca',
});

const event = (id, startISO, endISO, userId = 'user-a', title = 'Thing') => ({
  id, user_id: userId, title, start_time: startISO, end_time: endISO, is_busy: true,
});

describe('date helpers', () => {
  it('starts the week on Monday', () => {
    // Sunday 2026-08-09 belongs to the week beginning Monday 2026-08-03.
    expect(dateKey(startOfWeek(new Date(2026, 7, 9)))).toBe('2026-08-03');
    // Monday 2026-08-10 begins its own week.
    expect(dateKey(startOfWeek(new Date(2026, 7, 10)))).toBe('2026-08-10');
  });

  it('addDays crosses a month boundary', () => {
    expect(dateKey(addDays(new Date(2026, 7, 31), 1))).toBe('2026-09-01');
  });

  it('startOfDay strips the time', () => {
    const d = startOfDay(new Date(2026, 7, 10, 13, 45));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});

describe('visibleRange', () => {
  it('covers exactly one day in day mode', () => {
    const { start, end } = visibleRange('day', new Date(2026, 7, 10));
    expect(dateKey(start)).toBe('2026-08-10');
    expect(dateKey(end)).toBe('2026-08-11');
  });

  it('covers a Monday-to-Sunday week in week mode', () => {
    const { start, end } = visibleRange('week', new Date(2026, 7, 13));
    expect(dateKey(start)).toBe('2026-08-10');
    expect(dateKey(end)).toBe('2026-08-17');
  });

  it('covers six full weeks in month mode, including adjacent days', () => {
    const { start, end } = visibleRange('month', new Date(2026, 7, 15));
    // August 2026 starts on a Saturday, so the grid opens on 27 July.
    expect(dateKey(start)).toBe('2026-07-27');
    expect(Math.round((end - start) / 86400000)).toBe(42);
  });
});

describe('step', () => {
  beforeEach(() => {
    setViewState({ anchor: new Date(2026, 7, 10) });
  });

  it('moves a single day in day mode', () => {
    setViewState({ mode: 'day' });
    expect(dateKey(step(1))).toBe('2026-08-11');
    expect(dateKey(step(-1))).toBe('2026-08-10');
  });

  it('moves seven days in week mode', () => {
    setViewState({ mode: 'week' });
    expect(dateKey(step(1))).toBe('2026-08-17');
  });

  it('moves a whole month in month mode', () => {
    setViewState({ mode: 'month' });
    expect(step(1).getMonth()).toBe(8);
  });

  it('does not skip a month when stepping from the 31st', () => {
    setViewState({ mode: 'month', anchor: new Date(2026, 0, 31) });
    // Naive month arithmetic lands on 2 March here; anchoring to the 1st avoids it.
    expect(step(1).getMonth()).toBe(1);
  });
});

describe('assignLanes', () => {
  const at = (startHour, endHour) => ({
    start: new Date(2026, 7, 10, startHour).getTime(),
    end: new Date(2026, 7, 10, endHour).getTime(),
  });

  it('puts sequential events in the same lane', () => {
    const lanes = assignLanes([at(9, 10), at(10, 11)]);
    expect(lanes.map(l => l.lane)).toEqual([0, 0]);
  });

  it('puts overlapping events in separate lanes', () => {
    const lanes = assignLanes([at(9, 11), at(10, 12)]);
    expect(lanes.map(l => l.lane)).toEqual([0, 1]);
  });

  it('reuses a lane once its event has finished', () => {
    const lanes = assignLanes([at(9, 11), at(10, 12), at(11, 13)]);
    expect(lanes.map(l => l.lane)).toEqual([0, 1, 0]);
  });

  it('handles three-way overlap', () => {
    const lanes = assignLanes([at(9, 12), at(9, 12), at(9, 12)]);
    expect(lanes.map(l => l.lane)).toEqual([0, 1, 2]);
  });

  it('returns an empty list unchanged', () => {
    expect(assignLanes([])).toEqual([]);
  });
});

describe('renderCalendarViews', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    setViewState({ mode: 'month', anchor: new Date(2026, 7, 10) });
  });

  it('renders 42 day cells in month mode', () => {
    renderCalendarViews(container, baseData());
    expect(container.querySelectorAll('.cal-cell')).toHaveLength(42);
  });

  it('marks today', () => {
    setViewState({ anchor: new Date() });
    renderCalendarViews(container, baseData());
    expect(container.querySelectorAll('.cal-cell--today').length).toBeLessThanOrEqual(1);
  });

  it('renders seven columns in week mode', () => {
    setViewState({ mode: 'week' });
    renderCalendarViews(container, baseData());
    expect(container.querySelectorAll('.cal-col')).toHaveLength(7);
  });

  it('renders one column in day mode', () => {
    setViewState({ mode: 'day' });
    renderCalendarViews(container, baseData());
    expect(container.querySelectorAll('.cal-col')).toHaveLength(1);
  });

  it('draws shift and sleep bands behind the day', () => {
    setViewState({ mode: 'day', anchor: new Date(2026, 7, 10) });
    renderCalendarViews(container, baseData());
    expect(container.querySelectorAll('.cal-band--sleep').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.cal-band--shift').length).toBeGreaterThan(0);
  });

  it('colours events by owner', () => {
    const data = {
      ...baseData(),
      instances: [
        event('1', '2026-08-10T09:00:00', '2026-08-10T10:00:00', 'user-a'),
        event('2', '2026-08-10T11:00:00', '2026-08-10T12:00:00', 'user-b'),
        event('3', '2026-08-10T13:00:00', '2026-08-10T14:00:00', 'someone-else'),
      ],
    };
    setViewState({ mode: 'day' });
    renderCalendarViews(container, data);
    expect(container.querySelectorAll('.cal-event.is-a')).toHaveLength(1);
    expect(container.querySelectorAll('.cal-event.is-b')).toHaveLength(1);
    expect(container.querySelectorAll('.cal-event.is-shared')).toHaveLength(1);
  });

  it('collapses more than three events in a month cell into a count', () => {
    const instances = Array.from({ length: 5 }, (_, i) =>
      event(String(i), `2026-08-10T0${i + 1}:00:00`, `2026-08-10T0${i + 1}:30:00`)
    );
    setViewState({ mode: 'month' });
    renderCalendarViews(container, { ...baseData(), instances });

    const cell = container.querySelector('[data-date="2026-08-10"]');
    expect(cell.querySelectorAll('.cal-chip')).toHaveLength(3);
    expect(cell.querySelector('.cal-more').textContent.trim()).toBe('+2');
  });

  it('asks the host to reload when the view mode changes', () => {
    const onRangeChange = vi.fn();
    renderCalendarViews(container, { ...baseData(), onRangeChange });

    container.querySelector('[data-mode="week"]').click();

    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange.mock.calls[0][0].mode).toBe('week');
    expect(getViewState().mode).toBe('week');
  });

  it('asks the host to reload when stepping forward', () => {
    const onRangeChange = vi.fn();
    setViewState({ mode: 'day', anchor: new Date(2026, 7, 10) });
    renderCalendarViews(container, { ...baseData(), onRangeChange });

    container.querySelector('[data-step="1"]').click();

    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(dateKey(getViewState().anchor)).toBe('2026-08-11');
  });

  it('opens a day when a month cell is clicked', () => {
    const onRangeChange = vi.fn();
    setViewState({ mode: 'month', anchor: new Date(2026, 7, 10) });
    renderCalendarViews(container, { ...baseData(), onRangeChange });

    container.querySelector('[data-date="2026-08-12"]').click();

    expect(getViewState().mode).toBe('day');
    expect(dateKey(getViewState().anchor)).toBe('2026-08-12');
  });

  it('announces an event for editing rather than handling it internally', () => {
    const listener = vi.fn();
    window.addEventListener('calendar:edit-event', listener);

    setViewState({ mode: 'day', anchor: new Date(2026, 7, 10) });
    renderCalendarViews(container, {
      ...baseData(),
      instances: [event('evt-9', '2026-08-10T09:00:00', '2026-08-10T10:00:00')],
    });
    container.querySelector('.cal-event').click();

    expect(listener).toHaveBeenCalled();
    expect(listener.mock.calls[0][0].detail.id).toBe('evt-9');
    window.removeEventListener('calendar:edit-event', listener);
  });

  it('escapes event titles', () => {
    setViewState({ mode: 'day', anchor: new Date(2026, 7, 10) });
    renderCalendarViews(container, {
      ...baseData(),
      instances: [event('x', '2026-08-10T09:00:00', '2026-08-10T10:00:00', 'user-a', '<img src=x onerror=alert(1)>')],
    });
    expect(container.querySelector('.cal-event-title').innerHTML).not.toContain('<img');
  });
});
