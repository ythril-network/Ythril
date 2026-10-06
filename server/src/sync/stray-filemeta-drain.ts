/**
 * Recover the file metadata a 4.0-5.6.1 pull stored in `<space>_filemeta` into `<space>_files`, then drop the stray
 * collection once nothing in it can still be used (`Q-219`).
 *
 * From P-32 (4.0) to 5.6.1 the pull wrote each family to `${spaceId}_${payloadKey}`, and the payload key of file
 * metadata is `filemeta`, not `files`. Nothing reads that collection and the receive watermark has passed its
 * records, so they are never pulled again: a publisher's descriptions and tags never reached the subscriber's files.
 * 5.6.2 pulls into the right collection; this recovers what the old one left.
 *
 * - **Through the one validation step and the arrival writer with `fillOnly`**, never a copy loop: each record's wire
 *   keys pass `IncomingFileMetaDoc` as a FILL (`admitArrivals(…, { fill: true })`, `Q-225` — a `parentFileId` of any
 *   type, a field of the wrong type is refused, never filled; a key the record LACKS is not required, because the
 *   fill writes only what it carries, and a record without `tags` or `author` was otherwise lost); the writer keeps the shape refusal, the chunk refusal and the local-only drop,
 *   and hands each record to `fillFileMetaFromStray`, which fills a row this instance made by default and gives a
 *   peer-written row the normal seq accept — at the write, creating nothing. One write PER RECORD, deliberately,
 *   where every other file arrival is a page of one bulk write (`Q-107` part 2): each row's own outcome (filled,
 *   complete, newer, no file) is what the drain's summary line reports and what decides whether a record waits.
 *   5.6.2's drain used the seq-accepted merge, and a pre-5.6.0 receiver had stamped its own seq on those very rows, so it counted almost
 *   every stray description as "older than the stored copy" and dropped it.
 * - **Bounded, and resumed by deletion.** At most `maxPages` pages per space per cycle. Each record the writer
 *   answered is deleted from the stray collection; the collection is dropped only when it is EMPTY, so it is never
 *   dropped with an unread record in it, and the next cycle resumes on its own.
 * - **A record with no file row WAITS**: its bytes may still arrive and create the row (`recordArrivedFile`). It is
 *   discarded only when the file is known to be deleted (a file tombstone holds its path) or after waiting
 *   `WAIT_DAYS`. Waiting records are read after fresh ones, so they never use up a cycle's pages.
 * - **One space's trouble is that space's** (`Q-274`, `Q-358`). The spaces are walked through `walkSpaces`
 *   (`util/housekeeping-walk.ts`): a space's drain runs inside the housekeeping bound, so a database operation that hangs
 *   ends at its figure (the `Db`-level listing and drop included), and a failure — or a bound that fired — is reported once
 *   per window by the shared reporter, naming the space and the SUB-STEP it was in (list, read, write, settle, drop). That
 *   space's collection is kept and retried next cycle; the others carry on. No throttle of this file's own.
 * - **The drop is audited** (`file.stray_filemeta.drain`), after it succeeds, because it cannot be undone.
 * - **Recurring, inside the TTL sweep cycle**, like `files/legacy-spill-sweep.ts`: cheap when there is nothing (one
 *   `listCollections` per space). The source is local state no transport carries, so draining it is not a
 *   migration of synced data.
 *
 * Removed at the next major.
 */
import { concreteSpaces } from '../spaces/proxy.js';
import { getDb, col, asFilter } from '../db/mongo.js';
import { tombstonedFilePaths } from '../files/tombstones.js';
import { writeArrivals, warnArrivalsNotStored } from './arrivals.js';
import { admitArrivals } from './arrival-shape.js';
import { fileMetaForWire } from '../api/sync/_shared.js';
import { logInternalAudit } from '../audit/audit.js';
import { STRAY_FILEMETA_DRAIN_OPERATION } from '../audit/middleware.js';
import { log } from '../util/log.js';
import { walkSpaces, type WalkContext } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';

/** How long a record whose file has no row waits for the file's bytes before it is discarded. */
const WAIT_DAYS = 30;
/*
 * A stuck read or write must not hold the sweep cycle, and it does not: the drain walks the spaces through `walkSpaces`
 * (`util/housekeeping-walk.ts`), which runs each space's callback inside the housekeeping bound
 * (`withinHousekeepingBound`, `db/write-bound.ts`). Every database operation the callback issues ends at that figure — the
 * reads, the writes, and the two calls on the `Db` itself (`listCollections`, `dropCollection`, which go through the same
 * door), the drop included — rather than a literal per call restating how long that is. A step of its own is not wrapped
 * again: a scope inside a scope only tightens (a hold's deadline of its own would cut a long page the walk lets run).
 * Each record's own fill is bounded the same way, by being inside it (`fillFileMetaFromStray`).
 */

