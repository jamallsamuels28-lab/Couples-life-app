// ============================================================
// Recurrence picker — build an RRULE without typing one
// ============================================================
//
// The event form asked people to type `FREQ=WEEKLY;BYDAY=MO,WE,FR` by hand.
// The expansion engine underneath has always been sound — exdates, overrides,
// §1.2 ordering — but a field only one of the two people can use is a feature
// only one of them has. This is the interface to the engine that was missing.
//
// The pattern (frequency, interval, weekday chips, an end condition) is the
// one every calendar app converges on. Behaviour is not copyrightable and no
// code was taken from any of them; this is written against RFC 5545 and the
// rrule library the app already depends on.
//
// Pure string work — no DOM, no database — so the generated rules can be
// tested directly and a wrong one is visible rather than inferred.
// ============================================================

export const WEEKDAYS = [
  { code: 'MO', label: 'Mon' },
  { code: 'TU', label: 'Tue' },
  { code: 'WE', label: 'Wed' },
  { code: 'TH', label: 'Thu' },
  { code: 'FR', label: 'Fri' },
  { code: 'SA', label: 'Sat' },
  { code: 'SU', label: 'Sun' },
];

const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** The default state: does not repeat. */
export function emptyRecurrence() {
  return { freq: 'NONE', interval: 1, byday: [], endType: 'never', until: '', count: 10 };
}

/**
 * Builds an RRULE string, or null for "does not repeat".
 *
 * Returns null rather than an empty string because that is what the events
 * table stores for a one-off, and what expandRecurrence checks for.
 */
export function buildRRule(state = {}) {
  const freq = String(state.freq || 'NONE').toUpperCase();
  if (!FREQUENCIES.includes(freq)) return null;

  const parts = [`FREQ=${freq}`];

  const interval = Number(state.interval);
  // INTERVAL=1 is the default in RFC 5545, so emitting it is noise.
  if (Number.isFinite(interval) && interval > 1) {
    parts.push(`INTERVAL=${Math.floor(interval)}`);
  }

  // BYDAY only means "which days of the week" for a weekly rule. On a monthly
  // rule it means something quite different (every Monday of the month), so it
  // is deliberately not carried across when the frequency changes.
  if (freq === 'WEEKLY') {
    const days = (state.byday || []).filter(d => WEEKDAYS.some(w => w.code === d));
    if (days.length > 0) {
      // Ordered Monday-first so two equivalent rules compare equal as strings.
      const ordered = WEEKDAYS.filter(w => days.includes(w.code)).map(w => w.code);
      parts.push(`BYDAY=${ordered.join(',')}`);
    }
  }

  if (state.endType === 'count') {
    const count = Number(state.count);
    if (Number.isFinite(count) && count > 0) parts.push(`COUNT=${Math.floor(count)}`);
  } else if (state.endType === 'until' && state.until) {
    // RFC 5545 wants a UTC timestamp. Take the end of the chosen local day, so
    // "until the 14th" includes the 14th rather than stopping at midnight on
    // the 13th — which is what a plain date conversion would do.
    const date = new Date(`${state.until}T23:59:59`);
    if (!Number.isNaN(date.getTime())) {
      parts.push(`UNTIL=${toRRuleStamp(date)}`);
    }
  }

  return parts.join(';');
}

function toRRuleStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/**
 * Reads an existing RRULE back into picker state.
 *
 * Needed for editing: an event created before this picker existed, or by
 * Google sync, carries a rule the picker has to represent rather than silently
 * discard. Anything it cannot represent is reported so the caller can keep
 * showing the raw text instead of quietly rewriting it.
 */
