/**
 * Unit tests for the Recipe Book module — filter logic, favorites, and sorting.
 *
 * Tests cover:
 * - filterRecipes: tag filtering, meal type filtering, favorites-only filtering, combined filters
 * - sortRecipesByDate: descending order by created_at
 * - extractAllTags: unique tag extraction from recipe list
 * - isFavorite / toggleFavorite: per-user localStorage-based favorites
 *
 * Requirements: 9.1, 9.2, 9.3
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the supabase client. `from` is a spy so the favourites tests can swap
// in a table stub; the default keeps the original behaviour for the rest.
const supabaseMock = { from: vi.fn() };
const defaultFrom = () => ({
  insert: () => ({ select: () => ({ single: () => ({ data: null, error: null }) }) }),
  select: () => ({ order: () => ({ overlaps: () => ({ data: [], error: null }) }) }),
});
supabaseMock.from.mockImplementation(defaultFrom);

vi.mock('../js/supabase-client.js', () => ({
  supabase: supabaseMock,
}));

// Mock app-shell getCurrentUser
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: () => ({ id: 'user-jamall', display_name: 'Jamall' }),
  getPartner: () => ({ id: 'user-rebecca', display_name: 'Rebecca' }),
}));

// Imported dynamically, not statically: a static import is hoisted above the
// `supabaseMock` declaration above, so the module under test would load before
// the mock object exists. The rest of the suites here use the same pattern.
const {
  filterRecipes,
  sortRecipesByDate,
  extractAllTags,
  isFavorite,
  toggleFavorite,
  fetchFavorites,
  getFavorites,
  clearFavoritesCache,
} = await import('../js/recipe-book.js');

// --- Test Data ---

function makeRecipe(overrides = {}) {
  return {
    id: overrides.id || `recipe-${Math.random().toString(36).slice(2)}`,
    created_by: overrides.created_by || 'user-jamall',
    title: overrides.title || 'Test Recipe',
    description: overrides.description || null,
    ingredients: overrides.ingredients || [],
    steps: overrides.steps || [],
    prep_time_min: overrides.prep_time_min || 30,
    cook_time_min: overrides.cook_time_min || 20,
    servings: overrides.servings || 2,
    calories: overrides.calories || 500,
    protein_g: overrides.protein_g || 30,
    carbs_g: overrides.carbs_g || 60,
    fats_g: overrides.fats_g || 15,
    tags: overrides.tags || [],
    ai_generated: overrides.ai_generated || false,
    is_favorite: overrides.is_favorite || false,
    created_at: overrides.created_at || new Date().toISOString(),
  };
}

const RECIPES = [
  makeRecipe({ id: 'r1', title: 'Chicken Stir Fry', tags: ['dinner', 'high-protein', 'quick'], created_at: '2024-01-15T10:00:00Z' }),
  makeRecipe({ id: 'r2', title: 'Morning Oats', tags: ['breakfast', 'vegetarian'], created_at: '2024-01-14T09:00:00Z' }),
  makeRecipe({ id: 'r3', title: 'Greek Salad', tags: ['lunch', 'vegetarian', 'quick'], created_at: '2024-01-16T12:00:00Z' }),
  makeRecipe({ id: 'r4', title: 'Protein Shake', tags: ['snack', 'high-protein'], created_at: '2024-01-13T08:00:00Z' }),
  makeRecipe({ id: 'r5', title: 'Pasta Bolognese', tags: ['dinner'], created_at: '2024-01-12T18:00:00Z' }),
];

// --- Tests ---

describe('Recipe Book — filterRecipes()', () => {
  // =========================================================================
  // Tag filtering (Req 9.2)
  // =========================================================================
  describe('tag filtering', () => {
    it('returns all recipes when no filters applied', () => {
      const result = filterRecipes(RECIPES, {});
      expect(result).toHaveLength(5);
    });

    it('filters by a single tag', () => {
      const result = filterRecipes(RECIPES, { tags: ['vegetarian'] });
      expect(result).toHaveLength(2);
      expect(result.map(r => r.id)).toContain('r2');
      expect(result.map(r => r.id)).toContain('r3');
    });

    it('filters by multiple tags (OR logic — at least one match)', () => {
      const result = filterRecipes(RECIPES, { tags: ['high-protein', 'vegetarian'] });
      expect(result).toHaveLength(4);
      expect(result.map(r => r.id)).toContain('r1'); // high-protein
      expect(result.map(r => r.id)).toContain('r2'); // vegetarian
      expect(result.map(r => r.id)).toContain('r3'); // vegetarian
      expect(result.map(r => r.id)).toContain('r4'); // high-protein
    });

    it('returns empty when tag matches nothing', () => {
      const result = filterRecipes(RECIPES, { tags: ['nonexistent-tag'] });
      expect(result).toHaveLength(0);
    });

    it('handles recipes with no tags', () => {
      const recipesWithEmpty = [
        ...RECIPES,
        makeRecipe({ id: 'r6', title: 'No Tags', tags: [] }),
      ];
      const result = filterRecipes(recipesWithEmpty, { tags: ['dinner'] });
      expect(result.map(r => r.id)).not.toContain('r6');
    });

    it('handles recipes with null tags array', () => {
      const recipesWithNull = [
        ...RECIPES,
        makeRecipe({ id: 'r7', title: 'Null Tags', tags: null }),
      ];
      const result = filterRecipes(recipesWithNull, { tags: ['dinner'] });
      expect(result.map(r => r.id)).not.toContain('r7');
    });
  });

  // =========================================================================
  // Meal type filtering (Req 9.2)
  // =========================================================================
  describe('meal type filtering', () => {
    it('filters by meal_type (stored as tag)', () => {
      const result = filterRecipes(RECIPES, { meal_type: 'dinner' });
      expect(result).toHaveLength(2);
      expect(result.map(r => r.id)).toContain('r1');
      expect(result.map(r => r.id)).toContain('r5');
    });

    it('filters by breakfast meal type', () => {
      const result = filterRecipes(RECIPES, { meal_type: 'breakfast' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r2');
    });

    it('returns empty for meal type with no matches', () => {
      const result = filterRecipes(RECIPES, { meal_type: 'nonexistent' });
      expect(result).toHaveLength(0);
    });

    it('does not filter when meal_type is null/empty', () => {
      const result = filterRecipes(RECIPES, { meal_type: null });
      expect(result).toHaveLength(5);
    });
  });

  // =========================================================================
  // Favorites filtering (Req 9.3)
  // =========================================================================
  describe('favorites filtering', () => {
    it('filters to only favorited recipes', () => {
      const favSet = new Set(['r1', 'r3']);
      const result = filterRecipes(RECIPES, { favoritesOnly: true }, favSet);
      expect(result).toHaveLength(2);
      expect(result.map(r => r.id)).toContain('r1');
      expect(result.map(r => r.id)).toContain('r3');
    });

    it('returns empty when no recipes are favorited', () => {
      const favSet = new Set();
      const result = filterRecipes(RECIPES, { favoritesOnly: true }, favSet);
      expect(result).toHaveLength(0);
    });

    it('returns all recipes when favoritesOnly is false', () => {
      const favSet = new Set(['r1']);
      const result = filterRecipes(RECIPES, { favoritesOnly: false }, favSet);
      expect(result).toHaveLength(5);
    });

    it('does not filter when favoritesOnly is undefined', () => {
      const favSet = new Set(['r1']);
      const result = filterRecipes(RECIPES, {}, favSet);
      expect(result).toHaveLength(5);
    });
  });

  // =========================================================================
  // Combined filters (Req 9.2)
  // =========================================================================
  describe('combined filters', () => {
    it('combines tag + meal_type filter', () => {
      const result = filterRecipes(RECIPES, { tags: ['quick'], meal_type: 'dinner' });
      // Must match tag 'quick' AND have 'dinner' in tags
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r1');
    });

    it('combines tag + favorites filter', () => {
      const favSet = new Set(['r1', 'r2', 'r4']);
      const result = filterRecipes(RECIPES, { tags: ['high-protein'], favoritesOnly: true }, favSet);
      // Must have high-protein tag AND be a favorite
      expect(result).toHaveLength(2);
      expect(result.map(r => r.id)).toContain('r1');
      expect(result.map(r => r.id)).toContain('r4');
    });

    it('combines all three filters', () => {
      const favSet = new Set(['r1', 'r3', 'r5']);
      const result = filterRecipes(RECIPES, {
        tags: ['quick'],
        meal_type: 'dinner',
        favoritesOnly: true,
      }, favSet);
      // Must have 'quick' tag, 'dinner' in tags, and be a favorite
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r1');
    });

    it('returns empty when combined filters exclude everything', () => {
      const favSet = new Set(['r5']); // r5 has 'dinner' but not 'quick'
      const result = filterRecipes(RECIPES, {
        tags: ['quick'],
        meal_type: 'dinner',
        favoritesOnly: true,
      }, favSet);
      expect(result).toHaveLength(0);
    });
  });
});

describe('Recipe Book — sortRecipesByDate()', () => {
  it('sorts recipes by created_at descending (most recent first)', () => {
    const sorted = sortRecipesByDate(RECIPES);
    expect(sorted[0].id).toBe('r3'); // 2024-01-16
    expect(sorted[1].id).toBe('r1'); // 2024-01-15
    expect(sorted[2].id).toBe('r2'); // 2024-01-14
    expect(sorted[3].id).toBe('r4'); // 2024-01-13
    expect(sorted[4].id).toBe('r5'); // 2024-01-12
  });

  it('does not mutate the original array', () => {
    const original = [...RECIPES];
    sortRecipesByDate(RECIPES);
    expect(RECIPES).toEqual(original);
  });

  it('handles empty array', () => {
    const sorted = sortRecipesByDate([]);
    expect(sorted).toEqual([]);
  });

  it('handles single recipe', () => {
    const single = [makeRecipe({ id: 'only' })];
    const sorted = sortRecipesByDate(single);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].id).toBe('only');
  });
});

describe('Recipe Book — extractAllTags()', () => {
  it('extracts all unique tags from recipes', () => {
    const tags = extractAllTags(RECIPES);
    expect(tags).toContain('dinner');
    expect(tags).toContain('high-protein');
    expect(tags).toContain('quick');
    expect(tags).toContain('breakfast');
    expect(tags).toContain('vegetarian');
    expect(tags).toContain('lunch');
    expect(tags).toContain('snack');
  });

  it('returns sorted tags', () => {
    const tags = extractAllTags(RECIPES);
    const sortedCopy = [...tags].sort();
    expect(tags).toEqual(sortedCopy);
  });

  it('returns no duplicates', () => {
    const tags = extractAllTags(RECIPES);
    const unique = [...new Set(tags)];
    expect(tags).toEqual(unique);
  });

  it('handles empty recipe list', () => {
    const tags = extractAllTags([]);
    expect(tags).toEqual([]);
  });

  it('handles recipes with no tags', () => {
    const noTags = [makeRecipe({ tags: [] }), makeRecipe({ tags: null })];
    const tags = extractAllTags(noTags);
    expect(tags).toEqual([]);
  });
});

describe('Recipe Book — favourites (per person, in the database)', () => {
  // These lived in localStorage, which made them per-browser rather than
  // per-person: starring a recipe on the laptop left it unstarred on the
  // phone, and clearing site data wiped them.
  let rows;

  /** Stubs public.recipe_favorites as an in-memory table. */
  function stubFavouritesTable({ writeError = null, readError = null } = {}) {
    supabaseMock.from.mockImplementation((table) => {
      if (table !== 'recipe_favorites') return defaultFrom();
      return {
        select: () => ({
          eq: (_col, userId) => Promise.resolve({
            data: readError ? null : rows.filter(r => r.user_id === userId),
            error: readError,
          }),
        }),
        upsert: (row) => {
          if (!writeError && !rows.some(r =>
            r.user_id === row.user_id && r.recipe_id === row.recipe_id)) {
            rows.push(row);
          }
          return Promise.resolve({ error: writeError });
        },
        delete: () => ({
          eq: (_c1, userId) => ({
            eq: (_c2, recipeId) => {
              if (!writeError) {
                rows = rows.filter(r =>
                  !(r.user_id === userId && r.recipe_id === recipeId));
              }
              return Promise.resolve({ error: writeError });
            },
          }),
        }),
      };
    });
  }

  beforeEach(() => {
    rows = [];
    clearFavoritesCache();
    supabaseMock.from.mockImplementation(defaultFrom);
  });

  afterEach(() => {
    clearFavoritesCache();
    supabaseMock.from.mockImplementation(defaultFrom);
  });

  it('isFavorite is false for an unfavourited recipe', () => {
    expect(isFavorite('some-recipe-id')).toBe(false);
  });

  it('toggleFavorite writes a row', async () => {
    stubFavouritesTable();
    const result = await toggleFavorite('recipe-1');

    expect(result).toEqual({ success: true, favorite: true });
    expect(isFavorite('recipe-1')).toBe(true);
    expect(rows).toEqual([{ user_id: 'user-jamall', recipe_id: 'recipe-1' }]);
  });

  it('toggleFavorite removes the row again', async () => {
    stubFavouritesTable();
    await toggleFavorite('recipe-1');
    const result = await toggleFavorite('recipe-1');

    expect(result).toEqual({ success: true, favorite: false });
    expect(isFavorite('recipe-1')).toBe(false);
    expect(rows).toEqual([]);
  });

  it('survives a device it has never run on', async () => {
    // The whole point of moving off localStorage: a favourite starred
    // elsewhere is present on first load here.
    rows = [{ user_id: 'user-jamall', recipe_id: 'recipe-from-the-laptop' }];
    stubFavouritesTable();

    await fetchFavorites('user-jamall');
    expect(isFavorite('recipe-from-the-laptop')).toBe(true);
  });

  it('keeps each person’s favourites separate', async () => {
    rows = [
      { user_id: 'user-jamall', recipe_id: 'recipe-1' },
      { user_id: 'user-rebecca', recipe_id: 'recipe-2' },
    ];
    stubFavouritesTable();

    await fetchFavorites('user-jamall');
    expect(isFavorite('recipe-1')).toBe(true);
    expect(isFavorite('recipe-2')).toBe(false);

    await fetchFavorites('user-rebecca');
    expect(isFavorite('recipe-2')).toBe(true);
    expect(isFavorite('recipe-1')).toBe(false);
  });

  it('rolls the star back when the write fails', async () => {
    // A star that stays lit after a failed write is a lie about saved state.
    stubFavouritesTable({ writeError: { message: 'offline' } });

    const result = await toggleFavorite('recipe-1');
    expect(result).toEqual({ success: false, favorite: false });
    expect(isFavorite('recipe-1')).toBe(false);
  });

  it('does not blank the cache when the read fails', async () => {
    stubFavouritesTable();
    await toggleFavorite('recipe-1');
    expect(isFavorite('recipe-1')).toBe(true);

    // Showing everything as unstarred would invite re-starring what is
    // already starred, and read as data loss.
    stubFavouritesTable({ readError: { message: 'offline' } });
    await fetchFavorites('user-jamall');
    expect(isFavorite('recipe-1')).toBe(true);
  });

  it('favouriting twice does not write two rows', async () => {
    // The (user_id, recipe_id) primary key makes this idempotent, so a double
    // tap or an offline replay cannot duplicate.
    stubFavouritesTable();
    await toggleFavorite('recipe-1');
    rows.push(...[]);
    await fetchFavorites('user-jamall');
    await toggleFavorite('recipe-1');
    await toggleFavorite('recipe-1');

    expect(rows.filter(r => r.recipe_id === 'recipe-1')).toHaveLength(1);
  });

  it('several recipes can be favourited independently', async () => {
    stubFavouritesTable();
    await toggleFavorite('recipe-a');
    await toggleFavorite('recipe-b');
    await toggleFavorite('recipe-c');
    await toggleFavorite('recipe-b');

    expect(isFavorite('recipe-a')).toBe(true);
    expect(isFavorite('recipe-b')).toBe(false);
    expect(isFavorite('recipe-c')).toBe(true);
    expect(getFavorites().size).toBe(2);
  });
});
