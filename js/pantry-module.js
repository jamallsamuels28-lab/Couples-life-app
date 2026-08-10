// ============================================================
// Pantry Module — Couples Life App
// Shared pantry management: add, update, remove, filter expired.
// ============================================================

import { supabase } from './supabase-client.js';
import { getCurrentUser } from './app-shell.js';

// --- Constants ---

export const PANTRY_CATEGORIES = [
  'protein',
  'vegetable',
  'grain',
  'dairy',
  'spice',
  'other',
];

// --- Validation ---

/**
 * Validate pantry item data (client-side).
 * Returns { valid: boolean, errors: { name?: string } }
 */
export function validatePantryItem(data) {
  const errors = {};

  const name = data && data.name != null ? String(data.name) : '';
  const trimmed = name.trim();

  if (!trimmed) {
    errors.name = 'Item name is required';
  } else if (trimmed.length > 100) {
    errors.name = 'Item name must be 100 characters or fewer';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

// --- Data Access ---

/**
 * Add a new pantry item.
 * itemData: { name, category?, quantity?, expires_at? }
 * Returns { success: boolean, data?, error? }
 */
export async function addPantryItem(itemData) {
  const user = getCurrentUser();
  if (!user) {
    return { success: false, error: 'Not authenticated' };
  }

  // Validate
  const validation = validatePantryItem(itemData);
  if (!validation.valid) {
    return { success: false, error: validation.errors.name, validationErrors: validation.errors };
  }

  const record = {
    name: itemData.name.trim(),
    category: PANTRY_CATEGORIES.includes(itemData.category) ? itemData.category : 'other',
    quantity: itemData.quantity || null,
    expires_at: itemData.expires_at || null,
    added_by: user.id,
  };

  const { data, error } = await supabase
    .from('pantry_items')
    .insert(record)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data };
}

/**
 * Fetch all pantry items (shared between both partners).
 * Returns { success: boolean, data?: PantryItem[], error?: string }
 */
export async function fetchPantryItems() {
  const { data, error } = await supabase
    .from('pantry_items')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: data || [] };
}

/**
 * Update any field(s) of a pantry item.
 * Both partners can update any item (shared access).
 * changes: { name?, category?, quantity?, expires_at? }
 * Returns { success: boolean, data?, error? }
 */
export async function updatePantryItem(itemId, changes) {
  if (!itemId) {
    return { success: false, error: 'Item ID is required' };
  }

  // If name is being updated, validate it
  if (changes.name !== undefined) {
    const validation = validatePantryItem({ name: changes.name });
    if (!validation.valid) {
      return { success: false, error: validation.errors.name, validationErrors: validation.errors };
    }
    changes.name = changes.name.trim();
  }

  // If category is being updated, validate it
  if (changes.category !== undefined && !PANTRY_CATEGORIES.includes(changes.category)) {
    changes.category = 'other';
  }

  const { data, error } = await supabase
    .from('pantry_items')
    .update(changes)
    .eq('id', itemId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data };
}

/**
 * Remove a pantry item. Both partners can delete any item (shared access).
 * Returns { success: boolean, error?: string }
 */
export async function removePantryItem(itemId) {
  if (!itemId) {
    return { success: false, error: 'Item ID is required' };
  }

  const { error } = await supabase
    .from('pantry_items')
    .delete()
    .eq('id', itemId);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}

/**
 * Get pantry items that are NOT expired.
 * Items with no expiry date are always included.
 * Items with expiry date >= today are included.
 * Items with expiry date < today are excluded.
 *
 * This is a pure filtering function that works on an array of items.
 * Used for recipe generation context.
 */
export function getValidPantryItems(items) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return items.filter(item => {
    if (!item.expires_at) return true;
    const expiryDate = new Date(item.expires_at);
    expiryDate.setHours(0, 0, 0, 0);
    return expiryDate >= today;
  });
}

/**
 * Fetch only valid (non-expired) pantry items from the database.
 * Convenience wrapper combining fetchPantryItems + getValidPantryItems.
 * Returns { success: boolean, data?: PantryItem[], error?: string }
 */
export async function fetchValidPantryItems() {
  const result = await fetchPantryItems();
  if (!result.success) return result;
  return { success: true, data: getValidPantryItems(result.data) };
}

