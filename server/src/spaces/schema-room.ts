/**
 * Is there room for the schema a write would store: does its stored text fit in one stored document, and does its growth fit in the storage
 * quota? (bundle-382, Q-981; owner's decision: a space holds as many types as its storage allows.)
 *
 * ## What it prevents
 *
 * - **A count that refuses what the store holds.** The fixed limit of 200 types per knowledge type refused ontologies and benchmark imports a
 *   space had room for. What can break is the schema's SIZE: its text is stored whole as one row of the space's schema snapshots
 *   (`schema-snapshot-store.ts`), one MongoDB document, which holds at most {@link MAX_BSON_OBJECT_SIZE} bytes. A schema past that would be
 *   written to the config and then fail its snapshot write detached, with the caller told it was saved; it is refused here instead, with
 *   {@link SCHEMA_DOCUMENT_MAX_BYTES} named, before anything is written.
 * - **A schema that grows past the storage quota.** The snapshot rows are brain data (`dbStats` counts them in `measureUsage`), so a write
 *   that grows the schema asks the quota as a fact write does and is refused with the quota's own `QuotaError` sentence (`507`,
 *   `storageExceeded`). A write that does not grow the schema is not asked: at the limit an owner can still remove types to make room.
 *
 * Every door that writes a type schema asks {@link schemaRoomRefusal} before it writes anything: the settings write (`writeSpaceMeta`: the
 * space PATCH, `schema_update`, the schema-from-RDF door), `PUT /api/spaces/:id/schema` (before the backup of the schema it replaces), the
 * single-type `PUT` and a library group apply.
 */
import type { SpaceMeta } from '../config/types.js';
import { MAX_BSON_OBJECT_SIZE } from '../db/one-command.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { schemaTextOf } from './schema-stamp.js';

/** Room in a snapshot row for what it holds beside the text: its fingerprint, origin, links and dates. */
const ROW_HEADROOM_BYTES = 64 * 1024;
/** The largest stored schema text, in UTF-8 bytes: one snapshot row is one MongoDB document. */
export const SCHEMA_DOCUMENT_MAX_BYTES = MAX_BSON_OBJECT_SIZE - ROW_HEADROOM_BYTES;
/** The code of a schema too large for one stored document. */
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

/**
 * The refusal of a write that would store `next` as the schema of a space now holding `current`, or null when there is room. Asked before
 * anything is written; the quota is measured exactly (no reused measurement), as a person's single write is.
 */
export async function schemaRoomRefusal(current: SpaceMeta | undefined, next: SpaceMeta): Promise<SchemaRoomRefusal | null> {
  const nextBytes = Buffer.byteLength(schemaTextOf(next), 'utf8');
  if (nextBytes > SCHEMA_DOCUMENT_MAX_BYTES) {
    return { status: TOO_LARGE, body: { code: SCHEMA_TOO_LARGE, error:
      `The schema would take ${(nextBytes / MiB).toFixed(1)} MiB, more than one stored document holds: a schema is stored whole as one MongoDB `
      + `document of at most 16 MiB (${SCHEMA_DOCUMENT_MAX_BYTES} bytes of schema text). Nothing was written; remove or shorten types to fit.` } };
  }
  if (nextBytes <= Buffer.byteLength(schemaTextOf(current), 'utf8')) return null;
  try {
    await checkQuota('brain', nextBytes);
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
    return { status: INSUFFICIENT_STORAGE, body: { error: err.message, code: SCHEMA_STORAGE_EXCEEDED, storageExceeded: true } };
  }
  return null;
}
