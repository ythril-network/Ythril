/**
 * The upkeep of the triple indexes retries a rebuild that keeps failing after longer and longer waits, and starts over when one succeeds
 * (bundle-273, Q-764, pre-ship lens finding R1).
 *
 * ## The rule
 *
 * The upkeep tick runs every minute and starts a rebuild for each space whose index needs one. A rebuild reads every record of its space; one
 * that fails every time (a record the form cannot state, a store that refuses the swap) was started again at every tick, for ever, a full scan
 * of a large space each minute. The tick now counts a space's rebuilds that failed in a row and waits `2^(failures - 1)` upkeep intervals
 * before it starts the next one, at most one hour. A rebuild that ends `built` clears the count. An outcome that is no failure of the space
 * (`busy`: another instance builds it, `stopped`, `no-form`, `form-changed`) never counts.
 *
 * ## The cases
 *
 * The tick runs with a clock the spec moves one interval at a time and a launcher that fails or succeeds as the case says (the `now` and
 * `launch` options of `upkeepTripleIndexes`), over one RDF space whose index is missing, and the spec reads the intervals between launches.
 *
 * 1. A launcher that always fails is called after 1, 2, 4, 8, 16 and 32 intervals, then every 60 minutes.
 * 2. After a launch that ended `built` the next failure waits one interval again, not the interval the count had reached.
 * 3. An outcome of `busy` is retried at the next tick, however often it repeats.
 *
 * ## Seen red
 *
 * On a075fa803: the first case fails at its first check: the tick has no `launch` option, so no launch of the spec's is counted (0 of 1); the
 * real rebuild runs every tick.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-upkeep-backs-off-a-failing-rebuild-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, entityDoc } from './_triple-index-read.mjs';
import { verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixb-back';
const MINUTE = 60_000;
let d, verify;
/** The spec's clock, in ms: it only moves forward, across the cases. */
let clock = 1_000_000_000_000;

/**
 * Tick every interval until `launches` launches were made, answering each as `outcomes(n)` says (`'fail'`, or a rebuild outcome); the
 * minutes since the previous launch of each launch, the first from the clock's start.
 */
async function gaps(launches, outcomes) {
  // The case starts clean: two hours on (past the longest wait), one launch that ends built clears whatever count the cases before left.
  clock += 120 * MINUTE;
  await verify.upkeepTripleIndexes({ now: () => clock, launch: async () => ({ run: { result: Promise.resolve({ outcome: 'built' }), claimed: Promise.resolve(true) }, joined: false }) });
  await new Promise(resolve => setTimeout(resolve, 5));
  clock += MINUTE;
  const at = [];
  const launch = async () => {
    at.push(clock);
    const out = outcomes(at.length);
    const result = out === 'fail' ? Promise.reject(new Error('the rebuild failed')) : Promise.resolve({ outcome: out });
    result.catch(() => undefined);
    return { run: { result, claimed: Promise.resolve(true) }, joined: false };
  };
  for (let guard = 0; at.length < launches && guard < 2_000; guard++) {
    await verify.upkeepTripleIndexes({ now: () => clock, launch });
    // The tick does not wait for the rebuild's end: let its outcome settle before the next one.
    await new Promise(resolve => setTimeout(resolve, 5));
    clock += MINUTE;
  }
  assert.equal(at.length, launches, 'the tick launched the rebuilds the case asks for');
  return at.map((t, i) => (i === 0 ? 0 : (t - at[i - 1]) / MINUTE));
}

describe('the upkeep backs off a rebuild that keeps failing', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixb-back', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    await landAll(d, S, Array.from({ length: 3 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    verify = await verifyModule();
    assert.equal(typeof verify.UPKEEP_INTERVAL_MS, 'number');
    assert.equal(verify.UPKEEP_INTERVAL_MS, MINUTE, 'the spec counts in the upkeep interval');
  });
  after(async () => { await d?.close(); });

  it('retries a failing rebuild after 1, 2, 4, 8, 16 and 32 intervals, then every hour', async () => {
    assert.deepEqual(await gaps(9, () => 'fail'), [0, 1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it('starts the count over after a rebuild that ended built', async () => {
    // Three failures, then a success (the index stays missing: the stub built nothing), then failures again.
    const seen = await gaps(8, n => (n === 4 ? 'built' : 'fail'));
    assert.deepEqual(seen, [0, 1, 2, 4, 1, 1, 2, 4], 'the success is retried at the next tick, and the waits after it start from one interval again');
  });

  it('retries a space another instance builds at every tick', async () => {
    assert.deepEqual(await gaps(5, () => 'busy'), [0, 1, 1, 1, 1]);
  });
});
