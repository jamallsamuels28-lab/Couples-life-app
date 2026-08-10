// ============================================================
// Unit Tests — Recipe Generator Module
// Tests for mergeAllergies, selectDietType, buildRecipePrompt,
// validateRecipeAgainstDiet, and generateRecipe orchestration.
// ============================================================

/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock supabase-client
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    functions: {
      invoke: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
        })),
        order: vi.fn(() => Promise.resolve({ data: [], error: null })),
      })),
    })),
  },
}));

// Mock app-shell
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: () => ({ id: 'user-jamall', display_name: 'Jamall' }),
  getPartner: () => ({ id: 'user-rebecca', display_name: 'Rebecca' }),
}));

// Mock dietary-preferences
vi.mock('../js/dietary-preferences.js', () => ({
  getBothPreferences: vi.fn(() => Promise.resolve({ user: null, partner: null })),
}));

// Mock pantry-module
vi.mock('../js/pantry-module.js', () => ({
  fetchValidPantryItems: vi.fn(() => Promise.resolve({ success: true, data: [] })),
}));

import {
  mergeAllergies,
  selectDietType,
  buildRecipePrompt,
  validateRecipeAgainstDiet,
  generateRecipe,
  DIET_HIERARCHY,
  DIET_RESTRICTIONS,
} from '../js/recipe-generator.js';

// --- mergeAllergies ---

describe('mergeAllergies', () => {
  it('returns empty array when both preferences are null', () => {
    expect(mergeAllergies(null, null)).toEqual([]);
  });

  it('returns empty array when both have empty allergies', () => {
    expect(mergeAllergies({ allergies: [] }, { allergies: [] })).toEqual([]);
  });

  it('returns first partner allergies when second is null', () => {
    const prefsA = { allergies: ['Peanuts', 'Shellfish'] };
    const result = mergeAllergies(prefsA, null);
    expect(result).toEqual(['peanuts', 'shellfish']);
  });

  it('returns second partner allergies when first is null', () => {
    const prefsB = { allergies: ['Dairy', 'Gluten'] };
    const result = mergeAllergies(null, prefsB);
    expect(result).toEqual(['dairy', 'gluten']);
  });

  it('returns union of both partners allergies', () => {
    const prefsA = { allergies: ['Peanuts', 'Shellfish'] };
    const prefsB = { allergies: ['Dairy', 'Gluten'] };
    const result = mergeAllergies(prefsA, prefsB);
    expect(result.sort()).toEqual(['dairy', 'gluten', 'peanuts', 'shellfish']);
  });

  it('deduplicates overlapping allergies (case-insensitive)', () => {
    const prefsA = { allergies: ['Peanuts', 'Dairy'] };
    const prefsB = { allergies: ['peanuts', 'Gluten'] };
    const result = mergeAllergies(prefsA, prefsB);
    expect(result.sort()).toEqual(['dairy', 'gluten', 'peanuts']);
  });

  it('handles preferences object without allergies array', () => {
    const prefsA = { diet_type: 'vegan' };
    const prefsB = { allergies: ['nuts'] };
    const result = mergeAllergies(prefsA, prefsB);
    expect(result).toEqual(['nuts']);
  });

  it('trims whitespace from allergy names', () => {
    const prefsA = { allergies: ['  peanuts  ', 'shellfish '] };
    const result = mergeAllergies(prefsA, null);
    expect(result).toEqual(['peanuts', 'shellfish']);
  });

  it('filters out empty strings after trim', () => {
    const prefsA = { allergies: ['', '  ', 'peanuts'] };
    const result = mergeAllergies(prefsA, null);
    expect(result).toEqual(['peanuts']);
  });
});

// --- selectDietType ---

