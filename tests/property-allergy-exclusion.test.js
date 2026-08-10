/**
 * Property-based test: Allergy exclusion list is the union of both partners
 * **Validates: Requirements 8.2, 10.3**
 *
 * For any two sets of partner allergies, the merged exclusion list used for
 * recipe generation must contain every allergy from both partners (the set union).
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock dependencies before importing recipe-generator
vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn(), functions: { invoke: vi.fn() } },
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', name: 'Test' })),
  getPartner: vi.fn(() => ({ id: 'user-456', name: 'Partner' })),
}));
vi.mock('../js/dietary-preferences.js', () => ({
  getBothPreferences: vi.fn(),
}));
vi.mock('../js/pantry-module.js', () => ({
  fetchValidPantryItems: vi.fn(),
}));

import { mergeAllergies } from '../js/recipe-generator.js';

// --- Arbitraries ---

/** Generate an arbitrary allergy string (printable, may contain spaces/mixed case) */
const allergyArb = fc.string({ minLength: 1, maxLength: 20 });

/** Generate an array of allergy strings */
const allergyArrayArb = fc.array(allergyArb, { minLength: 0, maxLength: 15 });

/** Generate a preferences object with allergies */
const prefsArb = allergyArrayArb.map(allergies => ({ allergies }));

describe('Property 10: Allergy exclusion list is the union of both partners', () => {
  it('every allergy from partner A (after lowercase/trim) is present in the merged list', () => {
    fc.assert(
      fc.property(prefsArb, prefsArb, (prefsA, prefsB) => {
        const merged = mergeAllergies(prefsA, prefsB);

        for (const allergy of prefsA.allergies) {
          const normalized = allergy.toLowerCase().trim();
          if (normalized.length > 0) {
            expect(merged).toContain(normalized);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('every allergy from partner B (after lowercase/trim) is present in the merged list', () => {
    fc.assert(
      fc.property(prefsArb, prefsArb, (prefsA, prefsB) => {
        const merged = mergeAllergies(prefsA, prefsB);

        for (const allergy of prefsB.allergies) {
          const normalized = allergy.toLowerCase().trim();
          if (normalized.length > 0) {
            expect(merged).toContain(normalized);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('the merged list has no duplicates', () => {
    fc.assert(
      fc.property(prefsArb, prefsArb, (prefsA, prefsB) => {
        const merged = mergeAllergies(prefsA, prefsB);
        const unique = new Set(merged);
        expect(merged.length).toBe(unique.size);
      }),
      { numRuns: 100 }
    );
  });

  it('the merged list contains no empty strings', () => {
    fc.assert(
      fc.property(prefsArb, prefsArb, (prefsA, prefsB) => {
        const merged = mergeAllergies(prefsA, prefsB);
        for (const item of merged) {
          expect(item.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });
});
