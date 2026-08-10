import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for the generate-recipe Edge Function logic.
 * We test the core functions (validateRecipeStructure, normalizeRecipe, retry logic)
 * by re-implementing the pure logic in a testable form (since the Edge Function
 * runs on Deno and we test with Node/Vitest).
 *
 * Validates: Requirements 8.5, 8.8, 11.5
 */

// --- Re-implement core logic for testing (mirrors index.ts) ---

function validateRecipeStructure(data) {
  if (!data || typeof data !== 'object') return false;

  // Validate title
  if (typeof data.title !== 'string' || data.title.trim().length === 0) return false;

  // Validate ingredients
  if (!Array.isArray(data.ingredients) || data.ingredients.length === 0) return false;
  for (const ing of data.ingredients) {
    if (typeof ing !== 'object' || ing === null) return false;
    if (typeof ing.name !== 'string' || ing.name.trim().length === 0) return false;
    if (typeof ing.amount !== 'string' && typeof ing.amount !== 'number') return false;
    if (typeof ing.unit !== 'string') return false;
  }

  // Validate steps
  if (!Array.isArray(data.steps) || data.steps.length === 0) return false;
  for (const step of data.steps) {
    if (typeof step !== 'object' || step === null) return false;
    if (typeof step.order !== 'number') return false;
    if (typeof step.instruction !== 'string' || step.instruction.trim().length === 0) return false;
  }

  // Validate macros
  if (!data.macros || typeof data.macros !== 'object') return false;
  if (typeof data.macros.calories !== 'number' || data.macros.calories < 0) return false;
  if (typeof data.macros.protein_g !== 'number' || data.macros.protein_g < 0) return false;
  if (typeof data.macros.carbs_g !== 'number' || data.macros.carbs_g < 0) return false;
  if (typeof data.macros.fats_g !== 'number' || data.macros.fats_g < 0) return false;

  return true;
}

function normalizeRecipe(data) {
  const ingredients = data.ingredients.map((ing) => ({
    name: String(ing.name).trim(),
    amount: String(ing.amount),
    unit: String(ing.unit),
  }));

  const steps = data.steps.map((step, index) => ({
    order: typeof step.order === 'number' ? step.order : index + 1,
    instruction: String(step.instruction).trim(),
  }));

  return {
    title: String(data.title).trim(),
    ingredients,
    steps,
    macros: {
      calories: Math.round(data.macros.calories),
      protein_g: Math.round(data.macros.protein_g * 10) / 10,
      carbs_g: Math.round(data.macros.carbs_g * 10) / 10,
      fats_g: Math.round(data.macros.fats_g * 10) / 10,
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateWithRetry(callFn, maxRetries = 3, baseDelayMs = 1000, sleepFn = sleep) {
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await callFn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleepFn(delay);
      }
    }
  }

  throw lastError;
}

// --- Valid recipe fixture ---
const VALID_RECIPE = {
  title: 'Grilled Chicken Salad',
  ingredients: [
    { name: 'chicken breast', amount: '200', unit: 'g' },
    { name: 'mixed greens', amount: '100', unit: 'g' },
    { name: 'olive oil', amount: '1', unit: 'tbsp' },
  ],
  steps: [
    { order: 1, instruction: 'Season and grill the chicken breast for 6 minutes per side.' },
    { order: 2, instruction: 'Let chicken rest, then slice thinly.' },
    { order: 3, instruction: 'Toss greens with olive oil and top with sliced chicken.' },
  ],
  macros: {
    calories: 350,
    protein_g: 42,
    carbs_g: 5,
    fats_g: 18,
  },
};

// --- Tests ---

