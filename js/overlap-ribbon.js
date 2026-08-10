// ============================================================
// Overlap Ribbon Component — Couples Life App
// Renders the signature UI element showing both partners' schedules
// as tracks with a combined band highlighting mutual free windows.
//
// Requirements: 13.9
// ============================================================

/**
 * @typedef {Object} OverlapRibbonOptions
 * @property {Array<{start: Date, end: Date}>} freeWindows - Mutual free windows (from bothFreeWindows)
 * @property {Array<{start: Date|string, end: Date|string, userId?: string}>} busyBlocksA - Partner A busy blocks
 * @property {Array<{start: Date|string, end: Date|string, userId?: string}>} busyBlocksB - Partner B busy blocks
 * @property {Date} dayStart - Start of the display range (typically dayStartHour on the date)
 * @property {Date} dayEnd - End of the display range (typically dayEndHour on the date)
 * @property {string} [labelA='Partner A'] - Display name for partner A
 * @property {string} [labelB='Partner B'] - Display name for partner B
 * @property {number} [dayStartHour=8] - Waking hour start
 * @property {number} [dayEndHour=23] - Waking hour end
 */

/**
 * Creates and returns an overlap ribbon DOM element.
 * The ribbon shows:
 * - Two tracks (partner A and partner B) with busy/sleep blocks in identity colours
 * - A combined band below highlighting mutual free windows with a gradient
 * - Hour markers along the top
 * - Total free time display
 *
 * @param {OverlapRibbonOptions} options
 * @returns {HTMLElement} The rendered overlap ribbon element
 */
export function createOverlapRibbon(options) {
  const {
    freeWindows = [],
    busyBlocksA = [],
    busyBlocksB = [],
    dayStart,
    dayEnd,
    labelA = 'Partner A',
    labelB = 'Partner B',
    dayStartHour = 8,
    dayEndHour = 23,
  } = options;

  const container = document.createElement('div');
  container.className = 'overlap-ribbon';
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', buildAriaLabel(freeWindows, labelA, labelB));

  const rangeStartMs = toMs(dayStart);
  const rangeEndMs = toMs(dayEnd);
  const totalRangeMs = rangeEndMs - rangeStartMs;

  if (totalRangeMs <= 0) {
    container.innerHTML = '<div class="overlap-ribbon__empty">No time range to display</div>';
    return container;
  }

  // --- Header ---
  const totalFreeMinutes = computeTotalFreeMinutes(freeWindows);
  container.appendChild(buildHeader(totalFreeMinutes));

  // --- Hour markers ---
  container.appendChild(buildHourMarkers(dayStartHour, dayEndHour, rangeStartMs, totalRangeMs));

  // --- Tracks container ---
  const tracksContainer = document.createElement('div');
  tracksContainer.className = 'overlap-ribbon__tracks';

  // Partner A track
  tracksContainer.appendChild(
    buildTrack(busyBlocksA, 'a', labelA, rangeStartMs, rangeEndMs, totalRangeMs)
  );

  // Partner B track
  tracksContainer.appendChild(
    buildTrack(busyBlocksB, 'b', labelB, rangeStartMs, rangeEndMs, totalRangeMs)
  );

  container.appendChild(tracksContainer);

  // --- Combined free-time band ---
  container.appendChild(
    buildCombinedBand(freeWindows, rangeStartMs, rangeEndMs, totalRangeMs)
  );

  return container;
}

/**
 * Renders the overlap ribbon into the given container element.
 * Clears existing content within that container.
 *
 * @param {HTMLElement} container - Target DOM element
 * @param {OverlapRibbonOptions} options
 */
