/**
 * The benchmark harness's `-down` commands remove containers, volumes and a network by the run's name prefix. Without `--work` (or
 * `--name-prefix`) the prefix was the default run's, silently: a `ythril-down` meant for another run's folder took down the default run's
 * instance (Q-942 fix round, H1 follow-up).
 *
 * ## What it holds
 *
 * - `oxigraph-down` and `ythril-down` refuse to run when the command names neither `--work` nor `--name-prefix`, saying which flag to give;
 *   the refusal comes before any container is touched (docker is not on the test's PATH, so a command that got past it would fail on that).
 * - With `--work` or `--name-prefix` the command is past the guard.
 * - The up commands and the others keep working on the default folder.
 *
 * Run: node --test testing/standalone/bsbm-harness-down-needs-its-run.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOAD = fileURLToPath(new URL('../../benchmarks/rdf/load.mjs', import.meta.url));
/** A PATH with no docker on it: a command past the guard fails on that, never on a container of this machine. */
const NO_DOCKER = mkdtempSync(join(tmpdir(), 'bsbm-down-'));

function run(...args) {
  return spawnSync(process.execPath, [LOAD, ...args], { encoding: 'utf8', env: { PATH: NO_DOCKER, SystemRoot: process.env.SystemRoot ?? '' } });
}

for (const cmd of ['oxigraph-down', 'ythril-down']) {
  test(`${cmd} without --work or --name-prefix is refused before it touches anything`, () => {
    const r = run(cmd, '--size', '1000');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--work/);
    assert.match(r.stderr, /--name-prefix/);
    assert.doesNotMatch(r.stderr, /docker/i);
  });

  test(`${cmd} with --work is past the guard`, () => {
    const r = run(cmd, '--size', '1000', '--work', 'E:/TMP/Ythril/data/b358-guard-probe-bench');
    assert.doesNotMatch(r.stderr, /refuses to run without/);
  });

  test(`${cmd} with --name-prefix is past the guard`, () => {
    const r = run(cmd, '--size', '1000', '--name-prefix', 'b358-probe');
    assert.doesNotMatch(r.stderr, /refuses to run without/);
  });
}

test('downNeedsItsRun names the flags, and only for a -down command', async () => {
  const { downNeedsItsRun } = await import('../../benchmarks/rdf/env.mjs');
  assert.throws(() => downNeedsItsRun('ythril-down', {}), /--work.*--name-prefix/s);
  assert.doesNotThrow(() => downNeedsItsRun('ythril-down', { work: 'x' }));
  assert.doesNotThrow(() => downNeedsItsRun('ythril-down', { 'name-prefix': 'x' }));
  assert.doesNotThrow(() => downNeedsItsRun('ythril-up', {}));
  assert.doesNotThrow(() => downNeedsItsRun('ythril-limits', {}));
});
