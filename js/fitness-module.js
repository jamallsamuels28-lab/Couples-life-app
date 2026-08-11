// ============================================================
// Fitness module — data access and view (kiro-algorithm-spec.md §4)
// ============================================================
//
// The formulas live in fitness-engine.js. This file fetches, writes, and
// renders; it deliberately contains no training maths of its own.
// ============================================================

import { supabase, withAuthGuard } from './supabase-client.js';
import { getCurrentUser, getPartner } from './app-shell.js';
import { activate as activateStepsSection } from './steps-module.js';
import { renderExerciseLibrary } from './exercise-library.js';
import { escapeHtml, chevronSvg, formatNumber, localDateKey } from './ui-helpers.js';
import {
  MET,
  estimate1RM,
  bestE1RM,
  sessionVolume,
  weeklyVolumePerPattern,
  nextProgression,
  acwr,
  isDetraining,
  deloadCheck,
  trainingKcal,
  perLimbSummary,
  isRestricted,
  groupSessions,
} from './fitness-engine.js';

const PATTERN_LABELS = {
  squat: 'Squat', hinge: 'Hinge', push_h: 'Horizontal push', push_v: 'Vertical push',
  pull_h: 'Horizontal pull', pull_v: 'Vertical pull', carry: 'Carry', isolation: 'Isolation',
};

const DEFAULT_REP_RANGE = [8, 12];
const LOOKBACK_DAYS = 28;

// ------------------------------------------------------------
// Data access
// ------------------------------------------------------------

export async function fetchExercises() {
  const { data, error } = await supabase.from('exercises').select('*').order('name');
  if (error) return { success: false, error: 'Could not load the exercise list.' };
  return { success: true, exercises: data || [] };
}

/**
 * Sets for one person over the lookback window.
 * @param {string} userId
 * @param {number} [days=28]
 */
export async function fetchSets(userId, days = LOOKBACK_DAYS) {
  if (!userId) return { success: true, sets: [] };
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data, error } = await supabase
    .from('sets')
    .select('*')
    .eq('user_id', userId)
    .gte('performed_at', since)
    .order('performed_at', { ascending: false });

  if (error) return { success: false, error: 'Could not load your training history.' };
  return { success: true, sets: data || [] };
}

/**
 * Validates a set before it reaches the database.
 * @param {Object} input
 */
