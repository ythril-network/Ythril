/**
 * Standalone tests: Theme postMessage token filtering logic
 *
 * The ThemeService.handleThemeMessage() method only applies CSS custom
 * properties (prefixed with `--`) and rejects standard CSS property names.
 * This test validates that filtering contract via a minimal mock.
 *
 * Since the full Angular DI and browser DOM are not available in Node.js,
 * we replicate the exact filtering logic from theme.service.ts and test
 * it directly to ensure the security invariant holds.
 *
 * Run: node --test testing/standalone/theme-postmessage.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Replicated from client/src/app/core/theme.service.ts — handleThemeMessage().
 * If this logic changes in the source, this test must be updated.
 *
 * Returns the set of properties that WOULD be applied by setProperty().
 */
function filterThemeTokens(tokens) {
  const accepted = {};
  if (!tokens || typeof tokens !== 'object') return accepted;
  for (const [prop, value] of Object.entries(tokens)) {
    if (typeof prop === 'string' && prop.startsWith('--') && typeof value === 'string') {
      accepted[prop] = value;
    }
  }
  return accepted;
}

describe('Theme postMessage — token filtering', () => {
  it('accepts CSS custom properties (--prefixed)', () => {
    const result = filterThemeTokens({
      '--color-primary': '#ff0000',
      '--bg-surface': 'rgba(0,0,0,0.9)',
      '--font-size': '16px',
    });
    assert.deepEqual(result, {
      '--color-primary': '#ff0000',
      '--bg-surface': 'rgba(0,0,0,0.9)',
      '--font-size': '16px',
    });
  });

  it('rejects standard CSS properties (no -- prefix)', () => {
    const result = filterThemeTokens({
      'display': 'none',
      'visibility': 'hidden',
      'position': 'absolute',
      'opacity': '0',
      'z-index': '99999',
    });
    assert.deepEqual(result, {}, 'Standard CSS properties must be rejected');
  });

  it('rejects mixed — keeps only --prefixed', () => {
    const result = filterThemeTokens({
      '--accent': 'blue',
      'display': 'none',
      '--bg': '#000',
      'color': 'red',
    });
    assert.deepEqual(result, {
      '--accent': 'blue',
      '--bg': '#000',
    });
  });

  it('rejects non-string values', () => {
    const result = filterThemeTokens({
      '--color': 123,
      '--bg': null,
      '--font': undefined,
      '--ok': 'valid',
    });
    assert.deepEqual(result, { '--ok': 'valid' });
  });

  it('rejects non-string property names', () => {
    const tokens = {};
    tokens[42] = 'red';
    tokens['--valid'] = 'blue';
    const result = filterThemeTokens(tokens);
    // 42 gets coerced to "42" by JS, which doesn't start with --
    assert.deepEqual(result, { '--valid': 'blue' });
  });

  it('rejects null and non-object tokens', () => {
    assert.deepEqual(filterThemeTokens(null), {});
    assert.deepEqual(filterThemeTokens(undefined), {});
    assert.deepEqual(filterThemeTokens('string'), {});
    assert.deepEqual(filterThemeTokens(42), {});
  });

  it('rejects empty tokens object', () => {
    assert.deepEqual(filterThemeTokens({}), {});
  });

  it('rejects properties that look close but are not --prefixed', () => {
    const result = filterThemeTokens({
      '-webkit-appearance': 'none',
      '-moz-appearance': 'none',
      '_--trick': 'red',
      ' --spaced': 'red',
    });
    assert.deepEqual(result, {}, 'Single-dash and tricky prefixes must be rejected');
  });

  it('accepts deeply nested CSS variable names', () => {
    const result = filterThemeTokens({
      '--ythril-sidebar-bg-hover': '#123456',
    });
    assert.deepEqual(result, { '--ythril-sidebar-bg-hover': '#123456' });
  });
});
