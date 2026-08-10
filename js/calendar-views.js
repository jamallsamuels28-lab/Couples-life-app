// ============================================================
// Calendar Views — month / week / day
// ============================================================
//
// The familiar shape from Google or Samsung Calendar, held inside this app's
// design system: greyscale chassis, two identity hues, no third colour.
//
// The one thing a general-purpose calendar cannot show you is drawn here as a
// first-class layer — each person's shift and sleep, rendered as background
// bands behind the events. That is the whole reason this app exists rather
// than a shared Google calendar.
// ============================================================

import { escapeHtml } from './ui-helpers.js';
import { materialiseShifts, materialiseSleep } from './free-windows.js';

const DAY_MS = 86400000;
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** Week starts Monday, as it does everywhere outside North America. */
const WEEK_START = 1;

/** Hour band drawn in week and day views. Full day; sleep is content, not chrome. */
const GRID_START_HOUR = 0;
const GRID_END_HOUR = 24;

/** Module-level view state, persisted so a refresh does not lose your place. */
const state = {
  mode: readStoredMode(),
  anchor: startOfDay(new Date()),
};

export function getViewState() {
  return { mode: state.mode, anchor: new Date(state.anchor) };
}

export function setViewState({ mode, anchor } = {}) {
  if (mode && ['month', 'week', 'day'].includes(mode)) {
    state.mode = mode;
    try { localStorage.setItem('calendar-view-mode', mode); } catch { /* private mode */ }
  }
  if (anchor instanceof Date && !isNaN(anchor.getTime())) {
    state.anchor = startOfDay(anchor);
  }
}

// ------------------------------------------------------------
// Range helpers
// ------------------------------------------------------------

/**
 * The date range the current view needs loading.
 * @returns {{ start: Date, end: Date }}
 */
export function visibleRange(mode = state.mode, anchor = state.anchor) {
  if (mode === 'day') {
    return { start: startOfDay(anchor), end: addDays(startOfDay(anchor), 1) };
  }
  if (mode === 'week') {
    const start = startOfWeek(anchor);
    return { start, end: addDays(start, 7) };
  }
  // Month view shows leading and trailing days from the adjacent months.
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = startOfWeek(first);
  return { start, end: addDays(start, 42) };
}

/** Moves the anchor one unit in the given direction (-1 back, +1 forward). */
export function step(direction) {
  if (state.mode === 'day') {
    state.anchor = addDays(state.anchor, direction);
  } else if (state.mode === 'week') {
    state.anchor = addDays(state.anchor, 7 * direction);
  } else {
    state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + direction, 1);
  }
  return new Date(state.anchor);
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

/**
 * Renders the whole calendar surface: header, grid, and legend.
 *
 * @param {HTMLElement} container
 * @param {Object} data
 * @param {Array} data.instances - expanded event instances for the visible range
 * @param {Object} data.scheduleA - { patterns, sleepRules } for the signed-in user
 * @param {Object} data.scheduleB - { patterns, sleepRules } for the partner
 * @param {Object|null} data.user
 * @param {Object|null} data.partner
 * @param {string} data.labelA
 * @param {string} data.labelB
 * @param {Function} [data.onSelectDay] - called with a Date when a day is opened
 */
export function renderCalendarViews(container, data) {
  if (!container) return;

  const { start, end } = visibleRange();
  const bands = buildBands(data, start, end);

  container.innerHTML = `
    ${renderHeader(data)}
    <div class="cal-surface" id="cal-surface">
      ${state.mode === 'month' ? renderMonth(data, start) : ''}
      ${state.mode === 'week' ? renderTimeGrid(data, bands, start, 7) : ''}
      ${state.mode === 'day' ? renderTimeGrid(data, bands, startOfDay(state.anchor), 1) : ''}
    </div>
    ${renderLegend(data)}
  `;

  wire(container, data);
}

function renderHeader(data) {
  const title = state.mode === 'month'
    ? `${MONTHS[state.anchor.getMonth()]} ${state.anchor.getFullYear()}`
    : state.mode === 'week'
      ? weekTitle(startOfWeek(state.anchor))
      : `${DAY_SHORT[mondayIndex(state.anchor)]} ${state.anchor.getDate()} ${MONTHS[state.anchor.getMonth()].slice(0, 3)}`;

  return `
    <div class="cal-header">
      <div class="cal-header-main">
        <h3 class="cal-title">${escapeHtml(title)}</h3>
        <div class="cal-nav">
          <button type="button" class="cal-nav-btn" data-step="-1" aria-label="Previous ${state.mode}">
            ${arrowSvg('left')}
          </button>
          <button type="button" class="cal-nav-btn cal-today" data-today>Today</button>
          <button type="button" class="cal-nav-btn" data-step="1" aria-label="Next ${state.mode}">
            ${arrowSvg('right')}
          </button>
        </div>
      </div>
      <div class="seg" role="group" aria-label="Calendar view">
        ${['month', 'week', 'day'].map(mode => `
          <button type="button" data-mode="${mode}" aria-pressed="${state.mode === mode}">
            ${mode[0].toUpperCase()}${mode.slice(1)}
          </button>
        `).join('')}
      </div>
    </div>
  `;
}