export function renderOverlapRibbon(container, options) {
  container.innerHTML = '';
  container.appendChild(createOverlapRibbon(options));
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Converts a Date or timestamp to milliseconds.
 * @param {Date|string|number} value
 * @returns {number}
 */
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/**
 * Computes total free time in minutes across all windows.
 * @param {Array<{start: Date, end: Date}>} windows
 * @returns {number}
 */
function computeTotalFreeMinutes(windows) {
  let totalMs = 0;
  for (const w of windows) {
    totalMs += toMs(w.end) - toMs(w.start);
  }
  return Math.round(totalMs / 60000);
}

/**
 * Formats minutes into a human-friendly duration string.
 * @param {number} minutes
 * @returns {string}
 */
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * Builds the header row with eyebrow label and total free time.
 * @param {number} totalMinutes
 * @returns {HTMLElement}
 */
function buildHeader(totalMinutes) {
  const header = document.createElement('div');
  header.className = 'overlap-ribbon__header';
  header.innerHTML = `
    <span class="overlap-ribbon__label">Free together</span>
    <span class="overlap-ribbon__total">${formatDuration(totalMinutes)} free</span>
  `;
  return header;
}

/**
 * Builds hour marker elements positioned along the time axis.
 * @param {number} startHour
 * @param {number} endHour
 * @param {number} rangeStartMs
 * @param {number} totalRangeMs
 * @returns {HTMLElement}
 */
function buildHourMarkers(startHour, endHour, rangeStartMs, totalRangeMs) {
  const row = document.createElement('div');
  row.className = 'overlap-ribbon__hours';
  row.setAttribute('aria-hidden', 'true');

  // Show hour marks at regular intervals; skip if too many
  const totalHours = endHour - startHour;
  const step = totalHours > 12 ? 2 : 1;

  for (let h = startHour; h <= endHour; h += step) {
    const mark = document.createElement('span');
    mark.className = 'overlap-ribbon__hour-mark';

    // Position: percentage of the range
    const hourMs = h * 3600000;
    const startOfDayMs = rangeStartMs - (startHour * 3600000);
    const offsetMs = (startOfDayMs + hourMs) - rangeStartMs;
    const pct = (offsetMs / totalRangeMs) * 100;
    mark.style.left = `${Math.max(0, Math.min(100, pct))}%`;

    // Format: 8, 9, ... 22, 23 (24-hour, no leading zero)
    mark.textContent = String(h);
    row.appendChild(mark);
  }

  return row;
}

/**
 * Builds a single partner track with busy blocks rendered inside.
 * @param {Array} busyBlocks - Busy intervals for this partner
 * @param {'a'|'b'} identity - Partner identity (a or b)
 * @param {string} label - Partner display name
 * @param {number} rangeStartMs
 * @param {number} rangeEndMs
 * @param {number} totalRangeMs
 * @returns {HTMLElement}
 */
function buildTrack(busyBlocks, identity, label, rangeStartMs, rangeEndMs, totalRangeMs) {
  const track = document.createElement('div');
  track.className = 'overlap-ribbon__track';
  track.setAttribute('aria-label', `${label} schedule`);

  // Track label
  const trackLabel = document.createElement('span');
  trackLabel.className = 'overlap-ribbon__track-label';
  trackLabel.textContent = label;
  track.appendChild(trackLabel);

  // Render busy blocks
  for (const block of busyBlocks) {
    const blockStartMs = Math.max(toMs(block.start), rangeStartMs);
    const blockEndMs = Math.min(toMs(block.end), rangeEndMs);

    if (blockEndMs <= blockStartMs) continue;

    const leftPct = ((blockStartMs - rangeStartMs) / totalRangeMs) * 100;
    const widthPct = ((blockEndMs - blockStartMs) / totalRangeMs) * 100;

    const blockEl = document.createElement('div');
    blockEl.className = `overlap-ribbon__block overlap-ribbon__block--${identity}`;
    blockEl.style.left = `${leftPct}%`;
    blockEl.style.width = `${widthPct}%`;
    blockEl.setAttribute('aria-hidden', 'true');
    track.appendChild(blockEl);
  }

  return track;
}

/**
 * Builds the combined band showing mutual free windows with gradient.
 * Minor windows (shorter than the longest) are rendered at reduced opacity.
 * @param {Array<{start: Date, end: Date}>} freeWindows
 * @param {number} rangeStartMs
 * @param {number} rangeEndMs
 * @param {number} totalRangeMs
 * @returns {HTMLElement}
 */
function buildCombinedBand(freeWindows, rangeStartMs, rangeEndMs, totalRangeMs) {
  const band = document.createElement('div');
  band.className = 'overlap-ribbon__combined';
  band.setAttribute('aria-label', 'Mutual free time');

  // Label
  const bandLabel = document.createElement('span');
  bandLabel.className = 'overlap-ribbon__combined-label';
  bandLabel.textContent = 'Both free';
  band.appendChild(bandLabel);

  if (freeWindows.length === 0) {
    return band;
  }

  // Find the longest window duration to determine major vs minor
  let longestDurationMs = 0;
  for (const w of freeWindows) {
    const dur = toMs(w.end) - toMs(w.start);
    if (dur > longestDurationMs) longestDurationMs = dur;
  }

  // Render each free window segment
  for (const w of freeWindows) {
    const wStartMs = Math.max(toMs(w.start), rangeStartMs);
    const wEndMs = Math.min(toMs(w.end), rangeEndMs);

    if (wEndMs <= wStartMs) continue;

    const leftPct = ((wStartMs - rangeStartMs) / totalRangeMs) * 100;
    const widthPct = ((wEndMs - wStartMs) / totalRangeMs) * 100;
    const durationMs = toMs(w.end) - toMs(w.start);

    const segment = document.createElement('div');
    // overlap-fill class provides the gradient (from components.css)
    const isMinor = durationMs < longestDurationMs;
    segment.className = `overlap-ribbon__free overlap-fill${isMinor ? ' overlap-ribbon__free--minor' : ''}`;
    segment.style.left = `${leftPct}%`;
    segment.style.width = `${widthPct}%`;
    segment.setAttribute('aria-hidden', 'true');
    band.appendChild(segment);
  }

  return band;
}

/**
 * Builds an accessible aria-label summarizing the ribbon content.
 * @param {Array<{start: Date, end: Date}>} freeWindows
 * @param {string} labelA
 * @param {string} labelB
 * @returns {string}
 */
function buildAriaLabel(freeWindows, labelA, labelB) {
  const totalMinutes = computeTotalFreeMinutes(freeWindows);
  const windowCount = freeWindows.length;
  if (windowCount === 0) {
    return `Schedule overlap ribbon for ${labelA} and ${labelB}. No mutual free time found.`;
  }
  return `Schedule overlap ribbon for ${labelA} and ${labelB}. ${windowCount} free window${windowCount > 1 ? 's' : ''}, ${formatDuration(totalMinutes)} total.`;
}
