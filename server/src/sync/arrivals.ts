/**
 * THE ONE WRITER of a record produced elsewhere — a peer's push, a peer's pulled page, an admin restore
 * (`Q-107` part 1). `writeArrivals` replaced `ingestBrainDoc` (push, import), the pull's own page write, the inline
 * `$setOnInsert` of `POST /api/sync/entities`, and (`Q-107` part 2) the per-document file-metadata merge
 * `ingestFileMeta`.
 *
 * ## Why one writer, and why it owns every precondition
 *
 * Six doors stored arriving documents, each its own way and each holding a different subset of the rules: the
 * push kept the sender's space id while the pull retagged it; the pull queued no embedding at all; a single
 * pushed entity was stored and never queued; nothing stamped the receiver's retention; and every door's
 * whole-document replace erased the receiver's own vector and retention stamps. The door that skips a guard is
 * always the weaker one, so a guard that lives at a door is a guard some door does not have. Every one of them
 * is here, and a door cannot store a record without passing through all of them:
 *
 *  1. **Shape, per document** (`arrivalRefusal`): a string `_id`, a seq that is a non-negative integer the
 *     counter can carry (absent only for file metadata older than seqs). A refusal is that document's, never
 *     the page's — a poison document must not hold back everything sent with it.
 *  2. **Retag** to the local space, unconditionally: under a `spaceMap` alias the sender's id names another
 *     space, and every `spaceId`-filtered read on this instance would miss the record.
 *  3. **Collapse** a repeated `_id` to its highest seq (equal: the EARLIER, as the page planner reads a page —
 *     `isNewerCopy` is strict). An unordered bulk write lets the LAST
 *     op for an id win whatever its seq, so a page carrying `[9, 3]` stored 3.
 *  4. **What crosses the replace, per document** (`carriedFields`): the receiver's local-only fields are dropped
 *     from what arrived, and the stored copy's are carried across the replace server-side, in the same update — so
 *     a peer's edit does not erase this instance's vector, its retention stamps or its file sync bases. Except:
 *     an arrival this instance SUPPRESSES (`record > schema > space`, this instance's tiers) carries the record
 *     tier only, never the vector, its model or `matchedText`, which describe content it no longer embeds
 *     (`Q-230`); and a RESTORE carries nothing from the copy it replaces — the backup's own record-tier fields come
 *     with the document (`RESTORED_LOCAL_FIELDS`), and what the backup does not carry is absent (`Q-234`).
 *  5. **D-9, the receiver's retention** (owner decision, 2026-10-01): a record that carries no receiver stamp is
 *     stamped from its OWN `createdAt` by this instance's `schema > space` windows — never from now, never the
 *     sender's. A stamp already on the stored copy is carried by a peer's arrival, never recomputed. An arrival
 *     older than the window is therefore stamped in the past, and the sweep deletes it through the normal path.
 *  6. **The write guard** (`seqGuard`): `{ _id, seq < s or absent }`, on the insert half as well — a copy newer
 *     than the one planned, written meanwhile, fails the op with a duplicate `_id` and is kept. File metadata too,
 *     since `Q-107` part 2: it is MERGED (`fileMetaUpdate`, `$set` of the authored keys) rather than replaced, but
 *     under the same guard and in the same bulk write; `ingestFileMeta` filtered on `_id` alone. A RESTORE replaces,
 *     unguarded. The stray-filemeta drain's recovery (`fillOnly`, `fillFileMetaFromStray`) carries every condition
 *     in its own write's filter instead, creating nothing.
 *  7. **Failures by operation**: a duplicate is read back — a newer stored copy is "skipped"; one at the SAME seq
 *     is this very version, landed, unless its content differs (`divergesFrom`), which is a divergence the page
 *     accept forks (`Q-232`: a racing push's same-seq copy used to count itself landed while its text was stored
 *     nowhere); anything else is a unique-index duplicate (an edge triplet, a link's endpoints). Any other
 *     per-operation failure is retried ONCE alone and then refused by id. A failure with no per-operation shape
 *     falls back to one write per document; if that fails for every document, or for a reason the store owns
 *     (network, step-down), it THROWS — the push answers 500 (503 when the store is the cause) so the sender keeps
 *     its watermark, the pull holds `deliveredThrough`. **A write a bound ended is ambiguous, never a document's
 *     refusal** (`isWriteTimeout`): nothing says which documents landed, so the page fails whole without the
 *     per-document fallback, which would only spend the hold's time on the same stall. **A driver argument error
 *     raised on one document's own write** is that document's refusal (`isArgumentErrorOfOneWrite`) — unless it is
 *     the bound's (a defect of ours), or every document of the chunk raised it (the call's, not theirs).
 *  8. **The counter, then the queue**, in a `finally` per chunk: the counter over what the chunk received
 *     (awaited, `advanceCounterPast`), and only then the batched embed enqueue of what landed, by the RECEIVER's
 *     suppression. The bump is the only thing that makes an arrival visible to a seq-paged reader; nothing here
 *     notes a seq on its own, so a local write can never take a seq below an arrival a reader was already
 *     handed. **Each step runs whatever the one before it did** (`Q-224`): a counter that cannot move is logged
 *     and stops the page after the chunk's records are booked and queued; the write's own error, and its
 *     `partial`, always win; and a counter left behind with nothing else wrong throws `CounterBehindError`, which
 *     carries `partial` too.
 *
 * ## The record type is an explicit argument
 *
 * `null` means this family has nothing to embed (a link is a pair of ids) — said at the call, where a reviewer
 * sees it, rather than by a second writer for links.
 *
 * ## What it does not decide
 *
 * WHICH documents of a page land — tombstones, forks, the fork caps, the seq accept — is the page planner's
 * (`planArrivals`, `sync/upsert-plan.ts`, through `sync/accept-page.ts`), the same for a push and a pull; the
 * writer re-checks "strictly newer than stored" only AT the write, which agrees with every planned verdict. A
 * restore is not planned: it replaces what is stored.
 */
