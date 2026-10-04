/**
 * Seed a merge whose ABSORBED entity is a hub: `n` edges, links and face labels that a `graph_merge` must relink.
 *
 * ## Why a module
 *
 * The merge bound (`MERGE_MAX_RELINKS`, `Q-107` part 3a) is a count of what a merge relinks, and two places need
 * a hub sized against it: the door test that sends a merge at the bound and one over it
 * (`a-refused-merge-answers-alike-on-every-door-db.test.js`), and the measurement that sets the bound
 * (`testing/bench/merge-hub-in-one-transaction.mjs`). A copy in each would drift on the one thing both depend on —
 * WHAT counts as a relink — and a fixture that counts differently from the code sits on the wrong side of the
 * bound while reading as exactly at it.
 *
 * ## What it seeds, and the count it returns
 *
 * Two entities, and for the absorbed one: `edges` edges to distinct other ends (authored HERE, so the merge
 * re-keys them rather than leaving them in place), `links` link rows from facts, and `faces` face chunks labelled
 * with it. `relinks` is their sum — the plan's definition: absorbed edges + links + files. With `vectors`, every
 * edge carries a full-size embedding, because a re-key carries the vector across and a merge measured without
 * them prices a transaction a real hub never has.
 *
 * Inserted directly, in batches: the merge is under test, not the write path that would have created the hub.
 */
import { randomUUID } from 'node:crypto';

const T0 = '2026-09-01T00:00:00.000Z';

/** A deterministic unit-ish vector, so two seeds of one dimension compare equal and a carried copy can be checked. */
export function vectorOf(dims, salt = 1) {
  return Array.from({ length: dims }, (_, i) => Math.sin((i + 1) * salt));
}

/**
 * @param {object} o
 * @param {(name: string) => import('mongodb').Collection} o.coll  `(part) => collection` for the space
 * @param {string} o.space
 * @param {{ instanceId: string, instanceLabel: string }} o.author  THIS instance, so edges are re-keyed
 * @param {number} [o.edges] @param {number} [o.links] @param {number} [o.faces]
 * @param {number} [o.vectorDims]  give every edge an embedding of this size (0: none)
 * @param {number[]} [o.entityVector]  an embedding for both entities (the duplicate scanner compares these)
 * @param {number} [o.seqFrom]  first seq handed out; entities take the first two
 * @param {{ survivor: string, absorbed: string }} [o.names]  the two entities' names (both 'Hub' unless given), so a
 *   case can tell which one a refusal names
 * @returns the ids, the names, the targets each relinked record names, `relinks`, and the highest seq used
 */
export async function seedHub({ coll, space, author, edges = 0, links = 0, faces = 0, vectorDims = 0, entityVector, seqFrom = 1,
  names = { survivor: 'Hub', absorbed: 'Hub' } }) {
  let seq = seqFrom;
  const survivorId = randomUUID();
  const absorbedId = randomUUID();
  const entity = (_id, name) => ({
    _id, spaceId: space, name, type: 'thing', tags: [], properties: {}, author,
    createdAt: T0, updatedAt: T0, seq: seq++,
    ...(entityVector ? { embedding: entityVector, embeddingModel: 'seeded' } : {}),
  });
  // The survivor is the OLDER record (lower seq), which is who the duplicate routes pick under the default policy.
  await coll('entities').insertMany([entity(survivorId, names.survivor), entity(absorbedId, names.absorbed)]);

  const edgeTargets = [];
  const vector = vectorDims > 0 ? vectorOf(vectorDims, 0.37) : null;
  for (let i = 0; i < edges; i += 2_000) {
    const batch = [];
    for (let j = i; j < Math.min(edges, i + 2_000); j++) {
      const to = randomUUID();
      edgeTargets.push(to);
      batch.push({
        _id: randomUUID(), spaceId: space, from: absorbedId, to, label: 'rel', tags: [], author,
        createdAt: T0, updatedAt: T0, seq: seq++,
        ...(vector ? { embedding: vector, embeddingModel: 'seeded' } : {}),
      });
    }
    await coll('edges').insertMany(batch, { ordered: false });
  }

  const linkSources = [];
  if (links > 0) {
    const { linkIdFor } = await import('../../server/dist/brain/link-id.js');
    const rows = Array.from({ length: links }, () => {
      const from = randomUUID();
      linkSources.push(from);
      return { _id: linkIdFor(from, 'fact', absorbedId, 'entity'), spaceId: space, from, fromKind: 'fact',
        to: absorbedId, toKind: 'entity', author, createdAt: T0, updatedAt: T0, seq: seq++ };
    });
    await coll('links').insertMany(rows, { ordered: false });
  }

  const faceIds = [];
  if (faces > 0) {
    const rows = Array.from({ length: faces }, (_, i) => {
      const _id = `photos/hub-${absorbedId}.jpg#face${i}`;
      faceIds.push(_id);
      return { _id, spaceId: space, path: _id, parentFileId: `photos/hub-${absorbedId}.jpg`, faceEntityId: absorbedId,
        tags: [], author, createdAt: T0, updatedAt: T0, seq: seq++ };
    });
    await coll('files').insertMany(rows, { ordered: false });
  }

  return { survivorId, absorbedId, names, edgeTargets, linkSources, faceIds, relinks: edges + links + faces, maxSeq: seq - 1 };
}

/**
 * Did the merge land, in full: the absorbed entity gone, and every record that named it now naming the survivor —
 * checked by identity (the set of other ends, sources, face ids), never by a count that a wrong query also matches.
 * Returns a list of what is wrong; empty means relinked.
 */
export async function relinkProblems({ coll, hub }) {
  const out = [];
  const { survivorId, absorbedId } = hub;
  if (await coll('entities').findOne({ _id: absorbedId })) out.push('the absorbed entity is still stored');
  const stillAbsorbed = await coll('edges').countDocuments({ $or: [{ from: absorbedId }, { to: absorbedId }] })
    + await coll('links').countDocuments({ to: absorbedId }) + await coll('files').countDocuments({ faceEntityId: absorbedId });
  if (stillAbsorbed > 0) out.push(`${stillAbsorbed} record(s) still name the absorbed entity`);
  const ends = new Set((await coll('edges').find({ from: survivorId }, { projection: { to: 1 } }).toArray()).map(e => e.to));
  const lostEdges = hub.edgeTargets.filter(t => !ends.has(t));
  if (lostEdges.length > 0) out.push(`${lostEdges.length} edge(s) did not reach the survivor, e.g. to ${lostEdges[0]}`);
  const sources = new Set((await coll('links').find({ to: survivorId }, { projection: { from: 1 } }).toArray()).map(l => l.from));
  const lostLinks = hub.linkSources.filter(s => !sources.has(s));
  if (lostLinks.length > 0) out.push(`${lostLinks.length} link(s) did not reach the survivor`);
  const faces = new Set((await coll('files').find({ faceEntityId: survivorId }, { projection: { _id: 1 } }).toArray()).map(f => f._id));
  const lostFaces = hub.faceIds.filter(f => !faces.has(f));
  if (lostFaces.length > 0) out.push(`${lostFaces.length} face label(s) did not reach the survivor`);
  return out;
}
