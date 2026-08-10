/**
 * Property-based test: Generated recipes contain no allergens
 * **Validates: Requirements 8.6**
 *
 * For any generated recipe and any combined allergy list from both partners,
 * no ingredient in the recipe may match any item in the allergy exclusion list.
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

import { validateRecipeAgainstDiet } from '../js/recipe-generator.js';

// --- Arbitraries ---

/** Generate a simple ingredient name (alphabetic, 2-15 chars) */
const ingredientNameArb = fc.string({ minLength: 2, maxLength: 15, unit: fc.constantFrom(
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'
) });

/** Generate a realistic ingredient name from a curated list */
const realisticIngredientArb = fc.constantFrom(
  'tomato', 'onion', 'garlic', 'olive oil', 'salt', 'pepper', 'basil',
  'carrot', 'potato', 'rice', 'pasta', 'bread', 'flour', 'sugar',
  'lemon', 'lime', 'avocado', 'spinach', 'kale', 'broccoli',
  'mushroom', 'zucchini', 'bell pepper', 'corn', 'beans', 'lentils',
  'tofu', 'tempeh', 'coconut milk', 'soy sauce', 'ginger', 'cumin'
);

/** Generate an allergen string (2-10 chars, alphabetic) */
const allergenArb = fc.string({ minLength: 2, maxLength: 10, unit: fc.constantFrom(
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'
) });

/** Generate a realistic allergen from common allergens */
const realisticAllergenArb = fc.constantFrom(
  'peanut', 'tree nut', 'milk', 'egg', 'wheat', 'soy', 'fish',
  'shellfish', 'sesame', 'gluten', 'dairy', 'almond', 'cashew',
  'walnut', 'shrimp', 'crab', 'lobster', 'mustard', 'celery'
);

/** Generate a single ingredient object */
const ingredientArb = fc.oneof(ingredientNameArb, realisticIngredientArb).map(name => ({
  name,
  amount: '1',
  unit: 'cup',
}));

/** Generate a recipe with 1-10 ingredients */
const recipeArb = fc.array(ingredientArb, { minLength: 1, maxLength: 10 }).map(ingredients => ({
  ingredients,
  title: 'Test Recipe',
  instructions: ['Step 1'],
}));

/** Generate an allergen list with 0-8 items */
const allergenListArb = fc.array(
  fc.oneof(allergenArb, realisticAllergenArb),
  { minLength: 1, maxLength: 8 }
).map(list => [...new Set(list.map(a => a.toLowerCase().trim()))].filter(Boolean));

describe('Property 12: Generated recipes contain no allergens', () => {
  it('if a recipe passes validation, no ingredient name contains any allergen string', () => {
    fc.assert(
      fc.property(
        recipeArb,
        allergenListArb,
        (recipe, allergies) => {
          const result = validateRecipeAgainstDiet(recipe, allergies, 'flexible');

          if (result.valid) {
            // Verify the invariant: no ingredient contains any allergen
            for (const ingredient of recipe.ingredients) {
              const name = ingredient.name.toLowerCase().trim();
              for (const allergen of allergies) {
                expect(name.includes(allergen)).toBe(false);
                expect(allergen.includes(name)).toBe(false);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if a recipe has an ingredient that contains an allergen, validation returns { valid: false }', () => {
    fc.assert(
      fc.property(
        recipeArb,
        realisticAllergenArb,
        (baseRecipe, allergen) => {
          // Inject an ingredient that contains the allergen to guarantee a match
          const contaminatedIngredient = { name: `fresh ${allergen} sauce`, amount: '2', unit: 'tbsp' };
          const recipe = {
            ...baseRecipe,
            ingredients: [...baseRecipe.ingredients, contaminatedIngredient],
          };
          const allergies = [allergen.toLowerCase()];

          const result = validateRecipeAgainstDiet(recipe, allergies, 'flexible');

          expect(result.valid).toBe(false);
          expect(result.reason).toBeDefined();
          expect(result.reason).toContain('allergen');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('if allergies list is empty, all recipes pass the allergen check (may still fail diet check)', () => {
    fc.assert(
      fc.property(
        recipeArb,
        (recipe) => {
          // With empty allergies and flexible diet, validation should always pass
          const result = validateRecipeAgainstDiet(recipe, [], 'flexible');
          expect(result.valid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
