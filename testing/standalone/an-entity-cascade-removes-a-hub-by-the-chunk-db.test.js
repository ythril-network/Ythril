/**
 * An entity cascade removes a HUB — more edges than one write chunk — whole, with one tombstone per edge, at a cost
 * that grows by the chunk and not by the edge (`Q-107` part 3b).
 *
 * ## Why a hub
 *
 * The cascade deletes the entity's blocking edges one at a time through `deleteEdge`: a read, a delete, an embed-job
 * retire, a counter allocation and a tombstone write PER EDGE — five commands an edge, so a 1 500-edge hub is about
 * 7 500 round trips while the caller waits. The plan removes the edges in chunks of 500, each chunk one transaction
 * (`deleteMany` + the batched `writeTombstones`), so the cost is a constant per chunk.
 *
 * ## The two rules
 *
 *  1. **Whole, and every deletion replicates — a PIN, green today.** After a cascade of a hub spanning three chunks,
 *     no edge of it remains, the entity is gone, and there is exactly one tombstone per removed edge — each under the
 *     edge's id, each with its own seq, each carrying `originalSeq` = the deleted edge's seq (the pull filters a
 *     tombstone out for a peer whose watermark never reached the record; without it that peer is sent deletions for
 *     records it never had). A chunk loop that stops after its first chunk, or a batched tombstone writer that
 *     forgets `originalSeq` — the half `tombstoneDoc` calls forgettable — fails here.
 *  2. **The cost grows by the chunk.** A hub of 1 499 edges costs exactly as many database commands as one of 1 001:
 *     both are three chunks of at most 500 (and two of at most 1 000, one of at most 1 500), so a writer that is
 *     batched by the chunk cannot make them differ, and one that goes edge by edge differs by about 2 500 commands.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-entity-cascade-removes-a-hub-by-the-chunk-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'cascadehub';
const AUTHOR = { instanceId: 'cascadehub-receiver', instanceLabel: 'Receiver' };
const T0 = '2026-09-01T00:00:00.000Z';

let door, cascade;
let seq = 0;
const coll = (n) => door.coll(S, n);

/** An entity with `n` edges, half from it and half to it, to distinct other ends. */
async function hubWith(n) {
  const hub = randomUUID();
  await coll('entities').insertOne({ _id: hub, spaceId: S, name: 'Hub', type: 'thing', tags: [], author: AUTHOR,
    createdAt: T0, updatedAt: T0, seq: ++seq });
  const edges = Array.from({ length: n }, (_, i) => {
    const other = randomUUID();
    return { _id: randomUUID(), spaceId: S, ...(i % 2 === 0 ? { from: hub, to: other } : { from: other, to: hub }),
      label: 'rel', tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq: ++seq };
  });
  for (let i = 0; i < edges.length; i += 1_000) await coll('edges').insertMany(edges.slice(i, i + 1_000), { ordered: false });
  // The counter past every seeded seq, so the cascade's own tombstones take seqs above them.
  await door.setCounter(S, seq);
  return { hub, edges };
}

async function runCascade(hub) {
  const p = await cascade.previewEntityCascade(S, hub);
  const r = await cascade.deleteEntityCascade(S, hub, p.token);
  assert.equal(r.ok, true, `the cascade was refused: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
}

describe('an entity cascade removes a hub by the chunk', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'cascadehub', monitorCommands: true,
      // `strictLinkage` on: only there do edges block, so only there does the cascade remove them.
      spaces: [{ id: S, label: 'Hub', folders: [], completeLinkage: true, meta: { strictLinkage: true } }],
    });
    cascade = await import('../../server/dist/brain/entity-delete-cascade.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('PIN — a hub of three chunks is removed whole, with one tombstone per edge carrying its originalSeq', { timeout: 300_000 }, async () => {
    const { hub, edges } = await hubWith(1_201);
    await runCascade(hub);
    assert.equal(await coll('entities').findOne({ _id: hub }), null, 'the hub entity is still stored');
    const left = await coll('edges').find({ $or: [{ from: hub }, { to: hub }] }, { projection: { _id: 1 } }).toArray();
    assert.deepEqual(left.map(e => e._id), [], `${left.length} of the hub's ${edges.length} edges survived the cascade`);

    const tombs = await coll('tombstones').find({ type: 'edge' }).toArray();
    const byId = new Map(tombs.map(t => [t._id, t]));
    const untombed = edges.filter(e => !byId.has(e._id));
    assert.deepEqual(untombed.map(e => e._id).slice(0, 5), [],
      `${untombed.length} removed edge(s) have no tombstone, so a peer still holding them brings them back`);
    assert.equal(tombs.length, edges.length, `${tombs.length} edge tombstones for ${edges.length} removed edges`);
    const wrongOriginal = edges.filter(e => byId.get(e._id).originalSeq !== e.seq);
    assert.deepEqual(wrongOriginal.map(e => `${e._id}: ${byId.get(e._id).originalSeq} for seq ${e.seq}`).slice(0, 5), [],
      `${wrongOriginal.length} tombstone(s) do not carry the deleted edge's seq as originalSeq`);
    const seqs = new Set(tombs.map(t => t.seq));
    assert.equal(seqs.size, tombs.length, 'two tombstones share a seq — a reader paging by seq skips one of them');
    assert.ok(tombs.every(t => t.seq > Math.max(...edges.map(e => e.seq))), 'a tombstone took a seq at or below a record it deletes');
  });

  it('a hub of 1 499 edges costs as many commands as one of 1 001', { timeout: 300_000 }, async () => {
    const cost = async (n) => {
      const { hub } = await hubWith(n);
      return door.commandsDuring(() => runCascade(hub));
    };
    const smaller = await cost(1_001);
    await door.wipe(S);
    const larger = await cost(1_499);
    assert.ok(smaller.length > 0, 'command monitoring recorded nothing, so the comparison would pass vacuously');
    assert.equal(larger.length, smaller.length,
      `a cascade of 1 001 edges cost ${smaller.length} commands and 1 499 cost ${larger.length} — the hub is removed one `
      + `edge at a time. First commands: ${larger.slice(0, 8).join('; ')}`);
  });
});
