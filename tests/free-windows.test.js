/**
 * Free windows engine — kiro-algorithm-spec.md §1.3, §1.4, §1.5
 *
 * The previous version of this file tested a fixed waking-hour band
 * (dayStartHour / dayEndHour). That model is what produced the original bug:
 * sleeping 09:30–17:30 sat inside the "waking" band and was reported as free.
 * Availability is now derived from each person's shift pattern and sleep
 * rules, so the tests exercise that instead.
 */
import { describe, it, expect } from 'vitest';
import {
  bothFreeWindows,
  topWindows,
  mergeBusy,
  complement,
  scoreWindow,
  timeToMinutes,
  resolvePattern,
  resolveSleepContext,
  materialiseSleep,
} from '../js/free-windows.js';

// --- Fixtures -------------------------------------------------

/** Jamall: AMXL nights Sun–Wed, 22:30–09:00, sleeping 09:30–17:30 after. */
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
  sleepRules: [{ context: 'default', start_local: '23:00', end_local: '07:00' }],
};

/** Rebecca: earlies Mon–Fri, 07:00–15:30, sleeping 23:00–06:00. */
const EARLY_SHIFT = {
  patterns: [{
    label: 'ISO earlies',
    days_of_week: [1, 2, 3, 4, 5],
    start_local: '07:00',
    end_local: '15:30',
    sleep_start: '23:00',
    sleep_end: '06:00',
    valid_from: '2026-01-01',
    valid_to: null,
  }],
  sleepRules: [{ context: 'default', start_local: '23:00', end_local: '06:00' }],
};

const monday = (h = 0, m = 0) => new Date(2026, 7, 10, h, m, 0, 0);
const tuesday = (h = 0, m = 0) => new Date(2026, 7, 11, h, m, 0, 0);
const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// --- Interval primitives (§1.3) -------------------------------

describe('mergeBusy', () => {
  it('merges overlapping intervals', () => {
    const out = mergeBusy([
      { start: 0, end: 100 },
      { start: 50, end: 150 },
    ]);
    expect(out).toEqual([{ start: 0, end: 150 }]);
  });

  it('merges back-to-back intervals', () => {
    const out = mergeBusy([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
    ]);
    expect(out).toEqual([{ start: 0, end: 200 }]);
  });

  it('absorbs fully nested intervals', () => {
    const out = mergeBusy([
      { start: 0, end: 500 },
      { start: 100, end: 200 },
    ]);
    expect(out).toEqual([{ start: 0, end: 500 }]);
  });

  it('keeps disjoint intervals separate and sorted', () => {
    const out = mergeBusy([
      { start: 300, end: 400 },
      { start: 0, end: 100 },
    ]);
    expect(out).toEqual([{ start: 0, end: 100 }, { start: 300, end: 400 }]);
  });

  it('drops intervals below the busy weight threshold', () => {
    const out = mergeBusy([
      { start: 0, end: 100, weight: 100 },
      { start: 200, end: 300, weight: 20 },
    ]);
    expect(out).toEqual([{ start: 0, end: 100 }]);
  });

  it('treats a missing weight as hard busy', () => {
    expect(mergeBusy([{ start: 0, end: 100 }])).toHaveLength(1);
  });

  it('discards zero-length and inverted intervals', () => {
    expect(mergeBusy([{ start: 100, end: 100 }, { start: 200, end: 50 }])).toEqual([]);
  });
});

describe('complement', () => {
  it('returns the whole range when nothing is busy', () => {
    expect(complement([], 0, 1000)).toEqual([{ start: 0, end: 1000 }]);
  });

  it('returns head, middle and tail gaps', () => {
    const out = complement([{ start: 200, end: 300 }, { start: 500, end: 600 }], 0, 1000);
    expect(out).toEqual([
      { start: 0, end: 200 },
      { start: 300, end: 500 },
      { start: 600, end: 1000 },
    ]);
  });

  it('returns nothing when the range is fully covered', () => {
    expect(complement([{ start: 0, end: 1000 }], 0, 1000)).toEqual([]);
  });

  it('clips busy blocks that extend past the range', () => {
    const out = complement([{ start: -500, end: 200 }], 0, 1000);
    expect(out).toEqual([{ start: 200, end: 1000 }]);
  });
});

// --- Time parsing ---------------------------------------------

describe('timeToMinutes', () => {
  it('parses HH:MM', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('23:59')).toBe(1439);
  });

  it('parses the HH:MM:SS Postgres returns for a time column', () => {
    expect(timeToMinutes('22:30:00')).toBe(1350);
  });

  it('rejects nonsense', () => {
    expect(timeToMinutes('25:00')).toBeNull();
    expect(timeToMinutes('9:70')).toBeNull();
    expect(timeToMinutes('')).toBeNull();
    expect(timeToMinutes(null)).toBeNull();
  });
});

