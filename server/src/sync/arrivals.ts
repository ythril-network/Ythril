/**
 * THE ONE WRITER of a record produced elsewhere — a peer's push, a peer's pulled page, an admin restore. Ported to
 * 5.6.x by `Q-218` from main's `Q-107` part 1 writer, with every main-only behaviour the 5.6.2 plan cuts left out
 * and named where it would have been.
 *
 * `writeArrivals` replaced `ingestBrainDoc` (the four single push routes, `batch-upsert` and the import), the pull's
 * own page write (`batchUpsertBySeq`, moved here from `sync/engine.ts` with the accept it planned), and the inline
 * `$setOnInsert` of `POST /api/sync/entities`.
 *
 * ## Why one writer, and why it owns every precondition
 *
 * Six doors stored arriving documents, each its own way and each holding a different subset of the rules: the push
 * kept the sender's space id while the pull retagged it; the pull queued no embedding at all; a single pushed
 * entity was stored and never queued; every door's whole-document replace erased the receiver's own vector and
 * retention stamps; and a pulled file-metadata page went to a collection nothing reads. The door that skips a guard
 * is always the weaker one, so a guard that lives at a door is a guard some door does not have:
 *
 *  1. **Shape, per document** (`arrivalRefusal`): a string `_id`, and — for a peer's arrival — a seq that is a
 *     non-negative integer the counter can carry (absent only for file metadata older than seqs). A refusal is
 *     that document's, never the page's. A RESTORE checks the id only (cut `C7`: 5.6.1 stored whatever seq a backup
 *     held, and a patch keeps that) — but an implausible restored seq never moves the counter (`F14`).
 *  2. **Retag** to the local space, unconditionally: under a `spaceMap` alias the sender's id names another space.
 *  3. **Collapse** a repeated `_id` to its highest seq (equal: the earlier, `isNewerCopy`). An unordered bulk write
 *     lets the LAST op for an id win whatever its seq, so a page carrying `[9, 3]` stored 3.
 *  4. **What never crosses**: the receiver's local-only fields are dropped from what arrived — and CARRIED from the
 *     stored copy across the replace (`LOCAL_ONLY_FIELDS`), server-side, in the same update, so a peer's edit no
 *     longer erases this instance's vector, its retention stamps or its file sync bases. A RESTORE keeps what the
 *     export carried as the record's own state (`RESTORED_LOCAL_FIELDS`, as Dates) and drops what is derived.
 *  5. **No receiver stamping** (cut `C4`): main stamps an arrival with no stamp of its own from its `createdAt` by
 *     this instance's windows (`D-9`). 5.6.x stores it unstamped, as 5.6.1 did; a stamp the stored copy holds is
 *     carried (rule 4).
 *  6. **The write guard**: `{ _id, seq < s or absent }`, on the insert half as well — a copy newer than the one
 *     planned, written meanwhile, fails the op with a duplicate `_id` and is kept. A RESTORE replaces, unguarded.
 *     File metadata from a peer is merged per document by `ingestFileMeta` (a `$set` on `_id` alone), so only the
 *     accept read guards it.
 *  7. **Failures by operation**: a duplicate is read back — a newer stored copy is "newer here", anything else is a
 *     unique-index duplicate (an edge triplet, a link's endpoints). A per-operation refusal of the document itself
 *     is retried ONCE alone and then reported in `storeRefused` — NOT in `refused` (cut `C3`: main counts a store
 *     refusal as a rejected document and answers 200; on 5.6.x each door answers it as 5.6.1 answered the same
 *     fault, so the writer keeps it apart for the door to decide). A failure with no per-operation shape falls back
 *     to one write per document; a fault that is not one document's THROWS (`ArrivalWriteError`).
 *  8. **The counter, the seq note, the bookkeeping and the queue**, in a `finally` per chunk, EACH in its own `try`
 *     (`E1`, filed against main as `Q-224`): one that fails is logged and the next still runs, and a write error
 *     thrown by the body is never replaced by a bump error. The bump is awaited, over what the chunk RECEIVED; the
 *     enqueue is one bulk write per chunk, by the RECEIVER's suppression.
 *
 * ## The record type is an explicit argument
 *
 * `null` means this family has nothing to embed (a link is a pair of ids) — said at the call, where a reviewer sees
 * it, rather than by a second writer for links.
 *
 * ## What it does not decide
 *
 * WHICH documents of a push land — tombstones, forks, the fork caps — is the push door's (`api/sync/docs.ts`, which
 * on 5.6.x keeps 5.6.1's per-document reading of a page); the writer only re-checks "strictly newer than stored",
 * which is the whole of the pull's accept rule (`planSeqUpserts`) and agrees with every push verdict. Whether a
 * counter that could not be moved fails the answer is the door's too: each door awaits its own bump before it
 * answers.
 */
