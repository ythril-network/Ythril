/**
 * Every CSS custom property the client reads is defined somewhere.
 *
 * `var(--border-color)` styled the conflict page's action selects, and no theme defines `--border-color` (the token
 * is `--border`). An undefined property is not an error anywhere: the declaration is dropped, the select lost its
 * border and background, and on the dark themes the one editable column read like the text beside it. Found by the
 * owner from a screenshot, 2026-09-27.
 *
 * The sets are DERIVED: every `--name:` declared in the client's styles and component sources, against every
 * `var(--name)` read without a fallback. A `var(--x, fallback)` is exempt, because its author said what happens when
 * the token is missing.
 *
 * Run: node --test testing/standalone/every-css-variable-the-client-uses-is-defined.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';

const files = trackedSources(['client/src'], { ext: ['.ts', '.scss', '.css', '.html'], specs: false, untracked: true });
// Block comments stripped: prose that NAMES a var() (brand-logo explains `fill="var(--x)"`) is not a read.
const text = files.map(f => [f, readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ')]);

const defined = new Set();
for (const [, s] of text) for (const m of s.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
// A property set from code (`style.setProperty('--x', …)`) is defined too.
for (const [, s] of text) for (const m of s.matchAll(/setProperty\(\s*['"`](--[a-zA-Z0-9-]+)/g)) defined.add(m[1]);

describe('every CSS custom property the client reads is defined', () => {
  it('found the tokens and the reads (the check itself works)', () => {
    assert.ok(defined.size >= 20, `only ${defined.size} custom properties found — the derivation is wrong`);
    assert.ok(files.length >= 50, `only ${files.length} client sources found`);
  });

  it('no var() without a fallback names a property nothing defines', () => {
    const missing = [];
    for (const [f, s] of text) {
      for (const m of s.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*\)/g)) {
        if (!defined.has(m[1])) missing.push(`${f}: ${m[1]}`);
      }
    }
    assert.deepEqual([...new Set(missing)], [],
      'these read a custom property no stylesheet defines, so the declaration is silently dropped. Use the theme '
      + 'token that exists (see styles.scss), or give the var() a fallback.');
  });
});
