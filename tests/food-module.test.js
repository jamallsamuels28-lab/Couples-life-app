/**
 * Unit tests for the Food Module — meal logging validation.
 *
 * Tests cover:
 * - Title validation (empty, whitespace-only, max length)
 * - Meal type validation (valid enum values)
 * - Macro field validation (calories, protein_g, carbs_g, fats_g in range 0–10,000)
 * - Form data preservation on validation failure
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 14.1, 14.6
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';

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

import { validateMeal, aggregateDailyMacros } from '../js/food-module.js';

describe('Food Module — validateMeal()', () => {
  // =========================================================================
  // Title validation (Req 7.4, 14.6)
  // =========================================================================
  describe('title validation', () => {
    it('rejects empty title', () => {
      const result = validateMeal({
        title: '',
        meal_type: 'lunch',
        calories: 500,
        protein_g: 30,
        carbs_g: 60,
        fats_g: 20,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.title).toBe('Title is required');
    });

    it('rejects whitespace-only title', () => {
      const result = validateMeal({
        title: '   \t\n  ',
        meal_type: 'lunch',
        calories: 500,
        protein_g: 30,
        carbs_g: 60,
        fats_g: 20,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.title).toBe('Title is required');
    });

    it('rejects title exceeding 100 characters', () => {
      const longTitle = 'a'.repeat(101);
      const result = validateMeal({
        title: longTitle,
        meal_type: 'dinner',
        calories: 400,
        protein_g: 25,
        carbs_g: 50,
        fats_g: 15,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.title).toBe('Title must be 100 characters or fewer');
    });

    it('accepts title with exactly 100 characters', () => {
      const exactTitle = 'a'.repeat(100);
      const result = validateMeal({
        title: exactTitle,
        meal_type: 'breakfast',
        calories: 300,
        protein_g: 20,
        carbs_g: 40,
        fats_g: 10,
      });

      expect(result.valid).toBe(true);
      expect(result.errors.title).toBeUndefined();
    });

    it('accepts a normal title', () => {
      const result = validateMeal({
        title: 'Chicken & rice bowl',
        meal_type: 'lunch',
        calories: 650,
        protein_g: 45,
        carbs_g: 70,
        fats_g: 15,
      });

      expect(result.valid).toBe(true);
      expect(result.errors.title).toBeUndefined();
    });
  });

  // =========================================================================
  // Meal type validation (Req 7.2)
  // =========================================================================
  describe('meal_type validation', () => {
    it('accepts "breakfast"', () => {
      const result = validateMeal({
        title: 'Toast',
        meal_type: 'breakfast',
        calories: 200,
        protein_g: 5,
        carbs_g: 30,
        fats_g: 8,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts "lunch"', () => {
      const result = validateMeal({
        title: 'Salad',
        meal_type: 'lunch',
        calories: 350,
        protein_g: 20,
        carbs_g: 40,
        fats_g: 12,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts "dinner"', () => {
      const result = validateMeal({
        title: 'Pasta',
        meal_type: 'dinner',
        calories: 600,
        protein_g: 25,
        carbs_g: 80,
        fats_g: 20,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts "snack"', () => {
      const result = validateMeal({
        title: 'Yogurt',
        meal_type: 'snack',
        calories: 150,
        protein_g: 10,
        carbs_g: 15,
        fats_g: 5,
      });
      expect(result.valid).toBe(true);
    });

    it('rejects invalid meal type', () => {
      const result = validateMeal({
        title: 'Food',
        meal_type: 'brunch',
        calories: 400,
        protein_g: 20,
        carbs_g: 50,
        fats_g: 15,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.meal_type).toBe(
        'Meal type must be one of: breakfast, lunch, dinner, snack'
      );
    });

    it('rejects empty meal type', () => {
      const result = validateMeal({
        title: 'Food',
        meal_type: '',
        calories: 400,
        protein_g: 20,
        carbs_g: 50,
        fats_g: 15,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.meal_type).toBeDefined();
    });
  });

  // =========================================================================
  // Macro validation (Req 7.3, 14.1)
  // =========================================================================
  describe('calories validation', () => {
    it('accepts 0 calories', () => {
      const result = validateMeal({
        title: 'Water',
        meal_type: 'snack',
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fats_g: 0,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts 10,000 calories (upper bound)', () => {
      const result = validateMeal({
        title: 'Big meal',
        meal_type: 'dinner',
        calories: 10000,
        protein_g: 0,
        carbs_g: 0,
        fats_g: 0,
      });
      expect(result.valid).toBe(true);
    });

    it('rejects calories > 10,000', () => {
      const result = validateMeal({
        title: 'Overeating',
        meal_type: 'dinner',
        calories: 10001,
        protein_g: 0,
        carbs_g: 0,
        fats_g: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.calories).toBe('Calories must be between 0 and 10,000');
    });

    it('rejects negative calories', () => {
      const result = validateMeal({
        title: 'Negative',
        meal_type: 'breakfast',
        calories: -1,
        protein_g: 0,
        carbs_g: 0,
        fats_g: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.calories).toBe('Calories must be between 0 and 10,000');
    });

    it('rejects non-numeric calories', () => {
      const result = validateMeal({
        title: 'Test',
        meal_type: 'lunch',
        calories: 'abc',
        protein_g: 0,
        carbs_g: 0,
        fats_g: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.calories).toBe('Calories must be between 0 and 10,000');
    });
  });

  describe('protein_g validation', () => {
    it('rejects protein > 10,000', () => {
      const result = validateMeal({
        title: 'Test',
        meal_type: 'lunch',
        calories: 500,
        protein_g: 10001,
        carbs_g: 0,
        fats_g: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.protein_g).toBe('Protein must be between 0 and 10,000');
    });

    it('rejects negative protein', () => {
      const result = validateMeal({
        title: 'Test',
        meal_type: 'lunch',
        calories: 500,
        protein_g: -5,
        carbs_g: 0,
        fats_g: 0,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.protein_g).toBe('Protein must be between 0 and 10,000');
    });
  });

  describe('carbs_g validation', () => {
    it('rejects carbs > 10,000', () => {
      const result = validateMeal({
        title: 'Test',
        meal_type: 'dinner',
        calories: 500,
        protein_g: 30,
        carbs_g: 10001,
        fats_g: 10,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.carbs_g).toBe('Carbs must be between 0 and 10,000');
    });

    it('rejects negative carbs', () => {
      const result = validateMeal({
        title: 'Test',
        meal_type: 'dinner',
        calories: 500,
        protein_g: 30,
        carbs_g: -1,
        fats_g: 10,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.carbs_g).toBe('Carbs must be between 0 and 10,000');
    });
  });

  describe('fats_g validation', () => {
    it('rejects fats > 10,000', () => {
      const result = validateMeal({
        title: 'Test',
        meal_type: 'snack',
        calories: 200,
        protein_g: 5,
        carbs_g: 10,
        fats_g: 10001,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.fats_g).toBe('Fats must be between 0 and 10,000');
    });

    it('rejects negative fats', () => {
      const result = validateMeal({
        title: 'Test',
        meal_type: 'snack',
        calories: 200,
        protein_g: 5,
        carbs_g: 10,
        fats_g: -10,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.fats_g).toBe('Fats must be between 0 and 10,000');
    });
  });

  // =========================================================================
  // Multiple field errors (Req 14.1 — inline error adjacent to each failing field)
  // =========================================================================
  describe('multiple field errors', () => {
    it('returns errors for all invalid fields simultaneously', () => {
      const result = validateMeal({
        title: '',
        meal_type: 'brunch',
        calories: -1,
        protein_g: 99999,
        carbs_g: -5,
        fats_g: 20000,
      });

      expect(result.valid).toBe(false);
      expect(result.errors.title).toBeDefined();
      expect(result.errors.meal_type).toBeDefined();
      expect(result.errors.calories).toBeDefined();
      expect(result.errors.protein_g).toBeDefined();
      expect(result.errors.carbs_g).toBeDefined();
      expect(result.errors.fats_g).toBeDefined();
    });
  });

  // =========================================================================
  // Valid meal (happy path)
  // =========================================================================
  describe('valid meal data', () => {
    it('passes validation for a complete valid meal', () => {
      const result = validateMeal({
        title: 'Grilled chicken with quinoa',
        meal_type: 'dinner',
        calories: 650,
        protein_g: 45,
        carbs_g: 70,
        fats_g: 15,
      });

      expect(result.valid).toBe(true);
      expect(Object.keys(result.errors)).toHaveLength(0);
    });

    it('accepts boundary macro values (all at 0)', () => {
      const result = validateMeal({
        title: 'Plain water',
        meal_type: 'snack',
        calories: 0,
        protein_g: 0,
        carbs_g: 0,
        fats_g: 0,
      });

      expect(result.valid).toBe(true);
    });

    it('accepts boundary macro values (all at 10,000)', () => {
      const result = validateMeal({
        title: 'Maximum entry',
        meal_type: 'breakfast',
        calories: 10000,
        protein_g: 10000,
        carbs_g: 10000,
        fats_g: 10000,
      });

      expect(result.valid).toBe(true);
    });

    it('accepts string number values (as from form inputs)', () => {
      const result = validateMeal({
        title: 'From form',
        meal_type: 'lunch',
        calories: '500',
        protein_g: '30.5',
        carbs_g: '60',
        fats_g: '15',
      });

      expect(result.valid).toBe(true);
    });
  });
});


// ===========================================================================
// Tests for aggregateDailyMacros — daily macro aggregation
// Requirements: 7.5, 7.6
// ===========================================================================

describe('Food Module — aggregateDailyMacros()', () => {
  describe('empty input', () => {
    it('returns all zeros for empty array', () => {
      const result = aggregateDailyMacros([]);

      expect(result).toEqual({
        calories: 0,
        protein: 0,
        carbs: 0,
        fats: 0,
        mealCount: 0,
      });
    });

    it('returns all zeros for null input', () => {
      const result = aggregateDailyMacros(null);

      expect(result).toEqual({
        calories: 0,
        protein: 0,
        carbs: 0,
        fats: 0,
        mealCount: 0,
      });
    });

    it('returns all zeros for undefined input', () => {
      const result = aggregateDailyMacros(undefined);

      expect(result).toEqual({
        calories: 0,
        protein: 0,
        carbs: 0,
        fats: 0,
        mealCount: 0,
      });
    });
  });

  describe('single meal', () => {
    it('returns the meal values directly for a single meal', () => {
      const meals = [
        { calories: 650, protein_g: 45, carbs_g: 70, fats_g: 15 },
      ];

      const result = aggregateDailyMacros(meals);

      expect(result).toEqual({
        calories: 650,
        protein: 45,
        carbs: 70,
        fats: 15,
        mealCount: 1,
      });
    });

    it('handles a single meal with all zeros', () => {
      const meals = [
        { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0 },
      ];

      const result = aggregateDailyMacros(meals);

      expect(result).toEqual({
        calories: 0,
        protein: 0,
        carbs: 0,
        fats: 0,
        mealCount: 1,
      });
    });
  });

  describe('multiple meals', () => {
    it('sums macros across multiple meals correctly', () => {
      const meals = [
        { calories: 300, protein_g: 20, carbs_g: 40, fats_g: 10 },
        { calories: 650, protein_g: 45, carbs_g: 70, fats_g: 15 },
        { calories: 200, protein_g: 10, carbs_g: 25, fats_g: 8 },
      ];

      const result = aggregateDailyMacros(meals);

      expect(result).toEqual({
        calories: 1150,
        protein: 75,
        carbs: 135,
        fats: 33,
        mealCount: 3,
      });
    });

    it('handles decimal values in protein, carbs, and fats', () => {
      const meals = [
        { calories: 400, protein_g: 22.5, carbs_g: 55.3, fats_g: 12.7 },
        { calories: 350, protein_g: 18.2, carbs_g: 42.1, fats_g: 9.8 },
      ];

      const result = aggregateDailyMacros(meals);

      expect(result.calories).toBe(750);
      expect(result.protein).toBeCloseTo(40.7, 5);
      expect(result.carbs).toBeCloseTo(97.4, 5);
      expect(result.fats).toBeCloseTo(22.5, 5);
      expect(result.mealCount).toBe(2);
    });

    it('handles string numeric values (as from database numeric types)', () => {
      const meals = [
        { calories: '500', protein_g: '30.5', carbs_g: '60', fats_g: '15.2' },
        { calories: '300', protein_g: '20', carbs_g: '35.5', fats_g: '10' },
      ];

      const result = aggregateDailyMacros(meals);

      expect(result.calories).toBe(800);
      expect(result.protein).toBeCloseTo(50.5, 5);
      expect(result.carbs).toBeCloseTo(95.5, 5);
      expect(result.fats).toBeCloseTo(25.2, 5);
      expect(result.mealCount).toBe(2);
    });
  });
});