import { col, asBulk } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import {
  bulkWriteFailures, DUPLICATE_KEY, isDocumentRefusal, isDocumentRefusalCode, writeErrorCode, isArgumentErrorOfOneWrite,
} from '../db/write-errors.js';
import { isSeqImplausible } from '../util/seq.js';
import { advanceCounterPast, CounterBehindError } from './counter-after-page.js';
import { PageStoppedError } from './page-stopped.js';
import { isWriteTimeout } from '../db/write-timeout.js';
import { inOneCommandChunks, operationBytes } from '../db/one-command.js';
import { log, logSafe, peerList, peerText } from '../util/log.js';
import { BRAIN_COLLECTIONS } from '../config/types.js';
import type { BrainCollection, BrainEmbedRecordType } from '../config/types.js';
import { RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS, carriedFields } from './local-only-fields.js';
import { retagToLocalSpace, isNewerCopy, seqGuard, divergesFrom } from './upsert-plan.js';
import { enqueueIngestedRecords } from '../brain/embed-queue.js';
import type { RetentionSpace } from '../brain/chrono-retention.js';
import { retentionSpace, retentionStamps } from '../brain/ttl.js';
import { isDerived } from '../brain/embed-record.js';
import { embeddingSuppressedFor } from '../brain/suppress-embeddings.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { fileMetaForWire } from '../api/sync/_shared.js';
import { fillFileMetaFromStray } from './fill-file-meta.js';
import { fileMetaUpdate, embedArrivedFiles } from './file-meta-write.js';
import { isLegacyReadSpill } from './file-conflict.js';

type Doc = Record<string, unknown> & { _id: string; seq?: number };

export interface ArrivalOptions {
  /**
   * An admin RESTORE (`POST /api/admin/spaces/:id/import`): what is stored is replaced whatever its seq (a restore
   * over newer data is what the operator asked for), the export's record-tier local fields are kept and the replaced
   * copy's never are, and a restored file is queued for embedding whether or not its blob is here. Never set for a
   * peer.
   */
  restore?: boolean;
  /** Queue the embeddings later, through the returned `enqueue` — for a fork written inside a seq hold. */
  deferEnqueue?: boolean;
  /** Who sent it, for the log lines only. */
  from?: string;
  /**
   * The stray-filemeta drain (`Q-219`) only: each file record is RECOVERED onto its row by `fillFileMetaFromStray`
   * rather than merged — a row this instance made by default is filled, a peer-written row keeps the seq accept AT
   * THE WRITE, and no row is created. So the retention stamping is skipped: it belongs to a record being created.
   * It changes how a files record is written, never whether one is admitted (shape and chunk refusal still run).
   */
  fillOnly?: boolean;
}

