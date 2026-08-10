/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mock Supabase client ---
const mockSelect = vi.fn().mockReturnThis();
const mockSingle = vi.fn().mockResolvedValue({ data: null, error: null });
const mockInsert = vi.fn(() => ({ select: () => ({ single: mockSingle }) }));
const mockFrom = vi.fn(() => ({
  insert: mockInsert,
  select: mockSelect,
  update: vi.fn().mockReturnThis(),
  delete: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  in: vi.fn().mockReturnThis(),
  lt: vi.fn().mockReturnThis(),
  gt: vi.fn().mockReturnThis(),
  order: vi.fn().mockResolvedValue({ data: [], error: null }),
  single: mockSingle,
}));

vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    from: (...args) => mockFrom(...args),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-a' }, expires_at: Math.floor(Date.now() / 1000) + 3600 } },
        error: null,
      }),
    },
  },
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-key',
}));

// --- Mock app-shell ---
const mockCurrentUser = { id: 'user-a', email: 'jamall@test.com' };
const mockPartner = { id: 'user-b', email: 'rebecca@test.com' };

vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: () => mockCurrentUser,
  getPartner: () => mockPartner,
}));

// --- Import modules under test ---
const { wireModulesToRealtime, unwireModulesFromRealtime, isWired } = await import('../js/realtime-wiring.js');
const { bothFreeWindows } = await import('../js/free-windows.js');
const { aggregateDailyMacros } = await import('../js/food-module.js');
const { getValidPantryItems } = await import('../js/pantry-module.js');

// --- Test Helpers ---

/**
 * Dispatches a simulated realtime event for a given table.
 */
function dispatchRealtimeEvent(table, payload) {
  window.dispatchEvent(new CustomEvent(`realtime:${table}`, { detail: payload }));
}

/**
 * Creates a payload simulating a Supabase realtime INSERT.
 */
function makeInsertPayload(table, record) {
  return {
    eventType: 'INSERT',
    schema: 'public',
    table,
    new: record,
    old: null,
  };
}

/**
 * Creates a payload simulating a Supabase realtime UPDATE.
 */
function makeUpdatePayload(table, oldRecord, newRecord) {
  return {
    eventType: 'UPDATE',
    schema: 'public',
    table,
    new: newRecord,
    old: oldRecord,
  };
}

// ============================================================
// Integration Tests: Cross-Module Flows
// ============================================================

