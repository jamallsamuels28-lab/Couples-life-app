// ============================================================
// Design token contrast
// ============================================================
//
// --ink-3 shipped at 3.3:1 against --surface. It is the colour behind every
// placeholder, field hint and "nothing logged" line, so the text you most need
// when a form is misbehaving was the least readable text on the page, and on a
// phone it was effectively invisible. Nothing caught it because contrast was
// never asserted anywhere — it was a judgement made by eye in a dark room.
//
// This reads the real token file rather than a copy of the values, so editing
// design-tokens.css is what the test is actually checking.
// ============================================================

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const tokensPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'css', 'design-tokens.css');
const css = readFileSync(tokensPath, 'utf8');

/** WCAG 2.1 relative luminance of an #rrggbb string. */
function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255)
    + 0.7152 * channel((n >> 8) & 255)
    + 0.0722 * channel(n & 255);
}

export function contrastRatio(a, b) {
  const x = relativeLuminance(a);
  const y = relativeLuminance(b);
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pulls the hex custom properties out of one `:root[data-theme="..."]` block. */
function readTheme(theme) {
  const block = css.match(
    new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([\\s\\S]*?)\\}`)
  );
  if (!block) throw new Error(`No :root[data-theme="${theme}"] block in design-tokens.css`);

  const tokens = {};
  for (const [, name, value] of block[1].matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) {
    tokens[name] = value;
  }
  return tokens;
}

// Every background an ink colour is ever painted on.
const BACKGROUNDS = ['--bg', '--surface', '--surface-2'];
const AA_NORMAL = 4.5;

describe.each(['dark', 'light'])('%s theme contrast', (theme) => {
  const tokens = readTheme(theme);

  it('defines the ink and surface tokens', () => {
    for (const name of ['--ink', '--ink-2', '--ink-3', ...BACKGROUNDS]) {
      expect(tokens[name], `${name} missing from ${theme} theme`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  // --ink-3 is the one that regressed, but --ink and --ink-2 are held to the
  // same floor so a future "just soften it slightly" cannot walk any of them
  // back under AA.
  describe.each(['--ink', '--ink-2', '--ink-3'])('%s', (ink) => {
    it.each(BACKGROUNDS)(`meets WCAG AA on %s`, (background) => {
      const ratio = contrastRatio(tokens[ink], tokens[background]);
      expect(
        Number(ratio.toFixed(2)),
        `${ink} (${tokens[ink]}) on ${background} (${tokens[background]}) is ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });

  it('keeps the three inks visually ordered', () => {
    // The hierarchy is the point of having three. If --ink-2 and --ink-3 drift
    // together, raising contrast has just flattened the design instead.
    const onSurface = (ink) => contrastRatio(tokens[ink], tokens['--surface']);
    expect(onSurface('--ink')).toBeGreaterThan(onSurface('--ink-2'));
    expect(onSurface('--ink-2')).toBeGreaterThan(onSurface('--ink-3'));
  });
});

describe('type scale', () => {
  // iOS Safari zooms the viewport when a focused input renders under 16px.
  // .input is sized with --t-base, so the small-viewport value of --t-base is
  // load-bearing for the layout not lurching sideways on every tap.
  it('reaches 16px for --t-base on small viewports', () => {
    const mobile = css.match(/@media \(max-width: 640px\)\s*\{([\s\S]*?)\n\}/);
    expect(mobile, 'no small-viewport type block in design-tokens.css').not.toBeNull();

    const base = mobile[1].match(/--t-base:\s*([\d.]+)rem/);
    expect(base, '--t-base not overridden on small viewports').not.toBeNull();
    expect(Number(base[1]) * 16).toBeGreaterThanOrEqual(16);
  });

  it('keeps --t-xs above 11px', () => {
    const xs = css.match(/--t-xs:\s*([\d.]+)rem/);
    expect(Number(xs[1]) * 16).toBeGreaterThan(11);
  });
});
