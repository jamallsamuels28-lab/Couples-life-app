import { describe, it, expect, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { createOverlapRibbon, renderOverlapRibbon } from '../js/overlap-ribbon.js';

// Set up a minimal DOM environment
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.document = dom.window.document;

describe('Overlap Ribbon Component', () => {
  // Helper: create a Date for a specific hour on a fixed day
  function hourDate(hour, min = 0) {
    return new Date(2025, 5, 15, hour, min, 0, 0);
  }

  const baseOptions = {
    freeWindows: [
      { start: hourDate(10), end: hourDate(12) },
      { start: hourDate(14), end: hourDate(15) },
    ],
    busyBlocksA: [
      { start: hourDate(8), end: hourDate(10) },
      { start: hourDate(12), end: hourDate(14) },
    ],
    busyBlocksB: [
      { start: hourDate(9), end: hourDate(11) },
      { start: hourDate(15), end: hourDate(17) },
    ],
    dayStart: hourDate(8),
    dayEnd: hourDate(23),
    labelA: 'Jamall',
    labelB: 'Rebecca',
    dayStartHour: 8,
    dayEndHour: 23,
  };

  describe('createOverlapRibbon', () => {
    it('returns a DOM element with the overlap-ribbon class', () => {
      const el = createOverlapRibbon(baseOptions);
      expect(el.className).toBe('overlap-ribbon');
      expect(el.tagName).toBe('DIV');
    });

    it('has role="img" for accessibility', () => {
      const el = createOverlapRibbon(baseOptions);
      expect(el.getAttribute('role')).toBe('img');
    });

    it('includes an aria-label summarizing free time', () => {
      const el = createOverlapRibbon(baseOptions);
      const ariaLabel = el.getAttribute('aria-label');
      expect(ariaLabel).toContain('Jamall');
      expect(ariaLabel).toContain('Rebecca');
      expect(ariaLabel).toContain('2 free windows');
      // 2h + 1h = 3h total
      expect(ariaLabel).toContain('3h');
    });

    it('displays total free time in the header', () => {
      const el = createOverlapRibbon(baseOptions);
      const total = el.querySelector('.overlap-ribbon__total');
      expect(total).not.toBeNull();
      // 120 min + 60 min = 180 min = 3h
      expect(total.textContent).toBe('3h free');
    });

    it('renders two partner tracks', () => {
      const el = createOverlapRibbon(baseOptions);
      const tracks = el.querySelectorAll('.overlap-ribbon__track');
      expect(tracks.length).toBe(2);
    });

    it('renders partner A track with identity class blocks', () => {
      const el = createOverlapRibbon(baseOptions);
      const blocksA = el.querySelectorAll('.overlap-ribbon__block--a');
      expect(blocksA.length).toBe(2); // two busy blocks for partner A
    });

    it('renders partner B track with identity class blocks', () => {
      const el = createOverlapRibbon(baseOptions);
      const blocksB = el.querySelectorAll('.overlap-ribbon__block--b');
      expect(blocksB.length).toBe(2); // two busy blocks for partner B
    });

    it('renders the combined band with free window segments', () => {
      const el = createOverlapRibbon(baseOptions);
      const combined = el.querySelector('.overlap-ribbon__combined');
      expect(combined).not.toBeNull();
      const freeSegments = combined.querySelectorAll('.overlap-ribbon__free');
      expect(freeSegments.length).toBe(2); // two free windows
    });

    it('applies overlap-fill class (gradient) to free window segments', () => {
      const el = createOverlapRibbon(baseOptions);
      const freeSegments = el.querySelectorAll('.overlap-ribbon__free');
      for (const seg of freeSegments) {
        expect(seg.classList.contains('overlap-fill')).toBe(true);
      }
    });

    it('marks minor windows with reduced opacity class', () => {
      const el = createOverlapRibbon(baseOptions);
      const minorSegments = el.querySelectorAll('.overlap-ribbon__free--minor');
      // The 1h window is shorter than the 2h window, so it's minor
      expect(minorSegments.length).toBe(1);
    });

    it('does not mark the longest window as minor', () => {
      const el = createOverlapRibbon(baseOptions);
      const freeSegments = el.querySelectorAll('.overlap-ribbon__free');
      // Find the one without --minor class
      const major = Array.from(freeSegments).filter(
        seg => !seg.classList.contains('overlap-ribbon__free--minor')
      );
      expect(major.length).toBe(1);
    });

    it('renders hour markers', () => {
      const el = createOverlapRibbon(baseOptions);
      const hourMarks = el.querySelectorAll('.overlap-ribbon__hour-mark');
      expect(hourMarks.length).toBeGreaterThan(0);
    });

    it('positions busy blocks within 0-100% range', () => {
      const el = createOverlapRibbon(baseOptions);
      const blocks = el.querySelectorAll('.overlap-ribbon__block');
      for (const block of blocks) {
        const left = parseFloat(block.style.left);
        const width = parseFloat(block.style.width);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThanOrEqual(100);
        expect(width).toBeGreaterThan(0);
        expect(left + width).toBeLessThanOrEqual(100.01); // tolerance for rounding
      }
    });

    it('positions free segments within 0-100% range', () => {
      const el = createOverlapRibbon(baseOptions);
      const segments = el.querySelectorAll('.overlap-ribbon__free');
      for (const seg of segments) {
        const left = parseFloat(seg.style.left);
        const width = parseFloat(seg.style.width);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThanOrEqual(100);
        expect(width).toBeGreaterThan(0);
        expect(left + width).toBeLessThanOrEqual(100.01);
      }
    });
  });

  describe('edge cases', () => {
    it('renders empty state when no free windows exist', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        freeWindows: [],
      });
      const ariaLabel = el.getAttribute('aria-label');
      expect(ariaLabel).toContain('No mutual free time');
      const total = el.querySelector('.overlap-ribbon__total');
      expect(total.textContent).toBe('0m free');
    });

    it('renders correctly with no busy blocks', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        busyBlocksA: [],
        busyBlocksB: [],
      });
      const blocks = el.querySelectorAll('.overlap-ribbon__block');
      expect(blocks.length).toBe(0);
    });

    it('shows empty message for invalid range (dayStart >= dayEnd)', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        dayStart: hourDate(23),
        dayEnd: hourDate(8),
      });
      const empty = el.querySelector('.overlap-ribbon__empty');
      expect(empty).not.toBeNull();
      expect(empty.textContent).toContain('No time range');
    });

    it('all windows same duration: none marked as minor', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        freeWindows: [
          { start: hourDate(10), end: hourDate(11) },
          { start: hourDate(14), end: hourDate(15) },
        ],
      });
      const minor = el.querySelectorAll('.overlap-ribbon__free--minor');
      expect(minor.length).toBe(0);
    });

    it('single free window is not marked as minor', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        freeWindows: [{ start: hourDate(10), end: hourDate(12) }],
      });
      const minor = el.querySelectorAll('.overlap-ribbon__free--minor');
      expect(minor.length).toBe(0);
      const freeSegments = el.querySelectorAll('.overlap-ribbon__free');
      expect(freeSegments.length).toBe(1);
    });
  });

  describe('renderOverlapRibbon', () => {
    it('renders into a container and clears previous content', () => {
      const container = document.createElement('div');
      container.innerHTML = '<p>old content</p>';

      renderOverlapRibbon(container, baseOptions);

      expect(container.querySelector('p')).toBeNull();
      expect(container.querySelector('.overlap-ribbon')).not.toBeNull();
    });
  });

  describe('duration formatting', () => {
    it('formats minutes-only durations correctly', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        freeWindows: [{ start: hourDate(10), end: hourDate(10, 45) }],
      });
      const total = el.querySelector('.overlap-ribbon__total');
      expect(total.textContent).toBe('45m free');
    });

    it('formats hours and minutes durations correctly', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        freeWindows: [{ start: hourDate(10), end: hourDate(11, 30) }],
      });
      const total = el.querySelector('.overlap-ribbon__total');
      expect(total.textContent).toBe('1h 30m free');
    });

    it('formats exact hours without minutes suffix', () => {
      const el = createOverlapRibbon({
        ...baseOptions,
        freeWindows: [{ start: hourDate(10), end: hourDate(12) }],
      });
      const total = el.querySelector('.overlap-ribbon__total');
      expect(total.textContent).toBe('2h free');
    });
  });

  describe('track labels', () => {
    it('includes partner names as track labels', () => {
      const el = createOverlapRibbon(baseOptions);
      const labels = el.querySelectorAll('.overlap-ribbon__track-label');
      const labelTexts = Array.from(labels).map(l => l.textContent);
      expect(labelTexts).toContain('Jamall');
      expect(labelTexts).toContain('Rebecca');
    });

    it('includes "Both free" label on combined band', () => {
      const el = createOverlapRibbon(baseOptions);
      const label = el.querySelector('.overlap-ribbon__combined-label');
      expect(label).not.toBeNull();
      expect(label.textContent).toBe('Both free');
    });
  });
});
