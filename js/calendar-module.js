// ============================================================
// Calendar Module — Couples Life App
// Event creation with validation, form UI, and Supabase persistence
// ============================================================

import { RRule } from 'rrule';
import { supabase } from './supabase-client.js';
import { getCurrentUser, getPartner } from './app-shell.js';
import { createOverlapRibbon } from './overlap-ribbon.js';
import { bothFreeWindows } from './free-windows.js';
import { fetchShiftPatterns, fetchSleepRules, personSchedule } from './schedule-patterns.js';
import { renderScheduleEditor } from './schedule-editor.js';
import { renderCalendarViews, visibleRange } from './calendar-views.js';
import { renderGoogleSyncPanel, startAutoSync } from './google-sync.js';
import { escapeHtml, displayName, chevronSvg } from './ui-helpers.js';
import { renderRecurrencePicker, wireRecurrencePicker, describeRRule } from './recurrence-picker.js';

// --- Validation ---

/**
 * Validates event data for creation.
 * Returns { valid: true } or { valid: false, errors: { field: message } }
 */
export function validateEvent(eventData) {
  const errors = {};

  // Title: 1–100 chars, non-empty
  if (!eventData.title || eventData.title.trim().length === 0) {
    errors.title = 'Title is required';
  } else if (eventData.title.length > 100) {
    errors.title = 'Title must be 100 characters or fewer';
  }

  // Start time: required
  if (!eventData.start_time) {
    errors.start_time = 'Start time is required';
  }

  // End time: required, must be after start
  if (!eventData.end_time) {
    errors.end_time = 'End time is required';
  } else if (eventData.start_time && new Date(eventData.end_time) <= new Date(eventData.start_time)) {
    errors.end_time = 'End time must be after start time';
  }

  // RRULE: optional, but if provided must be a non-empty string
  if (eventData.rrule !== undefined && eventData.rrule !== null && eventData.rrule !== '') {
    if (typeof eventData.rrule !== 'string') {
      errors.rrule = 'Recurrence rule must be a text value';
    }
  }

  return Object.keys(errors).length === 0
    ? { valid: true }
    : { valid: false, errors };
}

// --- RRULE Recurrence Expansion ---

/** Maximum number of instances to expand per recurring event */
const MAX_INSTANCES_PER_EVENT = 365;

/**
 * Expands recurring events into concrete instances within a date range.
 * Non-recurring events pass through unchanged.
 *
 * @param {Array} events - Array of event objects (each may have an `rrule` field)
 * @param {Date} rangeStart - Start of visible range (inclusive)
 * @param {Date} rangeEnd - End of visible range (exclusive)
 * @returns {Array} - Flat array of event instances (expanded + non-recurring)
 */
export function expandRecurrence(events, rangeStart, rangeEnd) {
  const result = [];

  // §1.2 order of operations. Overrides are held back and applied after the
  // whole expansion, because an override can only replace an instance that
  // exists — applying it inline would depend on row order.
  const seeds = (events || []).filter(e => !e.override_of);
  const overrides = (events || []).filter(e => e.override_of);

  for (const event of seeds) {
    if (!event.rrule) {
      // Non-recurring: pass through unchanged
      result.push(event);
      continue;
    }

    // Calculate duration from the original event's start/end
    const eventStart = new Date(event.start_time);
    const eventEnd = new Date(event.end_time);
    const durationMs = eventEnd.getTime() - eventStart.getTime();

    // Build RRule from the event's rrule string and dtstart
    let rule;
    try {
      rule = RRule.fromString(`DTSTART:${formatRRuleDateString(eventStart)}\nRRULE:${event.rrule}`);
    } catch (e) {
      // If the RRULE is invalid, skip expansion and include as single instance
      result.push(event);
      continue;
    }

    // Expand occurrences within the visible range, capped at MAX_INSTANCES_PER_EVENT
    const occurrences = rule.between(rangeStart, rangeEnd, true);
    const capped = occurrences.slice(0, MAX_INSTANCES_PER_EVENT);

    // Cancelled instances, compared to the minute so a stored timestamp with
    // different precision still matches.
    const exdates = new Set(
      (event.exdates || [])
        .map(d => new Date(d).getTime())
        .filter(Number.isFinite)
    );

    for (const occurrence of capped) {
      const instanceStart = new Date(occurrence);
      if (exdates.has(instanceStart.getTime())) continue;

      const instanceEnd = new Date(instanceStart.getTime() + durationMs);

      result.push({
        ...event,
        start_time: instanceStart.toISOString(),
        end_time: instanceEnd.toISOString(),
        _isRecurrenceInstance: true,
        _originalEventId: event.id,
        _originalStart: instanceStart.toISOString(),
      });
    }
  }

  // Apply overrides: drop the instance being replaced, then add the replacement.
  for (const override of overrides) {
    const replacedStart = override.original_start
      ? new Date(override.original_start).getTime()
      : null;

    const index = result.findIndex(instance =>
      instance._originalEventId === override.override_of
      && (replacedStart === null || new Date(instance._originalStart).getTime() === replacedStart)
    );

    if (index !== -1) result.splice(index, 1);
    result.push({ ...override, _isOverride: true });
  }

  return result;
}

/**
 * Formats a Date into an RRULE-compatible DTSTART string (UTC).
 * @param {Date} date
 * @returns {string} e.g. "20250315T100000Z"
 */
