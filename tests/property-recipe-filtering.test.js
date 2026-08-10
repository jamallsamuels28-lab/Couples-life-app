/**
 * Property-based test: Recipe book filtering correctness
 * **Validates: Requirements 9.2**
 *
 * The recipe book should support filtering by user-assigned tags, meal type,
 * and favorite status, returning results sorted by most recently saved first.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock supabase-client and app-shell before importing recipe-book module
vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', name: 'Test' })),
  getPartner: vi.fn(() => ({ id: 'user-456', name: 'Partner' })),
}));

import { filterRecipes, sortRecipesByDate } from '../js/recipe-book.js';

// --- Arbitraries ---

/** Generate a random tag string (lowercase word-like, 2–12 chars) */
const tagArb = fc.stringMatching(/^[a-z]{2,12}$/);

/** Generate an array of 0–5 tags for a recipe */
const tagsArrayArb = fc.array(tagArb, { minLength: 0, maxLength: 5 });

/** Generate a unique recipe ID */
const recipeIdArb = fc.uuid();

/** Generate a created_at ISO timestamp within a reasonable range (2023–2026) */
const createdAtArb = fc.integer({
  min: new Date('2023-01-01T00:00:00Z').getTime(),
  max: new Date('2026-12-31T23:59:59Z').getTime(),
}).map(ts => new Date(ts).toISOString());

/** Generate a single recipe object */
const recipeArb = fc.record({
  id: recipeIdArb,
  title: fc.string({ minLength: 1, maxLength: 50 }),
  tags: tagsArrayArb,
  created_at: createdAtArb,
});

/** Generate an array of 0–30 recipes */
const recipesArrayArb = fc.array(recipeArb, { minLength: 0, maxLength: 30 });

/** Generate a non-empty subset of tags from a given pool */
function subsetOfTags(pool) {
  if (pool.length === 0) return fc.constant([]);
  return fc.shuffledSubarray(pool, { minLength: 1, maxLength: Math.min(pool.length, 3) });
}

describe('Property 15: Recipe book filtering correctness', () => {
  it('tags filter: every recipe in result has at least one matching tag from the filter set', () => {
    fc.assert(
      fc.property(
        recipesArrayArb,
        fc.array(tagArb, { minLength: 1, maxLength: 3 }),
        (recipes, filterTags) => {
          const filters = { tags: filterTags };
          const result = filterRecipes(recipes, filters, new Set());

          // Every recipe in result must have at least one tag from filterTags
          for (const recipe of result) {
            const hasMatch = Array.isArray(recipe.tags) &&
              filterTags.some(tag => recipe.tags.includes(tag));
            expect(hasMatch).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('meal type filter: every recipe in result includes that meal type in its tags', () => {
    fc.assert(
      fc.property(
        recipesArrayArb,
        fc.constantFrom('breakfast', 'lunch', 'dinner', 'snack'),
        (recipes, mealType) => {
          const filters = { meal_type: mealType };
          const result = filterRecipes(recipes, filters, new Set());

          // Every recipe in result must include mealType in its tags
          for (const recipe of result) {
            expect(Array.isArray(recipe.tags) && recipe.tags.includes(mealType)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('favorites filter: every recipe in result has its ID in the favoritesSet', () => {
    fc.assert(
      fc.property(
        recipesArrayArb,
        (recipes) => {
          // Build a random favorites set from a subset of recipe IDs
          const allIds = recipes.map(r => r.id);
          const favIds = allIds.filter(() => Math.random() > 0.5);
          const favoritesSet = new Set(favIds);

          const filters = { favoritesOnly: true };
          const result = filterRecipes(recipes, filters, favoritesSet);

          // Every recipe in result must be in the favorites set
          for (const recipe of result) {
            expect(favoritesSet.has(recipe.id)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('sort order: after sortRecipesByDate, recipes are in descending created_at order', () => {
    fc.assert(
      fc.property(
        recipesArrayArb,
        (recipes) => {
          const sorted = sortRecipesByDate(recipes);

          // Each consecutive pair should be in descending date order
          for (let i = 0; i < sorted.length - 1; i++) {
            const dateA = new Date(sorted[i].created_at).getTime();
            const dateB = new Date(sorted[i + 1].created_at).getTime();
            expect(dateA).toBeGreaterThanOrEqual(dateB);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('no data loss: the union of filtered-in and filtered-out recipes equals the original set', () => {
    fc.assert(
      fc.property(
        recipesArrayArb,
        fc.array(tagArb, { minLength: 1, maxLength: 3 }),
        (recipes, filterTags) => {
          const filters = { tags: filterTags };
          const favoritesSet = new Set();

          const filteredIn = filterRecipes(recipes, filters, favoritesSet);
          const filteredInIds = new Set(filteredIn.map(r => r.id));

          // Filtered-out are those not in filteredIn
          const filteredOut = recipes.filter(r => !filteredInIds.has(r.id));

          // Union should equal original set size
          expect(filteredIn.length + filteredOut.length).toBe(recipes.length);

          // Every original recipe should be in exactly one set
          const originalIds = new Set(recipes.map(r => r.id));
          const unionIds = new Set([...filteredIn.map(r => r.id), ...filteredOut.map(r => r.id)]);
          expect(unionIds.size).toBe(originalIds.size);

          for (const id of originalIds) {
            expect(unionIds.has(id)).toBe(true);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