// --- Pattern resolution (§1.1b) -------------------------------

describe('resolvePattern', () => {
  const patterns = [
    { label: 'old', days_of_week: [1], start_local: '06:00', end_local: '14:00', valid_from: '2026-01-01', valid_to: '2026-06-30' },
    { label: 'new', days_of_week: [1], start_local: '07:00', end_local: '15:00', valid_from: '2026-07-01', valid_to: null },
  ];

  it('picks the pattern in force on the date', () => {
    expect(resolvePattern(patterns, new Date(2026, 2, 2)).pattern.label).toBe('old');
    expect(resolvePattern(patterns, new Date(2026, 7, 10)).pattern.label).toBe('new');
  });

  it('does not let a later edit rewrite history', () => {
    // A March Monday still resolves to the pattern actually worked in March.
    const march = resolvePattern(patterns, new Date(2026, 2, 2));
    expect(march.pattern.start_local).toBe('06:00');
  });

  it('returns no pattern for a day of the week not worked', () => {
    expect(resolvePattern(patterns, new Date(2026, 7, 11)).pattern).toBeNull();
  });

  it('surfaces an error rather than guessing when two patterns overlap', () => {
    const broken = [
      { label: 'a', days_of_week: [1], start_local: '06:00', end_local: '14:00', valid_from: '2026-01-01', valid_to: null },
      { label: 'b', days_of_week: [1], start_local: '07:00', end_local: '15:00', valid_from: '2026-02-01', valid_to: null },
    ];
    const result = resolvePattern(broken, new Date(2026, 7, 10));
    expect(result.pattern).toBeNull();
    expect(result.error).toMatch(/Overlapping shift patterns/);
  });
});

describe('resolveSleepContext', () => {
  it('reports post_night_shift the morning after an overnight shift', () => {
    // Sunday night shift (22:30 Sun → 09:00 Mon) makes Monday a recovery day.
    const context = resolveSleepContext(NIGHT_SHIFT.patterns, monday());
    expect(context.context).toBe('post_night_shift');
  });

  it('reports pre_night_shift when a shift starts that evening but none ran overnight', () => {
    const eveningOnly = [{
      label: 'Nights Fri', days_of_week: [5],
      start_local: '22:00', end_local: '06:00',
      valid_from: '2026-01-01', valid_to: null,
    }];
    // Friday 2026-08-14: a shift starts tonight, nothing ran last night.
    const context = resolveSleepContext(eveningOnly, new Date(2026, 7, 14));
    expect(context.context).toBe('pre_night_shift');
  });

  it('falls back to default on an ordinary day', () => {
    const context = resolveSleepContext(EARLY_SHIFT.patterns, monday());
    expect(context.context).toBe('default');
  });
});

// --- Sleep materialisation (§1.4 step 2) ----------------------