export function parseRRule(rrule) {
  const state = emptyRecurrence();
  const text = String(rrule || '').trim();
  if (!text) return { state, exact: true };

  const parts = new Map();
  for (const chunk of text.replace(/^RRULE:/i, '').split(';')) {
    const [key, value] = chunk.split('=');
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim());
  }

  const freq = parts.get('FREQ');
  if (!FREQUENCIES.includes(freq)) return { state, exact: false };
  state.freq = freq;

  if (parts.has('INTERVAL')) {
    const interval = Number(parts.get('INTERVAL'));
    if (Number.isFinite(interval) && interval > 0) state.interval = interval;
  }

  if (parts.has('BYDAY')) {
    // A positional BYDAY like "2MO" (second Monday) is beyond what the chips
    // can express; say so rather than dropping the position and changing when
    // the event happens.
    const days = parts.get('BYDAY').split(',').map(d => d.trim().toUpperCase());
    const plain = days.every(d => WEEKDAYS.some(w => w.code === d));
    if (!plain || freq !== 'WEEKLY') return { state, exact: false };
    state.byday = days;
  }

  if (parts.has('COUNT')) {
    state.endType = 'count';
    state.count = Number(parts.get('COUNT')) || 1;
  } else if (parts.has('UNTIL')) {
    state.endType = 'until';
    const stamp = parts.get('UNTIL');
    const match = stamp.match(/^(\d{4})(\d{2})(\d{2})/);
    if (match) state.until = `${match[1]}-${match[2]}-${match[3]}`;
  }

  // Anything left over (BYMONTHDAY, BYSETPOS, WKST…) is a rule the picker
  // cannot round-trip.
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL']);
  const exact = [...parts.keys()].every(k => known.has(k));

  return { state, exact };
}

/**
 * A plain-English summary, so the rule can be checked without reading RRULE.
 * This is the line that tells you the picker did what you meant.
 */
