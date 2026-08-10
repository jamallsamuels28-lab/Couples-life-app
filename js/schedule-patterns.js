// ============================================================
// Shift Patterns & Sleep Rules — data access
// Implements kiro-algorithm-spec.md §1.1 and §1.1b
// ============================================================

import { supabase, withAuthGuard } from './supabase-client.js';

/** Sunday-first day names, matching days_of_week (0 = Sunday). */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const SLEEP_CONTEXTS = ['default', 'post_night_shift', 'pre_night_shift'];

/**
 * Fetches every shift pattern for the given users, including closed ones.
 * Historic rows are needed as well as current: a week in the past must resolve
 * against the pattern that was actually in force at the time.
 *
 * @param {string[]} userIds
 * @returns {Promise<{success:boolean, patterns?:Object[], error?:string}>}
 */
export async function fetchShiftPatterns(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { success: true, patterns: [] };
  }
  const { data, error } = await supabase
    .from('shift_patterns')
    .select('*')
    .in('user_id', userIds)
    .order('valid_from', { ascending: true });

  if (error) return { success: false, error: 'Could not load shift patterns.' };
  return { success: true, patterns: data || [] };
}

/**
 * Fetches sleep rules for the given users.
 * @param {string[]} userIds
 * @returns {Promise<{success:boolean, rules?:Object[], error?:string}>}
 */
export async function fetchSleepRules(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { success: true, rules: [] };
  }
  const { data, error } = await supabase
    .from('sleep_rules')
    .select('*')
    .in('user_id', userIds);

  if (error) return { success: false, error: 'Could not load sleep rules.' };
  return { success: true, rules: data || [] };
}

/**
 * Groups fetched rows into the { patterns, sleepRules } shape the free-window
 * engine expects, keyed by user id.
 *
 * @param {Object[]} patterns
 * @param {Object[]} rules
 * @param {string} userId
 * @returns {{patterns:Object[], sleepRules:Object[]}}
 */
export function personSchedule(patterns, rules, userId) {
  if (!userId) return { patterns: [], sleepRules: [] };
  return {
    patterns: (patterns || []).filter((p) => p.user_id === userId),
    sleepRules: (rules || []).filter((r) => r.user_id === userId),
  };
}

// ------------------------------------------------------------
// Validation
// ------------------------------------------------------------

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates a shift pattern before it reaches the database.
 * @param {Object} pattern
 * @returns {{valid:boolean, errors:Object}}
 */
