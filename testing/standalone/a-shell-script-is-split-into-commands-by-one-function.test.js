/**
 * A workflow step's shell script is split into its simple commands by ONE function, `shellCommands` in
 * `testing/_shared/ci-workflow.mjs` (bundle-56 pre-ship, duplicate sweep N2).
 *
 * ## What this prevents
 *
 * `scripts/unrun-tests.mjs` (which test files CI selects) and `testing/_shared/compose-start-sets.mjs` (which services a
 * job starts) each read the SAME `shellOf` output and each wrote its own splitter. They disagreed about `a & b`: one
 * did not split on a single `&` at all, the other split on every `&` — including the one inside `2>&1`, which tore
 * `docker compose up -d app 2>&1` into `… app 2>` and `1`, and read `2>` as a service name. A command run in the
 * background was invisible to one reader and a redirect was a command to the other.
 *
 * ## The rule
 *
 * - the separators are `&&`, `||`, `;`, `|`, a newline, and a single `&` that is a control operator;
 * - a `&` that is part of a redirection (`2>&1`, `>&2`, `&>file`, `<&3`) is not a separator;
 * - a trailing `&` (a command sent to the background) ends the command, and leaves no empty one;
 * - the pieces come back trimmed, empty ones dropped.
 *
 * And no other file splits a script itself: both consumers import it, and neither spells a splitter of its own (derived
 * from the two consumers' code, comments removed).
 *
 * Run: node --test testing/standalone/a-shell-script-is-split-into-commands-by-one-function.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { shellCommands } from '../_shared/ci-workflow.mjs';
import { startsComposeStack, upCommands } from '../_shared/compose-start-sets.mjs';

/** [what, script, commands]. */
const ROWS = [
  ['one command', 'npm test', ['npm test']],
  ['&&', 'npm ci && npm test', ['npm ci', 'npm test']],
  ['||', 'npm ci || exit 1', ['npm ci', 'exit 1']],
  [';', 'a; b', ['a', 'b']],
  ['a pipe', 'cat x | grep y', ['cat x', 'grep y']],
  ['a newline', 'set -e\nnpm test', ['set -e', 'npm test']],
  ['a single & between two commands', 'a & b', ['a', 'b']],
  ['a trailing & (backgrounded)', 'docker compose pull &', ['docker compose pull']],
  ['a trailing & and a wait', 'pull & \nwait $!', ['pull', 'wait $!']],
  ['2>&1 is a redirection, not a separator', 'docker compose up -d app 2>&1', ['docker compose up -d app 2>&1']],
  ['>&2', 'echo no >&2', ['echo no >&2']],
  ['&>file', 'cmd &> out.log', ['cmd &> out.log']],
  ['<&3', 'cmd <&3', ['cmd <&3']],
  ['a redirection beside a real &', 'a 2>&1 & b', ['a 2>&1', 'b']],
  ['blank lines and padding', '\n  a  \n\n  b  \n', ['a', 'b']],
  ['nothing', '', []],
];

describe('shellCommands', () => {
  for (const [what, script, commands] of ROWS) {
    it(what, () => assert.deepEqual(shellCommands(script), commands));
  }
  it('takes anything printable', () => {
    assert.deepEqual(shellCommands(undefined), []);
    assert.deepEqual(shellCommands(null), []);
  });
});

describe('both readers of a workflow script agree on what it says', () => {
  it('a compose up followed by & is a start, and its redirect is not a service', () => {
    assert.ok(startsComposeStack('docker compose up -d app 2>&1 &'));
    assert.deepEqual(upCommands('docker compose up -d app 2>&1'), [{ profiles: [], services: ['app'] }]);
    assert.deepEqual(upCommands('docker compose up -d app & docker compose up -d other'), [
      { profiles: [], services: ['app'] }, { profiles: [], services: ['other'] },
    ]);
  });
});

describe('no consumer splits a script itself', () => {
  const CONSUMERS = ['scripts/unrun-tests.mjs', 'testing/_shared/compose-start-sets.mjs'];
  for (const file of CONSUMERS) {
    it(`${file} imports shellCommands and spells no splitter`, () => {
      const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      assert.match(code, /\bshellCommands\b[^;]*from\s+'[^']*ci-workflow\.mjs'/, `${file} does not import shellCommands from ci-workflow.mjs`);
      assert.doesNotMatch(code, /\.split\(\s*\/[^/\n]*(?:&&|\\\|\\\|)[^/\n]*\//, `${file} splits a shell script on its own separators`);
    });
  }
  it('the pattern sees a splitter, and ignores a split that is not one', () => {
    const splitter = /\.split\(\s*\/[^/\n]*(?:&&|\\\|\\\|)[^/\n]*\//;
    assert.match("script.split(/&&|\\|\\||;|\\n/)", splitter);
    assert.doesNotMatch("line.split(/\\s+/)", splitter);
  });
});
