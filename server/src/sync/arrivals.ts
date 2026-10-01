/**
 * THE ONE WRITER of a record produced elsewhere — a peer's push, a peer's pulled page, an admin restore
 * (`Q-107` part 1). `writeArrivals` replaced `ingestBrainDoc` (push, import), the pull's own page write
 * (`batchUpsertBySeq`, moved here from `sync/engine.ts` with the accept it planned), and the inline
 * `$setOnInsert` of `POST /api/sync/entities`.
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
 *  3. **Collapse** a repeated `_id` to its highest seq (equal: the later). An unordered bulk write lets the LAST
 *     op for an id win whatever its seq, so a page carrying `[9, 3]` stored 3.
 *  4. **What never crosses**: the receiver's local-only fields are dropped from what arrived — and CARRIED from
 *     the stored copy across the replace (`LOCAL_ONLY_FIELDS`), server-side, in the same update, so a peer's
 *     edit no longer erases this instance's vector (the embed fingerprint then skips unchanged text and the
 *     record stays searchable meanwhile), its retention stamps, or its file sync bases. A RESTORE keeps what the
 *     export carried as the record's own state (`RESTORED_LOCAL_FIELDS`) and still drops what is derived.
 *  5. **D-9, the receiver's retention** (owner decision, 2026-10-01): a record that carries no receiver stamp is
 *     stamped from its OWN `createdAt` by this instance's `schema > space` windows — never from now, never the
 *     sender's. A stamp already on the stored copy is carried, never recomputed. An arrival older than the
 *     window is therefore stamped in the past, and the sweep deletes it through the normal path.
 *  6. **The write guard**: `{ _id, seq < s or absent }`, on the insert half as well — a copy newer than the one
 *     planned, written meanwhile, fails the op with a duplicate `_id` and is kept. A RESTORE replaces, unguarded.
 *     **File metadata is the stated exception until `Q-107` part 2:** it is merged per document by
 *     `ingestFileMeta`, whose `$set` upsert filters on `_id` alone, so only the accept read (`batchUpsertBySeq`)
 *     guards it — a copy written between that read and the merge is overwritten.
 *  7. **Failures by operation**: a duplicate is read back — a newer stored copy is "skipped", anything else is a
 *     unique-index duplicate (an edge triplet, a link's endpoints). Any other per-operation failure is retried
 *     ONCE alone and then refused by id. A failure with no per-operation shape falls back to one write per
 *     document; if that fails for every document, or for a reason the store owns (network, step-down), it
 *     THROWS — the push answers 500 so the sender keeps its watermark, the pull holds `deliveredThrough`.
 *  8. **The counter, then the queue**, in a `finally` per chunk: `bumpSeq` over what the chunk received
 *     (awaited), and only then the batched embed enqueue of what landed, by the RECEIVER's suppression. The
 *     bump is the only thing that makes an arrival visible to a seq-paged reader; nothing here notes a seq on
 *     its own, so a local write can never take a seq below an arrival a reader was already handed.
 *
 * ## The record type is an explicit argument
 *
 * `null` means this family has nothing to embed (a link is a pair of ids) — said at the call, where a reviewer
 * sees it, rather than by a second writer for links.
 *
 * ## What it does not decide
 *
 * WHICH documents of a push land — tombstones, forks, the fork caps — is the push planner's
 * (`planPushArrivals`, `sync/upsert-plan.ts`); the writer only re-checks "strictly newer than stored", which is
 * the whole of the pull's accept rule (`planSeqUpserts`) and agrees with every push verdict. File metadata is
 * merged per document through `ingestFileMeta` rather than replaced (`Q-107` part 2 batches it).
 */
import { col, asBulk } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import { bulkWriteFailures, DUPLICATE_KEY, isDocumentRefusal, isDocumentRefusalCode, writeErrorCode } from '../db/write-errors.js';
import { bumpSeq, isSeqImplausible } from '../util/seq.js';
import { inChunks } from '../util/chunks.js';
import { log } from '../util/log.js';
import { BRAIN_COLLECTIONS } from '../config/types.js';
import type { BrainCollection, BrainEmbedRecordType } from '../config/types.js';
import { LOCAL_ONLY_FIELDS, RESTORED_LOCAL_FIELDS, DERIVED_LOCAL_FIELDS } from './local-only-fields.js';
import { planSeqUpserts, retagToLocalSpace, isNewerCopy } from './upsert-plan.js';
import { enqueueIngestedRecords } from '../brain/embed-queue.js';
import type { RetentionSpace } from '../brain/chrono-retention.js';
import { retentionSpace, retentionStamps } from '../brain/ttl.js';
import { isDerived } from '../brain/embed-record.js';
import { ingestFileMeta, fileMetaForWire } from '../api/sync/_shared.js';

