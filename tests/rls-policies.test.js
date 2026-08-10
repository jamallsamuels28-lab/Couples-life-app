/**
 * Integration tests for Row Level Security (RLS) policies.
 *
 * These tests verify that:
 * - User A cannot insert/update records with User B's user_id in steps_log, meals, dietary_preferences
 * - Both users can SELECT all records across all tables
 * - Both users can insert/update/delete shared resources (recipes, pantry_items)
 *
 * Requirements: 11.1, 11.2, 11.3
 *
 * Prerequisites:
 *   1. Run `supabase start` to spin up the local Supabase instance.
 *   2. Ensure the migrations have been applied (tables + RLS policies exist).
 *   3. Create two test users via Supabase Auth and set their UUIDs below,
 *      or configure SUPABASE_TEST_USER_A_EMAIL / SUPABASE_TEST_USER_B_EMAIL env vars.
 *
 * Environment variables (all optional — defaults point to local Supabase):
 *   SUPABASE_URL           - defaults to http://127.0.0.1:54321
 *   SUPABASE_ANON_KEY      - the local anon key (from `supabase status`)
 *   SUPABASE_SERVICE_KEY   - the local service_role key for admin operations
 *   TEST_USER_A_EMAIL      - email for test user A (default: testa@test.local)
 *   TEST_USER_A_PASSWORD   - password for test user A (default: password123)
 *   TEST_USER_B_EMAIL      - email for test user B (default: testb@test.local)
 *   TEST_USER_B_PASSWORD   - password for test user B (default: password123)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const USER_A_EMAIL = process.env.TEST_USER_A_EMAIL || 'testa@test.local';
const USER_A_PASSWORD = process.env.TEST_USER_A_PASSWORD || 'password123';
const USER_B_EMAIL = process.env.TEST_USER_B_EMAIL || 'testb@test.local';
const USER_B_PASSWORD = process.env.TEST_USER_B_PASSWORD || 'password123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Admin client bypasses RLS — used for setup/teardown */
function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Create an authenticated client for a specific user */
async function createAuthenticatedClient(email, password) {
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Auth failed for ${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

/** Ensure a test user exists (sign up if needed, confirm email via admin) */
async function ensureTestUser(admin, email, password) {
  // Try signing up — if user already exists this is a no-op via the admin API
  const { data: existing } = await admin.auth.admin.listUsers();
  const found = existing?.users?.find((u) => u.email === email);
  if (found) return found.id;

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Could not create test user ${email}: ${error.message}`);
  return data.user.id;
}

/** Ensure a profile row exists for the user (needed for FK constraints) */
async function ensureProfile(admin, userId, displayName) {
  const { error } = await admin
    .from('profiles')
    .upsert({ id: userId, display_name: displayName }, { onConflict: 'id' });
  if (error) throw new Error(`Profile upsert failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RLS Policies Integration Tests', () => {
  let admin;
  let clientA;
  let clientB;
  let userAId;
  let userBId;

  // Track IDs for cleanup
  const createdIds = {
    steps_log: [],
    meals: [],
    recipes: [],
    dietary_preferences: [],
    pantry_items: [],
  };

  beforeAll(async () => {
    if (!SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
      throw new Error(
        'SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY must be set. Run `supabase status` to get keys.'
      );
    }

    admin = createAdminClient();

    // Create/ensure test users
    userAId = await ensureTestUser(admin, USER_A_EMAIL, USER_A_PASSWORD);
    userBId = await ensureTestUser(admin, USER_B_EMAIL, USER_B_PASSWORD);

    // Ensure profiles exist (FK target for steps_log, meals, etc.)
    await ensureProfile(admin, userAId, 'Test User A');
    await ensureProfile(admin, userBId, 'Test User B');

    // Authenticate both users
    const authA = await createAuthenticatedClient(USER_A_EMAIL, USER_A_PASSWORD);
    const authB = await createAuthenticatedClient(USER_B_EMAIL, USER_B_PASSWORD);
    clientA = authA.client;
    clientB = authB.client;
  });

  afterAll(async () => {
    // Cleanup all test data using admin client (bypasses RLS)
    for (const table of Object.keys(createdIds)) {
      const ids = createdIds[table];
      if (ids.length > 0) {
        await admin.from(table).delete().in('id', ids);
      }
    }
  });

  // =========================================================================
  // 11.2: steps_log — insert/update own only
  // =========================================================================
  describe('steps_log: own-record enforcement (Req 11.2)', () => {
    it('User A can insert their own steps_log entry', async () => {
      const { data, error } = await clientA
        .from('steps_log')
        .insert({
          user_id: userAId,
          log_date: '2025-01-15',
          step_count: 8500,
          source: 'manual',
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data.user_id).toBe(userAId);
      expect(data.step_count).toBe(8500);
      createdIds.steps_log.push(data.id);
    });

    it('User A CANNOT insert a steps_log entry with User B\'s user_id', async () => {
      const { data, error } = await clientA
        .from('steps_log')
        .insert({
          user_id: userBId, // Attempting to write as User B
          log_date: '2025-01-16',
          step_count: 5000,
          source: 'manual',
        })
        .select()
        .single();

      // RLS should reject this — error or empty data
      expect(error).not.toBeNull();
    });

    it('User A CANNOT update User B\'s steps_log entry', async () => {
      // First, insert a record for User B via admin
      const { data: bRecord } = await admin
        .from('steps_log')
        .insert({
          user_id: userBId,
          log_date: '2025-01-17',
          step_count: 6000,
          source: 'manual',
        })
        .select()
        .single();
      createdIds.steps_log.push(bRecord.id);

      // User A tries to update User B's record
      const { data, error, count } = await clientA
        .from('steps_log')
        .update({ step_count: 9999 })
        .eq('id', bRecord.id)
        .select();

      // RLS prevents the update — either error or no rows affected
      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data).toHaveLength(0);
      }
    });
  });

  // =========================================================================
  // 11.2: meals — insert/update own only
  // =========================================================================
  describe('meals: own-record enforcement (Req 11.2)', () => {
    it('User A can insert their own meal', async () => {
      const { data, error } = await clientA
        .from('meals')
        .insert({
          user_id: userAId,
          meal_date: '2025-01-15',
          meal_type: 'lunch',
          title: 'Grilled chicken',
          calories: 450,
          protein_g: 40,
          carbs_g: 20,
          fats_g: 15,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data.user_id).toBe(userAId);
      createdIds.meals.push(data.id);
    });

    it('User A CANNOT insert a meal with User B\'s user_id', async () => {
      const { data, error } = await clientA
        .from('meals')
        .insert({
          user_id: userBId,
          meal_date: '2025-01-15',
          meal_type: 'dinner',
          title: 'Fake entry',
          calories: 100,
        })
        .select()
        .single();

      expect(error).not.toBeNull();
    });

    it('User A CANNOT update User B\'s meal', async () => {
      // Insert B's meal via admin
      const { data: bMeal } = await admin
        .from('meals')
        .insert({
          user_id: userBId,
          meal_date: '2025-01-18',
          meal_type: 'breakfast',
          title: 'Oatmeal',
          calories: 300,
        })
        .select()
        .single();
      createdIds.meals.push(bMeal.id);

      // User A tries to update
      const { data, error } = await clientA
        .from('meals')
        .update({ title: 'Hacked meal' })
        .eq('id', bMeal.id)
        .select();

      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data).toHaveLength(0);
      }
    });
  });

  // =========================================================================
  // 11.1: Both users can read ALL records across all tables
  // =========================================================================
  describe('SELECT: both users can read all records (Req 11.1)', () => {
    it('User B can read User A\'s steps_log entries', async () => {
      const { data, error } = await clientB
        .from('steps_log')
        .select('*')
        .eq('user_id', userAId);

      expect(error).toBeNull();
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('User A can read User B\'s steps_log entries', async () => {
      const { data, error } = await clientA
        .from('steps_log')
        .select('*')
        .eq('user_id', userBId);

      expect(error).toBeNull();
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('User B can read User A\'s meals', async () => {
      const { data, error } = await clientB
        .from('meals')
        .select('*')
        .eq('user_id', userAId);

      expect(error).toBeNull();
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('Both users can read recipes', async () => {
      // Insert a recipe via admin for visibility test
      const { data: recipe } = await admin
        .from('recipes')
        .insert({
          created_by: userAId,
          title: 'Test Recipe for Read',
          ingredients: JSON.stringify([{ name: 'flour', amount: '2', unit: 'cups' }]),
          steps: JSON.stringify([{ order: 1, instruction: 'Mix ingredients' }]),
        })
        .select()
        .single();
      createdIds.recipes.push(recipe.id);

      const { data: dataA, error: errA } = await clientA
        .from('recipes')
        .select('*')
        .eq('id', recipe.id);
      expect(errA).toBeNull();
      expect(dataA).toHaveLength(1);

      const { data: dataB, error: errB } = await clientB
        .from('recipes')
        .select('*')
        .eq('id', recipe.id);
      expect(errB).toBeNull();
      expect(dataB).toHaveLength(1);
    });

    it('Both users can read dietary_preferences', async () => {
      // Insert prefs for User A via admin
      const { data: pref } = await admin
        .from('dietary_preferences')
        .upsert(
          { user_id: userAId, diet_type: 'vegetarian', allergies: ['peanuts'] },
          { onConflict: 'user_id' }
        )
        .select()
        .single();
      createdIds.dietary_preferences.push(pref.id);

      const { data: dataB, error: errB } = await clientB
        .from('dietary_preferences')
        .select('*')
        .eq('user_id', userAId);
      expect(errB).toBeNull();
      expect(dataB).toHaveLength(1);
      expect(dataB[0].diet_type).toBe('vegetarian');
    });

    it('Both users can read pantry_items', async () => {
      const { data: item } = await admin
        .from('pantry_items')
        .insert({ name: 'Olive Oil', category: 'other', added_by: userAId })
        .select()
        .single();
      createdIds.pantry_items.push(item.id);

      const { data: dataB, error: errB } = await clientB
        .from('pantry_items')
        .select('*')
        .eq('id', item.id);
      expect(errB).toBeNull();
      expect(dataB).toHaveLength(1);
    });
  });

  // =========================================================================
  // 11.3: Shared write access on recipes and pantry_items
  // =========================================================================
  describe('recipes: shared CRUD (Req 11.3)', () => {
    let recipeId;

    it('User A can insert a recipe', async () => {
      const { data, error } = await clientA
        .from('recipes')
        .insert({
          created_by: userAId,
          title: 'Pasta Carbonara',
          ingredients: JSON.stringify([{ name: 'spaghetti', amount: '200', unit: 'g' }]),
          steps: JSON.stringify([{ order: 1, instruction: 'Boil pasta' }]),
          servings: 2,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      recipeId = data.id;
      createdIds.recipes.push(data.id);
    });

    it('User B can update User A\'s recipe (shared write)', async () => {
      const { data, error } = await clientB
        .from('recipes')
        .update({ title: 'Pasta Carbonara (Updated)' })
        .eq('id', recipeId)
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data[0].title).toBe('Pasta Carbonara (Updated)');
    });

    it('User B can delete User A\'s recipe (shared delete)', async () => {
      const { error } = await clientB
        .from('recipes')
        .delete()
        .eq('id', recipeId);

      expect(error).toBeNull();

      // Verify deleted
      const { data } = await admin.from('recipes').select('*').eq('id', recipeId);
      expect(data).toHaveLength(0);

      // Remove from cleanup since already deleted
      createdIds.recipes = createdIds.recipes.filter((id) => id !== recipeId);
    });
  });

  describe('pantry_items: shared CRUD (Req 11.3)', () => {
    let pantryId;

    it('User A can insert a pantry item', async () => {
      const { data, error } = await clientA
        .from('pantry_items')
        .insert({
          name: 'Brown Rice',
          category: 'grain',
          quantity: '1 kg',
          added_by: userAId,
        })
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      pantryId = data.id;
      createdIds.pantry_items.push(data.id);
    });

    it('User B can update User A\'s pantry item (shared write)', async () => {
      const { data, error } = await clientB
        .from('pantry_items')
        .update({ quantity: '500g' })
        .eq('id', pantryId)
        .select();

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data[0].quantity).toBe('500g');
    });

    it('User B can delete User A\'s pantry item (shared delete)', async () => {
      const { error } = await clientB
        .from('pantry_items')
        .delete()
        .eq('id', pantryId);

      expect(error).toBeNull();

      const { data } = await admin.from('pantry_items').select('*').eq('id', pantryId);
      expect(data).toHaveLength(0);

      createdIds.pantry_items = createdIds.pantry_items.filter((id) => id !== pantryId);
    });
  });

  // =========================================================================
  // 11.2: dietary_preferences — upsert/update own only
  // =========================================================================
  describe('dietary_preferences: own-record enforcement (Req 11.2)', () => {
    it('User A can upsert their own dietary_preferences', async () => {
      const { data, error } = await clientA
        .from('dietary_preferences')
        .upsert(
          {
            user_id: userAId,
            diet_type: 'keto',
            allergies: ['shellfish'],
            dislikes: ['mushrooms'],
          },
          { onConflict: 'user_id' }
        )
        .select()
        .single();

      expect(error).toBeNull();
      expect(data).toBeDefined();
      expect(data.diet_type).toBe('keto');
      // Update tracked ID for cleanup
      createdIds.dietary_preferences = createdIds.dietary_preferences.filter(
        (id) => id !== data.id
      );
      createdIds.dietary_preferences.push(data.id);
    });

    it('User A CANNOT insert dietary_preferences with User B\'s user_id', async () => {
      const { data, error } = await clientA
        .from('dietary_preferences')
        .insert({
          user_id: userBId,
          diet_type: 'vegan',
          allergies: ['gluten'],
        })
        .select()
        .single();

      expect(error).not.toBeNull();
    });

    it('User A CANNOT update User B\'s dietary_preferences', async () => {
      // Ensure B has a preference record via admin
      const { data: bPref } = await admin
        .from('dietary_preferences')
        .upsert(
          { user_id: userBId, diet_type: 'halal', allergies: ['dairy'] },
          { onConflict: 'user_id' }
        )
        .select()
        .single();
      createdIds.dietary_preferences.push(bPref.id);

      // User A tries to update B's preferences
      const { data, error } = await clientA
        .from('dietary_preferences')
        .update({ diet_type: 'vegan' })
        .eq('user_id', userBId)
        .select();

      if (error) {
        expect(error).not.toBeNull();
      } else {
        expect(data).toHaveLength(0);
      }
    });
  });
});