describe('materialiseSleep', () => {
  it('emits the pattern sleep window in preference to the sleep rule', () => {
    const { blocks } = materialiseSleep({
      patterns: NIGHT_SHIFT.patterns,
      sleepRules: NIGHT_SHIFT.sleepRules,
      rangeStart: monday(),
      rangeEnd: tuesday(),
    });
    const mondaySleep = blocks.find(b => new Date(b.start).getDate() === 10);
    expect(clock(new Date(mondaySleep.start))).toBe('09:30');
    expect(clock(new Date(mondaySleep.end))).toBe('17:30');
  });

  it('carries a midnight-crossing sleep window into the following day', () => {
    const { blocks } = materialiseSleep({
      patterns: [],
      sleepRules: [{ context: 'default', start_local: '23:00', end_local: '06:00' }],
      rangeStart: monday(),
      rangeEnd: tuesday(),
    });
    const overnight = blocks.find(b => clock(new Date(b.start)) === '23:00');
    expect(new Date(overnight.end).getDate()).toBe(new Date(overnight.start).getDate() + 1);
    expect(clock(new Date(overnight.end))).toBe('06:00');
  });

  it('emits nothing when there is no pattern and no rule', () => {
    const { blocks } = materialiseSleep({
      patterns: [], sleepRules: [], rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(blocks).toEqual([]);
  });
});

// --- Window quality score (§1.5) ------------------------------

describe('scoreWindow', () => {
  const window = (startHour, hours) => ({
    start: monday(startHour).getTime(),
    end: monday(startHour + hours).getTime(),
  });

  it('saturates the length component at three hours', () => {
    expect(scoreWindow(window(18, 3)).parts.base).toBe(40);
    expect(scoreWindow(window(18, 6)).parts.base).toBe(40);
  });

  it('scales the length component below three hours', () => {
    // 90 minutes is half of the three-hour saturation point.
    const ninetyMinutes = { start: monday(18).getTime(), end: monday(19, 30).getTime() };
    expect(scoreWindow(ninetyMinutes).parts.base).toBe(20);
  });

  it('rates the evening highest', () => {
    expect(scoreWindow(window(18, 2)).parts.timeOfDay).toBe(30);
    expect(scoreWindow(window(13, 2)).parts.timeOfDay).toBe(20);
    expect(scoreWindow(window(9, 2)).parts.timeOfDay).toBe(10);
    expect(scoreWindow(window(4, 2)).parts.timeOfDay).toBe(0);
  });

  it('adds nothing for a weekday and fifteen for a weekend', () => {
    expect(scoreWindow(window(18, 2)).parts.weekend).toBe(0);
    const saturday = {
      start: new Date(2026, 7, 15, 18).getTime(),
      end: new Date(2026, 7, 15, 20).getTime(),
    };
    expect(scoreWindow(saturday).parts.weekend).toBe(15);
  });

  it('gives no buffer credit to a slot sandwiched between two busy blocks', () => {
    const merged = [
      { start: monday(16).getTime(), end: monday(18).getTime() },
      { start: monday(20).getTime(), end: monday(22).getTime() },
    ];
    expect(scoreWindow(window(18, 2), merged).parts.buffer).toBe(0);
  });

  it('gives full buffer credit when clear on both sides', () => {
    const merged = [
      { start: monday(14).getTime(), end: monday(16).getTime() },
      { start: monday(22).getTime(), end: monday(23).getTime() },
    ];
    expect(scoreWindow(window(18, 2), merged).parts.buffer).toBe(15);
  });

  it('penalises a window starting straight after a shift ends', () => {
    const shiftEnd = monday(17, 45).getTime();
    expect(scoreWindow(window(18, 2), [], [shiftEnd]).parts.proximity).toBe(-10);
  });

  it('does not penalise a window well clear of the shift end', () => {
    const shiftEnd = monday(9).getTime();
    expect(scoreWindow(window(18, 2), [], [shiftEnd]).parts.proximity).toBe(0);
  });
});

// --- Main entry point (§1.4) ----------------------------------

describe('bothFreeWindows — validation', () => {
  it('rejects a missing range', () => {
    expect(bothFreeWindows({}).success).toBe(false);
  });

  it('rejects an inverted range', () => {
    const r = bothFreeWindows({ rangeStart: tuesday(), rangeEnd: monday() });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/before/);
  });

  it('rejects a range longer than 31 days', () => {
    const r = bothFreeWindows({
      rangeStart: monday(),
      rangeEnd: new Date(monday().getTime() + 40 * 86400000),
    });
    expect(r.success).toBe(false);
  });

  it('rejects an out-of-bounds minMinutes', () => {
    const r = bothFreeWindows({
      rangeStart: monday(), rangeEnd: tuesday(), options: { minMinutes: 1 },
    });
    expect(r.success).toBe(false);
  });
});

describe('bothFreeWindows — the night shift regression', () => {
  const run = () => bothFreeWindows({
    personA: NIGHT_SHIFT,
    personB: EARLY_SHIFT,
    rangeStart: monday(),
    rangeEnd: tuesday(),
  });

  it('does not report sleep as free time', () => {
    const { windows } = run();
    // Jamall sleeps 09:30–17:30 on the Monday after his Sunday night shift.
    for (const w of windows) {
      const overlapsSleep = w.start < monday(17, 30) && w.end > monday(9, 30);
      expect(overlapsSleep).toBe(false);
    }
  });

  it('finds the single real evening window', () => {
    const { windows } = run();
    expect(windows).toHaveLength(1);
    expect(clock(windows[0].start)).toBe('17:30');
    expect(clock(windows[0].end)).toBe('22:30');
  });

  it('totals five hours, not the twelve the old waking-hour model reported', () => {
    const total = run().windows.reduce((sum, w) => sum + w.durationMinutes, 0);
    expect(total).toBe(300);
  });

  it('reports no free time on a day both people work through', () => {
    // Wednesday: Jamall sleeps 09:30–17:30 then works 22:30 onward,
    // Rebecca works 07:00–15:30 and sleeps 23:00.
    const wed = new Date(2026, 7, 12);
    const thu = new Date(2026, 7, 13);
    const { windows } = bothFreeWindows({
      personA: NIGHT_SHIFT, personB: EARLY_SHIFT, rangeStart: wed, rangeEnd: thu,
    });
    // Only the same evening gap survives; nothing in the small hours.
    for (const w of windows) {
      expect(w.start.getHours()).toBeGreaterThanOrEqual(17);
    }
  });
});

describe('bothFreeWindows — events', () => {
  const evt = (startH, endH, extra = {}) => ({
    start: monday(startH), end: monday(endH), isBusy: true, ...extra,
  });

  it('treats both partners events as busy', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [evt(9, 11)],
      personBEvents: [evt(14, 16)],
      rangeStart: monday(), rangeEnd: tuesday(),
    });
    for (const w of windows) {
      expect(w.start < monday(11) && w.end > monday(9)).toBe(false);
      expect(w.start < monday(16) && w.end > monday(14)).toBe(false);
    }
  });

  it('ignores events flagged not busy', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [evt(9, 11, { isBusy: false })],
      rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].durationMinutes).toBe(1440);
  });

  it('accepts start_time / end_time / is_busy naming', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [{
        start_time: '2026-08-10T09:00:00', end_time: '2026-08-10T11:00:00', is_busy: true,
      }],
      rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(windows.some(w => w.start < monday(11) && w.end > monday(9))).toBe(false);
  });

  it('schedules over a soft commitment below the busy threshold', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [evt(9, 11, { busy_weight: 20 })],
      rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].durationMinutes).toBe(1440);
  });

  it('blocks on a hard commitment at the threshold', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [evt(9, 11, { busy_weight: 50 })],
      rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(windows.every(w => !(w.start < monday(11) && w.end > monday(9)))).toBe(true);
  });

  it('skips events with unparseable dates instead of throwing', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [{ start: 'not a date', end: 'also not', isBusy: true }],
      rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(windows).toHaveLength(1);
  });
});

