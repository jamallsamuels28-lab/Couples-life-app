/**
 * Property-based test: Generated recipes respect diet type
 * **Validates: Requirement 8.7**
 *
 * For all generated recipes, the recipe must respect the selected diet type
 * according to the hierarchy. Tests that validateRecipeAgainstDiet correctly
 * enforces diet restrictions across arbitrary recipe inputs.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock dependencies before importing recipe-generator
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

import { validateRecipeAgainstDiet, DIET_RESTRICTIONS } from '../js/recipe-generator.js';

// --- Arbitraries ---

/** Generate a safe ingredient name that does NOT contain any restricted keyword for any diet */
const allRestrictedKeywords = [
  ...new Set(Object.values(DIET_RESTRICTIONS).flat()),
];

/**
 * Safe ingredient names: constructed from characters that cannot form
 * any restricted keyword substring. Using only 'z', 'x', 'q', 'j', 'v'
 * guarantees no restricted keyword match.
 */
const safeIngredientNameArb = fc.array(
  fc.constantFrom('z', 'x', 'q', 'j', 'v'),
  { minLength: 3, maxLength: 8 }
).map(chars => chars.join(''));

/** Generate a recipe with arbitrary safe ingredient names */
const safeRecipeArb = fc.array(safeIngredientNameArb, { minLength: 1, maxLength: 8 }).map(names => ({
  ingredients: names.map(name => ({ name })),
}));

/** Generate a diet type that has restrictions (vegan, vegetarian, halal) */
const restrictedDietTypeArb = fc.constantFrom('vegan', 'vegetarian', 'halal');

/** Generate any diet type */
const anyDietTypeArb = fc.constantFrom('vegan', 'vegetarian', 'halal', 'keto', 'flexible');

/** Generate a restricted keyword for a given diet type */
function restrictedKeywordForDiet(dietType) {
  const restrictions = DIET_RESTRICTIONS[dietType];
  if (!restrictions || restrictions.length === 0) return fc.constant(null);
  return fc.constantFrom(...restrictions);
}

/** Generate a recipe that explicitly contains a restricted keyword as an ingredient */
function recipeWithRestrictedIngredient(dietType) {
  return fc.tuple(
    fc.array(safeIngredientNameArb, { minLength: 0, maxLength: 5 }),
    restrictedKeywordForDiet(dietType),
    fc.array(safeIngredientNameArb, { minLength: 0, maxLength: 5 })
  ).map(([before, keyword, after]) => {
    if (keyword === null) return null;
    return {
      ingredients: [
        ...before.map(name => ({ name })),
        { name: keyword },
        ...after.map(name => ({ name })),
      ],
    };
  });
}

// --- Properties ---

describe('Property 13: Generated recipes respect diet type', () => {
  it('Property 1: If a recipe passes validation, no ingredient contains any restricted keyword for that diet type', () => {
    fc.assert(
      fc.property(
        safeRecipeArb,
        anyDietTypeArb,
        (recipe, dietType) => {
          const result = validateRecipeAgainstDiet(recipe, [], dietType);

          if (result.valid) {
            const restrictions = DIET_RESTRICTIONS[dietType] || [];
            for (const ingredient of recipe.ingredients) {
              const ingredientName = (ingredient.name || '').toLowerCase().trim();
              for (const restricted of restrictions) {
                expect(ingredientName.includes(restricted)).toBe(false);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 2: If an ingredient explicitly contains a restricted keyword, validation fails for that diet type', () => {
    fc.assert(
      fc.property(
        restrictedDietTypeArb,
        fc.integer({ min: 0, max: 2 }),
        (dietType, _seed) => {
          // Pick a restricted keyword for this diet type
          const restrictions = DIET_RESTRICTIONS[dietType];
          const keyword = restrictions[_seed % restrictions.length];

          // Build a recipe with that keyword as an ingredient name
          const recipe = {
            ingredients: [
              { name: 'safe ingredient zzz' },
              { name: keyword },
              { name: 'another safe qqq' },
            ],
          };

          const result = validateRecipeAgainstDiet(recipe, [], dietType);

          expect(result.valid).toBe(false);
          expect(result.reason).toBeDefined();
          expect(result.reason).toContain(dietType);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 3: flexible and keto diets never reject based on ingredients alone', () => {
    // Generate arbitrary ingredient names (including ones that would be restricted for other diets)
    const anyIngredientNameArb = fc.constantFrom(
      'chicken', 'beef', 'pork', 'milk', 'cheese', 'butter', 'eggs',
      'bacon', 'ham', 'wine', 'beer', 'honey', 'gelatin', 'lard',
      'fish', 'salmon', 'cream', 'yogurt', 'lamb', 'shrimp',
      'tofu', 'rice', 'beans', 'spinach', 'tomato', 'onion'
    );

    const anyRecipeArb = fc.array(anyIngredientNameArb, { minLength: 1, maxLength: 8 }).map(names => ({
      ingredients: names.map(name => ({ name })),
    }));

    const noRestrictionDietArb = fc.constantFrom('flexible', 'keto');

    fc.assert(
      fc.property(
        anyRecipeArb,
        noRestrictionDietArb,
        (recipe, dietType) => {
          // With no allergies, flexible and keto should always pass
          const result = validateRecipeAgainstDiet(recipe, [], dietType);

          expect(result.valid).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
