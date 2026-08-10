/**
 * UI helpers
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { localDateKey, formatNumber, escapeHtml, displayName } from '../js/ui-helpers.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('localDateKey', () => {
  it('formats a date as YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 7, 10, 13, 0))).toBe('2026-08-10');
  });

  it('zero-pads single-digit months and days', () => {
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  /**
   * The regression this helper exists for. At 00:30 local during BST the UTC
   * date is still the previous day, so toISOString() files the entry under
   * yesterday. That hour sits inside a night shift, which is exactly when
   * steps and meals get logged.
   */
  it('reports the local day just after midnight during BST', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T23:30:00Z')); // 00:30 on the 10th, BST

    const utcAnswer = new Date().toISOString().split('T')[0];
    expect(utcAnswer).toBe('2026-08-09');
    expect(localDateKey()).toBe('2026-08-10');
  });

  it('agrees with UTC in the middle of the day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00Z'));
    expect(localDateKey()).toBe(new Date().toISOString().split('T')[0]);
  });

  it('defaults to now', () => {
    expect(localDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts a parseable string', () => {
    expect(localDateKey('2026-08-10T09:00:00')).toBe('2026-08-10');
  });

  it('returns an empty string for an unparseable value', () => {
    expect(localDateKey('not a date')).toBe('');
  });
});

describe('formatNumber', () => {
  it('adds thousands separators', () => {
    expect(formatNumber(9240)).toBe('9,240');
  });

  it('falls back to zero for nonsense', () => {
    expect(formatNumber('abc')).toBe('0');
    expect(formatNumber(undefined)).toBe('0');
  });
});

describe('escapeHtml', () => {
  it('neutralises tags', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

describe('displayName', () => {
  it('falls back when there is no profile', () => {
    expect(displayName(null, 'Partner')).toBe('Partner');
  });
});
