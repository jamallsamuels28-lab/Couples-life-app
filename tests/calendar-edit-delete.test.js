/**
 * @vitest-environment jsdom
 *
 * Calendar editing and deletion.
 *
 * updateEvent() and deleteEvent() were written, exported, and never called by
 * anything — there were no controls to call them from, so an event could be
 * created and then never changed or removed. These cover the paths that were
 * missing, and in particular the single-occurrence ones: the schema has
 * carried `exdates` and `override_of` since migration 0004, but nothing ever
 * wrote either, so "just this Tuesday" could not be expressed at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const supabaseMock = { from: vi.fn() };
vi.mock('../js/supabase-client.js', () => ({
  supabase: supabaseMock,
  withAuthGuard: (operation) => operation(),
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-a' })),
  getPartner: vi.fn(() => ({ id: 'user-b' })),
}));

const {
  cancelOccurrence,
  updateOccurrence,
  renderEventList,
  beginEditingEvent,
  stopEditingEvent,
  getEditingContext,
  renderEventForm,
  expandRecurrence,
} = await import('../js/calendar-module.js');

const user = { id: 'user-a' };
const partner = { id: 'user-b' };

/** One instance of a weekly series, as expandRecurrence emits it. */
const occurrence = {
  id: 'series-1',
  user_id: 'user-a',
  title: 'Gym',
  start_time: '2026-08-17T18:00:00.000Z',
  end_time: '2026-08-17T19:00:00.000Z',
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  _isRecurrenceInstance: true,
  _originalEventId: 'series-1',
  _originalStart: '2026-08-17T18:00:00.000Z',
};

beforeEach(() => {
  supabaseMock.from.mockReset();
  document.body.innerHTML = '';
});

describe('cancelOccurrence', () => {
  function stubSeries(exdates, { updateError = null } = {}) {
    const updates = [];
    supabaseMock.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ single: async () => ({ data: { exdates }, error: null }) }),
      }),
      update: (payload) => {
        updates.push(payload);
        return { eq: async () => ({ error: updateError }) };
      },
    }));
    return updates;
  }

  it('adds the occurrence to exdates rather than deleting the series', async () => {
    const updates = stubSeries([]);
    const result = await cancelOccurrence('series-1', '2026-08-17T18:00:00.000Z');

    expect(result.success).toBe(true);
    expect(updates[0].exdates).toEqual(['2026-08-17T18:00:00.000Z']);
  });

  it('keeps exdates already recorded', async () => {
    const updates = stubSeries(['2026-08-10T18:00:00.000Z']);
    await cancelOccurrence('series-1', '2026-08-17T18:00:00.000Z');

    expect(updates[0].exdates).toHaveLength(2);
    expect(updates[0].exdates).toContain('2026-08-10T18:00:00.000Z');
  });

  it('treats a repeat cancellation as success without writing again', async () => {
    const updates = stubSeries(['2026-08-17T18:00:00.000Z']);
    const result = await cancelOccurrence('series-1', '2026-08-17T18:00:00.000Z');

    expect(result.success).toBe(true);
    expect(result.alreadyCancelled).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('refuses without an occurrence to cancel', async () => {
    const result = await cancelOccurrence('series-1', null);
    expect(result.success).toBe(false);
    expect(supabaseMock.from).not.toHaveBeenCalled();
  });

  it('surfaces a write failure', async () => {
    stubSeries([], { updateError: { message: 'boom' } });
    const result = await cancelOccurrence('series-1', '2026-08-17T18:00:00.000Z');
    expect(result.success).toBe(false);
  });

  it('actually removes the instance from the expansion', async () => {
    // The point of the exdate: expandRecurrence must stop emitting that date.
    const series = {
      id: 'series-1',
      user_id: 'user-a',
      title: 'Gym',
      start_time: '2026-08-03T18:00:00.000Z',
      end_time: '2026-08-03T19:00:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      exdates: ['2026-08-17T18:00:00.000Z'],
    };

    const instances = expandRecurrence(
      [series], new Date('2026-08-03T00:00:00Z'), new Date('2026-08-31T00:00:00Z')
    );

    const starts = instances.map(i => i.start_time);
    expect(starts).not.toContain('2026-08-17T18:00:00.000Z');
    expect(starts.length).toBeGreaterThan(0);
  });
});

