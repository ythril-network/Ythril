/**
 * Moving a file or directory — one cascade, shared by the REST `PATCH` and the MCP `move_file` tool.
 *
 * A move is not a rename of the bytes. What belongs to the path has to follow it: the metadata record, the rows a conversion derived
 * from it (chunks, the converted Markdown, extracted images, and the caption and face rows under those), the sidecar files on disk,
 * the links, the job queue, and a sync tombstone for every path left behind. Both doors wrote this sequence out, both did the same
 * part of it, and neither did the rest.
 *
 * ## The order, and what each step is there for
 *
 *  1. **Refuse what cannot be done, before anything is written**: a source that is not there and owes nothing (404, checked first so
 *     the order of refusals is the caller's), a move onto itself or into its own subtree, a destination a regular file blocks
 *     (`files/destination.ts`), and a destination whose ids another file's rows hold (`DestinationTakenByOther`, `files/move-plan.ts`).
 *  2. **Hold the jobs** (`holdJobsForMove`), before a byte moves. A conversion started by the upload can still be running; it used to
 *     finish afterwards and insert its chunk rows under the OLD path, which nothing would ever delete. A run that has not yet
 *     committed finds its claim gone and writes nothing; a run that did leaves rows where the batches below find them; a run that
 *     finds the file missing asks whether a move of that path is owed before it reconciles "a deleted source".
 *  3. **Write the tombstones PENDING, with the move's marker**, then move the bytes under them: each is published once ITS bytes
 *     have moved (`files/tombstones.ts`). The marker is what tells a retry "this is a move I began", as against an orphan source
 *     beside an unrelated file at the destination, and it records what the bytes were (size and mtime, so the bytes at the
 *     destination can be told from a different file's) and who asked. An act that cannot record its removal does not begin.
 *  4. **Carry the records in BATCHES**, each one transaction under a byte budget (`files/move-timing.ts`): the file rows, every row
 *     derived from them and the jobs are re-keyed together (`files/rekey-rows.ts`), after the batch's links were converged onto the
 *     new ids and before the old ids' links are removed (`files/move-links.ts`). Whatever fails, each file is wholly at its old path
 *     or wholly at its new one.
 *  5. **Forget the marker** only when nothing of the move is still owed.
 *
 * ## What a failure after the bytes moved is
 *
 * `MoveStillOwed` — never swallowed, never a success. The bytes are at the destination and some records are not, and the move is
 * finished by the retry of the request or, if nobody retries, by housekeeping (`files/finish-owed-moves.ts`); nothing that runs by
 * itself forgets the marker or removes the records while it is owed (`moveIsOwed`). A sidecar whose bytes cannot be moved keeps the
 * move owed: its rows do not move away from their bytes.
 *
 * ## One run at a time
 *
 * The runs of one `(space, src, dst)` take turns (`files/move-flight.ts`): the request, its retry and housekeeping cannot interleave.
 * A run that waited sees what the one before it left, so a retry that arrives behind a run that finished it is the "retried move
 * after it was finished" that answers 404, as the documentation says.
 *
 * ## An abandoned move
 *
 * A marker whose bytes at the destination are NOT the ones that moved (an unrelated file replaced them) is not owed and is never
 * finished: nothing is overwritten. The links the move had already converged onto the destination are removed when the marker is
 * cleared (`removeConvergedLinks`).
 */
import { moveFile, listFilesRecursive } from './files.js';
import { holdJobsForMove, releaseMoveHold, extendMoveHold, markSpaceMayHaveWork, rekeyJobsForMove } from './media/job-queue.js';
import { movedId, movedSidecars, type PathKind } from './moved-paths.js';
import { resolveSafePathChecked } from './sandbox.js';
import { bytesPresentAt, isStoredDirectory } from './stored-bytes.js';
import {
  actUnderPendingTombstones, bytesIdentityAt, forgetFinishedMove, moveIsOwed, moveMarkerOf, pendingAmong, settleBegunMove, writePendingFileTombstones,
} from './tombstones.js';
import { MoveStillOwed } from './act-answers.js';
import { assertDestinationReachable, assertNotMovedIntoItself } from './destination.js';
import { batchesOf, holdsAtDestination, planMove, rebuiltFileRow, type MoveBatch, type MovePlan } from './move-plan.js';
import { convergeLinks, removeConvergedLinks, retireLinks, type LinkMove } from './move-links.js';
import { moveTiming } from './move-timing.js';
import { runMoveOnce } from './move-flight.js';
import { StaleRekeyPlan, rekeyRows } from './rekey-rows.js';
import { fileLinkSourcesUnder } from '../brain/link-adjacency.js';
import { readStoredById } from '../db/read-by-id.js';
import { inBoundedTransaction } from '../db/bounded-transaction.js';
import { isDuplicateKey } from '../db/write-errors.js';
import { spaceCollection } from '../db/space-collection.js';
import { NotFoundError } from '../util/errors.js';
import { toDocId } from '../util/paths.js';
import { warnOnce } from '../util/warn-once.js';
import type { FileMetaDoc } from '../config/types.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import { fileMoveBatchReplansTotal, fileMovesOntoTakenDestinationTotal } from '../metrics/registry.js';
import { log, peerText } from '../util/log.js';

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A move that replaced a live file's records is said once per space per window: it is a stated behaviour, and a noisy line is not news. */
const saidReplaced = warnOnce<string>({ max: 1_000, every: 10 * 60_000 });

