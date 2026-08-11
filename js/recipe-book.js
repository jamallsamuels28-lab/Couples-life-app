// ============================================================
// Recipe Book — Couples Life App
// Save, browse, filter, and favorite recipes in the shared book.
// ============================================================

import { supabase } from './supabase-client.js';
import { getCurrentUser } from './app-shell.js';

// --- Constants ---

export const VALID_MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

// --- Favourites (per-person, public.recipe_favorites) ---
//
// These used to live in localStorage. That made them per-browser rather than
// per-person: starring a recipe on the laptop left it unstarred on the phone,
// and clearing site data wiped them. They are rows now.
//
// A synchronous cache sits in front of the table because rendering a card must
// know the starred state without awaiting anything. fetchFavorites() fills it;
// the render path only ever reads getFavorites().

let favoritesCache = new Set();
let favoritesCacheUserId = null;

/**
 * Loads this user's favourites from the database into the cache.
 * @returns {Promise<Set<string>>}
 */
export async function fetchFavorites(userId) {
  if (!userId) {
    favoritesCache = new Set();
    favoritesCacheUserId = null;
    return favoritesCache;
  }

  const { data, error } = await supabase
    .from('recipe_favorites').select('recipe_id').eq('user_id', userId);

  // On failure keep whatever is cached rather than silently showing everything
  // as unfavourited, which would invite the user to re-star what is already
  // starred and looks like data loss.
  if (error) return favoritesCache;

  favoritesCache = new Set((data || []).map(row => row.recipe_id));
  favoritesCacheUserId = userId;
  return favoritesCache;
}

/** The cached favourites, for synchronous render paths. */
export function getFavorites() {
  return favoritesCache;
}

/** Drops the cache — used on sign-out so one person's stars cannot leak. */
export function clearFavoritesCache() {
  favoritesCache = new Set();
  favoritesCacheUserId = null;
}

/**
 * Check if the current user has favorited a recipe.
 */
export function isFavorite(recipeId) {
  return favoritesCache.has(recipeId);
}

/**
 * Toggle favourite status for the current user on a recipe.
 *
 * The cache is updated first so the star responds immediately, and rolled back
 * if the write fails — a star that flips back is honest about not having saved.
 *
 * @returns {Promise<{success: boolean, favorite: boolean}>}
 */
export async function toggleFavorite(recipeId) {
  const user = getCurrentUser();
  if (!user || !recipeId) return { success: false, favorite: isFavorite(recipeId) };

  if (favoritesCacheUserId !== user.id) await fetchFavorites(user.id);

  const wasFavorite = favoritesCache.has(recipeId);
  const nowFavorite = !wasFavorite;

  if (nowFavorite) favoritesCache.add(recipeId);
  else favoritesCache.delete(recipeId);

  const { error } = nowFavorite
    // The primary key makes this idempotent, so a double tap is harmless.
    ? await supabase.from('recipe_favorites')
        .upsert({ user_id: user.id, recipe_id: recipeId }, { onConflict: 'user_id,recipe_id' })
    : await supabase.from('recipe_favorites')
        .delete().eq('user_id', user.id).eq('recipe_id', recipeId);

  if (error) {
    if (wasFavorite) favoritesCache.add(recipeId);
    else favoritesCache.delete(recipeId);
    return { success: false, favorite: wasFavorite };
  }

  return { success: true, favorite: nowFavorite };
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

  // Applied client-side against the cached favourites.
  if (filters.favoritesOnly) {
    const favorites = getFavorites();
    recipes = recipes.filter(r => favorites.has(r.id));
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
  const favorites = getFavorites();

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

  // The working copy, so a deleted recipe disappears without a round trip.
  let currentRecipes = recipes;

  function applyFilters() {
    const filters = {
      tags: tagFilter.value ? [tagFilter.value] : [],
      meal_type: mealTypeFilter.value || null,
      favoritesOnly: favFilter.checked,
    };

    const currentFavorites = getFavorites();
    const filtered = filterRecipes(currentRecipes, filters, currentFavorites);
    recipeList.innerHTML = renderRecipeCards(filtered, currentFavorites);
    attachFavoriteHandlers(recipeList, currentRecipes, currentFavorites, () => applyFilters());
    attachDeleteHandlers(recipeList, onRecipeDeleted);
  }

  function onRecipeDeleted(recipeId) {
    currentRecipes = currentRecipes.filter(r => r.id !== recipeId);
    applyFilters();
  }

  tagFilter.addEventListener('change', applyFilters);
  mealTypeFilter.addEventListener('change', applyFilters);
  favFilter.addEventListener('change', applyFilters);

  // Attach favorite and delete button handlers
  attachFavoriteHandlers(recipeList, currentRecipes, favorites, () => applyFilters());
  attachDeleteHandlers(recipeList, onRecipeDeleted);
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
          <button class="btn btn-ghost btn-sm recipe-delete-btn"
            data-recipe-id="${recipe.id}"
            data-recipe-title="${escapeHtml(recipe.title)}"
            aria-label="Delete ${escapeHtml(recipe.title)}">
            <svg class="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/>
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
    btn.addEventListener('click', async () => {
      const recipeId = btn.getAttribute('data-recipe-id');
      btn.disabled = true;
      await toggleFavorite(recipeId);
      btn.disabled = false;
      // Re-renders either way: on failure toggleFavorite has already rolled
      // the cache back, so the star returns to its true state rather than
      // showing a change that never reached the database.
      if (onToggle) onToggle();
    });
  });
}

/**
 * Deletes a recipe from the shared book.
 *
 * The recipe book had no delete at all, so a generated recipe nobody liked
 * stayed in the list for good. RLS allows either partner to delete (the book
 * is shared by design), so this does not filter on created_by.
 *
 * @param {string} recipeId
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteRecipe(recipeId) {
  if (!recipeId) return { success: false, error: 'No recipe given.' };

  const user = getCurrentUser();
  if (!user) return { success: false, error: 'You must be signed in to delete a recipe.' };

  const { error } = await supabase.from('recipes').delete().eq('id', recipeId);
  if (error) return { success: false, error: 'Could not delete that recipe.' };

  // The favourites row goes with it via the recipe_id foreign key's cascade;
  // this just keeps the in-memory cache honest without a refetch.
  getFavorites().delete(recipeId);

  return { success: true };
}

/**
 * Attaches delete handlers to the recipe cards in a container.
 * @param {HTMLElement} listEl
 * @param {() => void} onDeleted
 */
export function attachDeleteHandlers(listEl, onDeleted) {
  listEl.querySelectorAll('.recipe-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const recipeId = btn.getAttribute('data-recipe-id');
      const title = btn.getAttribute('data-recipe-title') || 'this recipe';
      // Shared book, no undo — so it asks.
      if (!window.confirm(`Delete “${title}” from the recipe book?`)) return;

      btn.disabled = true;
      const result = await deleteRecipe(recipeId);
      if (!result.success) {
        btn.disabled = false;
        return;
      }
      if (onDeleted) onDeleted(recipeId);
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
    // Favourites first: renderRecipeBook reads them synchronously from the
    // cache, so fetching after would paint every star as empty on first load.
    await fetchFavorites(user.id);

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
