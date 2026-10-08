/**
 * A file's BYTES arrived from a peer, or were found already here: record them completely, once, by this instance's own rules
 * (bundle-48, Q-254, Q-259, Q-260, Q-356).
 *
 * ## The question this module answers
 *
 * "These bytes are on disk and they are not a user's upload — what must now be true of the file?" The answer is three things, in
 * this order, and a door that does fewer is the defect: the file's row names the bytes (size, hash, and the peer that delivered
 * them), the file's processing is decided by THIS instance's rules (a document is queued for conversion, a media file for its
 * pipeline, a class this instance does not analyse is stamped `skipped`), and nothing is announced as if a person had made it.
 *
 * ## Why one function
 *
 * Two doors recorded an arrival and each wrote its own part. The upload door (`files/store-file.ts`) recorded the row,
 * dispatched, and fired a `file.created` webhook for a file a PEER wrote; the manifest pull (`sync/file-sync.ts`) recorded the
 * row with `.catch(() => {})` and nothing else. So a pulled `.html` was never converted and never found by a search, a pulled
 * CHANGED version left the previous version's passages beside nothing new, and a row write that failed was swallowed — the
 * bytes stayed on disk with no row naming them, the next cycle saw the same hash on both sides and skipped the file for ever.
 *
 * ## What a hand-written copy drops
 *
 * **The prior read.** The row is read BEFORE it is written and handed to the dispatcher. By the time the dispatcher runs the row
 * already holds the arriving hash, so a dispatcher that reads the row itself compares the arriving bytes with themselves: a
 * CHANGED file on a `complete` row was skipped and left `complete` under the new hash, with the old analysis (probe A ran it).
 * The read is here, in the only function an arrival goes through, so no door can skip it.
 *
 * **The count.** Every outcome is counted once, here (`ythril_sync_file_arrivals_total{door, outcome}`): a copy that recorded
 * the file and forgot the counter is an arrival an operator's dashboard never sees. A failure is counted and RETHROWN: the
 * caller owns what a failure means for its bytes (the pull removes them, see `sync/file-sync.ts`; the upload door answers 5xx),
 * and a swallowed one is the Q-254 defect.
 *
 * ## What it does not do
 *
 * It announces nothing. The record families that arrive from a peer pass no actor and publish nothing, on the bus or to a
 * webhook (`if (actor) emitWebhookEvent`), and a file's arrival is the same kind of write. An operator's Files page shows a
 * pulled or pushed file at its next refresh, as it shows a synced record.
 *
 * It does not store bytes and does not take the stored-bytes lock: the caller wrote them (or found them) at `filePath`.
 *
 * A pulled image is processed ONCE, by the media job the dispatcher queues for it. The sync engine used to queue a second one
 * for it (`sync/engine.ts`, gated on `reprocessSyncedImages`), which is gone: there is one path for a file's processing.
 */
import { authorRef } from '../config/author.js';
import type { AuthorRef } from '../config/types.js';
import { syncFileArrivalsTotal, type FILE_ARRIVAL_DOORS, type FILE_ARRIVAL_OUTCOMES } from '../metrics/registry.js';
import { recordArrivedFile } from './file-meta.js';
import { dispatchFileProcessing, readPriorProcessing, type DispatchResult } from './dispatch.js';
import { peerFileKey } from './sandbox.js';
import type { InputFormat } from './converters/pipeline.js';

/** How the bytes got here: `push` (a peer wrote them to the upload door) or `pull` (this instance fetched them, or found them held). */
export type FileArrivalDoor = (typeof FILE_ARRIVAL_DOORS)[number];
/** What became of an arrival, as `ythril_sync_file_arrivals_total` counts it. */
export type FileArrivalOutcome = (typeof FILE_ARRIVAL_OUTCOMES)[number];

/**
 * Why a file whose bytes were already here is recorded now: its row held another hash than the disk's (`stale_row`), no row at all
 * (`missing_row`), or processing never ran on a class that processes (`unprocessed`). The three repairs of `sync/file-sync.ts`.
 */
export type FileRepairReason = 'stale_row' | 'missing_row' | 'unprocessed';

/**
 * Count one arrival. THE counter write: every outcome goes through here, so no door counts by a spelling of its own.
 * Exported for the outcomes that never reach {@link recordArrivedBytes} (a refusal before the fetch, an offer ignored).
 */
export function countFileArrival(door: FileArrivalDoor, outcome: FileArrivalOutcome): void {
  syncFileArrivalsTotal.labels({ door, outcome }).inc();
}

export interface ArrivedBytes {
  sizeBytes: number;
  /** SHA-256 of the bytes on disk, which the caller computed or was given and checked. */
  sha256: string;
  door: FileArrivalDoor;
  /**
   * The peer that delivered the bytes: the author of a row NEW here, whose deliverer stamp it carries. Absent for bytes that were
   * already here and are being recorded now (a repair): nobody can be credited with delivering them, so the row is this
   * instance's own placeholder, which the first authored metadata to arrive replaces, and no peer is handed the power an
   * upstream's deletion stands on (`sync/deletion-authority.ts`) over a file it may never have sent.
   */
  from?: AuthorRef;
  /** Set when this is a repair of a file already held: counted under its reason instead of `recorded`. */
  repair?: FileRepairReason;
  /** Raw `Content-Type` of an upload, when there is one: the format and the enqueue MIME type derive from it. */
  contentType?: string | undefined;
  inputFormat?: InputFormat | undefined;
}

/**
 * Record bytes that arrived: the row, then the processing queue, then the count. Returns what the dispatcher decided (the
 * resolved format and the status for an answer).
 *
 * `filePath` is the PEER's text and is resolved here by the one resolver (`peerFileKey`, Q-404); a caller that already holds the
 * key passes it, and resolving a key gives the key.
 *
 * @throws what the row write or the dispatch threw, after counting `record_failed`. Bytes are NOT removed here: whether they
 *   stay is the caller's (the pull removes them and redoes the file next cycle; an upload fails and the sender retries).
 */
export async function recordArrivedBytes(spaceId: string, filePath: string, arrived: ArrivedBytes): Promise<DispatchResult> {
  const { key } = await peerFileKey(spaceId, filePath);
  // BEFORE any write: the dispatcher compares the arriving hash with the row's PRIOR one (see the module docblock).
  const prior = await readPriorProcessing(spaceId, key);
  try {
    await recordArrivedFile(spaceId, key, arrived.sizeBytes, arrived.sha256, arrived.from ?? authorRef());
    const dispatched = await dispatchFileProcessing(spaceId, key, {
      bytes: arrived.sizeBytes, inputFormat: arrived.inputFormat ?? 'auto', sha256: arrived.sha256, prior,
      ...(arrived.contentType ? { contentType: arrived.contentType } : {}),
    });
    countFileArrival(arrived.door, arrived.repair ? `repaired_${arrived.repair}` : 'recorded');
    return dispatched;
  } catch (err) {
    countFileArrival(arrived.door, 'record_failed');
    throw err;
  }
}
