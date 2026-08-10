/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { validateStepCount, validateDate, resolveStepConflict } from '../js/steps-module.js';

// Mock supabase-client.js
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      upsert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ data: { id: '123' }, error: null }))
        }))
      }))
    }))
  }
}));

// Mock app-shell.js
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: vi.fn(() => ({ id: 'user-123', display_name: 'Jamall' }))
}));

describe('steps-module', () => {
  describe('validateStepCount', () => {
    it('accepts 0 steps (minimum boundary)', () => {
      expect(validateStepCount(0)).toEqual({ valid: true });
    });

    it('accepts 200000 steps (maximum boundary)', () => {
      expect(validateStepCount(200000)).toEqual({ valid: true });
    });

    it('accepts a typical step count (10000)', () => {
      expect(validateStepCount(10000)).toEqual({ valid: true });
    });

    it('rejects negative step count', () => {
      const result = validateStepCount(-1);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Steps must be between 0 and 200,000');
    });

    it('rejects step count exceeding 200000', () => {
      const result = validateStepCount(200001);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Steps must be between 0 and 200,000');
    });

    it('rejects non-integer values', () => {
      const result = validateStepCount(10000.5);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Steps must be between 0 and 200,000');
    });

    it('rejects NaN values', () => {
      const result = validateStepCount(NaN);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Steps must be between 0 and 200,000');
    });

    it('rejects string values that are not integers', () => {
      const result = validateStepCount('abc');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Steps must be between 0 and 200,000');
    });

    it('accepts string values that represent valid integers', () => {
      expect(validateStepCount('5000')).toEqual({ valid: true });
    });
  });

  describe('validateDate', () => {
    it('accepts today', () => {
      const today = new Date().toLocaleDateString('en-CA');
      expect(validateDate(today)).toEqual({ valid: true });
    });

    it('accepts a past date', () => {
      expect(validateDate('2024-01-01')).toEqual({ valid: true });
    });

    it('rejects a future date', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString('en-CA');
      const result = validateDate(tomorrowStr);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Future dates are not allowed');
    });

    it('rejects an invalid date string', () => {
      const result = validateDate('not-a-date');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid date');
    });
  });

  describe('logSteps', () => {
    let logSteps;
    let mockSupabase;
    let mockGetCurrentUser;

    beforeEach(async () => {
      vi.resetModules();

      mockSupabase = {
        from: vi.fn()
      };

      mockGetCurrentUser = vi.fn(() => ({ id: 'user-123', display_name: 'Jamall' }));

      vi.doMock('../js/supabase-client.js', () => ({
        supabase: mockSupabase
      }));

      vi.doMock('../js/app-shell.js', () => ({
        getCurrentUser: mockGetCurrentUser
      }));

      const module = await import('../js/steps-module.js');
      logSteps = module.logSteps;
    });

    it('returns validation error for future date', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toLocaleDateString('en-CA');

      const result = await logSteps(tomorrowStr, 5000);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Future dates are not allowed');
      expect(result.field).toBe('date');
    });

    it('returns validation error for invalid step count', async () => {
      const today = new Date().toLocaleDateString('en-CA');
      const result = await logSteps(today, -100);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Steps must be between 0 and 200,000');
      expect(result.field).toBe('steps');
    });

    it('returns error when user is not authenticated', async () => {
      mockGetCurrentUser.mockReturnValue(null);
      const today = new Date().toLocaleDateString('en-CA');
      const result = await logSteps(today, 5000);
      expect(result.success).toBe(false);
      expect(result.error).toBe('Not authenticated');
    });

    it('calls supabase upsert with correct parameters on valid input', async () => {
      const today = new Date().toLocaleDateString('en-CA');
      const mockSingle = vi.fn(() => Promise.resolve({ data: { id: 'entry-1' }, error: null }));
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockUpsert = vi.fn(() => ({ select: mockSelect }));
      mockSupabase.from.mockReturnValue({ upsert: mockUpsert });

      const result = await logSteps(today, 8500);

      expect(result.success).toBe(true);
      expect(mockSupabase.from).toHaveBeenCalledWith('steps_log');
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          log_date: today,
          step_count: 8500,
          source: 'manual'
        }),
        { onConflict: 'user_id,log_date' }
      );
    });

    it('returns error when supabase upsert fails', async () => {
      const today = new Date().toLocaleDateString('en-CA');
      const mockSingle = vi.fn(() => Promise.resolve({ data: null, error: { message: 'DB error' } }));
      const mockSelect = vi.fn(() => ({ single: mockSingle }));
      const mockUpsert = vi.fn(() => ({ select: mockSelect }));
      mockSupabase.from.mockReturnValue({ upsert: mockUpsert });

      const result = await logSteps(today, 10000);
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  describe('renderStepLogForm', () => {
    let renderStepLogForm;

    beforeEach(async () => {
      vi.resetModules();

      vi.doMock('../js/supabase-client.js', () => ({
        supabase: { from: vi.fn() }
      }));

      vi.doMock('../js/app-shell.js', () => ({
        getCurrentUser: vi.fn(() => ({ id: 'user-123', display_name: 'Jamall' }))
      }));

      const module = await import('../js/steps-module.js');
      renderStepLogForm = module.renderStepLogForm;
    });

    it('renders form with date input, step count input, and submit button', () => {
      const container = document.createElement('div');
      renderStepLogForm(container);

      expect(container.querySelector('#step-date')).not.toBeNull();
      expect(container.querySelector('#step-count')).not.toBeNull();
      expect(container.querySelector('button[type="submit"]')).not.toBeNull();
    });

    it('defaults the date input to today', () => {
      const container = document.createElement('div');
      renderStepLogForm(container);

      const today = new Date().toLocaleDateString('en-CA');
      const dateInput = container.querySelector('#step-date');
      expect(dateInput.value).toBe(today);
    });

    it('has error message containers for both fields', () => {
      const container = document.createElement('div');
      renderStepLogForm(container);

      expect(container.querySelector('#step-date-error')).not.toBeNull();
      expect(container.querySelector('#step-count-error')).not.toBeNull();
    });

    it('uses input-num class for step count (monospace numeric font)', () => {
      const container = document.createElement('div');
      renderStepLogForm(container);

      const stepInput = container.querySelector('#step-count');
      expect(stepInput.classList.contains('input-num')).toBe(true);
    });

    it('has aria-describedby linking inputs to error messages', () => {
      const container = document.createElement('div');
      renderStepLogForm(container);

      const dateInput = container.querySelector('#step-date');
      expect(dateInput.getAttribute('aria-describedby')).toBe('step-date-error');

      const stepInput = container.querySelector('#step-count');
      expect(stepInput.getAttribute('aria-describedby')).toBe('step-count-error');
    });
  });

  describe('resolveStepConflict', () => {
    it('uses health value when no existing entry exists', () => {
      const result = resolveStepConflict(8000, null, 'health_connect');
      expect(result).toEqual({ keepValue: 8000, source: 'health_connect', changed: true });
    });

    it('uses health value when no existing entry (undefined)', () => {
      const result = resolveStepConflict(5000, undefined, 'apple_health');
      expect(result).toEqual({ keepValue: 5000, source: 'apple_health', changed: true });
    });

    it('overwrites with health value when health is higher', () => {
      const result = resolveStepConflict(12000, 8000, 'health_connect');
      expect(result).toEqual({ keepValue: 12000, source: 'health_connect', changed: true });
    });

    it('keeps manual value when manual is higher', () => {
      const result = resolveStepConflict(5000, 10000, 'health_connect');
      expect(result).toEqual({ keepValue: 10000, source: 'manual', changed: false });
    });

    it('keeps manual value when values are equal', () => {
      const result = resolveStepConflict(7500, 7500, 'apple_health');
      expect(result).toEqual({ keepValue: 7500, source: 'manual', changed: false });
    });

    it('uses apple_health as source when health value is higher', () => {
      const result = resolveStepConflict(15000, 10000, 'apple_health');
      expect(result).toEqual({ keepValue: 15000, source: 'apple_health', changed: true });
    });

    it('handles zero existing steps with positive health value', () => {
      const result = resolveStepConflict(3000, 0, 'health_connect');
      expect(result).toEqual({ keepValue: 3000, source: 'health_connect', changed: true });
    });

    it('keeps existing zero when health returns zero', () => {
      const result = resolveStepConflict(0, 0, 'health_connect');
      expect(result).toEqual({ keepValue: 0, source: 'manual', changed: false });
    });
  });

  describe('syncFromHealthAPI', () => {
    let syncFromHealthAPI;
    let mockSupabase;
    let mockGetCurrentUser;

    beforeEach(async () => {
      vi.resetModules();
      // Reset navigator.health
      delete navigator.health;
      delete window.webkit;

      mockSupabase = {
        from: vi.fn()
      };

      mockGetCurrentUser = vi.fn(() => ({ id: 'user-123', display_name: 'Jamall' }));

      vi.doMock('../js/supabase-client.js', () => ({
        supabase: mockSupabase
      }));

      vi.doMock('../js/app-shell.js', () => ({
        getCurrentUser: mockGetCurrentUser
      }));

      const module = await import('../js/steps-module.js');
      syncFromHealthAPI = module.syncFromHealthAPI;
    });

    it('returns unsupported message when no health API is available', async () => {
      const result = await syncFromHealthAPI();
      expect(result.synced).toBe(false);
      expect(result.reason).toContain('does not support health data sync');
      expect(result.reason).toContain('manually');
    });

    it('returns error when user is not authenticated', async () => {
      mockGetCurrentUser.mockReturnValue(null);
      const result = await syncFromHealthAPI();
      expect(result.synced).toBe(false);
      expect(result.reason).toBe('Not authenticated');
    });

    it('returns success and upserts when health API returns higher value', async () => {
      // Set up navigator.health
      Object.defineProperty(navigator, 'health', {
        value: {
          getSteps: vi.fn(() => Promise.resolve({ steps: 15000 }))
        },
        configurable: true
      });

      // Mock existing entry fetch (existing is 8000)
      // Chain: from('steps_log').select('step_count, source').eq('user_id', ...).eq('log_date', ...).maybeSingle()
      const mockMaybeSingle = vi.fn(() => Promise.resolve({
        data: { step_count: 8000, source: 'manual' },
        error: null
      }));
      const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
      const mockSelect = vi.fn(() => ({ eq: mockEq1 }));

      // Mock upsert
      const mockUpsertSingle = vi.fn(() => Promise.resolve({ data: { id: '123' }, error: null }));
      const mockUpsertSelect = vi.fn(() => ({ single: mockUpsertSingle }));
      const mockUpsert = vi.fn(() => ({ select: mockUpsertSelect }));

      let callCount = 0;
      mockSupabase.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // First call: select existing entry
          return { select: mockSelect };
        }
        // Second call: upsert
        return { upsert: mockUpsert };
      });

      const result = await syncFromHealthAPI();
      expect(result.synced).toBe(true);
      expect(result.stepCount).toBe(15000);
      expect(result.source).toBe('health_connect');
    });

    it('returns success with existing value when manual is higher', async () => {
      Object.defineProperty(navigator, 'health', {
        value: {
          getSteps: vi.fn(() => Promise.resolve({ steps: 3000 }))
        },
        configurable: true
      });

      // Existing entry is 10000 (higher than health)
      const mockMaybeSingle = vi.fn(() => Promise.resolve({
        data: { step_count: 10000, source: 'manual' },
        error: null
      }));
      const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
      const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
      const mockSelect = vi.fn(() => ({ eq: mockEq1 }));

      // Mock upsert (still called to persist the entry)
      const mockUpsertSingle = vi.fn(() => Promise.resolve({ data: { id: '123' }, error: null }));
      const mockUpsertSelect = vi.fn(() => ({ single: mockUpsertSingle }));
      const mockUpsert = vi.fn(() => ({ select: mockUpsertSelect }));

      let callCount = 0;
      mockSupabase.from.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { select: mockSelect };
        }
        return { upsert: mockUpsert };
      });

      const result = await syncFromHealthAPI();
      expect(result.synced).toBe(true);
      expect(result.stepCount).toBe(10000);
      expect(result.source).toBe('manual');
    });

    it('returns error when health API throws', async () => {
      Object.defineProperty(navigator, 'health', {
        value: {
          getSteps: vi.fn(() => Promise.reject(new Error('Permission denied')))
        },
        configurable: true
      });

      const result = await syncFromHealthAPI();
      expect(result.synced).toBe(false);
      expect(result.reason).toContain('Permission denied');
      expect(result.reason).toContain('existing entry remains unchanged');
    });

    it('returns error when health API returns no data', async () => {
      Object.defineProperty(navigator, 'health', {
        value: {
          getSteps: vi.fn(() => Promise.resolve(null))
        },
        configurable: true
      });

      const result = await syncFromHealthAPI();
      expect(result.synced).toBe(false);
      expect(result.reason).toContain('unsuccessful');
      expect(result.reason).toContain('existing entry remains unchanged');
    });
  });

  describe('renderStepLogForm - sync button', () => {
    let renderStepLogForm;

    beforeEach(async () => {
      vi.resetModules();

      vi.doMock('../js/supabase-client.js', () => ({
        supabase: { from: vi.fn() }
      }));

      vi.doMock('../js/app-shell.js', () => ({
        getCurrentUser: vi.fn(() => ({ id: 'user-123', display_name: 'Jamall' }))
      }));

      const module = await import('../js/steps-module.js');
      renderStepLogForm = module.renderStepLogForm;
    });

    it('renders a Sync from Health button', () => {
      const container = document.createElement('div');
      renderStepLogForm(container);

      const syncBtn = container.querySelector('#sync-health-btn');
      expect(syncBtn).not.toBeNull();
      expect(syncBtn.textContent).toBe('Sync from Health');
      expect(syncBtn.type).toBe('button');
    });

    it('renders a sync error message container', () => {
      const container = document.createElement('div');
      renderStepLogForm(container);

      const syncError = container.querySelector('#step-sync-error');
      expect(syncError).not.toBeNull();
      expect(syncError.classList.contains('hidden')).toBe(true);
    });
  });
});


