/**
 * The position hold's fixture: what a file-tombstone PUSH proves to a peer, and the writes that stamp a position —
 * the two things every case of "a position is never handed out while an earlier one is uncommitted" (Q-346) needs.
 *
 * ## Why a module
 *
 * The own-publish, legacy-pass and relayed-store cases live in two files (a door is one per process: the act doors
 * and the pull door cannot share one), and both need the same two answers. The second file was about to copy them,
 * and the copy that drifts is the case that proves the prune safe against a push that never looked like production's.
 *
 * ## What it answers
 *
 * `sentThenAcknowledged(S)` is the push's own first page, step for step as `sync/file-sync.ts` takes it: the published page
 * (`publishedFileTombstonePage`), the rows a 200 would PROVE delivered (`settledFileTombstones`) and the position that
 * acknowledgement records (`ackedPositionFrom`). It reads no config and sends nothing, so a case can ask it while a write is
 * parked. `upTo` is `null` when the page proved nothing, and a case then prunes nothing: a prune at an acknowledgement that was
 * never recorded is not a prune any cycle makes.
 *
 * ## What it prevents
 *
 * A "the push sent T2" assertion. On the fixed code a published tombstone may be held back from the page while an earlier
 * position is uncommitted, so the case asserts what the prune does with whatever WAS acknowledged, never that something was.
 *
 * `writesAPosition` is the one predicate for "this write stamps a position": a write method that carries the field
 * `positionAt` in what it writes, so a park armed with it parks the publish, the relayed store or the legacy pass, whichever
 * statement the implementation spells it with, and no test's own insert.
 */

/** The write methods that can carry a stamp. An insert is a test's own fixture row; a delete carries a position only in its filter. */
const STAMPING = new Set(['updateOne', 'updateMany', 'bulkWrite', 'findOneAndUpdate']);

/** Whether a write (`method`, `args` as the driver is called) writes the field `positionAt`. */
export function writesAPosition(method, args) {
  if (!STAMPING.has(method)) return false;
  const written = method === 'bulkWrite'
    ? (args[0] ?? []).flatMap(op => [op.updateOne?.update, op.updateMany?.update, op.replaceOne?.replacement])
    : [args[1]];
  return written.some(u => u && JSON.stringify(u.$set ?? u.$setOnInsert ?? u).includes('"positionAt"'));
}

/** What a push of the space's published tombstones would record as acknowledged, as a 200 for its first page. */
export async function sentThenAcknowledged(spaceId) {
  // Loaded when asked, after the door is open: these modules read the data root and the config at import.
  const { publishedFileTombstonePage, settledFileTombstones } = await import('../../server/dist/files/tombstones.js');
  const { ackedPositionFrom } = await import('../../server/dist/sync/file-tombstone-ack.js');
  const { ISO_READ_START } = await import('../../server/dist/util/seq-keyset.js');
  const { rows, next, peek } = await publishedFileTombstonePage(spaceId, ISO_READ_START);
  const proven = settledFileTombstones(rows, peek);
  return { sent: rows.map(r => r.path), next, upTo: ackedPositionFrom(proven) };
}

/** The prune a cycle makes once a peer's acknowledgement is recorded at `upTo` (one peer, so the floor is `upTo`). */
export async function pruneAt(spaceId, upTo) {
  const { pruneFileTombstonesToFloor } = await import('../../server/dist/brain/tombstone-prune.js');
  return pruneFileTombstonesToFloor(spaceId, { prune: true, upTo, peers: 1 });
}