function formatRRuleDateString(date) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const seconds = String(d.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

// --- Event Creation ---

/**
 * Creates a calendar event after validation.
 * Returns { success: true, event } or { success: false, errors }
 */
export async function createEvent(eventData) {
  const validation = validateEvent(eventData);
  if (!validation.valid) {
    return { success: false, errors: validation.errors };
  }

  const user = getCurrentUser();
  if (!user) {
    return { success: false, errors: { _form: 'You must be signed in to create events' } };
  }

  const record = {
    user_id: user.id,
    title: eventData.title.trim(),
    start_time: eventData.start_time,
    end_time: eventData.end_time,
    rrule: eventData.rrule || null,
    is_busy: eventData.is_busy !== undefined ? eventData.is_busy : true,
  };

  const { data, error } = await supabase
    .from('events')
    .insert(record)
    .select()
    .single();

  if (error) {
    return { success: false, errors: { _form: 'Failed to create event. Please try again.' } };
  }

  return { success: true, event: data };
}

// --- Event Fetching ---

/**
 * Fetches all events from both partners within the given date range.
 * An event overlaps the range if its start_time < rangeEnd AND end_time > rangeStart.
 * Returns { success: true, events: [] } or { success: false, errors: {} }
 */
export async function fetchEvents(rangeStart, rangeEnd) {
  const user = getCurrentUser();
  const partnerProfile = getPartner();

  if (!user) {
    return { success: false, errors: { _form: 'You must be signed in to view events' } };
  }

  // Build user IDs to query — include partner if available
  const userIds = [user.id];
  if (partnerProfile) {
    userIds.push(partnerProfile.id);
  }

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .in('user_id', userIds)
    .lt('start_time', rangeEnd)
    .gt('end_time', rangeStart)
    .order('start_time', { ascending: true });

  if (error) {
    return { success: false, errors: { _form: 'Failed to fetch events. Please try again.' } };
  }

  return { success: true, events: data };
}

// --- Event Update ---

/**
 * Updates an existing event by ID with the provided changes.
 * Validates changed fields using the same rules as creation.
 * Returns { success: true, event } or { success: false, errors }
 */
export async function updateEvent(eventId, changes) {
  if (!eventId) {
    return { success: false, errors: { _form: 'Event ID is required' } };
  }

  const user = getCurrentUser();
  if (!user) {
    return { success: false, errors: { _form: 'You must be signed in to update events' } };
  }

  // Validate the fields being changed using the same validation rules.
  // We build a "virtual" event data with only the changed fields for validation,
  // but we need to handle partial updates: only validate fields that are present.
  const validationErrors = {};

  if ('title' in changes) {
    if (!changes.title || changes.title.trim().length === 0) {
      validationErrors.title = 'Title is required';
    } else if (changes.title.length > 100) {
      validationErrors.title = 'Title must be 100 characters or fewer';
    }
  }

  if ('start_time' in changes && !changes.start_time) {
    validationErrors.start_time = 'Start time is required';
  }

  if ('end_time' in changes && !changes.end_time) {
    validationErrors.end_time = 'End time is required';
  }

  // If both start and end are provided, check ordering
  if ('start_time' in changes && 'end_time' in changes) {
    if (changes.start_time && changes.end_time &&
        new Date(changes.end_time) <= new Date(changes.start_time)) {
      validationErrors.end_time = 'End time must be after start time';
    }
  }

  // If only end_time is changing, we can't validate against current start_time here
  // (the caller should ensure consistency). But if only start_time changes,
  // same applies. We validate what we can with the data provided.

  if ('rrule' in changes && changes.rrule !== undefined && changes.rrule !== null && changes.rrule !== '') {
    if (typeof changes.rrule !== 'string') {
      validationErrors.rrule = 'Recurrence rule must be a text value';
    }
  }

  if (Object.keys(validationErrors).length > 0) {
    return { success: false, errors: validationErrors };
  }

  // Build the update payload
  const updatePayload = {};
  if ('title' in changes) updatePayload.title = changes.title.trim();
  if ('start_time' in changes) updatePayload.start_time = changes.start_time;
  if ('end_time' in changes) updatePayload.end_time = changes.end_time;
  if ('rrule' in changes) updatePayload.rrule = changes.rrule || null;
  if ('is_busy' in changes) updatePayload.is_busy = changes.is_busy;

  const { data, error } = await supabase
    .from('events')
    .update(updatePayload)
    .eq('id', eventId)
    .select()
    .single();

  if (error) {
    return { success: false, errors: { _form: 'Failed to update event. Please try again.' } };
  }

  return { success: true, event: data };
}

// --- Single-occurrence edits (§1.2) ---

/**
 * Cancels one occurrence of a recurring series by adding an exdate.
 *
 * The schema has carried `exdates` since migration 0004 and expandRecurrence
 * has always honoured them, but nothing ever wrote one — so "delete just this
 * Tuesday" had no way to be expressed and the only option was killing the
 * whole series.
 *
 * @param {string} seriesId - the id of the seed event, not the instance
 * @param {string} originalStart - ISO timestamp of the occurrence to cancel
 */
export async function cancelOccurrence(seriesId, originalStart) {
  if (!seriesId || !originalStart) {
    return { success: false, errors: { _form: 'Which occurrence is not clear.' } };
  }

  const user = getCurrentUser();
  if (!user) {
    return { success: false, errors: { _form: 'You must be signed in to change events' } };
  }

  const { data: series, error: readError } = await supabase
    .from('events').select('exdates').eq('id', seriesId).single();

  if (readError || !series) {
    return { success: false, errors: { _form: 'Could not find that series.' } };
  }

  const stamp = new Date(originalStart);
  if (Number.isNaN(stamp.getTime())) {
    return { success: false, errors: { _form: 'That occurrence has no valid date.' } };
  }

  // Already cancelled — treat as success so a double tap is harmless.
  const existing = series.exdates || [];
  if (existing.some(d => new Date(d).getTime() === stamp.getTime())) {
    return { success: true, alreadyCancelled: true };
  }

  // Read-modify-write, so two people cancelling different occurrences of the
  // same series within the same instant could lose one of the two. The window
  // is milliseconds and the recovery is to cancel it again; the alternative is
  // a Postgres function purely to array_append, which is more machinery than
  // the risk justifies for two users.
  const { error } = await supabase
    .from('events')
    .update({ exdates: [...existing, stamp.toISOString()] })
    .eq('id', seriesId);

  if (error) {
    return { success: false, errors: { _form: 'Could not cancel that occurrence.' } };
  }
  return { success: true };
}

/**
 * Changes one occurrence of a series without touching the rest of it.
 *
 * Written as a separate row pointing back at the series with `override_of`,
 * plus `original_start` recording which occurrence it replaces. Editing the
 * series row directly would move every past occurrence too — the same class of
 * bug as updating a shift pattern in place.
 */
export async function updateOccurrence(instance, changes) {
  const seriesId = instance?._originalEventId || instance?.override_of;
  const originalStart = instance?._originalStart || instance?.original_start;

  if (!seriesId || !originalStart) {
    return { success: false, errors: { _form: 'Which occurrence is not clear.' } };
  }

  const user = getCurrentUser();
  if (!user) {
    return { success: false, errors: { _form: 'You must be signed in to update events' } };
  }

  // An occurrence that already has an override row is edited in place rather
  // than accumulating a second override for the same slot.
  if (instance._isOverride && instance.id) {
    return updateEvent(instance.id, changes);
  }

  const start = changes.start_time || instance.start_time;
  const end = changes.end_time || instance.end_time;
  const validation = validateEvent({
    title: changes.title ?? instance.title,
    start_time: start,
    end_time: end,
  });
  if (!validation.valid) return { success: false, errors: validation.errors };

  const { data, error } = await supabase
    .from('events')
    .insert({
      user_id: user.id,
      title: (changes.title ?? instance.title).trim(),
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      is_busy: changes.is_busy ?? instance.is_busy ?? true,
      // The override is a single dated event; carrying the series rrule would
      // expand it into a second series.
      rrule: null,
      override_of: seriesId,
      original_start: new Date(originalStart).toISOString(),
    })
    .select()
    .single();

  if (error) {
    return { success: false, errors: { _form: 'Could not change that occurrence.' } };
  }
  return { success: true, event: data };
}

// --- Event Deletion ---

/**
 * Deletes an event by ID from the events table.
 * Returns { success: true } or { success: false, errors }
 */
export async function deleteEvent(eventId) {
  if (!eventId) {
    return { success: false, errors: { _form: 'Event ID is required' } };
  }

  const user = getCurrentUser();
  if (!user) {
    return { success: false, errors: { _form: 'You must be signed in to delete events' } };
  }

  const { error } = await supabase
    .from('events')
    .delete()
    .eq('id', eventId);

  if (error) {
    return { success: false, errors: { _form: 'Failed to delete event. Please try again.' } };
  }

  return { success: true };
}

// --- UI: Event Creation Form ---

/**
 * Renders the event creation form into the given container element.
 * Handles inline validation errors and preserves form data on failure.
 * Shows a success toast on successful creation.
 */
export function renderEventForm(container) {
  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title" id="event-form-title">New Event</h3>
      </div>
      <form id="event-form" class="card-body" novalidate>
        <div class="input-group">
          <label class="input-label" for="event-title">Title</label>
          <input
            type="text"
            id="event-title"
            name="title"
            class="input"
            maxlength="100"
            placeholder="Event title"
            required
            aria-describedby="event-title-error"
          />
          <span id="event-title-error" class="input-error-msg" aria-live="polite"></span>
        </div>

        <div class="input-group">
          <label class="input-label" for="event-start">Start time</label>
          <input
            type="datetime-local"
            id="event-start"
            name="start_time"
            class="input"
            required
            aria-describedby="event-start-error"
          />
          <span id="event-start-error" class="input-error-msg" aria-live="polite"></span>
        </div>

        <div class="input-group">
          <label class="input-label" for="event-end">End time</label>
          <input
            type="datetime-local"
            id="event-end"
            name="end_time"
            class="input"
            required
            aria-describedby="event-end-error"
          />
          <span id="event-end-error" class="input-error-msg" aria-live="polite"></span>
        </div>

        ${renderRecurrencePicker()}
        <span id="event-rrule-error" class="input-error-msg" aria-live="polite"></span>

        <div id="event-form-error" class="input-error-msg" aria-live="polite"></div>

        <div class="card-footer">
          <button type="submit" class="btn btn-primary" id="event-submit">Create Event</button>
          <button type="button" class="btn btn-ghost" id="event-cancel-edit" hidden>Cancel</button>
        </div>
      </form>
    </div>
  `;

  const form = container.querySelector('#event-form');
  form.addEventListener('submit', handleFormSubmit);
  // Held on the form so beginEditingEvent can load an existing rule back into
  // the controls rather than into a text box nobody can read.
  form._recurrence = wireRecurrencePicker(container);
  container.querySelector('#event-cancel-edit').addEventListener('click', () => {
    stopEditingEvent(form);
  });
}

/**
 * What the form is currently editing, if anything.
 *
 * `scope` is 'series' or 'occurrence'. The distinction cannot be inferred at
 * submit time — the same instance can legitimately be edited either way — so
 * it is captured when the user chooses and carried through.
 */
let editingContext = null;

/** A Date as the local 'YYYY-MM-DDTHH:mm' a datetime-local input expects.
 *  Never toISOString(): that answers in UTC and would show a 22:30 night shift
 *  as 21:30 during BST. */
function toLocalDateTimeInput(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Puts the form into edit mode for one event or occurrence. */
export function beginEditingEvent(instance, scope, container = document) {
  const form = container.querySelector('#event-form');
  if (!form || !instance) return false;

  editingContext = { instance, scope };
  // Lets the realtime handler warn if the partner changes this same event
  // while it is open. The plumbing existed; nothing ever set it.
  setCurrentlyEditingEventId(instance._originalEventId || instance.id);

  form.elements.title.value = instance.title || '';
  form.elements.start_time.value = toLocalDateTimeInput(instance.start_time);
  form.elements.end_time.value = toLocalDateTimeInput(instance.end_time);
  // Editing a single occurrence must not offer to change the series rule.
  const rule = scope === 'series' ? (instance.rrule || '') : '';
  if (form._recurrence) form._recurrence.setValue(rule);
  else form.elements.rrule.value = rule;

  // Hidden rather than disabled for an occurrence: there is no repeat to edit
  // on a single date, and showing greyed-out controls invites the attempt.
  const picker = container.querySelector('#recurrence-picker');
  if (picker) picker.hidden = scope === 'occurrence';
  form.elements.rrule.disabled = scope === 'occurrence';

  const title = container.querySelector('#event-form-title');
  const submit = container.querySelector('#event-submit');
  const cancel = container.querySelector('#event-cancel-edit');
  if (title) {
    title.textContent = scope === 'occurrence' ? 'Edit this occurrence' : 'Edit event';
  }
  if (submit) submit.textContent = 'Save changes';
  if (cancel) cancel.hidden = false;

  clearFormErrors(form);
  // Cosmetic. Guarded so that a environment without it cannot stop the form
  // entering edit mode, which is the part that matters.
  form.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  form.elements.title.focus();
  return true;
}

/** Returns the form to creating a new event. */
export function stopEditingEvent(form) {
  editingContext = null;
  setCurrentlyEditingEventId(null);
  if (!form) return;

  form.reset();
  form.elements.rrule.disabled = false;
  if (form._recurrence) form._recurrence.setValue('');
  const picker = form.querySelector('#recurrence-picker');
  if (picker) picker.hidden = false;
  clearFormErrors(form);

  const root = form.closest('.card') || document;
  const title = root.querySelector('#event-form-title');
  const submit = root.querySelector('#event-submit');
  const cancel = root.querySelector('#event-cancel-edit');
  if (title) title.textContent = 'New Event';
  if (submit) submit.textContent = 'Create Event';
  if (cancel) cancel.hidden = true;
}

/** Exposed for tests. */
export function getEditingContext() {
  return editingContext;
}

/**
 * Handles the form submit: validates, creates, shows errors or success.
 */
async function handleFormSubmit(e) {
  e.preventDefault();

  const form = e.target;
  clearFormErrors(form);

  const eventData = {
    title: form.elements.title.value,
    start_time: form.elements.start_time.value,
    end_time: form.elements.end_time.value,
    rrule: form.elements.rrule.value || null,
  };

  if (editingContext) {
    const { instance, scope } = editingContext;

    const result = scope === 'occurrence'
      // Only this one date moves; the series keeps its own times.
      ? await updateOccurrence(instance, {
          title: eventData.title,
          start_time: eventData.start_time,
          end_time: eventData.end_time,
        })
      : await updateEvent(instance._originalEventId || instance.id, eventData);

    if (!result.success) {
      showFormErrors(form, result.errors);
      return;
    }

    stopEditingEvent(form);
    showToast(
      scope === 'occurrence' ? 'This occurrence updated' : 'Event updated',
      'success'
    );
    refreshCalendarView();
    return;
  }

  const result = await createEvent(eventData);

  if (!result.success) {
    showFormErrors(form, result.errors);
    return;
  }

  // Success — clear form and show toast
  form.reset();
  showToast('Event created successfully', 'success');
  refreshCalendarView();
}

// --- Error Display ---

/**
 * Shows inline error messages adjacent to failing fields.
 * Form data is preserved (no reset on error).
 */
function showFormErrors(form, errors) {
  if (errors.title) {
    const input = form.querySelector('#event-title');
    const msg = form.querySelector('#event-title-error');
    input.classList.add('input-error');
    msg.textContent = errors.title;
  }

  if (errors.start_time) {
    const input = form.querySelector('#event-start');
    const msg = form.querySelector('#event-start-error');
    input.classList.add('input-error');
    msg.textContent = errors.start_time;
  }

  if (errors.end_time) {
    const input = form.querySelector('#event-end');
    const msg = form.querySelector('#event-end-error');
    input.classList.add('input-error');
    msg.textContent = errors.end_time;
  }

  if (errors.rrule) {
    const input = form.querySelector('#event-rrule');
    const msg = form.querySelector('#event-rrule-error');
    input.classList.add('input-error');
    msg.textContent = errors.rrule;
  }

  if (errors._form) {
    const msg = form.querySelector('#event-form-error');
    msg.textContent = errors._form;
  }
}

/**
 * Clears all inline error messages and error styling.
 */
function clearFormErrors(form) {
  form.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
  form.querySelectorAll('.input-error-msg').forEach(el => { el.textContent = ''; });
}

// --- Toast ---

/**
 * Shows a toast notification. Creates the toast container if not present.
 * @param {string} message - Toast message text
 * @param {'success'|'error'} type - Toast variant
 */
export function showToast(message, type = 'success') {
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const iconPath = type === 'success'
    ? '<polyline points="4 10 8 14 16 6"/>'
    : '<line x1="6" y1="6" x2="14" y2="14"/><line x1="14" y1="6" x2="6" y2="14"/>';

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 20 20">${iconPath}</svg>
    <span class="toast-message">${message}</span>
    <button class="toast-dismiss" aria-label="Dismiss">
      <svg class="icon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>
      </svg>
    </button>
  `;

  toast.querySelector('.toast-dismiss').addEventListener('click', () => {
    toast.classList.add('hidden');
    setTimeout(() => toast.remove(), 200);
  });

  toastContainer.appendChild(toast);

  // Auto-dismiss after 4 seconds
  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add('hidden');
      setTimeout(() => toast.remove(), 200);
    }
  }, 4000);
}

