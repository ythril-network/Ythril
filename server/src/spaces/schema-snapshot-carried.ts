/**
 * Which schema fingerprints the stored records of a space carry: THE one reader of that question (bundle-266, design r2 D4).
 *
 * ## The question it answers
 *
 * "Which fingerprints does a stored record of this collection carry (among these)?" The owed-snapshot gap scan asks it of every stamp, the fetch
 * asks which of the fingerprints it is about to fetch are still carried, and the snapshot sweep asks which of its candidates are. Before this module
 * the question was written by hand twice, with two filters; each caller now keeps only its own failure policy (the gap scan and the fetch are
 * additive, so a partial answer is safe there; the sweep removes, so it reads all four collections or none).
 *
 * ## What it prevents
 *
 * - A read that scans the collection. The filter holds the stamp index's own partial filter (`$exists: true`) verbatim, beside the `$in` of the
 *   among form, and the read HINTS `schemaFingerprint_present`: a collection whose index is gone fails the read instead of scanning every record
 *   of it every housekeeping cycle, and a caller that fails closed (the sweep) leaves the space untouched.
 * - A partial answer. It reads through `distinctStringsOf`, which throws on any failure and never answers part of the values.
 *
 * A fork row is a stored record like any other and is read: it carries the stamp of the copy it holds.
 */
import { col, asFilter } from '../db/mongo.js';
import { distinctStringsOf } from '../db/distinct-strings.js';
import { spaceCollection } from '../db/space-collection.js';
import { COLLECTION_SUFFIX, KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { isSchemaFingerprint, SCHEMA_FINGERPRINT_FIELD } from './schema-stamp.js';

/** The record collections that carry a stamp: every brain collection but `files` (no type, so no schema) and `links` (a link row has no schema). */
export const STAMPED_COLLECTIONS = KNOWLEDGE_TYPES.map(t => COLLECTION_SUFFIX[t]);

/** One of {@link STAMPED_COLLECTIONS}. */
export type StampedCollection = (typeof STAMPED_COLLECTIONS)[number];

/** The stamp's partial index, which every read here is hinted to: `spaces/space-indexes.ts` builds it under this name, read here, never copied. */
export const STAMP_INDEX = `${SCHEMA_FINGERPRINT_FIELD}_present`;

/** The stamp index's partial filter: the index holds only stamped records, and every read here holds this condition verbatim so the hint can serve it. */
export const STAMP_PRESENT = { $exists: true } as const;

/**
 * The fingerprints a stored record of `collection` in `spaceId` carries, each once; with `among`, only those of `among` (none asked: none read).
 * Throws on any failure of the read, a missing stamp index among them; never answers partially.
 */
export async function fingerprintsCarriedIn(spaceId: string, collection: StampedCollection, among?: readonly string[]): Promise<string[]> {
  if (among !== undefined && among.length === 0) return [];
  const filter = { [SCHEMA_FINGERPRINT_FIELD]: { ...STAMP_PRESENT, ...(among !== undefined ? { $in: [...among] } : {}) } };
  const found = await distinctStringsOf(col<Record<string, unknown>>(spaceCollection(spaceId, collection)), SCHEMA_FINGERPRINT_FIELD,
    asFilter<Record<string, unknown>>(filter), { hint: STAMP_INDEX });
  return found.filter(fp => isSchemaFingerprint(fp));
}