describe('bothFreeWindows — output shape', () => {
  it('drops gaps shorter than minMinutes', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [
        { start: monday(0), end: monday(12), isBusy: true },
        { start: monday(12, 30), end: tuesday(), isBusy: true },
      ],
      rangeStart: monday(), rangeEnd: tuesday(),
      options: { minMinutes: 45 },
    });
    expect(windows).toHaveLength(0);
  });

  it('keeps a gap exactly at minMinutes', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [
        { start: monday(0), end: monday(12), isBusy: true },
        { start: monday(12, 45), end: tuesday(), isBusy: true },
      ],
      rangeStart: monday(), rangeEnd: tuesday(),
      options: { minMinutes: 45 },
    });
    expect(windows).toHaveLength(1);
    expect(windows[0].durationMinutes).toBe(45);
  });

  it('returns windows ranked by score, best first', () => {
    const { windows } = bothFreeWindows({
      personAEvents: [
        // Leaves a 04:00–06:00 gap and an 18:00–21:00 gap.
        { start: monday(0), end: monday(4), isBusy: true },
        { start: monday(6), end: monday(18), isBusy: true },
        { start: monday(21), end: tuesday(), isBusy: true },
      ],
      rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(windows).toHaveLength(2);
    expect(clock(windows[0].start)).toBe('18:00');
    expect(windows[0].score).toBeGreaterThan(windows[1].score);
  });

  it('never returns overlapping windows', () => {
    const { windows } = bothFreeWindows({
      personA: NIGHT_SHIFT, personB: EARLY_SHIFT,
      rangeStart: monday(), rangeEnd: new Date(2026, 7, 17),
    });
    const chronological = [...windows].sort((a, b) => a.start - b.start);
    for (let i = 1; i < chronological.length; i++) {
      expect(chronological[i].start.getTime()).toBeGreaterThanOrEqual(chronological[i - 1].end.getTime());
    }
  });

  it('surfaces a warning when a person has overlapping patterns', () => {
    const broken = {
      patterns: [
        { label: 'a', days_of_week: [1], start_local: '06:00', end_local: '14:00', valid_from: '2026-01-01', valid_to: null },
        { label: 'b', days_of_week: [1], start_local: '07:00', end_local: '15:00', valid_from: '2026-02-01', valid_to: null },
      ],
      sleepRules: [],
    };
    const result = bothFreeWindows({
      personA: broken, rangeStart: monday(), rangeEnd: tuesday(),
    });
    expect(result.success).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('topWindows', () => {
  it('returns at most the requested number, highest scoring first', () => {
    const result = topWindows({
      personA: NIGHT_SHIFT, personB: EARLY_SHIFT,
      rangeStart: monday(), rangeEnd: new Date(2026, 7, 17),
    }, 3);
    expect(result.success).toBe(true);
    expect(result.windows.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < result.windows.length; i++) {
      expect(result.windows[i - 1].score).toBeGreaterThanOrEqual(result.windows[i].score);
    }
  });

  it('passes validation failures straight through', () => {
    expect(topWindows({}).success).toBe(false);
  });
});
