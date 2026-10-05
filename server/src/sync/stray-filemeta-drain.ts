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
 * - **Bounded, and resumed by deletion.** At most `maxPages` pages per space per cycle — 4 by default on 5.6.x, which
 *   has no background embed lane, so a cycle's merges queue at most 2,000 embed jobs per space. Each record the writer
 *   answered is deleted from the stray collection; the collection is dropped only when it is EMPTY, so it is never
 *   dropped with an unread record in it, and the next cycle resumes on its own.
 * - **5.6.x: a page whose counter could not be moved is kept whole** (`counterBehind`): none of its records is
 *   deleted, the space stops for this cycle and its collection is kept, so the next cycle offers the page again with
 *   the counter free. A record the STORE refuses (`storeRefused`, which 5.6.x's writer reports instead of throwing)
 *   is answered and counted as refused.
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

/** How long a record whose file has no row waits for the file's bytes before it is discarded. */
const WAIT_DAYS = 30;
/** How often one space's repeating failure is logged. */
const REPORT_EVERY_MS = 10 * 60_000;
/** One page read or delete; a stuck one must not hold the sweep cycle. */
const STEP_MS = 30_000;

type StrayDoc = { _id: string; keptSince?: string };

const lastReported = new Map<string, number>();

/** Drain every space's stray file-metadata collection. Returns the spaces whose collection was dropped. */
export async function drainStrayFileMeta({ pageSize = 500, maxPages = 4 }: { pageSize?: number; maxPages?: number } = {}): Promise<string[]> {
  const dropped: string[] = [];
  // Proxy spaces own no collections; `concreteSpaces` is empty before setup.
  for (const space of concreteSpaces()) {
    const step = { name: 'list' };
    try {
      if (await drainSpace(space.id, pageSize, maxPages, step)) dropped.push(space.id);
    } catch (err) {
      const now = Date.now();
      if (now - (lastReported.get(space.id) ?? 0) >= REPORT_EVERY_MS) {
        lastReported.set(space.id, now);
        log.warn(`Stray file-metadata drain (${logSafe(space.id)}, ${logSafe(step.name)}): `
          + `${logSafe(err instanceof Error ? err.message : String(err))}; the collection is kept for the next cycle (Q-219).`);
      }
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
  let held = false;
  for (const waiting of [false, true]) {
    let after: string | undefined;
    while (pages < maxPages && !held) {
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
      n.newer += out.newerLocal.length + out.diverged.length;
      n.refused += out.refused.length + out.storeRefused.length + out.derived.length + out.duplicates.length;
      if (out.counterBehind) {
        // The writer stored what it could, but the counter may be behind it: keep the page, so nothing is answered
        // until a cycle with a working counter offers it again (the writer already logged the bump's failure).
        held = true;
        log.warn(`Stray file-metadata drain (${logSafe(spaceId)}, counter): the seq counter could not be moved past a `
          + 'page of recovered records; the page and the collection are kept for the next cycle (Q-219).');
        break;
      }
      step.name = 'settle';
      const { discard, wait } = await settleUnstored(spaceId, page, out.unstored);
      n.deleted += discard.length;
      n.waiting += wait.length;
      const unstored = new Set(out.unstored);
      const answered = [...page.map(d => d._id).filter(id => !unstored.has(id)), ...discard];
      if (answered.length > 0) await stray.deleteMany(asFilter<StrayDoc>({ _id: { $in: answered } }), { maxTimeMS: STEP_MS });
      if (wait.length > 0) {
        await stray.updateMany(asFilter<StrayDoc>({ _id: { $in: wait }, keptSince: { $exists: false } } as never),
          { $set: { keptSince: new Date().toISOString() } }, { maxTimeMS: STEP_MS });
      }
    }
  }

  step.name = 'drop';
  const empty = !held && (await stray.countDocuments({}, { maxTimeMS: STEP_MS })) === 0;
  if (empty) {
    await getDb().dropCollection(collName);
    logInternalAudit({ method: 'SWEEP', path: 'internal:stray-filemeta-drain', spaceId, operation: STRAY_FILEMETA_DRAIN_OPERATION, startedAt });
  }
  if (n.merged > 0 || n.deleted > 0 || empty) {
    log.info(`Space '${spaceId}': merged ${logSafe(n.merged)} file metadata record(s) a 4.0-5.6.1 pull left in '${collName}' `
      + `(${logSafe(n.complete)} already complete here, ${logSafe(n.newer)} newer here, ${logSafe(n.deleted)} for files deleted since, `
      + `${logSafe(n.waiting)} waiting for their file, ${logSafe(n.refused)} refused)${empty ? ', and dropped the collection' : ''} (Q-219).`);
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
