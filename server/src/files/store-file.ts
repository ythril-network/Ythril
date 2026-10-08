/**
 * Store one file in a space: quota, bytes, metadata, the processing queue, the webhook — in that order, once.
 *
 * Three doors write a file: the REST upload, MCP `write_file`, and `ingest` (a conversation's transcripts). The
 * sequence was written out in the first two and was about to be written a third time. What a hand-written copy
 * drops is the part that looks like bookkeeping: the processing queue (a file stored and never embedded is
 * invisible to recall, and nothing says so) and the webhook (a subscriber never hears of it). They differed on one
 * point already — the REST door swallowed a metadata write failure and answered 2xx, which is the failure that
 * looks like the healthy answer — and here neither door does.
 *
 * A quota refusal is thrown as `QuotaError` for the door to map (REST answers 507, MCP an error result).
 */
import { sha256Hex } from '../util/sha256-hex.js';
import { writeFileBytes } from './files.js';
import { upsertFileMeta } from './file-meta.js';
import { bytesShadowed } from './tombstones.js';
import { peerFileKey } from './sandbox.js';
import { toDocId } from '../util/paths.js';
import type { AuthorRef } from '../config/types.js';
import { recordAndDispatchFile, type DispatchResult } from './dispatch.js';
import { recordArrivedBytes } from './bytes-arrived.js';
import { removeUnrecordedBytes } from './unrecorded-bytes.js';
import type { InputFormat } from './converters/pipeline.js';
import { checkQuota } from '../quota/quota.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';

/**
 * Are the bytes a PEER is delivering to the upload door the content a held file tombstone erased (bundle-51, Q-229)? Asked
 * by the door for a peer's arrival ONLY — never for a person's upload, which is a new authored version and always succeeds —
 * and answered by it `200 { tombstoned: true }` with nothing stored: an error status would be read by an older sender as a
 * failure, and it would upload the whole file again every cycle.
 *
 * `content` is the body (hashed here) or a way to hash it later (a chunked upload's staged chunks) — either is read only when a
 * tombstone for the path carries a hash to compare it with. The path is the PEER's text, resolved before anything is looked up
 * by it ({@link peerFileKey}, Q-404): `x/../victim` is asked about as `victim`. A tombstone Q-348 counts too — a delete whose
 * bytes are gone and whose publish has not landed — and a path that cannot be looked at throws a retryable `503`
 * ({@link bytesShadowed}). What it prevents: a peer that still holds a deleted file's bytes bringing them back through the one
 * door the manifest pull and the metadata writer do not guard.
 *
 * @throws RangeError when the path leaves the space — which the door answers `400`, as the write itself would have.
 */
export async function peerBytesShadowed(spaceId: string, filePath: string, content: Buffer | { sha256Of: () => Promise<string> }): Promise<boolean> {
  const { key } = await peerFileKey(spaceId, filePath);
  return bytesShadowed(spaceId, key, () => (Buffer.isBuffer(content) ? sha256Hex(content) : content.sha256Of()));
}

export interface StoreFileMeta {
  description?: string;
  tags?: string[];
  properties?: Record<string, string | number | boolean>;
  ttlDays?: number | null;
}

type Stored = { sha256: string; sizeBytes: number } & DispatchResult;
type StoreOpts = {
  meta?: StoreFileMeta; inputFormat?: InputFormat; contentType?: string; actor?: Record<string, unknown>;
  /**
   * The peer these bytes ARRIVED from, when a peer pushes a file to the upload door. Then the bytes are an arrival,
   * not an upload: recorded by `recordArrivedBytes` (`files/bytes-arrived.ts`: size and hash, the peer as author of a
   * record new here, no seq stamp, and the processing queue by this instance's rules) and `meta` and `actor` are ignored.
   * Stored as an upload, the receiver's copy took this instance's next seq and
   * this instance as the author of a new file, so it tied or outranked the publisher's next description or tag
   * edit, which then never landed (`Q-143` fixed the pull half of the same rule; this is the push half).
   */
  arrivedFrom?: AuthorRef;
};

/**
 * The half after the bytes are on disk: metadata, the processing queue, the webhook. For a door that wrote the
 * bytes itself — the chunked upload assembles them from parts — and for `storeFile` below. A peer's arrival takes the
 * other road, `recordArrivedBytes`, the one function the manifest pull goes through as well.
 *
 * **When the record step fails, the bytes it was to name do not stay behind** (`removeUnrecordedBytes`, the one answer every door
 * that writes bytes gives, the manifest pull's too): with no live row for the path they are removed, with one (an overwrite) they
 * are kept, as they are when the store cannot say whether a row exists, and the failure is rethrown either way for the door to answer. This is the only place the cleanup is asked for, so
 * `storeFile` and the chunked upload — the two callers — cannot leave it out; a door that wrote bytes and never calls this
 * function owns the same duty.
 */
export async function recordStoredFile(
  spaceId: string, filePath: string, sizeBytes: number, sha256: string, opts: StoreOpts = {},
): Promise<Stored> {
  // The path as the door was given it: the cleanup in the `catch` resolves it itself, and `filePath` is rebound below.
  const givenPath = filePath;
  try {
    // A path is a spelling until it is keyed (Q-404): the row, the processing queue and the webhook all name the KEY — a peer's
    // through the resolver (inside `recordArrivedBytes`), a local caller's through the one canonical key — so a webhook never
    // names a path the listing lacks. Rebound on purpose below, so no later line can name the spelling.
    if (opts.arrivedFrom) {
      // A peer's bytes: the one function every arrival goes through (the row, the processing queue by this instance's rules, the
      // count). No webhook and nothing on the bus: a peer's write is not a user act, as a synced record is not (`if (actor)` below).
      const dispatched = await recordArrivedBytes(spaceId, filePath, {
        sizeBytes, sha256, door: 'push', from: opts.arrivedFrom, inputFormat: opts.inputFormat, contentType: opts.contentType,
      });
      return { sha256, sizeBytes, ...dispatched };
    }
    filePath = toDocId(filePath);
    // The row is read BEFORE it is written and handed to the dispatcher, inside the one function both doors go through
    // (`recordAndDispatchFile`: its docblock says why that read is the part a hand-written sequence drops).
    const dispatched = await recordAndDispatchFile(spaceId, filePath, {
      bytes: sizeBytes, inputFormat: opts.inputFormat ?? 'auto', sha256,
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    }, () => upsertFileMeta(spaceId, filePath, sizeBytes, { ...(opts.meta ?? {}), sha256 }));
    // A write NO ONE made — a call with no actor — emits nothing, on the bus or to a webhook: the rule every record family keeps
    // (`if (actor) emitWebhookEvent`). A person's upload and a tool call carry one.
    if (opts.actor) emitWebhookEvent({ event: 'file.created', spaceId, entry: { path: filePath, sha256 }, ...opts.actor });
    return { sha256, sizeBytes, ...dispatched };
  } catch (err) {
    await removeUnrecordedBytes(spaceId, givenPath, err);
    throw err;
  }
}

/** The whole sequence: quota, bytes, then `recordStoredFile`. */
export async function storeFile(
  spaceId: string, filePath: string, bytes: Buffer, opts: StoreOpts = {},
): Promise<Stored & { quota: Awaited<ReturnType<typeof checkQuota>> }> {
  const quota = await checkQuota('files', bytes.length);
  const { sha256 } = await writeFileBytes(spaceId, filePath, bytes);
  return { ...(await recordStoredFile(spaceId, filePath, bytes.length, sha256, opts)), quota };
}
