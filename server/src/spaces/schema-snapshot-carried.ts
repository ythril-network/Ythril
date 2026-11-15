/**
 * Which schema fingerprints the stored records of a space carry, and of which types: THE readers of those questions (bundle-266, design r2 D4;
 * bundle-267, design r3 §1 and final changes 1, 2, 6).
 *
 * ## The questions it answers
 *
 * - {@link fingerprintsCarriedIn}: "Which fingerprints does a stored record of this collection carry (among these)?" The owed-snapshot gap scan
 *   asks it of every stamp, the fetch asks which of the fingerprints it is about to fetch are still carried, and the snapshot sweep asks which of
 *   its candidates are. Each caller keeps only its own failure policy (the gap scan and the fetch are additive, so a partial answer is safe there;
 *   the sweep removes, so it reads all four collections or none).
 * - {@link fingerprintTypesIn}: "Which (stamp, type) pairs do the stored records of this collection carry, and how many of each?" The version
 *   list's counts ask it.
 * - The type history's seeks (bundle-268, Q-744 design r4 §1), none a walk of the records: {@link unnamedFingerprintsIn} (R2, which stamps carry
 *   a record whose type is no string), {@link typeOnAnyOf} (R3, does a record of T carry one of these stamps), {@link fingerprintsOfType} (R4,
 *   which stamps T carries) and {@link recordTypeNamesIn} (R5, which names the records carry), each planned by
 *   {@link stampIndexMayHoldArrays}, the one answer to whether the stamp index may hold an array type.
 *
 * ## What it prevents
 *
 * - **A read that fetches every stamped record.** Every read here matches {@link STAMP_READ} (`$type: 'string'`), never the index's partial
 *   filter {@link STAMP_PRESENT} (`$exists: true`): an `$exists` match cannot be answered from an index, so it FETCHes each record even hinted
 *   (probe 2, E1), while `$type: 'string'` is answered from the keys alone and implies the partial filter, so the partial index still serves it.
 *   `every-stamp-reader-asks-what-the-stamp-index-holds` holds the implication and that no other module names `STAMP_PRESENT`.
 * - **A read that scans the collection.** Each read HINTS the stamp index the collection lists ({@link stampIndexHint}): the (stamp, type)
 *   compound {@link STAMP_INDEX} when it stands, the single-key one it replaces while a collection has only that (the upgrade window: the index
 *   step builds the compound, confirms it, and only then drops the old one), and with neither it throws {@link SchemaIndexBuilding} (503
 *   `schema_index_building`): a caller that fails closed (the sweep) leaves the space untouched, and a door says what to wait for.
 * - **A partial answer.** It reads through `distinctStringsOf` or one aggregate read whole, which throw on any failure.
 *
 * A fork row is a stored record like any other and is read: it carries the stamp of the copy it holds.
 */
import { col, asFilter, getDb } from '../db/mongo.js';
import { distinctStringsOf } from '../db/distinct-strings.js';
import type { TimeLeft } from '../db/read-by-id.js';
import { stampedTypeValue } from './type-field-clause.js';
import { indexNamesOf } from '../db/index-names.js';
import { spaceCollection } from '../db/space-collection.js';
import { COLLECTION_SUFFIX, KNOWLEDGE_TYPES, type KnowledgeType } from '../config/types-knowledge.js';
import { TYPE_FIELD } from '../brain/ttl.js';
import { RECORD_TYPE_OF } from '../sync/replicated-families.js';
import { SchemaIndexBuilding } from '../util/errors.js';
import { isSchemaFingerprint, SCHEMA_FINGERPRINT_FIELD } from './schema-stamp.js';

/** The record collections that carry a stamp: every brain collection but `files` (no type, so no schema) and `links` (a link row has no schema). */
export const STAMPED_COLLECTIONS = KNOWLEDGE_TYPES.map(t => COLLECTION_SUFFIX[t]);

/** One of {@link STAMPED_COLLECTIONS}. */
export type StampedCollection = (typeof STAMPED_COLLECTIONS)[number];