// --- Month ----------------------------------------------------

function renderMonth(data, gridStart) {
  const today = startOfDay(new Date());
  const month = state.anchor.getMonth();

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const day = addDays(gridStart, i);
    const dayEvents = eventsOnDay(data.instances, day)
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

    const outside = day.getMonth() !== month;
    const isToday = day.getTime() === today.getTime();

    // Three chips fit before the cell gets noisy; the rest collapse to a count.
    const shown = dayEvents.slice(0, 3);
    const overflow = dayEvents.length - shown.length;

    cells.push(`
      <button type="button"
        class="cal-cell${outside ? ' cal-cell--outside' : ''}${isToday ? ' cal-cell--today' : ''}"
        data-date="${dateKey(day)}"
        aria-label="${escapeHtml(fullDateLabel(day))}, ${dayEvents.length} event${dayEvents.length === 1 ? '' : 's'}">
        <span class="cal-cell-date num">${day.getDate()}</span>
        <span class="cal-cell-events">
          ${shown.map(ev => `
            <span class="cal-chip ${ownerClass(ev, data)}" title="${escapeHtml(ev.title || '')}">
              <span class="cal-chip-time num">${clock(new Date(ev.start_time))}</span>
              <span class="cal-chip-title">${escapeHtml(ev.title || 'Untitled')}</span>
            </span>
          `).join('')}
          ${overflow > 0 ? `<span class="cal-more num">+${overflow}</span>` : ''}
        </span>
      </button>
    `);
  }

  return `
    <div class="cal-month">
      <div class="cal-weekdays" aria-hidden="true">
        ${DAY_LETTERS.map((letter, i) => `<span class="cal-weekday">${letter}<span class="visually-hidden">${DAY_SHORT[i]}</span></span>`).join('')}
      </div>
      <div class="cal-grid" role="grid">${cells.join('')}</div>
    </div>
  `;
}

// --- Week and day (shared time grid) --------------------------

function renderTimeGrid(data, bands, gridStart, dayCount) {
  const today = startOfDay(new Date());
  const hours = [];
  for (let h = GRID_START_HOUR; h < GRID_END_HOUR; h++) {
    hours.push(`<span class="cal-hour num">${String(h).padStart(2, '0')}</span>`);
  }

  const columns = [];
  for (let i = 0; i < dayCount; i++) {
    const day = addDays(gridStart, i);
    const isToday = day.getTime() === today.getTime();

    columns.push(`
      <div class="cal-col${isToday ? ' cal-col--today' : ''}" data-date="${dateKey(day)}">
        ${renderBands(bands, day)}
        ${renderHourLines()}
        ${renderDayEvents(data, day)}
        ${isToday ? renderNowLine() : ''}
      </div>
    `);
  }

  return `
    <div class="cal-timegrid" data-days="${dayCount}">
      <div class="cal-daylabels">
        <span class="cal-gutter-spacer"></span>
        ${Array.from({ length: dayCount }, (_, i) => {
          const day = addDays(gridStart, i);
          const isToday = day.getTime() === today.getTime();
          return `
            <button type="button" class="cal-daylabel${isToday ? ' cal-daylabel--today' : ''}" data-date="${dateKey(day)}">
              <span class="cal-daylabel-name">${DAY_SHORT[mondayIndex(day)]}</span>
              <span class="cal-daylabel-num num">${day.getDate()}</span>
            </button>
          `;
        }).join('')}
      </div>
      <div class="cal-scroll">
        <div class="cal-gutter">${hours.join('')}</div>
        <div class="cal-cols">${columns.join('')}</div>
      </div>
    </div>
  `;
}

/**
 * Shift and sleep drawn behind the events. Shift takes the owner's identity
 * hue at low opacity; sleep takes the hatch from the design system, because
 * it is the same substance in the overlap ribbon and should read the same way.
 */
