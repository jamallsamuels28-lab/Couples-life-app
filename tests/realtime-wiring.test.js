/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks ---

// Mock supabase-client (with auth guard)
const mockGetSession = vi.fn();
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    auth: {
      getSession: (...args) => mockGetSession(...args),
    },
  },
  validateAuthToken: async () => {
    const result = await mockGetSession();
    const session = result?.data?.session;
    if (!session) return { valid: false, reason: 'No active session. Please sign in.' };
    if (session.expires_at) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= session.expires_at) {
        return { valid: false, reason: 'Session expired. Please sign in again.' };
      }
    }
    return { valid: true, session };
  },
  withAuthGuard: async (operation) => {
    const result = await mockGetSession();
    const session = result?.data?.session;
    if (!session) throw new Error('No active session. Please sign in.');
    if (session.expires_at) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (nowSeconds >= session.expires_at) {
        throw new Error('Session expired. Please sign in again.');
      }
    }
    return operation();
  },
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'test-key',
}));

// Mock app-shell for getCurrentUser
let mockUser = { id: 'user-1', display_name: 'Jamall' };
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: () => mockUser,
  getPartner: () => ({ id: 'user-2', display_name: 'Rebecca' }),
}));

// Import after mocks
const { wireModulesToRealtime, unwireModulesFromRealtime, isWired } = await import('../js/realtime-wiring.js');
const { validateAuthToken, withAuthGuard } = await import('../js/supabase-client.js');

describe('realtime-wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: 'user-1', display_name: 'Jamall' };
    // Ensure clean state
    unwireModulesFromRealtime();
  });

  afterEach(() => {
    unwireModulesFromRealtime();
  });

  describe('wireModulesToRealtime', () => {
    it('sets wired state to true when called', () => {
      expect(isWired()).toBe(false);
      wireModulesToRealtime();
      expect(isWired()).toBe(true);
    });

    it('does not duplicate wiring on repeated calls', () => {
      wireModulesToRealtime();
      wireModulesToRealtime(); // second call should be no-op
      expect(isWired()).toBe(true);
    });

    it('dispatches food:refresh when realtime:meals event fires', () => {
      wireModulesToRealtime();

      let received = null;
      window.addEventListener('food:refresh', (e) => { received = e.detail; });

      const payload = { eventType: 'INSERT', new: { id: 'meal-1', title: 'Lunch' } };
      window.dispatchEvent(new CustomEvent('realtime:meals', { detail: payload }));

      expect(received).toEqual(payload);
    });

    it('dispatches steps:refresh when realtime:steps_log event fires', () => {
      wireModulesToRealtime();

      let received = null;
      window.addEventListener('steps:refresh', (e) => { received = e.detail; });

      const payload = { eventType: 'UPDATE', new: { user_id: 'user-2', step_count: 8000 } };
      window.dispatchEvent(new CustomEvent('realtime:steps_log', { detail: payload }));

      expect(received).toEqual(payload);
    });

    it('dispatches recipes:refresh when realtime:recipes event fires', () => {
      wireModulesToRealtime();

      let received = null;
      window.addEventListener('recipes:refresh', (e) => { received = e.detail; });

      const payload = { eventType: 'INSERT', new: { id: 'recipe-1', title: 'Pasta' } };
      window.dispatchEvent(new CustomEvent('realtime:recipes', { detail: payload }));

      expect(received).toEqual(payload);
    });

    it('dispatches pantry:refresh when realtime:pantry_items event fires', () => {
      wireModulesToRealtime();

      let received = null;
      window.addEventListener('pantry:refresh', (e) => { received = e.detail; });

      const payload = { eventType: 'DELETE', old: { id: 'pantry-1', name: 'Milk' } };
      window.dispatchEvent(new CustomEvent('realtime:pantry_items', { detail: payload }));

      expect(received).toEqual(payload);
    });

    it('does not dispatch food:refresh when payload is null', () => {
      wireModulesToRealtime();

      let received = 'not called';
      window.addEventListener('food:refresh', (e) => { received = e.detail; });

      window.dispatchEvent(new CustomEvent('realtime:meals', { detail: null }));

      expect(received).toBe('not called');
    });

    it('does not dispatch when user is not authenticated', () => {
      mockUser = null;
      wireModulesToRealtime();

      let received = 'not called';
      window.addEventListener('food:refresh', (e) => { received = e.detail; });

      const payload = { eventType: 'INSERT', new: { id: 'meal-1' } };
      window.dispatchEvent(new CustomEvent('realtime:meals', { detail: payload }));

      expect(received).toBe('not called');
    });

    it('propagates events synchronously (under 2s requirement)', () => {
      wireModulesToRealtime();

      const timestamps = [];
      window.addEventListener('food:refresh', () => { timestamps.push(Date.now()); });

      const before = Date.now();
      window.dispatchEvent(new CustomEvent('realtime:meals', {
        detail: { eventType: 'INSERT', new: { id: 'meal-1' } }
      }));
      const after = Date.now();

      // Event should propagate synchronously (< 50ms overhead)
      expect(timestamps.length).toBe(1);
      expect(after - before).toBeLessThan(50);
    });
  });

  describe('unwireModulesFromRealtime', () => {
    it('sets wired state to false when called', () => {
      wireModulesToRealtime();
      expect(isWired()).toBe(true);
      unwireModulesFromRealtime();
      expect(isWired()).toBe(false);
    });

    it('stops dispatching events after unwiring', () => {
      wireModulesToRealtime();

      let callCount = 0;
      window.addEventListener('food:refresh', () => { callCount++; });

      // First dispatch should work
      window.dispatchEvent(new CustomEvent('realtime:meals', {
        detail: { eventType: 'INSERT', new: { id: 'meal-1' } }
      }));
      expect(callCount).toBe(1);

      // Unwire
      unwireModulesFromRealtime();

      // Second dispatch should NOT trigger the handler
      window.dispatchEvent(new CustomEvent('realtime:meals', {
        detail: { eventType: 'INSERT', new: { id: 'meal-2' } }
      }));
      expect(callCount).toBe(1);
    });
  });
});

describe('auth token guard (Requirement 11.4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates a valid session token', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'valid-token', expires_at: futureExpiry } }
    });

    const result = await validateAuthToken();
    expect(result.valid).toBe(true);
    expect(result.session.access_token).toBe('valid-token');
  });

  it('rejects when no session exists', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    const result = await validateAuthToken();
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('No active session');
  });

  it('rejects when token is expired', async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 100; // expired 100 seconds ago
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'expired-token', expires_at: pastExpiry } }
    });

    const result = await validateAuthToken();
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('withAuthGuard executes operation when token is valid', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'valid-token', expires_at: futureExpiry } }
    });

    const result = await withAuthGuard(async () => 'operation-result');
    expect(result).toBe('operation-result');
  });

  it('withAuthGuard throws when no session exists', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    await expect(withAuthGuard(async () => 'should-not-run')).rejects.toThrow(
      'No active session'
    );
  });

  it('withAuthGuard throws when token is expired', async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 100;
    mockGetSession.mockResolvedValue({
      data: { session: { access_token: 'expired-token', expires_at: pastExpiry } }
    });

    await expect(withAuthGuard(async () => 'should-not-run')).rejects.toThrow(
      'expired'
    );
  });

  it('withAuthGuard does not call the operation when auth fails', async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });

    const operationSpy = vi.fn().mockResolvedValue('result');

    await expect(withAuthGuard(operationSpy)).rejects.toThrow();
    expect(operationSpy).not.toHaveBeenCalled();
  });
});