// --- UI Rendering ---

/**
 * Render the pantry management UI into a container element.
 * Shows add form and list of existing items with edit/remove buttons.
 */
export function renderPantryUI(container, items = []) {
  container.innerHTML = `
    <section class="card pantry-section" aria-label="Pantry Management">
      <div class="card-header">
        <h3 class="card-title">Pantry</h3>
      </div>
      <div class="card-body">
        <!-- Add Item Form -->
        <form id="pantry-add-form" class="pantry-form flex-col gap-3" aria-label="Add pantry item">
          <div class="input-group">
            <label class="input-label" for="pantry-name">Item Name</label>
            <input type="text" id="pantry-name" class="input" placeholder="e.g. Chicken breast" maxlength="100" required aria-describedby="pantry-name-error">
            <span id="pantry-name-error" class="input-error-msg" aria-live="polite"></span>
          </div>
          <div class="flex gap-3">
            <div class="input-group" style="flex:1">
              <label class="input-label" for="pantry-category">Category</label>
              <select id="pantry-category" class="input" aria-label="Item category">
                ${PANTRY_CATEGORIES.map(cat => `<option value="${cat}">${cat.charAt(0).toUpperCase() + cat.slice(1)}</option>`).join('')}
              </select>
            </div>
            <div class="input-group" style="flex:1">
              <label class="input-label" for="pantry-quantity">Quantity</label>
              <input type="text" id="pantry-quantity" class="input" placeholder="e.g. 500g">
            </div>
          </div>
          <div class="input-group">
            <label class="input-label" for="pantry-expiry">Expiry Date (optional)</label>
            <input type="date" id="pantry-expiry" class="input" aria-label="Expiry date">
          </div>
          <button type="submit" class="btn btn-primary">Add Item</button>
        </form>

        <!-- Pantry Items List -->
        <div id="pantry-list" class="pantry-list flex-col gap-2 mt-4" aria-live="polite" aria-label="Pantry items">
          ${renderPantryItems(items)}
        </div>
      </div>
    </section>
  `;

  // Attach form submission handler
  const form = container.querySelector('#pantry-add-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleAddItem(container);
  });

  // Attach edit/remove handlers on the list
  attachItemHandlers(container);
}

/**
 * Render pantry items as HTML cards.
 */
function renderPantryItems(items) {
  if (!items || items.length === 0) {
    return '<p class="text-muted text-sm">No items in pantry.</p>';
  }

  return items.map(item => {
    const isExpired = item.expires_at && new Date(item.expires_at) < new Date(new Date().toDateString());
    const expiryLabel = item.expires_at
      ? `Expires: ${item.expires_at}${isExpired ? ' (expired)' : ''}`
      : '';

    return `
      <div class="card pantry-item shared-item${isExpired ? ' pantry-item-expired' : ''}" data-item-id="${item.id}">
        <div class="flex items-center justify-between">
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <span class="badge ml-2">${escapeHtml(item.category || 'other')}</span>
            ${item.quantity ? `<span class="text-sm text-muted ml-2">${escapeHtml(item.quantity)}</span>` : ''}
          </div>
          <div class="flex gap-1">
            <button class="btn btn-ghost btn-sm pantry-edit-btn" data-item-id="${item.id}" aria-label="Edit ${escapeHtml(item.name)}">
              <svg class="icon icon-sm" viewBox="0 0 20 20"><path d="M13.5 3.5l3 3L7 16H4v-3L13.5 3.5z"/></svg>
            </button>
            <button class="btn btn-ghost btn-sm pantry-remove-btn" data-item-id="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">
              <svg class="icon icon-sm" viewBox="0 0 20 20"><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>
            </button>
          </div>
        </div>
        ${expiryLabel ? `<p class="text-sm text-muted mt-1">${expiryLabel}</p>` : ''}
      </div>
    `;
  }).join('');
}

/**
 * Handle adding a pantry item from the form.
 */
