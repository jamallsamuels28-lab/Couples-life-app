// ============================================================
// Free Windows Module — Couples Life App
// Implements kiro-algorithm-spec.md §1.3, §1.4 and §1.5
// ============================================================
//
// WHAT CHANGED AND WHY
//
// The previous implementation assumed a single shared waking band
// (DAY_START_HOUR = 8, DAY_END_HOUR = 23) for both partners and treated
// anything outside it as unavailable, anything inside it as available.
// For a night-shift worker that is precisely backwards: sleeping 09:30–17:30
// sat entirely inside the "waking" band and was therefore reported as free,
// while genuinely free time after 23:00 was discarded.
//
// Per §1.4 there is no fixed dayStartHour. Waking hours are DERIVED from each
// person's shift context: sleep is materialised as busy blocks from their
// shift pattern or sleep rules, and free time is simply the complement of
// everything busy.
// ============================================================

const MINUTES = 60000;
const DAY_MS = 24 * 60 * MINUTES;

/** Default busy weight when an event does not specify one. */
const DEFAULT_BUSY_WEIGHT = 100;

/** Weight at or above which an interval blocks the calendar (§1.3). */
const DEFAULT_BUSY_THRESHOLD = 50;

/** An evening shift start (local hour) implies the pre-night-shift sleep context. */
const EVENING_SHIFT_HOUR = 18;

// ------------------------------------------------------------
// Interval primitives
// ------------------------------------------------------------

/**
 * Merges weighted intervals into a sorted, non-overlapping union (§1.3).
 * Only intervals at or above `threshold` block the calendar, so a soft
 * commitment (weight 50 by convention, or lower) can be scheduled over.
 *
 * O(n log n). Handles back-to-back and fully nested intervals, which naive
 * pairwise comparison does not.
 *
 * @param {Array<{start:number, end:number, weight?:number}>} intervals
 * @param {number} [threshold=50]
 * @returns {Array<{start:number, end:number}>}
 */
