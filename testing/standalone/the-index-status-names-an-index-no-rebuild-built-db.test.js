/**
 * The status of a space's triple index says `unbuilt` for an index no rebuild has built, on both doors (bundle-273, Q-764, drive finding S1;
 * contract row 6).
 *
 * ## The rule
 *
 * A query reads an index only when a rebuild built it (it has a build id, review finding G1). The status read (`space_rdf_index`, and its tool
 * door `POST /api/space_rdf_index`) answered `ready` with `buildId` null for an index a follower had started and no rebuild had built, while every
 * query still read the records: the status said the opposite of what the queries did. It now answers `unbuilt` there. `ready` is the status of
 * an index queries read, and only a built index is that.
 *
 * ## The case
 *
 * A space whose index state row says `ready` and names no build: both doors answer `status: 'unbuilt'` with `buildId: null`. After a rebuild
 * both answer `ready` with the build id.
 *
 * ## Seen red
 *
 * On a075fa803: both doors answer `ready` for the unbuilt index (`'ready' !== 'unbuilt'`).
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-index-status-names-an-index-no-rebuild-built-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { landAll, followUntilReady, entityDoc } from './_triple-index-read.mjs';
import { rebuildModule } from './_triple-index-rebuild.mjs';

const skip = await mongoSkipReason();
const S = 'tixs-status';
let d, admin;

/** The status of S on the MCP tool and on the tool door of REST. */
async function statuses() {
  const mcp = (await d.toolCall(admin.key, 'space_rdf_index', { space: S })).structured;
  const r = await fetch(`${d.server.url}/api/space_rdf_index`, {
    method: 'POST', headers: { Authorization: `Bearer ${admin.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ space: S }),
  });
  const text = await r.text();
  assert.equal(r.status, 200, text.slice(0, 300));
  const rest = JSON.parse(text);
  return { mcp, rest: rest.data ?? rest };
}

describe('the index status names an index no rebuild built', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({ suite: 'b273-tixs-status', spaces: [{ id: S, meta: rdfMeta(S) }] });
    await (await import('../../server/dist/brain/links-conversion.js')).convertAndMarkSpaces([{ id: S }]);
    admin = await d.mint('tixs-admin', {}, { admin: true });
    await landAll(d, S, Array.from({ length: 5 }, (_, i) => ['entities', entityDoc(S, `p${i}`, `Person ${i}`, 'person')]));
  });
  after(async () => { await d?.close(); });

  it('answers unbuilt on both doors for a state with no build, and ready once a rebuild built it', async () => {
    // The state a follower that started its own index left (an upgrade from a build that did): no build id, whatever the status.
    await d.col(`${S}_rdf_state`).replaceOne({ _id: 'state' }, { status: 'ready', appliedPos: 0, formKey: 'planted' }, { upsert: true });
    for (const [door, status] of Object.entries(await statuses())) {
      assert.equal(status.status, 'unbuilt', `the ${door} door says no rebuild built the index: ${JSON.stringify(status)}`);
      assert.equal(status.buildId, null, `the ${door} door names no build`);
    }
    assert.equal((await (await rebuildModule()).rebuildTripleIndex(S)).outcome, 'built');
    await followUntilReady(d, S);
    for (const [door, status] of Object.entries(await statuses())) {
      assert.equal(status.status, 'ready', `the ${door} door says the built index is ready: ${JSON.stringify(status)}`);
      assert.equal(typeof status.buildId, 'string', `the ${door} door names the build`);
    }
  });
});
