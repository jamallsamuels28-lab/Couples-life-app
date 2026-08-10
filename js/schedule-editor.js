// ============================================================
// Shift & Sleep Editor — Couples Life App
// UI for kiro-algorithm-spec.md §1.1 and §1.1b
// ============================================================
//
// Rotas change, so patterns are editable in the app rather than seeded in SQL.
// Saving a change to an existing pattern does NOT update the row: it closes the
// old one and opens a new one from the effective date, so past weeks keep
// resolving against the hours actually worked at the time.
// ============================================================

import { getCurrentUser } from './app-shell.js';
import { escapeHtml } from './ui-helpers.js';
import {
  DAY_NAMES,
  fetchShiftPatterns,
  fetchSleepRules,
  createPattern,
  supersedePattern,
  saveSleepRule,
  validatePattern,
} from './schedule-patterns.js';

const SLEEP_CONTEXT_LABELS = {
  default: 'Ordinary day',
  post_night_shift: 'After a night shift',
  pre_night_shift: 'Before a night shift',
};

/**
 * Mounts the schedule editor.
 * @param {HTMLElement} container
 */
export async function renderScheduleEditor(container) {
  if (!container) return;
  const user = getCurrentUser();

  if (!user) {
    container.innerHTML = `<div class="empty-state">Sign in to set up your shift pattern.</div>`;
    return;
  }

  container.innerHTML = `<p class="view-placeholder-text">Loading your pattern…</p>`;

  const [patternResult, sleepResult] = await Promise.all([
    fetchShiftPatterns([user.id]),
    fetchSleepRules([user.id]),
  ]);

  const patterns = patternResult.success ? patternResult.patterns : [];
  const rules = sleepResult.success ? sleepResult.rules : [];
  const current = patterns.find(p => !p.valid_to) || null;
  const history = patterns.filter(p => p.valid_to).sort((a, b) => b.valid_from.localeCompare(a.valid_from));

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">${current ? 'Your shift pattern' : 'Set your shift pattern'}</h3>
      </div>
      <div class="card-body">
        ${current ? renderCurrentSummary(current) : ''}
        <p class="field-hint">
          ${current
            ? 'Changing this closes the current pattern and starts a new one, so past weeks keep the hours you actually worked.'
            : 'Your working days and the sleep that follows them. This is what turns "both free" from a guess into a real answer.'}
        </p>
        ${renderPatternForm(current)}
      </div>
    </div>

    <div class="card mt-4">
      <div class="card-header">
        <h3 class="card-title">Sleep</h3>
      </div>
      <div class="card-body">
        <p class="field-hint">
          Used on days your shift pattern does not specify its own sleep window.
          An end time earlier than the start just means it runs past midnight.
        </p>
        ${renderSleepForm(rules)}
      </div>
    </div>

    ${history.length ? `
      <div class="card mt-4">
        <div class="card-header">
          <h3 class="card-title">Previous patterns</h3>
        </div>
        <div class="card-body">
          <div class="pattern-history">
            ${history.map(renderHistoryRow).join('')}
          </div>
        </div>
      </div>
    ` : ''}
  `;

  wirePatternForm(container, current, user.id);
  wireSleepForm(container, user.id);
}

// ------------------------------------------------------------
// Markup
// ------------------------------------------------------------

function renderCurrentSummary(pattern) {
  const days = (pattern.days_of_week || []).map(d => DAY_NAMES[d]).join(', ');
  const crosses = pattern.end_local < pattern.start_local;
  return `
    <div class="pattern-summary">
      <div class="pattern-summary-label">${escapeHtml(pattern.label)}</div>
      <div class="pattern-summary-detail">
        <span>${escapeHtml(days)}</span>
        <span class="divider">·</span>
        <span class="num">${shortTime(pattern.start_local)}–${shortTime(pattern.end_local)}</span>
        ${crosses ? '<span class="pattern-tag">overnight</span>' : ''}
      </div>
      ${pattern.sleep_start ? `
        <div class="pattern-summary-detail">
          <span>Sleep</span>
          <span class="num">${shortTime(pattern.sleep_start)}–${shortTime(pattern.sleep_end)}</span>
        </div>
      ` : ''}
      <div class="pattern-summary-detail pattern-summary-detail--muted">
        In force since <span class="num">${escapeHtml(pattern.valid_from)}</span>
      </div>
    </div>
  `;
}

function renderPatternForm(current) {
  const today = todayKey();
  return `
    <form id="pattern-form" novalidate>
      <div class="input-group">
        <label class="input-label" for="pattern-label">Pattern name</label>
        <input type="text" id="pattern-label" name="label" class="input" maxlength="60"
          placeholder="e.g. Nights Sun–Wed"
          value="${current ? escapeHtml(current.label) : ''}"
          aria-describedby="pattern-label-error" />
        <span id="pattern-label-error" class="input-error-msg" aria-live="polite"></span>
      </div>

      <fieldset class="input-group day-picker">
        <legend class="input-label">Working days</legend>
        <div class="day-toggles" role="group" aria-describedby="pattern-days-error">
          ${DAY_NAMES.map((name, index) => `
            <button type="button" class="day-toggle" data-day="${index}"
              aria-pressed="${current && (current.days_of_week || []).includes(index)}">
              ${name}
            </button>
          `).join('')}
        </div>
        <span id="pattern-days-error" class="input-error-msg" aria-live="polite"></span>
      </fieldset>

      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="pattern-start">Work starts</label>
          <input type="time" id="pattern-start" name="start_local" class="input num"
            value="${current ? shortTime(current.start_local) : ''}" />
          <span id="pattern-start-error" class="input-error-msg" aria-live="polite"></span>
        </div>
        <div class="input-group">
          <label class="input-label" for="pattern-end">Work ends</label>
          <input type="time" id="pattern-end" name="end_local" class="input num"
            value="${current ? shortTime(current.end_local) : ''}" />
          <span id="pattern-end-error" class="input-error-msg" aria-live="polite"></span>
        </div>
      </div>
      <p class="field-hint" id="overnight-hint" aria-live="polite"></p>

      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="pattern-sleep-start">Sleep starts</label>
          <input type="time" id="pattern-sleep-start" name="sleep_start" class="input num"
            value="${current && current.sleep_start ? shortTime(current.sleep_start) : ''}" />
          <span id="pattern-sleep-start-error" class="input-error-msg" aria-live="polite"></span>
        </div>
        <div class="input-group">
          <label class="input-label" for="pattern-sleep-end">Sleep ends</label>
          <input type="time" id="pattern-sleep-end" name="sleep_end" class="input num"
            value="${current && current.sleep_end ? shortTime(current.sleep_end) : ''}" />
          <span id="pattern-sleep-end-error" class="input-error-msg" aria-live="polite"></span>
        </div>
      </div>
      <p class="field-hint">Leave sleep blank to fall back to the sleep rules below.</p>

      <div class="input-group">
        <label class="input-label" for="pattern-from">
          ${current ? 'New pattern takes effect from' : 'In force from'}
        </label>
        <input type="date" id="pattern-from" name="valid_from" class="input num"
          value="${today}" />
        <span id="pattern-from-error" class="input-error-msg" aria-live="polite"></span>
      </div>

      <span id="pattern-form-error" class="input-error-msg" aria-live="polite"></span>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary" id="pattern-submit">
          ${current ? 'Save as new pattern' : 'Save pattern'}
        </button>
        <span class="form-status num" id="pattern-status" aria-live="polite"></span>
      </div>
    </form>
  `;
}

function renderSleepForm(rules) {
  const byContext = Object.fromEntries(rules.map(r => [r.context, r]));
  return `
    <form id="sleep-form" novalidate>
      ${Object.entries(SLEEP_CONTEXT_LABELS).map(([context, label]) => {
        const rule = byContext[context];
        return `
          <div class="sleep-rule-row" data-context="${context}">
            <span class="sleep-rule-label">${label}</span>
            <div class="field-row">
              <input type="time" class="input num" data-field="start_local"
                aria-label="${label} sleep starts"
                value="${rule ? shortTime(rule.start_local) : ''}" />
              <input type="time" class="input num" data-field="end_local"
                aria-label="${label} sleep ends"
                value="${rule ? shortTime(rule.end_local) : ''}" />
            </div>
          </div>
        `;
      }).join('')}
      <span id="sleep-form-error" class="input-error-msg" aria-live="polite"></span>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save sleep</button>
        <span class="form-status num" id="sleep-status" aria-live="polite"></span>
      </div>
    </form>
  `;
}

function renderHistoryRow(pattern) {
  const days = (pattern.days_of_week || []).map(d => DAY_NAMES[d]).join(', ');
  return `
    <div class="pattern-history-row">
      <div class="pattern-history-main">
        <span class="pattern-history-label">${escapeHtml(pattern.label)}</span>
        <span class="pattern-history-detail">${escapeHtml(days)} · <span class="num">${shortTime(pattern.start_local)}–${shortTime(pattern.end_local)}</span></span>
      </div>
      <span class="pattern-history-range num">${escapeHtml(pattern.valid_from)} → ${escapeHtml(pattern.valid_to)}</span>
    </div>
  `;
}

// ------------------------------------------------------------
// Behaviour
// ------------------------------------------------------------

function wirePatternForm(container, current, userId) {
  const form = container.querySelector('#pattern-form');
  if (!form) return;

  const selectedDays = new Set(current ? current.days_of_week || [] : []);

  form.querySelectorAll('.day-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const day = Number(button.dataset.day);
      if (selectedDays.has(day)) selectedDays.delete(day);
      else selectedDays.add(day);
      button.setAttribute('aria-pressed', selectedDays.has(day));
    });
  });

  // An end time before the start means the shift runs past midnight. Saying so
  // out loud stops it looking like a typo the user needs to correct.
  const startInput = form.querySelector('#pattern-start');
  const endInput = form.querySelector('#pattern-end');
  const hint = form.querySelector('#overnight-hint');
  const updateHint = () => {
    if (startInput.value && endInput.value && endInput.value < startInput.value) {
      hint.textContent = 'Ends the next morning — treated as one overnight shift.';
    } else {
      hint.textContent = '';
    }
  };
  startInput.addEventListener('input', updateHint);
  endInput.addEventListener('input', updateHint);
  updateHint();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);

    const status = form.querySelector('#pattern-status');
    const submit = form.querySelector('#pattern-submit');

    const candidate = {
      label: form.querySelector('#pattern-label').value,
      days_of_week: [...selectedDays].sort((a, b) => a - b),
      start_local: startInput.value,
      end_local: endInput.value,
      sleep_start: form.querySelector('#pattern-sleep-start').value || null,
      sleep_end: form.querySelector('#pattern-sleep-end').value || null,
      valid_from: form.querySelector('#pattern-from').value,
    };

    const { valid, errors } = validatePattern(candidate);
    if (!valid) {
      showErrors(form, errors);
      return;
    }

    submit.disabled = true;
    status.textContent = 'Saving…';

    const result = current
      ? await supersedePattern(current.id, candidate, candidate.valid_from, userId)
      : await createPattern(candidate, userId);

    submit.disabled = false;

    if (!result.success) {
      status.textContent = '';
      showErrors(form, result.errors || {});
      return;
    }

    status.textContent = 'Saved';
    window.dispatchEvent(new CustomEvent('calendar:refresh'));
    renderScheduleEditor(container);
  });
}

function wireSleepForm(container, userId) {
  const form = container.querySelector('#sleep-form');
  if (!form) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = form.querySelector('#sleep-status');
    const errorSlot = form.querySelector('#sleep-form-error');
    errorSlot.textContent = '';
    status.textContent = 'Saving…';

    const rows = [...form.querySelectorAll('.sleep-rule-row')];
    const failures = [];

    for (const row of rows) {
      const start = row.querySelector('[data-field="start_local"]').value;
      const end = row.querySelector('[data-field="end_local"]').value;
      // A blank row means "no rule for this context", which is allowed.
      if (!start && !end) continue;
      if (!start || !end) {
        failures.push(`${SLEEP_CONTEXT_LABELS[row.dataset.context]}: give both a start and an end.`);
        continue;
      }
      const result = await saveSleepRule(
        { context: row.dataset.context, start_local: start, end_local: end },
        userId
      );
      if (!result.success) {
        const message = result.errors?._form || Object.values(result.errors || {})[0] || 'Could not save.';
        failures.push(`${SLEEP_CONTEXT_LABELS[row.dataset.context]}: ${message}`);
      }
    }

    if (failures.length) {
      status.textContent = '';
      errorSlot.textContent = failures.join(' ');
      return;
    }

    status.textContent = 'Saved';
    window.dispatchEvent(new CustomEvent('calendar:refresh'));
  });
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function clearErrors(form) {
  form.querySelectorAll('.input-error-msg').forEach((el) => { el.textContent = ''; });
}

function showErrors(form, errors) {
  const map = {
    label: '#pattern-label-error',
    days_of_week: '#pattern-days-error',
    start_local: '#pattern-start-error',
    end_local: '#pattern-end-error',
    sleep_start: '#pattern-sleep-start-error',
    sleep_end: '#pattern-sleep-end-error',
    valid_from: '#pattern-from-error',
    _form: '#pattern-form-error',
  };
  for (const [field, message] of Object.entries(errors)) {
    const slot = form.querySelector(map[field] || map._form);
    if (slot) slot.textContent = message;
  }
}

/** Postgres returns 'HH:MM:SS' for a time column; inputs want 'HH:MM'. */
function shortTime(value) {
  return typeof value === 'string' ? value.slice(0, 5) : '';
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
