/**
 * @vitest-environment jsdom
 *
 * Fitness module — input validation and set logging
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

const { validateSet, logSet, renderSetForm } = await import('../js/fitness-module.js');

const valid = { exercise_id: 'ex-1', weight_kg: 100, reps: 5, rir: 2, side: 'both' };

describe('validateSet', () => {
  it('accepts a complete set', () => {
    expect(validateSet(valid).valid).toBe(true);
  });

  it('accepts a set with no reps in reserve recorded', () => {
    expect(validateSet({ ...valid, rir: '' }).valid).toBe(true);
    expect(validateSet({ ...valid, rir: null }).valid).toBe(true);
  });

  it('accepts bodyweight work at zero kilos', () => {
    expect(validateSet({ ...valid, weight_kg: 0 }).valid).toBe(true);
  });

  it('requires an exercise', () => {
    expect(validateSet({ ...valid, exercise_id: '' }).errors.exercise_id).toBeTruthy();
  });

  it('rejects an implausible weight', () => {
    expect(validateSet({ ...valid, weight_kg: 501 }).errors.weight_kg).toBeTruthy();
    expect(validateSet({ ...valid, weight_kg: -1 }).errors.weight_kg).toBeTruthy();
    expect(validateSet({ ...valid, weight_kg: 'heavy' }).errors.weight_kg).toBeTruthy();
  });

  it('rejects fractional or absent reps', () => {
    expect(validateSet({ ...valid, reps: 5.5 }).errors.reps).toBeTruthy();
    expect(validateSet({ ...valid, reps: 0 }).errors.reps).toBeTruthy();
    expect(validateSet({ ...valid, reps: undefined }).errors.reps).toBeTruthy();
  });

  it('rejects reps in reserve outside 0 to 5', () => {
    expect(validateSet({ ...valid, rir: 6 }).errors.rir).toBeTruthy();
    expect(validateSet({ ...valid, rir: -1 }).errors.rir).toBeTruthy();
  });

  it('rejects an unknown side', () => {
    expect(validateSet({ ...valid, side: 'middle' }).errors.side).toBeTruthy();
  });
});

describe('logSet', () => {
  beforeEach(() => {
    supabaseMock.from.mockReset();
  });

  function stubInsert({ error = null } = {}) {
    const captured = [];
    supabaseMock.from.mockImplementation(() => ({
      insert: (row) => {
        captured.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: error ? null : row, error }),
          }),
        };
      },
    }));
    return captured;
  }

  it('writes a client-generated id so a retry cannot double-insert', async () => {
    const captured = stubInsert();
    const result = await logSet(valid, 'user-a', 'session-1');

    expect(result.success).toBe(true);
    expect(captured[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured[0].session_id).toBe('session-1');
    expect(captured[0].user_id).toBe('user-a');
  });

  it('stores an unrecorded RIR as null rather than zero', async () => {
    const captured = stubInsert();
    await logSet({ ...valid, rir: '' }, 'user-a', 'session-1');
    expect(captured[0].rir).toBeNull();
  });

  it('preserves a recorded RIR of zero', async () => {
    const captured = stubInsert();
    await logSet({ ...valid, rir: 0 }, 'user-a', 'session-1');
    expect(captured[0].rir).toBe(0);
  });

  it('defaults the side to both', async () => {
    const captured = stubInsert();
    await logSet({ ...valid, side: undefined }, 'user-a', 'session-1');
    expect(captured[0].side).toBe('both');
  });

  it('rejects an invalid set without touching the database', async () => {
    const captured = stubInsert();
    const result = await logSet({ ...valid, reps: 0 }, 'user-a', 'session-1');
    expect(result.success).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('surfaces a write failure', async () => {
    stubInsert({ error: { message: 'boom' } });
    const result = await logSet(valid, 'user-a', 'session-1');
    expect(result.success).toBe(false);
    expect(result.errors._form).toBeTruthy();
  });
});

describe('renderSetForm', () => {
  const exercises = [
    { id: 'ex-1', name: 'Bench press', restricted_for: [] },
    { id: 'ex-2', name: 'Overhead press', restricted_for: ['user-a'] },
  ];

  it('omits exercises the person cannot currently do', () => {
    const mount = document.createElement('div');
    renderSetForm(mount, exercises, 'user-a');

    const options = [...mount.querySelectorAll('#set-exercise option')].map(o => o.textContent.trim());
    expect(options).toContain('Bench press');
    expect(options).not.toContain('Overhead press');
  });

  it('offers a restricted exercise to the other partner', () => {
    const mount = document.createElement('div');
    renderSetForm(mount, exercises, 'user-b');
    const options = [...mount.querySelectorAll('#set-exercise option')].map(o => o.textContent.trim());
    expect(options).toContain('Overhead press');
  });

  it('shows a live 1RM estimate as the numbers are typed', () => {
    const mount = document.createElement('div');
    renderSetForm(mount, exercises, 'user-a');

    mount.querySelector('#set-weight').value = '100';
    mount.querySelector('#set-reps').value = '5';
    mount.querySelector('#set-reps').dispatchEvent(new Event('input'));

    expect(mount.querySelector('#set-estimate').textContent).toMatch(/Estimated 1RM/);
  });

  it('says so rather than showing a number it does not trust', () => {
    const mount = document.createElement('div');
    renderSetForm(mount, exercises, 'user-a');

    mount.querySelector('#set-weight').value = '40';
    mount.querySelector('#set-reps').value = '20';
    mount.querySelector('#set-reps').dispatchEvent(new Event('input'));

    expect(mount.querySelector('#set-estimate').textContent).toMatch(/not worth showing/);
  });
});
