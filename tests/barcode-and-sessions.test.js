/**
 * @vitest-environment jsdom
 *
 * Barcode lookup (§3.6) and timed training sessions (§4.5)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const supabaseMock = { from: vi.fn() };
vi.mock('../js/supabase-client.js', () => ({
  supabase: supabaseMock,
  withAuthGuard: (operation) => operation(),
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-a' })),
  getPartner: vi.fn(() => ({ id: 'user-b' })),
}));

const { findByBarcode, lookupOpenFoodFacts, canScanBarcode } = await import('../js/food-diary.js');
const { sessionHours } = await import('../js/fitness-module.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('findByBarcode', () => {
  beforeEach(() => supabaseMock.from.mockReset());

  function stubLookup(food) {
    supabaseMock.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: food, error: null }) }) }),
    }));
  }

  it('returns a known product', async () => {
    stubLookup({ id: 'food-1', name: 'Beans' });
    const result = await findByBarcode('5000157024671');
    expect(result.food.name).toBe('Beans');
  });

  it('reports a miss without erroring', async () => {
    stubLookup(null);
    const result = await findByBarcode('5000157024671');
    expect(result.success).toBe(true);
    expect(result.food).toBeNull();
  });

  it('rejects anything that is not a barcode before querying', async () => {
    const result = await findByBarcode('chicken');
    expect(result.success).toBe(false);
    expect(supabaseMock.from).not.toHaveBeenCalled();
  });
});

describe('lookupOpenFoodFacts', () => {
  const product = (over = {}) => ({
    status: 1,
    product: {
      product_name: 'Baked beans',
      brands: 'Heinz, Kraft',
      serving_quantity: '200',
      nutriments: {
        'energy-kcal_100g': 78, proteins_100g: 4.7, carbohydrates_100g: 12.9,
        fat_100g: 0.2, fiber_100g: 3.7, sugars_100g: 4.7, salt_100g: 0.6,
      },
      ...over,
    },
  });

  it('maps the per-100 g figures straight across', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(product()) })));
    const result = await lookupOpenFoodFacts('5000157024671');

    expect(result.success).toBe(true);
    expect(result.draft.per_100g.kcal).toBe(78);
    expect(result.draft.per_100g.protein).toBe(4.7);
  });

  it('takes only the first brand', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(product()) })));
    const result = await lookupOpenFoodFacts('5000157024671');
    expect(result.draft.brand).toBe('Heinz');
  });

  it('marks the entry unverified so its origin is clear', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(product()) })));
    const result = await lookupOpenFoodFacts('5000157024671');
    expect(result.draft.verified).toBe(false);
    expect(result.draft.source).toBe('off');
  });

  it('refuses a product with no energy figure rather than logging zero', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve(product({ nutriments: {} })),
    })));
    const result = await lookupOpenFoodFacts('5000157024671');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no nutrition data/);
  });

  it('handles an unknown product', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 0 }) })));
    expect((await lookupOpenFoodFacts('0000000000000')).success).toBe(false);
  });

  it('handles the network being unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const result = await lookupOpenFoodFacts('5000157024671');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Could not reach/);
  });

  it('validates the barcode before going near the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await lookupOpenFoodFacts('abc');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('canScanBarcode', () => {
  // This used to assert false whenever BarcodeDetector was missing, which is
  // the case on every iPhone — so the scan button never rendered there at all.
  // The detector is polyfilled now, so the question is whether a camera can be
  // asked for, not whether this browser happens to ship the API.
  it('is false without a camera API', () => {
    // jsdom provides no navigator.mediaDevices.
    expect(canScanBarcode()).toBe(false);
  });

  it('is true where a camera can be requested, with no native BarcodeDetector', () => {
    const originalMediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: () => Promise.resolve({}) },
      configurable: true,
    });
    expect('BarcodeDetector' in window).toBe(false);

    try {
      expect(canScanBarcode()).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true,
      });
    }
  });
});

describe('sessionHours', () => {
  it('measures a closed session', () => {
    expect(sessionHours({
      started_at: '2026-08-10T18:00:00Z',
      ended_at: '2026-08-10T19:30:00Z',
    })).toBeCloseTo(1.5, 5);
  });

  it('returns nothing for a session still running', () => {
    expect(sessionHours({ started_at: '2026-08-10T18:00:00Z', ended_at: null })).toBeNull();
  });

  it('caps a session someone forgot to close', () => {
    expect(sessionHours({
      started_at: '2026-08-10T08:00:00Z',
      ended_at: '2026-08-10T22:00:00Z',
    })).toBe(3);
  });

  it('rejects an end before the start', () => {
    expect(sessionHours({
      started_at: '2026-08-10T19:00:00Z',
      ended_at: '2026-08-10T18:00:00Z',
    })).toBeNull();
  });

  it('returns nothing without a session', () => {
    expect(sessionHours(null)).toBeNull();
  });
});
