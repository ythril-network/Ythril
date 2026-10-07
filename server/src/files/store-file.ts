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
import { upsertFileMeta, recordArrivedFile } from './file-meta.js';
import { bytesShadowed } from './tombstones.js';
import { toDocId } from '../util/paths.js';
import type { AuthorRef } from '../config/types.js';
import { dispatchFileProcessing, type DispatchResult } from './dispatch.js';
import type { InputFormat } from './converters/pipeline.js';
import { checkQuota } from '../quota/quota.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';

/**
 * Are the bytes a PEER is delivering to the upload door the content a held file tombstone erased (bundle-51, Q-229)? Asked
 * by the door for a peer's arrival ONLY — never for a person's upload, which is a new authored version and always succeeds —
 * and answered by it `200 { tombstoned: true }` with nothing stored: an error status would be read by an older sender as a
 * failure, and it would upload the whole file again every cycle.
 *
 * `content` is the body (hashed here, and only when a tombstone for the path carries a hash to compare it with) or an already
 * known hash (a chunked upload's assembly). What it prevents: a peer that still holds a deleted file's bytes bringing them
 * back through the one door the manifest pull and the metadata writer do not guard.
 */
export async function peerBytesShadowed(spaceId: string, filePath: string, content: Buffer | { sha256: string }): Promise<boolean> {
  return bytesShadowed(spaceId, toDocId(filePath), () => (Buffer.isBuffer(content) ? sha256Hex(content) : content.sha256));
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
   * not an upload: recorded by `recordArrivedFile` (size and hash, the peer as author of a record new here, and no
   * seq stamp) and `meta` is ignored. Stored as an upload, the receiver's copy took this instance's next seq and
   * this instance as the author of a new file, so it tied or outranked the publisher's next description or tag
   * edit, which then never landed (`Q-143` fixed the pull half of the same rule; this is the push half).
   */
  arrivedFrom?: AuthorRef;
};

/**
 * The half after the bytes are on disk: metadata, the processing queue, the webhook. For a door that wrote the
 * bytes itself — the chunked upload assembles them from parts — and for `storeFile` below.
 */
export async function recordStoredFile(
  spaceId: string, filePath: string, sizeBytes: number, sha256: string, opts: StoreOpts = {},
): Promise<Stored> {
  if (opts.arrivedFrom) await recordArrivedFile(spaceId, filePath, sizeBytes, sha256, opts.arrivedFrom);
  else await upsertFileMeta(spaceId, filePath, sizeBytes, { ...(opts.meta ?? {}), sha256 });
  const dispatched = await dispatchFileProcessing(spaceId, filePath, {
    bytes: sizeBytes, inputFormat: opts.inputFormat ?? 'auto', sha256,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
  });
  emitWebhookEvent({ event: 'file.created', spaceId, entry: { path: filePath, sha256 }, ...(opts.actor ?? {}) });
  return { sha256, sizeBytes, ...dispatched };
}

/** The whole sequence: quota, bytes, then `recordStoredFile`. */
export async function storeFile(
  spaceId: string, filePath: string, bytes: Buffer, opts: StoreOpts = {},
): Promise<Stored & { quota: Awaited<ReturnType<typeof checkQuota>> }> {
  const quota = await checkQuota('files', bytes.length);
  const { sha256 } = await writeFileBytes(spaceId, filePath, bytes);
  return { ...(await recordStoredFile(spaceId, filePath, bytes.length, sha256, opts)), quota };
}