/** One document refused, by id and in words a log reader and an integrator can act on. */
export interface ArrivalRefusal {
  readonly _id: string;
  readonly reason: string;
}

/** What became of each document handed to the writer, by id. */
export interface ArrivalOutcome {
  /** Landed, with no stored copy before. */
  inserted: string[];
  /** Landed over a stored copy. */
  updated: string[];
  /** Not written: the stored copy is above this seq (the write guard's read-back). */
  newerLocal: string[];
  /**
   * Not written: a copy at the SAME seq with different content was stored meanwhile — a divergence, which the page
   * accept forks (`Q-232`). Never `landed`: this copy's text is in no record.
   */
  diverged: string[];
  /** Not written: a unique index other than `_id` holds this record under another id. */
  duplicates: string[];
  /** Refused, per document: a malformed id or seq, or a store refusal that repeated. */
  refused: ArrivalRefusal[];
  /** Not written by rule: a file chunk or face record (derived from the blob here), or a legacy read spill. */
  derived: string[];
  /** Ids that arrived more than once; one version (the highest seq) was kept. */
  collapsed: string[];
  /** `fillOnly`: the row this instance made already had everything the record could give it. */
  complete: string[];
  /** `fillOnly`: no file row for it, so nothing was written — never created, because a stray record is old. */
  unstored: string[];
  /** The highest plausible seq received — what the counter has been bumped to at least. */
  maxReceived: number;
  /** Queue the landed records' embeddings, when `deferEnqueue` held it back; a no-op otherwise. */
  enqueue: () => Promise<void>;
}

/** A record write the store could not do for reasons that are not one document's — transient, retry the page. */
export class ArrivalWriteError extends PageStoppedError {
  constructor(spaceId: string, readonly family: string, underlying: unknown) {
    super(`record write failed for ${family} in space '${spaceId}'`, spaceId, underlying);
    this.name = 'ArrivalWriteError';
  }
}

/**
 * Why a document cannot be stored as it arrived, or `null` when it can. The writer's shape rule: the page
 * accept asks it after the wire schema (`sync/arrival-shape.ts`), so a refused document is counted, not planned,
 * and the writer asks it again, so a caller that forgot to is still covered.
 */
export function arrivalRefusal(doc: unknown, { seqOptional }: { seqOptional: boolean }): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not a document';
  const { _id: id, seq } = doc as { _id?: unknown; seq?: unknown };
  if (typeof id !== 'string' || id.length === 0) return '_id is not a non-empty string';
  return seqRefusal(seq, { optional: seqOptional });
}

/**
 * Why a received seq cannot be carried by this instance's counter, or `null` when it can: a non-negative integer
 * below the protocol's ingest ceiling (`isSeqImplausible`). The seq half of `arrivalRefusal`, exposed for what
 * arrives with a seq and is not a record — a tombstone — so its check is this one and not a second spelling.
 */
export function seqRefusal(seq: unknown, { optional }: { optional: boolean }): string | null {
  if (seq === undefined && optional) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    // Bounded where the reason is BUILT (`Q-270`): it travels to a log line and back in an answer.
    return `seq ${peerText(typeof seq === 'string' ? JSON.stringify(seq) : seq)} is not a non-negative integer`;
  }
  if (isSeqImplausible(seq)) return `seq ${seq} is too close to the protocol ceiling and was refused`;
  return null;
}

/** An id for a log line or a refusal, whatever arrived in its place. */
export function arrivalId(doc: unknown): string {
  const id = (doc as { _id?: unknown } | null)?._id;
  return typeof id === 'string' && id.length > 0 ? id : `(${id === undefined ? 'no' : typeof id} _id)`;
}

/**
 * One warning per page for what a door did not store, naming the first ids — the shape every door logs, so a
 * refusal reads the same from a push, a pull and a restore. Never a line per document: a poison page would
 * flood the log ring with one fact.
 */
