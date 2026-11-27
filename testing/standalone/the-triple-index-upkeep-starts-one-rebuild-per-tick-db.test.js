/**
 * One tick of the triple index upkeep starts at most one rebuild, and starts none while one runs, so an upgrade that leaves every RDF
 * space `missing` is rebuilt over several ticks and the drift verify is never starved (bundle-273, Q-764, review finding F5).
 *
 * ## The rule
 *
 * The measured value is the count of rebuilds one upkeep tick starts: at most 1. The tick walks every space with one unit at a time
 * (`eachSpace`, limit 1) and the unit awaited its whole rebuild, so on an upgrade (every index without a build id is `missing`) the first
 * tick rebuilt every RDF space before it looked at the verify of any. The tick now starts a rebuild without waiting for it, the walk goes
 * on, and a space that needs one while this tick has started one, or one still runs in this process, waits for a later tick.
 *
 * ## Seen red
 *
 * On 42c51f330 (with the tick exported for the spec): after the first tick all three spaces have a build id.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-upkeep-starts-one-rebuild-per-tick-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../_shared/wait-for.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { assertIndexEqualsRecords, rebuildModule, verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const SPACES = ['tixt-a', 'tixt-b', 'tixt-c'];
let d;
const built = async (space) => typeof (await d.col(`${space}_rdf_state`).findOne({ _id: 'state' }))?.buildId === 'string';
const builtCount = async () => (await Promise.all(SPACES.map(built))).filter(Boolean).length;

/** Wait until no rebuild of any of the spaces runs (in this process or by a build row). */
async function idle() {
  const { tripleIndexStatusOf } = await rebuildModule();
  await waitFor(async () => (await Promise.all(SPACES.map(s => tripleIndexStatusOf(s)))).every(v => !v.rebuilding), 30_000, 50, undefined,
    { what: 'every rebuild the tick started to end' });
}

describe('the triple index upkeep starts one rebuild per tick', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixt-tick', spaces: SPACES.map(id => ({ id, meta: rdfMeta(id) })) });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces(SPACES.map(id => ({ id })));
    for (const space of SPACES) {
      await landAll(d, space, Array.from({ length: 12 }, (_, i) => ['entities', entityDoc(space, `p${i}`, `Person ${i}`, 'person')]));
      // No index and nobody built one: the state an upgrade leaves, `missing` for the upkeep (the follower starts none).
    }
  });
  after(async () => { await d?.close(); });

  it('each tick starts at most one rebuild, and the spaces are all rebuilt over the ticks', async () => {
    const { upkeepTripleIndexes } = await verifyModule();
    assert.equal(typeof upkeepTripleIndexes, 'function', 'verify.ts exports the upkeep tick');
    assert.equal(await builtCount(), 0, 'no space has a build id: each is `missing`');
    const counts = [];
    for (let tick = 1; tick <= 4; tick++) {
      await upkeepTripleIndexes();
      await idle();
      counts.push(await builtCount());
    }
    assert.deepEqual(counts, [1, 2, 3, 3], 'one more space is built by each tick, until none is missing');
    for (const space of SPACES) {
      await followUntilReady(d, space);
      await assertIndexEqualsRecords(assert, d, space);
    }
  });
});