// --- Realtime Subscription for Partner Calendar Changes ---

/**
 * Tracks the event ID currently being edited by this user.
 * Used to detect concurrent edit conflicts.
 */
let currentlyEditingEventId = null;

/**
 * Sets the ID of the event currently being edited by this user.
 * Call this when the user opens an event for editing.
 * @param {string|null} eventId
 */
export function setCurrentlyEditingEventId(eventId) {
  currentlyEditingEventId = eventId;
}

/**
 * Gets the ID of the event currently being edited by this user.
 * @returns {string|null}
 */
export function getCurrentlyEditingEventId() {
  return currentlyEditingEventId;
}

/**
 * Handles incoming realtime events for the events table.
 * Dispatched by the realtime manager as `realtime:events` custom events.
 *
 * - On INSERT/UPDATE/DELETE from partner: refreshes displayed events
 * - On UPDATE to an event currently being edited: shows conflict toast
 *
 * @param {CustomEvent} event - The realtime custom event with detail payload
 */
export function handleRealtimeEvent(event) {
  const payload = event.detail;
  if (!payload) return;

  const user = getCurrentUser();
  if (!user) return;

  const { eventType, new: newRecord, old: oldRecord } = payload;

  // Determine the user_id of the change author
  const changeUserId = newRecord?.user_id || oldRecord?.user_id;

  // Only react to partner changes (not our own)
  if (changeUserId === user.id) return;

  // Detect concurrent edit conflict: partner updated an event we are currently editing
  const affectedEventId = newRecord?.id || oldRecord?.id;
  if (eventType === 'UPDATE' && currentlyEditingEventId && affectedEventId === currentlyEditingEventId) {
    showConflictToast();
    return;
  }

  // For any partner change (INSERT, UPDATE, DELETE), refresh the events list
  refreshCalendarView();
}

