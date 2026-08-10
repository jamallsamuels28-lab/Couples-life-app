// ============================================================
// Recipe Generator — Couples Life App
// Client-side recipe generation flow: merges dietary preferences,
// builds prompt, calls Edge Function, validates result.
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 8.9, 8.10, 10.3
// ============================================================

import { supabase } from './supabase-client.js';
import { getCurrentUser, getPartner } from './app-shell.js';
import { getBothPreferences } from './dietary-preferences.js';
import { fetchValidPantryItems } from './pantry-module.js';

// --- Constants ---

/**
 * Diet type hierarchy from most restrictive to least.
 * Leftmost wins when selecting between two partners' types.
 * Requirement 8.3
 */
export const DIET_HIERARCHY = ['vegan', 'vegetarian', 'halal', 'keto', 'flexible'];

/**
 * Ingredients that violate each diet type.
 * Used for post-generation validation (Requirement 8.7).
 */
export const DIET_RESTRICTIONS = {
  vegan: [
    'meat', 'chicken', 'beef', 'pork', 'lamb', 'fish', 'salmon', 'tuna', 'shrimp', 'prawn',
    'egg', 'eggs', 'dairy', 'milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt',
    'honey', 'gelatin', 'lard', 'whey', 'casein', 'ghee',
  ],
  vegetarian: [
    'meat', 'chicken', 'beef', 'pork', 'lamb', 'fish', 'salmon', 'tuna', 'shrimp', 'prawn',
    'gelatin', 'lard', 'anchovy', 'anchovies',
  ],
  halal: [
    'pork', 'bacon', 'ham', 'lard', 'gelatin', 'alcohol', 'wine', 'beer', 'rum',
  ],
  keto: [], // Keto is about macros, not specific ingredient bans — validated via macros if needed
  flexible: [], // No restrictions
};

// --- Pure Logic Functions ---

/**
 * Merge both partners' allergies into a combined exclusion list (union).
 * Handles null/undefined preferences gracefully.
 * Requirement 8.2, 10.3
 *
 * @param {object|null} prefsA - First partner's preferences (or null)
 * @param {object|null} prefsB - Second partner's preferences (or null)
 * @returns {string[]} - Deduplicated union of allergies (case-insensitive, lowercase)
 */
export function mergeAllergies(prefsA, prefsB) {
  const allergiesA = (prefsA && Array.isArray(prefsA.allergies)) ? prefsA.allergies : [];
  const allergiesB = (prefsB && Array.isArray(prefsB.allergies)) ? prefsB.allergies : [];

  const combined = new Set([
    ...allergiesA.map(a => a.toLowerCase().trim()),
    ...allergiesB.map(a => a.toLowerCase().trim()),
  ]);

  // Remove empty strings that may result from trim
  combined.delete('');

  return [...combined];
}

/**
 * Select the more restrictive diet type between two partners.
 * Uses the hierarchy: vegan > vegetarian > halal > keto > flexible
 * The type that appears earlier (lower index) in the hierarchy wins.
 * Treats missing/invalid types as 'flexible'.
 * Requirement 8.3
 *
 * @param {string|null|undefined} typeA - First partner's diet type
 * @param {string|null|undefined} typeB - Second partner's diet type
 * @returns {string} - The more restrictive diet type
 */
export function selectDietType(typeA, typeB) {
  const normalizedA = DIET_HIERARCHY.includes(typeA) ? typeA : 'flexible';
  const normalizedB = DIET_HIERARCHY.includes(typeB) ? typeB : 'flexible';

  const indexA = DIET_HIERARCHY.indexOf(normalizedA);
  const indexB = DIET_HIERARCHY.indexOf(normalizedB);

  // Lower index = more restrictive
  return indexA <= indexB ? normalizedA : normalizedB;
}

