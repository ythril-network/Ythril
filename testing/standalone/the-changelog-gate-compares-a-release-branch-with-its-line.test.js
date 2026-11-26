/**
 * The preflight's changelog gate compares a branch with the release line it tracks, never with main.
 *
 * A patch branch on `release/6.5.x` holds that line's changelog. Compared with `origin/main` the gate failed on every
 * patch, the untouched v6.5.6 included, so no preflight pass could be recorded for 6.5.7 (2026-11-26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changelogBase } from '../../scripts/_shared/changelog-base.mjs';

test('a branch tracking a release line is compared with that line; anything else with main', () => {
  assert.equal(changelogBase({ upstream: 'origin/release/6.5.x\n' }), 'origin/release/6.5.x');
  assert.equal(changelogBase({ upstream: 'origin/bundle-372' }), 'origin/main');
  assert.equal(changelogBase({ upstream: '' }), 'origin/main', 'no upstream is main');
  assert.equal(changelogBase({ upstream: 'origin/release/a/b' }), 'origin/main', 'only one path segment after release/');
  assert.equal(changelogBase({ upstream: 'origin/release/6.5.x', override: 'origin/release/5.6.x' }), 'origin/release/5.6.x', 'the override wins');
});

test('the preflight passes the derived base to the changelog check, not a bare call', () => {
  const src = readFileSync(new URL('../../scripts/preflight.mjs', import.meta.url), 'utf8');
  assert.match(src, /changelogBase\(/, 'the preflight derives the base');
  assert.match(src, /check-changelog\.mjs \$\{changelogAgainst\}/, 'and hands it to the check');
  assert.doesNotMatch(src, /run\('node \.\/scripts\/check-changelog\.mjs'\)/, 'never the bare call that meant main');
});