export function validatePattern(pattern = {}) {
  const errors = {};

  const label = (pattern.label || '').trim();
  if (label.length < 1 || label.length > 60) {
    errors.label = 'Give the pattern a name between 1 and 60 characters.';
  }

  const days = pattern.days_of_week;
  if (!Array.isArray(days) || days.length === 0) {
    errors.days_of_week = 'Select at least one day.';
  } else if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    errors.days_of_week = 'Days must be 0 (Sunday) to 6 (Saturday).';
  }

  if (!TIME_RE.test(pattern.start_local || '')) errors.start_local = 'Use HH:MM.';
  if (!TIME_RE.test(pattern.end_local || '')) errors.end_local = 'Use HH:MM.';
  if (pattern.start_local && pattern.start_local === pattern.end_local) {
    errors.end_local = 'Start and end cannot be the same time.';
  }

  // Sleep is optional, but if one end is given the other must be too.
  const hasSleepStart = Boolean(pattern.sleep_start);
  const hasSleepEnd = Boolean(pattern.sleep_end);
  if (hasSleepStart !== hasSleepEnd) {
    errors.sleep_start = 'Give both a sleep start and a sleep end, or neither.';
  } else if (hasSleepStart) {
    if (!TIME_RE.test(pattern.sleep_start)) errors.sleep_start = 'Use HH:MM.';
    if (!TIME_RE.test(pattern.sleep_end)) errors.sleep_end = 'Use HH:MM.';
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(pattern.valid_from || '')) {
    errors.valid_from = 'Give a date this pattern starts from.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// ------------------------------------------------------------
// Versioned writes (§1.1b editing rule)
// ------------------------------------------------------------

/**
 * Creates a new shift pattern.
 * @param {Object} pattern
 * @param {string} userId
 */
export async function createPattern(pattern, userId) {
  const { valid, errors } = validatePattern(pattern);
  if (!valid) return { success: false, errors };

  return withAuthGuard(async () => {
    const { data, error } = await supabase
      .from('shift_patterns')
      .insert({ ...normalisePattern(pattern), user_id: userId })
      .select()
      .single();

    if (error) return { success: false, errors: { _form: describeWriteError(error) } };
    return { success: true, pattern: data };
  });
}

/**
 * Supersedes a pattern rather than editing it.
 *
 * Per §1.1b a pattern is NEVER updated in place. The existing row is closed by
 * setting valid_to to the day before the change, and a new row opens on the
 * change date. Editing in place would silently rewrite history: change your
 * shift in October and every past week would retroactively claim you worked
 * the new hours.
 *
 * @param {string} patternId - row being superseded
 * @param {Object} changes - the new pattern values
 * @param {string} effectiveFrom - 'YYYY-MM-DD', the date the change takes effect
 * @param {string} userId
 */
export async function supersedePattern(patternId, changes, effectiveFrom, userId) {
  const candidate = { ...changes, valid_from: effectiveFrom };
  const { valid, errors } = validatePattern(candidate);
  if (!valid) return { success: false, errors };

  const closesOn = previousDay(effectiveFrom);
  if (!closesOn) {
    return { success: false, errors: { _form: 'Invalid effective date.' } };
  }

  return withAuthGuard(async () => {
    // Close the old row first. If the insert then fails, the worst case is a
    // pattern that has ended and not yet been replaced — visible and fixable.
    // The reverse order would trip the overlap trigger and reject the insert.
    const { error: closeError } = await supabase
      .from('shift_patterns')
      .update({ valid_to: closesOn })
      .eq('id', patternId)
      .eq('user_id', userId);

    if (closeError) {
      return { success: false, errors: { _form: 'Could not close the previous pattern.' } };
    }

    const { data, error } = await supabase
      .from('shift_patterns')
      .insert({ ...normalisePattern(candidate), user_id: userId })
      .select()
      .single();

    if (error) {
      // Roll the closure back so the user is not left with no active pattern.
      await supabase
        .from('shift_patterns')
        .update({ valid_to: null })
        .eq('id', patternId)
        .eq('user_id', userId);
      return { success: false, errors: { _form: describeWriteError(error) } };
    }

    return { success: true, pattern: data, supersededId: patternId };
  });
}

/**
 * Upserts a sleep rule for one context.
 * @param {Object} rule - { context, start_local, end_local }
 * @param {string} userId
 */
export async function saveSleepRule(rule, userId) {
  const errors = {};
  if (!SLEEP_CONTEXTS.includes(rule.context)) errors.context = 'Unknown sleep context.';
  if (!TIME_RE.test(rule.start_local || '')) errors.start_local = 'Use HH:MM.';
  if (!TIME_RE.test(rule.end_local || '')) errors.end_local = 'Use HH:MM.';
  if (rule.start_local && rule.start_local === rule.end_local) {
    errors.end_local = 'Sleep cannot start and end at the same time.';
  }
  if (Object.keys(errors).length) return { success: false, errors };

  return withAuthGuard(async () => {
    const { data, error } = await supabase
      .from('sleep_rules')
      .upsert(
        {
          user_id: userId,
          context: rule.context,
          start_local: rule.start_local,
          end_local: rule.end_local,
          crosses_midnight: rule.end_local < rule.start_local,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,context' }
      )
      .select()
      .single();

    if (error) return { success: false, errors: { _form: 'Could not save sleep rule.' } };
    return { success: true, rule: data };
  });
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function normalisePattern(pattern) {
  return {
    label: (pattern.label || '').trim(),
    days_of_week: pattern.days_of_week,
    start_local: pattern.start_local,
    end_local: pattern.end_local,
    sleep_start: pattern.sleep_start || null,
    sleep_end: pattern.sleep_end || null,
    valid_from: pattern.valid_from,
    valid_to: pattern.valid_to || null,
  };
}

/** 'YYYY-MM-DD' one day earlier, or null if the input is unparseable. */
export function previousDay(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) return null;
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return null;
  date.setDate(date.getDate() - 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function describeWriteError(error) {
  const message = error?.message || '';
  if (message.includes('Overlapping shift pattern')) {
    return 'That pattern overlaps one you already have. Close the existing pattern first.';
  }
  return 'Could not save the pattern. Please try again.';
}
