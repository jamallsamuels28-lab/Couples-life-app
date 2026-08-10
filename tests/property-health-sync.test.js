/**
 * @vitest-environment jsdom
 */
/**
 * Property-Based Test: Health sync never decreases manual value
 * **Validates: Requirements 4.6**
 *
 * Tests the resolveStepConflict function to ensure that for any pair of
 * (healthSteps, existingSteps), the returned keepValue is always the higher
 * of the two — health sync never causes a decrease in the stored step count.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { resolveStepConflict } from '../js/steps-module.js';

// Mock supabase-client.js (required by steps-module.js import)
import { vi } from 'vitest';
vi.mock('../js/supabase-client.js', () => ({
  supabase: { from: vi.fn() }
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', display_name: 'Test' }))
}));

// Arbitrary for step counts within the valid range 0–200,000
const stepCountArb = fc.integer({ min: 0, max: 200000 });

// Arbitrary for health source strings
const healthSourceArb = fc.constantFrom('health_connect', 'apple_health');

describe('Property 7: Health sync never decreases manual value', () => {
  it('when existingSteps > healthSteps, keepValue must equal existingSteps (never decreased)', () => {
    fc.assert(
      fc.property(
        stepCountArb,
        stepCountArb,
        healthSourceArb,
        (healthSteps, existingSteps, healthSource) => {
          // Only test cases where existing manual value is strictly greater
          fc.pre(existingSteps > healthSteps);

          const result = resolveStepConflict(healthSteps, existingSteps, healthSource);

          expect(result.keepValue).toBe(existingSteps);
          expect(result.source).toBe('manual');
          expect(result.changed).toBe(false);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('when healthSteps > existingSteps, keepValue must equal healthSteps', () => {
    fc.assert(
      fc.property(
        stepCountArb,
        stepCountArb,
        healthSourceArb,
        (healthSteps, existingSteps, healthSource) => {
          // Only test cases where health value is strictly greater
          fc.pre(healthSteps > existingSteps);

          const result = resolveStepConflict(healthSteps, existingSteps, healthSource);

          expect(result.keepValue).toBe(healthSteps);
          expect(result.source).toBe(healthSource);
          expect(result.changed).toBe(true);
        }
      ),
      { numRuns: 500 }
    );
  });

  it('for ALL cases, keepValue >= Math.max(healthSteps, existingSteps || 0)', () => {
    fc.assert(
      fc.property(
        stepCountArb,
        fc.oneof(stepCountArb, fc.constant(null), fc.constant(undefined)),
        healthSourceArb,
        (healthSteps, existingSteps, healthSource) => {
          const result = resolveStepConflict(healthSteps, existingSteps, healthSource);

          const effectiveExisting = existingSteps || 0;
          const expectedMin = Math.max(healthSteps, effectiveExisting);

          expect(result.keepValue).toBeGreaterThanOrEqual(expectedMin);
        }
      ),
      { numRuns: 500 }
    );
  });
});
