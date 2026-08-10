// ============================================================
// Recipe Book — Couples Life App
// Save, browse, filter, and favorite recipes in the shared book.
// ============================================================

import { supabase } from './supabase-client.js';
import { getCurrentUser } from './app-shell.js';

// --- Constants ---

export const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];
const FAVORITES_STORAGE_KEY = 'recipe_favorites_';

// --- Favorites (per-user, localStorage) ---

/**
 * Get the localStorage key for a user's favorites set.
 */
function getFavoritesKey(userId) {
  return `${FAVORITES_STORAGE_KEY}${userId}`;
}

/**
 * Load the set of favorited recipe IDs for a given user.
 * Returns a Set of recipe IDs.
 */
export function loadFavorites(userId) {
  try {
    const raw = localStorage.getItem(getFavoritesKey(userId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

/**
 * Persist the favorites set for a given user to localStorage.
 */
function saveFavorites(userId, favoritesSet) {
  localStorage.setItem(getFavoritesKey(userId), JSON.stringify([...favoritesSet]));
}

/**
 * Check if the current user has favorited a recipe.
 */
export function isFavorite(recipeId) {
  const user = getCurrentUser();
  if (!user) return false;
  const favorites = loadFavorites(user.id);
  return favorites.has(recipeId);
}

/**
 * Toggle favorite status for the current user on a recipe.
 * Returns the new favorite state (true = favorited, false = unfavorited).
 */
export function toggleFavorite(recipeId) {
  const user = getCurrentUser();
  if (!user) return false;

  const favorites = loadFavorites(user.id);
  let nowFavorite;

  if (favorites.has(recipeId)) {
    favorites.delete(recipeId);
    nowFavorite = false;
  } else {
    favorites.add(recipeId);
    nowFavorite = true;
  }

  saveFavorites(user.id, favorites);
  return nowFavorite;
}

// --- Data Access ---

/**
 * Save a recipe to the shared recipe book.
 * recipeData should include: title, ingredients, steps, calories, protein_g, carbs_g, fats_g,
 * meal_type (optional), tags (optional), description, prep_time_min, cook_time_min, servings, ai_generated.
 * Returns { success: boolean, data?, error? }
 */
export async function saveRecipe(recipeData) {
  const user = getCurrentUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  const record = {
    created_by: user.id,
    title: recipeData.title || '',
    description: recipeData.description || null,
    ingredients: recipeData.ingredients || [],
    steps: recipeData.steps || [],
    prep_time_min: recipeData.prep_time_min || null,
    cook_time_min: recipeData.cook_time_min || null,
    servings: recipeData.servings || 2,
    calories: recipeData.calories || null,
    protein_g: recipeData.protein_g || null,
    carbs_g: recipeData.carbs_g || null,
    fats_g: recipeData.fats_g || null,
    tags: Array.isArray(recipeData.tags) ? recipeData.tags : [],
    ai_generated: recipeData.ai_generated || false,
  };

  const { data, error } = await supabase
    .from('recipes')
    .insert(record)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data };
}

/**
 * Fetch all recipes from the shared recipe book.
 * Supports filtering by:
 *   - tags: string[] — recipe must contain at least one of the specified tags
 *   - meal_type: string — exact match
 *   - favoritesOnly: boolean — only recipes favorited by the current user
 *
 * Results are sorted by created_at DESC (most recently saved first).
 * Returns { success: boolean, data?: Recipe[], error?: string }
 */
export async function fetchRecipeBook(filters = {}) {
  let query = supabase
    .from('recipes')
    .select('*')
    .order('created_at', { ascending: false });

  // Filter by meal_type if provided (stored in tags or as a field)
  // The schema doesn't have a dedicated meal_type column on recipes,
  // but the task says "meal type" — we'll use the tags array to store meal_type as well.
  // Actually, looking at schema again, there's no meal_type column on recipes.
  // We'll treat meal_type filtering as a tag filter with a convention:
  // recipes can include meal_type in their tags array.
  // BUT the task says "meal type" as a separate concept. Let's use tags overlap for this.

  // Apply tag-based filters at DB level using Postgres array overlap
  if (filters.tags && filters.tags.length > 0) {
    query = query.overlaps('tags', filters.tags);
  }

  const { data, error } = await query;

  if (error) {
    return { success: false, error: error.message };
  }

  let recipes = data || [];

  // Apply meal_type filter client-side (check if meal_type tag is present)
  if (filters.meal_type) {
    recipes = recipes.filter(r =>
      Array.isArray(r.tags) && r.tags.includes(filters.meal_type)
    );
  }

  // Apply favorites filter client-side (localStorage-based)
  if (filters.favoritesOnly) {
    const user = getCurrentUser();
    if (user) {
      const favorites = loadFavorites(user.id);
      recipes = recipes.filter(r => favorites.has(r.id));
    }
  }

  return { success: true, data: recipes };
}

// --- Pure Filter Logic (exported for unit testing) ---

/**
 * Apply filters to a list of recipes (pure function, no DB or localStorage dependency).
 * filters:
 *   - tags: string[] — recipe must have at least one matching tag
 *   - meal_type: string — recipe tags must include this meal type
 *   - favoritesOnly: boolean — only include recipes whose id is in the favoritesSet
 * favoritesSet: Set<string> — the current user's favorite recipe IDs
 *
 * Returns filtered array, preserving original order.
 */
export function filterRecipes(recipes, filters = {}, favoritesSet = new Set()) {
  let result = [...recipes];

  // Filter by tags (recipe must contain at least one of the specified tags)
  if (filters.tags && filters.tags.length > 0) {
    result = result.filter(r =>
      Array.isArray(r.tags) && filters.tags.some(tag => r.tags.includes(tag))
    );
  }

  // Filter by meal_type (stored as a tag in the recipe's tags array)
  if (filters.meal_type) {
    result = result.filter(r =>
      Array.isArray(r.tags) && r.tags.includes(filters.meal_type)
    );
  }

  // Filter by favorites only
  if (filters.favoritesOnly) {
    result = result.filter(r => favoritesSet.has(r.id));
  }

  return result;
}

/**
 * Sort recipes by created_at descending (most recently saved first).
 * Accepts an array of recipe objects with a created_at field.
 */
export function sortRecipesByDate(recipes) {
  return [...recipes].sort((a, b) => {
    const dateA = new Date(a.created_at);
    const dateB = new Date(b.created_at);
    return dateB - dateA;
  });
}

// --- UI Rendering ---

/**
 * Render the recipe book UI into a container element.
 * Shows filter controls and recipe cards.
 */
export function renderRecipeBook(container, recipes = [], allTags = []) {
  const user = getCurrentUser();
  const favorites = user ? loadFavorites(user.id) : new Set();

  container.innerHTML = `
    <section class="card recipe-book-section" aria-label="Recipe Book">
      <div class="card-header">
        <h3 class="card-title">Recipe Book</h3>
      </div>
      <div class="card-body">
        <!-- Filters -->
        <div class="recipe-filters flex gap-3 items-center" role="group" aria-label="Recipe filters">
          <div class="input-group">
            <label class="input-label" for="recipe-tag-filter">Tags</label>
            <select id="recipe-tag-filter" class="input" aria-label="Filter by tag">
              <option value="">All tags</option>
              ${allTags.map(tag => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join('')}
            </select>
          </div>
          <div class="input-group">
            <label class="input-label" for="recipe-meal-type-filter">Meal Type</label>
            <select id="recipe-meal-type-filter" class="input" aria-label="Filter by meal type">
              <option value="">All types</option>
              ${VALID_MEAL_TYPES.map(type => `<option value="${type}">${type.charAt(0).toUpperCase() + type.slice(1)}</option>`).join('')}
            </select>
          </div>
          <div class="input-group">
            <label class="input-label flex items-center gap-2">
              <input type="checkbox" id="recipe-fav-filter" aria-label="Show favorites only">
              Favorites only
            </label>
          </div>
        </div>

        <!-- Recipe List -->
        <div id="recipe-list" class="recipe-list flex-col gap-3" aria-live="polite">
          ${renderRecipeCards(recipes, favorites)}
        </div>
      </div>
    </section>
  `;

  // --- Filter event listeners ---
  const tagFilter = container.querySelector('#recipe-tag-filter');
  const mealTypeFilter = container.querySelector('#recipe-meal-type-filter');
  const favFilter = container.querySelector('#recipe-fav-filter');
  const recipeList = container.querySelector('#recipe-list');

  function applyFilters() {
    const filters = {
      tags: tagFilter.value ? [tagFilter.value] : [],
      meal_type: mealTypeFilter.value || null,
      favoritesOnly: favFilter.checked,
    };

    const currentFavorites = user ? loadFavorites(user.id) : new Set();
    const filtered = filterRecipes(recipes, filters, currentFavorites);
    recipeList.innerHTML = renderRecipeCards(filtered, currentFavorites);
    attachFavoriteHandlers(recipeList, recipes, currentFavorites, () => applyFilters());
  }

  tagFilter.addEventListener('change', applyFilters);
  mealTypeFilter.addEventListener('change', applyFilters);
  favFilter.addEventListener('change', applyFilters);

  // Attach favorite button handlers
  attachFavoriteHandlers(recipeList, recipes, favorites, () => applyFilters());
}

/**
 * Render recipe cards HTML.
 */
function renderRecipeCards(recipes, favoritesSet) {
  if (!recipes || recipes.length === 0) {
    return '<p class="text-muted text-sm">No recipes found.</p>';
  }

  return recipes.map(recipe => {
    const isFav = favoritesSet.has(recipe.id);
    const macroDisplay = [
      recipe.calories != null ? `${recipe.calories} kcal` : null,
      recipe.protein_g != null ? `${recipe.protein_g}g protein` : null,
      recipe.carbs_g != null ? `${recipe.carbs_g}g carbs` : null,
      recipe.fats_g != null ? `${recipe.fats_g}g fats` : null,
    ].filter(Boolean).join(' · ');

    const tagsHtml = (recipe.tags || []).map(tag =>
      `<span class="badge">${escapeHtml(tag)}</span>`
    ).join('');

    return `
      <div class="card recipe-card shared-item" data-recipe-id="${recipe.id}">
        <div class="card-header">
          <h4 class="card-title">${escapeHtml(recipe.title)}</h4>
          <button class="btn btn-ghost btn-sm recipe-fav-btn" data-recipe-id="${recipe.id}" aria-label="${isFav ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${isFav}">
            <svg class="icon" viewBox="0 0 20 20" fill="${isFav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.5">
              <path d="M10 15.27L4.12 18l1.12-6.53L1 7.24l6.56-.95L10 1l2.44 6.29 6.56.95-4.24 4.23L15.88 18z"/>
            </svg>
          </button>
        </div>
        ${macroDisplay ? `<p class="text-sm input-num">${macroDisplay}</p>` : ''}
        ${tagsHtml ? `<div class="flex gap-1 mt-2">${tagsHtml}</div>` : ''}
      </div>
    `;
  }).join('');
}

/**
 * Attach click handlers to favorite buttons within a recipe list container.
 */
function attachFavoriteHandlers(listEl, allRecipes, favoritesSet, onToggle) {
  listEl.querySelectorAll('.recipe-fav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const recipeId = btn.getAttribute('data-recipe-id');
      toggleFavorite(recipeId);
      if (onToggle) onToggle();
    });
  });
}

/**
 * Extract all unique tags from a list of recipes.
 */
export function extractAllTags(recipes) {
  const tagSet = new Set();
  for (const recipe of recipes) {
    if (Array.isArray(recipe.tags)) {
      recipe.tags.forEach(tag => tagSet.add(tag));
    }
  }
  return [...tagSet].sort();
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Initialize the recipe book section.
 * Fetches recipes from the database and renders the UI.
 */
export async function initRecipeBook(container) {
  const user = getCurrentUser();
  if (!user) return;

  try {
    const result = await fetchRecipeBook();
    if (result.success) {
      const recipes = sortRecipesByDate(result.data);
      const allTags = extractAllTags(recipes);
      renderRecipeBook(container, recipes, allTags);
    } else {
      container.innerHTML = `
        <div class="card">
          <p class="input-error-msg">Failed to load recipe book. Please try again.</p>
        </div>
      `;
    }
  } catch (err) {
    container.innerHTML = `
      <div class="card">
        <p class="input-error-msg">Failed to load recipe book. Please try again.</p>
      </div>
    `;
  }
}