type StrayDoc = { _id: string; keptSince?: string };

/** Who the drain's records came from, for the log lines. */
const FROM = 'a 4.0-5.6.1 pull (stray filemeta collection)';

/** The name a failure of this drain is reported, counted and quarantined under. */
const STEP = declareStep('Stray file-metadata drain');
/**
 * The sub-steps of one space's drain, in order. A failure is reported under the one it happened in, so the line says which
 * half of the work to look at; each is declared here, once, so its counter series starts at 0 like the step's.
 */
const SUB = {
  list: declareStep(`${STEP} (list)`),
  read: declareStep(`${STEP} (read)`),
  write: declareStep(`${STEP} (write)`),
  settle: declareStep(`${STEP} (settle)`),
  drop: declareStep(`${STEP} (drop)`),
} as const;

/** Drain every space's stray file-metadata collection. Returns the spaces whose collection was dropped. */
export async function drainStrayFileMeta({ pageSize = 500, maxPages = 20 }: { pageSize?: number; maxPages?: number } = {}): Promise<string[]> {
  // Proxy spaces own no collections; `concreteSpaces` is empty before setup. A space whose drain throws is reported once, by
  // name and sub-step, with its collection kept for the next cycle; the walk goes on to the next.
  const walk = await walkSpaces(STEP, concreteSpaces(), (space, ctx) => drainSpace(space.id, pageSize, maxPages, ctx));
  return walk.outcomes.filter(o => o.value === true).map(o => o.spaceId);
}

/** One space: recover up to `maxPages` pages, and drop the collection when it is empty. Returns whether it dropped. */
async function drainSpace(spaceId: string, pageSize: number, maxPages: number, ctx: WalkContext): Promise<boolean> {
  // The name the 4.0-5.6.1 pull built (`${spaceId}_${payloadKey}`); not a collection this version routes.
  const collName = `${spaceId}_filemeta`;
  ctx.step = SUB.list;
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
      ctx.step = SUB.read;
      const filter = {
        keptSince: waiting ? { $lt: cycleStart } : { $exists: false },
        ...(after === undefined ? {} : { _id: { $gt: after } }),
      };
      const page = await stray.find(asFilter<StrayDoc>(filter as never)).sort({ _id: 1 }).limit(pageSize).toArray();
      if (page.length === 0) break;
      pages++;
      after = page[page.length - 1]!._id;
      ctx.step = SUB.write;
      // The one validation step every arrival passes (`Q-225`), over the record's WIRE keys: an old pull stored the
      // peer's row whole, and what it held besides the wire keys was never the publisher's to give. A record its
      // schema refuses — a `parentFileId` of any type, a field of the wrong type — is answered, and never filled. As a
      // FILL: the keys present are checked and none is required, since the fill writes nothing a record lacks.
      const { admitted, refused } = admitArrivals('filemeta', page.map(({ keptSince: _k, ...doc }) => fileMetaForWire(doc)), { fill: true });
      warnArrivalsNotStored(FROM, spaceId, 'filemeta', 'refused', refused);
      const out = await writeArrivals(spaceId, 'files', 'file', admitted.map(a => a.doc), { from: FROM, fillOnly: true });
      n.merged += out.updated.length + out.inserted.length;
      n.complete += out.complete.length;
      n.newer += out.newerLocal.length;
      n.refused += refused.length + out.refused.length + out.derived.length + out.duplicates.length;
      ctx.step = SUB.settle;
      const settled = await settleUnstored(spaceId, page, out.unstored);
      const unstored = new Set(out.unstored);
      const answered = [...page.map(d => d._id).filter(id => !unstored.has(id)), ...settled.discard];
      if (answered.length > 0) await stray.deleteMany(asFilter<StrayDoc>({ _id: { $in: answered } }));
      if (settled.wait.length > 0) {
        await stray.updateMany(asFilter<StrayDoc>({ _id: { $in: settled.wait }, keptSince: { $exists: false } } as never),
          { $set: { keptSince: new Date().toISOString() } });
      }
      n.deleted += settled.discard.length;
      n.waiting += settled.wait.length;
    }
  }

  ctx.step = SUB.drop;
  const empty = (await stray.countDocuments({})) === 0;
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
 * Read inside the walk's bound (`withinHousekeepingBound`).
 */
async function settleUnstored(spaceId: string, page: StrayDoc[], unstored: string[]): Promise<{ discard: string[]; wait: string[] }> {
  if (unstored.length === 0) return { discard: [], wait: [] };
  // Published tombstones only: a pending one names an act that may not happen (bundle-30 I15, `files/tombstones.ts`).
  const tombstoned = await tombstonedFilePaths(spaceId, unstored);
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