describe('selectDietType', () => {
  it('returns "flexible" when both are null', () => {
    expect(selectDietType(null, null)).toBe('flexible');
  });

  it('returns "flexible" when both are undefined', () => {
    expect(selectDietType(undefined, undefined)).toBe('flexible');
  });

  it('returns "flexible" when both are "flexible"', () => {
    expect(selectDietType('flexible', 'flexible')).toBe('flexible');
  });

  it('returns "vegan" when one is vegan and other is flexible', () => {
    expect(selectDietType('vegan', 'flexible')).toBe('vegan');
  });

  it('returns "vegan" when one is flexible and other is vegan', () => {
    expect(selectDietType('flexible', 'vegan')).toBe('vegan');
  });

  it('returns "vegetarian" when one is vegetarian and other is keto', () => {
    expect(selectDietType('vegetarian', 'keto')).toBe('vegetarian');
  });

  it('returns "halal" when one is halal and other is flexible', () => {
    expect(selectDietType('halal', 'flexible')).toBe('halal');
  });

  it('returns "vegan" when one is vegan and other is vegetarian', () => {
    expect(selectDietType('vegan', 'vegetarian')).toBe('vegan');
  });

  it('returns "halal" when one is halal and other is keto', () => {
    expect(selectDietType('halal', 'keto')).toBe('halal');
  });

  it('treats invalid diet type as "flexible"', () => {
    expect(selectDietType('paleo', 'vegan')).toBe('vegan');
  });

  it('treats empty string as "flexible"', () => {
    expect(selectDietType('', 'keto')).toBe('keto');
  });

  it('returns the same type when both partners have the same type', () => {
    expect(selectDietType('vegetarian', 'vegetarian')).toBe('vegetarian');
  });

  // Test all pairwise comparisons — more restrictive always wins
  it('hierarchy is consistent: vegan > vegetarian > halal > keto > flexible', () => {
    for (let i = 0; i < DIET_HIERARCHY.length; i++) {
      for (let j = i; j < DIET_HIERARCHY.length; j++) {
        const result = selectDietType(DIET_HIERARCHY[i], DIET_HIERARCHY[j]);
        expect(result).toBe(DIET_HIERARCHY[i]);
        // Symmetric
        const resultReverse = selectDietType(DIET_HIERARCHY[j], DIET_HIERARCHY[i]);
        expect(resultReverse).toBe(DIET_HIERARCHY[i]);
      }
    }
  });
});

// --- buildRecipePrompt ---

describe('buildRecipePrompt', () => {
  it('includes opening instruction', () => {
    const prompt = buildRecipePrompt({ allergies: [], dislikes: [], dietType: 'flexible' }, [], {});
    expect(prompt).toContain('Generate a recipe');
  });

  it('includes diet type when not flexible', () => {
    const prompt = buildRecipePrompt({ allergies: [], dislikes: [], dietType: 'vegan' }, [], {});
    expect(prompt).toContain('vegan');
    expect(prompt).toContain('MUST strictly follow');
  });

  it('does not include diet type instruction when flexible', () => {
    const prompt = buildRecipePrompt({ allergies: [], dislikes: [], dietType: 'flexible' }, [], {});
    expect(prompt).not.toContain('MUST strictly follow');
  });

  it('includes allergens in exclusion list', () => {
    const prompt = buildRecipePrompt(
      { allergies: ['peanuts', 'shellfish'], dislikes: [], dietType: 'flexible' },
      [],
      {}
    );
    expect(prompt).toContain('peanuts');
    expect(prompt).toContain('shellfish');
    expect(prompt).toContain('ALLERGENS TO EXCLUDE');
  });

  it('includes dislikes', () => {
    const prompt = buildRecipePrompt(
      { allergies: [], dislikes: ['mushrooms', 'olives'], dietType: 'flexible' },
      [],
      {}
    );
    expect(prompt).toContain('mushrooms');
    expect(prompt).toContain('olives');
    expect(prompt).toContain('Disliked ingredients');
  });

  it('includes pantry items as preferred ingredients', () => {
    const pantryItems = [
      { name: 'Chicken breast', category: 'protein' },
      { name: 'Rice', category: 'grain' },
    ];
    const prompt = buildRecipePrompt(
      { allergies: [], dislikes: [], dietType: 'flexible' },
      pantryItems,
      {}
    );
    expect(prompt).toContain('Chicken breast');
    expect(prompt).toContain('Rice');
    expect(prompt).toContain('Preferred ingredients from pantry');
  });

  it('includes meal type constraint', () => {
    const prompt = buildRecipePrompt(
      { allergies: [], dislikes: [], dietType: 'flexible' },
      [],
      { mealType: 'dinner' }
    );
    expect(prompt).toContain('Meal type: dinner');
  });

  it('includes max prep time constraint', () => {
    const prompt = buildRecipePrompt(
      { allergies: [], dislikes: [], dietType: 'flexible' },
      [],
      { maxPrepTime: 30 }
    );
    expect(prompt).toContain('Maximum preparation time: 30 minutes');
  });

  it('includes max calories constraint', () => {
    const prompt = buildRecipePrompt(
      { allergies: [], dislikes: [], dietType: 'flexible' },
      [],
      { maxCalories: 500 }
    );
    expect(prompt).toContain('Maximum calories per serving: 500');
  });

  it('includes servings constraint', () => {
    const prompt = buildRecipePrompt(
      { allergies: [], dislikes: [], dietType: 'flexible' },
      [],
      { servings: 4 }
    );
    expect(prompt).toContain('Number of servings: 4');
  });

  it('builds a complete prompt with all options', () => {
    const prompt = buildRecipePrompt(
      { allergies: ['nuts'], dislikes: ['cilantro'], dietType: 'vegetarian' },
      [{ name: 'Tofu', category: 'protein' }],
      { mealType: 'lunch', maxPrepTime: 20, maxCalories: 400, servings: 2 }
    );
    expect(prompt).toContain('vegetarian');
    expect(prompt).toContain('nuts');
    expect(prompt).toContain('cilantro');
    expect(prompt).toContain('Tofu');
    expect(prompt).toContain('lunch');
    expect(prompt).toContain('20 minutes');
    expect(prompt).toContain('400');
    expect(prompt).toContain('2');
  });

  it('handles empty pantry items array gracefully', () => {
    const prompt = buildRecipePrompt(
      { allergies: [], dislikes: [], dietType: 'flexible' },
      [],
      {}
    );
    expect(prompt).not.toContain('Preferred ingredients from pantry');
  });
});