describe('Partner visibility - fetchPartnerSteps', () => {
  let fetchPartnerSteps;
  let mockSupabase;
  let mockGetCurrentUser;
  let mockGetPartner;

  beforeEach(async () => {
    vi.resetModules();

    mockSupabase = {
      from: vi.fn(),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn()
      })),
      removeChannel: vi.fn()
    };

    mockGetCurrentUser = vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' }));
    mockGetPartner = vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }));

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: mockSupabase
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: mockGetCurrentUser,
      getPartner: mockGetPartner
    }));

    const module = await import('../js/steps-module.js');
    fetchPartnerSteps = module.fetchPartnerSteps;
  });

  it('returns error when user is not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    const result = await fetchPartnerSteps('2025-01-01', '2025-01-03');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not authenticated');
  });

  it('returns error when partner is not linked', async () => {
    mockGetPartner.mockReturnValue(null);
    const result = await fetchPartnerSteps('2025-01-01', '2025-01-03');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Partner not linked');
  });

  it('fetches steps for both partners within date range', async () => {
    const mockIn = vi.fn(() => Promise.resolve({
      data: [
        { user_id: 'user-a', log_date: '2025-01-01', step_count: 8000 },
        { user_id: 'user-b', log_date: '2025-01-01', step_count: 12000 },
        { user_id: 'user-a', log_date: '2025-01-02', step_count: 5000 }
      ],
      error: null
    }));
    const mockLte = vi.fn(() => ({ in: mockIn }));
    const mockGte = vi.fn(() => ({ lte: mockLte }));
    const mockSelect = vi.fn(() => ({ gte: mockGte }));
    mockSupabase.from.mockReturnValue({ select: mockSelect });

    const result = await fetchPartnerSteps('2025-01-01', '2025-01-03');

    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      { date: '2025-01-01', userSteps: 8000, partnerSteps: 12000 },
      { date: '2025-01-02', userSteps: 5000, partnerSteps: 0 },
      { date: '2025-01-03', userSteps: 0, partnerSteps: 0 }
    ]);
  });

  it('shows 0 steps for dates where no entry exists', async () => {
    const mockIn = vi.fn(() => Promise.resolve({
      data: [],
      error: null
    }));
    const mockLte = vi.fn(() => ({ in: mockIn }));
    const mockGte = vi.fn(() => ({ lte: mockLte }));
    const mockSelect = vi.fn(() => ({ gte: mockGte }));
    mockSupabase.from.mockReturnValue({ select: mockSelect });

    const result = await fetchPartnerSteps('2025-01-01', '2025-01-02');

    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      { date: '2025-01-01', userSteps: 0, partnerSteps: 0 },
      { date: '2025-01-02', userSteps: 0, partnerSteps: 0 }
    ]);
  });

  it('returns error when supabase query fails', async () => {
    const mockIn = vi.fn(() => Promise.resolve({
      data: null,
      error: { message: 'Network error' }
    }));
    const mockLte = vi.fn(() => ({ in: mockIn }));
    const mockGte = vi.fn(() => ({ lte: mockLte }));
    const mockSelect = vi.fn(() => ({ gte: mockGte }));
    mockSupabase.from.mockReturnValue({ select: mockSelect });

    const result = await fetchPartnerSteps('2025-01-01', '2025-01-03');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('Partner visibility - getDateRange', () => {
  let getDateRange;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    getDateRange = module.getDateRange;
  });

  it('returns a single date when start equals end', () => {
    const result = getDateRange('2025-01-15', '2025-01-15');
    expect(result).toEqual(['2025-01-15']);
  });

  it('returns consecutive dates for a 3-day range', () => {
    const result = getDateRange('2025-01-01', '2025-01-03');
    expect(result).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
  });

  it('handles month boundaries', () => {
    const result = getDateRange('2025-01-30', '2025-02-01');
    expect(result).toEqual(['2025-01-30', '2025-01-31', '2025-02-01']);
  });

  it('returns empty array when start is after end', () => {
    const result = getDateRange('2025-01-05', '2025-01-03');
    expect(result).toEqual([]);
  });
});