/**
 * The kind whose records a stamped collection holds (`entities` → `entity`): `RECORD_TYPE_OF`, the one total table from a collection to its
 * record type, read here, never inverted again. Every stamped collection is a knowledge type's ({@link STAMPED_COLLECTIONS} is built from them).
 */
export const stampedKindOf = (collection: StampedCollection): KnowledgeType => RECORD_TYPE_OF[collection] as KnowledgeType;

/** The field a stamped collection's records name their type in: `TYPE_FIELD`'s (an edge's type is its `label`, every other record's is `type`). */
export const stampTypeFieldOf = (collection: StampedCollection): 'type' | 'label' => TYPE_FIELD[stampedKindOf(collection)];

/** The stamp index, `{ schemaFingerprint: 1, <type field>: 1 }`: `spaces/space-indexes.ts` builds it under this name, read here, never copied. */
export const STAMP_INDEX = `${SCHEMA_FINGERPRINT_FIELD}_type_present`;

/** The single-key stamp index the compound replaces (6.6.0): read through while a collection lists only it, dropped by the index step. */
export const REPLACED_STAMP_INDEX = `${SCHEMA_FINGERPRINT_FIELD}_present`;

/** The stamp index's partial filter: the index holds only stamped records. The index declaration's alone; every read matches {@link STAMP_READ}. */
export const STAMP_PRESENT = { $exists: true } as const;

/** What every reader of the stamp matches: a string stamp, which implies {@link STAMP_PRESENT} and is answered from the index keys alone. */
export const STAMP_READ = { $type: 'string' } as const;

/**
 * The stamp index to hint for a read of `collection` in `spaceId`: the compound when the collection lists it, else the single-key one it
 * replaces, else {@link SchemaIndexBuilding}. One listing per read: metadata, whatever the size of the collection.
 */
export async function stampIndexHint(spaceId: string, collection: StampedCollection): Promise<string> {
  return stampIndexIn(spaceId, await indexNamesOf(spaceCollection(spaceId, collection)));
}

/** {@link stampIndexHint} over a listing the caller already holds. */
function stampIndexIn(spaceId: string, names: readonly string[]): string {
  if (names.includes(STAMP_INDEX)) return STAMP_INDEX;
  if (names.includes(REPLACED_STAMP_INDEX)) return REPLACED_STAMP_INDEX;
  throw new SchemaIndexBuilding(spaceId);
}

/**
 * The fingerprints a stored record of `collection` in `spaceId` carries, each once; with `among`, only those of `among` (none asked: none read).
 * Throws on any failure of the read, a missing stamp index among them; never answers partially.
 */
export async function fingerprintsCarriedIn(
  spaceId: string, collection: StampedCollection, among?: readonly string[], opts: { timeLeft?: TimeLeft } & StampReadOptions = {},
): Promise<string[]> {
  if (among !== undefined && among.length === 0) return [];
  const hint = opts.plan?.hint ?? await stampIndexHint(spaceId, collection);
  const filter = { [SCHEMA_FINGERPRINT_FIELD]: { ...STAMP_READ, ...(among !== undefined ? { $in: [...among] } : {}) } };
  const maxTimeMS = opts.timeLeft?.();
  const found = await distinctStringsOf(col<Record<string, unknown>>(spaceCollection(spaceId, collection)), SCHEMA_FINGERPRINT_FIELD,
    asFilter<Record<string, unknown>>(filter), { hint, ...(maxTimeMS !== undefined ? { maxTimeMS } : {}) });
  return found.filter(fp => isSchemaFingerprint(fp));
}

// ── The type history's reads (bundle-268, Q-744 design r4 §1 and its amendment): index seeks, never a walk of the records ──────────────

/**
 * Every BSON type a type field can hold that is neither a string nor null nor an array, as `$type` aliases: as ONE `$type` list they bound the
 * stamp index tightly and the read stays covered (probe t8: 23 keys, 0 records, where an `$or` of the same clauses planned a FETCH once
 * `symbol` was in it). `symbol` is left out: a deprecated BSON type no door writes (a write and an arrival are JSON), whose index bounds are
 * the strings', so asking for it walks every key; `undefined` likewise (it cannot be bounded).
 */