type Doc = Record<string, unknown> & { _id: string; seq?: number };

export interface ArrivalOptions {
  /**
   * An admin RESTORE (`POST /api/admin/spaces/:id/import`): what is stored is replaced whatever its seq (a restore
   * over newer data is what the operator asked for), the export's record-tier local fields are kept, and a
   * restored file is queued for embedding whether or not its blob is here. Never set for a peer.
   */
  restore?: boolean;
  /** Queue the embeddings later, through the returned `enqueue` — for a fork written inside a seq hold. */
  deferEnqueue?: boolean;
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
  /** Refused, per document: a malformed id or seq, or a store refusal that repeated. */
  refused: ArrivalRefusal[];
  /** Not written by rule: a file chunk or face record (derived from the blob here), or a legacy read spill. */
  derived: string[];
  /** Ids that arrived more than once; one version (the highest seq) was kept. */
  collapsed: string[];
  /** The highest plausible seq received — what the counter has been bumped to at least. */
  maxReceived: number;
  /** Queue the landed records' embeddings, when `deferEnqueue` held it back; a no-op otherwise. */
  enqueue: () => Promise<void>;
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
 * Why a document cannot be stored as it arrived, or `null` when it can. The one shape rule for every door: the
 * push routes ask it before planning (so a refused document is counted, not planned), and the writer asks it
 * again, so a door that forgot to is still covered.
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

/**
 * One warning per page for what a door did not store, naming the first ids — the shape every door logs, so a
 * refusal reads the same from a push, a pull and a restore. Never a line per document: a poison page would
 * flood the log ring with one fact.
 */
export function warnArrivalsNotStored(
  where: string, spaceId: string, family: string, what: string, items: ReadonlyArray<string | ArrivalRefusal>,
): void {
  if (items.length === 0) return;
  const shown = items.slice(0, 10).map(i => (typeof i === 'string' ? i : `${i._id} (${i.reason})`));
  log.warn(`${where}: ${items.length} ${family} record(s) ${what} in space '${spaceId}': ${shown.join(', ')}`
    + (items.length > shown.length ? `, and ${items.length - shown.length} more` : ''));
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
 * The pull's page accept, moved from the engine with the write it planned for: which documents are strictly
 * newer than what is stored (`planSeqUpserts`), read in one projected `$in` per chunk. A restore accepts all.
 * Returns the stored copies too — whether one existed is what tells an insert from an update.
 */
export async function batchUpsertBySeq<T extends Doc>(
  collName: string, docs: T[], { restore, fields }: { restore: boolean; fields: Readonly<Record<string, 1>> },
): Promise<{ toWrite: T[]; stored: Map<string, Doc> }> {
  const stored = await readStoredById<Doc>(collName, docs.map(d => d._id), { seq: 1, ...fields });
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
 * The replace, as an update pipeline so the receiver's own fields are carried IN THE SAME WRITE: the stored
 * values of `LOCAL_ONLY_FIELDS` (a missing one is simply absent), over the D-9 defaults, under what arrived.
 * Read-free, and race-free against an embed worker writing a vector between a read and this write.
 */
function replacementFor(doc: Doc, defaults: Doc): unknown[] {
  const carried = Object.fromEntries([...LOCAL_ONLY_FIELDS].map(f => [f, `$${f}`]));
  return [{ $replaceWith: { $mergeObjects: [{ $literal: defaults }, carried, { $literal: doc }] } }];
}

const codeOf = writeErrorCode;
const storeRefusal = (err: unknown): string =>
  `the store refused it (${codeOf(err) !== undefined ? `error code ${codeOf(err)}` : 'no error code'})`;

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
    inserted: [], updated: [], newerLocal: [], duplicates: [], refused: [], derived: [], collapsed: [], maxReceived: 0,
    enqueue: async () => {
      // A file is queued by `ingestFileMeta` alone — when its blob is here, or on a restore — never here as well.
      if (recordType === null || queued.length === 0 || family === 'files') return;
      const batch = queued.splice(0);
      await enqueueIngestedRecords(spaceId, recordType, batch);
    },
  };

  // ── 1-3: shape, preparation, collapse — keyed in a Map, because an id is a peer's text ─────────────────────
  const page = new Map<string, Doc>();
  for (const raw of docs) {
    const why = arrivalRefusal(raw, { seqOptional: family === 'files' });
    if (why) { out.refused.push({ _id: arrivalId(raw), reason: why }); continue; }
    const doc = raw as Doc;
    if (family === 'files' && isDerived(doc)) { out.derived.push(doc._id); continue; }
    const seq = doc.seq ?? 0;
    if (seq > out.maxReceived) out.maxReceived = seq;
    const prev = page.get(doc._id);
    if (prev) {
      // The one accept rule: a later copy replaces an earlier one only when it is NEWER — at an equal seq the
      // earlier copy stands, as the push planner reads a page.
      out.collapsed.push(doc._id);
      if (!isNewerCopy(doc.seq, prev.seq)) continue;
    }
    page.set(doc._id, prepared(doc, family, restore));
  }
  const arriving = [...page.values()];
  retagToLocalSpace(arriving, spaceId);

  // ── the accept: strictly newer than what is stored, unless a restore ─────────────────────────────────────
  const collName = spaceCollection(spaceId, family);
  const stampFields = { _expireAt: 1, _contentExpireAt: 1 } as const;
  const { toWrite, stored } = await batchUpsertBySeq(collName, arriving, { restore, fields: family === 'files' ? stampFields : {} });
  const writing = new Set(toWrite);
  for (const d of arriving) if (!writing.has(d)) out.newerLocal.push(d._id);
  const space = recordType === null ? undefined : retentionSpace(spaceId);
  const defaults = new Map(toWrite.map(d => [d._id, recordType === null ? {} as Doc : receiverStamps(d, recordType, space)]));

  // ── the write, a chunk at a time ──────────────────────────────────────────────────────────────────────────
  const coll = col<Doc>(collName);
  /** The page cannot be written: say so, carrying the outcome so far (the chunk's `finally` completes it). */
  const stopped = (err: unknown): ArrivalWriteError => {
    const e = new ArrivalWriteError(spaceId, family, err);
    e.partial = out;
    return e;
  };
  let bumped = 0;
  const bump = async (top: number): Promise<void> => {
    if (top <= bumped) return;
    await bumpSeq(spaceId, top);
    bumped = top;
  };
  for (const chunk of inChunks(toWrite, READ_CHUNK)) {
    const landed: Doc[] = [];
    const dupes: Doc[] = [];
    /**
     * One document's failed write, classified: a duplicate is an outcome the read-back below decides (including
     * "this very version already landed", which is what a document of a bulk write that failed ambiguously after
     * applying says); a refusal of the document itself refuses it; anything else — a view, a dropped socket, a
     * step-down — is not the document's, and fails the page so it is offered again.
     */
    const classify = (d: Doc, err: unknown): void => {
      if (codeOf(err) === DUPLICATE_KEY) dupes.push(d);
      else if (isDocumentRefusal(err)) out.refused.push({ _id: d._id, reason: storeRefusal(err) });
      else throw stopped(err);
    };
    /** One write per document, for an ambiguous bulk failure and for file metadata (merged, never bulk). */
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
      if (family === 'files') {
        await oneByOne(chunk, async (d) => {
          const keep = stored.get(d._id);
          // D-9 for a file: a stamp the stored copy has is kept by the merge itself (`$set`, never `$unset`).
          const stamps = keep?.['_expireAt'] !== undefined || keep?.['_contentExpireAt'] !== undefined ? {} : defaults.get(d._id);
          return ingestFileMeta(spaceId, { ...stamps, ...d } as never, { restore });
        });
      } else {
        const update = (d: Doc) => replacementFor(d, defaults.get(d._id) ?? ({} as Doc));
        try {
          await coll.bulkWrite(asBulk<Doc>(chunk.map(d => ({
            updateOne: { filter: filterFor(d, restore), update: update(d), upsert: true },
          }))), { ordered: false });
          landed.push(...chunk);
        } catch (err) {
          const failures = bulkWriteFailures(err);
          const writeOne = async (d: Doc): Promise<boolean> => {
            await coll.updateOne(filterFor(d, restore), update(d), { upsert: true });
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
        // Read back: a stored copy AT the planned seq is this version, landed; one above it was written
        // meanwhile and is kept ("skipped"); anything else collided on a unique index other than `_id`.
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
      // The counter over what this chunk RECEIVED, awaited, and only then the queue — see the module docblock.
      await bump(Math.max(0, ...chunk.map(d => d.seq ?? 0)));
      for (const d of landed) (stored.has(d._id) ? out.updated : out.inserted).push(d._id);
      queued.push(...landed);
      if (!opts.deferEnqueue) await out.enqueue();
    }
  }
  // What was received and not written (newer locally, collapsed) still moves the counter: it is the peer's clock.
  await bump(out.maxReceived);

  warnArrivalsNotStored(where, spaceId, family, 'refused', out.refused);
  warnArrivalsNotStored(where, spaceId, family, 'not applied: a uniquely-indexed duplicate of a record held '
    + 'here under another id (the local copy is kept)', out.duplicates);
  return out;
}
