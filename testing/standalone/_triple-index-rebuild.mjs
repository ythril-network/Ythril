/**
 * What the drift and rebuild specs of a space's triple index (bundle-273, Q-764 slice S4) are tested with: the whole index compared with
 * the records, record by record, and the index taken away as a restore or a new space leaves it.
 *
 * The record collections are named from `RDF_KIND_COLLECTIONS` (the walk's own list), so a kind the mapper adds is compared here too; each
 * record's statements are its export form (`_triple-index.mjs` `formStatements`, written from the rule, not imported from the index).
 */
import { assertIndexedAsStored } from './_triple-index.mjs';

/**
 * Assert `space`'s index is `ready`, carries a build id, and holds exactly every stored record's form: each record compared, and no record
 * row for a record that is not stored. Answers the state row.
 */
export async function assertIndexEqualsRecords(assert, d, space) {
  const state = await d.col(`${space}_rdf_state`).findOne({ _id: 'state' });
  assert.equal(state?.status, 'ready', `the index of ${space} is ready: ${JSON.stringify(state)}`);
  assert.equal(typeof state.buildId, 'string', `the index of ${space} names the build it came from: ${JSON.stringify(state)}`);
  const { RDF_KIND_COLLECTIONS } = await import('../../server/dist/rdf/rdf-members.js');
  const stored = new Set();
  for (const { kind, collection } of RDF_KIND_COLLECTIONS) {
    const docs = await d.col(d.spaceCollection(space, collection)).find({}, { projection: { _id: 1 } }).toArray();
    for (const { _id } of docs) {
      stored.add(`${kind}:${_id}`);
      await assertIndexedAsStored(assert, d, space, kind, collection, _id);
    }
  }
  const rows = await d.col(`${space}_rdf_records`).find({}, { projection: { _id: 1 } }).toArray();
  const strays = rows.map(r => r._id).filter(id => !stored.has(id));
  assert.deepEqual(strays, [], `every record row of ${space} names a stored record`);
  return state;
}

/** Drop every collection of `space`'s index, as a restore leaves it (absent means not built). */
export async function dropIndex(d, space) {
  const { getDb } = await import('../../server/dist/db/mongo.js');
  const names = (await getDb().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => n.startsWith(`${space}_rdf_`));
  for (const n of names) await getDb().collection(n).drop();
}

/** The collections of `space` a build writes before its swap (named by the build id): none may be left once a build ends. */
export async function buildCollections(d, space) {
  const { getDb } = await import('../../server/dist/db/mongo.js');
  return (await getDb().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => n.startsWith(`${space}_rdf_b`)).sort();
}

/** The rebuild module (`server/src/rdf/triple-index/rebuild.ts`) and the verify module (`verify.ts`). */
export const rebuildModule = () => import('../../server/dist/rdf/triple-index/rebuild.js');
export const verifyModule = () => import('../../server/dist/rdf/triple-index/verify.js');