describe('updateOccurrence', () => {
  function stubInsert() {
    const rows = [];
    supabaseMock.from.mockImplementation(() => ({
      insert: (row) => {
        rows.push(row);
        return { select: () => ({ single: async () => ({ data: { ...row, id: 'o1' }, error: null }) }) };
      },
    }));
    return rows;
  }

  it('writes an override row pointing back at the series', async () => {
    const rows = stubInsert();
    await updateOccurrence(occurrence, {
      title: 'Gym (late)',
      start_time: '2026-08-17T19:30:00.000Z',
      end_time: '2026-08-17T20:30:00.000Z',
    });

    expect(rows[0].override_of).toBe('series-1');
    expect(rows[0].original_start).toBe('2026-08-17T18:00:00.000Z');
    expect(rows[0].title).toBe('Gym (late)');
  });

  it('does not copy the series rrule onto the override', async () => {
    // Carrying it would expand the override into a second weekly series.
    const rows = stubInsert();
    await updateOccurrence(occurrence, { title: 'Gym (late)' });
    expect(rows[0].rrule).toBeNull();
  });

  it('leaves the series row untouched', async () => {
    // Editing the series directly would move every past occurrence too.
    const rows = stubInsert();
    await updateOccurrence(occurrence, { title: 'Gym (late)' });
    expect(rows.every(r => r.override_of === 'series-1')).toBe(true);
    expect(rows.some(r => r.id === 'series-1')).toBe(false);
  });

  it('rejects an end before its start without writing', async () => {
    const rows = stubInsert();
    const result = await updateOccurrence(occurrence, {
      start_time: '2026-08-17T20:00:00.000Z',
      end_time: '2026-08-17T19:00:00.000Z',
    });

    expect(result.success).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it('refuses an instance with no series to attach to', async () => {
    const result = await updateOccurrence({ id: 'x', title: 'One-off' }, { title: 'y' });
    expect(result.success).toBe(false);
  });

  it('replaces the original instance in the expansion, not adds to it', async () => {
    const series = {
      id: 'series-1', user_id: 'user-a', title: 'Gym',
      start_time: '2026-08-03T18:00:00.000Z', end_time: '2026-08-03T19:00:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
    };
    const override = {
      id: 'o1', user_id: 'user-a', title: 'Gym (late)',
      start_time: '2026-08-17T19:30:00.000Z', end_time: '2026-08-17T20:30:00.000Z',
      override_of: 'series-1', original_start: '2026-08-17T18:00:00.000Z',
    };

    const instances = expandRecurrence(
      [series, override], new Date('2026-08-03T00:00:00Z'), new Date('2026-08-31T00:00:00Z')
    );

    const onThatDay = instances.filter(i => i.start_time.startsWith('2026-08-17'));
    expect(onThatDay).toHaveLength(1);
    expect(onThatDay[0].title).toBe('Gym (late)');
  });
});

describe('renderEventList controls', () => {
  it('offers edit and delete on your own events', () => {
    const html = renderEventList([{
      id: 'e1', user_id: 'user-a', title: 'Dentist',
      start_time: '2026-08-17T09:00:00.000Z', end_time: '2026-08-17T09:30:00.000Z',
    }], user, partner);

    expect(html).toMatch(/data-edit=/);
    expect(html).toMatch(/data-delete=/);
  });

  it('does not offer them on your partner\'s events', () => {
    const html = renderEventList([{
      id: 'e2', user_id: 'user-b', title: 'Their thing',
      start_time: '2026-08-17T09:00:00.000Z', end_time: '2026-08-17T09:30:00.000Z',
    }], user, partner);

    expect(html).not.toMatch(/data-edit=/);
    expect(html).not.toMatch(/data-delete=/);
  });

  it('tells a screen reader that the event repeats', () => {
    const html = renderEventList([occurrence], user, partner);
    expect(html).toMatch(/repeating/);
  });
});

describe('form edit mode', () => {
  function mountForm() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    renderEventForm(container);
    return container;
  }

  it('fills the form from the event and switches to Save', () => {
    const container = mountForm();
    beginEditingEvent(occurrence, 'series', container);

    expect(container.querySelector('#event-submit').textContent).toBe('Save changes');
    expect(container.querySelector('#event-form').elements.title.value).toBe('Gym');
    expect(getEditingContext().scope).toBe('series');
  });

  it('uses local time in the datetime input, not UTC', () => {
    // toISOString().slice(0,16) would show a 22:30 shift as 21:30 during BST,
    // which is the same class of bug localDateKey exists to prevent.
    const container = mountForm();
    beginEditingEvent(occurrence, 'series', container);

    const value = container.querySelector('#event-form').elements.start_time.value;
    const local = new Date('2026-08-17T18:00:00.000Z');
    const pad = (n) => String(n).padStart(2, '0');
    expect(value).toBe(
      `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
      + `T${pad(local.getHours())}:${pad(local.getMinutes())}`
    );
  });

  it('disables the recurrence rule when editing one occurrence', () => {
    // Changing the series rule from a single occurrence would silently rewrite
    // every other date.
    const container = mountForm();
    beginEditingEvent(occurrence, 'occurrence', container);

    expect(container.querySelector('#event-form').elements.rrule.disabled).toBe(true);
  });

  it('returns to create mode when cancelled', () => {
    const container = mountForm();
    beginEditingEvent(occurrence, 'series', container);
    stopEditingEvent(container.querySelector('#event-form'));

    expect(getEditingContext()).toBeNull();
    expect(container.querySelector('#event-submit').textContent).toBe('Create Event');
    expect(container.querySelector('#event-form').elements.rrule.disabled).toBe(false);
  });
});