describe('Partner visibility - renderPartnerComparison', () => {
  let renderPartnerComparison;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    renderPartnerComparison = module.renderPartnerComparison;
  });

  it('renders a table with headers for both partners', () => {
    const container = document.createElement('div');
    const data = [
      { date: '2025-01-01', userSteps: 8000, partnerSteps: 10000 }
    ];

    renderPartnerComparison(container, data);

    const headers = container.querySelectorAll('th');
    expect(headers[0].textContent).toBe('Date');
    expect(headers[1].textContent).toBe('Jamall');
    expect(headers[2].textContent).toBe('Rebecca');
  });

  it('renders step counts with locale formatting', () => {
    const container = document.createElement('div');
    const data = [
      { date: '2025-01-01', userSteps: 12345, partnerSteps: 8000 }
    ];

    renderPartnerComparison(container, data);

    const userCell = container.querySelector('[data-user-steps="2025-01-01"]');
    const partnerCell = container.querySelector('[data-partner-steps="2025-01-01"]');
    expect(userCell.textContent).toBe('12,345');
    expect(partnerCell.textContent).toBe('8,000');
  });

  it('applies user-higher class when user has more steps', () => {
    const container = document.createElement('div');
    const data = [
      { date: '2025-01-01', userSteps: 15000, partnerSteps: 8000 }
    ];

    renderPartnerComparison(container, data);

    const row = container.querySelector('.step-comparison-row');
    expect(row.classList.contains('user-higher')).toBe(true);
  });

  it('applies partner-higher class when partner has more steps', () => {
    const container = document.createElement('div');
    const data = [
      { date: '2025-01-01', userSteps: 3000, partnerSteps: 12000 }
    ];

    renderPartnerComparison(container, data);

    const row = container.querySelector('.step-comparison-row');
    expect(row.classList.contains('partner-higher')).toBe(true);
  });

  it('applies tied class when steps are equal', () => {
    const container = document.createElement('div');
    const data = [
      { date: '2025-01-01', userSteps: 10000, partnerSteps: 10000 }
    ];

    renderPartnerComparison(container, data);

    const row = container.querySelector('.step-comparison-row');
    expect(row.classList.contains('tied')).toBe(true);
  });

  it('renders multiple rows for multiple dates', () => {
    const container = document.createElement('div');
    const data = [
      { date: '2025-01-01', userSteps: 8000, partnerSteps: 10000 },
      { date: '2025-01-02', userSteps: 12000, partnerSteps: 5000 },
      { date: '2025-01-03', userSteps: 0, partnerSteps: 0 }
    ];

    renderPartnerComparison(container, data);

    const rows = container.querySelectorAll('.step-comparison-row');
    expect(rows.length).toBe(3);
  });

  it('shows 0 steps formatted correctly', () => {
    const container = document.createElement('div');
    const data = [
      { date: '2025-01-01', userSteps: 0, partnerSteps: 0 }
    ];

    renderPartnerComparison(container, data);

    const userCell = container.querySelector('[data-user-steps="2025-01-01"]');
    const partnerCell = container.querySelector('[data-partner-steps="2025-01-01"]');
    expect(userCell.textContent).toBe('0');
    expect(partnerCell.textContent).toBe('0');
  });
});

