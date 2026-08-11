/**
 * @vitest-environment jsdom
 *
 * Recurrence picker.
 *
 * The event form asked people to type `FREQ=WEEKLY;BYDAY=MO,WE,FR` by hand,
 * so repeating events existed for whoever knew RFC 5545 and nobody else. The
 * rules generated here go straight into expandRecurrence, so a wrong string is
 * a wrong schedule — these check the output rather than the controls.
 */
import { describe, it, expect } from 'vitest';
import { RRule } from 'rrule';

const {
  buildRRule, parseRRule, describeRRule, emptyRecurrence,
  renderRecurrencePicker, wireRecurrencePicker, WEEKDAYS,
} = await import('../js/recurrence-picker.js');

describe('buildRRule', () => {
  it('returns null for a one-off', () => {
    // null, not '' — that is what the events table stores and what
    // expandRecurrence checks for.
    expect(buildRRule(emptyRecurrence())).toBeNull();
    expect(buildRRule({ freq: 'NONE' })).toBeNull();
  });

  it('builds a simple weekly rule', () => {
    expect(buildRRule({ freq: 'WEEKLY', interval: 1, endType: 'never' }))
      .toBe('FREQ=WEEKLY');
  });

  it('omits INTERVAL=1, which is the RFC default', () => {
    expect(buildRRule({ freq: 'DAILY', interval: 1 })).toBe('FREQ=DAILY');
    expect(buildRRule({ freq: 'DAILY', interval: 2 })).toBe('FREQ=DAILY;INTERVAL=2');
  });

  it('orders weekdays Monday-first so equivalent rules match as strings', () => {
    const a = buildRRule({ freq: 'WEEKLY', byday: ['FR', 'MO', 'WE'] });
    const b = buildRRule({ freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'] });
    expect(a).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(a).toBe(b);
  });

  it('ignores weekday selections on a non-weekly rule', () => {
    // BYDAY on a monthly rule means "every Monday of the month", which is not
    // what the chips are offering — carrying it across would change the
    // schedule silently.
    expect(buildRRule({ freq: 'MONTHLY', byday: ['MO'] })).toBe('FREQ=MONTHLY');
  });

  it('adds COUNT when ending after a number of times', () => {
    expect(buildRRule({ freq: 'WEEKLY', endType: 'count', count: 6 }))
      .toBe('FREQ=WEEKLY;COUNT=6');
  });

  it('makes UNTIL inclusive of the chosen day', () => {
    // A plain date-to-UTC conversion stops at midnight, dropping the final
    // occurrence — "until the 14th" would exclude the 14th.
    const rule = buildRRule({ freq: 'DAILY', endType: 'until', until: '2026-09-14' });
    expect(rule).toMatch(/UNTIL=\d{8}T\d{6}Z/);

    const stamp = rule.match(/UNTIL=(\d{8})T/)[1];
    const endOfDay = new Date('2026-09-14T23:59:59');
    const pad = (n) => String(n).padStart(2, '0');
    const expected = `${endOfDay.getUTCFullYear()}${pad(endOfDay.getUTCMonth() + 1)}${pad(endOfDay.getUTCDate())}`;
    expect(stamp).toBe(expected);
  });

  it('ignores a nonsense frequency rather than emitting a broken rule', () => {
    expect(buildRRule({ freq: 'FORTNIGHTLY' })).toBeNull();
  });
});

describe('generated rules are valid RFC 5545', () => {
  // The real check: rrule is the library expandRecurrence uses, so anything it
  // cannot parse would silently collapse a series to a single instance.
  const cases = [
    { freq: 'DAILY', interval: 1 },
    { freq: 'DAILY', interval: 3, endType: 'count', count: 5 },
    { freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'] },
    { freq: 'WEEKLY', interval: 2, byday: ['SA', 'SU'], endType: 'until', until: '2026-12-31' },
    { freq: 'MONTHLY', interval: 1, endType: 'count', count: 12 },
    { freq: 'YEARLY' },
  ];

  it.each(cases)('rrule parses %o', (state) => {
    const rule = buildRRule(state);
    expect(rule).toBeTruthy();
    expect(() => RRule.fromString(
      `DTSTART:20260817T180000Z\nRRULE:${rule}`
    )).not.toThrow();
  });

  it('produces the occurrences it claims to', () => {
    const rule = buildRRule({ freq: 'WEEKLY', byday: ['MO', 'WE'], endType: 'count', count: 4 });
    const parsed = RRule.fromString(`DTSTART:20260817T180000Z\nRRULE:${rule}`);
    const dates = parsed.all();

    expect(dates).toHaveLength(4);
    // 17 Aug 2026 is a Monday; Mondays and Wednesdays only.
    for (const date of dates) expect([1, 3]).toContain(date.getUTCDay());
  });
});

describe('parseRRule', () => {
  it('round-trips what the picker builds', () => {
    const original = { freq: 'WEEKLY', interval: 2, byday: ['MO', 'TH'], endType: 'count', count: 8 };
    const rule = buildRRule(original);
    const { state, exact } = parseRRule(rule);

    expect(exact).toBe(true);
    expect(buildRRule(state)).toBe(rule);
  });

  it('treats an empty rule as does-not-repeat', () => {
    expect(parseRRule('').state.freq).toBe('NONE');
    expect(parseRRule(null).state.freq).toBe('NONE');
  });

  it('tolerates an RRULE: prefix', () => {
    expect(parseRRule('RRULE:FREQ=DAILY').state.freq).toBe('DAILY');
  });

  it('reports a positional BYDAY as inexact rather than dropping the position', () => {
    // "2MO" is the second Monday of the month. Silently reading it as "Monday"
    // would move the event.
    const { exact } = parseRRule('FREQ=MONTHLY;BYDAY=2MO');
    expect(exact).toBe(false);
  });

  it('reports rules with parts the controls cannot express', () => {
    expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=15').exact).toBe(false);
  });
});

describe('describeRRule', () => {
  it('describes a one-off', () => {
    expect(describeRRule(null)).toBe('Does not repeat');
  });

  it('describes named weekdays in plain English', () => {
    expect(describeRRule('FREQ=WEEKLY;BYDAY=MO,WE,FR'))
      .toBe('Weekly on Mon, Wed and Fri');
  });

  it('describes an interval', () => {
    expect(describeRRule('FREQ=WEEKLY;INTERVAL=2')).toBe('Every 2 weeks');
  });

  it('describes a count', () => {
    expect(describeRRule('FREQ=DAILY;COUNT=1')).toBe('Daily, 1 time');
    expect(describeRRule('FREQ=DAILY;COUNT=5')).toBe('Daily, 5 times');
  });

  it('admits when a rule is beyond it rather than describing it wrongly', () => {
    expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=15')).toBe('Custom repeat rule');
  });
});

describe('wireRecurrencePicker', () => {
  function mount() {
    const root = document.createElement('div');
    root.innerHTML = renderRecurrencePicker();
    document.body.appendChild(root);
    return { root, api: wireRecurrencePicker(root) };
  }

  it('keeps the hidden rrule field in step with the controls', () => {
    // The form submits form.elements.rrule, so the picker has to be an
    // interface over that value rather than a second source of truth.
    const { root } = mount();
    const freq = root.querySelector('#rrule-freq');
    freq.value = 'WEEKLY';
    freq.dispatchEvent(new Event('change'));

    root.querySelector('input[value="MO"]').checked = true;
    root.querySelector('input[value="MO"]').dispatchEvent(new Event('change', { bubbles: true }));

    expect(root.querySelector('#event-rrule').value).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('starts as does-not-repeat with an empty rule', () => {
    const { root } = mount();
    expect(root.querySelector('#event-rrule').value).toBe('');
    expect(root.querySelector('#rrule-summary').textContent).toBe('Does not repeat');
  });

  it('shows weekday chips only for a weekly rule', () => {
    const { root } = mount();
    const freq = root.querySelector('#rrule-freq');

    freq.value = 'WEEKLY';
    freq.dispatchEvent(new Event('change'));
    expect(root.querySelector('#rrule-days-group').hidden).toBe(false);

    freq.value = 'MONTHLY';
    freq.dispatchEvent(new Event('change'));
    expect(root.querySelector('#rrule-days-group').hidden).toBe(true);
  });

  it('loads an existing rule back into the controls', () => {
    const { root, api } = mount();
    expect(api.setValue('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')).toBe(true);

    expect(root.querySelector('#rrule-freq').value).toBe('WEEKLY');
    expect(root.querySelector('#rrule-interval').value).toBe('2');
    expect(root.querySelector('input[value="TU"]').checked).toBe(true);
    expect(root.querySelector('input[value="WE"]').checked).toBe(false);
  });

  it('preserves a rule it cannot represent instead of rewriting it', () => {
    // Google sync and older events carry rules the chips cannot express.
    // Approximating one would change when the event happens.
    const { root, api } = mount();
    const exotic = 'FREQ=MONTHLY;BYMONTHDAY=15';

    expect(api.setValue(exotic)).toBe(false);
    expect(root.querySelector('#event-rrule').value).toBe(exotic);
    expect(api.getValue()).toBe(exotic);
  });

  it('exposes all seven weekdays', () => {
    const { root } = mount();
    expect(root.querySelectorAll('input[name="rrule-day"]')).toHaveLength(7);
    expect(WEEKDAYS[0].code).toBe('MO');
  });
});
