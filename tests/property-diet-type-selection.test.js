/**
 * Property-based test: Restrictive diet type selection
 * **Validates: Requirements 8.3**
 *
 * For any pair of diet types from the two partners, the diet type selected for
 * recipe generation must be the more restrictive one according to the hierarchy:
 * vegan > vegetarian > halal > keto > flexible.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';

// Mock dependencies before importing recipe-generator
vi.mock('../js/supabase-client.js', () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', name: 'Test' })),
  getPartner: vi.fn(() => ({ id: 'user-456', name: 'Partner' })),
}));
vi.mock('../js/dietary-preferences.js', () => ({
  getBothPreferences: vi.fn(() => Promise.resolve({ user: null, partner: null })),
}));
vi.mock('../js/pantry-module.js', () => ({
  fetchValidPantryItems: vi.fn(() => Promise.resolve({ success: true, data: [] })),
}));

import { selectDietType, DIET_HIERARCHY } from '../js/recipe-generator.js';

// --- Arbitraries ---

/** Arbitrary that produces a valid diet type from the hierarchy */
const validDietTypeArb = fc.constantFrom(...DIET_HIERARCHY);

/** Arbitrary that produces an invalid/unknown diet type string */
const invalidDietTypeArb = fc.constantFrom(
  'paleo', 'carnivore', 'raw', 'fruitarian', '', 'VEGAN', 'Vegetarian', null, undefined, 42
);

/** Arbitrary that produces either a valid or invalid diet type */
const anyDietTypeArb = fc.oneof(validDietTypeArb, invalidDietTypeArb);

describe('Property: Restrictive diet type selection', () => {
  it('1. The result is always a valid diet type from the hierarchy', () => {
    fc.assert(
      fc.property(anyDietTypeArb, anyDietTypeArb, (typeA, typeB) => {
        const result = selectDietType(typeA, typeB);
        expect(DIET_HIERARCHY).toContain(result);
      }),
      { numRuns: 200 }
    );
  });

  it('2. The result has an index <= both partners\' types in the hierarchy (at least as restrictive)', () => {
    fc.assert(
      fc.property(validDietTypeArb, validDietTypeArb, (typeA, typeB) => {
        const result = selectDietType(typeA, typeB);
        const resultIndex = DIET_HIERARCHY.indexOf(result);
        const indexA = DIET_HIERARCHY.indexOf(typeA);
        const indexB = DIET_HIERARCHY.indexOf(typeB);

        // Result must be at least as restrictive (lower or equal index) as both inputs
        expect(resultIndex).toBeLessThanOrEqual(indexA);
        expect(resultIndex).toBeLessThanOrEqual(indexB);
      }),
      { numRuns: 200 }
    );
  });

  it('3. The result equals one of the two input types (or flexible if both are invalid)', () => {
    fc.assert(
      fc.property(anyDietTypeArb, anyDietTypeArb, (typeA, typeB) => {
        const result = selectDietType(typeA, typeB);

        // Normalize inputs: invalid types become 'flexible'
        const normalizedA = DIET_HIERARCHY.includes(typeA) ? typeA : 'flexible';
        const normalizedB = DIET_HIERARCHY.includes(typeB) ? typeB : 'flexible';

        // Result must be one of the two normalized types
        expect([normalizedA, normalizedB]).toContain(result);
      }),
      { numRuns: 200 }
    );
  });

  it('4. The function is symmetric: selectDietType(a, b) === selectDietType(b, a)', () => {
    fc.assert(
      fc.property(anyDietTypeArb, anyDietTypeArb, (typeA, typeB) => {
        const resultAB = selectDietType(typeA, typeB);
        const resultBA = selectDietType(typeB, typeA);
        expect(resultAB).toBe(resultBA);
      }),
      { numRuns: 200 }
    );
  });

  it('5. Invalid/unknown diet types are treated as flexible', () => {
    fc.assert(
      fc.property(invalidDietTypeArb, validDietTypeArb, (invalidType, validType) => {
        const result = selectDietType(invalidType, validType);

        // When paired with an invalid type (treated as 'flexible'),
        // the result should be the valid type (which is always at least as restrictive as flexible)
        expect(result).toBe(validType);
      }),
      { numRuns: 200 }
    );
  });
});