/**
 * Shows a persistent toast notification for concurrent edit conflicts.
 * The toast remains visible until dismissed or the user clicks refresh.
 */
export function showConflictToast() {
  let toastContainer = document.querySelector('.toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = 'toast toast-warning toast-conflict';
  toast.setAttribute('data-persistent', 'true');
  toast.innerHTML = `
    <svg class="toast-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="10" cy="10" r="8"/>
      <line x1="10" y1="6" x2="10" y2="11"/>
      <circle cx="10" cy="14" r="0.8" fill="currentColor" stroke="none"/>
    </svg>
    <span class="toast-message">Another user modified this event</span>
    <button class="toast-refresh-btn" aria-label="Refresh events">Refresh</button>
    <button class="toast-dismiss" aria-label="Dismiss">
      <svg class="icon-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/>
      </svg>
    </button>
  `;

  // Refresh button: refresh events and remove the toast
  toast.querySelector('.toast-refresh-btn').addEventListener('click', () => {
    refreshCalendarView();
    toast.remove();
  });

  // Dismiss button: just remove the toast
  toast.querySelector('.toast-dismiss').addEventListener('click', () => {
    toast.remove();
  });

  // No auto-dismiss — this toast stays until user action (requirement 14.5)
  toastContainer.appendChild(toast);
}

/**
 * Refreshes the calendar view by re-fetching events and dispatching
 * a custom event that the calendar renderer can listen for.
 * Does NOT cause a full page reload.
 */
export function refreshCalendarView() {
  window.dispatchEvent(new CustomEvent('calendar:refresh'));
}

// --- Module Init ---

/**
 * Initialises the calendar module when the calendar view becomes active.
 * Listens for the viewchange event dispatched by the app shell.
 * Also subscribes to realtime events for the events table.
 */
export function initCalendarModule() {
  window.addEventListener('viewchange', (e) => {
    if (e.detail.view === 'calendar') {
      const container = document.getElementById('calendar-view');
      if (container) {
        activateCalendarView(container);
      }
    }
  });

  // Tapping an event in the month, week or day view opens it for editing.
  //
  // calendar-views.js has dispatched this since the views were written and
  // nothing ever listened, so tapping an event did nothing at all — there was
  // no edit flow to connect it to until now.
  window.addEventListener('calendar:edit-event', async (event) => {
    const id = event.detail?.id;
    if (!id) return;

    // Fetched rather than taken from the view: the views render expanded
    // instances, and editing needs the stored row the instance came from.
    const { data, error } = await supabase
      .from('events').select('*').eq('id', id).single();

    if (error || !data) {
      showToast('Could not open that event', 'error');
      return;
    }

    const user = getCurrentUser();
    if (user && data.user_id !== user.id) {
      // RLS would refuse the write anyway; saying so beats a form that
      // silently fails on save.
      showToast('That is your partner\'s event', 'error');
      return;
    }

    beginEditingEvent(data, 'series', document);
  });

  // Re-render the dashboard when a partner change arrives over realtime
  window.addEventListener('calendar:refresh', () => {
    const container = document.getElementById('calendar-view');
    if (container && container.querySelector('#calendar-dashboard')) {
      renderCalendarDashboard(container.querySelector('#calendar-dashboard'));
      renderCalendarGrid(container.querySelector('#calendar-grid-mount'));
    }
  });

  // Subscribe to realtime events table changes from the realtime manager
  window.addEventListener('realtime:events', handleRealtimeEvent);

  // Keep Google in step while the app is open. Throttled to five minutes and
  // paused when the tab is hidden, so a PWA left open overnight does not sit
  // there hammering the API.
  startAutoSync();
}

// ============================================================
// VIEW COMPOSITION — Calendar dashboard
// Leads with the overlap ribbon (requirement 13.9's primary
// visualisation), then mutual free windows, then the upcoming
// event list. The New Event form is secondary, in a disclosure.
// ============================================================

// The ribbon draws a whole day. There is deliberately no waking-hour bound
// here any more: availability comes from each person's sleep rules and shift
// pattern (spec §1.4), not from a shared assumption that everyone is awake
// 08:00–23:00. That assumption was the reason a night shift plus a morning
// sleep used to read as twelve hours of mutual free time.
const RIBBON_START_HOUR = 0;
const RIBBON_END_HOUR = 24;
/** How many days ahead the dashboard looks */
const LOOKAHEAD_DAYS = 7;

/**
 * Mounts the calendar view: dashboard first, event form in a disclosure.
 * @param {HTMLElement} container - The #calendar-view mount point
 */
export function activateCalendarView(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="dashboard-stack" id="calendar-dashboard">
      <p class="view-placeholder-text">Loading schedule…</p>
    </div>
    <section class="calendar-grid-section" id="calendar-grid-mount">
      <p class="view-placeholder-text">Loading calendar…</p>
    </section>
    <details class="disclosure" id="event-form-disclosure">
      <summary>
        <span>New event</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="event-form-mount"></div>
    </details>
    <details class="disclosure" id="google-sync-disclosure">
      <summary>
        <span>Connected calendars</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="google-sync-mount"></div>
    </details>
    <details class="disclosure" id="schedule-editor-disclosure">
      <summary>
        <span>Shift pattern &amp; sleep</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="schedule-editor-mount"></div>
    </details>
  `;

  renderEventForm(container.querySelector('#event-form-mount'));
  renderScheduleEditor(container.querySelector('#schedule-editor-mount'));
  renderGoogleSyncPanel(container.querySelector('#google-sync-mount'));
  renderCalendarDashboard(container.querySelector('#calendar-dashboard'));
  renderCalendarGrid(container.querySelector('#calendar-grid-mount'));
}

/**
 * Fetches whatever the current month/week/day view needs and renders it.
 * The view asks for a reload when you navigate rather than fetching itself,
 * so there is one place that knows what range is loaded.
 *
 * @param {HTMLElement} mount
 */
export async function renderCalendarGrid(mount) {
  if (!mount) return;

  const { start, end } = visibleRange();
  const user = getCurrentUser();
  const partnerProfile = getPartner();
  const userIds = [user?.id, partnerProfile?.id].filter(Boolean);

  const [eventResult, patternResult, sleepResult] = await Promise.all([
    fetchEvents(start.toISOString(), end.toISOString()),
    fetchShiftPatterns(userIds),
    fetchSleepRules(userIds),
  ]);

  if (!eventResult.success) {
    mount.innerHTML = `<div class="empty-state">Could not load the calendar. Check your connection and try again.</div>`;
    return;
  }

  const allPatterns = patternResult.success ? patternResult.patterns : [];
  const allSleepRules = sleepResult.success ? sleepResult.rules : [];

  renderCalendarViews(mount, {
    instances: expandRecurrence(eventResult.events, start, end),
    scheduleA: personSchedule(allPatterns, allSleepRules, user?.id),
    scheduleB: personSchedule(allPatterns, allSleepRules, partnerProfile?.id),
    user,
    partner: partnerProfile,
    labelA: displayName(user, 'You'),
    labelB: displayName(partnerProfile, 'Partner'),
    // Navigating changes the range, so refetch rather than re-slice.
    onRangeChange: () => renderCalendarGrid(mount),
  });
}

/**
 * Fetches the next 7 days of events and renders the ribbon, free windows
 * and upcoming list into the given element.
 * @param {HTMLElement} mount
 */
export async function renderCalendarDashboard(mount) {
  if (!mount) return;

  const rangeStart = startOfDay(new Date());
  const rangeEnd = new Date(rangeStart.getTime() + LOOKAHEAD_DAYS * 86400000);

  const result = await fetchEvents(rangeStart.toISOString(), rangeEnd.toISOString());

  if (!result.success) {
    mount.innerHTML = `<div class="empty-state">Could not load your schedule. Check your connection and try again.</div>`;
    return;
  }

  const instances = expandRecurrence(result.events, rangeStart, rangeEnd);

  const user = getCurrentUser();
  const partnerProfile = getPartner();
  const labelA = displayName(user, 'You');
  const labelB = displayName(partnerProfile, 'Partner');

  // Shift patterns and sleep rules for both people. Without these the engine
  // has no idea when either of you is asleep, and reports rest as free time.
  const userIds = [user?.id, partnerProfile?.id].filter(Boolean);
  const [patternResult, sleepResult] = await Promise.all([
    fetchShiftPatterns(userIds),
    fetchSleepRules(userIds),
  ]);
  const allPatterns = patternResult.success ? patternResult.patterns : [];
  const allSleepRules = sleepResult.success ? sleepResult.rules : [];

  const scheduleA = personSchedule(allPatterns, allSleepRules, user?.id);
  const scheduleB = personSchedule(allPatterns, allSleepRules, partnerProfile?.id);
  const hasSchedule = scheduleA.patterns.length > 0 || scheduleA.sleepRules.length > 0;

  const eventsA = instances.filter(ev => user && ev.user_id === user.id);
  const eventsB = instances.filter(ev => partnerProfile && ev.user_id === partnerProfile.id);

  // --- Today's ribbon (full day) ---
  const todayStart = new Date(rangeStart);
  todayStart.setHours(RIBBON_START_HOUR, 0, 0, 0);
  const todayEnd = new Date(rangeStart);
  todayEnd.setHours(0, 0, 0, 0);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const inToday = ev => new Date(ev.start_time) < todayEnd && new Date(ev.end_time) > todayStart;
  const todayInstances = instances.filter(inToday);

  const todayFree = bothFreeWindows({
    personAEvents: eventsA.filter(inToday),
    personBEvents: eventsB.filter(inToday),
    personA: scheduleA,
    personB: scheduleB,
    rangeStart: todayStart,
    rangeEnd: todayEnd,
  });

  const busyToday = todayInstances.filter(ev => ev.is_busy);
  const busyBlocksA = busyToday
    .filter(ev => user && ev.user_id === user.id)
    .map(toBlock);
  const busyBlocksB = busyToday
    .filter(ev => partnerProfile && ev.user_id === partnerProfile.id)
    .map(toBlock);

  // --- Week's free windows, ranked by quality (§1.5) ---
  const weekFree = bothFreeWindows({
    personAEvents: eventsA,
    personBEvents: eventsB,
    personA: scheduleA,
    personB: scheduleB,
    rangeStart,
    rangeEnd,
  });
  const weekWindows = weekFree.success ? weekFree.windows : [];
  // Windows arrive sorted by score. The hero shows the best one to spend time
  // together, which is not necessarily the soonest.
  const nextWindow = weekWindows[0] || null;
  const scheduleWarnings = weekFree.warnings || [];

  mount.innerHTML = `
    <div class="hero">
      <span class="hero-label">Next free together</span>
      <div class="hero-value">
        ${nextWindow
          ? `<span class="hero-num">${formatClock(nextWindow.start)}</span>
             <span class="hero-unit">${dayLabel(nextWindow.start)}</span>`
          : `<span class="hero-num">—</span>
             <span class="hero-unit">nothing in the next ${LOOKAHEAD_DAYS} days</span>`}
      </div>
      <div class="hero-sub">
        ${nextWindow
          ? `<span>until <time datetime="${nextWindow.end.toISOString()}">${formatClock(nextWindow.end)}</time></span>
             <span class="divider">·</span>
             <span class="num">${formatMinutes(minutesBetween(nextWindow))}</span>`
          : hasSchedule
            ? `<span>Nothing lines up in the next ${LOOKAHEAD_DAYS} days</span>`
            : `<span>Add your shift pattern and sleep to see real availability</span>`}
      </div>
    </div>

    ${!hasSchedule ? `
      <div class="notice notice--setup">
        <p>No shift pattern or sleep window set up yet, so every hour you are not
        in a logged event counts as free. Add them below and this page starts
        telling the truth.</p>
      </div>
    ` : ''}
    ${scheduleWarnings.length ? `
      <div class="notice notice--warning">
        ${scheduleWarnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}
      </div>
    ` : ''}

    <div class="stat-tiles">
      <div class="stat-tile stat-tile--shared">
        <span class="stat-tile-label">Free windows</span>
        <span class="stat-tile-value">${weekWindows.length}<small>next ${LOOKAHEAD_DAYS}d</small></span>
      </div>
      <div class="stat-tile stat-tile--a">
        <span class="stat-tile-label">${escapeHtml(labelA)} busy</span>
        <span class="stat-tile-value">${instances.filter(ev => ev.is_busy && user && ev.user_id === user.id).length}</span>
      </div>
      <div class="stat-tile stat-tile--b">
        <span class="stat-tile-label">${escapeHtml(labelB)} busy</span>
        <span class="stat-tile-value">${instances.filter(ev => ev.is_busy && partnerProfile && ev.user_id === partnerProfile.id).length}</span>
      </div>
    </div>

    <section>
      <div class="section-heading">
        <h3>Today</h3>
        <span class="section-meta">00:00–24:00</span>
      </div>
      <div id="ribbon-mount"></div>
    </section>

    <details class="disclosure mt-4" id="free-window-disclosure" open>
      <summary>
        <span>Mutual free time</span>
        <span class="disclosure-meta">${weekWindows.length}</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="free-window-mount"></div>
    </details>

    <details class="disclosure mt-4" id="event-list-disclosure">
      <summary>
        <span>Upcoming</span>
        <span class="disclosure-meta">${instances.length}</span>
        ${chevronSvg()}
      </summary>
      <div class="disclosure-body" id="event-list-mount"></div>
    </details>
  `;

  // Ribbon is built as DOM nodes, not markup
  const ribbonMount = mount.querySelector('#ribbon-mount');
  ribbonMount.appendChild(createOverlapRibbon({
    freeWindows: todayFree.success ? todayFree.windows : [],
    busyBlocksA,
    busyBlocksB,
    dayStart: todayStart,
    dayEnd: todayEnd,
    labelA,
    labelB,
    dayStartHour: RIBBON_START_HOUR,
    dayEndHour: RIBBON_END_HOUR,
  }));

  mount.querySelector('#free-window-mount').innerHTML =
    renderFreeWindowList(weekWindows);
  const eventListMount = mount.querySelector('#event-list-mount');
  eventListMount.innerHTML = renderEventList(instances, user, partnerProfile);
  wireEventList(eventListMount);
}

/**
 * Builds the mutual free window list markup.
 * @param {Array<{start: Date, end: Date}>} windows
 * @returns {string}
 */
export function renderFreeWindowList(windows) {
  if (!windows || windows.length === 0) {
    return `<div class="empty-state">No mutual free time in the next ${LOOKAHEAD_DAYS} days.</div>`;
  }

  // The first three are the headline output of the whole app (§1.5), so they
  // are marked rather than left to blend into a flat list.
  const items = windows.slice(0, 12).map((w, index) => `
    <div class="free-window${index < 3 ? ' free-window--top' : ''}">
      <span class="free-window-day">${dayLabel(w.start)}</span>
      <span class="free-window-time">
        <time datetime="${w.start.toISOString()}">${formatClock(w.start)}</time>–<time datetime="${w.end.toISOString()}">${formatClock(w.end)}</time>
      </span>
      <span class="free-window-duration">${formatMinutes(minutesBetween(w))}</span>
      ${typeof w.score === 'number'
        ? `<span class="free-window-score num" title="${escapeHtml(describeScore(w))}">${w.score}</span>`
        : ''}
    </div>
  `).join('');

  return `<div class="free-window-list">${items}</div>`;
}

/**
 * Plain-English breakdown of a window's quality score, for the tooltip.
 * @param {{score:number, scoreParts?:Object}} window
 * @returns {string}
 */
export function describeScore(window) {
  const parts = window.scoreParts;
  if (!parts) return `Score ${window.score}`;
  const bits = [
    `${parts.base} length`,
    `${parts.timeOfDay} time of day`,
  ];
  if (parts.weekend) bits.push(`${parts.weekend} weekend`);
  if (parts.buffer) bits.push(`${parts.buffer} breathing room`);
  if (parts.proximity) bits.push(`${parts.proximity} straight after a shift`);
  return `Score ${window.score} — ${bits.join(', ')}`;
}

/**
 * Builds the upcoming event list markup, accented by owner.
 * @param {Array} instances - Expanded event instances
 * @param {object|null} user
 * @param {object|null} partnerProfile
 * @returns {string}
 */
export function renderEventList(instances, user, partnerProfile) {
  if (!instances || instances.length === 0) {
    return `<div class="empty-state">No events in the next ${LOOKAHEAD_DAYS} days. Add one below.</div>`;
  }

  const sorted = [...instances].sort(
    (a, b) => new Date(a.start_time) - new Date(b.start_time)
  );

  const visible = sorted.slice(0, 20);
  // Held for the wiring pass, so an event object never has to be serialised
  // into a DOM attribute and parsed back out.
  lastRenderedInstances = visible;

  const items = visible.map((ev, index) => {
    const start = new Date(ev.start_time);
    const end = new Date(ev.end_time);
    const isUsers = user && ev.user_id === user.id;
    const ownerClass = isUsers
      ? 'event-item--a'
      : (partnerProfile && ev.user_id === partnerProfile.id ? 'event-item--b' : '');
    const ownerName = isUsers
      ? displayName(user, 'You')
      : displayName(partnerProfile, 'Partner');
    const repeats = Boolean(ev._isRecurrenceInstance || ev.rrule);

    return `
      <div class="event-item ${ownerClass}">
        <span class="event-time">
          ${dayLabel(start)} <time datetime="${start.toISOString()}">${formatClock(start)}</time>–<time datetime="${end.toISOString()}">${formatClock(end)}</time>
        </span>
        <span class="event-title">${escapeHtml(ev.title || 'Untitled')}</span>
        <span class="event-owner">${escapeHtml(ownerName)}</span>
        ${isUsers ? `
          <span class="event-actions">
            <button type="button" class="icon-btn" data-edit="${index}"
              aria-label="Edit ${escapeHtml(ev.title || 'event')}${repeats ? ', repeating' : ''}">Edit</button>
            <button type="button" class="icon-btn" data-delete="${index}"
              aria-label="Delete ${escapeHtml(ev.title || 'event')}${repeats ? ', repeating' : ''}">Delete</button>
          </span>
        ` : ''}
      </div>
    `;
  }).join('');

  return `<div class="event-list">${items}</div>`;
}

// The instances behind the most recent renderEventList call.
let lastRenderedInstances = [];

/**
 * Asks whether an action applies to one occurrence or the whole series.
 *
 * Only shown for repeating events — asking for a one-off would be a pointless
 * extra tap. Uses a native <dialog> so focus trapping and Escape come from the
 * platform rather than from hand-rolled key handling.
 *
 * @returns {Promise<'occurrence'|'series'|null>} null if dismissed
 */
export function askRecurrenceScope(verb, title) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'scope-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="scope-dialog-body">
        <h3 class="card-title">${escapeHtml(verb)} “${escapeHtml(title || 'this event')}”</h3>
        <p class="field-hint">This event repeats. What should change?</p>
        <div class="scope-dialog-actions">
          <button type="submit" value="occurrence" class="btn btn-primary">Just this one</button>
          <button type="submit" value="series" class="btn btn-secondary">The whole series</button>
          <button type="submit" value="" class="btn btn-ghost">Cancel</button>
        </div>
      </form>
    `;

    document.body.appendChild(dialog);
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue;
      dialog.remove();
      resolve(value === 'occurrence' || value === 'series' ? value : null);
    });

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else resolve(null); // No <dialog> support: caller falls back.
  });
}

