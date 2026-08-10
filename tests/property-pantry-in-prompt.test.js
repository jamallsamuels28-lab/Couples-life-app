/**
 * Property-based test: Pantry items included in generation prompt
 * **Validates: Requirements 8.4, 9.6**
 *
 * When pantry items are available, the prompt must include them as preferred ingredients.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock dependencies before importing the module under test
vi.mock('../js/supabase-client.js', () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', name: 'Test' })),
  getPartner: vi.fn(() => ({ id: 'user-456', name: 'Partner' })),
}));
vi.mock('../js/dietary-preferences.js', () => ({
  getBothPreferences: vi.fn(() => Promise.resolve({ user: null, partner: null })),
}));
vi.mock('../js/pantry-module.js', () => ({
  fetchValidPantryItems: vi.fn(() => Promise.resolve({ success: true, data: [] })),
}));

import { buildRecipePrompt } from '../js/recipe-generator.js';

// --- Arbitraries ---

/** Generate a pantry item with a random name and category */
const pantryItemArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 30 }).filter(s => s.trim().length > 0),
  category: fc.constantFrom('produce', 'dairy', 'meat', 'grains', 'spices', 'condiments'),
  quantity: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
});

/** Generate a non-empty array of pantry items */
const nonEmptyPantryArb = fc.array(pantryItemArb, { minLength: 1, maxLength: 20 });

/** Generate preferences object */
const preferencesArb = fc.record({
  allergies: fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 0, maxLength: 5 }),
  dislikes: fc.array(fc.string({ minLength: 1, maxLength: 15 }), { minLength: 0, maxLength: 5 }),
  dietType: fc.constantFrom('vegan', 'vegetarian', 'halal', 'keto', 'flexible'),
});

describe('Property 14: Pantry items included in generation prompt', () => {
  it('every pantry item name appears in the prompt when pantryItems is non-empty', () => {
    fc.assert(
      fc.property(
        preferencesArb,
        nonEmptyPantryArb,
        (preferences, pantryItems) => {
          const prompt = buildRecipePrompt(preferences, pantryItems);

          // Every pantry item's name must appear in the prompt
          for (const item of pantryItems) {
            expect(prompt).toContain(item.name);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('prompt does NOT contain "Preferred ingredients from pantry" when pantryItems is empty', () => {
    fc.assert(
      fc.property(
        preferencesArb,
        (preferences) => {
          const prompt = buildRecipePrompt(preferences, []);

          expect(prompt).not.toContain('Preferred ingredients from pantry');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('prompt always contains "Generate a recipe" regardless of pantry state', () => {
    fc.assert(
      fc.property(
        preferencesArb,
        fc.oneof(nonEmptyPantryArb, fc.constant([])),
        (preferences, pantryItems) => {
          const prompt = buildRecipePrompt(preferences, pantryItems);

          expect(prompt).toContain('Generate a recipe');
        }
      ),
      { numRuns: 100 }
    );
  });
});
