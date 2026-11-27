/**
 * The preflight's changelog gate compares a branch with the release line it tracks, never with main.
 *
 * A patch branch on `release/6.5.x` holds that line's changelog. Compared with `origin/main` the gate failed on every
 * patch, the untouched v6.5.6 included, so no preflight pass could be recorded for 6.5.7 (2026-11-26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { changelogBase, gitResolves } from '../../scripts/_shared/changelog-base.mjs';

test('a branch tracking a release line is compared with that line; anything else with main', () => {
  assert.equal(changelogBase({ upstream: 'origin/release/6.5.x\n' }), 'origin/release/6.5.x');
  assert.equal(changelogBase({ upstream: 'origin/bundle-372' }), 'origin/main');
  assert.equal(changelogBase({ upstream: '' }), 'origin/main', 'no upstream is main');
  assert.equal(changelogBase({ upstream: 'origin/release/a/b' }), 'origin/main', 'only one path segment after release/');
  assert.equal(changelogBase({ upstream: 'origin/release/6.5.x', override: 'origin/release/5.6.x', resolves: () => true }), 'origin/release/5.6.x', 'the override wins');
});

test('an upstream ref name that holds a shell character is never the base (Q-970): git admits ; $( & | and backticks in a ref', () => {
  for (const upstream of ['origin/release/x;y', 'origin/release/$(id)', 'origin/release/x&y', 'origin/release/x|y', 'origin/release/`id`', 'origin/release/x y']) {
    assert.equal(changelogBase({ upstream }), 'origin/main', upstream);
  }
});

test('an override that starts with - or holds a character outside [A-Za-z0-9._/-] is refused, never passed on', () => {
  for (const override of ['--output=x', '-x', 'origin/main;id', '$(id)', 'a`id`', 'a&b', 'a b', 'a|b']) {
    assert.throws(() => changelogBase({ override, resolves: () => true }), /PREFLIGHT_CHANGELOG_BASE/, override);
  }
});

test('an override git cannot resolve fails with a sentence naming it, so a mistyped one never skips the check (Q-970)', () => {
  assert.throws(() => changelogBase({ override: 'origin/relase/6.5.x', resolves: () => false }), /PREFLIGHT_CHANGELOG_BASE.*origin\/relase\/6\.5\.x.*does not resolve/s);
  assert.equal(changelogBase({ override: 'origin/main', resolves: (ref) => ref === 'origin/main' }), 'origin/main');
  assert.equal(gitResolves('HEAD'), true, 'the real resolver finds a commit');
  assert.equal(gitResolves('origin/no-such-branch-for-this-test'), false, 'and refuses a ref that is not there');
});

test('the preflight hands the derived base to the changelog check as an argument, never inside a shell string', () => {
  const src = readFileSync(new URL('../../scripts/preflight.mjs', import.meta.url), 'utf8');
  assert.match(src, /changelogBase\(/, 'the preflight derives the base');
  assert.match(src, /execFileSync\(\s*'node',\s*\['\.\/scripts\/check-changelog\.mjs', changelogAgainst\]/, 'and hands it to the check as an argument');
  assert.doesNotMatch(src, /check-changelog\.mjs \$\{/, 'never interpolated into a command string');
  assert.doesNotMatch(src, /run\('node \.\/scripts\/check-changelog\.mjs'\)/, 'never the bare call that meant main');
});