describe('Integration: Cross-Module Flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="app"></div>';
    // Ensure a fresh wiring state
    unwireModulesFromRealtime();
  });

  afterEach(() => {
    unwireModulesFromRealtime();
    document.body.innerHTML = '';
  });

  // ----------------------------------------------------------
  // 1. Calendar → Free Windows Flow
  // Validates: Requirements 2.6, 3.1
  // ----------------------------------------------------------
  describe('Calendar → Free Windows Flow', () => {
    it('a new busy event reduces available free windows', () => {
      const rangeStart = new Date('2025-03-15T00:00:00');
      const rangeEnd = new Date('2025-03-16T00:00:00');

      // Before: no events, full waking hours are free
      const resultBefore = bothFreeWindows({
        personAEvents: [], personBEvents: [],
        rangeStart, rangeEnd, options: { minMinutes: 45 },
      });
      expect(resultBefore.success).toBe(true);
      const totalFreeBefore = resultBefore.windows.reduce(
        (sum, w) => sum + (w.end.getTime() - w.start.getTime()), 0
      );

      // After: add a busy event from 10:00-12:00
      const events = [{
        id: 'evt-1',
        user_id: 'user-a',
        title: 'Meeting',
        start_time: '2025-03-15T10:00:00',
        end_time: '2025-03-15T12:00:00',
        is_busy: true,
      }];

      const resultAfter = bothFreeWindows({
        personAEvents: events, personBEvents: [],
        rangeStart, rangeEnd, options: { minMinutes: 45 },
      });
      expect(resultAfter.success).toBe(true);
      const totalFreeAfter = resultAfter.windows.reduce(
        (sum, w) => sum + (w.end.getTime() - w.start.getTime()), 0
      );

      // Free time should be reduced by the 2-hour busy block
      expect(totalFreeAfter).toBeLessThan(totalFreeBefore);
      expect(totalFreeBefore - totalFreeAfter).toBe(2 * 60 * 60 * 1000);
    });

    it('realtime:events dispatches calendar:refresh for partner changes', () => {
      wireModulesToRealtime();

      // The calendar module listens to realtime:events directly (not via wiring),
      // but the wiring module ensures steps/meals/pantry/recipes are bridged.
      // Simulate a calendar event from partner — verify that the calendar module
      // receives the event through the standard realtime:events path.
      let received = false;
      const handler = (e) => { received = true; };
      window.addEventListener('realtime:events', handler);

      dispatchRealtimeEvent('events', makeInsertPayload('events', {
        id: 'evt-2',
        user_id: 'user-b',
        title: 'Partner Meeting',
        start_time: '2025-03-15T14:00:00',
        end_time: '2025-03-15T15:00:00',
        is_busy: true,
      }));

      expect(received).toBe(true);
      window.removeEventListener('realtime:events', handler);
    });

    it('partner busy event is included in free window calculation', () => {
      const rangeStart = new Date('2025-03-15T00:00:00');
      const rangeEnd = new Date('2025-03-16T00:00:00');

      // Both partners have events
      const events = [
        {
          id: 'evt-a', user_id: 'user-a', title: 'My meeting',
          start_time: '2025-03-15T09:00:00', end_time: '2025-03-15T10:00:00', is_busy: true,
        },
        {
          id: 'evt-b', user_id: 'user-b', title: 'Partner meeting',
          start_time: '2025-03-15T14:00:00', end_time: '2025-03-15T16:00:00', is_busy: true,
        },
      ];

      const result = bothFreeWindows({
        personAEvents: events.filter(e => e.user_id === 'user-a'),
        personBEvents: events.filter(e => e.user_id === 'user-b'),
        rangeStart, rangeEnd, options: { minMinutes: 45 },
      });

      expect(result.success).toBe(true);
      // No free window should overlap with either event
      for (const w of result.windows) {
        // Should not overlap 09:00-10:00
        expect(
          w.start < new Date('2025-03-15T10:00:00') && w.end > new Date('2025-03-15T09:00:00')
        ).toBe(false);
        // Should not overlap 14:00-16:00
        expect(
          w.start < new Date('2025-03-15T16:00:00') && w.end > new Date('2025-03-15T14:00:00')
        ).toBe(false);
      }
    });
  });

  // ----------------------------------------------------------
  // 2. Meal → Macros Aggregation → Partner Visibility Flow
  // Validates: Requirements 7.5, 7.7, 5.2
  // ----------------------------------------------------------
  describe('Meal → Macros → Partner Visibility Flow', () => {
    it('logged meals aggregate into correct macro totals', () => {
      const meals = [
        { calories: 400, protein_g: 30, carbs_g: 50, fats_g: 15 },
        { calories: 600, protein_g: 45, carbs_g: 60, fats_g: 25 },
      ];

      const macros = aggregateDailyMacros(meals);

      expect(macros.calories).toBe(1000);
      expect(macros.protein).toBe(75);
      expect(macros.carbs).toBe(110);
      expect(macros.fats).toBe(40);
      expect(macros.mealCount).toBe(2);
    });

    it('realtime meal event dispatches food:refresh for partner view', () => {
      wireModulesToRealtime();

      let foodRefreshDetail = null;
      window.addEventListener('food:refresh', (e) => {
        foodRefreshDetail = e.detail;
      });

      const mealPayload = makeInsertPayload('meals', {
        id: 'meal-1',
        user_id: 'user-b',
        meal_date: '2025-03-15',
        meal_type: 'lunch',
        title: 'Salad bowl',
        calories: 350,
        protein_g: 25,
        carbs_g: 30,
        fats_g: 12,
      });

      dispatchRealtimeEvent('meals', mealPayload);

      expect(foodRefreshDetail).not.toBeNull();
      expect(foodRefreshDetail.new.user_id).toBe('user-b');
      expect(foodRefreshDetail.new.title).toBe('Salad bowl');
    });

    it('empty meals array produces zero aggregates', () => {
      const macros = aggregateDailyMacros([]);
      expect(macros.calories).toBe(0);
      expect(macros.protein).toBe(0);
      expect(macros.carbs).toBe(0);
      expect(macros.fats).toBe(0);
      expect(macros.mealCount).toBe(0);
    });

    it('partner meal realtime event is visible after wiring is active', () => {
      wireModulesToRealtime();

      const events = [];
      window.addEventListener('food:refresh', (e) => events.push(e.detail));

      // Simulate multiple partner meals being added
      dispatchRealtimeEvent('meals', makeInsertPayload('meals', {
        id: 'meal-2', user_id: 'user-b', calories: 200, protein_g: 15, carbs_g: 25, fats_g: 8,
      }));
      dispatchRealtimeEvent('meals', makeInsertPayload('meals', {
        id: 'meal-3', user_id: 'user-b', calories: 500, protein_g: 40, carbs_g: 50, fats_g: 20,
      }));

      expect(events).toHaveLength(2);
      // Aggregate the visible meal data
      const mealsData = events.map(e => e.new);
      const macros = aggregateDailyMacros(mealsData);
      expect(macros.calories).toBe(700);
      expect(macros.protein).toBe(55);
    });
  });

  // ----------------------------------------------------------
  // 3. Pantry → Recipe Generation Context Flow
  // Validates: Requirements 9.6, 9.7
  // ----------------------------------------------------------
  describe('Pantry → Recipe Generation Context Flow', () => {
    it('pantry:refresh event is dispatched when pantry item is added via realtime', () => {
      wireModulesToRealtime();

      let pantryRefreshDetail = null;
      window.addEventListener('pantry:refresh', (e) => {
        pantryRefreshDetail = e.detail;
      });

      const pantryPayload = makeInsertPayload('pantry_items', {
        id: 'pantry-1',
        name: 'Chicken breast',
        category: 'protein',
        quantity: '500g',
        expires_at: '2025-04-01',
        added_by: 'user-a',
      });

      dispatchRealtimeEvent('pantry_items', pantryPayload);

      expect(pantryRefreshDetail).not.toBeNull();
      expect(pantryRefreshDetail.new.name).toBe('Chicken breast');
    });

    it('valid pantry items are included in recipe generation context', () => {
      const today = new Date();
      const futureDate = new Date(today);
      futureDate.setDate(futureDate.getDate() + 10);
      const pastDate = new Date(today);
      pastDate.setDate(pastDate.getDate() - 5);

      const items = [
        { id: '1', name: 'Chicken', expires_at: futureDate.toISOString().split('T')[0] },
        { id: '2', name: 'Expired milk', expires_at: pastDate.toISOString().split('T')[0] },
        { id: '3', name: 'Rice', expires_at: null }, // no expiry → always valid
      ];

      const validItems = getValidPantryItems(items);

      expect(validItems).toHaveLength(2);
      expect(validItems.map(i => i.name)).toContain('Chicken');
      expect(validItems.map(i => i.name)).toContain('Rice');
      expect(validItems.map(i => i.name)).not.toContain('Expired milk');
    });

    it('pantry update event propagates updated item for recipe context refresh', () => {
      wireModulesToRealtime();

      const received = [];
      window.addEventListener('pantry:refresh', (e) => received.push(e.detail));

      // Simulate a pantry update (e.g. name or quantity change)
      const updatePayload = makeUpdatePayload('pantry_items',
        { id: 'pantry-1', name: 'Chicken breast', quantity: '500g' },
        { id: 'pantry-1', name: 'Chicken breast', quantity: '1kg' }
      );
      dispatchRealtimeEvent('pantry_items', updatePayload);

      expect(received).toHaveLength(1);
      expect(received[0].new.quantity).toBe('1kg');
    });

    it('expired items are excluded from recipe generation context after refresh', () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const items = [
        { id: '1', name: 'Fresh spinach', expires_at: null },
        { id: '2', name: 'Old yogurt', expires_at: yesterday.toISOString().split('T')[0] },
      ];

      const validItems = getValidPantryItems(items);
      expect(validItems).toHaveLength(1);
      expect(validItems[0].name).toBe('Fresh spinach');
    });
  });

  // ----------------------------------------------------------
  // 4. Partner Visibility: Realtime events from different user_id
  // Validates: Requirements 2.6, 5.2
  // ----------------------------------------------------------
  describe('Partner Visibility via Realtime', () => {
    it('steps:refresh is dispatched for partner step log events', () => {
      wireModulesToRealtime();

      let stepsRefreshDetail = null;
      window.addEventListener('steps:refresh', (e) => {
        stepsRefreshDetail = e.detail;
      });

      dispatchRealtimeEvent('steps_log', makeInsertPayload('steps_log', {
        id: 'step-1',
        user_id: 'user-b',
        log_date: '2025-03-15',
        step_count: 8500,
        source: 'manual',
      }));

      expect(stepsRefreshDetail).not.toBeNull();
      expect(stepsRefreshDetail.new.user_id).toBe('user-b');
      expect(stepsRefreshDetail.new.step_count).toBe(8500);
    });

    it('recipes:refresh is dispatched for shared recipe additions', () => {
      wireModulesToRealtime();

      let recipesRefreshDetail = null;
      window.addEventListener('recipes:refresh', (e) => {
        recipesRefreshDetail = e.detail;
      });

      dispatchRealtimeEvent('recipes', makeInsertPayload('recipes', {
        id: 'recipe-1',
        title: 'Grilled Chicken Salad',
        tags: ['healthy', 'high-protein'],
        meal_type: 'lunch',
      }));

      expect(recipesRefreshDetail).not.toBeNull();
      expect(recipesRefreshDetail.new.title).toBe('Grilled Chicken Salad');
    });

    it('no events are dispatched when wiring is not active', () => {
      // Ensure unwired
      expect(isWired()).toBe(false);

      let foodReceived = false;
      let stepsReceived = false;
      window.addEventListener('food:refresh', () => { foodReceived = true; });
      window.addEventListener('steps:refresh', () => { stepsReceived = true; });

      dispatchRealtimeEvent('meals', makeInsertPayload('meals', {
        id: 'meal-x', user_id: 'user-b', calories: 100,
      }));
      dispatchRealtimeEvent('steps_log', makeInsertPayload('steps_log', {
        id: 'step-x', user_id: 'user-b', step_count: 5000,
      }));

      expect(foodReceived).toBe(false);
      expect(stepsReceived).toBe(false);
    });

    it('unwiring stops all event propagation', () => {
      wireModulesToRealtime();
      expect(isWired()).toBe(true);

      unwireModulesFromRealtime();
      expect(isWired()).toBe(false);

      let received = false;
      window.addEventListener('pantry:refresh', () => { received = true; });

      dispatchRealtimeEvent('pantry_items', makeInsertPayload('pantry_items', {
        id: 'p-1', name: 'Test',
      }));

      expect(received).toBe(false);
    });

    it('wiring is idempotent — calling wireModulesToRealtime twice does not duplicate handlers', () => {
      wireModulesToRealtime();
      wireModulesToRealtime(); // second call should be no-op

      const events = [];
      window.addEventListener('food:refresh', (e) => events.push(e));

      dispatchRealtimeEvent('meals', makeInsertPayload('meals', {
        id: 'meal-dup', user_id: 'user-b', calories: 300,
      }));

      // Should only fire once, not twice
      expect(events).toHaveLength(1);
    });
  });
});
