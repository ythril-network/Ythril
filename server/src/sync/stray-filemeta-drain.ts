/**
 * Recover the file metadata a 4.0-5.6.1 pull stored in `<space>_filemeta` into `<space>_files`, then drop the stray
 * collection once nothing in it can still be used (`Q-219`).
 *
 * From P-32 (4.0) to 5.6.1 the pull wrote each family to `${spaceId}_${payloadKey}`, and the payload key of file
 * metadata is `filemeta`, not `files`. Nothing reads that collection and the receive watermark has passed its
 * records, so they are never pulled again: a publisher's descriptions and tags never reached the subscriber's files.
 * 5.6.2 pulls into the right collection; this recovers what the old one left.
 *
 * - **Through the arrival writer with `fillOnly`**, never a copy loop: it keeps the shape refusal, the chunk refusal
 *   and the local-only drop, and hands each record to `fillFileMetaFromStray`, which fills a row this instance made by
 *   default and gives a peer-written row the normal seq accept — at the write, creating nothing. 5.6.2's drain used
 *   the seq-accepted merge, and a pre-5.6.0 receiver had stamped its own seq on those very rows, so it counted almost
 *   every stray description as "older than the stored copy" and dropped it.
 * - **Bounded, and resumed by deletion.** At most `maxPages` pages per space per cycle. Each record the writer
 *   answered is deleted from the stray collection; the collection is dropped only when it is EMPTY, so it is never
 *   dropped with an unread record in it, and the next cycle resumes on its own.
 * - **A record with no file row WAITS**: its bytes may still arrive and create the row (`recordArrivedFile`). It is
 *   discarded only when the file is known to be deleted (a file tombstone holds its path) or after waiting
 *   `WAIT_DAYS`. Waiting records are read after fresh ones, so they never use up a cycle's pages.
 * - **One space at a time, each in its own try.** A failure is logged naming the space and the step, at most every
 *   `REPORT_EVERY_MS` per space, and that space's collection is kept for the next cycle; the others carry on.
 * - **The drop is audited** (`file.stray_filemeta.drain`), after it succeeds, because it cannot be undone.
 * - **Recurring, inside the TTL sweep cycle**, like `files/legacy-spill-sweep.ts`: cheap when there is nothing (one
 *   `listCollections` per space). The source is local state no transport carries, so draining it is not a
 *   migration of synced data.
 *
 * Removed at the next major.
 */
