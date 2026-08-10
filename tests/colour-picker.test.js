/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  HUE_OPTIONS,
  angularDistance,
  getAvailableHues,
  loadSelections,
  saveSelection,
  applyHueToRoot,
  initColours,
  renderColourPicker,
} from '../js/colour-picker.js';

describe('colour-picker', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty('--id-a-h');
    document.documentElement.style.removeProperty('--id-b-h');
    document.documentElement.setAttribute('data-theme', 'dark');
  });

  describe('HUE_OPTIONS', () => {
    it('contains exactly 6 hue options', () => {
      expect(HUE_OPTIONS).toHaveLength(6);
    });

    it('includes the correct hue values', () => {
      const hues = HUE_OPTIONS.map(o => o.hue);
      expect(hues).toEqual([250, 190, 145, 85, 35, 330]);
    });

    it('includes the correct names', () => {
      const names = HUE_OPTIONS.map(o => o.name);
      expect(names).toEqual(['Slate', 'Teal', 'Moss', 'Brass', 'Clay', 'Plum']);
    });
  });

  describe('angularDistance', () => {
    it('returns 0 for identical hues', () => {
      expect(angularDistance(250, 250)).toBe(0);
    });

    it('returns correct distance for non-wrapping case', () => {
      expect(angularDistance(85, 145)).toBe(60);
    });

    it('handles wrap-around correctly (350° to 10° = 20°)', () => {
      expect(angularDistance(350, 10)).toBe(20);
    });

    it('handles wrap-around from Plum 330° to Clay 35°', () => {
      // 330 to 35: |330-35|=295, 360-295=65
      expect(angularDistance(330, 35)).toBe(65);
    });

    it('returns the shorter arc (never > 180)', () => {
      expect(angularDistance(0, 200)).toBe(160);
    });

    it('is symmetric', () => {
      expect(angularDistance(35, 250)).toBe(angularDistance(250, 35));
    });
  });

  describe('getAvailableHues', () => {
    it('returns all hues enabled when otherPartnerHue is null', () => {
      const result = getAvailableHues(null);
      expect(result.every(h => h.disabled === false)).toBe(true);
    });

    it('disables hues within 60° of the other partner selection', () => {
      // Partner B selects Slate (250). What's within 60° of 250?
      // Teal 190: distance = 60 → NOT disabled (< 60 means strictly less)
      // Moss 145: distance = 105 → not disabled
      // Brass 85: distance = 165 → not disabled
      // Clay 35: distance = 215 → wraps to 145 → not disabled
      // Plum 330: distance = 80 → not disabled
      // Slate 250: distance = 0 → disabled
      const result = getAvailableHues(250);
      const disabled = result.filter(h => h.disabled).map(h => h.name);
      expect(disabled).toContain('Slate');
    });

    it('disables Clay (35°) when partner selects Brass (85°) — distance 50° < 60°', () => {
      const result = getAvailableHues(85);
      const clay = result.find(h => h.name === 'Clay');
      expect(clay.disabled).toBe(true);
    });

    it('does NOT disable Teal (190°) when partner selects Slate (250°) — distance exactly 60°', () => {
      const result = getAvailableHues(250);
      const teal = result.find(h => h.name === 'Teal');
      expect(teal.disabled).toBe(false);
    });

    it('disables Brass (85°) when partner selects Moss (145°) — distance 60° exactly means NOT disabled', () => {
      // distance = |145-85| = 60, which is NOT < 60, so NOT disabled
      const result = getAvailableHues(145);
      const brass = result.find(h => h.name === 'Brass');
      expect(brass.disabled).toBe(false);
    });
  });

  describe('loadSelections / saveSelection', () => {
    it('returns null for both when nothing stored', () => {
      const { a, b } = loadSelections();
      expect(a).toBeNull();
      expect(b).toBeNull();
    });

    it('saves and loads partner A selection', () => {
      saveSelection('a', 190);
      const { a } = loadSelections();
      expect(a).toBe(190);
    });

    it('saves and loads partner B selection', () => {
      saveSelection('b', 330);
      const { b } = loadSelections();
      expect(b).toBe(330);
    });
  });

  describe('applyHueToRoot', () => {
    it('sets --id-a-h on document root for partner A', () => {
      applyHueToRoot('a', 190);
      expect(document.documentElement.style.getPropertyValue('--id-a-h')).toBe('190');
    });

    it('sets --id-b-h on document root for partner B', () => {
      applyHueToRoot('b', 35);
      expect(document.documentElement.style.getPropertyValue('--id-b-h')).toBe('35');
    });
  });

  describe('initColours', () => {
    it('applies saved selections to CSS custom properties', () => {
      localStorage.setItem('id-a-hue', '145');
      localStorage.setItem('id-b-hue', '330');
      initColours();
      expect(document.documentElement.style.getPropertyValue('--id-a-h')).toBe('145');
      expect(document.documentElement.style.getPropertyValue('--id-b-h')).toBe('330');
    });

    it('does not set properties when nothing is stored', () => {
      initColours();
      expect(document.documentElement.style.getPropertyValue('--id-a-h')).toBe('');
      expect(document.documentElement.style.getPropertyValue('--id-b-h')).toBe('');
    });
  });

  describe('renderColourPicker', () => {
    let container;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    it('renders 6 swatch buttons', () => {
      renderColourPicker('a', container);
      const buttons = container.querySelectorAll('button');
      expect(buttons).toHaveLength(6);
    });

    it('sets role=radiogroup on the container', () => {
      renderColourPicker('a', container);
      expect(container.getAttribute('role')).toBe('radiogroup');
    });

    it('marks the selected swatch with aria-checked=true', () => {
      saveSelection('a', 250);
      renderColourPicker('a', container);
      const selected = container.querySelector('[aria-checked="true"]');
      expect(selected).not.toBeNull();
      expect(selected.dataset.hue).toBe('250');
    });

    it('disables swatches within 60° of the other partner', () => {
      saveSelection('b', 85); // Brass
      renderColourPicker('a', container);
      const clay = container.querySelector('[data-hue="35"]');
      expect(clay.disabled).toBe(true);
    });

    it('uses oklch via --swatch-h custom property, not hardcoded colours', () => {
      renderColourPicker('a', container);
      const swatch = container.querySelector('button');
      expect(swatch.style.backgroundColor).toContain('oklch');
      expect(swatch.style.getPropertyValue('--swatch-h')).toBeTruthy();
    });

    it('updates localStorage and CSS property on click', () => {
      renderColourPicker('a', container);
      const tealBtn = container.querySelector('[data-hue="190"]');
      tealBtn.click();
      expect(localStorage.getItem('id-a-hue')).toBe('190');
      expect(document.documentElement.style.getPropertyValue('--id-a-h')).toBe('190');
    });

    it('calls onChange callback when a swatch is clicked', () => {
      let receivedHue = null;
      renderColourPicker('a', container, { onChange: (h) => { receivedHue = h; } });
      const mossBtn = container.querySelector('[data-hue="145"]');
      mossBtn.click();
      expect(receivedHue).toBe(145);
    });
  });
});
