// ============================================================
// Exercise library — browse, filter, and see how a lift is done
// ============================================================
//
// The exercises table held 27 rows carrying only what the progression maths
// needs. That is a lookup list, not a library: it answers "which lift am I
// logging" and nothing about "what should I do for shoulders" or "how is this
// meant to look".
//
// The taxonomy — pick a body part, then narrow by equipment — follows ExRx,
// because that is the arrangement people already know. Only the structure was
// taken. The content comes from wger's openly licensed database, and the
// licence obliges attribution wherever a description or image is shown, which
// is why renderAttribution() is not optional decoration.
//
// This module is presentation over reference data. Nothing here feeds a
// calculation, so a missing description or image cannot move a training number.
// ============================================================

import { escapeHtml, chevronSvg } from './ui-helpers.js';
import { cuesFor } from './exercise-cues.js';

const ALL = '__all__';

/** Sort order for the body-part filter — compounds first, then the small stuff. */
const CATEGORY_ORDER = [
  'Legs', 'Back', 'Chest', 'Shoulders', 'Arms', 'Abs', 'Calves', 'Cardio',
];

/**
 * The distinct values available for filtering, taken from the data rather
 * than hardcoded — the library is imported, so a fixed list would drift the
 * moment the seed is regenerated.
 */
export function facetsFor(exercises) {
  const categories = new Set();
  const equipment = new Set();
  const muscles = new Set();

  for (const exercise of exercises || []) {
    if (exercise.category) categories.add(exercise.category);
    for (const item of exercise.equipment || []) equipment.add(item);
    for (const muscle of exercise.primary_muscles || []) muscles.add(muscle);
  }

  const byOrder = (a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  };

  return {
    categories: [...categories].sort(byOrder),
    equipment: [...equipment].sort((a, b) => a.localeCompare(b)),
    muscles: [...muscles].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Filters the library. Pure, so the matching rules can be tested without a
 * database or a DOM.
 *
 * @param {Array} exercises
 * @param {{category?: string, equipment?: string, muscle?: string, search?: string}} filters
 */
export function filterExercises(exercises, filters = {}) {
  const term = String(filters.search || '').trim().toLowerCase();

  return (exercises || []).filter((exercise) => {
    if (filters.category && filters.category !== ALL
      && exercise.category !== filters.category) return false;

    if (filters.equipment && filters.equipment !== ALL
      && !(exercise.equipment || []).includes(filters.equipment)) return false;

    if (filters.muscle && filters.muscle !== ALL
      && !(exercise.primary_muscles || []).includes(filters.muscle)) return false;

    if (term) {
      // Name first, then muscles — searching "hamstring" should find the lifts
      // that train it, not only the ones with the word in their title.
      const haystack = [
        exercise.name,
        ...(exercise.primary_muscles || []),
        ...(exercise.secondary_muscles || []),
      ].join(' ').toLowerCase();
      if (!haystack.includes(term)) return false;
    }

    return true;
  });
}

/**
 * Where to send someone who wants to see the movement.
 *
 * wger carries a video for only 45 of the 722 exercises, so the fallback is
 * not an edge case — it is the common path. A YouTube *search* rather than a
 * specific video id: a search always resolves, where a hardcoded id rots when
 * the upload is deleted, and inventing ids is exactly the guessing this
 * codebase exists to avoid.
 */
export function videoLinkFor(exercise) {
  if (exercise?.video_url) {
    return { href: exercise.video_url, label: 'Watch demonstration', hosted: true };
  }
  const query = encodeURIComponent(`${exercise?.name || ''} exercise form`.trim());
  return {
    href: `https://www.youtube.com/results?search_query=${query}`,
    label: 'Search for a form video',
    hosted: false,
  };
}

/**
 * Attribution for imported content.
 *
 * CC-BY-SA requires crediting the author and naming the licence wherever the
 * text or image appears. Skipped for the original hand-written rows, which
 * have no third-party licence to honour.
 */
export function renderAttribution(exercise) {
  if (exercise.source !== 'wger' || !exercise.license) return '';

  const author = exercise.license_author
    ? `${escapeHtml(exercise.license_author)}, ` : '';
  return `
    <p class="exercise-attribution">
      ${author}<a href="https://wger.de" target="_blank" rel="noopener noreferrer">wger</a>
      · ${escapeHtml(exercise.license)}
    </p>
  `;
}

function renderCard(exercise, index) {
  const equipment = (exercise.equipment || []).join(', ') || 'No equipment listed';
  const primary = (exercise.primary_muscles || []).join(', ');

  return `
    <details class="exercise-card" data-index="${index}">
      <summary>
        <span class="exercise-card-head">
          <span class="exercise-name">${escapeHtml(exercise.name)}</span>
          <span class="exercise-meta">${escapeHtml(primary || exercise.category || '')}</span>
        </span>
        ${chevronSvg()}
      </summary>
      <div class="exercise-body">
        <dl class="exercise-facts">
          <div><dt>Equipment</dt><dd>${escapeHtml(equipment)}</dd></div>
          ${exercise.secondary_muscles?.length
            ? `<div><dt>Also works</dt><dd>${escapeHtml(exercise.secondary_muscles.join(', '))}</dd></div>`
            : ''}
          ${exercise.unilateral ? `<div><dt>Note</dt><dd>Trained one side at a time</dd></div>` : ''}
        </dl>
        <div class="exercise-detail-mount"></div>
      </div>
    </details>
  `;
}

/**
 * The heavy part of a card — image and description — is built only when the
 * card is opened. Rendering 722 images up front would fetch every one of them
 * on a phone connection to show a list the user scrolls straight past.
 */
/**
 * Our own form cues, kept visually distinct from the imported description.
 *
 * The separation is not decorative: the description below is CC-BY-SA text
 * from wger and this is not, so running them together would make it
 * impossible to tell which text carries which obligations.
 */
function renderCues(exercise) {
  const cues = cuesFor(exercise.name);
  if (!cues) return '';

  const section = (heading, items, className = '') => `
    <div class="cue-group ${className}">
      <h5 class="cue-heading">${heading}</h5>
      <ul class="cue-list">
        ${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    </div>
  `;

  return `
    <div class="exercise-cues">
      <h4 class="cue-title">How to do it</h4>
      ${section('Set up', cues.setup)}
      ${section('The lift', cues.execution)}
      ${section('Common faults', cues.faults, 'cue-group--faults')}
    </div>
  `;
}

function renderCardDetail(exercise) {
  const video = videoLinkFor(exercise);

  return `
    ${renderCues(exercise)}
    ${exercise.image_url
      ? `<img class="exercise-image" src="${escapeHtml(exercise.image_url)}"
           alt="${escapeHtml(exercise.name)}" loading="lazy" />`
      : ''}
    ${exercise.description
      ? `<p class="exercise-description">${escapeHtml(exercise.description).replace(/\n/g, '<br>')}</p>`
      : `<p class="field-hint">No description for this one.</p>`}
    <p class="exercise-actions">
      <a class="btn btn-secondary btn-sm" href="${escapeHtml(video.href)}"
         target="_blank" rel="noopener noreferrer">${escapeHtml(video.label)}</a>
    </p>
    ${renderAttribution(exercise)}
  `;
}

export function renderExerciseLibrary(mount, exercises) {
  if (!mount) return;

  if (!exercises || exercises.length === 0) {
    mount.innerHTML = `<div class="empty-state">
      No exercises yet. Run the exercise library migrations to load them.
    </div>`;
    return;
  }

  const facets = facetsFor(exercises);
  const option = (value, label = value) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;

  mount.innerHTML = `
    <div class="exercise-filters">
      <div class="input-group">
        <label class="input-label" for="exercise-search">Search</label>
        <input type="search" id="exercise-search" class="input" placeholder="Bench press, hamstrings…" autocomplete="off" />
      </div>
      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="exercise-category">Body part</label>
          <select id="exercise-category" class="input">
            ${option(ALL, 'All')}${facets.categories.map(c => option(c)).join('')}
          </select>
        </div>
        <div class="input-group">
          <label class="input-label" for="exercise-equipment">Equipment</label>
          <select id="exercise-equipment" class="input">
            ${option(ALL, 'Any')}${facets.equipment.map(e => option(e)).join('')}
          </select>
        </div>
      </div>
    </div>
    <p class="exercise-count field-hint" aria-live="polite"></p>
    <div class="exercise-list" id="exercise-list"></div>
  `;

  const search = mount.querySelector('#exercise-search');
  const category = mount.querySelector('#exercise-category');
  const equipment = mount.querySelector('#exercise-equipment');
  const list = mount.querySelector('#exercise-list');
  const count = mount.querySelector('.exercise-count');

  // Capped, because painting 722 <details> elements on a phone is a visible
  // stall for a list nobody scrolls to the end of. Narrowing the filters is
  // the intended way to reach the rest, and the count says so.
  const PAGE = 60;
  let shown = [];

  function apply() {
    const filters = {
      search: search.value,
      category: category.value,
      equipment: equipment.value,
    };
    shown = filterExercises(exercises, filters);

    const visible = shown.slice(0, PAGE);
    list.innerHTML = visible.map(renderCard).join('');

    count.textContent = shown.length > visible.length
      ? `Showing ${visible.length} of ${shown.length} — narrow the filters to see the rest.`
      : `${shown.length} exercise${shown.length === 1 ? '' : 's'}`;

    list.querySelectorAll('.exercise-card').forEach((card) => {
      card.addEventListener('toggle', () => {
        if (!card.open) return;
        const target = card.querySelector('.exercise-detail-mount');
        if (!target || target.dataset.loaded) return;
        target.innerHTML = renderCardDetail(visible[Number(card.dataset.index)]);
        target.dataset.loaded = 'true';
      }, { once: false });
    });
  }

  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(apply, 150);
  });
  category.addEventListener('change', apply);
  equipment.addEventListener('change', apply);

  apply();
}
