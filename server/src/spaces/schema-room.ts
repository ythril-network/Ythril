/**
 * Is there room for the schema a write would store: is its stored text within the one size bound, and does its growth fit in the storage
 * quota? (bundle-382, Q-981; owner's decision: a space holds as many types as its storage allows.)
 *
 * ## The one bound, and why it is this one
 *
 * A schema's stored text is kept whole as one row of the space's schema snapshots (`schema-snapshot-store.ts`), one MongoDB document of at most
 * {@link MAX_BSON_OBJECT_SIZE} bytes, and a peer fetches that text over HTTP and refuses one past {@link SCHEMA_SNAPSHOT_MAX_BYTES}. The peer's
 * limit is the smaller (10 MiB against 16 MiB, with the row's own fields in the rest of the difference), so it binds first and is the only bound
 * asked here: a schema between the two would be stored and could never sync, and one past both is refused by this test as well. The limit is
 * imported from the snapshot module, never copied, so a change to what peers take moves this bound with it.
 *
 * ## What it prevents
 *
 * - **A count that refuses what the store holds.** The fixed limit of 200 types per knowledge type refused ontologies and benchmark imports a
 *   space had room for. What can break is the schema's SIZE. A schema past the bound would be written to the config and then fail its snapshot
 *   write or its sync detached, with the caller told it was saved; it is refused here instead, with the limit named in bytes, before anything is
 *   written.
 * - **A schema that grows past the storage quota.** The snapshot rows are brain data (`dbStats` counts them in `measureUsage`), so a write
 *   that grows the schema asks the quota for the GROWTH (the new text less the stored one), as a fact write asks for its own bytes, and is
 *   refused `507` (`storageExceeded`) with the quota's sentence in figures a reader can compare ({@link quotaSentence}). Asking for the whole
 *   next schema refused a small addition to a large schema while the quota had room for it.
 * - **A space locked out of its own settings.** A write that does not grow the schema is never refused: it returns before the size test, so a
 *   space whose stored schema is already over the bound (it grew past it before, or the bound was lowered) still takes a settings change and a
 *   shrink, and at the storage limit an owner can still remove types to make room.
 *
 * Every door that writes a type schema asks {@link schemaRoomRefusal} before it writes anything: the settings write (`writeSpaceMeta`: the
 * space PATCH, `schema_update`, the schema-from-RDF write), the schema-from-RDF dry run and the data import's schema option (through
 * `judgeSchemaProposal`), space create (`planSpaceCreate`), `PUT /api/spaces/:id/schema` (before the backup of the schema it replaces), the
 * single-type `PUT` and a library group apply. A networked write is asked when it is proposed only; nothing asks again when its round lands.
 */
import type { SpaceMeta } from '../config/types.js';
import { MAX_BSON_OBJECT_SIZE } from '../db/one-command.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { schemaTextOf } from './schema-stamp.js';
import { SCHEMA_SNAPSHOT_MAX_BYTES } from './schema-snapshot.js';

/** The code of a schema past the size bound. */
export const SCHEMA_TOO_LARGE = 'schema_too_large';
/** The code of a schema write the storage quota refuses: the RDF import's and the bulk door's word for the same refusal. */
export const SCHEMA_STORAGE_EXCEEDED = 'storage_exceeded';
const TOO_LARGE = 413;
const INSUFFICIENT_STORAGE = 507;

export interface SchemaRoomRefusal {
  status: typeof TOO_LARGE | typeof INSUFFICIENT_STORAGE;
  body: { error: string; code: string; storageExceeded?: true };
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
/** The digits a size is first shown with, and the most a quota sentence adds to make the used figure read above the limit. */
const SHOWN_DIGITS = 2;
const MOST_DIGITS = 9;

// One snapshot row must hold the bound and what it holds beside the text: the bound that binds first is the peer's, never the document's.
if (SCHEMA_SNAPSHOT_MAX_BYTES >= MAX_BSON_OBJECT_SIZE) throw new Error('SCHEMA_SNAPSHOT_MAX_BYTES is no longer below one stored document: a schema inside it would not fit its snapshot row');

/**
 * The quota's refusal in figures that compare: MiB under 1 GiB of limit, GiB above, with digits added until the used figure reads above the
 * limit's (`toFixed(2)` of 0.004 GiB said "0.00 GiB used of 0 GiB allowed", and 1.004 against 1 said "1.00 used of 1 allowed").
 */
export function quotaSentence(area: string, usedGiB: number, limitGiB: number): string {
  const [unit, size] = limitGiB < 1 ? ['MiB', MiB / GiB] as const : ['GiB', 1] as const;
  const used = usedGiB / size;
  const limit = limitGiB / size;
  let digits = SHOWN_DIGITS;
  while (digits < MOST_DIGITS &&Number(used.toFixed(digits)) <= Number(limit.toFixed(digits))) digits += 1;
  return `Storage ${area} hard limit exceeded: ${used.toFixed(digits)} ${unit} used of ${Number(limit.toFixed(digits))} ${unit} allowed`;
}

/**
 * The refusal of a write that would store `next` as the schema of a space now holding `current`, or null when there is room. Asked before
 * anything is written; the quota is measured exactly (no reused measurement), as a person's single write is.
 */
export async function schemaRoomRefusal(current: SpaceMeta | undefined, next: SpaceMeta): Promise<SchemaRoomRefusal | null> {
  const nextText = schemaTextOf(next);
  const nextBytes = Buffer.byteLength(nextText, 'utf8');
  const growth = nextBytes - Buffer.byteLength(schemaTextOf(current), 'utf8');
  // First: a write that does not grow the schema is never asked, whatever the stored size (the bound is for what a write adds).
  if (growth <= 0) return null;
  if (nextBytes > SCHEMA_SNAPSHOT_MAX_BYTES) {
    return { status: TOO_LARGE, body: { code: SCHEMA_TOO_LARGE, error:
      `The schema would take ${nextBytes} bytes (${(nextBytes / MiB).toFixed(SHOWN_DIGITS)} MiB), more than the ${SCHEMA_SNAPSHOT_MAX_BYTES} bytes (${SCHEMA_SNAPSHOT_MAX_BYTES / MiB} MiB) `
      + 'a schema may take: peers refuse to fetch a larger one, so it could never sync. Nothing was written; remove or shorten types to fit.' } };
  }
  try {
    await checkQuota('brain', growth);
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
    return { status: INSUFFICIENT_STORAGE, body: { error: quotaSentence(err.area, err.usedGiB, err.limitGiB), code: SCHEMA_STORAGE_EXCEEDED, storageExceeded: true } };
  }
  return null;
}