// --- validateRecipeAgainstDiet ---

describe('validateRecipeAgainstDiet', () => {
  const makeRecipe = (ingredientNames) => ({
    title: 'Test Recipe',
    ingredients: ingredientNames.map(name => ({ name, amount: '1', unit: 'cup' })),
    steps: [{ order: 1, instruction: 'Cook it' }],
    macros: { calories: 500, protein_g: 30, carbs_g: 50, fats_g: 20 },
  });

  it('returns valid for recipe with no allergens and flexible diet', () => {
    const recipe = makeRecipe(['rice', 'vegetables', 'olive oil']);
    const result = validateRecipeAgainstDiet(recipe, [], 'flexible');
    expect(result.valid).toBe(true);
  });

  it('returns invalid when recipe contains an allergen', () => {
    const recipe = makeRecipe(['rice', 'peanut butter', 'vegetables']);
    const result = validateRecipeAgainstDiet(recipe, ['peanut'], 'flexible');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('peanut');
  });

  it('allergen matching is case-insensitive', () => {
    const recipe = makeRecipe(['Rice', 'Shrimp', 'Garlic']);
    const result = validateRecipeAgainstDiet(recipe, ['shrimp'], 'flexible');
    expect(result.valid).toBe(false);
  });

  it('returns invalid when vegan recipe contains meat', () => {
    const recipe = makeRecipe(['tofu', 'chicken breast', 'vegetables']);
    const result = validateRecipeAgainstDiet(recipe, [], 'vegan');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('vegan');
    expect(result.reason).toContain('chicken');
  });

  it('returns invalid when vegan recipe contains dairy', () => {
    const recipe = makeRecipe(['pasta', 'cheese', 'tomato']);
    const result = validateRecipeAgainstDiet(recipe, [], 'vegan');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('cheese');
  });

  it('returns invalid when vegetarian recipe contains fish', () => {
    const recipe = makeRecipe(['rice', 'salmon fillet', 'lemon']);
    const result = validateRecipeAgainstDiet(recipe, [], 'vegetarian');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('salmon');
  });

  it('returns valid when vegetarian recipe has no meat', () => {
    const recipe = makeRecipe(['tofu', 'rice', 'vegetables', 'soy sauce']);
    const result = validateRecipeAgainstDiet(recipe, [], 'vegetarian');
    expect(result.valid).toBe(true);
  });

  it('returns invalid when halal recipe contains pork', () => {
    const recipe = makeRecipe(['rice', 'pork chop', 'vegetables']);
    const result = validateRecipeAgainstDiet(recipe, [], 'halal');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('pork');
  });

  it('returns invalid when halal recipe contains alcohol', () => {
    const recipe = makeRecipe(['rice', 'wine-braised vegetables']);
    const result = validateRecipeAgainstDiet(recipe, [], 'halal');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('wine');
  });

  it('returns valid for keto recipe (no ingredient restrictions)', () => {
    const recipe = makeRecipe(['butter', 'steak', 'avocado']);
    const result = validateRecipeAgainstDiet(recipe, [], 'keto');
    expect(result.valid).toBe(true);
  });

  it('returns valid for flexible diet with any ingredients', () => {
    const recipe = makeRecipe(['pork', 'cheese', 'wine', 'shellfish']);
    const result = validateRecipeAgainstDiet(recipe, [], 'flexible');
    expect(result.valid).toBe(true);
  });

  it('returns invalid for null recipe', () => {
    const result = validateRecipeAgainstDiet(null, [], 'flexible');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Invalid recipe structure');
  });

  it('returns invalid for recipe without ingredients array', () => {
    const result = validateRecipeAgainstDiet({ title: 'Test' }, [], 'flexible');
    expect(result.valid).toBe(false);
  });

  it('checks allergens before diet restrictions', () => {
    // Has both an allergen AND diet violation
    const recipe = makeRecipe(['peanut butter', 'chicken']);
    const result = validateRecipeAgainstDiet(recipe, ['peanut'], 'vegan');
    // Should catch the allergen first
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('allergen');
  });
});