describe('Partner visibility - updatePartnerStepDisplay', () => {
  let updatePartnerStepDisplay;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    updatePartnerStepDisplay = module.updatePartnerStepDisplay;
  });

  it('updates partner step cell when partner data changes', () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr class="step-comparison-row tied" data-date="2025-01-01">
            <td class="step-date-cell">2025-01-01</td>
            <td class="step-count-cell" data-user-steps="2025-01-01">5,000</td>
            <td class="step-count-cell" data-partner-steps="2025-01-01">5,000</td>
          </tr>
        </tbody>
      </table>
    `;

    updatePartnerStepDisplay('user-b', '2025-01-01', 12000);

    const partnerCell = document.querySelector('[data-partner-steps="2025-01-01"]');
    expect(partnerCell.textContent).toBe('12,000');
  });

  it('updates user step cell when user data changes', () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr class="step-comparison-row tied" data-date="2025-01-01">
            <td class="step-date-cell">2025-01-01</td>
            <td class="step-count-cell" data-user-steps="2025-01-01">5,000</td>
            <td class="step-count-cell" data-partner-steps="2025-01-01">5,000</td>
          </tr>
        </tbody>
      </table>
    `;

    updatePartnerStepDisplay('user-a', '2025-01-01', 15000);

    const userCell = document.querySelector('[data-user-steps="2025-01-01"]');
    expect(userCell.textContent).toBe('15,000');
  });

  it('updates row highlight class after partner update', () => {
    document.body.innerHTML = `
      <table>
        <tbody>
          <tr class="step-comparison-row tied" data-date="2025-01-01">
            <td class="step-date-cell">2025-01-01</td>
            <td class="step-count-cell" data-user-steps="2025-01-01">5,000</td>
            <td class="step-count-cell" data-partner-steps="2025-01-01">5,000</td>
          </tr>
        </tbody>
      </table>
    `;

    updatePartnerStepDisplay('user-b', '2025-01-01', 12000);

    const row = document.querySelector('.step-comparison-row');
    expect(row.classList.contains('partner-higher')).toBe(true);
    expect(row.classList.contains('tied')).toBe(false);
  });

  it('does nothing when no matching cell exists in the DOM', () => {
    document.body.innerHTML = '';
    // Should not throw
    expect(() => updatePartnerStepDisplay('user-b', '2025-01-01', 9000)).not.toThrow();
  });
});

describe('Partner visibility - subscribeToStepsRealtime', () => {
  let subscribeToStepsRealtime;
  let unsubscribeFromStepsRealtime;
  let mockSupabase;
  let mockChannel;

  beforeEach(async () => {
    vi.resetModules();

    mockChannel = {
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnThis()
    };

    mockSupabase = {
      from: vi.fn(),
      channel: vi.fn(() => mockChannel),
      removeChannel: vi.fn()
    };

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: mockSupabase
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    subscribeToStepsRealtime = module.subscribeToStepsRealtime;
    unsubscribeFromStepsRealtime = module.unsubscribeFromStepsRealtime;
  });

  it('creates a realtime channel subscription for steps_log', () => {
    subscribeToStepsRealtime();

    expect(mockSupabase.channel).toHaveBeenCalledWith('steps_log_partner');
    expect(mockChannel.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'steps_log' },
      expect.any(Function)
    );
    expect(mockChannel.subscribe).toHaveBeenCalled();
  });

  it('does not create duplicate subscriptions on repeated calls', () => {
    subscribeToStepsRealtime();
    subscribeToStepsRealtime();

    expect(mockSupabase.channel).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes the channel', () => {
    subscribeToStepsRealtime();
    unsubscribeFromStepsRealtime();

    expect(mockSupabase.removeChannel).toHaveBeenCalledWith(mockChannel);
  });

  it('allows re-subscription after unsubscribe', () => {
    subscribeToStepsRealtime();
    unsubscribeFromStepsRealtime();
    subscribeToStepsRealtime();

    expect(mockSupabase.channel).toHaveBeenCalledTimes(2);
  });
});