/**
 * Wires the edit and delete controls on the event list.
 *
 * updateEvent and deleteEvent have existed and been exported since the
 * calendar was written, but nothing ever called them — there were no controls
 * to call them from, which is why events could be created and never changed.
 */
export function wireEventList(mount) {
  if (!mount) return;

  mount.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const instance = lastRenderedInstances[Number(button.dataset.edit)];
      if (!instance) return;

      let scope = 'series';
      if (instance._isRecurrenceInstance) {
        scope = await askRecurrenceScope('Edit', instance.title);
        if (!scope) return;
      }
      beginEditingEvent(instance, scope, document);
    });
  });

  mount.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', async () => {
      const instance = lastRenderedInstances[Number(button.dataset.delete)];
      if (!instance) return;

      let result;
      if (instance._isRecurrenceInstance) {
        const scope = await askRecurrenceScope('Delete', instance.title);
        if (!scope) return;

        result = scope === 'occurrence'
          ? await cancelOccurrence(instance._originalEventId, instance._originalStart)
          : await deleteEvent(instance._originalEventId);
      } else {
        // Deleting is not undoable, so it asks first.
        if (!window.confirm(`Delete “${instance.title || 'this event'}”?`)) return;
        result = await deleteEvent(instance.id);
      }

      if (!result.success) {
        showToast(result.errors?._form || 'Could not delete that event', 'error');
        return;
      }

      // The form may be sitting open on the row that just went away.
      if (editingContext) {
        const editedId = editingContext.instance._originalEventId || editingContext.instance.id;
        const deletedId = instance._originalEventId || instance.id;
        if (editedId === deletedId) {
          stopEditingEvent(document.querySelector('#event-form'));
        }
      }

      showToast('Event deleted', 'success');
      refreshCalendarView();
    });
  });
}

// --- Formatting helpers ---

/** Maps an event record to the {start, end} shape the ribbon expects */
function toBlock(ev) {
  return { start: new Date(ev.start_time), end: new Date(ev.end_time), userId: ev.user_id };
}

/** Midnight on the given date, local time */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Minutes spanned by a window */
function minutesBetween(window) {
  return Math.round((window.end.getTime() - window.start.getTime()) / 60000);
}

/** 24-hour clock, zero padded: "08:30" */
function formatClock(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** "Today", "Tomorrow", else "Mon 14 Apr" */
function dayLabel(date) {
  const today = startOfDay(new Date());
  const target = startOfDay(date);
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return target.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "2h 15m" / "45m" */
function formatMinutes(minutes) {
  if (!minutes || minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export { formatMinutes as formatFreeDuration };
