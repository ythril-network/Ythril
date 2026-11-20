/**
 * A source space for the RDF import's round-trip specs (bundle-270, fix round 4, findings R1 to R3): its schema, the records written through
 * the ordinary REST doors (so every record is one a door wrote, with its link rows), and the readers the specs compare with.
 *
 * ## What it holds
 *
 * Every kind pair the store links: a fact to entities (`fact.entityIds`), a chrono entry to entities and to facts (`chrono.entityIds`,
 * `chrono.factIds`), as `LINK_CLASSES` states them (`brain/link-adjacency.ts`; files are never imported). The literal counts the fixture
 * writes are in {@link EXPECTED}: every comparison is guarded by them, so an equality over two empty lists fails.
 *
 * A record of each sort a round trip must not rewrite for a difference the file never stated: a tag list whose stored order is not the sorted
 * one (`Zed`), a number stored as an integer (`age: 36`) that the export writes as a decimal, and, in a `warn` space, a property whose value
 * does not fit its declared type, which the export leaves out (`Nan`).
 */
import { rdfMeta, baseOf } from './_rdf-import-doors.mjs';

export { baseOf };

export const SCHEMA = {
  entity: {
    Person: { propertySchemas: { age: { type: 'number' }, nick: { type: 'string' } } },
    Org: { propertySchemas: { size: { type: 'number' } } },
  },
  fact: { note: { propertySchemas: { weight: { type: 'number' } } } },
  edge: { knows: {}, about: {} },
};

/** A space's meta: RDF on, its base `baseOf(id)`, the fixture's schema, embeddings on unless `suppressEmbeddings` is given. */
export const sourceMeta = (id, extra = {}) => rdfMeta(id, { validationMode: 'strict', typeSchemas: SCHEMA, suppressEmbeddings: false, ...extra });

/** The value of `age` the `weird` entity holds: a text where a number is declared, which the export leaves out. */
export const NOT_A_NUMBER = 'unknown-age-xyzzy';

/** The records the fixture writes, as literal counts; `weird` adds the entity whose property the export leaves out. */
export const expected = (weird = false) => ({ entity: weird ? 5 : 4, fact: 2, chrono: 2, edge: 2, link: 6 });

/** The link rows by kind pair, as literal counts: the pairs the store links. */
export const PAIRS = Object.freeze([
  { from: 'fact', to: 'entity', n: 3 },
  { from: 'chrono', to: 'entity', n: 2 },
  { from: 'chrono', to: 'fact', n: 1 },
]);

const COLLECTION = { entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges', link: 'links' };
export const COLLECTIONS = COLLECTION;

/** Write the fixture into `space` through the REST doors; answers the ids by name. */
export async function writeSource(d, key, space, { weird = false } = {}) {
  const post = async (rest, body) => {
    const r = await d.rest(key, 'POST', `/api/brain/spaces/${space}${rest}`, body);
    if (!(r.status < 300 && r.body?._id)) throw new Error(`${rest}: ${r.status} ${r.text?.slice(0, 400)}`);
    return r.body._id;
  };
  const ids = {};
  ids.ada = await post('/entities', { name: 'Ada Lovelace', type: 'Person', tags: ['pioneer', 'math'], description: 'First programmer', properties: { age: 36, nick: 'Enchantress' } });
  ids.charles = await post('/entities', { name: 'Charles Babbage', type: 'Person', properties: { age: 79 } });
  ids.engines = await post('/entities', { name: 'Analytical Engines Ltd', type: 'Org', tags: ['org'], properties: { size: 12 } });
  ids.zed = await post('/entities', { name: 'Zed Zeta', type: 'Person', tags: ['zeta', 'alpha'] });
  if (weird) ids.nan = await post('/entities', { name: 'Nan Unknown', type: 'Person', properties: { age: NOT_A_NUMBER } });
  ids.f1 = await post('/facts', { fact: 'Ledger entry "A"\nsecond line', type: 'note', tags: ['ledger'], properties: { weight: 0.5 }, linkEntities: [ids.ada, ids.charles] });
  ids.f2 = await post('/facts', { fact: 'Second fact', type: 'note', linkEntities: [ids.engines] });
  ids.c1 = await post('/chrono', {
    title: 'Lecture', type: 'event', startsAt: '2026-06-01T09:00:00Z', endsAt: '2026-06-01T10:30:00Z', status: 'active', confidence: 0.8,
    tags: ['talk'], description: 'A lecture', recurrence: { freq: 'weekly', interval: 2, until: '2027-06-01T00:00:00Z' },
    linkEntities: [ids.ada], linkFacts: [ids.f1],
  });
  ids.c2 = await post('/chrono', { title: 'Launch', type: 'milestone', startsAt: '2026-09-15T00:00:00Z', status: 'upcoming', linkEntities: [ids.engines] });
  await post('/edges', { from: ids.ada, to: ids.charles, label: 'knows', weight: 0.7, type: 'friend', description: 'met in 1833', tags: ['social'] });
  await post('/edges', { from: ids.c1, fromKind: 'chrono', to: ids.f2, toKind: 'fact', label: 'about', tags: ['t'] });
  return ids;
}

/** Every record of `space` by kind, read straight from its collections. */
export async function snapshotOf(d, space) {
  const out = {};
  for (const [kind, collection] of Object.entries(COLLECTION)) out[kind] = await d.records(space, collection);
  return out;
}

/** The text a record is known by. */
const labelOf = (kind, doc) => (kind === 'entity' ? doc.name : kind === 'fact' ? doc.fact : doc.title);

/** `kind:id` to `kind:label`. */
export function labelsOf(snap) {
  const m = new Map();
  for (const kind of ['entity', 'fact', 'chrono']) for (const doc of snap[kind]) m.set(`${kind}:${doc._id}`, `${kind}:${labelOf(kind, doc)}`);
  return m;
}

/** The link rows of one kind pair as `from => to` labels, sorted. */
export function linkLabels(snap, from, to) {
  const m = labelsOf(snap);
  return snap.link.filter(l => l.fromKind === from && l.toKind === to).map(l => `${m.get(`${l.fromKind}:${l.from}`)} => ${m.get(`${l.toKind}:${l.to}`)}`).sort();
}

/** The export of `space` in `format`, asserted whole. */
export async function exportText(d, key, space, format, params = {}) {
  const r = await d.exportRest(key, space, { format, ...params });
  if (r.status !== 200) throw new Error(`export ${format} of ${space}: ${r.status} ${r.text.slice(0, 300)}`);
  return r.text;
}
