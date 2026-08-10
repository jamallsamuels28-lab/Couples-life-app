/**
 * @vitest-environment jsdom
 *
 * Property 9: Macro aggregation equals independent sum
 * Validates: Requirements 7.5, 7.6
 *
 * For any set of meals for a single user on a single date, the aggregated
 * daily macros must equal the independent sum of each meal's calories,
 * protein_g, carbs_g, and fats_g. If the meal set is empty, all values
 * must be zero.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock the supabase client before importing food-module
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    from: () => ({
      insert: () => ({ select: () => ({ single: () => ({ data: null, error: null }) }) }),
    }),
  },
}));

// Mock app-shell getCurrentUser
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: () => ({ id: 'test-user-id', display_name: 'Test User' }),
}));

import { aggregateDailyMacros } from '../js/food-module.js';

// Generator: a single meal object with random macro values
const mealArb = fc.record({
  calories: fc.integer({ min: 0, max: 10000 }),
  protein_g: fc.integer({ min: 0, max: 10000 }),
  carbs_g: fc.integer({ min: 0, max: 10000 }),
  fats_g: fc.integer({ min: 0, max: 10000 }),
  // Include extra fields that a real meal object would have (should be ignored by aggregation)
  title: fc.string({ minLength: 1, maxLength: 50 }),
  meal_type: fc.constantFrom('breakfast', 'lunch', 'dinner', 'snack'),
});

// Generator: array of meals (including empty arrays)
const mealsArb = fc.array(mealArb, { minLength: 0, maxLength: 30 });

describe('Property 9: Macro aggregation equals independent sum', () => {
  /**
   * Validates: Requirements 7.5, 7.6
   */

  it('aggregated calories equals the sum of all meal calories', () => {
    fc.assert(
      fc.property(mealsArb, (meals) => {
        const result = aggregateDailyMacros(meals);
        const expectedCalories = meals.reduce((sum, m) => sum + m.calories, 0);
        expect(result.calories).toBe(expectedCalories);
      }),
      { numRuns: 200 }
    );
  });

  it('aggregated protein equals the sum of all meal protein_g', () => {
    fc.assert(
      fc.property(mealsArb, (meals) => {
        const result = aggregateDailyMacros(meals);
        const expectedProtein = meals.reduce((sum, m) => sum + m.protein_g, 0);
        expect(result.protein).toBe(expectedProtein);
      }),
      { numRuns: 200 }
    );
  });

  it('aggregated carbs equals the sum of all meal carbs_g', () => {
    fc.assert(
      fc.property(mealsArb, (meals) => {
        const result = aggregateDailyMacros(meals);
        const expectedCarbs = meals.reduce((sum, m) => sum + m.carbs_g, 0);
        expect(result.carbs).toBe(expectedCarbs);
      }),
      { numRuns: 200 }
    );
  });

  it('aggregated fats equals the sum of all meal fats_g', () => {
    fc.assert(
      fc.property(mealsArb, (meals) => {
        const result = aggregateDailyMacros(meals);
        const expectedFats = meals.reduce((sum, m) => sum + m.fats_g, 0);
        expect(result.fats).toBe(expectedFats);
      }),
      { numRuns: 200 }
    );
  });

  it('mealCount equals meals.length', () => {
    fc.assert(
      fc.property(mealsArb, (meals) => {
        const result = aggregateDailyMacros(meals);
        expect(result.mealCount).toBe(meals.length);
      }),
      { numRuns: 200 }
    );
  });

  it('for empty arrays all values are zero', () => {
    fc.assert(
      fc.property(fc.constant([]), (meals) => {
        const result = aggregateDailyMacros(meals);
        expect(result.calories).toBe(0);
        expect(result.protein).toBe(0);
        expect(result.carbs).toBe(0);
        expect(result.fats).toBe(0);
        expect(result.mealCount).toBe(0);
      }),
      { numRuns: 1 }
    );
  });

  it('all result values are always >= 0', () => {
    fc.assert(
      fc.property(mealsArb, (meals) => {
        const result = aggregateDailyMacros(meals);
        expect(result.calories).toBeGreaterThanOrEqual(0);
        expect(result.protein).toBeGreaterThanOrEqual(0);
        expect(result.carbs).toBeGreaterThanOrEqual(0);
        expect(result.fats).toBeGreaterThanOrEqual(0);
        expect(result.mealCount).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 200 }
    );
  });
});