export function describeRRule(rrule) {
  const { state, exact } = parseRRule(rrule);
  if (state.freq === 'NONE') return 'Does not repeat';
  if (!exact) return 'Custom repeat rule';

  const every = state.interval > 1 ? `every ${state.interval} ` : 'every ';
  let base;
  switch (state.freq) {
    case 'DAILY':
      base = state.interval > 1 ? `${every}days` : 'Daily';
      break;
    case 'WEEKLY': {
      const unit = state.interval > 1 ? `${every}weeks` : 'Weekly';
      if (state.byday.length) {
        const names = WEEKDAYS.filter(w => state.byday.includes(w.code)).map(w => w.label);
        const list = names.length > 1
          ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
          : names[0];
        base = `${unit} on ${list}`;
      } else {
        base = unit;
      }
      break;
    }
    case 'MONTHLY':
      base = state.interval > 1 ? `${every}months` : 'Monthly';
      break;
    case 'YEARLY':
      base = state.interval > 1 ? `${every}years` : 'Yearly';
      break;
    default:
      return 'Custom repeat rule';
  }

  const sentence = base.charAt(0).toUpperCase() + base.slice(1);

  if (state.endType === 'count') {
    return `${sentence}, ${state.count} time${state.count === 1 ? '' : 's'}`;
  }
  if (state.endType === 'until' && state.until) {
    const date = new Date(`${state.until}T12:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return `${sentence}, until ${date.toLocaleDateString(undefined, {
        day: 'numeric', month: 'short', year: 'numeric',
      })}`;
    }
  }
  return sentence;
}

/** Markup for the picker. Wire it with wireRecurrencePicker(). */
export function renderRecurrencePicker() {
  const dayChips = WEEKDAYS.map(day => `
    <label class="day-chip">
      <input type="checkbox" name="rrule-day" value="${day.code}" />
      <span>${day.label}</span>
    </label>
  `).join('');

  return `
    <div class="input-group recurrence-picker" id="recurrence-picker">
      <label class="input-label" for="rrule-freq">Repeat</label>
      <select id="rrule-freq" class="input">
        <option value="NONE">Does not repeat</option>
        <option value="DAILY">Daily</option>
        <option value="WEEKLY">Weekly</option>
        <option value="MONTHLY">Monthly</option>
        <option value="YEARLY">Yearly</option>
      </select>

      <div class="recurrence-detail" id="rrule-detail" hidden>
        <div class="field-row mt-4">
          <div class="input-group">
            <label class="input-label" for="rrule-interval">Every</label>
            <input type="number" id="rrule-interval" class="input num" min="1" max="52" value="1" inputmode="numeric" />
          </div>
          <div class="input-group">
            <label class="input-label" for="rrule-end">Ends</label>
            <select id="rrule-end" class="input">
              <option value="never">Never</option>
              <option value="until">On a date</option>
              <option value="count">After a number of times</option>
            </select>
          </div>
        </div>

        <div class="input-group mt-4" id="rrule-days-group" hidden>
          <span class="input-label">On these days</span>
          <div class="day-chips">${dayChips}</div>
        </div>

        <div class="input-group mt-4" id="rrule-until-group" hidden>
          <label class="input-label" for="rrule-until">Last date</label>
          <input type="date" id="rrule-until" class="input" />
        </div>

        <div class="input-group mt-4" id="rrule-count-group" hidden>
          <label class="input-label" for="rrule-count">Number of times</label>
          <input type="number" id="rrule-count" class="input num" min="1" max="500" value="10" inputmode="numeric" />
        </div>
      </div>

      <p class="recurrence-summary field-hint" id="rrule-summary" aria-live="polite">Does not repeat</p>
      <input type="hidden" id="event-rrule" name="rrule" value="" />
    </div>
  `;
}

/**
 * Wires the picker and keeps the hidden rrule field in step.
 *
 * The hidden field keeps the form's existing contract — handleFormSubmit still
 * reads form.elements.rrule — so the picker is an interface over the same
 * value rather than a second source of truth.
 *
 * @returns {{setValue: (rrule: string) => boolean, getValue: () => string|null}}
 */
export function wireRecurrencePicker(root) {
  const el = (id) => root.querySelector(`#${id}`);
  const freq = el('rrule-freq');
  if (!freq) return { setValue: () => false, getValue: () => null };

  const detail = el('rrule-detail');
  const interval = el('rrule-interval');
  const endSelect = el('rrule-end');
  const daysGroup = el('rrule-days-group');
  const untilGroup = el('rrule-until-group');
  const countGroup = el('rrule-count-group');
  const until = el('rrule-until');
  const count = el('rrule-count');
  const summary = el('rrule-summary');
  const hidden = el('event-rrule');

  const dayBoxes = () => [...root.querySelectorAll('input[name="rrule-day"]')];

  function readState() {
    return {
      freq: freq.value,
      interval: Number(interval.value) || 1,
      byday: dayBoxes().filter(b => b.checked).map(b => b.value),
      endType: endSelect.value,
      until: until.value,
      count: Number(count.value) || 1,
    };
  }

  function sync() {
    const state = readState();
    const repeats = state.freq !== 'NONE';

    detail.hidden = !repeats;
    daysGroup.hidden = state.freq !== 'WEEKLY';
    untilGroup.hidden = state.endType !== 'until';
    countGroup.hidden = state.endType !== 'count';

    const rrule = buildRRule(state);
    hidden.value = rrule || '';
    summary.textContent = describeRRule(rrule);
  }

  freq.addEventListener('change', sync);
  endSelect.addEventListener('change', sync);
  interval.addEventListener('input', sync);
  until.addEventListener('input', sync);
  count.addEventListener('input', sync);
  root.addEventListener('change', (event) => {
    if (event.target?.name === 'rrule-day') sync();
  });

  sync();

  return {
    /**
     * Loads an existing rule. Returns false when the rule is beyond what the
     * controls can express, so the caller can leave it alone rather than
     * rewrite someone's rule into an approximation of itself.
     */
    setValue(rrule) {
      const { state, exact } = parseRRule(rrule);
      if (!exact) {
        hidden.value = rrule || '';
        summary.textContent = describeRRule(rrule);
        return false;
      }

      freq.value = state.freq;
      interval.value = state.interval;
      endSelect.value = state.endType;
      until.value = state.until;
      count.value = state.count;
      for (const box of dayBoxes()) box.checked = state.byday.includes(box.value);

      sync();
      return true;
    },
    getValue() {
      return hidden.value || null;
    },
  };
}
