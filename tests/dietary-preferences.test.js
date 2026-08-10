/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VALID_DIET_TYPES,
  MAX_ALLERGIES,
  MAX_DISLIKES,
  validatePreferences,
  renderPreferencesForm,
} from '../js/dietary-preferences.js';

// Mock supabase-client
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null }))
        }))
      })),
      upsert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: {}, error: null }))
        }))
      }))
    }))
  }
}));

// Mock app-shell
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-1', display_name: 'Jamall' })),
  getPartner: vi.fn(() => ({ id: 'user-2', display_name: 'Rebecca' }))
}));

describe('dietary-preferences', () => {
  describe('VALID_DIET_TYPES', () => {
    it('contains exactly 5 diet types', () => {
      expect(VALID_DIET_TYPES).toHaveLength(5);
    });

    it('contains the correct diet types', () => {
      expect(VALID_DIET_TYPES).toEqual(['flexible', 'vegetarian', 'vegan', 'keto', 'halal']);
    });
  });

  describe('validatePreferences', () => {
    it('returns valid for correct preferences', () => {
      const result = validatePreferences({
        diet_type: 'vegan',
        allergies: ['peanuts', 'shellfish'],
        dislikes: ['olives'],
        calorie_target: 2000,
        protein_target: 150,
        carbs_target: 200,
        fats_target: 70
      });
      expect(result.valid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('rejects invalid diet type with message listing valid options', () => {
      const result = validatePreferences({ diet_type: 'carnivore' });
      expect(result.valid).toBe(false);
      expect(result.errors.diet_type).toContain('Invalid diet type');
      expect(result.errors.diet_type).toContain('flexible');
      expect(result.errors.diet_type).toContain('vegetarian');
      expect(result.errors.diet_type).toContain('vegan');
      expect(result.errors.diet_type).toContain('keto');
      expect(result.errors.diet_type).toContain('halal');
    });

    it('rejects allergies array exceeding 20 items', () => {
      const allergies = Array.from({ length: 21 }, (_, i) => `allergy-${i}`);
      const result = validatePreferences({ allergies });
      expect(result.valid).toBe(false);
      expect(result.errors.allergies).toContain('20');
    });

    it('accepts allergies array of exactly 20 items', () => {
      const allergies = Array.from({ length: 20 }, (_, i) => `allergy-${i}`);
      const result = validatePreferences({ allergies });
      expect(result.valid).toBe(true);
    });

    it('rejects dislikes array exceeding 30 items', () => {
      const dislikes = Array.from({ length: 31 }, (_, i) => `dislike-${i}`);
      const result = validatePreferences({ dislikes });
      expect(result.valid).toBe(false);
      expect(result.errors.dislikes).toContain('30');
    });

    it('accepts dislikes array of exactly 30 items', () => {
      const dislikes = Array.from({ length: 30 }, (_, i) => `dislike-${i}`);
      const result = validatePreferences({ dislikes });
      expect(result.valid).toBe(true);
    });

    it('rejects non-positive integer calorie_target', () => {
      const result = validatePreferences({ calorie_target: -100 });
      expect(result.valid).toBe(false);
      expect(result.errors.calorie_target).toContain('positive integer');
    });

    it('rejects zero calorie_target', () => {
      const result = validatePreferences({ calorie_target: 0 });
      expect(result.valid).toBe(false);
      expect(result.errors.calorie_target).toContain('positive integer');
    });

    it('rejects fractional protein_target', () => {
      const result = validatePreferences({ protein_target: 150.5 });
      expect(result.valid).toBe(false);
      expect(result.errors.protein_target).toContain('positive integer');
    });

    it('rejects negative fats_target', () => {
      const result = validatePreferences({ fats_target: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors.fats_target).toContain('positive integer');
    });

    it('accepts null macro targets (optional fields)', () => {
      const result = validatePreferences({
        diet_type: 'flexible',
        calorie_target: null,
        protein_target: null,
        carbs_target: null,
        fats_target: null
      });
      expect(result.valid).toBe(true);
    });

    it('accepts empty string macro targets (optional fields)', () => {
      const result = validatePreferences({
        diet_type: 'halal',
        calorie_target: '',
        protein_target: '',
        carbs_target: '',
        fats_target: ''
      });
      expect(result.valid).toBe(true);
    });

    it('accepts valid positive integer string macro targets', () => {
      const result = validatePreferences({
        calorie_target: '2500',
        protein_target: '120',
        carbs_target: '250',
        fats_target: '80'
      });
      expect(result.valid).toBe(true);
    });

    it('reports multiple errors at once', () => {
      const result = validatePreferences({
        diet_type: 'paleo',
        calorie_target: -5,
        allergies: Array.from({ length: 25 }, (_, i) => `a${i}`)
      });
      expect(result.valid).toBe(false);
      expect(Object.keys(result.errors).length).toBeGreaterThanOrEqual(3);
    });

    it('validates each diet type as valid', () => {
      for (const type of VALID_DIET_TYPES) {
        const result = validatePreferences({ diet_type: type });
        expect(result.valid).toBe(true);
      }
    });
  });

  describe('renderPreferencesForm', () => {
    let container;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    it('renders a form with diet type select', () => {
      renderPreferencesForm(container);
      const select = container.querySelector('#diet-type-select');
      expect(select).not.toBeNull();
      expect(select.options.length).toBe(5);
    });

    it('renders default diet type as flexible', () => {
      renderPreferencesForm(container);
      const select = container.querySelector('#diet-type-select');
      expect(select.value).toBe('flexible');
    });

    it('renders with existing preferences pre-filled', () => {
      renderPreferencesForm(container, {
        diet_type: 'keto',
        allergies: ['peanuts'],
        dislikes: ['mushrooms'],
        calorie_target: 2000,
        protein_target: null,
        carbs_target: null,
        fats_target: null
      });
      const select = container.querySelector('#diet-type-select');
      expect(select.value).toBe('keto');
      const calorieInput = container.querySelector('#calorie-target');
      expect(calorieInput.value).toBe('2000');
    });

    it('renders allergy and dislike input fields', () => {
      renderPreferencesForm(container);
      expect(container.querySelector('#allergy-input')).not.toBeNull();
      expect(container.querySelector('#dislike-input')).not.toBeNull();
    });

    it('renders macro target input fields', () => {
      renderPreferencesForm(container);
      expect(container.querySelector('#calorie-target')).not.toBeNull();
      expect(container.querySelector('#protein-target')).not.toBeNull();
      expect(container.querySelector('#carbs-target')).not.toBeNull();
      expect(container.querySelector('#fats-target')).not.toBeNull();
    });

    it('renders a save button', () => {
      renderPreferencesForm(container);
      const btn = container.querySelector('#save-prefs-btn');
      expect(btn).not.toBeNull();
      expect(btn.textContent).toBe('Save Preferences');
    });

    it('renders section with aria-label for accessibility', () => {
      renderPreferencesForm(container);
      const section = container.querySelector('[aria-label="Dietary Preferences"]');
      expect(section).not.toBeNull();
    });

    it('renders existing allergies as tags', () => {
      renderPreferencesForm(container, {
        diet_type: 'flexible',
        allergies: ['peanuts', 'shellfish'],
        dislikes: [],
        calorie_target: null,
        protein_target: null,
        carbs_target: null,
        fats_target: null
      });
      const tags = container.querySelectorAll('#allergies-tags .tag-badge');
      expect(tags.length).toBe(2);
    });

    it('adds an allergy tag via button click', () => {
      renderPreferencesForm(container);
      const input = container.querySelector('#allergy-input');
      const btn = container.querySelector('#add-allergy-btn');
      input.value = 'gluten';
      btn.click();
      const tags = container.querySelectorAll('#allergies-tags .tag-badge');
      expect(tags.length).toBe(1);
      expect(input.value).toBe('');
    });

    it('adds a dislike tag via Enter key', () => {
      renderPreferencesForm(container);
      const input = container.querySelector('#dislike-input');
      input.value = 'cilantro';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      const tags = container.querySelectorAll('#dislikes-tags .tag-badge');
      expect(tags.length).toBe(1);
    });

    it('removes a tag when remove button is clicked', () => {
      renderPreferencesForm(container, {
        diet_type: 'flexible',
        allergies: ['peanuts', 'shellfish'],
        dislikes: [],
        calorie_target: null,
        protein_target: null,
        carbs_target: null,
        fats_target: null
      });
      const removeBtns = container.querySelectorAll('#allergies-tags .tag-remove-btn');
      expect(removeBtns.length).toBe(2);
      removeBtns[0].click();
      const tags = container.querySelectorAll('#allergies-tags .tag-badge');
      expect(tags.length).toBe(1);
    });

    it('does not add duplicate allergy tags', () => {
      renderPreferencesForm(container);
      const input = container.querySelector('#allergy-input');
      const btn = container.querySelector('#add-allergy-btn');
      input.value = 'peanuts';
      btn.click();
      input.value = 'peanuts';
      btn.click();
      const tags = container.querySelectorAll('#allergies-tags .tag-badge');
      expect(tags.length).toBe(1);
    });

    it('does not add empty allergy tags', () => {
      renderPreferencesForm(container);
      const input = container.querySelector('#allergy-input');
      const btn = container.querySelector('#add-allergy-btn');
      input.value = '   ';
      btn.click();
      const tags = container.querySelectorAll('#allergies-tags .tag-badge');
      expect(tags.length).toBe(0);
    });

    it('shows error when exceeding max allergies', () => {
      const allergies = Array.from({ length: 20 }, (_, i) => `allergy-${i}`);
      renderPreferencesForm(container, {
        diet_type: 'flexible',
        allergies,
        dislikes: [],
        calorie_target: null,
        protein_target: null,
        carbs_target: null,
        fats_target: null
      });
      const input = container.querySelector('#allergy-input');
      const btn = container.querySelector('#add-allergy-btn');
      input.value = 'one-more';
      btn.click();
      const errorEl = container.querySelector('#allergies-error');
      expect(errorEl.textContent).toContain('20');
    });
  });
});
