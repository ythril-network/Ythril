/**
 * Which embed work a file row has — the one answer every remover and every relocator of file rows asks (bundle-111, Q-459).
 *
 * ## What it prevents
 *
 * Every file row — a top-level file, a chunk, a converted or extracted sidecar, a caption or face row under an image — has its own embed
 * job, keyed `embedJobId('file', <row id>)`. Nothing that removed or moved rows touched those jobs:
 *
 *  - **a delete left every job of the file and its derived rows**, each answering `gone` when claimed, a terminal `failed` one for ever;
 *    and one left at a later move's destination stood in that move's way;
 *  - **a move left the moved file with its OLD path's vector.** A top-level file's embed text is built from its path, the re-key carries
 *    the vector with the row, and no job was queued at the new id — so the moved file ranked as the old path, for ever, while a peer that
 *    received the move embedded the new one.
 *
 * ## The two steps, and what each keeps inside so no caller can drop it
 *
 *  - {@link retireEmbedWorkOfRemovedRows}: the jobs of rows a remover took. **Derived ids are the caller's READ of the rows** (`rowsOfFiles`,
 *    `parentFileId`), never an id prefix: `file:a#` also matches a file literally named `a#1.md`, which is a file of its own and keeps its
 *    job. A wipe names every file row of the space.
 *  - {@link requeueEmbedWorkOfMovedRows}: AFTER the move's last batch committed (never inside a transaction: the queue takes no session,
 *    and a worker woken before the commit finds no row and deletes the job as `gone`). It reads the rows now AT THE DESTINATION — not the
 *    batches, so a retried owed move re-covers the batches an earlier attempt committed — queues every top-level row (its text changed with
 *    its path) and every derived row that had a job at its old id, and retires the old ids' jobs. **Best-effort**: the records are moved, so
 *    a failure is said once through the shared reporter and never makes the move owed; the rows keep their old vectors until a reindex.
 *    A move into a suppressed ancestor is queued too: the worker answers `excluded` there and drops the vector.
 */
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { embedJobId, enqueueEmbedJobs, retireEmbedJobs, EMBED_PRIORITY } from '../brain/embed-queue.js';
import { rootsOfDirectory, rowsOfFiles } from './derived-rows.js';
import { movedId, movedRoot, sidecarsOwnedBy, type PathKind } from './moved-paths.js';
import { warnOnce } from '../util/warn-once.js';
import { log, peerText } from '../util/log.js';
import { NOT_A_FLAGGED_ROW } from './live-file-row.js';
import type { RemoveBy } from './path-keyed-cache.js';

/** Which rows a remover took: their ids, read from the rows (see the module docblock), or every file row of the space (a wipe, in its batches). */
export type RowsRemoved = { ids: readonly string[] } | { everyRow: RemoveBy };

/** Retire the embed jobs of the file rows a remover took. See the module docblock. */
export async function retireEmbedWorkOfRemovedRows(spaceId: string, rows: RowsRemoved): Promise<void> {
  if ('everyRow' in rows) { await rows.everyRow(spaceCollection(spaceId, 'embedJobs'), { recordType: 'file' }); return; }
  if (rows.ids.length > 0) await retireEmbedJobs(spaceId, 'file', [...new Set(rows.ids)]);
}

/** A failure after a move's commit, said once per space per window: the move is finished either way. */
const requeueFailed = warnOnce<string>({ every: 10 * 60_000 });

/**
 * Queue the embed work of the rows a move carried from `src` to `dst`, and retire the work at their old ids — after the last batch has
 * committed. Never throws (see the module docblock). `unplaced` are the sidecar paths AT THE SOURCE the move finished without: what stands
 * at their destinations is another file's, and is left alone.
 */
export async function requeueEmbedWorkOfMovedRows(
  spaceId: string, move: { src: string; dst: string; kind: PathKind; unplaced?: readonly string[] },
): Promise<void> {
  const { src, dst, kind } = move;
  try {
    const from = movedRoot(src);
    const to = movedRoot(dst);
    if (!from || !to) return;
    const files = spaceCollection(spaceId, 'files');
    const unplacedThere = new Set((move.unplaced ?? []).map(p => movedId(p, from, to)).filter((p): p is string => p !== null));
    const owned = (await sidecarsOwnedBy(spaceId, to, kind)).filter(s => !unplacedThere.has(s.path));
    const { ids } = await rowsOfFiles(spaceId, kind === 'file' ? [to] : await rootsOfDirectory(spaceId, to), owned);
    // A flagged row (a soft delete's audit record) has no embed work: it is neither queued nor counted as moved.
    const rows = [...(await readStoredById<{ _id: string; parentFileId?: string }>(files, [...ids], { parentFileId: 1 }, { filter: NOT_A_FLAGGED_ROW })).values()];
    if (rows.length === 0) return;
    const topLevel = new Set(rows.filter(r => r.parentFileId === undefined).map(r => r._id));
    const oldIdOf = new Map(rows.flatMap((r): Array<[string, string]> => { const old = movedId(r._id, to, from, topLevel); return old === null ? [] : [[r._id, old]]; }));

    const hadJob = await readStoredById<{ _id: string }>(spaceCollection(spaceId, 'embedJobs'),
      [...oldIdOf.values()].map(id => embedJobId('file', id)), { _id: 1 });
    const queue = rows.map(r => r._id).filter(id => topLevel.has(id) || (oldIdOf.has(id) && hadJob.has(embedJobId('file', oldIdOf.get(id)!))));
    await enqueueEmbedJobs(spaceId, 'file', queue, { priority: EMBED_PRIORITY.background });

    // An old id a file holds again (a re-upload at the source since the bytes moved) keeps its job: it is that file's.
    const heldAgain = await readStoredById<{ _id: string }>(files, [...oldIdOf.values()], { _id: 1 }, { filter: NOT_A_FLAGGED_ROW });
    await retireEmbedJobs(spaceId, 'file', [...oldIdOf.values()].filter(id => !heldAgain.has(id)));
  } catch (err) {
    requeueFailed(spaceId, () => log.warn(`embed queue: the move ${peerText(spaceId)}, ${peerText(src)} → ${peerText(dst)} finished, but its files were not `
      + `re-queued for embedding (${peerText(err)}). They keep the vectors of their old paths until the space is reindexed (POST /api/spaces/:id/reindex).`));
  }
}
