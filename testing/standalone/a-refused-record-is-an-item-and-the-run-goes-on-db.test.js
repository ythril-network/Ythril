/**
 * A record the store or a guard refuses becomes an item by its class, and the run goes on (Q-746, bundle-284 design r5 section 5.3 step 5,
 * decision 4, finding B3).
 *
 * ## The rule
 *
 * An edge `renameType` moves each edge onto the identity its new label derives. When an edge with that identity already exists, the relabel is
 * refused (`EdgeIdentityTaken`): the run writes an item with reason `relationship_exists` for that edge, converts the next records of the page
 * and the pages after it, and completes. A per-record refusal never fails a page or the run.
 *
 * ## What was wrong
 *
 * r3 let any throw of the update function fail the page; three passes later the run was `failed` over one edge (B3).
 *
 * Seen red on 14af4644: the run module is not built.
 *
 * Run: node --test testing/standalone/a-refused-record-is-an-item-and-the-run-goes-on-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';
import { waitForValue } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const S = 'refused';
const RELABEL = { op: 'renameType', kind: 'edge', from: 'knows', to: 'likes' };

describe('a refused record is an item and the run goes on (real MongoDB)', { skip }, () => {
  let door, run, edgeIdFor;
  before(async () => {
    door = await openConvertDoor({ name: 'b284refused', spaces: [S] });
    run = await door.runModule();
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
  });
  after(async () => { run?.stopSchemaConvertWatcher(); await door?.close(); });

  it('an edge relabel onto an existing relationship is a relationship_exists item; the other edges convert and the run completes', async () => {
    await door.seed(S, 'entities', ['a', 'b', 'c'].map(id => ({ _id: id, name: id.toUpperCase(), type: 'person', properties: {} })));
    const edge = (from, to, label) => ({ _id: edgeIdFor(from, to, label), from, to, label });
    const blocked = edge('a', 'b', 'knows');
    await door.seed(S, 'edges', [blocked, edge('a', 'b', 'likes'), edge('a', 'c', 'knows'), edge('b', 'c', 'knows')]);

    const started = await run.startSchemaConvertRun({ spaceId: S, types: [{ kind: 'edge', type: 'knows' }], steps: [RELABEL], source: { kind: 'act' } });
    assert.equal(started.ok, true, JSON.stringify(started));
    const done = await waitForValue(async () => { const d = await door.runDoc(S); return d && d.state !== 'running' ? d : null; },
      20_000, 100, undefined, { what: 'the run to end' });

    assert.equal(done.state, 'complete', `one refused edge ended the run: ${JSON.stringify(done)}`);
    const items = await door.itemRows(S);
    assert.deepEqual(items.map(i => [i.recordId, i.reason]), [[blocked._id, 'relationship_exists']]);
    assert.ok(await door.coll(S, 'edges').findOne({ _id: blocked._id, label: 'knows' }), 'the refused edge is left as it was');
    for (const [from, to] of [['a', 'c'], ['b', 'c']]) {
      assert.ok(await door.coll(S, 'edges').findOne({ _id: edgeIdFor(from, to, 'likes'), label: 'likes' }), `${from}->${to} was not relabelled after the refusal`);
      assert.equal(await door.coll(S, 'edges').findOne({ _id: edgeIdFor(from, to, 'knows') }), null, `${from}->${to} stayed under its old identity`);
    }
    assert.equal(done.counts.rewritten, 2);
    assert.equal(done.counts.unconverted, 1);
  });
});
