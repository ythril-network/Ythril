/**
 * The follower of a triple index does no index work for a space whose index no rebuild has built, so a write in it answers as it does with RDF
 * off; the rebuild's swap is what hands the space to the follower (bundle-273, Q-764, pre-ship lens finding P2; design-r2 R1; contract row 1).
 *
 * ## The rule
 *
 * After the 6.5 to 6.6 upgrade every RDF space has no index, and the upkeep builds each one with a rebuild. The follower used to start an index
 * of its own at the first positioned write and apply up to 8 x 500 records inside that write before it answered, and again at every later
 * write until it was caught up. That index is never read (the read side asks for a build id, review finding G1) and the rebuild replaces it,
 * so the work was thrown away while every write of the space was slow. The follower now returns at once for a space whose index has no state
 * row, or one with no build id: it takes no lease, creates no collection and applies nothing. The rebuild's swap writes the state, and from
 * then on the follower applies what lands above the rebuild's cap.
 *
 * ## The cases
 *
 * 1. A space with RDF on and records landed through the stream, no rebuild: a follower run leaves the space with no `rdf_*` collection at all
 *    (no state row, no lease row, no dictionary), though the records stand.
 * 2. After a rebuild, records landed through the stream reach the index (the state is `ready` with the rebuild's build id, and the index
 *    states every stored record): the follower took over.
 *
 * ## Seen red
 *
 * On a075fa803: case 1 fails at its first check, the space has index collections after the follower ran (`tixf-late_rdf_state` and the lease, the
 * dictionary and the quads of the records it applied).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-follower-leaves-an-index-no-rebuild-built-alone-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { assertIndexEqualsRecords, rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixf-late';
let d;

/** The names of the collections of S's index (every collection the follower or a rebuild makes for it). */
async function indexCollections() {
  const { getDb } = await import('../../server/dist/db/mongo.js');
  return (await getDb().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => n.startsWith(`${S}_rdf_`)).sort();
}

describe('the follower leaves an index no rebuild built alone', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixf-late', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
  });
  after(async () => { await d?.close(); });

  it('a space with no built index has no index collection after its records landed and its follower ran', async () => {
    assert.deepEqual(await indexCollections(), [], 'the space starts with no index collection');
    await landAll(d, S, Array.from({ length: 30 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
    const { followTripleIndexNow } = await import('../../server/dist/rdf/triple-index/follow.js');
    await followTripleIndexNow(S);
    assert.deepEqual(await indexCollections(), [], 'neither the landing nor a follower run started an index');
  });

  it('after a rebuild the follower applies the records that land above it', async () => {
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await landAll(d, S, Array.from({ length: 5 }, (_, i) => ['entities', entityDoc(S, `late${i}`, `Late ${i}`, 'person')]));
    await followUntilReady(d, S);
    await assertIndexEqualsRecords(assert, d, S);
  });
});
