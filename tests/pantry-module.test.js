// ============================================================
// Pantry Module — Unit Tests
// Tests for validation and getValidPantryItems filtering logic
//
// Requirements: 9.4, 9.5, 9.6, 9.7
//
// @vitest-environment jsdom
// ============================================================

import { describe, it, expect, vi } from 'vitest';

// Mock the supabase client
vi.mock('../js/supabase-client.js', () => ({
  supabase: {
    from: () => ({
      insert: () => ({ select: () => ({ single: () => ({ data: null, error: null }) }) }),
      select: () => ({ order: () => ({ data: [], error: null }) }),
      update: () => ({ eq: () => ({ select: () => ({ single: () => ({ data: null, error: null }) }) }) }),
      delete: () => ({ eq: () => ({ data: null, error: null }) }),
    }),
  },
}));

// Mock app-shell getCurrentUser
vi.mock('../js/app-shell.js', () => ({
  getCurrentUser: () => ({ id: 'user-jamall', display_name: 'Jamall' }),
  getPartner: () => ({ id: 'user-rebecca', display_name: 'Rebecca' }),
}));

import { validatePantryItem, getValidPantryItems } from '../js/pantry-module.js';

// --- validatePantryItem tests ---

describe('validatePantryItem', () => {
  describe('valid inputs', () => {
    it('accepts a simple name', () => {
      const result = validatePantryItem({ name: 'Chicken' });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual({});
    });

    it('accepts a name with exactly 1 character', () => {
      const result = validatePantryItem({ name: 'A' });
      expect(result.valid).toBe(true);
    });

    it('accepts a name with exactly 100 characters', () => {
      const name = 'a'.repeat(100);
      const result = validatePantryItem({ name });
      expect(result.valid).toBe(true);
    });

    it('accepts a name with leading/trailing spaces (trims to valid)', () => {
      const result = validatePantryItem({ name: '  Rice  ' });
      expect(result.valid).toBe(true);
    });
  });

  describe('empty or whitespace-only name', () => {
    it('rejects empty string', () => {
      const result = validatePantryItem({ name: '' });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name is required');
    });

    it('rejects whitespace-only string', () => {
      const result = validatePantryItem({ name: '   ' });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name is required');
    });

    it('rejects null name', () => {
      const result = validatePantryItem({ name: null });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name is required');
    });

    it('rejects undefined name', () => {
      const result = validatePantryItem({});
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name is required');
    });

    it('rejects missing data entirely', () => {
      const result = validatePantryItem(null);
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name is required');
    });
  });

  describe('name exceeding 100 characters', () => {
    it('rejects a name with 101 characters', () => {
      const name = 'a'.repeat(101);
      const result = validatePantryItem({ name });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name must be 100 characters or fewer');
    });

    it('rejects a very long name', () => {
      const name = 'x'.repeat(500);
      const result = validatePantryItem({ name });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name must be 100 characters or fewer');
    });

    it('checks trimmed length — 100 chars plus spaces is still valid', () => {
      // Name is 100 chars after trimming
      const name = '  ' + 'b'.repeat(100) + '  ';
      const result = validatePantryItem({ name });
      expect(result.valid).toBe(true);
    });

    it('rejects when trimmed length exceeds 100', () => {
      const name = '  ' + 'c'.repeat(101) + '  ';
      const result = validatePantryItem({ name });
      expect(result.valid).toBe(false);
      expect(result.errors.name).toBe('Item name must be 100 characters or fewer');
    });
  });
});

// --- getValidPantryItems tests ---

describe('getValidPantryItems', () => {
  // Helper to create a date string for today, past, or future
  function dateString(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toLocaleDateString('en-CA'); // YYYY-MM-DD
  }

  it('returns all items when none have expiry dates', () => {
    const items = [
      { id: '1', name: 'Rice', expires_at: null },
      { id: '2', name: 'Salt', expires_at: null },
    ];
    const result = getValidPantryItems(items);
    expect(result).toHaveLength(2);
  });

  it('includes items with future expiry dates', () => {
    const items = [
      { id: '1', name: 'Milk', expires_at: dateString(7) },
      { id: '2', name: 'Yogurt', expires_at: dateString(1) },
    ];
    const result = getValidPantryItems(items);
    expect(result).toHaveLength(2);
  });

  it('includes items expiring today', () => {
    const items = [
      { id: '1', name: 'Bread', expires_at: dateString(0) },
    ];
    const result = getValidPantryItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Bread');
  });

  it('excludes items with past expiry dates', () => {
    const items = [
      { id: '1', name: 'Old Milk', expires_at: dateString(-1) },
      { id: '2', name: 'Old Eggs', expires_at: dateString(-30) },
    ];
    const result = getValidPantryItems(items);
    expect(result).toHaveLength(0);
  });

  it('filters a mix of expired, valid, and no-expiry items', () => {
    const items = [
      { id: '1', name: 'Fresh Chicken', expires_at: dateString(3) },
      { id: '2', name: 'Expired Yogurt', expires_at: dateString(-2) },
      { id: '3', name: 'Salt', expires_at: null },
      { id: '4', name: 'Today Bread', expires_at: dateString(0) },
      { id: '5', name: 'Old Fish', expires_at: dateString(-10) },
    ];
    const result = getValidPantryItems(items);
    expect(result).toHaveLength(3);
    expect(result.map(i => i.name)).toEqual(['Fresh Chicken', 'Salt', 'Today Bread']);
  });

  it('returns empty array when given empty array', () => {
    const result = getValidPantryItems([]);
    expect(result).toHaveLength(0);
  });

  it('handles items with undefined expires_at as no expiry', () => {
    const items = [
      { id: '1', name: 'Spice', expires_at: undefined },
    ];
    const result = getValidPantryItems(items);
    expect(result).toHaveLength(1);
  });
});