/**
 * Every file path the move takes away, for the tombstones: the files themselves (`moved`, gone with the rename) and
 * their sidecars (`sidecars`, gone only once `completeMove` moves them, which can fail). Sync has no rename
 * detection, so a path without a tombstone is still advertised by a peer's manifest and comes back on the next pull.
 */
async function pathsLeaving(spaceId: string, src: string, dst: string): Promise<{ moved: string[]; sidecars: string[] }> {
  // What `src` IS decides which sidecars it owns, so it is read from the disk (`isStoredDirectory`), never inferred from whether it
  // has children: an empty directory has none and is still a directory, whose trees are not a file's converted Markdown.
  const kind = await kindAt(spaceId, src);
  const children = await listFilesRecursive(spaceId, src);
  const sidecars: string[] = [];
  for (const { from } of await movedSidecars(spaceId, src, dst, kind)) {
    const under = await listFilesRecursive(spaceId, from);
    if (under.length > 0) sidecars.push(...under);
    else if (await bytesPresentAt(spaceId, from)) sidecars.push(from);
  }
  return { moved: children.length > 0 ? children : [src], sidecars };
}

/** What the path at `relPath` is on disk — a directory or, whatever else, a file: the kind its sidecars are asked by. */
async function kindAt(spaceId: string, relPath: string): Promise<PathKind> {
  return await isStoredDirectory(await resolveSafePathChecked(spaceId, relPath)) ? 'directory' : 'file';
}

/**
 * Re-key one batch: converge the batch's links onto their new ids, then ONE transaction for the file rows, the rows derived from
 * them and the jobs (with the flagged audit rows at the destination removed and a live occupant's rows replaced), then — only once
 * it has committed — wake the worker and take the old ids' links off. The worker is never woken before the commit: it would find no
 * row at the new id, report the job gone, and have it deleted.
 */
async function carryBatch(spaceId: string, plan: MovePlan, batch: MoveBatch, held: readonly string[]): Promise<void> {
  const { src, dst, kind } = plan;
  const links: LinkMove[] = batch.linkFiles.flatMap(from => {
    const to = movedId(from, src, dst);
    return to !== null && to !== from ? [{ from, to }] : [];
  });
  await convergeLinks(spaceId, links);

  const moves = batch.rows.map(r => ({ from: r.from, to: r.to }));
  const filesColl = spaceCollection(spaceId, 'files');
  const first = batch.rows[0];
  const firstJob = batch.jobIds[0];
  const jobTo = firstJob === undefined ? undefined : movedId(firstJob, src, dst);
  // A commit whose reply was lost has landed: the batch's first row is at its new id and no longer at its old one.
  const landed = async (): Promise<boolean> => {
    if (first) {
      const seen = await readStoredById<{ _id: string }>(filesColl, [first.from, first.to], { _id: 1 });
      return seen.has(first.to) && !seen.has(first.from);
    }
    if (firstJob !== undefined && jobTo) {
      const seen = await readStoredById<{ _id: string }>(spaceCollection(spaceId, 'mediaJobs'), [firstJob, jobTo], { _id: 1 });
      return seen.has(jobTo) && !seen.has(firstJob);
    }
    return false;
  };
  let jobsMoved = 0;
  if (moves.length > 0 || batch.jobIds.length > 0) {
    jobsMoved = await inBoundedTransaction(async (session) => {
      if (moves.length > 0) {
        await rekeyRows<FileMetaDoc>(filesColl, session, {
          moves,
          rebuild: (row, to) => rebuiltFileRow(row, to, src, dst),
          // A row at a new id that the plan did not name appeared since it was made: the plan is stale, and is made again.
          refuse: (to) => new StaleRekeyPlan(`a row appeared at '${to}' since the batch was planned`),
          replacements: { replaced: batch.replaced, flagged: batch.flagged },
        });
      }
      return rekeyJobsForMove(spaceId, src, dst, held, kind, { session, jobIds: batch.jobIds });
    }, { landed });
  }
  if (jobsMoved > 0) markSpaceMayHaveWork(spaceId);
  if (batch.replaced.length > 0) {
    fileMovesOntoTakenDestinationTotal.labels({ space: spaceId }).inc();
    saidReplaced(spaceId, () => log.info(`A move in space '${peerText(spaceId)}' replaced the records of a file that stood at its destination (a rename onto an existing file replaces it)`));
  }
  await retireLinks(spaceId, links.map(l => l.from));
}