describe('Comparative statistics - getComparativeStats', () => {
  let getComparativeStats;
  let getISOWeekBounds;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    getComparativeStats = module.getComparativeStats;
    getISOWeekBounds = module.getISOWeekBounds;
  });

  it('returns zero totals and tied state when stepsData is empty', () => {
    const stats = getComparativeStats([]);
    expect(stats.daily.userTotal).toBe(0);
    expect(stats.daily.partnerTotal).toBe(0);
    expect(stats.daily.leader).toBe('tied');
    expect(stats.weekly.userTotal).toBe(0);
    expect(stats.weekly.partnerTotal).toBe(0);
    expect(stats.weekly.leader).toBe('tied');
  });

  it('returns daily totals for today and identifies user as leader', () => {
    const today = new Date().toLocaleDateString('en-CA');
    const data = [
      { date: today, userSteps: 12000, partnerSteps: 8000 }
    ];
    const stats = getComparativeStats(data);
    expect(stats.daily.userTotal).toBe(12000);
    expect(stats.daily.partnerTotal).toBe(8000);
    expect(stats.daily.leader).toBe('user');
  });

  it('returns daily totals for today and identifies partner as leader', () => {
    const today = new Date().toLocaleDateString('en-CA');
    const data = [
      { date: today, userSteps: 5000, partnerSteps: 15000 }
    ];
    const stats = getComparativeStats(data);
    expect(stats.daily.userTotal).toBe(5000);
    expect(stats.daily.partnerTotal).toBe(15000);
    expect(stats.daily.leader).toBe('partner');
  });

  it('returns tied state when daily counts are equal', () => {
    const today = new Date().toLocaleDateString('en-CA');
    const data = [
      { date: today, userSteps: 10000, partnerSteps: 10000 }
    ];
    const stats = getComparativeStats(data);
    expect(stats.daily.leader).toBe('tied');
  });

  it('sums weekly totals for Mon–Sun ISO week and identifies leader', () => {
    // Build a full week of data for the current ISO week
    const { weekStart, weekEnd } = getISOWeekBounds(new Date());
    // Use exactly 3 known dates within the week
    const data = [
      { date: weekStart, userSteps: 10000, partnerSteps: 8000 },
      { date: weekEnd, userSteps: 10000, partnerSteps: 8000 },
      // A date in the middle of the week
      { date: (() => { const d = new Date(weekStart + 'T00:00:00'); d.setDate(d.getDate() + 1); return d.toLocaleDateString('en-CA'); })(), userSteps: 10000, partnerSteps: 8000 }
    ];

    const stats = getComparativeStats(data);
    expect(stats.weekly.userTotal).toBe(30000);
    expect(stats.weekly.partnerTotal).toBe(24000);
    expect(stats.weekly.leader).toBe('user');
  });

  it('identifies partner as weekly leader when their total is higher', () => {
    const { weekStart } = getISOWeekBounds(new Date());
    const tues = new Date(weekStart + 'T00:00:00');
    tues.setDate(tues.getDate() + 1);

    const data = [
      { date: weekStart, userSteps: 5000, partnerSteps: 12000 },
      { date: tues.toLocaleDateString('en-CA'), userSteps: 5000, partnerSteps: 12000 }
    ];

    const stats = getComparativeStats(data);
    expect(stats.weekly.leader).toBe('partner');
  });

  it('returns tied weekly state when totals are equal', () => {
    const { weekStart } = getISOWeekBounds(new Date());
    const tues = new Date(weekStart + 'T00:00:00');
    tues.setDate(tues.getDate() + 1);

    const data = [
      { date: weekStart, userSteps: 9000, partnerSteps: 9000 },
      { date: tues.toLocaleDateString('en-CA'), userSteps: 9000, partnerSteps: 9000 }
    ];

    const stats = getComparativeStats(data);
    expect(stats.weekly.leader).toBe('tied');
  });

  it('excludes dates outside the current week from weekly totals', () => {
    const { weekStart } = getISOWeekBounds(new Date());
    // Date before current week's Monday
    const beforeWeek = new Date(weekStart + 'T00:00:00');
    beforeWeek.setDate(beforeWeek.getDate() - 1);
    const beforeStr = beforeWeek.toLocaleDateString('en-CA');

    const data = [
      { date: beforeStr, userSteps: 50000, partnerSteps: 1000 },
      { date: weekStart, userSteps: 3000, partnerSteps: 7000 }
    ];

    const stats = getComparativeStats(data);
    // Only the weekStart entry should count
    expect(stats.weekly.userTotal).toBe(3000);
    expect(stats.weekly.partnerTotal).toBe(7000);
    expect(stats.weekly.leader).toBe('partner');
  });

  it('ignores dates that are not today for daily totals', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toLocaleDateString('en-CA');

    const data = [
      { date: yesterdayStr, userSteps: 20000, partnerSteps: 1000 }
    ];

    const stats = getComparativeStats(data);
    expect(stats.daily.userTotal).toBe(0);
    expect(stats.daily.partnerTotal).toBe(0);
    expect(stats.daily.leader).toBe('tied');
  });
});

