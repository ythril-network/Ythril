/**
 * File sync tombstones.
 *
 * A `FileTombstoneDoc` in the per-space `<spaceId>_file_tombstones` collection
 * records that a file was deleted locally. The sync engine pushes these to peers,
 * which then unlink the file and drop its metadata — without them, a peer's manifest
 * still advertises the file and pushes it straight back (resurrection). Every code
 * path that deletes a file (API, folder delete, MCP) must write one.
 *
 * ## The tombstone is written BEFORE the bytes go (bundle-30 I13)
 *
 * Every path that removes a file — `deleteFileCascade`, the directory delete, `moveFileCascade` — writes the tombstone
 * first and only then unlinks, removes or moves. The two orders fail differently, and only one of them recovers:
 *
 * - **A tombstone for a removal that then failed** names a file the caller asked to remove and was told was not. The
 *   caller's retry completes it, and a peer that applied the tombstone meanwhile holds what it would hold after a
 *   delete followed by a re-upload — a state sync already lives with. A move that fails withdraws the tombstones it
 *   wrote, because nobody asked for that path to go.
 * - **Bytes gone with no tombstone** is repaired by nothing: the retry finds no file, and a peer's manifest pushes it
 *   back for good. That is what I12's rethrow produced while the write ran after the unlink — the retried REST
 *   delete took its orphan branch and wrote none, the directory delete answered 404, the move found no source, and
 *   the TTL sweep met ENOENT on every cycle.
 *
 * So a store failure here leaves the file exactly where it was, the caller is answered `503`, and the retry repeats
 * the whole act. A file whose bytes are already gone while its metadata remains is completed by the cascade
 * (`files/delete-cascade.ts`), tombstone included.
 *
 * ## A write reported failed is withdrawn by ids known before it was sent (bundle-30 I14, verify-drive-4 D2)
 *
 * **The invariant: a tombstone stays only for a path this instance removed, or is still removing.** A write the store
 * reported failed is not known NOT to have landed: with the store paused, the driver gives up on the connection and
 * reports the insert failed, and the store applies it from its buffer when it comes back. This module used to answer
 * such a write with no ids, so nothing was withdrawn, and a moved-nowhere file was tombstoned for every peer.
 *
 * So the ids are allocated before the write, and a write that fails — for any reason — withdraws them itself, before
 * it says so; a move that fails after its tombstones were written withdraws those. The withdrawal does not depend on
 * what the write reported, and it does not give up while the store is the reason: it is retried until the store takes
 * it, then once more {@link CONFIRM_AFTER_MS} later for an insert applied just after it. It runs behind the act, so
 * the caller's `503` does not wait on the store a second time.
 */

import { v4 as uuidv4 } from 'uuid';
import { toDocId } from '../util/paths.js';
import { col, asDoc, asFilter } from '../db/mongo.js';
import type { FileTombstoneDoc } from '../config/types.js';
import { log, peerText } from '../util/log.js';
import { classifyReadFailure, throwIfStoreSide } from '../brain/store-failure.js';
import { spaceCollection } from '../db/space-collection.js';
import { backoffDelayMs } from '../util/backoff.js';
import { DetachedWork } from '../util/detached-work.js';

/** The wait before a refused withdrawal is tried again: this, doubling to {@link RETRY_MAX_MS}, jittered (`backoffDelayMs`). */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 30_000;
/** How long after a withdrawal succeeds it is repeated — an insert from a connection the driver gave up on can land just after. */
const CONFIRM_AFTER_MS = 2_000;

/** Withdrawals still running, so a test (and nothing else) can wait for them: `whenFileTombstoneWithdrawalsSettle`. */
const withdrawals = new DetachedWork('withdrawFileTombstones');

/**
 * Insert a sync tombstone for each of `paths` so peers remove the files too, and answer the ids written (none when
 * the write failed on a condition that is not the store's).
 * Paths are normalised (forward slashes, no leading slash) and deduped.
 * A failed write withdraws the ids it was given before it reports anything (see the module docblock). Then a STORE
 * failure is thrown, so the door answers it as every door answers one and the caller knows to retry (bundle-30 I12) —
 * and since it is written before the bytes go, nothing has happened yet that the retry would miss. Any other failure
 * is logged and the act goes on.
 */
export async function writeFileTombstones(spaceId: string, paths: string[]): Promise<string[]> {
  const unique = [...new Set(paths.map(toDocId))].filter(Boolean);
  if (unique.length === 0) return [];
  const now = new Date().toISOString();
  const docs: FileTombstoneDoc[] = unique.map(p => ({ _id: uuidv4(), spaceId, path: p, deletedAt: now }));
  const ids = docs.map(d => d._id);
  try {
    await col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones')).insertMany(docs.map(d => asDoc<FileTombstoneDoc>(d)));
    return ids;
  } catch (err) {
    withdrawFileTombstones(spaceId, ids);
    throwIfStoreSide(err);
    log.warn(`writeFileTombstones error for space ${peerText(spaceId)} (${unique.length} paths): ${peerText(err)}`);
    return [];
  }
}

/**
 * Remove tombstones this instance wrote for an act that did not happen — a write reported failed, or a move whose
 * bytes did not move. Started at once and run behind the caller; retried while the failure is the store's retryable
 * condition, then repeated once (module docblock). Any other failure is logged and ends it: retrying it would fail
 * the same way.
 */
export function withdrawFileTombstones(spaceId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const owed = [...ids];
  withdrawals.start(() => withdrawUntilTaken(spaceId, owed));
}

async function withdrawUntilTaken(spaceId: string, ids: string[]): Promise<void> {
  const tombstones = col<FileTombstoneDoc>(spaceCollection(spaceId, 'fileTombstones'));
  const withdraw = () => tombstones.deleteMany(asFilter<FileTombstoneDoc>({ _id: { $in: ids } }));
  const what = `withdrawFileTombstones for space ${peerText(spaceId)} (${ids.length})`;
  for (let refusals = 0; ; refusals++) {
    try {
      await withdraw();
      if (refusals > 0) log.info(`${what}: taken`);
      break;
    } catch (err) {
      if (!classifyReadFailure(err).retryable) {
        log.warn(`${what} failed, and is not retried — peers may delete these paths: ${peerText(err)}`);
        return;
      }
      if (refusals === 0) log.warn(`${what}: the store refused it; retrying until it is taken: ${peerText(err)}`);
      await sleep(backoffDelayMs(refusals, RETRY_FIRST_MS, RETRY_MAX_MS));
    }
  }
  await sleep(CONFIRM_AFTER_MS);
  await withdraw().catch(err => log.warn(`${what}: the repeat failed: ${peerText(err)}`));
}

/** A wait that does not hold the process open: a withdrawal still pending at shutdown is not worth staying up for. */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms).unref());

/** Resolves when every withdrawal started so far has finished. For tests: the act answers before its withdrawal does. */
export async function whenFileTombstoneWithdrawalsSettle(): Promise<void> {
  await withdrawals.settled();
}