const NON_STRING_SCALAR_TYPES = [
  'number', 'object', 'binData', 'objectId', 'bool', 'date', 'regex', 'dbPointer', 'javascript', 'javascriptWithScope',
  'timestamp', 'minKey', 'maxKey',
] as const;

/** The IXSCAN of `index` anywhere in an explain answer, whatever shape the server version gives it. */
function ixscanOf(node: unknown, index: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const n of node) { const hit = ixscanOf(n, index); if (hit) return hit; }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const o = node as Record<string, unknown>;
  if (o['stage'] === 'IXSCAN' && o['indexName'] === index) return o;
  for (const [k, v] of Object.entries(o)) {
    if (k === 'rejectedPlans' || k === 'command') continue;
    const hit = ixscanOf(v, index);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * May this collection's stamp index hold an array-valued type field? THE one answer R2, R4, R3 and the filter's `older` pick their plan by
 * (design r4 amend "one rule"): read from the index's own multikey flag, which the store sets the first time a stamped record with an array
 * type is written (and never clears), through one planner explain (no record read, no command on the collection). A collection read through
 * the single-key stamp index it replaces answers `true`: that index does not hold the type, so it cannot say. What it prevents: the plain,
 * covered type match used where a stamped `['T', 'X']` would match T by an element, and the guarded FETCH paid where no array can exist.
 */
export async function stampIndexMayHoldArrays(spaceId: string, collection: StampedCollection, hint?: string): Promise<boolean> {
  const index = hint ?? await stampIndexHint(spaceId, collection);
  if (index !== STAMP_INDEX) return true;
  const explained = await getDb().command({
    explain: { find: spaceCollection(spaceId, collection), filter: { [SCHEMA_FINGERPRINT_FIELD]: STAMP_READ }, hint: index, limit: 1 },
    verbosity: 'queryPlanner',
  });
  const scan = ixscanOf(explained, index);
  if (!scan) return true;
  const paths = scan['multiKeyPaths'] as Record<string, unknown[]> | undefined;
  const typeField = stampTypeFieldOf(collection);
  if (paths && typeof paths === 'object' && Array.isArray(paths[typeField])) return paths[typeField]!.length > 0;
  return scan['isMultiKey'] !== false;
}

/** What a pass's stamp reads share: the index to hint, whether it may hold an array type, and the listing both came from. */
export interface StampPlan {
  readonly hint: string;
  readonly mayHoldArrays: boolean;
  /** The collection's index names, as listed once for the plan: the type index of R5 is read from here, never listed again. */
  readonly indexNames: readonly string[];
}

/**
 * The plan of one pass over `collection`: ONE listing of its indexes and one planner explain. A pass makes it once and hands it to every read
 * ({@link StampReadOptions}), so the number of types it seeks never multiplies the listing. Throws {@link SchemaIndexBuilding} when the
 * collection lists no stamp index.
 */
export async function stampPlanOf(spaceId: string, collection: StampedCollection): Promise<StampPlan> {
  const indexNames = await indexNamesOf(spaceCollection(spaceId, collection));
  const hint = stampIndexIn(spaceId, indexNames);
  return { hint, indexNames, mayHoldArrays: await stampIndexMayHoldArrays(spaceId, collection, hint) };
}

/** What every R2 to R5 read takes besides its question: the pass's plan. A read handed none makes its own, so a lone read is never blind. */
export interface StampReadOptions { readonly plan?: StampPlan }

/**
 * R2: which of `among` does a record carry whose type is neither a string nor absent (`unnamed`: an array, a number, an object)? The same set
 * the shipped `unnamed` rule of {@link fingerprintTypesIn} answers, asked of `among` alone. On a stamp index that holds no array, one covered
 * read (the `$type` list, tight bounds: no record read); on one that may, the same list with `array` in it, which fetches (an array of
 * strings has no key of its own type). Throws on any failure; never answers partially.
 */
export async function unnamedFingerprintsIn(
  spaceId: string, collection: StampedCollection, among: readonly string[], timeLeft: TimeLeft, opts: StampReadOptions = {},
): Promise<string[]> {
  if (among.length === 0) return [];
  const { hint, mayHoldArrays: arrays } = opts.plan ?? await stampPlanOf(spaceId, collection);
  const typeField = stampTypeFieldOf(collection);
  const stamp = { [SCHEMA_FINGERPRINT_FIELD]: { ...STAMP_READ, $in: [...new Set(among)] } };
  const filter = { ...stamp, [typeField]: { $type: arrays ? [...NON_STRING_SCALAR_TYPES, 'array'] : [...NON_STRING_SCALAR_TYPES] } };
  const maxTimeMS = timeLeft();
  const rows = await col<Record<string, unknown>>(spaceCollection(spaceId, collection)).find(asFilter<Record<string, unknown>>(filter), {
    projection: { _id: 0, [SCHEMA_FINGERPRINT_FIELD]: 1 }, hint, ...(maxTimeMS !== undefined ? { maxTimeMS } : {}),
  }).toArray();
  return [...new Set(rows.map(r => r[SCHEMA_FINGERPRINT_FIELD]).filter((fp): fp is string => isSchemaFingerprint(fp)))];
}

/**
 * R3: does a record of `type` (the string, never an array holding it) carry any of `fps`? One point seek per stamp at most, stopping at the
 * first hit. Throws on any failure.
 */
export async function typeOnAnyOf(
  spaceId: string, collection: StampedCollection, type: string, fps: readonly string[], timeLeft: TimeLeft, opts: StampReadOptions = {},
): Promise<boolean> {
  if (fps.length === 0) return false;
  const { hint, mayHoldArrays: arrays } = opts.plan ?? await stampPlanOf(spaceId, collection);
  const filter = { [SCHEMA_FINGERPRINT_FIELD]: { ...STAMP_READ, $in: [...new Set(fps)] }, [stampTypeFieldOf(collection)]: stampedTypeValue(type, arrays) };
  const maxTimeMS = timeLeft();
  const hit = await col<Record<string, unknown>>(spaceCollection(spaceId, collection)).findOne(asFilter<Record<string, unknown>>(filter), {
    projection: { _id: 0, [SCHEMA_FINGERPRINT_FIELD]: 1 }, hint, ...(maxTimeMS !== undefined ? { maxTimeMS } : {}),
  });
  return hit !== null;
}

/**
 * R4: which stamps do the records of `type` carry, each once? On a stamp index that holds no array, one covered read (the type's keys of the
 * stamp index, grouped by stamp: `distinctStringsOf`, never the driver's one-reply distinct); on one that may, a loose scan of the guarded
 * match, one seek per stamp the type carries plus one, the deadline asked before each. Never a walk of the type's records. Throws on any failure.
 */
export async function fingerprintsOfType(
  spaceId: string, collection: StampedCollection, type: string, timeLeft: TimeLeft, opts: StampReadOptions = {},
): Promise<string[]> {
  const { hint, mayHoldArrays: arrays } = opts.plan ?? await stampPlanOf(spaceId, collection);
  const records = col<Record<string, unknown>>(spaceCollection(spaceId, collection));
  const typeField = stampTypeFieldOf(collection);
  if (!arrays) {
    const maxTimeMS = timeLeft();
    const found = await distinctStringsOf(records, SCHEMA_FINGERPRINT_FIELD,
      asFilter<Record<string, unknown>>({ [SCHEMA_FINGERPRINT_FIELD]: STAMP_READ, [typeField]: type }), { hint, ...(maxTimeMS !== undefined ? { maxTimeMS } : {}) });
    return found.filter(fp => isSchemaFingerprint(fp));
  }
  const out: string[] = [];
  let last = '';
  for (;;) {
    const maxTimeMS = timeLeft();
    // No `sort`: the hinted stamp index is read forward from `last`, so its first match IS the next stamp (a sort on the stamp would name the
    // field through a computed key the position-order gate cannot read).
    const next = await records.findOne(asFilter<Record<string, unknown>>({
      [SCHEMA_FINGERPRINT_FIELD]: { ...STAMP_READ, $gt: last }, [typeField]: stampedTypeValue(type, true),
    }), { projection: { _id: 0, [SCHEMA_FINGERPRINT_FIELD]: 1 }, hint, ...(maxTimeMS !== undefined ? { maxTimeMS } : {}) });
    const fp = next?.[SCHEMA_FINGERPRINT_FIELD];
    if (typeof fp !== 'string') return out;
    if (isSchemaFingerprint(fp)) out.push(fp);
    last = fp;
  }
}

/** The single-field type index a collection's record-only names are read through: `{ label: 1 }` on the edges, `{ type: 1 }` elsewhere. */
const typeIndexOf = (collection: StampedCollection): string => `${stampTypeFieldOf(collection)}_1`;

/**
 * R5: the string type names the records of `collection` carry, stamped or not, each once: one key per name (DISTINCT_SCAN) on the type index,
 * through `distinctStringsOf` with no filter. A caller lists a name only once a string-typed record carrying a version confirms it (R3). While
 * the edges' `{ label: 1 }` is still being built (it is the background pass's) the read runs unhinted under the deadline. Whether the type index
 * is listed is read from the pass's plan when it has one ({@link StampPlan}), so it lists nothing again. Throws on any failure.
 */
export async function recordTypeNamesIn(spaceId: string, collection: StampedCollection, timeLeft: TimeLeft, opts: StampReadOptions = {}): Promise<string[]> {
  const name = spaceCollection(spaceId, collection);
  const index = typeIndexOf(collection);
  const listed = (opts.plan?.indexNames ?? await indexNamesOf(name)).includes(index);
  const maxTimeMS = timeLeft();
  return distinctStringsOf(col<Record<string, unknown>>(name), stampTypeFieldOf(collection), {},
    { ...(listed ? { hint: index } : {}), ...(maxTimeMS !== undefined ? { maxTimeMS } : {}) });
}

/**
 * One (stamp, type) pair the stored records of a collection carry: `type` is `null` for an untyped record. `unnamed` marks records whose type
 * field holds something that is not a string (a peer's arrival keeps its writer's stamp unchecked): no type name can be read for them, so a
 * reader that classifies by type must answer them unclassified, never leave them out.
 */
export interface FingerprintType {
  readonly fp: string;
  readonly type: string | null;
  readonly count: number;
  readonly unnamed?: true;
}

/** The figure a list's group runs under when its caller states none. */
export const FINGERPRINT_TYPES_DEFAULT_MS = 10_000;

/**
 * Every (stamp, type) pair the stored records of `collection` in `spaceId` carry, with how many records carry each: one `$group` answered
 * from the stamp index's keys ("reads every stamped key of the collection once, no records"), under `maxTimeMS` always. Only fingerprint-shaped
 * stamps are answered; a type that is neither a string nor absent is answered `unnamed`, never dropped, so its stamp still reaches the
 * counts and the filter's unclassified records. Throws on any failure of the read, a missing stamp index among them.
 */
export async function fingerprintTypesIn(
  spaceId: string, collection: StampedCollection, opts: { maxTimeMS?: number } = {},
): Promise<FingerprintType[]> {
  const hint = await stampIndexHint(spaceId, collection);
  const typeField = stampTypeFieldOf(collection);
  const groups = await col<Record<string, unknown>>(spaceCollection(spaceId, collection)).aggregate<{ _id: { fp?: unknown; t?: unknown }; n: number }>([
    { $match: { [SCHEMA_FINGERPRINT_FIELD]: STAMP_READ } },
    { $group: { _id: { fp: `$${SCHEMA_FINGERPRINT_FIELD}`, t: `$${typeField}` }, n: { $sum: 1 } } },
  ], { hint, maxTimeMS: opts.maxTimeMS ?? FINGERPRINT_TYPES_DEFAULT_MS }).toArray();
  const out: FingerprintType[] = [];
  for (const g of groups) {
    const { fp, t } = g._id ?? {};
    if (!isSchemaFingerprint(fp)) continue;
    const unnamed = t !== undefined && t !== null && typeof t !== 'string';
    out.push({ fp, type: typeof t === 'string' ? t : null, count: g.n, ...(unnamed ? { unnamed: true as const } : {}) });
  }
  return out;
}
