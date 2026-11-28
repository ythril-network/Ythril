/**
 * Every container the RDF benchmark harness starts is limited to what it booked. The harness books memory and CPUs for a container
 * with the docker booking, but started its containers with a memory limit only: a load could take every CPU of the shared machine
 * while the booking said 2 (found on a booking check, bundle-384 fix round). Its booking label was an old bundle's, so a run showed
 * under the wrong name.
 *
 * ## What it holds
 *
 * - `docker()`, `dockerOk()` and `dockerAsync()` (the helpers every start goes through) hand `docker run` both `-m` and `--cpus`,
 *   the CPU count equal to the one the booking is asked for (`--cpus` of the booking command), added inside the helper so a call
 *   site cannot leave it out; a `run` that names its own `--cpus` keeps it, and a command that is not a `run` is left alone.
 * - No harness file starts a container any other way (a plain `docker run` outside the helpers is booked by nobody).
 * - The default booking label names the harness, not a bundle.
 *
 * The booking script is replaced by one that prints the command it was given, so no container starts and nothing is booked.
 *
 * Run: node --test testing/standalone/bsbm-harness-books-its-cpus.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = mkdtempSync(join(tmpdir(), 'bsbm-cpus-'));
const FAKE = join(DIR, 'booking.js');
writeFileSync(FAKE, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
process.env.DOCKER_BOOKING = FAKE;
delete process.env.DOCKER_BOOKING_LABEL;
const { docker, dockerOk, dockerAsync } = await import('../../benchmarks/rdf/env.mjs');

const flagAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];
const dockerPart = (argv) => argv.slice(argv.indexOf('--') + 1);

const HELPERS = {
  docker: (a, o) => JSON.parse(docker(a, o).stdout),
  dockerOk: (a, o) => JSON.parse(dockerOk(a, o).stdout),
  dockerAsync: async (a, o) => JSON.parse((await dockerAsync(a, o)).stdout),
};

for (const [name, run] of Object.entries(HELPERS)) {
  test(`${name}: a docker run carries -m and --cpus, the CPUs equal to the booked ones`, async () => {
    const argv = await run(['run', '--rm', '-v', 'a:/a', 'img', 'cmd'], { mem: 3 });
    const d = dockerPart(argv);
    assert.equal(d[0], 'docker');
    assert.ok(d.includes('-m'), `no -m in: ${d.join(' ')}`);
    assert.ok(d.includes('--cpus'), `no --cpus in: ${d.join(' ')}`);
    assert.equal(flagAfter(d, '--cpus'), flagAfter(argv, '--cpus'), 'the container limit and the booking name different CPU counts');
    assert.ok(Number(flagAfter(d, '--cpus')) > 0);
    assert.equal(flagAfter(d, '-m'), '3g', 'the memory limit is not what was booked');
    // the limits come before the image, where docker reads its options
    assert.ok(d.indexOf('--cpus') < d.indexOf('img') && d.indexOf('-m') < d.indexOf('img'));
  });

  test(`${name}: a run that names its own limits keeps them, and the booking is told the same CPUs`, async () => {
    const argv = await run(['run', '-d', '-m', '4g', '--cpus', '3', 'img'], { mem: 4, cpus: 3 });
    const d = dockerPart(argv);
    assert.equal(d.filter((x) => x === '--cpus').length, 1);
    assert.equal(d.filter((x) => x === '-m').length, 1);
    assert.equal(flagAfter(d, '--cpus'), '3');
    assert.equal(flagAfter(argv, '--cpus'), '3');
  });

  test(`${name}: a command that starts no container is left as it is`, async () => {
    const argv = await run(['volume', 'create', 'v'], { mem: 1 });
    assert.deepEqual(dockerPart(argv), ['docker', 'volume', 'create', 'v']);
  });
}

test('a held start (a detached container) is limited and booked with the same CPUs', () => {
  const argv = JSON.parse(docker(['run', '-d', '--name', 'n', 'img'], { mem: 2, hold: ['n'] }).stdout);
  assert.equal(argv[0], 'hold');
  assert.equal(flagAfter(dockerPart(argv), '--cpus'), flagAfter(argv, '--cpus'));
});

test('the default booking label names the harness, not a bundle', () => {
  const argv = JSON.parse(docker(['run', 'img'], { mem: 1 }).stdout);
  assert.equal(flagAfter(argv, '--label'), 'rdf-bench');
});

test('no harness file starts a container outside the booked helpers', () => {
  const root = fileURLToPath(new URL('../../benchmarks/rdf/', import.meta.url));
  const offenders = [];
  for (const f of readdirSync(root).filter((n) => n.endsWith('.mjs') && n !== 'env.mjs')) {
    const src = readFileSync(join(root, f), 'utf8');
    for (const m of src.matchAll(/(dockerPlain|spawn|spawnSync|execFileSync|execFile)\(\s*(\[\s*)?'(docker'\s*,\s*\[\s*)?'run'/g)) offenders.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], 'start containers through docker()/dockerOk()/dockerAsync() so they are booked and limited');
});