import { col, asBulk } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import { bulkWriteFailures, DUPLICATE_KEY, isDocumentRefusal, isDocumentRefusalCode, writeErrorCode } from '../db/write-errors.js';
import { bumpSeq, isSeqImplausible, noteSeqStored } from '../util/seq.js';
import { inChunks } from '../util/chunks.js';
import { log, logSafe } from '../util/log.js';
import { BRAIN_COLLECTIONS } from '../config/types.js';
import type { BrainCollection, BrainEmbedRecordType } from '../config/types.js';
import { LOCAL_ONLY_FIELDS, RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS } from './local-only-fields.js';
import { planSeqUpserts, retagToLocalSpace, isNewerCopy } from './upsert-plan.js';
import { enqueueIngestedRecords } from '../brain/embed-queue.js';
import { isDerived } from '../brain/embed-record.js';
import { ingestFileMeta, fileMetaForWire } from '../api/sync/_shared.js';

type Doc = Record<string, unknown> & { _id: string; seq?: number };

export interface ArrivalOptions {
  /**
   * An admin RESTORE (`POST /api/admin/spaces/:id/import`): what is stored is replaced whatever its seq, the
   * export's record-tier local fields are kept, a file row is REPLACED rather than merged and its derived records
   * (chunks, face records) are restored as they were (cut `C6`), and every restored record is queued. Never set
   * for a peer.
   */
  restore?: boolean;
  /** Who sent it, for the log lines only. */
  from?: string;
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
  /** Not written: the stored copy is at or above this seq (the accept, or the write guard). */
  newerLocal: string[];
  /** Not written: a unique index other than `_id` holds this record under another id. */
  duplicates: string[];
  /** Refused for its SHAPE: a malformed id or seq. Never stored, never offered again by an honest sender. */
  refused: ArrivalRefusal[];
  /**
   * Refused by the STORE, twice: a validator, an oversized document. Kept apart from `refused` (cut `C3`): each
   * door answers it as 5.6.1 answered the same fault — a push 500s, a pull holds its position, an import counts
   * an error.
   */
  storeRefused: ArrivalRefusal[];
  /** Not written by rule: a file chunk or face record arriving from a peer (derived here), or a legacy read spill. */
  derived: string[];
  /** Ids that arrived more than once; one version (the highest seq) was kept. */
  collapsed: string[];
  /** The highest plausible seq received — what the counter has been bumped to at least. */
  maxReceived: number;
}

/** A record write the store could not do for reasons that are not one document's — transient, retry the page. */
export class ArrivalWriteError extends Error {
  /**
   * What the writer had already done when it stopped: earlier chunks are committed (and bumped and queued) before a
   * later one fails, so a caller reporting per document must not call them refused. Set by `writeArrivals`.
   */
  partial?: ArrivalOutcome;
  constructor(readonly spaceId: string, readonly family: string, readonly underlying: unknown) {
    super(`record write failed for ${family} in space '${spaceId}': `
      + `${underlying instanceof Error ? underlying.message : String(underlying)}`);
    this.name = 'ArrivalWriteError';
  }
}

/**
 * Why a document cannot be stored as it arrived, or `null` when it can. The one shape rule for every door. A
 * restore asks the id half only (`seq: 'any'`, cut `C7`).
 */