import { concreteSpaces } from '../spaces/proxy.js';
import { getDb, col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { writeArrivals } from './arrivals.js';
import { logInternalAudit } from '../audit/audit.js';
import { STRAY_FILEMETA_DRAIN_OPERATION } from '../audit/middleware.js';
import { log, logSafe } from '../util/log.js';
import { warnOnce } from '../util/warn-once.js';
import { writeTimeoutMs } from '../db/write-bound.js';

/** How long a record whose file has no row waits for the file's bytes before it is discarded. */
const WAIT_DAYS = 30;
/** How often one space's repeating failure is logged. */
const REPORT_EVERY_MS = 10 * 60_000;
/**
 * One page READ; a stuck one must not hold the sweep cycle. The page's writes (the delete, the wait stamp) take the
 * one write bound, `writeTimeoutMs()` (`db/write-bound.ts`), rather than a second literal for the same question.
 */
const STEP_MS = 30_000;

type StrayDoc = { _id: string; keptSince?: string };

/** One report per space per `REPORT_EVERY_MS` (`util/warn-once.ts`). */
const failureReports = warnOnce<string>({ every: REPORT_EVERY_MS });

/** Drain every space's stray file-metadata collection. Returns the spaces whose collection was dropped. */
export async function drainStrayFileMeta({ pageSize = 500, maxPages = 20 }: { pageSize?: number; maxPages?: number } = {}): Promise<string[]> {
  const dropped: string[] = [];
  // Proxy spaces own no collections; `concreteSpaces` is empty before setup.
  for (const space of concreteSpaces()) {
    const step = { name: 'list' };
    try {
      if (await drainSpace(space.id, pageSize, maxPages, step)) dropped.push(space.id);
    } catch (err) {
      failureReports(space.id, () => log.warn(`Stray file-metadata drain (${logSafe(space.id)}, ${step.name}): `
        + `${logSafe(err instanceof Error ? err.message : String(err))}; the collection is kept for the next cycle (Q-219).`));
    }
  }
  return dropped;
}

/** One space: recover up to `maxPages` pages, and drop the collection when it is empty. Returns whether it dropped. */
async function drainSpace(spaceId: string, pageSize: number, maxPages: number, step: { name: string }): Promise<boolean> {
  // The name the 4.0-5.6.1 pull built (`${spaceId}_${payloadKey}`); not a collection this version routes.
  const collName = `${spaceId}_filemeta`;
  if ((await getDb().listCollections({ name: collName }, { nameOnly: true }).toArray()).length === 0) return false;
  const startedAt = Date.now();
  const stray = col<StrayDoc>(collName);
  const n = { merged: 0, complete: 0, newer: 0, waiting: 0, deleted: 0, refused: 0 };

  // Fresh records first; then the ones that were already waiting when this cycle began (not the ones this cycle just
  // set waiting), by id, so a long wait list never uses up the pages and no record is offered twice in one cycle.
  const cycleStart = new Date(startedAt).toISOString();
  let pages = 0;
  for (const waiting of [false, true]) {
    let after: string | undefined;
    while (pages < maxPages) {
      step.name = 'read';
      const filter = {
        keptSince: waiting ? { $lt: cycleStart } : { $exists: false },
        ...(after === undefined ? {} : { _id: { $gt: after } }),
      };
      const page = await stray.find(asFilter<StrayDoc>(filter as never), { maxTimeMS: STEP_MS })
        .sort({ _id: 1 }).limit(pageSize).toArray();
      if (page.length === 0) break;
      pages++;
      after = page[page.length - 1]!._id;
      step.name = 'write';
      const out = await writeArrivals(spaceId, 'files', 'file', page.map(({ keptSince: _k, ...doc }) => doc),
        { from: 'a 4.0-5.6.1 pull (stray filemeta collection)', fillOnly: true });
      n.merged += out.updated.length + out.inserted.length;
      n.complete += out.complete.length;
      n.newer += out.newerLocal.length;
      n.refused += out.refused.length + out.derived.length + out.duplicates.length;
      step.name = 'settle';
      const { discard, wait } = await settleUnstored(spaceId, page, out.unstored);
      n.deleted += discard.length;
      n.waiting += wait.length;
      const unstored = new Set(out.unstored);
      const answered = [...page.map(d => d._id).filter(id => !unstored.has(id)), ...discard];
      if (answered.length > 0) await stray.deleteMany(asFilter<StrayDoc>({ _id: { $in: answered } }), { maxTimeMS: writeTimeoutMs() });
      if (wait.length > 0) {
        await stray.updateMany(asFilter<StrayDoc>({ _id: { $in: wait }, keptSince: { $exists: false } } as never),
          { $set: { keptSince: new Date().toISOString() } }, { maxTimeMS: writeTimeoutMs() });
      }
    }
  }

  step.name = 'drop';
  const empty = (await stray.countDocuments({}, { maxTimeMS: STEP_MS })) === 0;
  if (empty) {
    await getDb().dropCollection(collName);
    logInternalAudit({ method: 'SWEEP', path: 'internal:stray-filemeta-drain', spaceId, operation: STRAY_FILEMETA_DRAIN_OPERATION, startedAt });
  }
  if (n.merged > 0 || n.deleted > 0 || empty) {
    log.info(`Space '${spaceId}': merged ${n.merged} file metadata record(s) a 4.0-5.6.1 pull left in '${collName}' `
      + `(${n.complete} already complete here, ${n.newer} newer here, ${n.deleted} for files deleted since, `
      + `${n.waiting} waiting for their file, ${n.refused} refused)${empty ? ', and dropped the collection' : ''} (Q-219).`);
  }
  return empty;
}

/**
 * Which of a page's records with no file row to discard, and which wait: discarded when a file tombstone holds the
 * path (the file was deleted here or by a peer) or the record has waited `WAIT_DAYS`; otherwise it waits for bytes.
 */
async function settleUnstored(spaceId: string, page: StrayDoc[], unstored: string[]): Promise<{ discard: string[]; wait: string[] }> {
  if (unstored.length === 0) return { discard: [], wait: [] };
  const tombstoned = new Set((await col<{ _id: string; path: string }>(spaceCollection(spaceId, 'fileTombstones'))
    .find(asFilter<{ _id: string; path: string }>({ path: { $in: unstored } }), { projection: { path: 1 }, maxTimeMS: STEP_MS })
    .toArray()).map(t => t.path));
  const since = new Map(page.map(d => [d._id, d.keptSince]));
  const expired = Date.now() - WAIT_DAYS * 86_400_000;
  const discard: string[] = [], wait: string[] = [];
  for (const id of unstored) {
    const kept = since.get(id);
    if (tombstoned.has(id) || (kept !== undefined && Date.parse(kept) < expired)) discard.push(id);
    else wait.push(id);
  }
  return { discard, wait };
}
