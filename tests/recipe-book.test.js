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

// Mock the supabase client
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    from: () => ({
      insert: () => ({ select: () => ({ single: () => ({ data: null, error: null }) }) }),
      select: () => ({ order: () => ({ overlaps: () => ({ data: [], error: null }) }) }),
    }),
  },
}));

// Mock app-shell getCurrentUser
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: () => ({ id: 'user-jamall', display_name: 'Jamall' }),
  getPartner: () => ({ id: 'user-rebecca', display_name: 'Rebecca' }),
}));

import {
  filterRecipes,
  sortRecipesByDate,
  extractAllTags,
  isFavorite,
  toggleFavorite,
  loadFavorites,
} from '../js/recipe-book.js';

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

describe('Recipe Book — favorites (localStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('isFavorite returns false for unfavorited recipe', () => {
    expect(isFavorite('some-recipe-id')).toBe(false);
  });

  it('toggleFavorite adds a recipe to favorites', () => {
    const result = toggleFavorite('recipe-1');
    expect(result).toBe(true);
    expect(isFavorite('recipe-1')).toBe(true);
  });

  it('toggleFavorite removes a recipe from favorites', () => {
    toggleFavorite('recipe-1'); // add
    const result = toggleFavorite('recipe-1'); // remove
    expect(result).toBe(false);
    expect(isFavorite('recipe-1')).toBe(false);
  });

  it('favorites are independent per user', () => {
    // Toggle favorite for current user (user-jamall)
    toggleFavorite('recipe-1');
    expect(isFavorite('recipe-1')).toBe(true);

    // Load favorites for a different user — should be empty
    const partnerFavs = loadFavorites('user-rebecca');
    expect(partnerFavs.has('recipe-1')).toBe(false);
  });

  it('loadFavorites returns empty set for new user', () => {
    const favs = loadFavorites('brand-new-user');
    expect(favs.size).toBe(0);
  });

  it('loadFavorites handles corrupted localStorage data', () => {
    localStorage.setItem('recipe_favorites_user-jamall', 'not-valid-json{{{');
    const favs = loadFavorites('user-jamall');
    expect(favs.size).toBe(0);
  });

  it('multiple recipes can be favorited independently', () => {
    toggleFavorite('recipe-a');
    toggleFavorite('recipe-b');
    toggleFavorite('recipe-c');

    expect(isFavorite('recipe-a')).toBe(true);
    expect(isFavorite('recipe-b')).toBe(true);
    expect(isFavorite('recipe-c')).toBe(true);

    toggleFavorite('recipe-b'); // remove
    expect(isFavorite('recipe-a')).toBe(true);
    expect(isFavorite('recipe-b')).toBe(false);
    expect(isFavorite('recipe-c')).toBe(true);
  });
});