export function mergeBusy(intervals, threshold = DEFAULT_BUSY_THRESHOLD) {
  const hard = intervals
    .filter((i) => (i.weight === undefined ? DEFAULT_BUSY_WEIGHT : i.weight) >= threshold)
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (const iv of hard) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/**
 * Returns the gaps between merged busy blocks across [rangeStart, rangeEnd),
 * including the head and tail of the range (§1.4 step 4).
 *
 * @param {Array<{start:number, end:number}>} merged - sorted, non-overlapping
 * @param {number} rangeStart
 * @param {number} rangeEnd
 * @returns {Array<{start:number, end:number}>}
 */
export function complement(merged, rangeStart, rangeEnd) {
  const free = [];
  let cursor = rangeStart;

  for (const { start, end } of merged) {
    if (end <= cursor) continue;
    if (start >= rangeEnd) break;
    if (start > cursor) free.push({ start: cursor, end: Math.min(start, rangeEnd) });
    cursor = Math.max(cursor, end);
    if (cursor >= rangeEnd) break;
  }

  if (cursor < rangeEnd) free.push({ start: cursor, end: rangeEnd });
  return free;
}

// ------------------------------------------------------------
// Sleep materialisation (§1.4 step 2)
// ------------------------------------------------------------

/**
 * Parses a 'HH:MM' or 'HH:MM:SS' local time into minutes past midnight.
 * @param {string} value
 * @returns {number|null}
 */
export function timeToMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Selects the shift pattern in force for a given date (§1.1b resolution rule).
 * Exactly one row should match. More than one means the versioning logic is
 * broken upstream, so this surfaces an error rather than picking arbitrarily.
 *
 * @param {Array<Object>} patterns - rows from shift_patterns for one person
 * @param {Date} date - local date to resolve
 * @returns {{ pattern: Object|null, error?: string }}
 */
export function resolvePattern(patterns, date) {
  if (!Array.isArray(patterns) || patterns.length === 0) return { pattern: null };

  const dayKey = toDateKey(date);
  const dow = date.getDay(); // 0 = Sunday .. 6 = Saturday

  const matches = patterns.filter((p) => {
    const from = typeof p.valid_from === 'string' ? p.valid_from : toDateKey(toDate(p.valid_from));
    const to = p.valid_to
      ? (typeof p.valid_to === 'string' ? p.valid_to : toDateKey(toDate(p.valid_to)))
      : null;
    if (!from || from > dayKey) return false;
    if (to && to < dayKey) return false;
    const days = p.days_of_week || p.daysOfWeek || [];
    return days.includes(dow);
  });

  if (matches.length > 1) {
    return {
      pattern: null,
      error: `Overlapping shift patterns for ${dayKey}: ${matches.length} rows matched. Close the previous pattern with valid_to before adding a new one.`,
    };
  }
  return { pattern: matches[0] || null };
}

/**
 * Determines the sleep context for a person on a given day (§1.4 step 2).
 *
 * post_night_shift — a shift that began the previous evening ends this morning
 * pre_night_shift  — a shift begins this evening
 * default          — everything else
 *
 * @param {Array<Object>} patterns
 * @param {Date} day - local midnight of the day in question
 * @returns {{ context: string, pattern: Object|null, previousPattern: Object|null, error?: string }}
 */
export function resolveSleepContext(patterns, day) {
  const today = resolvePattern(patterns, day);
  if (today.error) return { context: 'default', pattern: null, previousPattern: null, error: today.error };

  const previousDay = new Date(day.getTime());
  previousDay.setDate(previousDay.getDate() - 1);
  const yesterday = resolvePattern(patterns, previousDay);

  const crossesMidnight = (p) => {
    if (!p) return false;
    const start = timeToMinutes(p.start_local ?? p.startLocal);
    const end = timeToMinutes(p.end_local ?? p.endLocal);
    return start !== null && end !== null && end < start;
  };

  if (crossesMidnight(yesterday.pattern)) {
    return { context: 'post_night_shift', pattern: today.pattern, previousPattern: yesterday.pattern };
  }

  const todayStart = today.pattern
    ? timeToMinutes(today.pattern.start_local ?? today.pattern.startLocal)
    : null;
  if (todayStart !== null && todayStart >= EVENING_SHIFT_HOUR * 60) {
    return { context: 'pre_night_shift', pattern: today.pattern, previousPattern: yesterday.pattern };
  }

  return { context: 'default', pattern: today.pattern, previousPattern: yesterday.pattern };
}

/**
 * Materialises sleep as busy intervals across a range for one person.
 *
 * A shift pattern carrying its own sleep_start/sleep_end wins, because it is
 * the more specific statement of when this person sleeps on this rota. The
 * matching sleep_rules row for the resolved context is the fallback.
 *
 * Intervals are emitted in absolute milliseconds and may cross midnight;
 * splitting at midnight is a rendering concern, not a maths one.
 *
 * @param {Object} params
 * @param {Array<Object>} params.patterns - shift_patterns rows for this person
 * @param {Array<Object>} params.sleepRules - sleep_rules rows for this person
 * @param {Date} params.rangeStart
 * @param {Date} params.rangeEnd
 * @returns {{ blocks: Array<{start:number,end:number,weight:number,kind:string}>, warnings: string[] }}
 */
export function materialiseSleep({ patterns = [], sleepRules = [], rangeStart, rangeEnd }) {
  const blocks = [];
  const warnings = [];

  // Start a day early: sleep beginning the previous evening can run into range.
  const cursor = new Date(rangeStart.getTime());
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 1);

  const endTime = rangeEnd.getTime();

  while (cursor.getTime() < endTime) {
    const day = new Date(cursor.getTime());
    const { context, pattern, error } = resolveSleepContext(patterns, day);
    if (error && !warnings.includes(error)) warnings.push(error);

    let startMin = null;
    let endMin = null;

    const patternSleepStart = pattern ? timeToMinutes(pattern.sleep_start ?? pattern.sleepStart) : null;
    const patternSleepEnd = pattern ? timeToMinutes(pattern.sleep_end ?? pattern.sleepEnd) : null;

    if (patternSleepStart !== null && patternSleepEnd !== null) {
      startMin = patternSleepStart;
      endMin = patternSleepEnd;
    } else {
      const rule = sleepRules.find((r) => r.context === context)
        || sleepRules.find((r) => r.context === 'default');
      if (rule) {
        startMin = timeToMinutes(rule.start_local ?? rule.startLocal);
        endMin = timeToMinutes(rule.end_local ?? rule.endLocal);
      }
    }

    if (startMin !== null && endMin !== null && startMin !== endMin) {
      const start = day.getTime() + startMin * MINUTES;
      // An end earlier than the start means the interval runs into the next day.
      const end = day.getTime() + endMin * MINUTES + (endMin < startMin ? DAY_MS : 0);
      blocks.push({ start, end, weight: 100, kind: 'sleep' });
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return { blocks, warnings };
}

/**
 * Materialises shift work as busy intervals from patterns (§1.1b).
 * One-off deviations live in `events` and take precedence, so callers should
 * pass events through as well — events are the truth, the pattern is the default.
 *
 * @param {Object} params
 * @returns {{ blocks: Array<{start:number,end:number,weight:number,kind:string}>, warnings: string[] }}
 */
export function materialiseShifts({ patterns = [], rangeStart, rangeEnd }) {
  const blocks = [];
  const warnings = [];

  const cursor = new Date(rangeStart.getTime());
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 1);

  const endTime = rangeEnd.getTime();

  while (cursor.getTime() < endTime) {
    const day = new Date(cursor.getTime());
    const { pattern, error } = resolvePattern(patterns, day);
    if (error && !warnings.includes(error)) warnings.push(error);

    if (pattern) {
      const startMin = timeToMinutes(pattern.start_local ?? pattern.startLocal);
      const endMin = timeToMinutes(pattern.end_local ?? pattern.endLocal);
      if (startMin !== null && endMin !== null && startMin !== endMin) {
        const start = day.getTime() + startMin * MINUTES;
        const end = day.getTime() + endMin * MINUTES + (endMin < startMin ? DAY_MS : 0);
        blocks.push({ start, end, weight: 100, kind: 'shift' });
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return { blocks, warnings };
}

// ------------------------------------------------------------
// Window quality score (§1.5)
// ------------------------------------------------------------

/**
 * Scores a free window. Not all free time is equal — 45 minutes at 04:00 is
 * not a date night.
 *
 * base      up to 40, saturating at three hours
 * timeOfDay 30 evening / 20 afternoon / 10 morning / 0 otherwise
 * weekend   15 on Saturday or Sunday
 * buffer    15 if at least 60 min clear of hard-busy on both sides, 5 if 30
 * proximity −10 if it starts within 90 min of either person's shift ending
 *
 * @param {{start:number, end:number}} window
 * @param {Array<{start:number, end:number}>} merged - merged hard-busy blocks
 * @param {Array<number>} shiftEnds - shift end timestamps for both people
 * @returns {{ score:number, parts:Object }}
 */
export function scoreWindow(window, merged = [], shiftEnds = []) {
  const durationMinutes = (window.end - window.start) / MINUTES;
  const base = Math.min(durationMinutes / 180, 1) * 40;

  const startDate = new Date(window.start);
  const hour = startDate.getHours() + startDate.getMinutes() / 60;

  let timeOfDay = 0;
  if (hour >= 17 && hour < 22) timeOfDay = 30;
  else if (hour >= 11 && hour < 17) timeOfDay = 20;
  else if (hour >= 8 && hour < 11) timeOfDay = 10;

  const dow = startDate.getDay();
  const weekend = dow === 0 || dow === 6 ? 15 : 0;

  // Gap to the nearest hard-busy block on each side. A window that begins or
  // ends the range has no adjacent block on that side, which counts as clear.
  let gapBefore = Infinity;
  let gapAfter = Infinity;
  for (const block of merged) {
    if (block.end <= window.start) gapBefore = Math.min(gapBefore, (window.start - block.end) / MINUTES);
    if (block.start >= window.end) gapAfter = Math.min(gapAfter, (block.start - window.end) / MINUTES);
  }
  const tightest = Math.min(gapBefore, gapAfter);
  let buffer = 0;
  if (tightest >= 60) buffer = 15;
  else if (tightest >= 30) buffer = 5;

  // Nobody wants to socialise in the ninety minutes after a shift ends.
  const proximity = shiftEnds.some(
    (t) => window.start >= t && window.start - t <= 90 * MINUTES
  ) ? -10 : 0;

  const score = base + timeOfDay + weekend + buffer + proximity;
  return {
    score: Math.round(score),
    parts: { base: Math.round(base), timeOfDay, weekend, buffer, proximity },
  };
}

// ------------------------------------------------------------
// Main entry point (§1.4)
// ------------------------------------------------------------

/**
 * Computes windows where neither partner is busy or asleep, scored and ranked.
 *
 * @param {Object} params
 * @param {Array<Object>} params.personAEvents - expanded instances for A
 * @param {Array<Object>} params.personBEvents - expanded instances for B
 * @param {Object} [params.personA] - { patterns, sleepRules } for A
 * @param {Object} [params.personB] - { patterns, sleepRules } for B
 * @param {Date|string} params.rangeStart
 * @param {Date|string} params.rangeEnd
 * @param {Object} [params.options]
 * @param {number} [params.options.minMinutes=45]
 * @param {number} [params.options.busyThreshold=50]
 * @returns {{ success:true, windows:Array, warnings:string[] } | { success:false, error:string }}
 */
export function bothFreeWindows({
  personAEvents = [],
  personBEvents = [],
  personA = {},
  personB = {},
  rangeStart,
  rangeEnd,
  options = {},
} = {}) {
  const start = toDate(rangeStart);
  const end = toDate(rangeEnd);

  if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { success: false, error: 'Invalid date range: rangeStart and rangeEnd must be valid dates' };
  }
  if (start >= end) {
    return { success: false, error: 'Invalid date range: rangeStart must be before rangeEnd' };
  }
  if ((end.getTime() - start.getTime()) / DAY_MS > 31) {
    return { success: false, error: 'Invalid date range: range must not exceed 31 days' };
  }

  const minMinutes = options.minMinutes !== undefined ? options.minMinutes : 45;
  if (typeof minMinutes !== 'number' || minMinutes < 5 || minMinutes > 480) {
    return { success: false, error: 'Invalid option: minMinutes must be between 5 and 480' };
  }
  const busyThreshold = options.busyThreshold !== undefined ? options.busyThreshold : DEFAULT_BUSY_THRESHOLD;

  const warnings = [];
  const intervals = [];
  const shiftEnds = [];

  // Step 1: events for both people (recurrence already expanded by the caller).
  for (const event of [...personAEvents, ...personBEvents]) {
    const isBusy = event.isBusy !== undefined ? event.isBusy : event.is_busy;
    if (isBusy === false) continue;

    const s = toDate(event.start || event.start_time);
    const e = toDate(event.end || event.end_time);
    if (!s || !e || isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) continue;

    const weight = event.busy_weight ?? event.busyWeight ?? DEFAULT_BUSY_WEIGHT;
    intervals.push({ start: s.getTime(), end: e.getTime(), weight, kind: 'event' });
  }

  // Step 2: sleep and shift blocks for each person, derived from their context.
  for (const person of [personA, personB]) {
    const shifts = materialiseShifts({
      patterns: person.patterns,
      rangeStart: start,
      rangeEnd: end,
    });
    const sleep = materialiseSleep({
      patterns: person.patterns,
      sleepRules: person.sleepRules,
      rangeStart: start,
      rangeEnd: end,
    });

    intervals.push(...shifts.blocks, ...sleep.blocks);
    shiftEnds.push(...shifts.blocks.map((b) => b.end));
    for (const w of [...shifts.warnings, ...sleep.warnings]) {
      if (!warnings.includes(w)) warnings.push(w);
    }
  }

  // Steps 3–5: union, complement, drop the unusably short.
  const merged = mergeBusy(intervals, busyThreshold);
  const minDurationMs = minMinutes * MINUTES;
  const gaps = complement(merged, start.getTime(), end.getTime())
    .filter((g) => g.end - g.start >= minDurationMs);

  // Step 6: score and rank.
  const windows = gaps
    .map((g) => {
      const { score, parts } = scoreWindow(g, merged, shiftEnds);
      return {
        start: new Date(g.start),
        end: new Date(g.end),
        durationMinutes: Math.round((g.end - g.start) / MINUTES),
        score,
        scoreParts: parts,
      };
    })
    .sort((a, b) => b.score - a.score || a.start - b.start);

  return { success: true, windows, warnings };
}

/**
 * Convenience wrapper for the headline output: the best few windows to surface
 * as "you're both free here" (§1.5).
 * @param {Object} params - same shape as bothFreeWindows
 * @param {number} [limit=3]
 */
export function topWindows(params, limit = 3) {
  const result = bothFreeWindows(params);
  if (!result.success) return result;
  return { ...result, windows: result.windows.slice(0, limit) };
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return null;
}

/** Local YYYY-MM-DD, avoiding the UTC shift that toISOString() introduces. */
function toDateKey(date) {
  if (!date || isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