export function arrivalRefusal(doc: unknown, { seq }: { seq: 'required' | 'optional' | 'any' }): string | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not a document';
  const { _id: id, seq: s } = doc as { _id?: unknown; seq?: unknown };
  if (typeof id !== 'string' || id.length === 0) return '_id is not a non-empty string';
  if (seq === 'any') return null;
  return seqRefusal(s, { optional: seq === 'optional' });
}

/**
 * Why a received seq cannot be carried by this instance's counter, or `null` when it can: a non-negative integer
 * below the protocol's ingest ceiling (`isSeqImplausible`). The seq half of `arrivalRefusal`, exposed for what
 * arrives with a seq and is not a record — a tombstone — so its check is this one and not a second spelling.
 */
export function seqRefusal(seq: unknown, { optional }: { optional: boolean }): string | null {
  if (seq === undefined && optional) return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    return `seq ${JSON.stringify(seq) ?? String(seq)} is not a non-negative integer`;
  }
  if (isSeqImplausible(seq)) return `seq ${seq} is too close to the protocol ceiling and was refused`;
  return null;
}

/** An id for a log line or a refusal, whatever arrived in its place. */
export function arrivalId(doc: unknown): string {
  const id = (doc as { _id?: unknown } | null)?._id;
  return typeof id === 'string' && id.length > 0 ? id : `(${id === undefined ? 'no' : typeof id} _id)`;
}

/** How many ids a refusal summary names before it says how many more. */
export const NAMED_IN_SUMMARY = 10;

/**
 * One warning per page for what a door did not store, naming the first ids — the shape every door logs, so a
 * refusal reads the same from a push, a pull and a restore. Never a line per document: a poison page would flood
 * the log ring with one fact. Every id, every reason and the caller's `where` (it names the peer) may carry what a
 * peer sent, so each goes through `logSafe`.
 */
export function warnArrivalsNotStored(
  where: string, spaceId: string, family: string, what: string, items: ReadonlyArray<string | ArrivalRefusal>,
): void {
  if (items.length === 0) return;
  const shown = items.slice(0, NAMED_IN_SUMMARY)
    .map(i => (typeof i === 'string' ? logSafe(i) : `${logSafe(i._id)} (${logSafe(i.reason)})`));
  log.warn(`${logSafe(where)}: ${items.length} ${family} record(s) ${what} in space '${spaceId}': ${shown.join(', ')}`
    + (items.length > shown.length ? `, and ${items.length - shown.length} more` : ''));
}

/** A seq the counter may carry, or `undefined` — what a restore's odd seq counts as, for the counter and collapse. */
function plausibleSeq(seq: unknown): number | undefined {
  return seqRefusal(seq, { optional: false }) === null ? seq as number : undefined;
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
  if (family === 'files' && !restore) {
    // A peer's file metadata travels as its wire keys only: sizes, hashes and excerpts describe bytes this instance
    // has. A RESTORE replaces the row whole, sizes and hashes included, as 5.6.1 did (cut `C6`).
    doc = fileMetaForWire(doc) as Doc;
  }
  return doc;
}

/**
 * The pull's page accept, moved from the engine with the write it planned for: which documents are strictly newer
 * than what is stored (`planSeqUpserts`), read in one projected `$in` per chunk. A restore accepts all. Returns the
 * stored copies too — whether one existed is what tells an insert from an update.
 */
export async function batchUpsertBySeq<T extends Doc>(
  collName: string, docs: T[], { restore }: { restore: boolean },
): Promise<{ toWrite: T[]; stored: Map<string, Doc> }> {
  const stored = await readStoredById<Doc>(collName, docs.map(d => d._id), { seq: 1 });
  if (restore) return { toWrite: docs, stored };
  const existingSeq = new Map<string, number>();
  // A stored copy with no seq (file metadata from before 4.0) is overwritten by anything that arrives.
  for (const [id, s] of stored) if (typeof s.seq === 'number') existingSeq.set(id, s.seq);
  return { toWrite: planSeqUpserts(docs as Array<T & { seq: number }>, existingSeq), stored };
}

/** The guard on every write but a restore's: only a stored copy below this seq, or none, may be replaced. */
function filterFor(doc: Doc, restore: boolean): Record<string, unknown> {
  if (restore || typeof doc.seq !== 'number') return { _id: doc._id };
  return { _id: doc._id, $or: [{ seq: { $lt: doc.seq } }, { seq: { $exists: false } }] };
}

