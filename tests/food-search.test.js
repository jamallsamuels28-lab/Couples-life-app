/**
 * @vitest-environment jsdom
 *
 * Food search — the local table, the Open Food Facts fallback, and hand entry.
 *
 * The bug these cover: `foods` is created empty by migration and only ever
 * gains a row when a barcode lookup succeeds, so searching by name returned
 * nothing for every term anyone could type. Nothing failed, nothing errored —
 * the box just sat there. The first test here is the one that would have said so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const supabaseMock = { from: vi.fn() };
vi.mock('../js/supabase-client.js', () => ({
  supabase: supabaseMock,
  withAuthGuard: (operation) => operation(),
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-a' })),
  getPartner: vi.fn(() => null),
}));

const { searchFoods, searchOpenFoodFacts, validateCustomFood, createCustomFood } =
  await import('../js/food-diary.js');

/** Stubs the `foods` table returning `rows` from an ilike query. */
function stubFoodsTable(rows = [], error = null) {
  supabaseMock.from.mockImplementation(() => ({
    select: () => ({
      ilike: () => ({ limit: () => Promise.resolve({ data: rows, error }) }),
    }),
  }));
}

/** One Open Food Facts product, in their response shape. */
function offProduct(name, { code = '1234567890123', brand = 'Tesco', kcal = 110 } = {}) {
  return {
    code,
    product_name: name,
    brands: brand,
    nutriments: {
      'energy-kcal_100g': kcal,
      proteins_100g: 24.3,
      carbohydrates_100g: 0,
      fat_100g: 1.1,
    },
  };
}

beforeEach(() => {
  supabaseMock.from.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchFoods with an empty foods table', () => {
  it('still returns results, because the table ships empty', async () => {
    // This is the whole bug. Before the Open Food Facts fallback existed, an
    // empty table meant an empty result for every possible search term.
    stubFoodsTable([]);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ products: [offProduct('Chicken breast fillets')] }),
    })));

    const result = await searchFoods('chicken breast', []);
    expect(result.success).toBe(true);
    expect(result.foods.length).toBeGreaterThan(0);
    expect(result.foods[0].name).toBe('Chicken breast fillets');
  });

  it('marks remote results as unsaved so the caller knows to persist them', async () => {
    stubFoodsTable([]);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ products: [offProduct('Chicken breast fillets')] }),
    })));

    const result = await searchFoods('chicken breast', []);
    expect(result.foods[0].id).toBeNull();
  });

  it('reports a search failure rather than pretending the food does not exist', async () => {
    stubFoodsTable([], { message: 'connection refused' });
    const result = await searchFoods('chicken', []);
    expect(result.success).toBe(false);
  });

  it('survives the food database being unreachable', async () => {
    stubFoodsTable([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    const result = await searchFoods('chicken', []);
    expect(result.success).toBe(true);
    expect(result.foods).toEqual([]);
    expect(result.remoteError).toBeTruthy();
  });
});

describe('searchFoods with a populated foods table', () => {
  const localRows = Array.from({ length: 10 }, (_, i) => ({
    id: `local-${i}`,
    name: `Chicken thing ${i}`,
    per_100g: { kcal: 100, protein: 20, carbs: 0, fat: 2 },
    verified: true,
  }));

  it('does not call out to the network when local results suffice', async () => {
    stubFoodsTable(localRows);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await searchFoods('chicken', []);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.remoteUsed).toBe(false);
  });

  it('puts local results ahead of remote ones', async () => {
    stubFoodsTable(localRows.slice(0, 2));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ products: [offProduct('Chicken breast, branded')] }),
    })));

    const result = await searchFoods('chicken', []);
    // Everything with an id comes before everything without one.
    const firstRemote = result.foods.findIndex(f => !f.id);
    const lastLocal = result.foods.map(f => Boolean(f.id)).lastIndexOf(true);
    expect(lastLocal).toBeLessThan(firstRemote);
  });

  it('does not offer a remote duplicate of a food already in the table', async () => {
    stubFoodsTable([{
      id: 'local-1',
      name: 'Chicken breast fillets',
      barcode: '1234567890123',
      per_100g: { kcal: 110, protein: 24, carbs: 0, fat: 1 },
    }]);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ products: [offProduct('Chicken breast fillets')] }),
    })));

    const result = await searchFoods('chicken breast', []);
    expect(result.foods).toHaveLength(1);
    expect(result.foods[0].id).toBe('local-1');
  });
});