/**
 * Build the prompt string for the Edge Function.
 * Includes merged preferences and pantry items context.
 * Requirements 8.1, 8.2, 8.3, 8.4
 *
 * @param {object} preferences - Merged preferences: { allergies: string[], dislikes: string[], dietType: string }
 * @param {object[]} pantryItems - Non-expired pantry items with { name, category, quantity }
 * @param {object} constraints - Optional: { mealType?, maxPrepTime?, maxCalories?, servings? }
 * @returns {string} - The formatted prompt
 */
export function buildRecipePrompt(preferences, pantryItems, constraints = {}) {
  const parts = [];

  // Opening instruction
  parts.push('Generate a recipe with the following requirements:');

  // Diet type
  if (preferences.dietType && preferences.dietType !== 'flexible') {
    parts.push(`Diet type: ${preferences.dietType}. The recipe MUST strictly follow ${preferences.dietType} dietary rules.`);
  }

  // Allergies (exclusion list)
  if (preferences.allergies && preferences.allergies.length > 0) {
    parts.push(`ALLERGENS TO EXCLUDE (do NOT use any of these ingredients): ${preferences.allergies.join(', ')}.`);
  }

  // Dislikes
  if (preferences.dislikes && preferences.dislikes.length > 0) {
    parts.push(`Disliked ingredients (avoid if possible): ${preferences.dislikes.join(', ')}.`);
  }

  // Pantry items as preferred ingredients
  if (pantryItems && pantryItems.length > 0) {
    const pantryNames = pantryItems.map(item => item.name);
    parts.push(`Preferred ingredients from pantry (use these when possible, but you may include additional ingredients): ${pantryNames.join(', ')}.`);
  }

  // Constraints
  if (constraints.mealType) {
    parts.push(`Meal type: ${constraints.mealType}.`);
  }
  if (constraints.maxPrepTime) {
    parts.push(`Maximum preparation time: ${constraints.maxPrepTime} minutes.`);
  }
  if (constraints.maxCalories) {
    parts.push(`Maximum calories per serving: ${constraints.maxCalories}.`);
  }
  if (constraints.servings) {
    parts.push(`Number of servings: ${constraints.servings}.`);
  }

  return parts.join('\n');
}

/**
 * Validate a generated recipe against the allergen list and diet type.
 * Returns { valid: boolean, reason?: string }
 * Requirements 8.6, 8.7, 8.10
 *
 * @param {object} recipe - Generated recipe with ingredients[].name
 * @param {string[]} allergies - Combined allergen exclusion list (lowercase)
 * @param {string} dietType - The selected diet type
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateRecipeAgainstDiet(recipe, allergies, dietType) {
  if (!recipe || !Array.isArray(recipe.ingredients)) {
    return { valid: false, reason: 'Invalid recipe structure: missing ingredients' };
  }

  // Check each ingredient against allergen list
  for (const ingredient of recipe.ingredients) {
    const ingredientName = (ingredient.name || '').toLowerCase().trim();
    for (const allergen of allergies) {
      if (ingredientName.includes(allergen) || allergen.includes(ingredientName)) {
        return {
          valid: false,
          reason: `Recipe contains allergen "${allergen}" in ingredient "${ingredient.name}"`,
        };
      }
    }
  }

  // Check ingredient against diet type restrictions
  const restrictions = DIET_RESTRICTIONS[dietType] || [];
  if (restrictions.length > 0) {
    for (const ingredient of recipe.ingredients) {
      const ingredientName = (ingredient.name || '').toLowerCase().trim();
      for (const restricted of restrictions) {
        if (ingredientName.includes(restricted)) {
          return {
            valid: false,
            reason: `Recipe ingredient "${ingredient.name}" violates ${dietType} diet (contains "${restricted}")`,
          };
        }
      }
    }
  }

  return { valid: true };
}

// --- Main Orchestration ---

/**
 * Generate a recipe by orchestrating the full flow:
 * 1. Fetch both partners' dietary preferences
 * 2. Fetch non-expired pantry items
 * 3. Merge allergies and select restrictive diet type
 * 4. Build prompt and call the Edge Function
 * 5. Validate the response
 * 6. Return the recipe or error
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 8.9, 8.10
 *
 * @param {object} constraints - Optional: { mealType?, maxPrepTime?, maxCalories?, servings? }
 * @returns {Promise<{ success: boolean, recipe?: object, error?: string }>}
 */