/** How many ids a refusal summary names before it says how many more — the log line's and the import response's. */
export const NAMED_IN_SUMMARY = 10;

export function warnArrivalsNotStored(
  where: string, spaceId: string, family: string, what: string, items: ReadonlyArray<string | ArrivalRefusal>,
): void {
  if (items.length === 0) return;
  // Every id, every reason and the caller's `where` (it names the peer) may carry what a peer sent: each item is
  // rendered by `peerList`, which names the first `NAMED_IN_SUMMARY` and says how many more — never a slice before
  // it and a hand-written tail after it, which bounded the count twice and the text not at all (bundle-30 I6, C15).
  const named = items.map(i => (typeof i === 'string' ? i : `${i._id} (${i.reason})`));
  log.warn(`${logSafe(where)}: ${items.length} ${peerText(family)} record(s) ${peerText(what)} in space '${peerText(spaceId)}': `
    + peerList(named, ', ', { count: NAMED_IN_SUMMARY }));
}

/** A copy of what arrived with what never crosses removed, and a restore's stamps turned back into Dates. */
function prepared(raw: Doc, family: BrainCollection, restore: boolean): Doc {
  let doc: Doc = { ...raw };
  for (const f of DERIVED_LOCAL_FIELDS) delete doc[f];
  for (const f of RESTORED_LOCAL_FIELDS) {
    if (!restore) { delete doc[f]; continue; }
    // JSON turned a stamp into text; stored as text it never compares with a Date and the sweep never fires.
    const v = doc[f];
    if (typeof v === 'string') {
      const at = new Date(v);
      if (Number.isNaN(at.getTime())) delete doc[f]; else doc[f] = at;
    }
  }
  if (family === 'files') {
    // File metadata travels as its wire keys only: sizes, hashes and excerpts describe bytes this instance has.
    const kept = Object.fromEntries([...RESTORED_LOCAL_FIELDS].filter(f => doc[f] !== undefined).map(f => [f, doc[f]]));
    doc = { ...fileMetaForWire(doc), ...kept } as Doc;
  }
  return doc;
}

/** D-9: the stamps this instance's policy gives a record created at `createdAt`, absent where it gives none. */
function receiverStamps(doc: Doc, recordType: BrainEmbedRecordType, space: RetentionSpace | undefined): Doc {
  // This instance's whole `schema > space` policy (the backfill passes a schema-only one to the same step).
  return (space ? retentionStamps(space, recordType, doc) : {}) as Doc;
}


/**
 * The replace, as an update pipeline so the carried fields cross IN THE SAME WRITE: the stored values of `carried`
 * (a missing one is simply absent), over the D-9 defaults, under what arrived — every peer value inside `$literal`.
 * Read-free, and race-free against an embed worker writing a vector between a read and this write.
 */
function replacementFor(doc: Doc, defaults: Doc, carried: ReadonlySet<string>): unknown[] {
  const kept = Object.fromEntries([...carried].map(f => [f, `$${f}`]));
  return [{ $replaceWith: { $mergeObjects: [{ $literal: defaults }, kept, { $literal: doc }] } }];
}

const storeRefusal = (err: unknown): string =>
  `the store refused it (${writeErrorCode(err) !== undefined ? `error code ${writeErrorCode(err)}` : 'no error code'})`;
/**
 * How much of a driver's error an argument refusal quotes: enough to act on, never a page of it. Through `peerText`,
 * because the driver's message can carry the peer's value: escaped, cut on a code point, and saying it was cut.
 */
const ARGUMENT_QUOTED = 200;
const argumentRefusal = (err: unknown): string =>
  `the database driver refused it as an invalid argument (${peerText(err, { max: ARGUMENT_QUOTED })})`;

/** The ids a bulk write reports as UPSERTED (inserted), from its result or its error's partial result. */
function upsertedIdsOf(r: unknown): unknown[] {
  const ids = (r as { upsertedIds?: Record<number, unknown> } | null)?.upsertedIds
    ?? (r as { result?: { upsertedIds?: Record<number, unknown> } } | null)?.result?.upsertedIds;
  return ids ? Object.values(ids) : [];
}

/**
 * Store documents that arrived from elsewhere — see the module docblock for every rule this holds.
 *
 * @param family the collection, which for file metadata is `files`
 * @param recordType what the family holds for the embed queue, or `null` for links — explicit at every call
 */