describe('Comparative statistics - getISOWeekBounds', () => {
  let getISOWeekBounds;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    getISOWeekBounds = module.getISOWeekBounds;
  });

  it('returns Monday–Sunday for a Wednesday', () => {
    // 2025-01-15 is a Wednesday
    const result = getISOWeekBounds(new Date('2025-01-15T12:00:00'));
    expect(result.weekStart).toBe('2025-01-13');
    expect(result.weekEnd).toBe('2025-01-19');
  });

  it('returns Monday–Sunday for a Monday', () => {
    // 2025-01-13 is a Monday
    const result = getISOWeekBounds(new Date('2025-01-13T12:00:00'));
    expect(result.weekStart).toBe('2025-01-13');
    expect(result.weekEnd).toBe('2025-01-19');
  });

  it('returns Monday–Sunday for a Sunday', () => {
    // 2025-01-19 is a Sunday
    const result = getISOWeekBounds(new Date('2025-01-19T12:00:00'));
    expect(result.weekStart).toBe('2025-01-13');
    expect(result.weekEnd).toBe('2025-01-19');
  });

  it('handles month boundary (Sunday in next month)', () => {
    // 2025-01-27 is a Monday
    const result = getISOWeekBounds(new Date('2025-01-27T12:00:00'));
    expect(result.weekStart).toBe('2025-01-27');
    expect(result.weekEnd).toBe('2025-02-02');
  });
});

describe('Comparative statistics - renderComparativeStats', () => {
  let renderComparativeStats;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    renderComparativeStats = module.renderComparativeStats;
  });

  it('renders daily and weekly sections', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 10000, partnerTotal: 8000, leader: 'user' },
      weekly: { userTotal: 50000, partnerTotal: 45000, leader: 'user' }
    };

    renderComparativeStats(container, stats);

    expect(container.querySelector('#daily-comparison')).not.toBeNull();
    expect(container.querySelector('#weekly-comparison')).not.toBeNull();
  });

  it('displays user leader indicator when user is leading daily', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 15000, partnerTotal: 8000, leader: 'user' },
      weekly: { userTotal: 50000, partnerTotal: 45000, leader: 'user' }
    };

    renderComparativeStats(container, stats);

    const dailySection = container.querySelector('#daily-comparison');
    expect(dailySection.querySelector('.user-leads')).not.toBeNull();
    expect(dailySection.querySelector('.partner-leads')).toBeNull();
  });

  it('displays partner leader indicator when partner is leading daily', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 5000, partnerTotal: 12000, leader: 'partner' },
      weekly: { userTotal: 30000, partnerTotal: 60000, leader: 'partner' }
    };

    renderComparativeStats(container, stats);

    const dailySection = container.querySelector('#daily-comparison');
    expect(dailySection.querySelector('.partner-leads')).not.toBeNull();
    expect(dailySection.querySelector('.user-leads')).toBeNull();
  });

  it('displays tied indicator when daily counts are equal', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 10000, partnerTotal: 10000, leader: 'tied' },
      weekly: { userTotal: 50000, partnerTotal: 50000, leader: 'tied' }
    };

    renderComparativeStats(container, stats);

    const dailySection = container.querySelector('#daily-comparison');
    expect(dailySection.querySelector('.tied-indicator')).not.toBeNull();
    expect(dailySection.querySelector('.user-leads')).toBeNull();
    expect(dailySection.querySelector('.partner-leads')).toBeNull();
  });

  it('displays weekly leader indicator correctly', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 10000, partnerTotal: 10000, leader: 'tied' },
      weekly: { userTotal: 70000, partnerTotal: 50000, leader: 'user' }
    };

    renderComparativeStats(container, stats);

    const weeklySection = container.querySelector('#weekly-comparison');
    expect(weeklySection.querySelector('.user-leads')).not.toBeNull();
  });

  it('displays step counts with locale formatting', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 12345, partnerTotal: 8000, leader: 'user' },
      weekly: { userTotal: 56789, partnerTotal: 43210, leader: 'user' }
    };

    renderComparativeStats(container, stats);

    const dailyUser = container.querySelector('[data-daily-user]');
    const dailyPartner = container.querySelector('[data-daily-partner]');
    expect(dailyUser.textContent).toBe('12,345');
    expect(dailyPartner.textContent).toBe('8,000');

    const weeklyUser = container.querySelector('[data-weekly-user]');
    const weeklyPartner = container.querySelector('[data-weekly-partner]');
    expect(weeklyUser.textContent).toBe('56,789');
    expect(weeklyPartner.textContent).toBe('43,210');
  });

  it('displays partner names from user context', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 10000, partnerTotal: 8000, leader: 'user' },
      weekly: { userTotal: 50000, partnerTotal: 45000, leader: 'user' }
    };

    renderComparativeStats(container, stats);

    const names = container.querySelectorAll('.comparative-name');
    const nameTexts = Array.from(names).map(n => n.textContent);
    expect(nameTexts).toContain('Jamall');
    expect(nameTexts).toContain('Rebecca');
  });

  it('applies tied class to comparative row when tied', () => {
    const container = document.createElement('div');
    const stats = {
      daily: { userTotal: 10000, partnerTotal: 10000, leader: 'tied' },
      weekly: { userTotal: 50000, partnerTotal: 50000, leader: 'tied' }
    };

    renderComparativeStats(container, stats);

    const dailyRow = container.querySelector('#daily-comparison .comparative-row');
    expect(dailyRow.classList.contains('tied')).toBe(true);
  });
});

