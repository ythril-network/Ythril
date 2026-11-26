/**
 * What the read side of a space's triple index (bundle-273, Q-764 slice S3) is tested with: records landed in bulk through the records
 * stream, the follower run until the index is caught up, the index state bent into each case the barrier must refuse, and the store
 * commands of one query sorted into the reads of the records and the reads of the index.
 *
 * The record collections are named from `RDF_KIND_COLLECTIONS` (the walk's own list), so a kind the mapper adds is read here too; the
 * index collections from `SPACE_COLLECTIONS`, the parts `store.ts` writes.
 */

/** Every positioned write of `docs` (`[collection, doc]`) into `space`, in one held band, as every positioned writer lands them. */
export async function landAll(d, space, docs) {
  const stream = await import('../../server/dist/sync/record-position-stream.js');
  const byCollection = new Map();
  for (const [collection, doc] of docs) {
    if (!byCollection.has(collection)) byCollection.set(collection, []);
    byCollection.get(collection).push(doc);
  }
  for (const [collection, rows] of byCollection) {
    for (let at = 0; at < rows.length; at += 500) {
      const part = rows.slice(at, at + 500);
      await stream.withLandingStamp(space, part.map(() => stream.localRow(1)), async (patches) => {
        await d.col(d.spaceCollection(space, collection)).insertMany(part.map((doc, i) => ({ ...doc, ...patches[i] })));
      }, 'test.landing');
    }
  }
}

/** Run `space`'s follower until its index is `ready` with no journal row left, or throw after `tries` runs. */
export async function followUntilReady(d, space, tries = 40) {
  const { followTripleIndex } = await import('../../server/dist/rdf/triple-index/follow.js');
  const { settledPositionCap } = await import('../../server/dist/util/position-clock.js');
  const { recordPositions } = await import('../../server/dist/sync/record-position-stream.js');
  for (let i = 0; i < tries; i++) {
    await followTripleIndex(space, () => settledPositionCap(recordPositions, space));
    const state = await d.col(`${space}_rdf_state`).findOne({ _id: 'state' });
    const journal = await d.col(`${space}_rdf_dirty`).countDocuments({});
    if (state?.status === 'ready' && journal === 0) return state;
  }
  throw new Error(`the triple index of ${space} is not ready after ${tries} follower runs`);
}

/** The names of `space`'s record collections (the six kinds) and of its index collections. */
export async function collectionsOf(d, space) {
  const { RDF_KIND_COLLECTIONS } = await import('../../server/dist/rdf/rdf-members.js');
  return {
    records: RDF_KIND_COLLECTIONS.map(k => d.spaceCollection(space, k.collection)),
    quads: d.spaceCollection(space, 'rdfQuads'),
    terms: d.spaceCollection(space, 'rdfTerms'),
  };
}

/** The `find` and `getMore` commands of `commands` (as the push door logs them, `<name> <collection>`) on `collection`. */
export const readsOn = (commands, collection) => commands.filter(c => /^(find|getMore) /.test(c) && c.split(' ')[1] === collection);
/** The `find` commands of `commands` on `collection`. */
export const findsOn = (commands, collection) => commands.filter(c => c === `find ${collection}`);

/** Set fields of `space`'s index state row (`appliedPos`, `status`, `formKey`), answering the row as it was. */
export async function bendState(d, space, fields) {
  const was = await d.col(`${space}_rdf_state`).findOne({ _id: 'state' });
  await d.col(`${space}_rdf_state`).updateOne({ _id: 'state' }, { $set: fields });
  return was;
}

/** Hold `space`'s follower lease for another owner, so no follower of this process can apply anything. */
export async function holdLease(d, space) {
  await d.col(`${space}_rdf_state`).updateOne({ _id: 'lease' }, { $set: { owner: 'another-process', until: Date.now() + 3_600_000 } }, { upsert: true });
}

/** Give the lease back and put the state row back as it was. */
export async function restore(d, space, was) {
  await d.col(`${space}_rdf_state`).deleteOne({ _id: 'lease' });
  if (was) await d.col(`${space}_rdf_state`).replaceOne({ _id: 'state' }, was);
}

/** An entity's stored shape, for `landAll`. */
export function entityDoc(space, id, name, type, properties = {}, extra = {}) {
  const STAMP = '2026-03-04T05:06:07.000Z';
  return { _id: id, spaceId: space, seq: 1, name, type, properties, tags: [], createdAt: STAMP, updatedAt: STAMP, author: { instanceId: 'tix-author', instanceLabel: 'Tix' }, ...extra };
}

/** An edge's stored shape, for `landAll`. */
export function edgeDoc(space, id, from, to, label, extra = {}) {
  const STAMP = '2026-03-04T05:06:07.000Z';
  return { _id: id, spaceId: space, seq: 1, from, to, label, tags: [], createdAt: STAMP, updatedAt: STAMP, author: { instanceId: 'tix-author', instanceLabel: 'Tix' }, ...extra };
}