export async function generateRecipe(constraints = {}) {
  try {
    // 1. Fetch both partners' dietary preferences
    let userPrefs = null;
    let partnerPrefs = null;

    try {
      const bothPrefs = await getBothPreferences();
      userPrefs = bothPrefs.user;
      partnerPrefs = bothPrefs.partner;
    } catch {
      // Requirement 8.9: treat missing preferences as no allergies/dislikes + flexible
      userPrefs = null;
      partnerPrefs = null;
    }

    // 2. Fetch non-expired pantry items
    let pantryItems = [];
    try {
      const pantryResult = await fetchValidPantryItems();
      if (pantryResult.success) {
        pantryItems = pantryResult.data;
      }
    } catch {
      // Pantry fetch failure is non-fatal; proceed without pantry context
      pantryItems = [];
    }

    // 3. Merge allergies and select restrictive diet type
    const allergies = mergeAllergies(userPrefs, partnerPrefs);
    const dietType = selectDietType(
      userPrefs?.diet_type,
      partnerPrefs?.diet_type
    );

    // Also merge dislikes for the prompt
    const dislikesA = (userPrefs && Array.isArray(userPrefs.dislikes)) ? userPrefs.dislikes : [];
    const dislikesB = (partnerPrefs && Array.isArray(partnerPrefs.dislikes)) ? partnerPrefs.dislikes : [];
    const dislikes = [...new Set([
      ...dislikesA.map(d => d.toLowerCase().trim()),
      ...dislikesB.map(d => d.toLowerCase().trim()),
    ])].filter(Boolean);

    // 4. Build prompt
    const preferences = { allergies, dislikes, dietType };
    const prompt = buildRecipePrompt(preferences, pantryItems, constraints);

    // 5. Call the Edge Function
    //
    // Allergies and diet go as structured fields as well as inside the prompt.
    // The function needs them separately to state the allergy constraint in its
    // own words, and the remaining macros are passed so it can aim at them and
    // score the fit afterwards (§2.4).
    const { data, error } = await supabase.functions.invoke('generate-recipe', {
      body: {
        prompt,
        allergies,
        dislikes,
        dietType,
        pantry: pantryItems.map(item => item.name).filter(Boolean),
        constraints,
        remainingMacros: constraints.remainingMacros || null,
      },
    });

    if (error) {
      // Distinguish "not deployed" from "broken", because the fix is entirely
      // different and the generic message sent us looking in the wrong place.
      const status = error.context?.status;
      if (status === 404) {
        return {
          success: false,
          error: 'The recipe function is not deployed yet. Supabase dashboard → Edge Functions → Deploy a new function → Via Editor, named generate-recipe.',
        };
      }
      return {
        success: false,
        error: `Recipe generation failed${status ? ` (${status})` : ''}. ${error.message || 'Please try again later.'}`,
      };
    }

    if (data?.error) {
      return { success: false, error: data.error };
    }

    const recipe = data?.recipe;
    if (!recipe) {
      return { success: false, error: 'No recipe was returned. Please try again.' };
    }

    // 6. Validate the recipe against allergens and diet type (Requirement 8.6, 8.7, 8.10)
    const validation = validateRecipeAgainstDiet(recipe, allergies, dietType);
    if (!validation.valid) {
      return {
        success: false,
        error: 'The generated recipe did not meet dietary safety requirements. Please try again.',
      };
    }

    return { success: true, recipe, warning: data?.warning || null };
  } catch (err) {
    return {
      success: false,
      error: 'An unexpected error occurred during recipe generation. Please try again.',
    };
  }
}