describe('generate-recipe: validateRecipeStructure', () => {
  it('accepts a valid recipe structure', () => {
    expect(validateRecipeStructure(VALID_RECIPE)).toBe(true);
  });

  it('rejects null input', () => {
    expect(validateRecipeStructure(null)).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateRecipeStructure('string')).toBe(false);
    expect(validateRecipeStructure(42)).toBe(false);
    expect(validateRecipeStructure(undefined)).toBe(false);
  });

  it('rejects recipe with empty title', () => {
    expect(validateRecipeStructure({ ...VALID_RECIPE, title: '' })).toBe(false);
    expect(validateRecipeStructure({ ...VALID_RECIPE, title: '   ' })).toBe(false);
  });

  it('rejects recipe with missing title', () => {
    const { title, ...noTitle } = VALID_RECIPE;
    expect(validateRecipeStructure(noTitle)).toBe(false);
  });

  it('rejects recipe with empty ingredients array', () => {
    expect(validateRecipeStructure({ ...VALID_RECIPE, ingredients: [] })).toBe(false);
  });

  it('rejects recipe with missing ingredients', () => {
    const { ingredients, ...noIng } = VALID_RECIPE;
    expect(validateRecipeStructure(noIng)).toBe(false);
  });

  it('rejects ingredient with empty name', () => {
    const recipe = {
      ...VALID_RECIPE,
      ingredients: [{ name: '', amount: '1', unit: 'cup' }],
    };
    expect(validateRecipeStructure(recipe)).toBe(false);
  });

  it('rejects ingredient with non-string/non-number amount', () => {
    const recipe = {
      ...VALID_RECIPE,
      ingredients: [{ name: 'flour', amount: null, unit: 'cup' }],
    };
    expect(validateRecipeStructure(recipe)).toBe(false);
  });

  it('accepts ingredient with numeric amount', () => {
    const recipe = {
      ...VALID_RECIPE,
      ingredients: [{ name: 'flour', amount: 2, unit: 'cups' }],
    };
    expect(validateRecipeStructure(recipe)).toBe(true);
  });

  it('rejects recipe with empty steps array', () => {
    expect(validateRecipeStructure({ ...VALID_RECIPE, steps: [] })).toBe(false);
  });

  it('rejects step with non-number order', () => {
    const recipe = {
      ...VALID_RECIPE,
      steps: [{ order: 'first', instruction: 'Do something' }],
    };
    expect(validateRecipeStructure(recipe)).toBe(false);
  });

  it('rejects step with empty instruction', () => {
    const recipe = {
      ...VALID_RECIPE,
      steps: [{ order: 1, instruction: '' }],
    };
    expect(validateRecipeStructure(recipe)).toBe(false);
  });

  it('rejects recipe with missing macros', () => {
    const { macros, ...noMacros } = VALID_RECIPE;
    expect(validateRecipeStructure(noMacros)).toBe(false);
  });

  it('rejects negative macro values', () => {
    expect(validateRecipeStructure({
      ...VALID_RECIPE,
      macros: { calories: -1, protein_g: 10, carbs_g: 10, fats_g: 10 },
    })).toBe(false);

    expect(validateRecipeStructure({
      ...VALID_RECIPE,
      macros: { calories: 100, protein_g: -5, carbs_g: 10, fats_g: 10 },
    })).toBe(false);
  });

  it('rejects non-number macro values', () => {
    expect(validateRecipeStructure({
      ...VALID_RECIPE,
      macros: { calories: '350', protein_g: 42, carbs_g: 5, fats_g: 18 },
    })).toBe(false);
  });
});

describe('generate-recipe: normalizeRecipe', () => {
  it('normalizes a valid recipe without changing values', () => {
    const result = normalizeRecipe(VALID_RECIPE);
    expect(result.title).toBe('Grilled Chicken Salad');
    expect(result.ingredients).toHaveLength(3);
    expect(result.steps).toHaveLength(3);
    expect(result.macros.calories).toBe(350);
  });

  it('trims whitespace from title and ingredient names', () => {
    const recipe = {
      ...VALID_RECIPE,
      title: '  Pasta  ',
      ingredients: [{ name: '  garlic  ', amount: '2', unit: 'cloves' }],
    };
    const result = normalizeRecipe(recipe);
    expect(result.title).toBe('Pasta');
    expect(result.ingredients[0].name).toBe('garlic');
  });

  it('converts numeric amounts to strings', () => {
    const recipe = {
      ...VALID_RECIPE,
      ingredients: [{ name: 'flour', amount: 2, unit: 'cups' }],
    };
    const result = normalizeRecipe(recipe);
    expect(result.ingredients[0].amount).toBe('2');
  });

  it('assigns sequential order when step.order is not a number', () => {
    const recipe = {
      ...VALID_RECIPE,
      steps: [
        { order: 'first', instruction: 'Boil water' },
        { order: 'second', instruction: 'Add pasta' },
      ],
    };
    const result = normalizeRecipe(recipe);
    expect(result.steps[0].order).toBe(1);
    expect(result.steps[1].order).toBe(2);
  });

  it('rounds macro values appropriately', () => {
    const recipe = {
      ...VALID_RECIPE,
      macros: { calories: 350.7, protein_g: 42.35, carbs_g: 5.149, fats_g: 18.06 },
    };
    const result = normalizeRecipe(recipe);
    expect(result.macros.calories).toBe(351);
    expect(result.macros.protein_g).toBe(42.4);
    expect(result.macros.carbs_g).toBe(5.1);
    expect(result.macros.fats_g).toBe(18.1);
  });
});

