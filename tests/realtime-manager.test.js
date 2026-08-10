/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock supabase before importing the module
const mockSubscribe = vi.fn((cb) => {
  if (cb) cb('SUBSCRIBED');
  return { subscribe: mockSubscribe };
});

const mockOn = vi.fn(() => ({ subscribe: mockSubscribe }));
const mockChannel = vi.fn(() => ({ on: mockOn, subscribe: mockSubscribe }));
const mockRemoveChannel = vi.fn();

vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    channel: (...args) => mockChannel(...args),
    removeChannel: (...args) => mockRemoveChannel(...args),
  },
}));

// Import after mocking
const { initRealtime, cleanup } = await import('../js/realtime-manager.js');

describe('realtime-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Set up a minimal DOM with bottom-nav
    document.body.innerHTML = `
      <div id="app">
        <main id="view-container"></main>
        <nav class="bottom-nav"></nav>
      </div>
    `;

    // Reset module state by calling cleanup
    cleanup();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('initRealtime', () => {
    it('subscribes to all five tables', () => {
      initRealtime();

      expect(mockChannel).toHaveBeenCalledTimes(5);
      expect(mockChannel).toHaveBeenCalledWith('realtime:events');
      expect(mockChannel).toHaveBeenCalledWith('realtime:steps_log');
      expect(mockChannel).toHaveBeenCalledWith('realtime:meals');
      expect(mockChannel).toHaveBeenCalledWith('realtime:recipes');
      expect(mockChannel).toHaveBeenCalledWith('realtime:pantry_items');
    });

    it('subscribes to postgres_changes with wildcard event', () => {
      initRealtime();

      // Each channel should have .on() called with postgres_changes config
      expect(mockOn).toHaveBeenCalledTimes(5);
      const firstCall = mockOn.mock.calls[0];
      expect(firstCall[0]).toBe('postgres_changes');
      expect(firstCall[1]).toEqual({ event: '*', schema: 'public', table: 'events' });
    });
  });

  describe('cleanup', () => {
    it('removes all channels on cleanup', () => {
      // Need to track the channel objects returned
      const channelObj = { on: mockOn, subscribe: mockSubscribe };
      mockChannel.mockReturnValue(channelObj);

      // Clear previous calls from beforeEach cleanup
      mockRemoveChannel.mockClear();

      initRealtime();
      cleanup();

      expect(mockRemoveChannel).toHaveBeenCalledTimes(5);
    });

    it('removes offline indicator on cleanup', () => {
      let subscribeCb = null;
      mockSubscribe.mockImplementation((cb) => {
        subscribeCb = cb;
      });
      mockOn.mockReturnValue({ subscribe: mockSubscribe });

      initRealtime();

      // Trigger the module's own offline indicator by simulating connection loss
      subscribeCb('CHANNEL_ERROR');
      vi.advanceTimersByTime(3000);

      // Confirm indicator is showing
      expect(document.querySelector('.realtime-offline-indicator')).not.toBeNull();

      cleanup();

      expect(document.querySelector('.realtime-offline-indicator')).toBeNull();
    });
  });

  describe('custom events', () => {
    it('dispatches custom event on table change', () => {
      let receivedEvent = null;
      window.addEventListener('realtime:events', (e) => {
        receivedEvent = e.detail;
      });

      // Capture the callback passed to .on()
      let changeCallback = null;
      mockOn.mockImplementation((type, config, cb) => {
        if (config.table === 'events') {
          changeCallback = cb;
        }
        return { subscribe: mockSubscribe };
      });

      initRealtime();

      // Simulate a change payload
      const payload = { eventType: 'INSERT', new: { id: 1, title: 'Test' } };
      changeCallback(payload);

      expect(receivedEvent).toEqual(payload);
    });
  });

  describe('offline indicator', () => {
    it('does not show offline indicator immediately on connection loss', () => {
      // Subscribe callback returning CHANNEL_ERROR to trigger offline
      mockSubscribe.mockImplementation((cb) => {
        if (cb) cb('CHANNEL_ERROR');
      });

      mockOn.mockReturnValue({ subscribe: mockSubscribe });

      initRealtime();

      // Should not be visible immediately
      expect(document.querySelector('.realtime-offline-indicator')).toBeNull();
    });

    it('shows offline indicator after 3 seconds of connection loss', () => {
      // First call subscribes normally, then we trigger error
      let subscribeCb = null;
      mockSubscribe.mockImplementation((cb) => {
        subscribeCb = cb;
      });
      mockOn.mockReturnValue({ subscribe: mockSubscribe });

      initRealtime();

      // Trigger connection loss
      subscribeCb('CHANNEL_ERROR');

      // Advance past 3 second delay
      vi.advanceTimersByTime(3000);

      const indicator = document.querySelector('.realtime-offline-indicator');
      expect(indicator).not.toBeNull();
      expect(indicator.textContent).toContain('Offline');
    });

    it('offline indicator has role="status" for accessibility', () => {
      let subscribeCb = null;
      mockSubscribe.mockImplementation((cb) => {
        subscribeCb = cb;
      });
      mockOn.mockReturnValue({ subscribe: mockSubscribe });

      initRealtime();
      subscribeCb('CHANNEL_ERROR');
      vi.advanceTimersByTime(3000);

      const indicator = document.querySelector('.realtime-offline-indicator');
      expect(indicator.getAttribute('role')).toBe('status');
    });
  });

  describe('reconnection', () => {
    it('dispatches realtime:reconnected event when connection restores', () => {
      let reconnected = false;
      window.addEventListener('realtime:reconnected', () => {
        reconnected = true;
      });

      let subscribeCb = null;
      mockSubscribe.mockImplementation((cb) => {
        subscribeCb = cb;
      });
      mockOn.mockReturnValue({ subscribe: mockSubscribe });

      initRealtime();

      // Go offline
      subscribeCb('CHANNEL_ERROR');
      vi.advanceTimersByTime(3000);

      // Come back online
      subscribeCb('SUBSCRIBED');

      expect(reconnected).toBe(true);
    });

    it('removes offline indicator on reconnection', () => {
      let subscribeCb = null;
      mockSubscribe.mockImplementation((cb) => {
        subscribeCb = cb;
      });
      mockOn.mockReturnValue({ subscribe: mockSubscribe });

      initRealtime();

      // Go offline
      subscribeCb('CHANNEL_ERROR');
      vi.advanceTimersByTime(3000);

      expect(document.querySelector('.realtime-offline-indicator')).not.toBeNull();

      // Come back online
      subscribeCb('SUBSCRIBED');

      expect(document.querySelector('.realtime-offline-indicator')).toBeNull();
    });

    it('shows persistent error with refresh button after 3 failed reconnect attempts', () => {
      let subscribeCb = null;
      mockSubscribe.mockImplementation((cb) => {
        subscribeCb = cb;
      });
      mockOn.mockReturnValue({ subscribe: mockSubscribe });

      initRealtime();

      // Go offline
      subscribeCb('CHANNEL_ERROR');

      // Advance past offline delay + all reconnect attempts
      // Delay: 3s, reconnect schedule: 2s initial, then 2s + 4s + 8s backoff
      vi.advanceTimersByTime(3000); // offline indicator shows
      vi.advanceTimersByTime(2000); // first reconnect attempt
      vi.advanceTimersByTime(2000); // second reconnect
      vi.advanceTimersByTime(4000); // third reconnect (exponential backoff)

      const indicator = document.querySelector('.realtime-error-persistent');
      expect(indicator).not.toBeNull();
      expect(indicator.textContent).toContain('Connection lost');
      expect(indicator.querySelector('.realtime-refresh-btn')).not.toBeNull();
    });
  });
});