/** {@link carryBatch}, planned again (up to `maxReplans` times) when what stood at the destination changed between the plan and the transaction. */
async function carryBatchReplanning(spaceId: string, plan: MovePlan, batch: MoveBatch, held: readonly string[]): Promise<void> {
  let current = batch;
  for (let replans = 0; ; replans++) {
    try {
      await carryBatch(spaceId, plan, current, held);
      return;
    } catch (err) {
      if (!(err instanceof StaleRekeyPlan || isDuplicateKey(err)) || replans >= moveTiming().maxReplans) throw err;
      fileMoveBatchReplansTotal.labels({ space: spaceId }).inc();
      const holds = await holdsAtDestination(spaceId, current.rows, plan.src, plan.dst, plan.kind);
      current = { ...current, flagged: [...holds.flagged], replaced: [...holds.replaced] };
    }
  }
}

/** The files of the plan whose bytes are at the source again — a re-upload after the move: their rows describe a new file and stay where they are. */
async function cameBackAtSource(spaceId: string, plan: MovePlan): Promise<Set<string>> {
  if (plan.kind === 'file') return new Set(await bytesPresentAt(spaceId, plan.src) ? [plan.src] : []);
  return new Set((await listFilesRecursive(spaceId, plan.src)).map(p => toDocId(String(p))));
}

/**
 * Everything that follows the bytes, in the order a retry can finish: the sidecars' bytes, the settle of the tombstones the move
 * left pending, then the records in batches. A failure of any of it is {@link MoveStillOwed} — the marker stays, the jobs stay held —
 * and nothing in here swallows one. The marker is forgotten only when the move is no longer owed.
 */
async function completeMove(spaceId: string, src: string, dst: string, held: readonly string[]): Promise<void> {
  try {
    // The bytes have moved, so what the path IS is read where they went.
    const kind = await kindAt(spaceId, dst);
    let sidecarFailed = false;
    for (const sidecar of await movedSidecars(spaceId, src, dst, kind)) {
      if (!(await bytesPresentAt(spaceId, sidecar.from))) continue;
      await moveFile(spaceId, sidecar.from, sidecar.to).catch((err: unknown) => {
        sidecarFailed = true;
        log.warn(`move sidecar error for ${peerText(spaceId)}, ${peerText(sidecar.from)} → ${peerText(sidecar.to)}: ${peerText(why(err))}`);
      });
    }
    // Every byte this move will carry has moved, or failed to: the tombstones it left pending are settled from the disk. A sidecar that
    // could not move is still here, so its tombstone is dropped rather than published (preship-4 P4-3).
    await settleBegunMove(spaceId, src, dst);
    if (sidecarFailed) throw new Error('a sidecar of the moved path could not be moved, so its records stay with its bytes');

    const plan = await planMove(spaceId, src, dst, kind);
    const cameBack = await cameBackAtSource(spaceId, plan);
    const batches = batchesOf(plan, moveTiming().txnBytes).map(b => ({
      ...b,
      rows: b.rows.filter(r => !cameBack.has(r.group)),
      linkFiles: b.linkFiles.filter(f => !cameBack.has(f)),
    }));
    let started = false;
    for (const batch of batches) {
      if (started) await extendMoveHold(spaceId, plan.src, kind);
      started = true;
      await carryBatchReplanning(spaceId, plan, batch, held);
    }
  } catch (err) {
    log.warn(`The move ${peerText(spaceId)}, ${peerText(src)} → ${peerText(dst)} stopped after its bytes moved and is owed: ${peerText(why(err))}`);
    throw new MoveStillOwed(src, dst);
  }
  // Finished: nothing is owed, so its marker must not make a later orphan at `src` look like this move. A move that is still owed
  // (something of it was not carried: a file whose bytes came back) keeps its marker.
  await forgetFinishedMove(spaceId, src, dst);
}

/**
 * Take back the links an abandoned move converged onto its destination, and forget its marker. A move is abandoned when its marker
 * says the bytes moved, the bytes are at the destination and none at the source, and yet it is not owed: what is at the destination
 * is not what moved (an unrelated file replaced it), or nothing of the file is left at the source. Nothing is carried or overwritten.
 */
