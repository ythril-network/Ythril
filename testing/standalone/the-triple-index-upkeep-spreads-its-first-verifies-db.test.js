/**
 * The first upkeep tick of a process does not run the drift verify of every RDF space at once (bundle-273, Q-764, pre-ship lens finding, minor).
 *
 * ## The rule
 *
 * The upkeep remembers when it verified each space last, in memory. A fresh process remembered nothing, so every space was due at the first
 * tick and the tick ran about six hundred counts for each of them in one go, on a server that was just starting. A space the tick has not seen
 * yet now starts with a verify time a random part of the verify interval ago, so its first verify falls somewhere within the next interval,
 * and never in the first tick.
 *
 * ## The case
 *
 * Four spaces with RDF on, each rebuilt and caught up (so each is verifiable), and the first tick of the process: no space has a verify row
 * (`rdf_state` `{ _id: 'verify' }`, written by each verify run) after it.
 *
 * ## Seen red
 *
 * On a075fa803: all four spaces have a verify row after the first tick.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-upkeep-spreads-its-first-verifies-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule, verifyModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const SPACES = ['tixv-a', 'tixv-b', 'tixv-c', 'tixv-d'];
let d;

describe('the upkeep spreads the first verifies of a process', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixv-first', spaces: SPACES.map(id => ({ id, meta: rdfMeta(id) })) });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces(SPACES.map(id => ({ id })));
    for (const space of SPACES) {
      await landAll(d, space, Array.from({ length: 10 }, (_, i) => ['entities', entityDoc(space, `p${i}`, `Person ${i}`, 'person')]));
      assert.equal((await (await rebuildModule()).rebuildTripleIndex(space)).outcome, 'built');
      await followUntilReady(d, space);
    }
  });
  after(async () => { await d?.close(); });

  it('the first tick verifies none of the spaces', async () => {
    for (const space of SPACES) assert.equal(await d.col(`${space}_rdf_state`).countDocuments({ _id: 'verify' }), 0, `${space} has not been verified yet`);
    await (await verifyModule()).upkeepTripleIndexes();
    const verified = [];
    for (const space of SPACES) if (await d.col(`${space}_rdf_state`).countDocuments({ _id: 'verify' }) > 0) verified.push(space);
    assert.deepEqual(verified, [], 'no space was verified by the first tick');
  });
});
