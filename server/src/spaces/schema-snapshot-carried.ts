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
 *   list's counts and the filter's `older` predicate ask it.
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
import { col, asFilter } from '../db/mongo.js';
import { distinctStringsOf } from '../db/distinct-strings.js';
import { indexNamesOf } from '../db/index-names.js';
import { spaceCollection } from '../db/space-collection.js';
import { COLLECTION_SUFFIX, KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { SchemaIndexBuilding } from '../util/errors.js';
import { isSchemaFingerprint, SCHEMA_FINGERPRINT_FIELD } from './schema-stamp.js';

/** The record collections that carry a stamp: every brain collection but `files` (no type, so no schema) and `links` (a link row has no schema). */
export const STAMPED_COLLECTIONS = KNOWLEDGE_TYPES.map(t => COLLECTION_SUFFIX[t]);

/** One of {@link STAMPED_COLLECTIONS}. */
export type StampedCollection = (typeof STAMPED_COLLECTIONS)[number];

/** The field a stamped collection's records name their type in: an edge's type is its `label`, every other record's is `type`. */
export const stampTypeFieldOf = (collection: StampedCollection): 'type' | 'label' => (collection === COLLECTION_SUFFIX.edge ? 'label' : 'type');

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
  const names = await indexNamesOf(spaceCollection(spaceId, collection));
  if (names.includes(STAMP_INDEX)) return STAMP_INDEX;
  if (names.includes(REPLACED_STAMP_INDEX)) return REPLACED_STAMP_INDEX;
  throw new SchemaIndexBuilding(spaceId);
}

/**
 * The fingerprints a stored record of `collection` in `spaceId` carries, each once; with `among`, only those of `among` (none asked: none read).
 * Throws on any failure of the read, a missing stamp index among them; never answers partially.
 */
export async function fingerprintsCarriedIn(spaceId: string, collection: StampedCollection, among?: readonly string[]): Promise<string[]> {
  if (among !== undefined && among.length === 0) return [];
  const hint = await stampIndexHint(spaceId, collection);
  const filter = { [SCHEMA_FINGERPRINT_FIELD]: { ...STAMP_READ, ...(among !== undefined ? { $in: [...among] } : {}) } };
  const found = await distinctStringsOf(col<Record<string, unknown>>(spaceCollection(spaceId, collection)), SCHEMA_FINGERPRINT_FIELD,
    asFilter<Record<string, unknown>>(filter), { hint });
  return found.filter(fp => isSchemaFingerprint(fp));
}

/** One (stamp, type) pair the stored records of a collection carry: `type` is `null` for an untyped record. */
export interface FingerprintType {
  readonly fp: string;
  readonly type: string | null;
  readonly count: number;
}

/** The figure a list's group runs under when its caller states none. */
export const FINGERPRINT_TYPES_DEFAULT_MS = 10_000;

/**
 * Every (stamp, type) pair the stored records of `collection` in `spaceId` carry, with how many records carry each: one `$group` answered
 * from the stamp index's keys ("reads every stamped key of the collection once, no records"), under `maxTimeMS` always. Only fingerprint-shaped
 * stamps and string-or-absent types are answered. Throws on any failure of the read, a missing stamp index among them.
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
    if (t !== undefined && t !== null && typeof t !== 'string') continue;
    out.push({ fp, type: typeof t === 'string' ? t : null, count: g.n });
  }
  return out;
}