function renderBands(bands, day) {
  const dayStart = day.getTime();
  const dayEnd = dayStart + DAY_MS;

  return bands
    .filter(b => b.start < dayEnd && b.end > dayStart)
    .map((b) => {
      const top = pct(Math.max(b.start, dayStart) - dayStart);
      const height = pct(Math.min(b.end, dayEnd) - Math.max(b.start, dayStart));
      const cls = b.kind === 'sleep' ? 'cal-band--sleep' : `cal-band--shift cal-band--${b.person}`;
      return `<div class="cal-band ${cls}" style="top:${top};height:${height}" aria-hidden="true"></div>`;
    })
    .join('');
}

function renderHourLines() {
  return Array.from({ length: GRID_END_HOUR - GRID_START_HOUR }, (_, i) =>
    `<div class="cal-hourline" style="top:${(i / (GRID_END_HOUR - GRID_START_HOUR) * 100).toFixed(4)}%" aria-hidden="true"></div>`
  ).join('');
}

function renderDayEvents(data, day) {
  const dayStart = day.getTime();
  const dayEnd = dayStart + DAY_MS;

  const events = eventsOnDay(data.instances, day)
    .map(ev => ({
      ev,
      start: new Date(ev.start_time).getTime(),
      end: new Date(ev.end_time).getTime(),
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const lanes = assignLanes(events);
  const laneCount = Math.max(1, ...lanes.map(l => l.lane + 1));

  return lanes.map(({ ev, start, end, lane }) => {
    const top = pct(Math.max(start, dayStart) - dayStart);
    const height = pct(Math.max(Math.min(end, dayEnd) - Math.max(start, dayStart), 15 * 60000));
    const width = 100 / laneCount;
    return `
      <button type="button" class="cal-event ${ownerClass(ev, data)}"
        style="top:${top};height:${height};left:${(lane * width).toFixed(3)}%;width:${width.toFixed(3)}%"
        data-event-id="${escapeHtml(ev.id || '')}"
        title="${escapeHtml(ev.title || '')} · ${clock(new Date(start))}–${clock(new Date(end))}">
        <span class="cal-event-title">${escapeHtml(ev.title || 'Untitled')}</span>
        <span class="cal-event-time num">${clock(new Date(start))}</span>
      </button>
    `;
  }).join('');
}

/**
 * Places overlapping events side by side, the way every calendar does.
 * Greedy: an event takes the first lane whose last event has already ended.
 */
export function assignLanes(events) {
  const laneEnds = [];
  return events.map((item) => {
    let lane = laneEnds.findIndex(endsAt => endsAt <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    return { ...item, lane };
  });
}

function renderNowLine() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return `<div class="cal-now" style="top:${(minutes / 1440 * 100).toFixed(4)}%" aria-hidden="true"></div>`;
}

function renderLegend(data) {
  return `
    <div class="cal-legend">
      <span class="cal-legend-item"><i class="cal-swatch cal-swatch--a"></i>${escapeHtml(data.labelA || 'You')}</span>
      <span class="cal-legend-item"><i class="cal-swatch cal-swatch--b"></i>${escapeHtml(data.labelB || 'Partner')}</span>
      <span class="cal-legend-item"><i class="cal-swatch cal-swatch--shared"></i>Shared</span>
      <span class="cal-legend-item"><i class="cal-swatch cal-swatch--sleep"></i>Sleep</span>
    </div>
  `;
}

// ------------------------------------------------------------
// Behaviour
// ------------------------------------------------------------

function wire(container, data) {
  const rerender = () => renderCalendarViews(container, data);

  container.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      setViewState({ mode: button.dataset.mode });
      requestReload(container, data);
    });
  });

  container.querySelectorAll('[data-step]').forEach((button) => {
    button.addEventListener('click', () => {
      step(Number(button.dataset.step));
      requestReload(container, data);
    });
  });

  const todayButton = container.querySelector('[data-today]');
  if (todayButton) {
    todayButton.addEventListener('click', () => {
      setViewState({ anchor: new Date() });
      requestReload(container, data);
    });
  }

  // Opening a day from the month grid or a week column header.
  container.querySelectorAll('.cal-cell, .cal-daylabel').forEach((element) => {
    element.addEventListener('click', () => {
      const date = parseDateKey(element.dataset.date);
      if (!date) return;
      setViewState({ mode: 'day', anchor: date });
      requestReload(container, data);
    });
  });

  container.querySelectorAll('.cal-event').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = element.dataset.eventId;
      if (id) window.dispatchEvent(new CustomEvent('calendar:edit-event', { detail: { id } }));
    });
  });

  // Arrow keys move through the calendar the way they do in a native one.
  const surface = container.querySelector('#cal-surface');
  if (surface) {
    surface.tabIndex = 0;
    surface.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') { step(-1); requestReload(container, data); }
      else if (event.key === 'ArrowRight') { step(1); requestReload(container, data); }
      else if (event.key.toLowerCase() === 't') { setViewState({ anchor: new Date() }); requestReload(container, data); }
      else return;
      event.preventDefault();
    });
  }

  // Week and day open scrolled to the evening rather than to 00:00, because
  // the small hours are almost never what you came to look at.
  const scroll = container.querySelector('.cal-scroll');
  if (scroll) {
    const focusHour = state.mode === 'day' || state.mode === 'week' ? 7 : 0;
    scroll.scrollTop = scroll.scrollHeight * (focusHour / 24);
  }

  void rerender;
}

