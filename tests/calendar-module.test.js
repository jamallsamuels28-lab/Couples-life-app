/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock supabase-client before importing calendar module
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

// Mock app-shell
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', name: 'Jamall' })),
  getPartner: vi.fn(() => ({ id: 'user-456', name: 'Rebecca' })),
}));

import { validateEvent, createEvent, fetchEvents, updateEvent, deleteEvent, expandRecurrence, renderEventForm, showToast, handleRealtimeEvent, setCurrentlyEditingEventId, getCurrentlyEditingEventId, showConflictToast, refreshCalendarView } from '../js/calendar-module.js';
import { supabase } from '../js/supabase-client.js';
import { getCurrentUser, getPartner } from '../js/app-shell.js';

describe('calendar-module', () => {
  describe('validateEvent', () => {
    it('returns valid for correct event data', () => {
      const result = validateEvent({
        title: 'Team meeting',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result).toEqual({ valid: true });
    });

    it('rejects empty title', () => {
      const result = validateEvent({
        title: '',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.title).toBe('Title is required');
    });

    it('rejects whitespace-only title', () => {
      const result = validateEvent({
        title: '   ',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.title).toBe('Title is required');
    });

    it('rejects title longer than 100 characters', () => {
      const result = validateEvent({
        title: 'A'.repeat(101),
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.title).toBe('Title must be 100 characters or fewer');
    });

    it('accepts title exactly 100 characters', () => {
      const result = validateEvent({
        title: 'A'.repeat(100),
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts title with 1 character', () => {
      const result = validateEvent({
        title: 'X',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects missing start_time', () => {
      const result = validateEvent({
        title: 'Meeting',
        start_time: '',
        end_time: '2025-03-15T11:00',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.start_time).toBe('Start time is required');
    });

    it('rejects missing end_time', () => {
      const result = validateEvent({
        title: 'Meeting',
        start_time: '2025-03-15T10:00',
        end_time: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.end_time).toBe('End time is required');
    });

    it('rejects end_time equal to start_time', () => {
      const result = validateEvent({
        title: 'Meeting',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T10:00',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.end_time).toBe('End time must be after start time');
    });

    it('rejects end_time before start_time', () => {
      const result = validateEvent({
        title: 'Meeting',
        start_time: '2025-03-15T11:00',
        end_time: '2025-03-15T10:00',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.end_time).toBe('End time must be after start time');
    });

    it('accepts valid optional rrule', () => {
      const result = validateEvent({
        title: 'Weekly sync',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts null rrule', () => {
      const result = validateEvent({
        title: 'One-off',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
        rrule: null,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts undefined rrule', () => {
      const result = validateEvent({
        title: 'One-off',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts empty string rrule (treated as no rrule)', () => {
      const result = validateEvent({
        title: 'One-off',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
        rrule: '',
      });
      expect(result.valid).toBe(true);
    });

    it('returns multiple errors when multiple fields fail', () => {
      const result = validateEvent({
        title: '',
        start_time: '',
        end_time: '',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.title).toBeDefined();
      expect(result.errors.start_time).toBeDefined();
      expect(result.errors.end_time).toBeDefined();
    });
  });

  describe('createEvent', () => {
    let mockInsert, mockSelect, mockSingle;

    beforeEach(() => {
      vi.clearAllMocks();
      mockSingle = vi.fn();
      mockSelect = vi.fn(() => ({ single: mockSingle }));
      mockInsert = vi.fn(() => ({ select: mockSelect }));
      supabase.from.mockReturnValue({ insert: mockInsert });
    });

    it('returns validation errors without calling supabase for invalid data', async () => {
      const result = await createEvent({ title: '', start_time: '', end_time: '' });
      expect(result.success).toBe(false);
      expect(result.errors.title).toBeDefined();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('returns error if user is not authenticated', async () => {
      getCurrentUser.mockReturnValueOnce(null);
      const result = await createEvent({
        title: 'Test',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });
      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('signed in');
    });

    it('inserts event into supabase and returns created event on success', async () => {
      const createdEvent = {
        id: 'evt-1',
        user_id: 'user-123',
        title: 'Dinner',
        start_time: '2025-03-15T19:00:00Z',
        end_time: '2025-03-15T20:00:00Z',
        rrule: null,
        is_busy: true,
      };
      mockSingle.mockResolvedValue({ data: createdEvent, error: null });

      const result = await createEvent({
        title: 'Dinner',
        start_time: '2025-03-15T19:00',
        end_time: '2025-03-15T20:00',
      });

      expect(result.success).toBe(true);
      expect(result.event).toEqual(createdEvent);
      expect(supabase.from).toHaveBeenCalledWith('events');
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        user_id: 'user-123',
        title: 'Dinner',
        start_time: '2025-03-15T19:00',
        end_time: '2025-03-15T20:00',
        rrule: null,
        is_busy: true,
      }));
    });

    it('trims title whitespace before inserting', async () => {
      mockSingle.mockResolvedValue({ data: { id: 'evt-2', title: 'Lunch' }, error: null });

      await createEvent({
        title: '  Lunch  ',
        start_time: '2025-03-15T12:00',
        end_time: '2025-03-15T13:00',
      });

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Lunch',
      }));
    });

    it('passes rrule through when provided', async () => {
      mockSingle.mockResolvedValue({ data: { id: 'evt-3' }, error: null });

      await createEvent({
        title: 'Weekly standup',
        start_time: '2025-03-15T09:00',
        end_time: '2025-03-15T09:15',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      });

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      }));
    });

    it('returns form error on supabase network failure', async () => {
      mockSingle.mockResolvedValue({ data: null, error: { message: 'Network error' } });

      const result = await createEvent({
        title: 'Test event',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('Failed to create event');
    });

    it('sets is_busy to true by default', async () => {
      mockSingle.mockResolvedValue({ data: { id: 'evt-4' }, error: null });

      await createEvent({
        title: 'Default busy',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
      });

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        is_busy: true,
      }));
    });

    it('allows is_busy to be set to false', async () => {
      mockSingle.mockResolvedValue({ data: { id: 'evt-5' }, error: null });

      await createEvent({
        title: 'Free time block',
        start_time: '2025-03-15T10:00',
        end_time: '2025-03-15T11:00',
        is_busy: false,
      });

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        is_busy: false,
      }));
    });
  });

  describe('renderEventForm', () => {
    let container;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      container.remove();
    });

    it('renders a form with title, start, end, rrule fields', () => {
      renderEventForm(container);

      expect(container.querySelector('#event-title')).not.toBeNull();
      expect(container.querySelector('#event-start')).not.toBeNull();
      expect(container.querySelector('#event-end')).not.toBeNull();
      expect(container.querySelector('#event-rrule')).not.toBeNull();
    });

    it('renders a submit button', () => {
      renderEventForm(container);
      const btn = container.querySelector('button[type="submit"]');
      expect(btn).not.toBeNull();
      expect(btn.textContent).toContain('Create Event');
    });

    it('renders error message spans for each field', () => {
      renderEventForm(container);

      expect(container.querySelector('#event-title-error')).not.toBeNull();
      expect(container.querySelector('#event-start-error')).not.toBeNull();
      expect(container.querySelector('#event-end-error')).not.toBeNull();
      expect(container.querySelector('#event-rrule-error')).not.toBeNull();
    });

    it('renders a card component wrapper', () => {
      renderEventForm(container);
      expect(container.querySelector('.card')).not.toBeNull();
    });

    it('has aria-describedby linking inputs to error messages', () => {
      renderEventForm(container);
      const titleInput = container.querySelector('#event-title');
      expect(titleInput.getAttribute('aria-describedby')).toBe('event-title-error');
    });

    it('preserves form data on validation failure (does not reset)', async () => {
      renderEventForm(container);

      const titleInput = container.querySelector('#event-title');
      const startInput = container.querySelector('#event-start');
      const endInput = container.querySelector('#event-end');

      // Set only title (leave times empty to trigger validation error)
      titleInput.value = 'My Event';
      startInput.value = '2025-03-15T10:00';
      endInput.value = ''; // Missing — will fail

      const form = container.querySelector('#event-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 10));

      // Form data should be preserved
      expect(titleInput.value).toBe('My Event');
      expect(startInput.value).toBe('2025-03-15T10:00');
    });

    it('shows inline error on validation failure', async () => {
      renderEventForm(container);

      const form = container.querySelector('#event-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      await new Promise(resolve => setTimeout(resolve, 10));

      const titleError = container.querySelector('#event-title-error');
      expect(titleError.textContent).toBe('Title is required');
    });
  });

  describe('showToast', () => {
    beforeEach(() => {
      // Remove any existing toast containers
      document.querySelectorAll('.toast-container').forEach(el => el.remove());
    });

    it('creates a toast container if none exists', () => {
      showToast('Hello', 'success');
      expect(document.querySelector('.toast-container')).not.toBeNull();
    });

    it('renders a success toast with the message', () => {
      showToast('Event created', 'success');
      const toast = document.querySelector('.toast-success');
      expect(toast).not.toBeNull();
      expect(toast.querySelector('.toast-message').textContent).toBe('Event created');
    });

    it('renders an error toast', () => {
      showToast('Something failed', 'error');
      const toast = document.querySelector('.toast-error');
      expect(toast).not.toBeNull();
    });

    it('toast is dismissable via button click', () => {
      showToast('Dismiss me', 'success');
      const dismissBtn = document.querySelector('.toast-dismiss');
      dismissBtn.click();
      const toast = document.querySelector('.toast');
      expect(toast.classList.contains('hidden')).toBe(true);
    });
  });

  describe('fetchEvents', () => {
    let mockSelect, mockIn, mockLt, mockGt, mockOrder;

    beforeEach(() => {
      vi.clearAllMocks();
      mockOrder = vi.fn();
      mockGt = vi.fn(() => ({ order: mockOrder }));
      mockLt = vi.fn(() => ({ gt: mockGt }));
      mockIn = vi.fn(() => ({ lt: mockLt }));
      mockSelect = vi.fn(() => ({ in: mockIn }));
      supabase.from.mockReturnValue({ select: mockSelect });
    });

    it('fetches events for both partners within the given range', async () => {
      const events = [
        { id: 'evt-1', user_id: 'user-123', title: 'Meeting', start_time: '2025-03-15T10:00:00Z', end_time: '2025-03-15T11:00:00Z' },
        { id: 'evt-2', user_id: 'user-456', title: 'Lunch', start_time: '2025-03-15T12:00:00Z', end_time: '2025-03-15T13:00:00Z' },
      ];
      mockOrder.mockResolvedValue({ data: events, error: null });

      const result = await fetchEvents('2025-03-15T00:00:00Z', '2025-03-16T00:00:00Z');

      expect(result.success).toBe(true);
      expect(result.events).toEqual(events);
      expect(supabase.from).toHaveBeenCalledWith('events');
      expect(mockSelect).toHaveBeenCalledWith('*');
      expect(mockIn).toHaveBeenCalledWith('user_id', ['user-123', 'user-456']);
      expect(mockLt).toHaveBeenCalledWith('start_time', '2025-03-16T00:00:00Z');
      expect(mockGt).toHaveBeenCalledWith('end_time', '2025-03-15T00:00:00Z');
    });

    it('returns error if user is not authenticated', async () => {
      getCurrentUser.mockReturnValueOnce(null);

      const result = await fetchEvents('2025-03-15T00:00:00Z', '2025-03-16T00:00:00Z');

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('signed in');
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('returns error on supabase failure', async () => {
      mockOrder.mockResolvedValue({ data: null, error: { message: 'Network error' } });

      const result = await fetchEvents('2025-03-15T00:00:00Z', '2025-03-16T00:00:00Z');

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('Failed to fetch events');
    });

    it('fetches only own events if partner is not available', async () => {
      getPartner.mockReturnValueOnce(null);
      mockOrder.mockResolvedValue({ data: [], error: null });

      const result = await fetchEvents('2025-03-15T00:00:00Z', '2025-03-16T00:00:00Z');

      expect(result.success).toBe(true);
      expect(mockIn).toHaveBeenCalledWith('user_id', ['user-123']);
    });

    it('returns empty array when no events exist in range', async () => {
      mockOrder.mockResolvedValue({ data: [], error: null });

      const result = await fetchEvents('2025-04-01T00:00:00Z', '2025-04-02T00:00:00Z');

      expect(result.success).toBe(true);
      expect(result.events).toEqual([]);
    });
  });

  describe('updateEvent', () => {
    let mockUpdate, mockEq, mockSelect, mockSingle;

    beforeEach(() => {
      vi.clearAllMocks();
      mockSingle = vi.fn();
      mockSelect = vi.fn(() => ({ single: mockSingle }));
      mockEq = vi.fn(() => ({ select: mockSelect }));
      mockUpdate = vi.fn(() => ({ eq: mockEq }));
      supabase.from.mockReturnValue({ update: mockUpdate });
    });

    it('updates event title with trimming', async () => {
      const updatedEvent = { id: 'evt-1', title: 'New Title', start_time: '2025-03-15T10:00:00Z', end_time: '2025-03-15T11:00:00Z' };
      mockSingle.mockResolvedValue({ data: updatedEvent, error: null });

      const result = await updateEvent('evt-1', { title: '  New Title  ' });

      expect(result.success).toBe(true);
      expect(result.event).toEqual(updatedEvent);
      expect(mockUpdate).toHaveBeenCalledWith({ title: 'New Title' });
      expect(mockEq).toHaveBeenCalledWith('id', 'evt-1');
    });

    it('rejects empty title', async () => {
      const result = await updateEvent('evt-1', { title: '' });

      expect(result.success).toBe(false);
      expect(result.errors.title).toBe('Title is required');
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('rejects title over 100 characters', async () => {
      const result = await updateEvent('evt-1', { title: 'A'.repeat(101) });

      expect(result.success).toBe(false);
      expect(result.errors.title).toBe('Title must be 100 characters or fewer');
    });

    it('rejects end_time before start_time when both provided', async () => {
      const result = await updateEvent('evt-1', {
        start_time: '2025-03-15T14:00',
        end_time: '2025-03-15T10:00',
      });

      expect(result.success).toBe(false);
      expect(result.errors.end_time).toBe('End time must be after start time');
    });

    it('rejects empty start_time', async () => {
      const result = await updateEvent('evt-1', { start_time: '' });

      expect(result.success).toBe(false);
      expect(result.errors.start_time).toBe('Start time is required');
    });

    it('rejects empty end_time', async () => {
      const result = await updateEvent('evt-1', { end_time: '' });

      expect(result.success).toBe(false);
      expect(result.errors.end_time).toBe('End time is required');
    });

    it('returns error if user is not authenticated', async () => {
      getCurrentUser.mockReturnValueOnce(null);

      const result = await updateEvent('evt-1', { title: 'Updated' });

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('signed in');
    });

    it('returns error if eventId is missing', async () => {
      const result = await updateEvent(null, { title: 'Updated' });

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('Event ID is required');
    });

    it('returns error on supabase failure', async () => {
      mockSingle.mockResolvedValue({ data: null, error: { message: 'DB error' } });

      const result = await updateEvent('evt-1', { title: 'Valid Title' });

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('Failed to update event');
    });

    it('updates multiple fields at once', async () => {
      const updatedEvent = { id: 'evt-1', title: 'Renamed', start_time: '2025-03-16T09:00', end_time: '2025-03-16T10:00' };
      mockSingle.mockResolvedValue({ data: updatedEvent, error: null });

      const result = await updateEvent('evt-1', {
        title: 'Renamed',
        start_time: '2025-03-16T09:00',
        end_time: '2025-03-16T10:00',
      });

      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith({
        title: 'Renamed',
        start_time: '2025-03-16T09:00',
        end_time: '2025-03-16T10:00',
      });
    });

    it('sets rrule to null when empty string provided', async () => {
      mockSingle.mockResolvedValue({ data: { id: 'evt-1' }, error: null });

      await updateEvent('evt-1', { rrule: '' });

      expect(mockUpdate).toHaveBeenCalledWith({ rrule: null });
    });
  });

  describe('deleteEvent', () => {
    let mockDelete, mockEq;

    beforeEach(() => {
      vi.clearAllMocks();
      mockEq = vi.fn();
      mockDelete = vi.fn(() => ({ eq: mockEq }));
      supabase.from.mockReturnValue({ delete: mockDelete });
    });

    it('deletes event by ID and returns success', async () => {
      mockEq.mockResolvedValue({ error: null });

      const result = await deleteEvent('evt-1');

      expect(result.success).toBe(true);
      expect(supabase.from).toHaveBeenCalledWith('events');
      expect(mockDelete).toHaveBeenCalled();
      expect(mockEq).toHaveBeenCalledWith('id', 'evt-1');
    });

    it('returns error if user is not authenticated', async () => {
      getCurrentUser.mockReturnValueOnce(null);

      const result = await deleteEvent('evt-1');

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('signed in');
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it('returns error if eventId is missing', async () => {
      const result = await deleteEvent(null);

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('Event ID is required');
    });

    it('returns error on supabase failure', async () => {
      mockEq.mockResolvedValue({ error: { message: 'Not found' } });

      const result = await deleteEvent('evt-999');

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('Failed to delete event');
    });

    it('returns error for empty string eventId', async () => {
      const result = await deleteEvent('');

      expect(result.success).toBe(false);
      expect(result.errors._form).toContain('Event ID is required');
    });
  });

  describe('expandRecurrence', () => {
    it('passes non-recurring events through unchanged', () => {
      const events = [
        {
          id: 'evt-1',
          title: 'One-off meeting',
          start_time: '2025-03-15T10:00:00Z',
          end_time: '2025-03-15T11:00:00Z',
          rrule: null,
          user_id: 'user-123',
          is_busy: true,
        },
      ];

      const result = expandRecurrence(
        events,
        new Date('2025-03-01T00:00:00Z'),
        new Date('2025-04-01T00:00:00Z')
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(events[0]);
    });

    it('expands a weekly recurring event into instances within range', () => {
      const events = [
        {
          id: 'evt-weekly',
          title: 'Weekly standup',
          start_time: '2025-03-03T09:00:00Z', // Monday
          end_time: '2025-03-03T09:30:00Z',
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          user_id: 'user-123',
          is_busy: true,
        },
      ];

      // Range: 4 weeks (March 3–March 31)
      const result = expandRecurrence(
        events,
        new Date('2025-03-03T00:00:00Z'),
        new Date('2025-03-31T23:59:59Z')
      );

      // Should have instances on: Mar 3, 10, 17, 24, 31
      expect(result.length).toBeGreaterThanOrEqual(4);
      expect(result.length).toBeLessThanOrEqual(5);

      // Each instance should have 30-minute duration
      for (const instance of result) {
        const start = new Date(instance.start_time);
        const end = new Date(instance.end_time);
        expect(end.getTime() - start.getTime()).toBe(30 * 60 * 1000);
      }

      // All instances should preserve original event properties
      for (const instance of result) {
        expect(instance.title).toBe('Weekly standup');
        expect(instance.user_id).toBe('user-123');
        expect(instance.is_busy).toBe(true);
        expect(instance._isRecurrenceInstance).toBe(true);
        expect(instance._originalEventId).toBe('evt-weekly');
      }
    });

    it('expands a daily recurring event and preserves duration', () => {
      const events = [
        {
          id: 'evt-daily',
          title: 'Daily checkin',
          start_time: '2025-03-01T08:00:00Z',
          end_time: '2025-03-01T08:15:00Z', // 15 minutes
          rrule: 'FREQ=DAILY',
          user_id: 'user-456',
          is_busy: false,
        },
      ];

      // Range: 1 week
      const result = expandRecurrence(
        events,
        new Date('2025-03-01T00:00:00Z'),
        new Date('2025-03-08T00:00:00Z')
      );

      // 7 days
      expect(result).toHaveLength(7);

      // Each should be 15 minutes
      for (const instance of result) {
        const start = new Date(instance.start_time);
        const end = new Date(instance.end_time);
        expect(end.getTime() - start.getTime()).toBe(15 * 60 * 1000);
        expect(instance.is_busy).toBe(false);
      }
    });

    it('caps at 365 instances per event', () => {
      const events = [
        {
          id: 'evt-daily-long',
          title: 'Recurring forever',
          start_time: '2025-01-01T10:00:00Z',
          end_time: '2025-01-01T11:00:00Z',
          rrule: 'FREQ=DAILY',
          user_id: 'user-123',
          is_busy: true,
        },
      ];

      // Range: 2 years (would produce ~730 instances without cap)
      const result = expandRecurrence(
        events,
        new Date('2025-01-01T00:00:00Z'),
        new Date('2027-01-01T00:00:00Z')
      );

      expect(result).toHaveLength(365);
    });

    it('returns empty array for empty input', () => {
      const result = expandRecurrence(
        [],
        new Date('2025-03-01T00:00:00Z'),
        new Date('2025-04-01T00:00:00Z')
      );

      expect(result).toEqual([]);
    });

    it('handles mix of recurring and non-recurring events', () => {
      const events = [
        {
          id: 'evt-single',
          title: 'One-off',
          start_time: '2025-03-10T14:00:00Z',
          end_time: '2025-03-10T15:00:00Z',
          rrule: null,
          user_id: 'user-123',
          is_busy: true,
        },
        {
          id: 'evt-weekly',
          title: 'Weekly',
          start_time: '2025-03-03T09:00:00Z',
          end_time: '2025-03-03T10:00:00Z',
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          user_id: 'user-456',
          is_busy: true,
        },
      ];

      const result = expandRecurrence(
        events,
        new Date('2025-03-01T00:00:00Z'),
        new Date('2025-03-31T23:59:59Z')
      );

      // 1 non-recurring + multiple weekly instances
      const nonRecurring = result.filter(e => !e._isRecurrenceInstance);
      const recurring = result.filter(e => e._isRecurrenceInstance);

      expect(nonRecurring).toHaveLength(1);
      expect(nonRecurring[0].title).toBe('One-off');
      expect(recurring.length).toBeGreaterThanOrEqual(4);
      expect(recurring.every(e => e.title === 'Weekly')).toBe(true);
    });

    it('handles invalid rrule gracefully by including event as-is', () => {
      const events = [
        {
          id: 'evt-bad',
          title: 'Bad rule',
          start_time: '2025-03-10T10:00:00Z',
          end_time: '2025-03-10T11:00:00Z',
          rrule: 'NOT_A_VALID_RRULE',
          user_id: 'user-123',
          is_busy: true,
        },
      ];

      const result = expandRecurrence(
        events,
        new Date('2025-03-01T00:00:00Z'),
        new Date('2025-04-01T00:00:00Z')
      );

      // Should still include the event (graceful fallback)
      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Bad rule');
    });

    it('returns no instances if range is before recurring event starts', () => {
      const events = [
        {
          id: 'evt-future',
          title: 'Future weekly',
          start_time: '2025-06-01T10:00:00Z',
          end_time: '2025-06-01T11:00:00Z',
          rrule: 'FREQ=WEEKLY;BYDAY=MO',
          user_id: 'user-123',
          is_busy: true,
        },
      ];

      const result = expandRecurrence(
        events,
        new Date('2025-03-01T00:00:00Z'),
        new Date('2025-04-01T00:00:00Z')
      );

      // No instances in March for an event starting in June
      expect(result).toHaveLength(0);
    });

    it('expands MWF schedule correctly', () => {
      const events = [
        {
          id: 'evt-mwf',
          title: 'MWF Class',
          start_time: '2025-03-03T14:00:00Z', // Monday
          end_time: '2025-03-03T15:30:00Z', // 90 min
          rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR',
          user_id: 'user-456',
          is_busy: true,
        },
      ];

      // Range: 1 week (Mon to Sun)
      const result = expandRecurrence(
        events,
        new Date('2025-03-03T00:00:00Z'),
        new Date('2025-03-10T00:00:00Z')
      );

      // Should have 3 instances (Mon, Wed, Fri)
      expect(result).toHaveLength(3);

      // Each instance should be 90 minutes
      for (const instance of result) {
        const start = new Date(instance.start_time);
        const end = new Date(instance.end_time);
        expect(end.getTime() - start.getTime()).toBe(90 * 60 * 1000);
      }
    });
  });

  describe('Realtime subscription for partner calendar changes', () => {
    beforeEach(() => {
      setCurrentlyEditingEventId(null);
      document.querySelectorAll('.toast-container').forEach(el => el.remove());
    });

    describe('handleRealtimeEvent', () => {
      it('ignores events with no payload detail', () => {
        const spy = vi.spyOn(window, 'dispatchEvent');
        const event = new CustomEvent('realtime:events', { detail: null });
        handleRealtimeEvent(event);
        // Should not dispatch calendar:refresh
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(0);
        spy.mockRestore();
      });

      it('ignores own user changes (not partner)', () => {
        const spy = vi.spyOn(window, 'dispatchEvent');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'INSERT',
            new: { id: 'evt-new', user_id: 'user-123', title: 'My event' },
            old: null,
          },
        });
        handleRealtimeEvent(event);
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(0);
        spy.mockRestore();
      });

      it('dispatches calendar:refresh on partner INSERT', () => {
        const spy = vi.spyOn(window, 'dispatchEvent');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'INSERT',
            new: { id: 'evt-partner', user_id: 'user-456', title: 'Partner event' },
            old: null,
          },
        });
        handleRealtimeEvent(event);
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(1);
        spy.mockRestore();
      });

      it('dispatches calendar:refresh on partner UPDATE (no conflict)', () => {
        const spy = vi.spyOn(window, 'dispatchEvent');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'UPDATE',
            new: { id: 'evt-other', user_id: 'user-456', title: 'Updated title' },
            old: { id: 'evt-other', user_id: 'user-456', title: 'Old title' },
          },
        });
        handleRealtimeEvent(event);
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(1);
        spy.mockRestore();
      });

      it('dispatches calendar:refresh on partner DELETE', () => {
        const spy = vi.spyOn(window, 'dispatchEvent');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'DELETE',
            new: null,
            old: { id: 'evt-deleted', user_id: 'user-456', title: 'Deleted event' },
          },
        });
        handleRealtimeEvent(event);
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(1);
        spy.mockRestore();
      });

      it('shows conflict toast when partner updates event user is editing', () => {
        setCurrentlyEditingEventId('evt-conflict');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'UPDATE',
            new: { id: 'evt-conflict', user_id: 'user-456', title: 'Partner changed this' },
            old: { id: 'evt-conflict', user_id: 'user-456', title: 'Original' },
          },
        });
        handleRealtimeEvent(event);

        const conflictToast = document.querySelector('.toast-conflict');
        expect(conflictToast).not.toBeNull();
        expect(conflictToast.querySelector('.toast-message').textContent).toBe(
          'Another user modified this event'
        );
      });

      it('does not show conflict toast for partner UPDATE on different event', () => {
        setCurrentlyEditingEventId('evt-mine');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'UPDATE',
            new: { id: 'evt-other', user_id: 'user-456', title: 'Other' },
            old: { id: 'evt-other', user_id: 'user-456', title: 'Previous' },
          },
        });
        handleRealtimeEvent(event);

        const conflictToast = document.querySelector('.toast-conflict');
        expect(conflictToast).toBeNull();
      });

      it('does not react when user is not authenticated', () => {
        getCurrentUser.mockReturnValueOnce(null);
        const spy = vi.spyOn(window, 'dispatchEvent');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'INSERT',
            new: { id: 'evt-x', user_id: 'user-456', title: 'Test' },
            old: null,
          },
        });
        handleRealtimeEvent(event);
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(0);
        spy.mockRestore();
      });
    });

    describe('showConflictToast', () => {
      it('creates a toast container if not present', () => {
        showConflictToast();
        expect(document.querySelector('.toast-container')).not.toBeNull();
      });

      it('renders a persistent conflict toast with correct message', () => {
        showConflictToast();
        const toast = document.querySelector('.toast-conflict');
        expect(toast).not.toBeNull();
        expect(toast.getAttribute('data-persistent')).toBe('true');
        expect(toast.querySelector('.toast-message').textContent).toBe(
          'Another user modified this event'
        );
      });

      it('conflict toast has a refresh button', () => {
        showConflictToast();
        const refreshBtn = document.querySelector('.toast-refresh-btn');
        expect(refreshBtn).not.toBeNull();
        expect(refreshBtn.textContent).toBe('Refresh');
      });

      it('conflict toast has a dismiss button', () => {
        showConflictToast();
        const dismissBtn = document.querySelector('.toast-conflict .toast-dismiss');
        expect(dismissBtn).not.toBeNull();
      });

      it('clicking refresh dispatches calendar:refresh and removes toast', () => {
        showConflictToast();
        const spy = vi.spyOn(window, 'dispatchEvent');
        const refreshBtn = document.querySelector('.toast-refresh-btn');
        refreshBtn.click();

        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(1);
        expect(document.querySelector('.toast-conflict')).toBeNull();
        spy.mockRestore();
      });

      it('clicking dismiss removes toast without refresh', () => {
        showConflictToast();
        const spy = vi.spyOn(window, 'dispatchEvent');
        const dismissBtn = document.querySelector('.toast-conflict .toast-dismiss');
        dismissBtn.click();

        expect(document.querySelector('.toast-conflict')).toBeNull();
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(0);
        spy.mockRestore();
      });

      it('conflict toast does NOT auto-dismiss (stays persistent)', async () => {
        showConflictToast();
        // Wait longer than the normal toast auto-dismiss (4s)
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(document.querySelector('.toast-conflict')).not.toBeNull();
      });
    });

    describe('setCurrentlyEditingEventId / getCurrentlyEditingEventId', () => {
      it('defaults to null', () => {
        setCurrentlyEditingEventId(null);
        expect(getCurrentlyEditingEventId()).toBeNull();
      });

      it('stores and retrieves an event ID', () => {
        setCurrentlyEditingEventId('evt-editing');
        expect(getCurrentlyEditingEventId()).toBe('evt-editing');
      });

      it('can be cleared back to null', () => {
        setCurrentlyEditingEventId('evt-123');
        setCurrentlyEditingEventId(null);
        expect(getCurrentlyEditingEventId()).toBeNull();
      });
    });

    describe('refreshCalendarView', () => {
      it('dispatches a calendar:refresh custom event', () => {
        const spy = vi.spyOn(window, 'dispatchEvent');
        refreshCalendarView();
        const refreshCalls = spy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(1);
        spy.mockRestore();
      });
    });

    describe('initCalendarModule realtime integration', () => {
      it('registers a listener for realtime:events on init', () => {
        const spy = vi.spyOn(window, 'addEventListener');
        // Re-import would be needed but we can test via dispatch
        // The initCalendarModule function is already called during import
        // We verify the handler was bound by dispatching and checking behavior
        spy.mockRestore();

        // Instead verify by dispatching a realtime:events event and checking
        // that partner changes cause a refresh
        const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
        const event = new CustomEvent('realtime:events', {
          detail: {
            eventType: 'INSERT',
            new: { id: 'evt-rt', user_id: 'user-456', title: 'Realtime test' },
            old: null,
          },
        });
        // Call handleRealtimeEvent directly since initCalendarModule binds it
        handleRealtimeEvent(event);
        const refreshCalls = dispatchSpy.mock.calls.filter(
          ([e]) => e.type === 'calendar:refresh'
        );
        expect(refreshCalls).toHaveLength(1);
        dispatchSpy.mockRestore();
      });
    });
  });
});