describe('searchOpenFoodFacts', () => {
  it('ignores products with no energy figure', async () => {
    // §0.2 — a product that logs as zero kcal silently flatters the day.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        products: [
          offProduct('Has data', { code: '111', kcal: 250 }),
          offProduct('No data', { code: '222', kcal: 0 }),
        ],
      }),
    })));

    const result = await searchOpenFoodFacts('thing');
    expect(result.foods.map(f => f.name)).toEqual(['Has data']);
  });

  it('collapses the same product listed under several barcodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        products: [
          offProduct('Greek yoghurt', { code: '111' }),
          offProduct('Greek yoghurt', { code: '222' }),
        ],
      }),
    })));

    const result = await searchOpenFoodFacts('yoghurt');
    expect(result.foods).toHaveLength(1);
  });

  it('does not search on a fragment', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await searchOpenFoodFacts('ch');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.foods).toEqual([]);
  });
});

describe('validateCustomFood', () => {
  const good = { name: 'Sourdough loaf', kcal: 250, protein: 9, carbs: 48, fat: 2 };

  it('accepts a complete food', () => {
    expect(validateCustomFood(good).valid).toBe(true);
  });

  it('requires a name', () => {
    expect(validateCustomFood({ ...good, name: 'x' }).errors.name).toBeTruthy();
  });

  it('caps energy at what pure fat could supply', () => {
    // 1200 kcal/100 g is not a food, it is a per-serving figure in the wrong box.
    expect(validateCustomFood({ ...good, kcal: 1200 }).errors.kcal).toBeTruthy();
  });

  it('rejects negative macros', () => {
    // USDA carbs-by-difference can come back negative; nothing may reach the
    // database that way, because portions scale linearly off these figures.
    expect(validateCustomFood({ ...good, carbs: -5 }).errors.carbs).toBeTruthy();
  });

  it('rejects macros that cannot fit in 100 g', () => {
    const result = validateCustomFood({ ...good, protein: 50, carbs: 50, fat: 50 });
    expect(result.valid).toBe(false);
    expect(result.errors._form).toMatch(/150 g/);
  });

  it('allows a zero-calorie food', () => {
    // Black coffee, herbal tea, water. A floor of zero, not of one.
    expect(validateCustomFood({ name: 'Black coffee', kcal: 0 }).valid).toBe(true);
  });
});

describe('createCustomFood', () => {
  it('does not write when validation fails', async () => {
    const insert = vi.fn();
    supabaseMock.from.mockImplementation(() => ({ insert }));

    const result = await createCustomFood({ name: 'x', kcal: 5000 }, 'user-a');
    expect(result.success).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it('stores hand entry as custom and unverified', async () => {
    const captured = [];
    supabaseMock.from.mockImplementation(() => ({
      insert: (row) => {
        captured.push(row);
        return { select: () => ({ single: async () => ({ data: { ...row, id: 'f1' }, error: null }) }) };
      },
    }));

    await createCustomFood(
      { name: 'Sourdough loaf', kcal: 250, protein: 9, carbs: 48, fat: 2 },
      'user-a'
    );

    expect(captured[0].source).toBe('custom');
    expect(captured[0].verified).toBe(false);
    expect(captured[0].per_100g.kcal).toBe(250);
    expect(captured[0].created_by).toBe('user-a');
  });
});