export function validateSet(input = {}) {
  const errors = {};

  if (!input.exercise_id) errors.exercise_id = 'Pick an exercise.';

  const weight = Number(input.weight_kg);
  if (!Number.isFinite(weight) || weight < 0 || weight > 500) {
    errors.weight_kg = 'Weight must be between 0 and 500 kg.';
  }

  const reps = Number(input.reps);
  if (!Number.isInteger(reps) || reps < 1 || reps > 100) {
    errors.reps = 'Reps must be a whole number between 1 and 100.';
  }

  // RIR is optional, but a value outside 0–5 is a typo rather than a reading.
  if (input.rir !== null && input.rir !== undefined && input.rir !== '') {
    const rir = Number(input.rir);
    if (!Number.isInteger(rir) || rir < 0 || rir > 5) {
      errors.rir = 'Reps in reserve run from 0 to 5.';
    }
  }

  if (input.side && !['both', 'left', 'right'].includes(input.side)) {
    errors.side = 'Side must be both, left or right.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Logs a set. The client generates the id so an offline retry cannot
 * double-insert (§0.5).
 */
export async function logSet(input, userId, sessionId) {
  const { valid, errors } = validateSet(input);
  if (!valid) return { success: false, errors };

  return withAuthGuard(async () => {
    const row = {
      id: crypto.randomUUID(),
      user_id: userId,
      session_id: sessionId,
      exercise_id: input.exercise_id,
      weight_kg: Number(input.weight_kg),
      reps: Number(input.reps),
      rir: input.rir === '' || input.rir === null || input.rir === undefined ? null : Number(input.rir),
      side: input.side || 'both',
      is_warmup: Boolean(input.is_warmup),
      performed_at: new Date().toISOString(),
    };

    const { data, error } = await supabase.from('sets').insert(row).select().single();
    if (error) return { success: false, errors: { _form: 'Could not save the set.' } };
    return { success: true, set: data };
  });
}

export async function deleteSet(setId, userId) {
  return withAuthGuard(async () => {
    const { error } = await supabase.from('sets').delete().eq('id', setId).eq('user_id', userId);
    if (error) return { success: false, error: 'Could not delete the set.' };
    return { success: true };
  });
}

/**
 * Marks an exercise as currently off-limits for someone, or clears it.
 *
 * This is what keeps a rehab block from poisoning the numbers: a restricted
 * lift stops being offered, and per-limb work stays out of bilateral PRs.
 */
export async function setRestriction(exerciseId, userId, restricted) {
  return withAuthGuard(async () => {
    const { data: exercise, error: readError } = await supabase
      .from('exercises').select('restricted_for').eq('id', exerciseId).single();
    if (readError) return { success: false, error: 'Could not read the exercise.' };

    const current = new Set(exercise.restricted_for || []);
    if (restricted) current.add(userId); else current.delete(userId);

    const { error } = await supabase
      .from('exercises').update({ restricted_for: [...current] }).eq('id', exerciseId);
    if (error) return { success: false, error: 'Could not update the restriction.' };
    return { success: true };
  });
}

// ------------------------------------------------------------
// Training sessions (§4.5 needs a real duration, not an assumed hour)
// ------------------------------------------------------------

export async function fetchSessions(userId, days = LOOKBACK_DAYS) {
  if (!userId) return { success: true, sessions: [] };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await supabase
    .from('training_sessions').select('*')
    .eq('user_id', userId).gte('started_at', since)
    .order('started_at', { ascending: false });
  if (error) return { success: false, error: 'Could not load sessions.' };
  return { success: true, sessions: data || [] };
}

/** The session still running, if there is one. */
export async function fetchOpenSession(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('training_sessions').select('*')
    .eq('user_id', userId).is('ended_at', null)
    .order('started_at', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

export async function startSession(userId, intensity = 'moderate') {
  return withAuthGuard(async () => {
    const row = {
      id: crypto.randomUUID(),
      user_id: userId,
      started_at: new Date().toISOString(),
      intensity,
    };
    const { data, error } = await supabase
      .from('training_sessions').insert(row).select().single();
    if (error) return { success: false, error: 'Could not start the session.' };
    return { success: true, session: data };
  });
}

export async function endSession(sessionId, userId) {
  return withAuthGuard(async () => {
    const { error } = await supabase
      .from('training_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', sessionId).eq('user_id', userId);
    if (error) return { success: false, error: 'Could not end the session.' };
    return { success: true };
  });
}

/**
 * Hours a session actually lasted.
 *
 * An unclosed session is capped rather than counted open-ended — forgetting to
 * press stop should not credit you with a fourteen-hour workout.
 */
export function sessionHours(session, { capHours = 3 } = {}) {
  if (!session?.started_at) return null;
  const start = new Date(session.started_at).getTime();
  const end = session.ended_at ? new Date(session.ended_at).getTime() : null;
  if (!Number.isFinite(start)) return null;
  if (end === null) return null;
  const hours = (end - start) / 3600000;
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.min(hours, capHours);
}

/** Body weight, needed for the MET calculation. Falls back rather than guessing wildly. */
export async function fetchBodyWeight(userId) {
  const { data } = await supabase
    .from('user_settings').select('setting_value')
    .eq('user_id', userId).eq('setting_key', 'body_weight_kg').maybeSingle();
  const value = Number(data?.setting_value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// ------------------------------------------------------------
// View
// ------------------------------------------------------------

let activeSessionId = null;

export function activateFitnessView(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="dashboard-stack" id="fitness-dashboard">
      <p class="view-placeholder-text">Loading training…</p>
    </div>
    <details class="disclosure" id="set-form-disclosure" open>
      <summary><span>Log a set</span>${chevronSvg()}</summary>
      <div class="disclosure-body" id="set-form-mount"></div>
    </details>
    <details class="disclosure" id="exercise-library-disclosure">
      <summary><span>Exercise library</span>${chevronSvg()}</summary>
      <div class="disclosure-body" id="exercise-library-mount"></div>
    </details>
    <details class="disclosure" id="restriction-disclosure">
      <summary><span>Restricted exercises</span>${chevronSvg()}</summary>
      <div class="disclosure-body" id="restriction-mount"></div>
    </details>

    <div class="section-heading mt-4">
      <h3>Steps</h3>
      <span class="section-meta">Daily movement</span>
    </div>
    <div id="steps-mount"></div>
  `;

  renderFitnessDashboard(container.querySelector('#fitness-dashboard'));

  // Built on first open rather than on view load: the library is 700-odd rows
  // and most visits to this tab are to log a set, not to browse.
  const libraryDisclosure = container.querySelector('#exercise-library-disclosure');
  libraryDisclosure?.addEventListener('toggle', async () => {
    const mount = container.querySelector('#exercise-library-mount');
    if (!libraryDisclosure.open || !mount || mount.dataset.loaded) return;
    mount.dataset.loaded = 'true';
    mount.innerHTML = `<p class="view-placeholder-text">Loading exercises…</p>`;

    const result = await fetchExercises();
    if (!result.success) {
      mount.dataset.loaded = '';
      mount.innerHTML = `<div class="empty-state">${result.error}</div>`;
      return;
    }
    renderExerciseLibrary(mount, result.exercises);
  });

  // Steps is part of training, not a separate concern — walking volume feeds
  // the same energy expenditure figure as a session does.
  activateStepsSection(container.querySelector('#steps-mount'));
}

export async function renderFitnessDashboard(mount) {
  if (!mount) return;
  const user = getCurrentUser();
  if (!user) {
    mount.innerHTML = `<div class="empty-state">Sign in to see your training.</div>`;
    return;
  }

  const [exerciseResult, setResult, bodyWeight, sessionResult, openSession] = await Promise.all([
    fetchExercises(),
    fetchSets(user.id),
    fetchBodyWeight(user.id),
    fetchSessions(user.id),
    fetchOpenSession(user.id),
  ]);

  if (!exerciseResult.success || !setResult.success) {
    mount.innerHTML = `<div class="empty-state">Could not load training data. Check your connection and try again.</div>`;
    return;
  }

  const exercises = exerciseResult.exercises;
  const sets = setResult.sets;
  const exerciseById = new Map(exercises.map(e => [e.id, e]));

  const load = acwr(sets);
  const detraining = isDetraining(sets);
  const sessions = groupSessions(sets);
  const weekSets = sets.filter(s => new Date(s.performed_at) >= new Date(Date.now() - 7 * 86400000));
  const patterns = weeklyVolumePerPattern(weekSets, exercises);
  const restricted = exercises.filter(e => isRestricted(e, user.id));

  const trainingSessions = sessionResult.success ? sessionResult.sessions : [];

  mount.innerHTML = `
    ${renderSessionControl(openSession)}
    ${renderLoadCard(load, detraining, sessions.length)}
    ${renderVolumeCard(patterns, weekSets)}
    ${restricted.length ? renderRehabCard(restricted, sets, user.id, exerciseById) : ''}
    ${renderLiftsCard(sets, exerciseById, user.id)}
    ${renderSessionsCard(sessions.slice(0, 5), exerciseById, bodyWeight, trainingSessions)}
  `;

  wireSessionControl(mount, user.id, openSession);

  const container = mount.closest('#fitness-view') || document;
  renderSetForm(container.querySelector('#set-form-mount'), exercises, user.id);
  renderRestrictionEditor(container.querySelector('#restriction-mount'), exercises, user.id);
}

/**
 * Start/stop control. Training calories need a real duration — an assumed hour
 * can be out by a factor of two, and it feeds straight into TDEE.
 */
function renderSessionControl(openSession) {
  if (openSession) {
    const started = new Date(openSession.started_at);
    return `
      <div class="card session-control session-control--live">
        <div class="card-body session-control-row">
          <div>
            <span class="session-control-label">Session running</span>
            <span class="session-control-meta num">
              since ${String(started.getHours()).padStart(2, '0')}:${String(started.getMinutes()).padStart(2, '0')}
            </span>
          </div>
          <button type="button" class="btn btn-primary" data-end-session="${openSession.id}">Finish</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="card session-control">
      <div class="card-body session-control-row">
        <div>
          <span class="session-control-label">No session running</span>
          <span class="session-control-meta">Start one so training calories use real time</span>
        </div>
        <div class="session-control-actions">
          <button type="button" class="btn btn-secondary" data-start-session="moderate">Moderate</button>
          <button type="button" class="btn btn-primary" data-start-session="vigorous">Vigorous</button>
        </div>
      </div>
    </div>
  `;
}

function wireSessionControl(mount, userId, openSession) {
  mount.querySelectorAll('[data-start-session]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await startSession(userId, button.dataset.startSession);
      if (!result.success) { button.disabled = false; return; }
      activeSessionId = result.session.id;
      window.dispatchEvent(new CustomEvent('fitness:refresh'));
    });
  });

  const endButton = mount.querySelector('[data-end-session]');
  if (endButton) {
    // Reuse the open session for any sets logged this visit, so the sets and
    // the timed session agree with each other.
    activeSessionId = openSession?.id || activeSessionId;
    endButton.addEventListener('click', async () => {
      endButton.disabled = true;
      const result = await endSession(endButton.dataset.endSession, userId);
      if (!result.success) { endButton.disabled = false; return; }
      activeSessionId = null;
      window.dispatchEvent(new CustomEvent('fitness:refresh'));
    });
  }
}

function renderLoadCard(load, detraining, sessionCount) {
  // The gauge is a bar with the optimal band marked, not a dial — a dial
  // implies precision this ratio does not have.
  const position = load.ratio === null ? null : Math.min(load.ratio / 2, 1) * 100;

  return `
    <div class="card">
      <div class="card-header">
        <h3 class="card-title">Training load</h3>
        <span class="section-meta num">${sessionCount} session${sessionCount === 1 ? '' : 's'} · 28d</span>
      </div>
      <div class="card-body">
        <div class="load-value">
          <span class="load-num num">${load.ratio === null ? '—' : load.ratio.toFixed(2)}</span>
          <span class="load-label">acute : chronic</span>
        </div>
        ${position === null ? '' : `
          <div class="load-gauge" role="img" aria-label="Load ratio ${load.ratio}, optimal band 0.8 to 1.3">
            <span class="load-band"></span>
            <span class="load-marker" style="left:${position.toFixed(2)}%"></span>
          </div>
          <div class="load-scale">
            <span class="num">0</span><span class="num">0.8</span><span class="num">1.3</span><span class="num">2.0</span>
          </div>
        `}
        <p class="field-hint">${escapeHtml(load.message)}</p>
        ${detraining ? `<p class="field-hint">Below the band for a fortnight now — that is detraining rather than a light week.</p>` : ''}
        <div class="load-figures">
          <span>Last 7 days <span class="num">${formatNumber(load.acute)}</span> kg/day</span>
          <span>Last 28 days <span class="num">${formatNumber(load.chronic)}</span> kg/day</span>
        </div>
      </div>
    </div>
  `;
}

function renderVolumeCard(patterns, weekSets) {
  const entries = Object.entries(patterns).sort((a, b) => b[1] - a[1]);
  const max = entries.length ? entries[0][1] : 0;

  return `
    <div class="card mt-4">
      <div class="card-header">
        <h3 class="card-title">This week by pattern</h3>
        <span class="section-meta num">${weekSets.filter(s => !s.is_warmup).length} sets</span>
      </div>
      <div class="card-body">
        ${entries.length === 0
          ? `<div class="empty-state">Nothing logged in the last seven days.</div>`
          : entries.map(([pattern, volume]) => `
              <div class="pattern-row">
                <span class="pattern-name">${escapeHtml(PATTERN_LABELS[pattern] || pattern)}</span>
                <span class="pattern-bar"><i style="width:${max ? (volume / max * 100).toFixed(1) : 0}%"></i></span>
                <span class="pattern-volume num">${formatNumber(Math.round(volume))}</span>
              </div>
            `).join('')}
      </div>
    </div>
  `;
}

/**
 * Per-limb panel. Only shown when something is restricted, because for
 * everyone else it is noise.
 */
function renderRehabCard(restrictedExercises, sets, userId, exerciseById) {
  const unilateralSets = sets.filter(s => (s.side || 'both') !== 'both');
  const byExercise = new Map();
  for (const set of unilateralSets) {
    if (!byExercise.has(set.exercise_id)) byExercise.set(set.exercise_id, []);
    byExercise.get(set.exercise_id).push(set);
  }

  const rows = [...byExercise.entries()].map(([exerciseId, group]) => {
    const summary = perLimbSummary(group);
    const name = exerciseById.get(exerciseId)?.name || 'Exercise';
    return `
      <div class="limb-row">
        <span class="limb-name">${escapeHtml(name)}</span>
        <span class="limb-side">L <span class="num">${summary.left.bestE1RM ?? '—'}</span></span>
        <span class="limb-side">R <span class="num">${summary.right.bestE1RM ?? '—'}</span></span>
        <span class="limb-deficit num">${summary.deficitPct === null ? '—' : summary.deficitPct + '%'}</span>
      </div>
    `;
  });

  return `
    <div class="card mt-4">
      <div class="card-header">
        <h3 class="card-title">Rehab</h3>
        <span class="section-meta">${restrictedExercises.length} restricted</span>
      </div>
      <div class="card-body">
        <p class="field-hint">
          Single-limb sets are tracked per side and kept out of your two-sided
          bests, so a rehab block does not read as a regression.
        </p>
        ${rows.length
          ? `<div class="limb-table">
              <div class="limb-row limb-row--head">
                <span>Exercise</span><span>Left</span><span>Right</span><span>Deficit</span>
              </div>
              ${rows.join('')}
            </div>`
          : `<div class="empty-state">No single-limb sets logged yet.</div>`}
        <p class="field-hint">
          Currently off-limits: ${restrictedExercises.map(e => escapeHtml(e.name)).join(', ')}.
        </p>
      </div>
    </div>
  `;
}

function renderLiftsCard(sets, exerciseById, userId) {
  const byExercise = new Map();
  for (const set of sets) {
    if (set.is_warmup) continue;
    if (!byExercise.has(set.exercise_id)) byExercise.set(set.exercise_id, []);
    byExercise.get(set.exercise_id).push(set);
  }

  const rows = [...byExercise.entries()].map(([exerciseId, group]) => {
    const exercise = exerciseById.get(exerciseId) || {};
    const best = bestE1RM(group);
    const sessions = groupSessions(group);
    const lastSession = sessions[0]?.sets || [];
    const next = nextProgression({ sets: lastSession, repRange: DEFAULT_REP_RANGE, exercise });
    const deload = deloadCheck({
      sessionsForLift: sessions.map(s => s.sets),
      allSets: sets,
    });

    return {
      name: exercise.name || 'Exercise',
      best,
      next,
      deload,
      lastAt: sessions[0]?.performedAt,
    };
  }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  return `
    <div class="card mt-4">
      <div class="card-header">
        <h3 class="card-title">Lifts</h3>
        <span class="section-meta num">${rows.length}</span>
      </div>
      <div class="card-body">
        ${rows.length === 0
          ? `<div class="empty-state">No working sets logged yet.</div>`
          : rows.map(row => `
              <div class="lift-row">
                <div class="lift-main">
                  <span class="lift-name">${escapeHtml(row.name)}</span>
                  <span class="lift-next">
                    ${row.next
                      ? `Next: <span class="num">${row.next.weightKg}</span> kg × <span class="num">${row.next.targetReps}</span>`
                      : 'No prescription yet'}
                  </span>
                  ${row.deload.suggest
                    ? `<span class="lift-flag">${escapeHtml(row.deload.message)}</span>`
                    : ''}
                </div>
                <div class="lift-e1rm">
                  <span class="num">${row.best ? row.best.value : '—'}</span>
                  <span class="lift-e1rm-label">e1RM</span>
                </div>
              </div>
            `).join('')}
      </div>
    </div>
  `;
}

function renderSessionsCard(sessions, exerciseById, bodyWeight, trainingSessions = []) {
  const timedById = new Map(trainingSessions.map(s => [s.id, s]));
  return `
    <div class="card mt-4">
      <div class="card-header">
        <h3 class="card-title">Recent sessions</h3>
      </div>
      <div class="card-body">
        ${sessions.length === 0
          ? `<div class="empty-state">Nothing logged yet.</div>`
          : sessions.map((session) => {
              const volume = sessionVolume(session.sets);
              // Only report calories when the session was actually timed.
              // Assuming an hour can be out by a factor of two, and it feeds
              // straight into TDEE and from there into the calorie target.
              const timed = timedById.get(session.sessionId);
              const hours = sessionHours(timed);
              const kcal = bodyWeight && hours
                ? trainingKcal({
                    met: timed.intensity === 'vigorous'
                      ? MET.resistance_vigorous
                      : MET.resistance_moderate,
                    weightKg: bodyWeight,
                    hours,
                  })
                : null;
              const names = [...new Set(session.sets.map(s => exerciseById.get(s.exercise_id)?.name).filter(Boolean))];
              return `
                <div class="session-row">
                  <div class="session-main">
                    <span class="session-date num">${localDateKey(session.performedAt)}</span>
                    <span class="session-lifts">${escapeHtml(names.slice(0, 3).join(', ')) || 'Session'}</span>
                  </div>
                  <div class="session-figures">
                    <span class="num">${formatNumber(Math.round(volume))}</span> kg
                    ${kcal !== null
                      ? `<span class="divider">·</span> <span class="num">${kcal}</span> kcal`
                      : `<span class="divider">·</span> <span title="Session was not timed">untimed</span>`}
                  </div>
                </div>
              `;
            }).join('')}
        ${bodyWeight === null ? `
          <p class="field-hint">
            Add your body weight in settings to get training calories — the MET
            formula needs it and guessing would be worse than leaving it blank.
          </p>` : ''}
        <p class="field-hint">
          Sessions you did not start and finish here show as untimed rather
          than being credited a guessed hour.
        </p>
      </div>
    </div>
  `;
}

// ------------------------------------------------------------
// Set logging form
// ------------------------------------------------------------

export function renderSetForm(mount, exercises, userId) {
  if (!mount) return;
  const available = exercises.filter(e => !isRestricted(e, userId));

  mount.innerHTML = `
    <form id="set-form" novalidate>
      <div class="input-group">
        <label class="input-label" for="set-exercise">Exercise</label>
        <select id="set-exercise" class="input">
          <option value="">Choose…</option>
          ${available.map(e => `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join('')}
        </select>
        <span id="set-exercise-error" class="input-error-msg" aria-live="polite"></span>
      </div>

      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="set-weight">Weight (kg)</label>
          <input type="number" id="set-weight" class="input num" step="0.25" min="0" max="500" inputmode="decimal" />
          <span id="set-weight-error" class="input-error-msg" aria-live="polite"></span>
        </div>
        <div class="input-group">
          <label class="input-label" for="set-reps">Reps</label>
          <input type="number" id="set-reps" class="input num" step="1" min="1" max="100" inputmode="numeric" />
          <span id="set-reps-error" class="input-error-msg" aria-live="polite"></span>
        </div>
      </div>

      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="set-rir">Reps in reserve</label>
          <input type="number" id="set-rir" class="input num" step="1" min="0" max="5" inputmode="numeric" placeholder="optional" />
          <span id="set-rir-error" class="input-error-msg" aria-live="polite"></span>
        </div>
        <div class="input-group">
          <label class="input-label" for="set-side">Side</label>
          <select id="set-side" class="input">
            <option value="both">Both</option>
            <option value="left">Left only</option>
            <option value="right">Right only</option>
          </select>
        </div>
      </div>

      <label class="off-toggle"><input type="checkbox" id="set-warmup" /> Warm-up set</label>
      <p class="field-hint">Warm-ups are logged but excluded from volume, e1RM and progression.</p>

      <span id="set-form-error" class="input-error-msg" aria-live="polite"></span>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Log set</button>
        <span class="form-status num" id="set-status" aria-live="polite"></span>
      </div>
    </form>
    <div id="set-estimate" class="set-estimate" aria-live="polite"></div>
  `;

  wireSetForm(mount, userId);
}

function wireSetForm(mount, userId) {
  const form = mount.querySelector('#set-form');
  const estimate = mount.querySelector('#set-estimate');
  const weight = form.querySelector('#set-weight');
  const reps = form.querySelector('#set-reps');
  const rir = form.querySelector('#set-rir');

  // Live e1RM as you type, so the number is visible before committing the set.
  const updateEstimate = () => {
    const result = estimate1RM({ weight_kg: weight.value, reps: reps.value, rir: rir.value || null });
    if (!result) { estimate.textContent = ''; return; }
    if (!result.reliable) {
      estimate.textContent = 'Above 12 effective reps the 1RM estimate is not worth showing.';
      return;
    }
    estimate.innerHTML = `Estimated 1RM <span class="num">${result.value}</span> kg${result.atFailure ? ' at failure' : ''}`;
  };
  [weight, reps, rir].forEach(input => input.addEventListener('input', updateEstimate));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    form.querySelectorAll('.input-error-msg').forEach(el => { el.textContent = ''; });

    const status = form.querySelector('#set-status');
    const input = {
      exercise_id: form.querySelector('#set-exercise').value,
      weight_kg: weight.value,
      reps: reps.value,
      rir: rir.value,
      side: form.querySelector('#set-side').value,
      is_warmup: form.querySelector('#set-warmup').checked,
    };

    const { valid, errors } = validateSet(input);
    if (!valid) {
      showSetErrors(form, errors);
      return;
    }

    // One session id per visit; a new one starts when the view reloads.
    if (!activeSessionId) activeSessionId = crypto.randomUUID();

    status.textContent = 'Saving…';
    const result = await logSet(input, userId, activeSessionId);

    if (!result.success) {
      status.textContent = '';
      showSetErrors(form, result.errors || {});
      return;
    }

    status.textContent = 'Logged';
    reps.value = '';
    rir.value = '';
    estimate.textContent = '';
    window.dispatchEvent(new CustomEvent('fitness:refresh'));
  });
}

function showSetErrors(form, errors) {
  const map = {
    exercise_id: '#set-exercise-error',
    weight_kg: '#set-weight-error',
    reps: '#set-reps-error',
    rir: '#set-rir-error',
    _form: '#set-form-error',
  };
  for (const [field, message] of Object.entries(errors)) {
    const slot = form.querySelector(map[field] || map._form);
    if (slot) slot.textContent = message;
  }
}

// ------------------------------------------------------------
// Restrictions
// ------------------------------------------------------------

export function renderRestrictionEditor(mount, exercises, userId) {
  if (!mount) return;

  mount.innerHTML = `
    <p class="field-hint">
      Mark anything you cannot currently do. Restricted lifts stop being offered
      in the set form and stay out of your progression targets.
    </p>
    <div class="restriction-list">
      ${exercises.map(e => `
        <label class="restriction-row">
          <input type="checkbox" data-exercise="${e.id}" ${isRestricted(e, userId) ? 'checked' : ''} />
          <span>${escapeHtml(e.name)}</span>
        </label>
      `).join('')}
    </div>
    <span class="form-status num" id="restriction-status" aria-live="polite"></span>
  `;

  const status = mount.querySelector('#restriction-status');
  mount.querySelectorAll('[data-exercise]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      status.textContent = 'Saving…';
      const result = await setRestriction(checkbox.dataset.exercise, userId, checkbox.checked);
      if (!result.success) {
        checkbox.checked = !checkbox.checked;
        status.textContent = result.error;
        return;
      }
      status.textContent = 'Saved';
      window.dispatchEvent(new CustomEvent('fitness:refresh'));
    });
  });
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------

export function initFitnessModule() {
  window.addEventListener('viewchange', (event) => {
    if (event.detail.view === 'fitness') {
      activeSessionId = null;
      const container = document.getElementById('fitness-view');
      if (container) activateFitnessView(container);
    }
  });

  window.addEventListener('fitness:refresh', () => {
    const container = document.getElementById('fitness-view');
    const mount = container?.querySelector('#fitness-dashboard');
    if (mount) renderFitnessDashboard(mount);
  });
}
