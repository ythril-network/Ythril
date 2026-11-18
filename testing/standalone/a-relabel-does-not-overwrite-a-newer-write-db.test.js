/**
 * An edge relabel made at a read version does not overwrite a write that landed after that read (bundle-284 slice 5b, found by slice 2;
 * design r5 section 5.3 step 4).
 *
 * ## What it prevents
 *
 * A label change is an identity change: the edge moves onto the id `(from, to, label)` derives, by a delete of the old row and an insert of the
 * new one (`rekeyEdge`). `updateEdgeById` checked `If-Match` (`ifMatchSeq`) against ITS OWN READ, before the move, and the move's delete removed
 * the old id whatever version it held then. So a write that landed between the read and the re-key was deleted with the row, and the edge was
 * re-inserted from the stale read: the newer write lost with a 200, on every relabel with a precondition, the conversion run's among them (it
 * relabels with `ifMatchSeq` = the version it read, and must count a moved record as `moved`, never overwrite it).
 *
 * ## What holds
 *
 * - a relabel with `ifMatchSeq`, during which another write lands on the edge, answers as moved (`null`): nothing is deleted or inserted, and
 *   the newer write is still there under its old label and id;
 * - `rekeyEdge` asked to move at the version it was handed, after the stored row moved past it, moves nothing and answers `null`.
 *
 * Run: node --test testing/standalone/a-relabel-does-not-overwrite-a-newer-write-db.test.js (test stack up, after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openConvertDoor } from './_schema-convert.mjs';

const skip = await mongoSkipReason();
const S = 'relabel';

describe('a relabel does not overwrite a newer write (real MongoDB)', { skip }, () => {
  let door, edges, rekey, edgeIdFor;
  before(async () => {
    door = await openConvertDoor({ name: 'b284relabel', spaces: [S] });
    edges = await import('../../server/dist/brain/edges.js');
    rekey = await import('../../server/dist/brain/edge-rekey.js');
    ({ edgeIdFor } = await import('../../server/dist/brain/edge-id.js'));
    await door.seed(S, 'entities', ['a', 'b', 'c', 'd'].map(id => ({ _id: id, name: id.toUpperCase(), type: 'person', properties: {} })));
  });
  after(async () => { await door?.close(); });

  const row = (id) => door.coll(S, 'edges').findOne({ _id: id });

  it('a relabel with ifMatchSeq, during which another write lands, answers moved and the newer write is still there under its old label', async () => {
    const id = edgeIdFor('a', 'b', 'knows');
    const [seeded] = await door.seed(S, 'edges', [{ _id: id, from: 'a', to: 'b', label: 'knows' }]);
    let newer;
    // Called once the edge is read and judged, before the move is written: the other writer lands here.
    const onValidation = () => {
      newer ??= door.coll(S, 'edges').updateOne({ _id: id }, { $set: { description: 'the newer write' }, $inc: { seq: 1 } });
    };
    const answer = await edges.updateEdgeById(S, id, { label: 'likes' }, undefined, undefined, undefined, seeded.seq, onValidation);
    await newer;
    assert.equal(answer, null, `the relabel overwrote a write that landed after its read: ${JSON.stringify(answer)}`);
    const kept = await row(id);
    assert.ok(kept, 'the edge was deleted under its old id');
    assert.equal(kept.label, 'knows');
    assert.equal(kept.description, 'the newer write', 'the newer write was lost');
    assert.equal(await row(edgeIdFor('a', 'b', 'likes')), null, 'the stale read was inserted under the new id');
  });

  it('rekeyEdge asked to move at the version it was handed moves nothing once the stored row moved past it', async () => {
    const id = edgeIdFor('c', 'd', 'knows');
    const [stale] = await door.seed(S, 'edges', [{ _id: id, from: 'c', to: 'd', label: 'knows' }]);
    await door.coll(S, 'edges').updateOne({ _id: id }, { $set: { description: 'the newer write' }, $inc: { seq: 1 } });
    const moved = await rekey.rekeyEdge(S, stale, { label: 'likes' }, {}, [], undefined, undefined, { atReadVersion: true });
    assert.equal(moved, null, 'a re-key at a version the row no longer holds moved it');
    const kept = await row(id);
    assert.ok(kept, 'the edge was deleted under its old id');
    assert.equal(kept.description, 'the newer write');
    assert.equal(await row(edgeIdFor('c', 'd', 'likes')), null, 'the stale read was inserted under the new id');
  });
});