export async function writeArrivals(
  spaceId: string,
  family: BrainCollection,
  recordType: BrainEmbedRecordType | null,
  docs: readonly unknown[],
  opts: ArrivalOptions = {},
): Promise<ArrivalOutcome> {
  if (!(BRAIN_COLLECTIONS as readonly string[]).includes(family)) throw new Error(`writeArrivals: '${family}' is not a record family`);
  const restore = opts.restore === true;
  const where = `${restore ? 'import' : 'sync'} ${family}${opts.from ? ` from ${opts.from}` : ''}`;
  const queued: Doc[] = [];
  const out: ArrivalOutcome = {
    inserted: [], updated: [], newerLocal: [], diverged: [], duplicates: [], refused: [], derived: [], collapsed: [],
    complete: [], unstored: [], maxReceived: 0,
    enqueue: async () => {
      if (recordType === null || queued.length === 0) return;
      const batch = queued.splice(0);
      // A file is queued when its bytes are here (or on a restore) and, when this instance suppresses it, has the
      // vectors of the rows derived from it removed — its own went with its write (`embedArrivedFiles`).
      if (family === 'files') await embedArrivedFiles(spaceId, batch.map(d => d._id), { restore });
      else await enqueueIngestedRecords(spaceId, recordType, batch);
    },
  };

  // ── 1-3: shape, preparation, collapse — keyed in a Map, because an id is a peer's text ─────────────────────
  const page = new Map<string, Doc>();
  for (const raw of docs) {
    const why = arrivalRefusal(raw, { seqOptional: family === 'files' });
    if (why) { out.refused.push({ _id: arrivalId(raw), reason: why }); continue; }
    const doc = raw as Doc;
    // A chunk is derived from the blob here; a legacy read spill (`Q-92`) travels in neither direction.
    if (family === 'files' && (isDerived(doc) || isLegacyReadSpill(doc._id))) { out.derived.push(doc._id); continue; }
    const seq = doc.seq ?? 0;
    if (seq > out.maxReceived) out.maxReceived = seq;
    const prev = page.get(doc._id);
    if (prev) {
      // The one accept rule: a later copy replaces an earlier one only when it is NEWER — at an equal seq the
      // earlier copy stands, as the page planner reads a page.
      out.collapsed.push(doc._id);
      if (!isNewerCopy(doc.seq, prev.seq)) continue;
    }
    page.set(doc._id, prepared(doc, family, restore));
  }
  const toWrite = [...page.values()];
  retagToLocalSpace(toWrite, spaceId);

  // ── per document: the D-9 defaults and the receiver's suppression, the space's policy read once ─────────────
  const collName = spaceCollection(spaceId, family);
  // A recovery decides per row at the write (`fillFileMetaFromStray`), and creates nothing, so it stamps nothing.
  const fillOnly = opts.fillOnly === true && family === 'files';
  const space = recordType === null || fillOnly ? undefined : retentionSpace(spaceId);
  const meta = recordType === null || fillOnly ? undefined : getSpaceMeta(spaceId);
  const defaults = new Map(toWrite.map(d =>
    [d._id, recordType === null || fillOnly ? {} as Doc : receiverStamps(d, recordType, space)]));
  const suppressed = new Set(recordType === null || fillOnly ? []
    : toWrite.filter(d => embeddingSuppressedFor(spaceId, recordType, d, meta)).map(d => d._id));
  const filterOf = (d: Doc): Record<string, unknown> => (restore ? { _id: d._id } : seqGuard(d._id, d.seq));
  const updateOf = (d: Doc): unknown => {
    const quiet = suppressed.has(d._id);
    const stamps = defaults.get(d._id) ?? ({} as Doc);
    return family === 'files'
      ? fileMetaUpdate(d, { defaults: stamps, restore, suppressed: quiet })
      : replacementFor(d, stamps, carriedFields({ restore, suppressed: quiet }));
  };
  // Built ONCE per document: the update is a copy of the document, read for its size when the page is sliced and again to
  // write it (and once more for a document written on its own after a bulk failure). An id is unique in `toWrite`.
  const updates = new Map<string, unknown>();
  const updateFor = (d: Doc): unknown => {
    if (!updates.has(d._id)) updates.set(d._id, updateOf(d));
    return updates.get(d._id);
  };

  // ── the write, a chunk at a time ──────────────────────────────────────────────────────────────────────────
  const coll = col<Doc>(collName);
  /** The page cannot be written: say so, carrying the outcome so far (the chunk's `finally` completes it). */
  const stopped = (err: unknown): ArrivalWriteError => {
    const e = new ArrivalWriteError(spaceId, family, err);
    e.partial = out;
    return e;
  };
  let bumped = 0;
  /** A counter that could not be moved past what was received: the page is not finished (`Q-224`). */
  let behind: CounterBehindError | null = null;
  /** Never throws: a failure is logged by the helper and kept, so the steps after it still run. */
  const bump = async (top: number): Promise<void> => {
    if (top <= bumped || behind) return;
    behind = await advanceCounterPast(spaceId, top, where);
    if (!behind) bumped = top;
  };
  // A chunk is ONE wire command (`db/one-command.ts`): a bulk write the driver splits is several commands with a deadline
  // of their own each, and the write bound ends a call by the first one's. By bytes as well as by count, because a page
  // is a peer's and 500 documents of 32 KiB already pass the driver's 16 MiB batch limit.
  const chunks = inOneCommandChunks(toWrite, {
    maxItems: READ_CHUNK,
    bytesOf: (d) => (fillOnly ? 0 : operationBytes({ filter: filterOf(d), update: updateFor(d) })),
  });
  for (const chunk of chunks) {
    const landed: Doc[] = [];
    const dupes: Doc[] = [];
    const inserted = new Set<string>();
    /**
     * One document's failed write, classified: a duplicate is an outcome the read-back below decides (including
     * "this very version already landed", which is what a document of a bulk write that failed ambiguously after
     * applying says); a refusal of the document itself refuses it; anything else — a view, a dropped socket, a
     * step-down — is not the document's, and fails the page so it is offered again.
     */
    const classify = (d: Doc, err: unknown): void => {
      if (writeErrorCode(err) === DUPLICATE_KEY) dupes.push(d);
      else if (isDocumentRefusal(err)) out.refused.push({ _id: d._id, reason: storeRefusal(err) });
      else throw stopped(err);
    };
    /**
     * One write per document, for an ambiguous bulk failure and the retry of a refused one. An argument error the
     * driver raises on one document's own write refuses that document — unless every document here raised it, which
     * makes it the CALL's (the options all of them share), and the page fails so the defect is seen.
     */
    const oneByOne = async (docsHere: readonly Doc[], write: (d: Doc) => Promise<boolean>): Promise<void> => {
      const argued: Array<{ d: Doc; err: unknown }> = [];
      for (const d of docsHere) {
        try {
          if (await write(d)) landed.push(d); else out.derived.push(d._id);
        } catch (err) {
          if (isArgumentErrorOfOneWrite(err)) argued.push({ d, err }); else classify(d, err);
        }
      }
      if (argued.length > 1 && argued.length === docsHere.length) throw stopped(argued[0]!.err);
      for (const { d, err } of argued) out.refused.push({ _id: d._id, reason: argumentRefusal(err) });
    };
    const writeOne = async (d: Doc): Promise<boolean> => {
      const r = await coll.updateOne(filterOf(d), updateFor(d) as never, { upsert: true });
      if (r.upsertedCount > 0) inserted.add(d._id);
      return true;
    };
    try {
      if (fillOnly) {
        for (const d of chunk) {
          try {
            const r = await fillFileMetaFromStray(spaceId, d);
            if (r === 'merged') out.updated.push(d._id);
            else if (r === 'complete') out.complete.push(d._id);
            else if (r === 'newer') out.newerLocal.push(d._id);
            else out.unstored.push(d._id);
          } catch (err) {
            classify(d, err);
          }
        }
      } else {
        try {
          const r = await coll.bulkWrite(asBulk<Doc>(chunk.map(d => ({
            updateOne: { filter: filterOf(d), update: updateFor(d), upsert: true },
          }))), { ordered: false });
          for (const id of upsertedIdsOf(r)) inserted.add(String(id));
          landed.push(...chunk);
        } catch (err) {
          // A bound ended the write: nothing says which documents landed, and asking each one again would only
          // spend the hold's time on more of the same stall. The page fails whole, to be offered again.
          if (isWriteTimeout(err)) throw stopped(err);
          for (const id of upsertedIdsOf(err)) inserted.add(String(id));
          const failures = bulkWriteFailures(err);
          if (!failures || failures.some(f => chunk[f.index] === undefined)) {
            // No per-operation shape: nothing says which documents landed, so ask each one.
            await oneByOne(chunk, writeOne);
          } else {
            const failedAt = new Map(failures.map(f => [f.index, f.code]));
            chunk.forEach((d, k) => { if (!failedAt.has(k)) landed.push(d); });
            const retry: Doc[] = [];
            for (const [k, code] of failedAt) {
              const d = chunk[k]!;
              if (code === DUPLICATE_KEY) dupes.push(d);
              else if (isDocumentRefusalCode(code)) retry.push(d);
              else throw stopped(err);
            }
            // Retried ONCE alone: a document the store refuses refuses again, and is then refused by id.
            await oneByOne(retry, writeOne);
          }
        }
      }
      if (dupes.length > 0) {
        // Read back: a stored copy AT the planned seq is this version, landed — unless its content differs, which is
        // a divergence (`Q-232`); one above it was written meanwhile and is kept ("skipped"); anything else collided
        // on a unique index other than `_id`.
        const now = await readStoredById<Doc>(collName, dupes.map(d => d._id), family === 'facts' ? { seq: 1, fact: 1 } : { seq: 1 });
        for (const d of dupes) {
          const held = now.get(d._id);
          const s = held?.seq;
          const sameSeq = typeof s === 'number' && s === d.seq;
          if (!restore && sameSeq && divergesFrom(d, held)) out.diverged.push(d._id);
          else if (!restore && sameSeq) landed.push(d);
          else if (!restore && typeof s === 'number' && isNewerCopy(s, d.seq)) out.newerLocal.push(d._id);
          else out.duplicates.push(d._id);
        }
      }
    } finally {
      // The chunk is written (or the page stopped): its updates are not read again, and `updateFor` built every one of them
      // up front to size the page — kept to the end, a page would be held twice over (round V, S6).
      for (const d of chunk) updates.delete(d._id);
      // The counter over what this chunk RECEIVED, awaited, and only then the queue — see the module docblock.
      // Each step runs whatever the one before it did (`Q-224`): a bump that threw from here used to skip the
      // bookkeeping and the queue, so records that LANDED were never queued and the write's own error was lost.
      await bump(Math.max(0, ...chunk.map(d => d.seq ?? 0)));
      for (const d of landed) (inserted.has(d._id) ? out.inserted : out.updated).push(d._id);
      queued.push(...landed);
      if (!opts.deferEnqueue) {
        await out.enqueue().catch((err: unknown) => log.warn(`${logSafe(where)}: ${landed.length} landed record(s) in `
          + `space '${peerText(spaceId)}' could not be queued for embedding (${logSafe(err instanceof Error ? err.message : String(err))}); `
          + 'they are stored, and a reindex queues them'));
      }
    }
    // The counter could not be moved past this chunk: the page stops here, what landed is booked and queued.
    if (behind) break;
  }
  // What was received and not written (collapsed, derived) still moves the counter: it is the peer's clock.
  await bump(out.maxReceived);

  warnArrivalsNotStored(where, spaceId, family, 'refused', out.refused);
  // A repeated id is a sender's bug or a page that overlapped itself: one copy was kept, by the accept rule.
  warnArrivalsNotStored(where, spaceId, family, 'sent more than once in one page (the newest copy was kept)',
    [...new Set(out.collapsed)]);
  warnArrivalsNotStored(where, spaceId, family, 'not applied: a uniquely-indexed duplicate of a record held '
    + 'here under another id (the local copy is kept)', out.duplicates);
  // A counter left behind what was received fails the call, carrying what landed: the push answers 500, the pull
  // holds its watermark, the import reports what it restored AND that the counter is behind.
  const counter = behind as CounterBehindError | null;
  if (counter) {
    counter.partial = out;
    throw counter;
  }
  return out;
}
