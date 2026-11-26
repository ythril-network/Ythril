/**
 * The dictionary of a space's triple index: one dense integer id per RDF term, and the key a term is found by (bundle-273, Q-764 S1).
 *
 * ## The question it answers
 *
 * "Which id does this term have in this space's index, and what is its key?" The index stores every statement as three ids (`store.ts`), so
 * a term must have exactly one key and one id: a second spelling of a key would give one term two ids, and the index would hold a statement
 * twice under names that never meet in a join.
 *
 * ## The key
 *
 * An IRI is `I<iri>`; a literal is `L` + JSON `[value, datatype or '', language or '']`; an RDF 1.2 triple term (the object of `rdf:reifies`)
 * is `T` + JSON of its three keys. A blank node or a list has no key: the record form (`record-triples.ts`) writes neither, so one reaching
 * here is a form this index was not built for, and it throws instead of storing something no query can find.
 *
 * ## The stored row
 *
 * `<space>_rdf_terms` holds `{ _id: <id>, k: <key> }`, unique on `k`. A key longer than {@link TERM_KEY_INLINE_MAX} characters (a fact's
 * text) is stored as `k: 'H' + sha256(key)` with the key itself in `v`, so the unique index holds a bounded value. Ids are taken from the
 * counter row `_id: -1` (`top`, the last id handed out) inside the caller's transaction, so an aborted batch hands its ids out again. The
 * dictionary never frees an id: a term no statement uses any more keeps its row (a rebuild, slice S4, starts a fresh dictionary).
 */
import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { Term } from '../literals.js';
import { col, asFilter, asUpdate, asDoc } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { inChunks } from '../../util/chunks.js';
import { inOneCommandChunks, operationBytes } from '../../db/one-command.js';

/** The longest key a dictionary row holds as it is; a longer one is stored by its hash. */
export const TERM_KEY_INLINE_MAX = 512;
/** The `_id` of the counter row. */
const COUNTER_ID = -1;
/** The highest id a statement id can carry: each of its three ids is a big-endian uint32. */
export const MAX_TERM_ID = 0xffff_ffff;
/** The most keys one `$in` read or one insert sends. */
const KEYS_PER_COMMAND = 1_000;

/** One dictionary row. */
export interface TermRow { _id: number; k: string; v?: string }
interface CounterRow { _id: number; top: number }

/** The key of `t`; throws for a term the record form never writes (a blank node, a list). */
export function termKey(t: Term): string {
  switch (t.kind) {
    case 'iri': return `I${t.value}`;
    case 'literal': return `L${JSON.stringify([t.value, t.datatype ?? '', t.language ?? ''])}`;
    case 'triple': return `T${JSON.stringify([termKey(t.subject), termKey(t.predicate), termKey(t.object)])}`;
    default: throw new Error(`the triple index has no key for a ${t.kind} term: the record form changed without the index`);
  }
}

/** The value a key is stored and looked up by in `k`: the key itself, or `H` + its SHA-256 when it is longer than the inline limit. */
export function storedKeyOf(key: string): string {
  return key.length <= TERM_KEY_INLINE_MAX ? key : `H${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/**
 * The id of every key in `keys` in `spaceId`'s dictionary, giving the missing ones the next ids, all inside `session`. Every key comes back
 * with an id, or the call throws (the dictionary is full past {@link MAX_TERM_ID}).
 */
export async function termIds(spaceId: string, keys: Iterable<string>, session: ClientSession): Promise<Map<string, number>> {
  const byStored = new Map<string, string>();
  for (const key of keys) byStored.set(storedKeyOf(key), key);
  const coll = col<TermRow>(spaceCollection(spaceId, 'rdfTerms'));
  const ids = new Map<string, number>();
  for (const chunk of inChunks([...byStored.keys()], KEYS_PER_COMMAND)) {
    const rows = await coll.find(asFilter<TermRow>({ k: { $in: chunk } }), { session, projection: { _id: 1, k: 1 } }).toArray();
    for (const row of rows) ids.set(byStored.get(row.k)!, row._id);
  }
  const missing = [...byStored.values()].filter(key => !ids.has(key));
  if (missing.length === 0) return ids;
  const counter = await col<CounterRow>(spaceCollection(spaceId, 'rdfTerms')).findOneAndUpdate(
    asFilter<CounterRow>({ _id: COUNTER_ID }), asUpdate<CounterRow>({ $inc: { top: missing.length } }),
    { upsert: true, returnDocument: 'after', session },
  );
  const top = counter?.top;
  if (typeof top !== 'number' || top > MAX_TERM_ID) {
    throw new Error(`the triple index of space '${spaceId}' has no term id left (the dictionary reached ${String(top)}): it needs a rebuild`);
  }
  let next = top - missing.length + 1;
  const rows: TermRow[] = missing.map((key) => {
    const id = next++;
    ids.set(key, id);
    const stored = storedKeyOf(key);
    return stored === key ? { _id: id, k: key } : { _id: id, k: stored, v: key };
  });
  for (const chunk of inOneCommandChunks(rows, { maxItems: KEYS_PER_COMMAND, bytesOf: operationBytes })) await coll.insertMany(chunk.map(r => asDoc<TermRow>(r)), { session, ordered: true });
  return ids;
}
