/**
 * Read a space's stored triple index (bundle-273, Q-764 slice S1) straight from its collections, and the statements a record's form says
 * it should hold, so a test compares the two without going through the code under test.
 *
 * ## The stored shape it reads (the contract S1 writes, `server/src/rdf/triple-index/store.ts`)
 *
 * - `<space>_rdf_terms`: `{ _id: <int>, k: <key> }`, or `{ _id, k: 'H' + sha256(key), v: <key> }` for a key longer than the inline limit; the
 *   counter document is `_id: -1`.
 * - `<space>_rdf_quads`: `{ _id: Binary(s,p,o as three big-endian uint32), s, p, o, nK, nF }`: how many knowledge (or link) records and how
 *   many file records state it.
 * - `<space>_rdf_records`: `{ _id: '<kind>:<id>', pos, q: Binary(the record's statement ids, 12 bytes each) }`.
 * - `<space>_rdf_state`: `{ _id: 'state', appliedPos, formKey, status }`.
 *
 * A term's key: an IRI is `I<iri>`, a literal `L` + JSON `[value, datatype or '', language or '']`, a triple term `T` + JSON of its three
 * keys. Written here from the rule, not imported, so a key the server spells differently fails the comparison instead of agreeing with itself.
 */

/** The key of one term of a record's form (`rdf/literals.ts` terms). */
export function termKey(t) {
  if (t.kind === 'iri') return `I${t.value}`;
  if (t.kind === 'literal') return `L${JSON.stringify([t.value, t.datatype ?? '', t.language ?? ''])}`;
  if (t.kind === 'triple') return `T${JSON.stringify([termKey(t.subject), termKey(t.predicate), termKey(t.object)])}`;
  throw new Error(`a record's form holds a ${t.kind} term, which the index has no key for`);
}

/** One statement as text: its three keys. */
const statementOf = (s, p, o) => JSON.stringify([s, p, o]);

/**
 * The statements of `doc` (a stored record of `kind`) in `space` as the index must hold them: the export's own mapper with the resolved
 * meta, RDF 1.2 edge details and no agent memory, each statement once, sorted.
 */
export async function formStatements(space, kind, doc) {
  const { getConfig } = await import('../../server/dist/config/loader.js');
  const { inlineResolvableRefs } = await import('../../server/dist/spaces/schema-validation.js');
  const { recordTriples } = await import('../../server/dist/rdf/record-triples.js');
  const meta = inlineResolvableRefs(getConfig().spaces.find(s => s.id === space).meta);
  const form = recordTriples(meta, kind, doc, { edgeDetails: 'rdf12' });
  return [...new Set(form.quads.map(q => statementOf(termKey(q.subject), termKey(q.predicate), termKey(q.object))))].sort();
}

/** The three term ids packed in a 12-byte statement id. */
function idsOf(buf, at) {
  return [buf.readUInt32BE(at), buf.readUInt32BE(at + 4), buf.readUInt32BE(at + 8)];
}

const bytesOf = (bin) => Buffer.from(bin.buffer ?? bin);

/** The key a term id stands for in `space`'s dictionary. */
async function keysOf(col, spaceCollection, space, ids) {
  const docs = await col(`${space}_rdf_terms`).find({ _id: { $in: [...new Set(ids)] } }).toArray();
  const byId = new Map(docs.map(d => [d._id, d.v ?? d.k]));
  return (id) => {
    const key = byId.get(id);
    if (key === undefined) throw new Error(`term id ${id} of space ${space} is in no dictionary row`);
    return key;
  };
}

/**
 * The statements the index holds for the record `kind:id` of `space`, sorted, or `null` when it has no record row. `d` carries `col` and
 * `spaceCollection` (the view doors do).
 */
export async function indexedStatements(d, space, kind, id) {
  const row = await d.col(`${space}_rdf_records`).findOne({ _id: `${kind}:${id}` });
  if (row === null) return null;
  const buf = bytesOf(row.q);
  const triples = [];
  for (let at = 0; at < buf.length; at += 12) triples.push(idsOf(buf, at));
  const key = await keysOf(d.col, d.spaceCollection, space, triples.flat());
  return triples.map(([s, p, o]) => statementOf(key(s), key(p), key(o))).sort();
}

/** The quad row of a statement (three keys as `statementOf` writes them) in `space`, or `null`. */
export async function quadRow(d, space, statement) {
  const [s, p, o] = JSON.parse(statement);
  const terms = await d.col(`${space}_rdf_terms`).find({ $or: [{ k: { $in: [s, p, o] } }, { v: { $in: [s, p, o] } }] }).toArray();
  const idOf = (k) => terms.find(t => (t.v ?? t.k) === k)?._id;
  const [si, pi, oi] = [idOf(s), idOf(p), idOf(o)];
  if (si === undefined || pi === undefined || oi === undefined) return null;
  return d.col(`${space}_rdf_quads`).findOne({ s: si, p: pi, o: oi });
}

/** Every quad row of `space`. */
export async function allQuadRows(d, space) {
  return d.col(`${space}_rdf_quads`).find({}).toArray();
}

/** The state document of `space`'s index, or `null`. */
export async function indexState(d, space) {
  return d.col(`${space}_rdf_state`).findOne({ _id: 'state' });
}

/** The names of `space`'s index collections that exist now. */
export async function indexCollections(d, space) {
  const { getDb } = await import('../../server/dist/db/mongo.js');
  const names = (await getDb().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
  return names.filter(n => n.startsWith(`${space}_rdf_`)).sort();
}

/**
 * Assert the index holds exactly the form of the stored record `kind:id` of `space` (read now), and say what differs. A record with no
 * statements has no record row.
 */
export async function assertIndexedAsStored(assert, d, space, kind, collection, id) {
  const stored = await d.col(d.spaceCollection(space, collection)).findOne({ _id: id });
  const want = stored === null ? [] : await formStatements(space, kind, stored);
  const have = await indexedStatements(d, space, kind, id);
  assert.deepEqual(have ?? [], want, `the index holds ${have === null ? 'no record row' : `${have.length} statement(s)`} for ${kind} ${id}, `
    + `its stored form has ${want.length}`);
}
