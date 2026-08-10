/**
 * Colour Picker Module
 * Identity colour selection for both partners with 60° gap enforcement.
 *
 * Six hue options per partner (Slate, Teal, Moss, Brass, Clay, Plum).
 * Uses oklch(var(--id-l) var(--id-c) var(--id-x-h)) — never hardcodes colours.
 *
 * Requirements: 13.2, 13.3
 */

// ---------- Hue definitions ----------

export const HUE_OPTIONS = [
  { name: 'Slate', hue: 250 },
  { name: 'Teal', hue: 190 },
  { name: 'Moss', hue: 145 },
  { name: 'Brass', hue: 85 },
  { name: 'Clay', hue: 35 },
  { name: 'Plum', hue: 330 },
];

// ---------- Storage keys ----------

const STORAGE_KEY_A = 'id-a-hue';
const STORAGE_KEY_B = 'id-b-hue';

// ---------- Angular distance ----------

/**
 * Calculate the angular distance between two hues on the 360° colour wheel.
 * Handles wrap-around (e.g. distance between 350° and 10° is 20°, not 340°).
 * @param {number} h1 - First hue in degrees (0–360)
 * @param {number} h2 - Second hue in degrees (0–360)
 * @returns {number} The shortest angular distance (0–180)
 */
export function angularDistance(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// ---------- Gap enforcement ----------

/**
 * Given one partner's selected hue, returns the list of hue options with
 * a `disabled` flag for any hue within 60° of that selection.
 * @param {number|null} otherPartnerHue - The other partner's selected hue (or null if none)
 * @returns {Array<{name: string, hue: number, disabled: boolean}>}
 */
export function getAvailableHues(otherPartnerHue) {
  return HUE_OPTIONS.map(option => ({
    ...option,
    disabled: otherPartnerHue != null && angularDistance(option.hue, otherPartnerHue) < 60,
  }));
}

// ---------- localStorage persistence ----------

/**
 * Load both partners' saved hue selections from localStorage.
 * @returns {{ a: number|null, b: number|null }}
 */
export function loadSelections() {
  const rawA = localStorage.getItem(STORAGE_KEY_A);
  const rawB = localStorage.getItem(STORAGE_KEY_B);
  return {
    a: rawA != null ? Number(rawA) : null,
    b: rawB != null ? Number(rawB) : null,
  };
}

/**
 * Save a partner's hue selection to localStorage.
 * @param {'a'|'b'} partner
 * @param {number} hue
 */
export function saveSelection(partner, hue) {
  const key = partner === 'a' ? STORAGE_KEY_A : STORAGE_KEY_B;
  localStorage.setItem(key, String(hue));
}

// ---------- CSS custom property updates ----------

/**
 * Apply a partner's hue selection to the :root CSS custom property.
 * Updates --id-a-h or --id-b-h so oklch-based colours recompute automatically.
 * @param {'a'|'b'} partner
 * @param {number} hue
 */
export function applyHueToRoot(partner, hue) {
  const prop = partner === 'a' ? '--id-a-h' : '--id-b-h';
  document.documentElement.style.setProperty(prop, String(hue));
}

// ---------- Initialisation ----------

/**
 * Load saved selections from localStorage and apply them to CSS custom properties.
 * Call this on app boot to restore identity colours.
 */
export function initColours() {
  const { a, b } = loadSelections();
  if (a != null) applyHueToRoot('a', a);
  if (b != null) applyHueToRoot('b', b);
}

// ---------- UI component ----------

/**
 * Render a colour picker for a given partner.
 * Shows six swatches coloured via oklch using the design-token lightness/chroma.
 * Disabled swatches (within 60° of the other partner) are visually muted and non-interactive.
 *
 * @param {'a'|'b'} partner - Which partner this picker is for
 * @param {HTMLElement} container - DOM element to render into
 * @param {object} [options]
 * @param {function} [options.onChange] - Callback fired with the new hue on selection
 */
export function renderColourPicker(partner, container, options = {}) {
  const { onChange } = options;
  const selections = loadSelections();
  const currentHue = selections[partner];
  const otherHue = selections[partner === 'a' ? 'b' : 'a'];
  const hues = getAvailableHues(otherHue);

  // Clear existing content
  container.innerHTML = '';
  container.setAttribute('role', 'radiogroup');
  container.setAttribute('aria-label', `Colour selection for Partner ${partner.toUpperCase()}`);

  const list = document.createElement('div');
  list.className = 'colour-picker__swatches';

  hues.forEach(({ name, hue, disabled }) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'colour-picker__swatch';
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-checked', String(hue === currentHue));
    swatch.setAttribute('aria-label', `${name} (${hue}°)`);
    swatch.dataset.hue = hue;

    // Use oklch with CSS custom properties for the swatch colour — never hardcode
    swatch.style.setProperty('--swatch-h', String(hue));
    swatch.style.backgroundColor = 'oklch(var(--id-l) var(--id-c) var(--swatch-h))';

    if (disabled) {
      swatch.disabled = true;
      swatch.setAttribute('aria-disabled', 'true');
      swatch.title = `${name} is too close to your partner's colour`;
    }

    if (hue === currentHue) {
      swatch.classList.add('colour-picker__swatch--selected');
    }

    swatch.addEventListener('click', () => {
      if (disabled) return;

      // Persist and apply
      saveSelection(partner, hue);
      applyHueToRoot(partner, hue);

      // Re-render to update visual state (selected indicator + partner constraints)
      renderColourPicker(partner, container, options);

      if (onChange) onChange(hue);
    });

    list.appendChild(swatch);
  });

  container.appendChild(list);
}
