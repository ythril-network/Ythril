/**
 * A local test stack runs the checkout it was started from: every `npm run` script that brings the stack up builds the image (Q-656).
 *
 * ## What it prevents
 *
 * `docker compose up` builds an image only when none carries the tag. `testing/docker-compose.test.yml` names `ythril-test:latest`, so a
 * `npm run test:up` after a branch switch, a pull or an edit started the image of whatever was built last, and the integration and sync
 * suites then tested code that was not in the working tree: the bundle-211 token cases passed against a stack that never held the fix,
 * and a failure in code that had been fixed looked like a regression in the change under test. `test:up:rebuild` always built; the script
 * people run first did not, and nothing said so.
 *
 * ## The rule
 *
 * Every script of `package.json` whose command runs `docker compose` against the test compose file with `up` carries `--build`, unless it
 * says `--no-build` (the CI shape, which loads an image it was given). The scripts are found in the parsed `package.json`, never listed,
 * with a floor: a read that finds none passes every loop written over it.
 *
 * Run: node --test testing/standalone/a-local-test-stack-is-built-from-the-checkout.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts;

/** The `docker compose ... up ...` commands of a script, each a segment between `&&`. */
const upCommands = (command) => command.split('&&').map(s => s.trim())
  .filter(s => /^docker compose\b/.test(s) && /docker-compose\.test\.yml/.test(s) && /\sup(\s|$)/.test(s));

describe('a script that starts the local test stack builds its image', () => {
  const found = Object.entries(scripts).flatMap(([name, command]) => upCommands(command).map(up => ({ name, up })));

  it('finds the scripts that start the stack, with a floor, and test:up is one of them', () => {
    assert.ok(found.length >= 2, `only ${found.length} script(s) start the test stack: the read finds nothing, or the stack scripts were renamed`);
    assert.ok(found.some(f => f.name === 'test:up'), `test:up starts no stack any more: ${found.map(f => f.name).join(', ')}`);
    assert.ok(found.some(f => f.name === 'test:up:rebuild'), 'test:up:rebuild starts no stack any more');
  });

  it('each carries --build, unless it says --no-build', () => {
    for (const { name, up } of found) {
      if (/--no-build\b/.test(up)) continue;
      assert.match(up, /\sup\b[^&]*\s--build\b/,
        `npm run ${name} starts the stack with no --build, so a local stack runs the image that was last built, not the checkout: ${up}`);
    }
  });
});