// --- generateRecipe (integration-style with mocks) ---

describe('generateRecipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports generateRecipe as a function', () => {
    expect(typeof generateRecipe).toBe('function');
  });

  it('exports all expected functions', () => {
    expect(typeof mergeAllergies).toBe('function');
    expect(typeof selectDietType).toBe('function');
    expect(typeof buildRecipePrompt).toBe('function');
    expect(typeof validateRecipeAgainstDiet).toBe('function');
    expect(typeof generateRecipe).toBe('function');
  });

  it('DIET_HIERARCHY has correct order', () => {
    expect(DIET_HIERARCHY).toEqual(['vegan', 'vegetarian', 'halal', 'keto', 'flexible']);
  });

  it('returns success with a valid recipe', async () => {
    const { getBothPreferences } = await import('../js/dietary-preferences.js');
    const { fetchValidPantryItems } = await import('../js/pantry-module.js');
    const { supabase } = await import('../js/supabase-client.js');

    getBothPreferences.mockResolvedValue({
      user: { allergies: ['peanuts'], dislikes: [], diet_type: 'flexible' },
      partner: { allergies: [], dislikes: ['mushrooms'], diet_type: 'flexible' },
    });

    fetchValidPantryItems.mockResolvedValue({
      success: true,
      data: [{ name: 'Chicken', category: 'protein' }],
    });

    const validRecipe = {
      title: 'Grilled Chicken Salad',
      ingredients: [
        { name: 'chicken breast', amount: '2', unit: 'pieces' },
        { name: 'lettuce', amount: '1', unit: 'head' },
        { name: 'olive oil', amount: '2', unit: 'tbsp' },
      ],
      steps: [{ order: 1, instruction: 'Grill the chicken' }],
      macros: { calories: 400, protein_g: 35, carbs_g: 10, fats_g: 20 },
    };

    supabase.functions.invoke.mockResolvedValue({
      data: { recipe: validRecipe },
      error: null,
    });

    const result = await generateRecipe({ mealType: 'dinner' });
    expect(result.success).toBe(true);
    expect(result.recipe.title).toBe('Grilled Chicken Salad');
  });

  it('returns error when Edge Function fails', async () => {
    const { getBothPreferences } = await import('../js/dietary-preferences.js');
    const { fetchValidPantryItems } = await import('../js/pantry-module.js');
    const { supabase } = await import('../js/supabase-client.js');

    getBothPreferences.mockResolvedValue({ user: null, partner: null });
    fetchValidPantryItems.mockResolvedValue({ success: true, data: [] });

    supabase.functions.invoke.mockResolvedValue({
      data: null,
      error: { message: 'Function error' },
    });

    const result = await generateRecipe();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Recipe generation failed');
  });

  it('says the function is not deployed rather than blaming the network', async () => {
    // A HAR capture showed the undeployed function surfacing as "offline",
    // which sent us looking at connectivity instead of at a missing deploy.
    const { getBothPreferences } = await import('../js/dietary-preferences.js');
    const { fetchValidPantryItems } = await import('../js/pantry-module.js');
    const { supabase } = await import('../js/supabase-client.js');

    getBothPreferences.mockResolvedValue({ user: null, partner: null });
    fetchValidPantryItems.mockResolvedValue({ success: true, data: [] });

    supabase.functions.invoke.mockResolvedValue({
      data: null,
      error: { message: 'Not Found', context: { status: 404 } },
    });

    const result = await generateRecipe();
    expect(result.success).toBe(false);
    expect(result.error).toContain('not deployed');
  });

  it('returns error when generated recipe contains allergen', async () => {
    const { getBothPreferences } = await import('../js/dietary-preferences.js');
    const { fetchValidPantryItems } = await import('../js/pantry-module.js');
    const { supabase } = await import('../js/supabase-client.js');

    getBothPreferences.mockResolvedValue({
      user: { allergies: ['peanut'], dislikes: [], diet_type: 'flexible' },
      partner: { allergies: [], dislikes: [], diet_type: 'flexible' },
    });

    fetchValidPantryItems.mockResolvedValue({ success: true, data: [] });

    const recipeWithAllergen = {
      title: 'Peanut Stir Fry',
      ingredients: [
        { name: 'peanut oil', amount: '2', unit: 'tbsp' },
        { name: 'tofu', amount: '200', unit: 'g' },
      ],
      steps: [{ order: 1, instruction: 'Stir fry' }],
      macros: { calories: 300, protein_g: 20, carbs_g: 15, fats_g: 18 },
    };

    supabase.functions.invoke.mockResolvedValue({
      data: { recipe: recipeWithAllergen },
      error: null,
    });

    const result = await generateRecipe();
    expect(result.success).toBe(false);
    expect(result.error).toContain('dietary safety requirements');
  });

  it('returns error when generated recipe violates diet type', async () => {
    const { getBothPreferences } = await import('../js/dietary-preferences.js');
    const { fetchValidPantryItems } = await import('../js/pantry-module.js');
    const { supabase } = await import('../js/supabase-client.js');

    getBothPreferences.mockResolvedValue({
      user: { allergies: [], dislikes: [], diet_type: 'vegan' },
      partner: { allergies: [], dislikes: [], diet_type: 'flexible' },
    });

    fetchValidPantryItems.mockResolvedValue({ success: true, data: [] });

    const recipeWithMeat = {
      title: 'Chicken Curry',
      ingredients: [
        { name: 'chicken thigh', amount: '500', unit: 'g' },
        { name: 'coconut milk', amount: '400', unit: 'ml' },
      ],
      steps: [{ order: 1, instruction: 'Cook curry' }],
      macros: { calories: 600, protein_g: 40, carbs_g: 10, fats_g: 35 },
    };

    supabase.functions.invoke.mockResolvedValue({
      data: { recipe: recipeWithMeat },
      error: null,
    });

    const result = await generateRecipe();
    expect(result.success).toBe(false);
    expect(result.error).toContain('dietary safety requirements');
  });

  it('treats missing preferences gracefully (Requirement 8.9)', async () => {
    const { getBothPreferences } = await import('../js/dietary-preferences.js');
    const { fetchValidPantryItems } = await import('../js/pantry-module.js');
    const { supabase } = await import('../js/supabase-client.js');

    // Simulate preferences fetch failure
    getBothPreferences.mockRejectedValue(new Error('Not authenticated'));
    fetchValidPantryItems.mockResolvedValue({ success: true, data: [] });

    const validRecipe = {
      title: 'Simple Pasta',
      ingredients: [
        { name: 'pasta', amount: '200', unit: 'g' },
        { name: 'tomato sauce', amount: '1', unit: 'cup' },
      ],
      steps: [{ order: 1, instruction: 'Boil pasta' }],
      macros: { calories: 400, protein_g: 12, carbs_g: 70, fats_g: 5 },
    };

    supabase.functions.invoke.mockResolvedValue({
      data: { recipe: validRecipe },
      error: null,
    });

    const result = await generateRecipe();
    expect(result.success).toBe(true);
    expect(result.recipe.title).toBe('Simple Pasta');
  });

  it('proceeds without pantry items when pantry fetch fails', async () => {
    const { getBothPreferences } = await import('../js/dietary-preferences.js');
    const { fetchValidPantryItems } = await import('../js/pantry-module.js');
    const { supabase } = await import('../js/supabase-client.js');

    getBothPreferences.mockResolvedValue({ user: null, partner: null });
    fetchValidPantryItems.mockRejectedValue(new Error('DB error'));

    const validRecipe = {
      title: 'Quick Salad',
      ingredients: [
        { name: 'lettuce', amount: '1', unit: 'head' },
        { name: 'tomato', amount: '2', unit: 'pieces' },
      ],
      steps: [{ order: 1, instruction: 'Chop and mix' }],
      macros: { calories: 100, protein_g: 3, carbs_g: 12, fats_g: 2 },
    };

    supabase.functions.invoke.mockResolvedValue({
      data: { recipe: validRecipe },
      error: null,
    });

    const result = await generateRecipe();
    expect(result.success).toBe(true);
  });
});
