/**
 * @vitest-environment jsdom
 *
 * Food diary — entry validation and logging
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const supabaseMock = { from: vi.fn() };
vi.mock('../js/supabase-client.js', () => ({
  supabase: supabaseMock,
  withAuthGuard: (operation) => operation(),
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-a' })),
  getPartner: vi.fn(() => ({ id: 'user-b' })),
}));

const { validateEntry, logEntry, renderWeighInForm } = await import('../js/food-diary.js');

const chicken = {
  id: 'food-1',
  name: 'Chicken breast',
  per_100g: { kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
};

describe('validateEntry', () => {
  it('accepts a complete entry', () => {
    expect(validateEntry({ food: chicken, grams: 150, meal: 'lunch' }).valid).toBe(true);
  });

  it('requires a food', () => {
    expect(validateEntry({ food: null, grams: 150, meal: 'lunch' }).errors.food).toBeTruthy();
  });

  it('rejects a zero or negative amount', () => {
    expect(validateEntry({ food: chicken, grams: 0, meal: 'lunch' }).errors.grams).toBeTruthy();
    expect(validateEntry({ food: chicken, grams: -10, meal: 'lunch' }).errors.grams).toBeTruthy();
  });

  it('rejects an implausible amount', () => {
    expect(validateEntry({ food: chicken, grams: 6000, meal: 'lunch' }).errors.grams).toBeTruthy();
  });

  it('rejects an unknown meal', () => {
    expect(validateEntry({ food: chicken, grams: 150, meal: 'brunch' }).errors.meal).toBeTruthy();
  });
});

describe('logEntry', () => {
  beforeEach(() => {
    supabaseMock.from.mockReset();
  });

  function stubInsert({ error = null } = {}) {
    const captured = [];
    supabaseMock.from.mockImplementation(() => ({
      insert: (row) => {
        captured.push(row);
        return {
          select: () => ({ single: () => Promise.resolve({ data: error ? null : row, error }) }),
        };
      },
    }));
    return captured;
  }

  it('snapshots the macros onto the entry', async () => {
    const captured = stubInsert();
    await logEntry({ food: chicken, grams: 200, meal: 'dinner', dateKey: '2026-08-10' }, 'user-a');

    // A later correction to the food row must not rewrite this history.
    expect(captured[0].macros.kcal).toBe(330);
    expect(captured[0].macros.protein).toBe(62);
  });

  it('writes a client-generated id for offline idempotency', async () => {
    const captured = stubInsert();
    await logEntry({ food: chicken, grams: 100, meal: 'lunch' }, 'user-a');
    expect(captured[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('files the entry against the given day', async () => {
    const captured = stubInsert();
    await logEntry({ food: chicken, grams: 100, meal: 'lunch', dateKey: '2026-08-09' }, 'user-a');
    expect(captured[0].entry_date).toBe('2026-08-09');
  });

  it('defaults to the local day, not the UTC one', async () => {
    const captured = stubInsert();
    await logEntry({ food: chicken, grams: 100, meal: 'lunch' }, 'user-a');
    const now = new Date();
    const localKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(captured[0].entry_date).toBe(localKey);
  });

  it('rejects an invalid entry without touching the database', async () => {
    const captured = stubInsert();
    const result = await logEntry({ food: chicken, grams: 0, meal: 'lunch' }, 'user-a');
    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('surfaces a write failure', async () => {
    stubInsert({ error: { message: 'boom' } });
    const result = await logEntry({ food: chicken, grams: 100, meal: 'lunch' }, 'user-a');
    expect(result.success).toBe(false);
  });
});

describe('renderWeighInForm', () => {
  it('explains why the smoothed line is used rather than the raw number', () => {
    const mount = document.createElement('div');
    renderWeighInForm(mount);
    expect(mount.textContent).toMatch(/mostly water/);
  });

  it('renders an input bounded to plausible weights', () => {
    const mount = document.createElement('div');
    renderWeighInForm(mount);
    const input = mount.querySelector('#weighin-value');
    expect(input.min).toBe('20');
    expect(input.max).toBe('400');
  });
});