async function abandonMove(spaceId: string, src: string, dst: string): Promise<void> {
  const marker = await moveMarkerOf(spaceId, src, dst);
  if (!marker || !(await bytesPresentAt(spaceId, marker.to)) || await bytesPresentAt(spaceId, marker.from)) return;
  const kind = await kindAt(spaceId, marker.to);
  const froms = kind === 'file' ? [toDocId(src)] : await fileLinkSourcesUnder(spaceId, toDocId(src));
  await removeConvergedLinks(spaceId, froms.flatMap(from => { const to = movedId(from, src, dst); return to !== null && to !== from ? [{ from, to }] : []; }));
  await forgetFinishedMove(spaceId, src, dst);
}

/** A source with no bytes: a move this instance began and a failure stopped is finished; anything else is an orphan beside whatever is at the destination. */
async function finishOrRefuse(spaceId: string, src: string, dst: string): Promise<void> {
  // Without the marker this is an orphan `src` beside an unrelated `dst`, which this used to "complete" by overwriting that file's jobs,
  // chunks and sidecars (preship-3 P3-2). A path that cannot be looked at is thrown, never read as "not owed".
  if (!(await moveIsOwed(spaceId, src, dst))) {
    await abandonMove(spaceId, src, dst);
    throw new NotFoundError(`Path '${src}' not found in space '${spaceId}'`);
  }
  // Its tombstones were written before those bytes moved; `completeMove` settles any its first attempt left pending, once the
  // sidecars have had their turn. The bytes are at `dst`, so what the path IS is read there.
  await completeMove(spaceId, src, dst, await holdJobsForMove(spaceId, src, await kindAt(spaceId, dst)));
}

/**
 * Begin a move that has a source: refuse a destination other files' rows hold, write the tombstones pending with the marker, hold the
 * jobs and move the bytes under them. Returns the jobs it holds.
 *
 * The tombstones go BEFORE the bytes move, pending (bundle-30 I13, I15, `files/tombstones.ts`): a store failure here leaves the source
 * where it was, so the retry repeats the move — written after, the retry found no source and the paths left behind were never
 * tombstoned. Each is published once ITS bytes have moved — the file's with the rename, a sidecar's only after its own move
 * (bundle-30 I16, preship-4 P4-3) — and dropped if they did not, since nobody asked for those paths to go. Pending, no peer is told of
 * them meanwhile.
 */
async function beginMove(spaceId: string, src: string, dst: string, actor: WebhookActor | undefined): Promise<string[]> {
  const kind = await kindAt(spaceId, src);
  await planMove(spaceId, src, dst, kind);
  const { moved, sidecars } = await pathsLeaving(spaceId, src, dst);
  // A rename keeps a file's size and mtime: what tells the bytes at the destination are the moved ones. A directory records none.
  const identity = kind === 'file' ? await bytesIdentityAt(spaceId, src) : undefined;
  const pending = await writePendingFileTombstones(spaceId, [...moved, ...sidecars], { from: src, to: dst, ...identity, ...(actor ? { actor } : {}) });
  let held: string[] = [];
  await actUnderPendingTombstones(pending, async () => {
    try {
      held = await holdJobsForMove(spaceId, src, kind);
      await moveFile(spaceId, src, dst);
    } catch (err) {
      await releaseMoveHold(spaceId, held).catch(e => log.warn(`releaseMoveHold error for ${peerText(spaceId)}/${peerText(src)}: ${peerText(why(e))}`));
      throw err;
    }
  }, pendingAmong(pending, moved));
  return held;
}

/** Move `src` to `dst` in `spaceId`, and everything that belongs to it with it. See the module docblock for the order. */
export async function moveFileCascade(spaceId: string, src: string, dst: string, actor?: WebhookActor): Promise<void> {
  // Both paths resolved and the source found BEFORE anything is written: a refusal of either is the caller's, and
  // must not leave a tombstone behind it.
  await resolveSafePathChecked(spaceId, src);
  await resolveSafePathChecked(spaceId, dst);
  await runMoveOnce(spaceId, src, dst, async () => {
    if (!(await bytesPresentAt(spaceId, src))) {
      await finishOrRefuse(spaceId, src, dst);
    } else {
      assertNotMovedIntoItself(spaceId, src, dst);
      await assertDestinationReachable(spaceId, dst);
      await completeMove(spaceId, src, dst, await beginMove(spaceId, src, dst, actor));
    }
    // The brain family's one rule (`if (actor) emitWebhookEvent`), as in `deleteFileCascade`: no actor, no webhook and no
    // live-view event (bundle-48, Q-259).
    if (actor) emitWebhookEvent({ event: 'file.updated', spaceId, entry: { path: dst, previousPath: src }, ...actor });
  });
}