async function handleAddItem(container) {
  const nameInput = container.querySelector('#pantry-name');
  const categoryInput = container.querySelector('#pantry-category');
  const quantityInput = container.querySelector('#pantry-quantity');
  const expiryInput = container.querySelector('#pantry-expiry');
  const nameError = container.querySelector('#pantry-name-error');

  // Clear previous errors
  nameError.textContent = '';
  nameInput.classList.remove('input-error');

  const itemData = {
    name: nameInput.value,
    category: categoryInput.value,
    quantity: quantityInput.value || null,
    expires_at: expiryInput.value || null,
  };

  // Client-side validation
  const validation = validatePantryItem(itemData);
  if (!validation.valid) {
    nameError.textContent = validation.errors.name;
    nameInput.classList.add('input-error');
    return;
  }

  const result = await addPantryItem(itemData);
  if (!result.success) {
    nameError.textContent = result.error;
    nameInput.classList.add('input-error');
    return;
  }

  // Clear form on success
  nameInput.value = '';
  quantityInput.value = '';
  expiryInput.value = '';
  categoryInput.value = 'other';

  // Refresh the list
  await refreshPantryList(container);
}

/**
 * Refresh the pantry items list in the UI.
 */
async function refreshPantryList(container) {
  const result = await fetchPantryItems();
  if (result.success) {
    const listEl = container.querySelector('#pantry-list');
    if (listEl) {
      listEl.innerHTML = renderPantryItems(result.data);
      attachItemHandlers(container);
    }
  }
}

/**
 * Attach click handlers for edit and remove buttons.
 */
function attachItemHandlers(container) {
  container.querySelectorAll('.pantry-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const itemId = btn.getAttribute('data-item-id');
      await removePantryItem(itemId);
      await refreshPantryList(container);
    });
  });

  container.querySelectorAll('.pantry-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.getAttribute('data-item-id');
      const itemCard = container.querySelector(`.pantry-item[data-item-id="${itemId}"]`);
      if (itemCard) {
        showEditInline(container, itemCard, itemId);
      }
    });
  });
}

/**
 * Show inline edit form for a pantry item.
 */
function showEditInline(container, itemCard, itemId) {
  // Get current values from the card text
  const nameEl = itemCard.querySelector('strong');
  const currentName = nameEl ? nameEl.textContent : '';

  itemCard.innerHTML = `
    <form class="pantry-edit-form flex-col gap-2" data-item-id="${itemId}">
      <div class="input-group">
        <input type="text" class="input pantry-edit-name" value="${escapeHtml(currentName)}" maxlength="100" required aria-label="Edit item name">
        <span class="input-error-msg pantry-edit-error" aria-live="polite"></span>
      </div>
      <div class="flex gap-2">
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
        <button type="button" class="btn btn-ghost btn-sm pantry-edit-cancel">Cancel</button>
      </div>
    </form>
  `;

  const form = itemCard.querySelector('.pantry-edit-form');
  const editInput = itemCard.querySelector('.pantry-edit-name');
  const editError = itemCard.querySelector('.pantry-edit-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    editError.textContent = '';
    editInput.classList.remove('input-error');

    const newName = editInput.value;
    const validation = validatePantryItem({ name: newName });
    if (!validation.valid) {
      editError.textContent = validation.errors.name;
      editInput.classList.add('input-error');
      return;
    }

    const result = await updatePantryItem(itemId, { name: newName.trim() });
    if (!result.success) {
      editError.textContent = result.error;
      editInput.classList.add('input-error');
      return;
    }

    await refreshPantryList(container);
  });

  itemCard.querySelector('.pantry-edit-cancel').addEventListener('click', async () => {
    await refreshPantryList(container);
  });
}

// --- Helpers ---

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Initialization ---

/**
 * Initialize the pantry section.
 * Fetches pantry items and renders the UI.
 */
export async function initPantry(container) {
  const user = getCurrentUser();
  if (!user) return;

  try {
    const result = await fetchPantryItems();
    if (result.success) {
      renderPantryUI(container, result.data);
    } else {
      container.innerHTML = `
        <div class="card">
          <p class="input-error-msg">Failed to load pantry. Please try again.</p>
        </div>
      `;
    }
  } catch (err) {
    container.innerHTML = `
      <div class="card">
        <p class="input-error-msg">Failed to load pantry. Please try again.</p>
      </div>
    `;
  }
}
