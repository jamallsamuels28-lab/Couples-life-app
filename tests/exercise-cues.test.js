/**
 * @vitest-environment jsdom
 *
 * Form cues.
 *
 * These are written for this app rather than imported, which is the point of
 * the tests below: the matching has to be specific enough that a lift gets its
 * own cues rather than a near neighbour's. A Romanian deadlift told to "push
 * the floor away" is worse than no cues at all.
 */
import { describe, it, expect } from 'vitest';

const { cuesFor, cueCount } = await import('../js/exercise-cues.js');

describe('cuesFor', () => {
  it('matches a plain lift name', () => {
    const cues = cuesFor('Deadlift');
    expect(cues).not.toBeNull();
    expect(cues.setup.join(' ')).toMatch(/mid-foot/);
  });

  it('matches names carrying equipment prefixes', () => {
    // The library names come from a community database and are inconsistent.
    expect(cuesFor('Barbell Bench Press')).not.toBeNull();
    expect(cuesFor('Bench Press')).not.toBeNull();
    expect(cuesFor('Dumbbell Bench Press')).not.toBeNull();
  });

  it('gives a Romanian deadlift its own cues, not the deadlift ones', () => {
    // Both contain "deadlift". The RDL pattern is listed first for this reason
    // — the conventional pull's cues would actively mislead here.
    const rdl = cuesFor('Dumbbell Romanian Deadlift');
    const conventional = cuesFor('Deadlift');

    expect(rdl).not.toBe(conventional);
    expect(rdl.execution.join(' ')).toMatch(/hips backwards/i);
    expect(rdl.execution.join(' ')).not.toMatch(/push the floor away/i);
  });

  it('gives a front squat its own cues, not the back squat ones', () => {
    const front = cuesFor('Front Squat');
    expect(front.setup.join(' ')).toMatch(/elbows/i);
    expect(front).not.toBe(cuesFor('Back Squat'));
  });

  it('gives a split squat its own cues rather than the squat ones', () => {
    const split = cuesFor('Bulgarian split squats left');
    expect(split.setup.join(' ')).toMatch(/rear foot/i);
  });

  it('distinguishes incline from flat pressing', () => {
    const incline = cuesFor('Incline Bench Press - MP');
    expect(incline.setup.join(' ')).toMatch(/30 degrees/);
    expect(incline).not.toBe(cuesFor('Bench Press'));
  });

  it('returns null rather than filler for exercises with no cues', () => {
    // Generic advice attached to 700 exercises teaches the reader to skip the
    // section, which devalues the ones that are specific.
    expect(cuesFor('Cable crossover')).toBeNull();
    expect(cuesFor('Jumping jacks')).toBeNull();
  });

  it('handles missing or empty names', () => {
    expect(cuesFor(undefined)).toBeNull();
    expect(cuesFor('')).toBeNull();
    expect(cuesFor('   ')).toBeNull();
  });

  it('gives every cue set all three sections, none empty', () => {
    const names = [
      'Deadlift', 'Romanian Deadlift', 'Back Squat', 'Front Squat',
      'Bench Press', 'Incline Bench Press', 'Overhead Press', 'Pull-up',
      'Barbell Row', 'Lat Pulldown', 'Hip Thrust', 'Dip', 'Press-up',
      'Face pull', 'Farmer\'s carry', 'Leg press', 'Good morning',
      'Bulgarian split squat',
    ];

    for (const name of names) {
      const cues = cuesFor(name);
      expect(cues, `${name} has no cues`).not.toBeNull();
      for (const section of ['setup', 'execution', 'faults']) {
        expect(Array.isArray(cues[section]), `${name}.${section} not an array`).toBe(true);
        expect(cues[section].length, `${name}.${section} is empty`).toBeGreaterThan(0);
        for (const line of cues[section]) {
          expect(typeof line).toBe('string');
          expect(line.trim().length, `${name}.${section} has a blank line`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('covers a meaningful number of lifts', () => {
    expect(cueCount()).toBeGreaterThanOrEqual(15);
  });
});
