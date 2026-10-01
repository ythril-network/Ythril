/**
 * How many CPUs this process may actually use (`util/cpu-budget.ts`): the host's count, capped by the cgroup quota.
 *
 * ## Why this is a question of its own
 *
 * A container limited to one CPU on a 16-core node still sees 16 cores, and onnxruntime sized its intra-op pool from
 * exactly that: sixteen threads sharing one CPU's worth of CFS quota, throttled for most of every period. A recent
 * runtime's `os.availableParallelism()` reads the quota itself, an older one does not, so the module reads it too. Measured in the test stack's container (cpus: 1.0 on 16 cores): 640 ms per text
 * with the default pool, 54 ms with one thread. The quota IS visible from inside the container, in the cgroup files;
 * this module is the one place that reads them.
 *
 * ## The contract
 *
 *   availableCpus({ readFile?, availableParallelism? } = {}) -> integer >= 1
 *     min(host count, floor(quota / period)), at least 1; cgroup v2 `cpu.max` first, then v1's two files;
 *     an unlimited quota, a missing file or anything unparseable is the host count. Never throws.
 *
 * Run: node --test testing/standalone/cpu-budget.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

let availableCpus;
before(async () => { ({ availableCpus } = await import('../../server/dist/util/cpu-budget.js')); });

const V2 = '/sys/fs/cgroup/cpu.max';
const V1_QUOTA = '/sys/fs/cgroup/cpu/cpu.cfs_quota_us';
const V1_PERIOD = '/sys/fs/cgroup/cpu/cpu.cfs_period_us';

/** A filesystem holding exactly `files`; every other path is ENOENT, as on a host without that cgroup version. */
const fsWith = (files) => (p) => {
  const key = String(p).replace(/\\/g, '/');
  if (key in files) return files[key];
  throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
};

const cpus = (files, host = 16) => availableCpus({ readFile: fsWith(files), availableParallelism: () => host });

describe('cgroup v2 (cpu.max)', () => {
  it('a one-CPU quota is 1 on a 16-core host', () => assert.equal(cpus({ [V2]: '100000 100000\n' }), 1));
  it('a four-CPU quota is 4', () => assert.equal(cpus({ [V2]: '400000 100000\n' }), 4));
  it('a fractional quota floors: 1.5 CPUs is 1', () => assert.equal(cpus({ [V2]: '150000 100000\n' }), 1));
  it('"max" is unlimited: the host count', () => assert.equal(cpus({ [V2]: 'max 100000\n' }), 16));
  it('a quota below one CPU is still 1, never 0', () => assert.equal(cpus({ [V2]: '20000 100000\n' }), 1));
});

describe('cgroup v1 (cfs_quota_us / cfs_period_us)', () => {
  it('reads the two files when there is no cpu.max', () => {
    assert.equal(cpus({ [V1_QUOTA]: '200000\n', [V1_PERIOD]: '100000\n' }), 2);
  });
  it('-1 is unlimited: the host count', () => {
    assert.equal(cpus({ [V1_QUOTA]: '-1\n', [V1_PERIOD]: '100000\n' }), 16);
  });
});

describe('what it never does', () => {
  it('never reports more than the host has', () => assert.equal(cpus({ [V2]: '800000 100000\n' }, 4), 4));
  it('never reports fewer than 1, even from a host count of 0', () => assert.equal(cpus({}, 0), 1));
  it('no cgroup files at all is the host count', () => assert.equal(cpus({}), 16));

  it('garbage in any file is the host count, not an exception and not NaN', () => {
    for (const files of [
      { [V2]: 'nonsense' },
      { [V2]: '100000' },
      { [V2]: '100000 0' },
      { [V2]: '-5 100000' },
      { [V2]: '' },
      { [V1_QUOTA]: 'abc', [V1_PERIOD]: '100000' },
      { [V1_QUOTA]: '100000' },
      { [V1_QUOTA]: '100000', [V1_PERIOD]: '0' },
    ]) {
      assert.equal(cpus(files), 16, `for ${JSON.stringify(files)}`);
    }
  });

  it('a reader that throws something other than ENOENT is the host count too', () => {
    const value = availableCpus({ readFile: () => { throw new TypeError('boom'); }, availableParallelism: () => 6 });
    assert.equal(value, 6);
  });

  it('a host count that is not a positive integer is floored and kept at 1 or more', () => {
    assert.equal(cpus({}, 3.7), 3);
    assert.equal(cpus({}, Number.NaN), 1);
  });

  it('with nothing injected it answers for this machine: an integer between 1 and the host count', () => {
    const value = availableCpus();
    assert.ok(Number.isInteger(value) && value >= 1, `got ${value}`);
    assert.ok(value <= os.availableParallelism(), `got ${value} on ${os.availableParallelism()} cores`);
  });
});