/**
 * The replace, as an update pipeline so the receiver's own fields are carried IN THE SAME WRITE: the stored values
 * of `LOCAL_ONLY_FIELDS` (a missing one is simply absent), under what arrived. Read-free, and race-free against an
 * embed worker writing a vector between a read and this write. (No `D-9` defaults beneath them: cut `C4`.)
 */
function replacementFor(doc: Doc): unknown[] {
  const carried = Object.fromEntries([...LOCAL_ONLY_FIELDS].map(f => [f, `$${f}`]));
  return [{ $replaceWith: { $mergeObjects: [carried, { $literal: doc }] } }];
}

const storeRefusal = (err: unknown): string =>
  `the store refused it (${writeErrorCode(err) !== undefined ? `error code ${writeErrorCode(err)}` : 'no error code'})`;

const message = (err: unknown): string => logSafe(err instanceof Error ? err.message : String(err));

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
  const out: ArrivalOutcome = {
    inserted: [], updated: [], newerLocal: [], duplicates: [], refused: [], storeRefused: [], derived: [],
    collapsed: [], maxReceived: 0,
  };
  // A peer's file is queued by `ingestFileMeta` alone, when its blob is here; a RESTORED file row is replaced here,
  // not merged, so the writer queues it as 5.6.1's restore did.
  const queues = recordType !== null && (family !== 'files' || restore);

  // ── 1-3: shape, preparation, collapse — keyed in a Map, because an id is a peer's text ─────────────────────────
  const page = new Map<string, Doc>();
  for (const raw of docs) {
    const why = arrivalRefusal(raw, { seq: restore ? 'any' : family === 'files' ? 'optional' : 'required' });
    if (why) { out.refused.push({ _id: arrivalId(raw), reason: why }); continue; }
    const doc = raw as Doc;
    if (family === 'files' && !restore && isDerived(doc)) { out.derived.push(doc._id); continue; }
    const seq = plausibleSeq(doc.seq);
    if (seq !== undefined && seq > out.maxReceived) out.maxReceived = seq;
    const prev = page.get(doc._id);
    if (prev) {
      // The one accept rule: a later copy replaces an earlier one only when it is NEWER — at an equal seq the
      // earlier copy stands, as the push door reads a page.
      out.collapsed.push(doc._id);
      if (!isNewerCopy(seq, plausibleSeq(prev.seq))) continue;
    }
    page.set(doc._id, prepared(doc, family, restore));
  }
  const arriving = [...page.values()];
  retagToLocalSpace(arriving, spaceId);

  // ── the accept: strictly newer than what is stored, unless a restore ─────────────────────────────────────────
  const collName = spaceCollection(spaceId, family);
  const { toWrite, stored } = await batchUpsertBySeq(collName, arriving, { restore });
  const writing = new Set(toWrite);
  for (const d of arriving) if (!writing.has(d)) out.newerLocal.push(d._id);

  // ── the write, a chunk at a time ──────────────────────────────────────────────────────────────────────────────
  const coll = col<Doc>(collName);
  const merges = family === 'files' && !restore;
  /** The page cannot be written: say so, carrying the outcome so far (the chunk's `finally` completes it). */
  const stopped = (err: unknown): ArrivalWriteError => {
    const e = new ArrivalWriteError(spaceId, family, err);
    e.partial = out;
    return e;
  };
  let bumped = 0;
  /** The counter over what was received — awaited, and a failure LOGGED, never thrown (`E1`): see the docblock. */
  const bump = async (top: number): Promise<void> => {
    if (top <= bumped) return;
    try {
      await bumpSeq(spaceId, top);
      bumped = top;
    } catch (err) {
      log.warn(`${logSafe(where)}: the seq counter of space '${spaceId}' could not be moved to ${top}: ${message(err)}`);
    }
  };
  for (const chunk of inChunks(toWrite, READ_CHUNK)) {
    const landed: Doc[] = [];
    const dupes: Doc[] = [];
    /**
     * One document's failed write, classified: a duplicate is an outcome the read-back below decides; a refusal of
     * the document itself is a store refusal; anything else — a view, a dropped socket, a step-down — is not the
     * document's, and fails the page so it is offered again.
     */
    const classify = (d: Doc, err: unknown): void => {
      if (writeErrorCode(err) === DUPLICATE_KEY) dupes.push(d);
      else if (isDocumentRefusal(err)) out.storeRefused.push({ _id: d._id, reason: storeRefusal(err) });
      else throw stopped(err);
    };
    /** One write per document, for an ambiguous bulk failure and for a peer's file metadata (merged, never bulk). */
    const oneByOne = async (docsHere: readonly Doc[], write: (d: Doc) => Promise<boolean>): Promise<void> => {
      for (const d of docsHere) {
        try {
          if (await write(d)) landed.push(d); else out.derived.push(d._id);
        } catch (err) {
          classify(d, err);
        }
      }
    };
    try {
      if (merges) {
        // `ingestFileMeta` returns false for a legacy read spill, which is never stored (counted `derived`).
        await oneByOne(chunk, (d) => ingestFileMeta(spaceId, d as never));
      } else {
        try {
          await coll.bulkWrite(asBulk<Doc>(chunk.map(d => ({
            updateOne: { filter: filterFor(d, restore), update: replacementFor(d), upsert: true },
          }))), { ordered: false });
          landed.push(...chunk);
        } catch (err) {
          const failures = bulkWriteFailures(err);
          const writeOne = async (d: Doc): Promise<boolean> => {
            await coll.updateOne(filterFor(d, restore), replacementFor(d), { upsert: true });
            return true;
          };
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
        // Read back: a stored copy AT the planned seq is this version, landed; one above it was written meanwhile
        // and is kept; anything else collided on a unique index other than `_id`.
        const now = await readStoredById<Doc>(collName, dupes.map(d => d._id), { seq: 1 });
        for (const d of dupes) {
          const s = now.get(d._id)?.seq;
          const sameSeq = typeof s === 'number' && s === d.seq;
          if (!restore && sameSeq) landed.push(d);
          else if (!restore && typeof s === 'number' && isNewerCopy(s, d.seq)) out.newerLocal.push(d._id);
          else out.duplicates.push(d._id);
        }
      }
    } finally {
      /*
       * E1 (`Q-224` on main): four side effects, each run whatever the one before it did. The counter over what this
       * chunk RECEIVED, awaited; the seq note that lets a reader be handed what landed even when the counter could
       * not move; the bookkeeping; and the queue. A bump that throws must not cost landed records their embed jobs,
       * and none of these may replace an `ArrivalWriteError` the body threw.
       */
      await bump(Math.max(0, ...chunk.map(d => plausibleSeq(d.seq) ?? 0)));
      for (const d of landed) {
        const s = plausibleSeq(d.seq);
        if (s !== undefined) noteSeqStored(spaceId, s);
      }
      for (const d of landed) (stored.has(d._id) ? out.updated : out.inserted).push(d._id);
      if (queues && landed.length > 0) {
        try {
          await enqueueIngestedRecords(spaceId, recordType!, landed);
        } catch (err) {
          log.warn(`${logSafe(where)}: ${landed.length} landed record(s) were not queued for embedding in space `
            + `'${spaceId}': ${message(err)}`);
        }
      }
    }
  }
  // What was received and not written (newer locally, collapsed) still moves the counter: it is the peer's clock.
  await bump(out.maxReceived);

  warnArrivalsNotStored(where, spaceId, family, 'refused', out.refused);
  warnArrivalsNotStored(where, spaceId, family, 'refused by the store', out.storeRefused);
  // A repeated id is a sender's bug or a page that overlapped itself: one copy was kept, by the accept rule.
  warnArrivalsNotStored(where, spaceId, family, 'sent more than once in one page (the newest copy was kept)',
    [...new Set(out.collapsed)]);
  warnArrivalsNotStored(where, spaceId, family, 'not applied: a uniquely-indexed duplicate of a record held '
    + 'here under another id (the local copy is kept)', out.duplicates);
  return out;
}