describe('calculateStreak', () => {
  let calculateStreak;

  // Helper to get local date string (YYYY-MM-DD) without timezone issues
  function toLocalDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    calculateStreak = module.calculateStreak;
  });

  it('returns zeros for empty log', () => {
    const result = calculateStreak([], 10000);
    expect(result).toEqual({ currentStreak: 0, longestStreak: 0, lastActiveDate: null });
  });

  it('returns zeros for null/undefined log', () => {
    expect(calculateStreak(null, 10000)).toEqual({ currentStreak: 0, longestStreak: 0, lastActiveDate: null });
    expect(calculateStreak(undefined, 10000)).toEqual({ currentStreak: 0, longestStreak: 0, lastActiveDate: null });
  });

  it('uses default goal of 10000 when not specified', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toLocalDateStr(today);

    const log = [{ log_date: todayStr, step_count: 10000 }];
    const result = calculateStreak(log);
    expect(result.currentStreak).toBe(1);
  });

  it('counts a single day meeting goal today as streak of 1', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toLocalDateStr(today);

    const log = [{ log_date: todayStr, step_count: 15000 }];
    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(1);
    expect(result.longestStreak).toBe(1);
    expect(result.lastActiveDate).not.toBeNull();
    expect(toLocalDateStr(result.lastActiveDate)).toBe(todayStr);
  });

  it('counts consecutive days ending at today', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dates = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(toLocalDateStr(d));
    }

    // Sorted descending (today first)
    const log = dates.map(d => ({ log_date: d, step_count: 12000 }));
    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(5);
    expect(result.longestStreak).toBe(5);
  });

  it('counts streak starting from yesterday if today not yet logged', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dates = [];
    for (let i = 1; i <= 3; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(toLocalDateStr(d));
    }

    const log = dates.map(d => ({ log_date: d, step_count: 11000 }));
    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(3);
    expect(result.longestStreak).toBe(3);
  });

  it('breaks streak when a day below goal is encountered', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const d0 = new Date(today);
    const d1 = new Date(today); d1.setDate(d1.getDate() - 1);
    const d2 = new Date(today); d2.setDate(d2.getDate() - 2);

    const log = [
      { log_date: toLocalDateStr(d0), step_count: 12000 },
      { log_date: toLocalDateStr(d1), step_count: 5000 },  // below goal
      { log_date: toLocalDateStr(d2), step_count: 15000 }
    ];

    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(1); // only today
    expect(result.longestStreak).toBe(1); // longest is also 1 (isolated days)
  });

  it('treats missing days (gaps) as streak-breaking', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const d0 = new Date(today);
    const d2 = new Date(today); d2.setDate(d2.getDate() - 2);

    // Today and 2 days ago (yesterday missing)
    const log = [
      { log_date: toLocalDateStr(d0), step_count: 12000 },
      { log_date: toLocalDateStr(d2), step_count: 15000 }
    ];

    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(1); // only today counts
  });

  it('computes longest streak across entire history', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const makeDate = (daysAgo) => {
      const d = new Date(today);
      d.setDate(d.getDate() - daysAgo);
      return toLocalDateStr(d);
    };

    // Current streak: 2 days (today + yesterday)
    // Historical streak: 4 days (7-10 days ago)
    const log = [
      { log_date: makeDate(0), step_count: 12000 },
      { log_date: makeDate(1), step_count: 11000 },
      { log_date: makeDate(2), step_count: 3000 }, // break
      { log_date: makeDate(7), step_count: 10000 },
      { log_date: makeDate(8), step_count: 10000 },
      { log_date: makeDate(9), step_count: 10000 },
      { log_date: makeDate(10), step_count: 10000 }
    ];

    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(2);
    expect(result.longestStreak).toBe(4);
  });

  it('ensures currentStreak <= longestStreak always holds', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const log = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      log.push({ log_date: toLocalDateStr(d), step_count: 15000 });
    }

    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBeLessThanOrEqual(result.longestStreak);
    expect(result.currentStreak).toBe(10);
    expect(result.longestStreak).toBe(10);
  });

  it('returns currentStreak 0 when today and yesterday both below goal', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const log = [
      { log_date: toLocalDateStr(today), step_count: 5000 },
      { log_date: toLocalDateStr(yesterday), step_count: 3000 }
    ];

    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(0);
  });

  it('handles step_count exactly equal to goal as meeting goal', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toLocalDateStr(today);

    const log = [{ log_date: todayStr, step_count: 10000 }];
    const result = calculateStreak(log, 10000);
    expect(result.currentStreak).toBe(1);
  });

  it('respects custom goal value', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toLocalDateStr(today);

    // 8000 steps meets a goal of 5000 but not 10000
    const log = [{ log_date: todayStr, step_count: 8000 }];
    expect(calculateStreak(log, 5000).currentStreak).toBe(1);
    expect(calculateStreak(log, 10000).currentStreak).toBe(0);
  });

  it('sets lastActiveDate to the most recent date where goal was met', () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const log = [
      { log_date: toLocalDateStr(today), step_count: 3000 }, // not met
      { log_date: toLocalDateStr(yesterday), step_count: 12000 },
      { log_date: toLocalDateStr(twoDaysAgo), step_count: 11000 }
    ];

    const result = calculateStreak(log, 10000);
    expect(toLocalDateStr(result.lastActiveDate)).toBe(toLocalDateStr(yesterday));
  });
});

describe('validateGoal', () => {
  let validateGoal;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    validateGoal = module.validateGoal;
  });

  it('accepts minimum goal of 1', () => {
    expect(validateGoal(1)).toEqual({ valid: true });
  });

  it('accepts maximum goal of 200000', () => {
    expect(validateGoal(200000)).toEqual({ valid: true });
  });

  it('accepts a typical goal of 10000', () => {
    expect(validateGoal(10000)).toEqual({ valid: true });
  });

  it('rejects goal of 0', () => {
    const result = validateGoal(0);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('1');
    expect(result.error).toContain('200,000');
  });

  it('rejects negative goal', () => {
    const result = validateGoal(-5);
    expect(result.valid).toBe(false);
  });

  it('rejects goal exceeding 200000', () => {
    const result = validateGoal(200001);
    expect(result.valid).toBe(false);
  });

  it('rejects non-integer goal', () => {
    const result = validateGoal(5000.5);
    expect(result.valid).toBe(false);
  });

  it('rejects NaN', () => {
    const result = validateGoal(NaN);
    expect(result.valid).toBe(false);
  });

  it('accepts string that represents a valid integer', () => {
    expect(validateGoal('15000')).toEqual({ valid: true });
  });

  it('rejects string that is not a valid integer', () => {
    const result = validateGoal('abc');
    expect(result.valid).toBe(false);
  });
});

