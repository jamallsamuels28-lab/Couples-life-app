// ============================================================
// UI Helpers — Couples Life App
// Small presentation-only utilities shared by the feature
// modules. Imports nothing, so it can never create a cycle.
// ============================================================

/**
 * Escapes text for safe interpolation into innerHTML.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Produces a human-readable name from a profile.
 *
 * Profiles created by the `handle_new_user` trigger default `display_name` to
 * the local part of the email (e.g. "jamal.samuels78"), which reads badly in
 * the UI. This takes the first name-like segment, drops trailing digits and
 * title-cases it. An explicitly set display name with a space in it is assumed
 * to be intentional and passed through unchanged.
 *
 * @param {{display_name?: string, email?: string}|null} profile
 * @param {string} [fallback='Partner']
 * @returns {string}
 */
export function displayName(profile, fallback = 'Partner') {
  const raw = profile?.display_name || profile?.email || '';
  if (!raw) return fallback;

  // Already a real name (contains a space) — leave it alone
  if (/\s/.test(raw.trim())) return raw.trim();

  const localPart = raw.split('@')[0];
  const firstSegment = localPart.split(/[._-]/)[0] || localPart;
  const cleaned = firstSegment.replace(/\d+$/, '');
  if (!cleaned) return fallback;

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/**
 * Chevron icon markup for disclosure summaries.
 * Stroked at 1.5px inside a 20px box, per the design system.
 * @returns {string}
 */
export function chevronSvg() {
  return `<svg class="disclosure-icon" viewBox="0 0 20 20" aria-hidden="true"><polyline points="6 8 10 12 14 8"/></svg>`;
}

/**
 * Formats an integer with thousands separators for display.
 * @param {number} value
 * @returns {string}
 */
export function formatNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

/**
 * The calendar date in the user's own timezone, as 'YYYY-MM-DD'.
 *
 * Use this anywhere the app asks "what day is it" — never
 * `toISOString().split('T')[0]`, which answers in UTC. During BST those two
 * disagree between midnight and 01:00, so a meal or a step count logged at
 * 00:30 gets filed under the previous day. That hour is squarely inside a
 * night shift, which is when this app is most likely to be in use.
 *
 * @param {Date} [date=new Date()]
 * @returns {string} 'YYYY-MM-DD' in local time
 */
export function localDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
