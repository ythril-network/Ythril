/**
 * What the per-space index declaration says, and what a space's collections really carry, in ONE comparable shape
 * (bundle-101, Q-445 design rev 5.1 items 1, 6 and 7).
 *
 * ## The question each answers
 *
 * - {@link loadSpaceIndexDeclaration} - *"what does `spaces/space-indexes.ts` declare"*: every entry as {@link IndexSpec} plus its
 *   failure `policy` and `bootSafe`. The design names the module and what an entry holds (keys, options, its collection kind, a
 *   failure policy, bootSafe) and leaves the spelling open; the spelling this suite reads is fixed HERE, once, so the implementation
 *   meets one place: `export const SPACE_INDEXES`, each `{ part, keys, options: { name?, unique?, sparse?, partialFilterExpression? },
 *   policy: 'throw' | 'report' | 'best-effort', bootSafe?: boolean }`, `part` being a `SpacePart` as `spaceCollection` takes it.
 * - {@link indexesOfSpace} - *"what indexes does this space's every collection carry right now"*, read from the store.
 * - {@link buildReferenceSpace} - *"every index any per-space builder puts on a space"*: `initSpace` on a space created now, the
 *   background pass (`ensureQueryIndexes`), and the TTL sweep's builder while one is exported apart from the pass
 *   (`brain/ttl.ts` `ensureTtlIndex` at df2e7534). The derivation a test leans on when the declaration is not there to read.
 *
 * ## What a hand-written copy drops
 *
 * **The comparison's fields.** A copy that compares keys alone passes a unique index rebuilt without `unique`, which is the index
 * that lets duplicates in. Every comparison here is name, key, unique, sparse and partialFilterExpression ({@link sameSpec}).
 *
 * **The default name and the text index's real key.** An entry with no `options.name` is named the way the store names it
 * (`<field>_<dir>` joined by `_`), and a text index is stored as `{ _fts: 'text', _ftsx: 1 }` with its fields in `weights`; both
 * are normalised here, or a declared `lexical_text` and the built one never compare equal.
 *
 * **A declaration that read as empty.** {@link loadSpaceIndexDeclaration} answers WHY it has nothing (the module is not built, the
 * export is missing or empty) instead of an empty list, so a loop over it cannot pass by covering nothing.
 */
import { isDeepStrictEqual } from 'node:util';

/** The store's own name for an index with no `name` option. */
export const defaultIndexName = (keys) => Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_');

/** The comparable shape of one index: what decides whether two of them are the same index. */
export function specOf({ name, key, unique, sparse, partialFilterExpression, weights }) {
  const textKey = key && key._fts === 'text'
    ? Object.fromEntries([...Object.entries(key).filter(([k]) => k !== '_fts' && k !== '_ftsx'), ...Object.keys(weights ?? {}).map(f => [f, 'text'])])
    : key;
  return { name, key: textKey, unique: unique === true, sparse: sparse === true, partialFilterExpression: partialFilterExpression ?? null };
}

/** Whether two specs are one index; when not, the fields that differ. */
export function specDifference(a, b) {
  const fields = ['name', 'key', 'unique', 'sparse', 'partialFilterExpression'];
  const keyOrder = (k) => (k && typeof k === 'object' ? Object.entries(k) : k);
  return fields.filter(f => !isDeepStrictEqual(f === 'key' ? keyOrder(a[f]) : a[f], f === 'key' ? keyOrder(b[f]) : b[f]));
}
export const sameSpec = (a, b) => specDifference(a, b).length === 0;

/** `<suffix>:<name>`, the identity of an index across spaces. */
export const indexId = (suffix, name) => `${suffix}:${name}`;

let spaceCollections;
async function suffixOfPart(part) {
  spaceCollections ??= (await import('../../server/dist/db/space-collection.js')).SPACE_COLLECTIONS;
  const suffix = spaceCollections[part];
  if (!suffix) throw new Error(`a declared index names the collection kind ${JSON.stringify(part)}, which SPACE_COLLECTIONS does not hold`);
  return suffix;
}

/**
 * The declaration, normalised: `{ entries }` with each entry `{ suffix, part, id, spec, policy, bootSafe, raw }`, or `{ missing }`
 * with the reason there is none. Never an empty `entries`: an empty export is a `missing`.
 */
export async function loadSpaceIndexDeclaration() {
  let mod;
  try { mod = await import('../../server/dist/spaces/space-indexes.js'); }
  catch (err) { return { missing: `spaces/space-indexes.ts, the one declaration of every per-space index, is not built (${String(err?.code ?? err?.message ?? err)})` }; }
  const declared = mod.SPACE_INDEXES;
  if (!Array.isArray(declared)) return { missing: 'spaces/space-indexes.ts exports no SPACE_INDEXES array' };
  if (declared.length === 0) return { missing: 'SPACE_INDEXES is empty: a loop over it builds nothing' };
  const entries = [];
  for (const raw of declared) {
    const suffix = await suffixOfPart(raw.part);
    const options = raw.options ?? {};
    const name = options.name ?? defaultIndexName(raw.keys);
    entries.push({
      suffix, part: raw.part, id: indexId(suffix, name), policy: raw.policy, bootSafe: raw.bootSafe, raw,
      spec: specOf({ name, key: raw.keys, unique: options.unique, sparse: options.sparse, partialFilterExpression: options.partialFilterExpression }),
    });
  }
  return { entries, module: mod };
}

/** The declaration, or a failed assertion naming why there is none (for a case whose rule is the declaration's). */
export async function requireSpaceIndexDeclaration(assert) {
  const d = await loadSpaceIndexDeclaration();
  assert.ok(!d.missing, d.missing);
  return d.entries;
}

/**
 * Every index of every collection of `spaceId`, `_id_` left out: a `Map` of `indexId` to `{ suffix, spec }`. Read with `db`
 * (the server's `getDb()` or a fixture client's).
 */
export async function indexesOfSpace(db, spaceId) {
  const out = new Map();
  for (const { name: coll } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (!coll.startsWith(`${spaceId}_`)) continue;
    const suffix = coll.slice(spaceId.length + 1);
    for (const ix of await db.collection(coll).indexes()) {
      if (ix.name === '_id_') continue;
      out.set(indexId(suffix, ix.name), { suffix, spec: specOf(ix) });
    }
  }
  return out;
}

/**
 * Run every per-space builder the server has on `spaceId`, which the caller has already created through `initSpace` (the door
 * does): the background pass, and the TTL sweep's own builder while it is exported apart from the pass. Answers what the space
 * then carries ({@link indexesOfSpace}).
 */
export async function buildReferenceSpace(db, spaceId) {
  const { ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js');
  await ensureQueryIndexes();
  const ttl = await import('../../server/dist/brain/ttl.js');
  if (typeof ttl.ensureTtlIndex === 'function') await ttl.ensureTtlIndex(spaceId);
  return indexesOfSpace(db, spaceId);
}

/** Drop every index of every collection of `spaceId` but `_id_`, so the next build starts from nothing. */
export async function dropSpaceIndexes(db, spaceId) {
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith(`${spaceId}_`)) await db.collection(name).dropIndexes();
  }
}