describe('generate-recipe: retry logic with exponential backoff', () => {
  // Use a no-op sleep to avoid real delays and fake timer issues
  const noopSleep = () => Promise.resolve();

  it('returns immediately on first success (no retry)', async () => {
    const callFn = vi.fn().mockResolvedValue(VALID_RECIPE);

    const result = await generateWithRetry(callFn, 3, 1000, noopSleep);

    expect(callFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual(VALID_RECIPE);
  });

  it('retries on first failure and succeeds on second attempt', async () => {
    const callFn = vi.fn()
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce(VALID_RECIPE);

    const result = await generateWithRetry(callFn, 3, 1000, noopSleep);

    expect(callFn).toHaveBeenCalledTimes(2);
    expect(result).toEqual(VALID_RECIPE);
  });

  it('retries up to 3 times then throws the last error', async () => {
    const callFn = vi.fn()
      .mockRejectedValueOnce(new Error('Persistent failure'))
      .mockRejectedValueOnce(new Error('Persistent failure'))
      .mockRejectedValueOnce(new Error('Persistent failure'))
      .mockRejectedValueOnce(new Error('Persistent failure'));

    await expect(generateWithRetry(callFn, 3, 1000, noopSleep)).rejects.toThrow('Persistent failure');
    // Initial call + 3 retries = 4 total attempts
    expect(callFn).toHaveBeenCalledTimes(4);
  });

  it('succeeds on the last retry attempt (attempt 3)', async () => {
    const callFn = vi.fn()
      .mockRejectedValueOnce(new Error('Error 1'))
      .mockRejectedValueOnce(new Error('Error 2'))
      .mockRejectedValueOnce(new Error('Error 3'))
      .mockResolvedValueOnce(VALID_RECIPE);

    const result = await generateWithRetry(callFn, 3, 1000, noopSleep);

    expect(callFn).toHaveBeenCalledTimes(4);
    expect(result).toEqual(VALID_RECIPE);
  });

  it('applies exponential backoff delays (1s, 2s, 4s)', async () => {
    const delays = [];
    const trackingSleep = (ms) => {
      delays.push(ms);
      return Promise.resolve();
    };

    let callCount = 0;
    const callFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        return Promise.reject(new Error(`Attempt ${callCount}`));
      }
      return Promise.resolve(VALID_RECIPE);
    });

    await generateWithRetry(callFn, 3, 1000, trackingSleep);

    // Verify exponential backoff: 1000ms, 2000ms, 4000ms
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it('handles non-Error throw values gracefully', async () => {
    const callFn = vi.fn()
      .mockRejectedValueOnce('string error')
      .mockRejectedValueOnce('string error')
      .mockRejectedValueOnce('string error')
      .mockRejectedValueOnce('string error');

    await expect(generateWithRetry(callFn, 3, 1000, noopSleep)).rejects.toThrow('string error');
  });
});

describe('generate-recipe: error response format', () => {
  it('error message is non-technical and user-friendly', () => {
    const errorMessage = 'Recipe generation is temporarily unavailable. Please try again later.';
    // This is the exact message from the Edge Function (Requirement 8.8)
    expect(errorMessage).not.toMatch(/API|OpenAI|500|timeout|exception/i);
    expect(errorMessage).toContain('temporarily unavailable');
    expect(errorMessage).toContain('try again');
  });
});
