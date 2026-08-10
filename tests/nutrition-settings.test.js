/**
 * @vitest-environment jsdom
 *
 * Nutrition settings and portion split rendering
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const supabaseMock = { from: vi.fn() };
vi.mock('../js/supabase-client.js', () => ({
  supabase: supabaseMock,
  withAuthGuard: (operation) => operation(),
}));
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
  getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' })),
}));

const { validateProfile, saveBodyWeight } = await import('../js/nutrition-settings.js');
const { normaliseServing } = await import('../js/portion-split.js');

const valid = {
  sex: 'male',
  height_cm: 180,
  birth_date: '1995-06-01',
  goal_weight_kg: 95,
  goal_rate_kg_per_week: -0.5,
};

describe('validateProfile', () => {
  it('accepts a complete profile', () => {
    expect(validateProfile(valid).valid).toBe(true);
  });

  it('accepts a profile with no goal weight', () => {
    expect(validateProfile({ ...valid, goal_weight_kg: '' }).valid).toBe(true);
  });

  it('requires sex, because the BMR formula differs by it', () => {
    const result = validateProfile({ ...valid, sex: '' });
    expect(result.errors.sex).toBeTruthy();
  });

  it('rejects an implausible height', () => {
    expect(validateProfile({ ...valid, height_cm: 90 }).errors.height_cm).toBeTruthy();
    expect(validateProfile({ ...valid, height_cm: 260 }).errors.height_cm).toBeTruthy();
  });

  it('rejects a missing or malformed date of birth', () => {
    expect(validateProfile({ ...valid, birth_date: '' }).errors.birth_date).toBeTruthy();
    expect(validateProfile({ ...valid, birth_date: '01/06/1995' }).errors.birth_date).toBeTruthy();
  });

  it('rejects a date of birth implying an impossible age', () => {
    expect(validateProfile({ ...valid, birth_date: '2025-01-01' }).errors.birth_date).toBeTruthy();
    expect(validateProfile({ ...valid, birth_date: '1850-01-01' }).errors.birth_date).toBeTruthy();
  });

  it('rejects a rate outside the safe range', () => {
    expect(validateProfile({ ...valid, goal_rate_kg_per_week: -2 }).errors.goal_rate_kg_per_week).toBeTruthy();
    expect(validateProfile({ ...valid, goal_rate_kg_per_week: 2 }).errors.goal_rate_kg_per_week).toBeTruthy();
  });

  it('allows maintenance', () => {
    expect(validateProfile({ ...valid, goal_rate_kg_per_week: 0 }).valid).toBe(true);
  });
});

describe('saveBodyWeight', () => {
  beforeEach(() => supabaseMock.from.mockReset());

  it('rejects an implausible weight without writing', async () => {
    const result = await saveBodyWeight(5, 'user-a');
    expect(result.success).toBe(false);
    expect(supabaseMock.from).not.toHaveBeenCalled();
  });

  it('upserts a valid weight', async () => {
    const captured = [];
    supabaseMock.from.mockImplementation(() => ({
      upsert: (row) => { captured.push(row); return Promise.resolve({ error: null }); },
    }));

    const result = await saveBodyWeight(116, 'user-a');
    expect(result.success).toBe(true);
    expect(captured[0].setting_key).toBe('body_weight_kg');
    expect(captured[0].setting_value).toBe('116');
  });
});

describe('normaliseServing', () => {
  it('reads the generator\'s flat shape', () => {
    const result = normaliseServing({
      calories: 600, protein_g: 45, carbs_g: 50, fats_g: 20,
    });
    expect(result.kcal).toBe(600);
    expect(result.protein).toBe(45);
    expect(result.fat).toBe(20);
  });

  it('reads a nested macros object', () => {
    const result = normaliseServing({
      macros: { kcal: 500, protein: 40, carbs: 30, fat: 15 },
    });
    expect(result.kcal).toBe(500);
    expect(result.carbs).toBe(30);
  });

  it('reads a per-serving object', () => {
    expect(normaliseServing({ per_serving: { kcal: 400 } }).kcal).toBe(400);
  });

  it('returns nothing without a calorie figure', () => {
    expect(normaliseServing({ protein_g: 40 })).toBeNull();
    expect(normaliseServing({ calories: 0 })).toBeNull();
    expect(normaliseServing(null)).toBeNull();
  });

  it('treats a missing macro as zero rather than NaN', () => {
    const result = normaliseServing({ calories: 600 });
    expect(result.protein).toBe(0);
    expect(result.carbs).toBe(0);
    expect(result.fat).toBe(0);
  });
});