describe('setDailyGoal', () => {
  let setDailyGoal;
  let mockSupabase;
  let mockGetCurrentUser;

  beforeEach(async () => {
    vi.resetModules();

    mockSupabase = {
      from: vi.fn(),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn()
      })),
      removeChannel: vi.fn()
    };

    mockGetCurrentUser = vi.fn(() => ({ id: 'user-123', display_name: 'Jamall' }));

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: mockSupabase
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: mockGetCurrentUser,
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    setDailyGoal = module.setDailyGoal;
  });

  it('returns validation error for invalid goal', async () => {
    const result = await setDailyGoal(0);
    expect(result.success).toBe(false);
    expect(result.error).toContain('1');
  });

  it('returns error when user is not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    const result = await setDailyGoal(10000);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not authenticated');
  });

  it('upserts goal to user_settings on valid input', async () => {
    const mockUpsert = vi.fn(() => Promise.resolve({ error: null }));
    mockSupabase.from.mockReturnValue({ upsert: mockUpsert });

    const result = await setDailyGoal(15000);

    expect(result.success).toBe(true);
    expect(mockSupabase.from).toHaveBeenCalledWith('user_settings');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-123',
        setting_key: 'daily_step_goal',
        setting_value: '15000'
      }),
      { onConflict: 'user_id,setting_key' }
    );
  });

  it('returns error when supabase upsert fails', async () => {
    const mockUpsert = vi.fn(() => Promise.resolve({ error: { message: 'DB error' } }));
    mockSupabase.from.mockReturnValue({ upsert: mockUpsert });

    const result = await setDailyGoal(10000);
    expect(result.success).toBe(false);
    expect(result.error).toBe('DB error');
  });
});

describe('getDailyGoal', () => {
  let getDailyGoal;
  let mockSupabase;

  beforeEach(async () => {
    vi.resetModules();

    mockSupabase = {
      from: vi.fn(),
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn()
      })),
      removeChannel: vi.fn()
    };

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: mockSupabase
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    getDailyGoal = module.getDailyGoal;
  });

  it('returns error when userId is missing', async () => {
    const result = await getDailyGoal(null);
    expect(result.success).toBe(false);
    expect(result.error).toBe('User ID is required');
  });

  it('returns default goal of 10000 when no custom goal is set', async () => {
    const mockMaybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
    const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
    const mockSelect = vi.fn(() => ({ eq: mockEq1 }));
    mockSupabase.from.mockReturnValue({ select: mockSelect });

    const result = await getDailyGoal('user-123');
    expect(result.success).toBe(true);
    expect(result.goal).toBe(10000);
  });

  it('returns the custom goal when it exists', async () => {
    const mockMaybeSingle = vi.fn(() => Promise.resolve({
      data: { setting_value: '15000' },
      error: null
    }));
    const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
    const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
    const mockSelect = vi.fn(() => ({ eq: mockEq1 }));
    mockSupabase.from.mockReturnValue({ select: mockSelect });

    const result = await getDailyGoal('user-123');
    expect(result.success).toBe(true);
    expect(result.goal).toBe(15000);
  });

  it('returns default goal when stored value is invalid', async () => {
    const mockMaybeSingle = vi.fn(() => Promise.resolve({
      data: { setting_value: 'invalid' },
      error: null
    }));
    const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
    const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
    const mockSelect = vi.fn(() => ({ eq: mockEq1 }));
    mockSupabase.from.mockReturnValue({ select: mockSelect });

    const result = await getDailyGoal('user-123');
    expect(result.success).toBe(true);
    expect(result.goal).toBe(10000);
  });

  it('returns error when supabase query fails', async () => {
    const mockMaybeSingle = vi.fn(() => Promise.resolve({
      data: null,
      error: { message: 'Network error' }
    }));
    const mockEq2 = vi.fn(() => ({ maybeSingle: mockMaybeSingle }));
    const mockEq1 = vi.fn(() => ({ eq: mockEq2 }));
    const mockSelect = vi.fn(() => ({ eq: mockEq1 }));
    mockSupabase.from.mockReturnValue({ select: mockSelect });

    const result = await getDailyGoal('user-123');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('renderStreakDisplay', () => {
  let renderStreakDisplay;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock('../js/supabase-client.js', () => ({
      supabase: {
        from: vi.fn(),
        channel: vi.fn(() => ({
          on: vi.fn().mockReturnThis(),
          subscribe: vi.fn()
        })),
        removeChannel: vi.fn()
      }
    }));

    vi.doMock('../js/app-shell.js', () => ({
      getCurrentUser: vi.fn(() => ({ id: 'user-a', display_name: 'Jamall' })),
      getPartner: vi.fn(() => ({ id: 'user-b', display_name: 'Rebecca' }))
    }));

    const module = await import('../js/steps-module.js');
    renderStreakDisplay = module.renderStreakDisplay;
  });

  it('renders the current streak value', () => {
    const container = document.createElement('div');
    renderStreakDisplay(container, { currentStreak: 5, longestStreak: 14, lastActiveDate: new Date('2025-01-15') });

    const currentEl = container.querySelector('#current-streak-value');
    expect(currentEl).not.toBeNull();
    expect(currentEl.textContent).toBe('5');
  });

  it('renders the longest streak value', () => {
    const container = document.createElement('div');
    renderStreakDisplay(container, { currentStreak: 3, longestStreak: 21, lastActiveDate: new Date('2025-01-10') });

    const longestEl = container.querySelector('#longest-streak-value');
    expect(longestEl).not.toBeNull();
    expect(longestEl.textContent).toBe('21');
  });

  it('shows "Never" when lastActiveDate is null', () => {
    const container = document.createElement('div');
    renderStreakDisplay(container, { currentStreak: 0, longestStreak: 0, lastActiveDate: null });

    const metaEl = container.querySelector('.streak-last-active');
    expect(metaEl.textContent).toContain('Never');
  });

  it('shows formatted date when lastActiveDate is set', () => {
    const container = document.createElement('div');
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    const expectedStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    renderStreakDisplay(container, { currentStreak: 3, longestStreak: 10, lastActiveDate: date });

    const timeEl = container.querySelector('time');
    expect(timeEl).not.toBeNull();
    expect(timeEl.textContent).toBe(expectedStr);
  });

  it('has aria-labels for accessibility', () => {
    const container = document.createElement('div');
    renderStreakDisplay(container, { currentStreak: 7, longestStreak: 14, lastActiveDate: new Date() });

    const currentStat = container.querySelector('[aria-label="Current streak: 7 days"]');
    const longestStat = container.querySelector('[aria-label="Longest streak: 14 days"]');
    expect(currentStat).not.toBeNull();
    expect(longestStat).not.toBeNull();
  });

  it('renders streak card with proper structure', () => {
    const container = document.createElement('div');
    renderStreakDisplay(container, { currentStreak: 0, longestStreak: 0, lastActiveDate: null });

    expect(container.querySelector('#streak-card')).not.toBeNull();
    expect(container.querySelector('.card-title').textContent).toBe('Step Streak');
  });
});
