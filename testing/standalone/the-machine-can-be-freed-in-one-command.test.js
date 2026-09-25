/**
 * `npm run machine:free` frees this machine's disk and memory in one command, and destroys nothing it should keep
 * (`Q-55`).
 *
 * Owner-requested 2026-09-24, so that a memory crash or a full Docker disk is one command rather than the right
 * sequence of four remembered steps. It was built and sat on a branch for a day with no tracker row, while the flow's
 * machine-trouble convention told the loop to run it.
 *
 * The part worth a gate is what it must NOT do. The default run removes the TEST stack and prunes only what no running
 * container needs; the whole data disk — a running instance's database with it — goes only with `-Wipe`.
 *
 * Run: node --test testing/standalone/the-machine-can-be-freed-in-one-command.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const PKG = JSON.parse(readFileSync('package.json', 'utf8'));
const SCRIPT = 'scripts/machine-free.ps1';
const code = () => readFileSync(SCRIPT, 'utf8').split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('npm run machine:free', () => {
  it('is a script, and the file it runs exists', () => {
    assert.match(PKG.scripts?.['machine:free'] ?? '', /scripts\/machine-free\.ps1/, 'package.json has no machine:free');
    assert.ok(existsSync(SCRIPT), `${SCRIPT} is missing`);
  });

  it('removes the TEST stack and nothing else by name', () => {
    const downs = [...code().matchAll(/docker compose[^\n]*down[^\n]*/g)].map(m => m[0]);
    assert.ok(downs.length > 0, 'it no longer removes the test stack');
    for (const d of downs) assert.match(d, /-p ythril-test\b/, `a compose down outside the test project: ${d}`);
  });

  it('wipes the data disk only when asked with -Wipe', () => {
    const src = code();
    const at = src.indexOf('docker-wipe.ps1');
    assert.ok(at > -1, 'the -Wipe path is gone');
    assert.match(src.slice(Math.max(0, src.lastIndexOf('if', at) - 1), at), /if \(\$Wipe\)/, 'docker-wipe runs without -Wipe');
  });
});