/**
 * Asks the host to refetch for the new range. The host owns the data, so the
 * view never fetches for itself — that keeps a single source of truth for what
 * is loaded and avoids two components racing on the same range.
 */
function requestReload(container, data) {
  const { start, end } = visibleRange();
  if (typeof data.onRangeChange === 'function') {
    data.onRangeChange({ start, end, mode: state.mode });
  } else {
    renderCalendarViews(container, data);
  }
}

// ------------------------------------------------------------
// Data shaping
// ------------------------------------------------------------

/**
 * Shift and sleep blocks for both people across the range, tagged by person
 * so the view can colour them.
 */
function buildBands(data, start, end) {
  const bands = [];
  const people = [
    { schedule: data.scheduleA, person: 'a' },
    { schedule: data.scheduleB, person: 'b' },
  ];

  for (const { schedule, person } of people) {
    if (!schedule) continue;
    const shifts = materialiseShifts({
      patterns: schedule.patterns, rangeStart: start, rangeEnd: end,
    });
    const sleep = materialiseSleep({
      patterns: schedule.patterns, sleepRules: schedule.sleepRules,
      rangeStart: start, rangeEnd: end,
    });
    bands.push(
      ...shifts.blocks.map(b => ({ ...b, person })),
      ...sleep.blocks.map(b => ({ ...b, person })),
    );
  }
  return bands;
}

function eventsOnDay(instances, day) {
  const dayStart = day.getTime();
  const dayEnd = dayStart + DAY_MS;
  return (instances || []).filter((ev) => {
    const start = new Date(ev.start_time).getTime();
    const finish = new Date(ev.end_time).getTime();
    return start < dayEnd && finish > dayStart;
  });
}

function ownerClass(event, data) {
  if (data.user && event.user_id === data.user.id) return 'is-a';
  if (data.partner && event.user_id === data.partner.id) return 'is-b';
  return 'is-shared';
}

// ------------------------------------------------------------
// Date helpers
// ------------------------------------------------------------

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date, count) {
  const d = new Date(date);
  d.setDate(d.getDate() + count);
  return d;
}

/** Monday-first start of week. */
export function startOfWeek(date) {
  const d = startOfDay(date);
  const shift = (d.getDay() - WEEK_START + 7) % 7;
  d.setDate(d.getDate() - shift);
  return d;
}

/** 0 = Monday .. 6 = Sunday, for indexing DAY_SHORT. */
function mondayIndex(date) {
  return (date.getDay() + 6) % 7;
}

export function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return null;
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function clock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function pct(ms) {
  return `${(ms / DAY_MS * 100).toFixed(4)}%`;
}

function weekTitle(start) {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const left = `${start.getDate()} ${MONTHS[start.getMonth()].slice(0, 3)}`;
  const right = sameMonth
    ? `${end.getDate()} ${MONTHS[end.getMonth()].slice(0, 3)}`
    : `${end.getDate()} ${MONTHS[end.getMonth()].slice(0, 3)}`;
  return `${left} – ${right} ${end.getFullYear()}`;
}

function fullDateLabel(date) {
  return `${DAY_SHORT[mondayIndex(date)]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function readStoredMode() {
  try {
    const stored = localStorage.getItem('calendar-view-mode');
    return ['month', 'week', 'day'].includes(stored) ? stored : 'month';
  } catch {
    return 'month';
  }
}

/** Stroked, 1.5px, 20px box — the icon rule from the design system. */
function arrowSvg(direction) {
  const d = direction === 'left' ? 'M12.5 15 7.5 10l5-5' : 'M7.5 5l5 5-5 5';
  return `<svg viewBox="0 0 20 20" width="20" height="20" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
