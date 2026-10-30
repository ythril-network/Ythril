/**
 * The metadata a file row LOST at an equal seq, kept as a conflict of this instance's own (Q-426).
 *
 * ## What it prevents
 *
 * Two instances holding one file's row at one version with different authored content (a different description, other tags) each skipped the other's
 * copy, and the space hash differed for ever. The tie every family follows (`arrivingWinsTie`, over `fileContentHash`) makes one of the two the row on
 * both. The other is the loser, and a loser that is simply overwritten is a description somebody wrote and nobody decided to lose: it is kept here,
 * in Conflicts, on the instance whose row it was (y-flows convention `convention-ythril-my-instance-is-my-data`: the peer never decides what this instance holds, and this
 * instance's user decides what becomes of its own copy).
 *
 * ## Why it is written BEFORE the row is replaced, and deleted when the replace does not happen
 *
 * A state in which the displaced metadata is stored nowhere must not exist, so the record is first. A replace the guard then refuses (the stored row
 * moved on) leaves the stored row standing, and a conflict naming metadata that was never displaced would be noise: the ones THIS call wrote are taken
 * back (`dropMetadataConflicts`). One that was already there (a re-delivery, an earlier landed swap) is never touched.
 *
 * The id derives from the file, the version and the hash of what lost, so the same loss delivered twice is one record (`$setOnInsert`).
 */
import { col, asBulk, asFilter } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { inChunks, ROWS_PER_BULK_COMMAND } from '../util/chunks.js';
import { spaceCollection } from '../db/space-collection.js';
import { derivedV4Id } from '../util/derived-id.js';
import { fileContentHash, FILE_HASH_PROJECTION } from '../brain/merkle.js';
import type { LosingFileMetadata, MetadataConflictDoc } from '../config/types.js';

/**
 * The fields of a metadata conflict a user can SEE and `keep-local` can APPLY: the ones the Conflicts page's table compares (its `METADATA_FIELDS`, which a test
 * holds equal to this list). The row's `author` and its two stamps are kept in the record, and are not something a user chooses between.
 */
export const SHOWN_METADATA_KEYS = ['description', 'descriptionSource', 'tags', 'properties', 'suppressEmbeddings'] as const;

/** The fields of a file row that are its authored half, as a conflict holds them: read from the row, never listed here a second time beyond the type. */
const LOSING_KEYS = [...SHOWN_METADATA_KEYS, 'author', 'createdAt', 'updatedAt'] as const;

/**
 * Whether a displaced row said anything a user could see differently from the row that displaces it. Two copies that differ only in a stamp or the author (a
 * `createdAt` the two instances took independently) are one description to a reader: the row is still swapped, because the hash needs the same copy on both,
 * and no conflict is recorded, because its table would be empty and "Keep mine" would change nothing a user can see (the review of bundle-45, #2).
 */
export function differsInWhatIsShown(displaced: Readonly<Record<string, unknown>>, by: Readonly<Record<string, unknown>>): boolean {
  // The hash's own projection with everything not shown blanked: the same canonical form the tie compares, so equal here means equal to a reader.
  const hidden = Object.keys(FILE_HASH_PROJECTION).filter(k => !(SHOWN_METADATA_KEYS as readonly string[]).includes(k));
  return fileContentHash(displaced as Record<string, unknown>, hidden) !== fileContentHash(by as Record<string, unknown>, hidden);
}

/** What the displaced row said: its authored half, with only the keys it had. */
export function losingMetadataOf(row: Readonly<Record<string, unknown>>): LosingFileMetadata {
  const out: Record<string, unknown> = {};
  for (const k of LOSING_KEYS) if (row[k] !== undefined) out[k] = row[k];
  return out as LosingFileMetadata;
}

/** The id of the conflict for what `row` said at `seq`: one per file, version and content, whoever delivers the winner and however often. */
export function metadataConflictIdFor(spaceId: string, fileId: string, seq: number, row: Readonly<Record<string, unknown>>): string {
  return derivedV4Id('ythril.meta-conflict', spaceId, fileId, String(seq), fileContentHash(row as Record<string, unknown>));
}

/** One displaced row: the file it was the row of, the version, what it said, and the row that displaces it (`by`). */
export interface DisplacedMetadata {
  fileId: string;
  seq: number;
  row: Readonly<Record<string, unknown>>;
  by: Readonly<Record<string, unknown>>;
}

/**
 * Keep each displaced row as a metadata conflict, except one that said nothing a user could see differently from the row that displaces it
 * ({@link differsInWhatIsShown}: it is swapped all the same, but there is nothing to decide). Returns the ids of the records THIS call wrote, so a replace
 * that does not happen can take back exactly those. Throws when the store cannot take them: the replace is then not made (the caller does not reach it).
 */
export async function recordMetadataConflicts(
  spaceId: string, displaced: readonly DisplacedMetadata[], peer: { instanceId: string; label: string },
): Promise<string[]> {
  const worth = displaced.filter(d => differsInWhatIsShown(d.row, d.by));
  if (worth.length === 0) return [];
  const at = new Date().toISOString();
  const docs = worth.map((d): MetadataConflictDoc => ({
    _id: metadataConflictIdFor(spaceId, d.fileId, d.seq, d.row),
    spaceId, kind: 'metadata', originalPath: d.fileId, losing: losingMetadataOf(d.row), seq: d.seq,
    peerInstanceId: peer.instanceId, peerInstanceLabel: peer.label, detectedAt: at,
  }));
  const written: string[] = [];
  // 1000 rows at a time: the rows of one accepted page, each a bounded description, tags and properties beside an id (`a-bounded-bulk-write-is-one-command`).
  for (const chunk of inChunks(docs, ROWS_PER_BULK_COMMAND)) {
    const r = await col<MetadataConflictDoc>(spaceCollection(spaceId, 'conflicts')).bulkWrite(asBulk<MetadataConflictDoc>(chunk.map(({ _id, ...rest }) => ({
      updateOne: { filter: { _id }, update: { $setOnInsert: rest }, upsert: true },
    }))), { ordered: false });
    written.push(...Object.keys(r.upsertedIds ?? {}).map(i => chunk[Number(i)]!._id));
  }
  return written;
}

/**
 * How a conflict names the peer that delivered the copy which won: the label of the network member with that instance id, the same on every door (a pull
 * knows the member it read from and a push only the id its token proves, so the door's own words would differ), or `fallback` when no member has it.
 */
export function peerLabelFor(instanceId: string | undefined, fallback: string): string {
  if (instanceId) {
    for (const network of getConfig().networks) {
      const member = network.members.find(m => m.instanceId === instanceId && typeof m.label === 'string' && m.label !== '');
      if (member) return member.label;
    }
  }
  return fallback;
}

/** Take back the conflicts a call wrote for a replace that was not made. */
export async function dropMetadataConflicts(spaceId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await col<MetadataConflictDoc>(spaceCollection(spaceId, 'conflicts')).deleteMany(asFilter<MetadataConflictDoc>({ _id: { $in: [...ids] } }));
}
