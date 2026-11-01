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
 *     counter can carry (absent only for file metadata older than seqs), and — for file metadata that is not a restore —
 *     an `_id` that IS the key its path resolves to (`fileKeyRefusal`, Q-404). A refusal is that document's, never
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
 *     tier and the write guard from the stored copy, never its vector, model or `matchedText`, which describe content
 *     it no longer embeds (`Q-230`), and is stored with THIS instance's own `matchedText` of the arriving content, built
 *     by this instance's text builder as a local suppressed write's is (`Q-262`): the record stays findable by its words,
 *     and nothing queues it, so nothing would write the text later (a file's is written after the merge,
 *     `embedArrivedFiles`, because it depends on fields the arrival does not carry); and a RESTORE carries nothing from the copy it replaces — the backup's own record-tier fields come
 *     with the document (`RESTORED_LOCAL_FIELDS`), and what the backup does not carry is absent (`Q-234`).
 *     **Who delivered the version is stamped last** (`deliveredBy`, bundle-51): the delivering peer's id, or `''`
 *     when nobody delivered it (an admin push), written AFTER the carried fields so the stored stamp never survives a
 *     new delivery. The upstream deletion ground (`sync/deletion-authority.ts`) stands on that stamp alone, and a
 *     carried one would let the first deliverer of a record keep the right to delete what another peer later sent.
 *     A restore keeps the backup's own stamp, which is part of what it restores (`''` for a backup that has none).
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
 *  8. **The landing, then the queue.** Every chunk takes ONE block of positions under the hold (`withLandingStamp`,
 *     `sync/record-position-stream.ts`) and writes its documents with them: a position is where the record sits in THIS
 *     instance's stream, taken here whatever the sender's version was (the version is the issuer's, kept as it arrived). A
 *     reader is handed a position only once its write has settled, so an arrival is visible the way a local write is. An
 *     arrival never moves the space's version counter (D-19 B): a peer's version can neither raise this instance's own
 *     stamps nor strand them above the ceiling (Q-241), and a local edit of an arrival is stamped above it by the version
 *     formula (`util/version-stamp.ts`). Then, in a `finally` per chunk, the batched embed enqueue of what landed, by the
 *     RECEIVER's suppression. The write's own error, and its `partial`, always win.
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
import { col, asBulk, asFilter, asUpdate } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import {
  bulkWriteFailures, DUPLICATE_KEY, isDuplicateKey, isDocumentRefusal, isDocumentRefusalCode, writeErrorCode, isArgumentErrorOfOneWrite,
} from '../db/write-errors.js';
import { isSeqImplausible } from '../util/seq.js';
import { withLandingStamp, arrivalRow, type ArrivalLanding } from './record-position-stream.js';
import { PageStoppedError } from './page-stopped.js';
import { isWriteTimeout } from '../db/write-timeout.js';
import { isUnsatisfiableWriteConcern } from '../db/store-condition.js';
import { inOneCommandChunks, operationBytes } from '../db/one-command.js';
import { log, logSafe, peerList, peerText } from '../util/log.js';
import { BRAIN_COLLECTIONS } from '../config/types.js';
import type { BrainCollection, BrainEmbedRecordType } from '../config/types.js';
import { RESTORED_LOCAL_FIELDS, RESTORED_DATE_FIELDS, NOT_CARRIED_BY_BACKUP, WRITE_GUARD_FIELDS, WRITTEN_HERE, carriedFields, stampOfArrival } from './local-only-fields.js';
import { retentionStampOf } from '../brain/retention-stamp.js';
import { retagToLocalSpace, seqGuard, divergesFrom, forkRowVerdict, isForkingFamily, CONVERGE_BLANKED } from './upsert-plan.js';
import { isNewerCopy } from './held-tombstone-rules.js';
import { authoredContentHash, bodyProjectionOf } from './authored-content.js';
import { readBackDuplicates } from './duplicate-readback.js';
import { fileContentHash, FILE_HASH_PROJECTION } from '../brain/merkle.js';
import { isWrittenHere } from './written-here.js';
import { enqueueIngestedRecords, EMBED_REPAIR_HINT } from '../brain/embed-queue.js';
import type { RetentionSpace } from '../brain/chrono-retention.js';
import { retentionSpace, retentionStamps } from '../brain/ttl.js';
import { isDerived, buildEmbedTexts } from '../brain/embed-record.js';
import { derivedFieldsForWrite } from '../brain/derived-text-on-write.js';
import { embeddingSuppressedFor } from '../brain/suppress-embeddings.js';
import { getSpaceMeta } from '../spaces/schema-validation.js';
import { fileMetaForWire } from '../api/sync/_shared.js';
import { fillFileMetaFromStray } from './fill-file-meta.js';
import { fileMetaUpdate, embedArrivedFiles, authoredKeysRestoreRemoves } from './file-meta-write.js';
import { isLegacyReadSpill, isInstanceLocalFile } from './file-conflict.js';
import { decideArrivals, supersedeFileTombstones } from '../files/tombstones.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { fileKeyOf } from '../files/sandbox.js';
import { countFileArrival } from '../files/bytes-arrived.js';
import { isComparableIso } from '../util/comparable-iso.js';
import { admitSpaceWriteUnit, assertSpaceTakesWrites } from '../spaces/space-write-gate.js';
import { RequestRefusal } from '../util/errors.js';
import { adoptLegacyRow, forgetLegacyIndex } from '../files/legacy-file-keys.js';

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
   * The peer the door PROVES delivered the page — stored on every record it writes (`deliveredBy`). Absent for a
   * delivery with no peer behind it (an admin or local token), which is stamped `''`: nobody's. Ignored by a restore,
   * whose records carry the backup's own stamp.
   */
  deliveredBy?: string;
  /**
   * The stray-filemeta drain (`Q-219`) only: each file record is RECOVERED onto its row by `fillFileMetaFromStray`
   * rather than merged — a row this instance made by default is filled, a peer-written row keeps the seq accept AT
   * THE WRITE, and no row is created. So the retention stamping is skipped: it belongs to a record being created.
   * It changes how a files record is written, never whether one is admitted (shape and chunk refusal still run).
   */
  fillOnly?: boolean;
  /**
   * The documents of this write that are PARENT SWAPS (Q-324), by id: each replaces the stored copy at its OWN seq, under the guard the planner built from that
   * stored copy (`equalSeqSwapGuard`) instead of `seqGuard`, which admits only a lower seq. Every other document keeps `seqGuard`. Ignored by a restore.
   */
  swapGuards?: ReadonlyMap<string, Record<string, unknown>>;
  /**
   * The delivery stamp of a document that is NOT the page's deliverer's, by id (Q-324): the fork a STORED copy became keeps whoever delivered that copy
   * (`''` when nobody did). The page's deliverer is the peer that sent the copy that displaced it, and stamping the fork with it would keep the fork from ever
   * being offered back to that peer — which has never seen the displaced text. Ignored by a restore.
   */
  deliveredByOf?: ReadonlyMap<string, string>;
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
  /** Not written by rule: a file chunk or face record (derived from the blob here), or a file this instance keeps for itself (`isInstanceLocalFile`). */
  derived: string[];
  /**
   * Not written: a held file tombstone covers this VERSION of the file (its `rowSeq` is at or above the arriving seq,
   * Q-229). Only for file metadata, and never for a restore. The page is answered `tombstoned`, as a record is.
   */
  tombstoned: string[];
  /**
   * Not written: a file's metadata a pending delete would shadow, whose path could not be looked at, and whose stored row did not decide it
   * (the one case that cannot occur: a live row below the arriving version, `metaDecidedByRow`). The page goes on; the document is answered
   * `skipped` and said once per window (`UNDECIDED_STEP`).
   */
  undecided: string[];
  /** Ids that arrived more than once; one version (the highest seq) was kept. */
  collapsed: string[];
  /** `fillOnly`: the row this instance made already had everything the record could give it. */
  complete: string[];
  /** `fillOnly`: no file row for it, so nothing was written — never created, because a stray record is old. */
  unstored: string[];
  /**
   * A RESTORE only: the file rows that landed carrying the `deletedAt` flag their backup held (`Q-257`) — soft-deleted files
   * the restore brought back as the audit records they were, not as live rows.
   */
  flagKept: string[];
  /**
   * A RESTORE only: how many authored keys the rows that landed lost because their backup row lacks them (an export is a full
   * record). Counted from the stored rows read before the write (`authoredKeysRestoreRemoves`), so a key the replaced row never had
   * is not counted.
   */
  keysRemoved: number;
  /** The highest plausible seq received. Informational: an arrival never moves the version counter. */
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
 * Why a file-metadata document's `_id` cannot be the key of a file row, or `null` when it can: the id must BE the key its path
 * resolves to (`fileKeyOf`, the same key `toDocId` gives a local write), which is what every other door looks the file up by
 * (bundle-71, Q-404). A key comparison needs no disk, so none is read: this runs per arriving file row, and a symlink is the
 * business of whatever later reads or writes bytes at the path, which resolves it with the symlink check.
 *
 * ## What it prevents
 *
 * A row keyed by a peer's SPELLING of a path (`x/../victim`) is a row nothing reads again — the bytes, the tombstones and the
 * local manifest all key by the resolved `victim` — and the shadow ask for it was made by the spelling, so a tombstone held for
 * `victim` never saw the arrival. Refused as a shape violation, counted with every other, rather than keyed for the writer: the
 * peer's record for `victim` arrives under its own id, and one for a path that leaves the space is no file of this one.
 *
 * Reasons carry no text of the peer's: they travel to a log line and back in an answer. Anything but a refused path is thrown,
 * so the page fails and is retried rather than a document being refused for a fault of ours.
 */
function fileKeyRefusal(spaceId: string, id: string): string | null {
  try {
    return fileKeyOf(spaceId, id).key === id ? null : '_id is not the canonical key of its path';
  } catch (err) {
    // Our refusal class, not any `RangeError`: the runtime throws one too, and that is a fault of ours the page must fail on.
    if (err instanceof RequestRefusal) return '_id is not a path inside the space';
    throw err;
  }
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
  // The derived half and this instance's write guard: never a peer's and never a backup's (`NOT_CARRIED_BY_BACKUP`); a restored
  // edge arrives unmarked (`Q-439`).
  for (const f of NOT_CARRIED_BY_BACKUP) delete doc[f];
  // Stamped afresh by this landing, whatever door brought it: the written-here bit joins the record tier for a database's raw restore, but
  // an import or a peer never takes it from the document (the landing's patch is the only source, `withLandingStamp`).
  delete doc[WRITTEN_HERE];
  for (const f of RESTORED_LOCAL_FIELDS) {
    if (!restore) { delete doc[f]; continue; }
    // JSON turned a stamp into text, and a backup may carry any shape; stored as anything but a Date it never matches the sweep's range
    // query and the record never expires. Every date-typed one goes through the one rule (`retentionStampOf`): a Date or nothing, and
    // nothing means the field is dropped and the record is stamped as an unstamped one is (D-9 / D-13). Only the date-typed ones: a peer's id
    // is text, and read as a date it would be thrown away.
    if (RESTORED_DATE_FIELDS.has(f)) {
      const at = retentionStampOf(doc[f]);
      if (at === undefined) delete doc[f]; else doc[f] = at;
    }
  }
  if (family === 'files') {
    // File metadata travels as its wire keys only: sizes, hashes and excerpts describe bytes this instance has.
    const kept = Object.fromEntries([...RESTORED_LOCAL_FIELDS].filter(f => doc[f] !== undefined).map(f => [f, doc[f]]));
    doc = { ...fileMetaForWire(doc), ...kept, ...(restore ? restoredFileFlag(doc) : {}) } as Doc;
  }
  return doc;
}

/**
 * The flag a soft delete left on a file row, as a RESTORE keeps it (`Q-257`): `deletedAt` says THIS instance deleted the
 * file and kept the row for audit, which is what an export of this instance's own space records, so restoring it live — a
 * row with no bytes, offered to every peer — would turn every audited deletion into a phantom file. A files-only carry, named
 * here and not added to `RESTORED_LOCAL_FIELDS`: that list is every family's, and is skipped at every nesting level by the
 * hash. A peer's copy never carries it (`fileMetaForWire` drops it, and a flagged row is not offered), and a flag that is not
 * an instant is not one.
 */
function restoredFileFlag(doc: Readonly<Doc>): { deletedAt?: string } {
  return isComparableIso(doc['deletedAt']) ? { deletedAt: doc['deletedAt'] } : {};
}

/** D-9: the stamps this instance's policy gives a record created at `createdAt`, absent where it gives none. */
function receiverStamps(doc: Doc, recordType: BrainEmbedRecordType, space: RetentionSpace | undefined): Doc {
  // This instance's whole `schema > space` policy (the backfill passes a schema-only one to the same step).
  return (space ? retentionStamps(space, recordType, doc) : {}) as Doc;
}


/**
 * What the replace carries of a write-guard field (`Q-439`): the stored value, but only while the arriving document's `from`
 * and `label` are the stored ones. A guard is a function of `(from, label)`, so a peer's edit that moves the edge to another
 * subject must not leave the old marker on it — a phantom holding the old subject's slot for ever. Decided in the same write,
 * on the stored row, because a read before it could be stale. A document with no `from` and `label` (every family but edges)
 * has no guard to carry.
 */
function guardCarry(doc: Doc, field: string): unknown {
  if (typeof doc['from'] !== 'string' || typeof doc['label'] !== 'string') return '$$REMOVE';
  return {
    $cond: [{ $and: [{ $eq: ['$from', { $literal: doc['from'] }] }, { $eq: ['$label', { $literal: doc['label'] }] }] }, `$${field}`, '$$REMOVE'],
  };
}

/**
 * The replace, as an update pipeline so the carried fields cross IN THE SAME WRITE: the stored values of `carried`
 * (a missing one is simply absent), over the D-9 defaults, under what arrived — every peer value inside `$literal`.
 * Read-free, and race-free against an embed worker writing a vector between a read and this write.
 *
 * `deliveredBy` is the fourth operand, after what was carried: the stamp of THIS delivery wins over the stored one. A
 * restore passes the backup's own (`''` when it carried none): what it replaced is never what it keeps. The landing (the position
 * this arrival took and the version it is for) is the last: it describes THIS landing and is never the replaced copy's.
 */
function replacementFor(
  doc: Doc, defaults: Doc, carried: ReadonlySet<string>, deliveredBy: string, landing: ArrivalLanding, guarded: ReadonlySet<string> = new Set(),
  own: Record<string, unknown> = {},
): unknown[] {
  // `guarded`: the carried fields that are write guards, kept only while the record's subject is unchanged.
  // `own`: what THIS instance derived from the arriving content (a suppressed record's `matchedText`), merged after `doc` so neither
  // a default nor a carried field can override it.
  const kept = Object.fromEntries([...carried].map(f => [f, guarded.has(f) ? guardCarry(doc, f) : `$${f}`]));
  return [{ $replaceWith: { $mergeObjects: [{ $literal: defaults }, kept, { $literal: doc }, { $literal: own }, { $literal: { deliveredBy } }, { $literal: landing }] } }];
}

/**
 * The `matchedText` of the arrivals this instance suppresses, by id — through the one rule of what a write may store beside a
 * vector (`derivedFieldsForWrite`: the text, and no vector). A file has none here: its text depends on the row as merged.
 */
async function suppressedTexts(
  spaceId: string, family: BrainCollection, recordType: BrainEmbedRecordType | null, docs: readonly Doc[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (family === 'files' || recordType === null || docs.length === 0) return out;
  const texts = await buildEmbedTexts(spaceId, recordType, docs);
  for (let i = 0; i < docs.length; i++) {
    const text = texts[i];
    // Only a string is a text: the builder's marker for a wrong-typed field stores nothing, and the backfill owes that record.
    if (typeof text !== 'string') continue;
    // `.set` alone, the one named exemption (`a-derived-write-applies-both-halves`): the replace keeps only the fields it names, and a
    // suppressed arrival carries no vector field from the stored copy (`carriedFields`), so there is nothing for an `unset` to remove.
    out.set(docs[i]!._id, (await derivedFieldsForWrite({ text: () => text, vector: null, suppressed: true, onto: 'stored' })).set);
  }
  return out;
}

/**
 * A landing the update holds BY REFERENCE: sized with the right bytes and none of the right value, before its chunk's block of positions is
 * taken, then set in place (`Object.assign`) once it is — so the update is built once per document, measured and written through the one memo.
 */
type MutableLanding = { pos: number; posAtSeq: number; writtenHere?: true };

const storeRefusal = (err: unknown): string =>
  `the store refused it (${writeErrorCode(err) !== undefined ? `error code ${writeErrorCode(err)}` : 'no error code'})`;
/**
 * How much of a driver's error an argument refusal quotes: enough to act on, never a page of it. Through `peerText`,
 * because the driver's message can carry the peer's value: escaped, cut on a code point, and saying it was cut.
 */
const ARGUMENT_QUOTED = 200;
/** The step a file's metadata a pending delete would shadow, that the stored row could not decide either, is said under. */
const UNDECIDED_STEP = declareStep('File metadata arrival undecided');
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
  // A restore does not refuse an id that is not its path's key, so it can bring legacy ids back: what was learned of the space's legacy ids is forgotten (Q-413) — here, and again after each chunk has landed.
  if (restore && family === 'files') forgetLegacyIndex(spaceId);
  const where = `${restore ? 'import' : 'sync'} ${family}${opts.from ? ` from ${opts.from}` : ''}`;
  const queued: Doc[] = [];
  const out: ArrivalOutcome = {
    inserted: [], updated: [], newerLocal: [], diverged: [], duplicates: [], refused: [], derived: [], tombstoned: [], undecided: [], collapsed: [],
    complete: [], unstored: [], flagKept: [], keysRemoved: 0, maxReceived: 0,
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
    // A fork row is accepted on EVERY door only when its id derives from its subject, its seq and its body (design section 3): a restore plans nothing
    // and so asks it here, where the row is refused by name and never stored. A row the derivation cannot prove (a legacy fact fork, a redacted chrono
    // fork) is restored: a backup is this instance's own export, and refusing a real row would be the divergence the exception exists to avoid.
    if (restore && typeof doc['forkOf'] === 'string' && forkRowVerdict(family, doc as Parameters<typeof forkRowVerdict>[1], (isForkingFamily(family) ? authoredContentHash(family, doc as Record<string, unknown>).text : '')) === 'invalid') {
      out.refused.push({ _id: doc._id, reason: 'a fork row whose id does not derive from its subject, its seq and its body (or whose forkOf is its own id, or on a family that does not fork)' });
      continue;
    }
    // A chunk is derived from the blob here, and a file this instance derives for ITSELF travels in neither direction
    // (`isInstanceLocalFile`, the one predicate every door asks: a legacy read spill `Q-92`, a conflict copy, a schema
    // snapshot, and what lies under a derived tree — each receiver converts by its own configuration).
    // A peer's row at such a path is ignored, never stored. A restore is this instance's OWN export, so its rows are not
    // judged by it: only the legacy spill, which no instance keeps any more, is left out of one.
    if (family === 'files' && (isDerived(doc) || (restore ? isLegacyReadSpill(doc._id) : isInstanceLocalFile(doc._id)))) {
      // A peer's offer of an instance-local path is counted through the one arrival recorder (not a chunk, not a restore's spill).
      if (!restore && !isDerived(doc)) countFileArrival('metadata', 'ignored_instance_local');
      out.derived.push(doc._id);
      continue;
    }
    // A restore's ids are this instance's own export's, and it is never judged by a peer's rules; any other arrival is a peer's text.
    const keyWhy = family === 'files' && !restore ? fileKeyRefusal(spaceId, doc._id) : null;
    if (keyWhy) { out.refused.push({ _id: doc._id, reason: keyWhy }); continue; }
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
  let toWrite = [...page.values()];
  retagToLocalSpace(toWrite, spaceId);
  // A file's metadata a held tombstone covers is not written (Q-229): by VERSION, so a newer one passes. A restore is the
  // operator's own instruction and is never judged by one. Asked of the one predicate every arrival of a file asks.
  if (family === 'files' && !restore && toWrite.length > 0) {
    // A row this instance holds under a spelling bundle-71 no longer writes is put at the key the arrival names before anything is compared with it (Q-413).
    for (const d of toWrite) await adoptLegacyRow(spaceId, d._id);
    const { shadowed, undecided, cause } = await decideArrivals(spaceId, toWrite.map(d => ({ id: d._id, path: d._id, kind: 'meta' as const, seq: d.seq ?? 0,
      author: (d.author as { instanceId?: string } | undefined)?.instanceId, deliveredBy: opts.deliveredBy })));
    if (shadowed.size > 0) out.tombstoned.push(...shadowed);
    // One path the tombstone's disk cannot answer for never holds up the page: its document is not written and the rest goes on.
    for (const id of undecided) reportSpaceFailure(UNDECIDED_STEP, spaceId, cause, { unit: id, when: 'next cycle' });
    out.undecided.push(...undecided);
    if (shadowed.size > 0 || undecided.size > 0) toWrite = toWrite.filter(d => !shadowed.has(d._id) && !undecided.has(d._id));
  }

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
  // What an arrival this instance suppresses is stored with: this instance's OWN text of what arrived (`Q-262`), built by its own
  // builder as a local suppressed write's is, and never the stored copy's (`carriedFields`). Nothing queues a suppressed record, so
  // nothing would write it later. A file's text depends on fields the arrival does not carry, so a file's is written after the merge
  // (`embedArrivedFiles`).
  const ownText = await suppressedTexts(spaceId, family, recordType, toWrite.filter(d => suppressed.has(d._id)));
  // A restore tells the operator what it removes: read BEFORE the write, which replaces the rows. A count is a diagnostic, so a read
  // that fails leaves it unsaid and never fails the restore (the writes below fail, and say so, if the store is not answering).
  const removable = family === 'files' && restore
    ? await authoredKeysRestoreRemoves(spaceId, toWrite).catch((err: unknown) => {
      log.debug(`${logSafe(where)}: the keys this restore removes could not be counted: ${logSafe(String(err))}`);
      return new Map<string, number>();
    })
    : new Map<string, number>();
  /** Who delivered the version this document carries: the page's deliverer, but for a fork a stored copy BECAME, whoever delivered that copy (`deliveredByOf`). */
  const deliveredByOf = (d: Doc): string | undefined => opts.deliveredByOf?.get(d._id) ?? opts.deliveredBy;
  const filterOf = (d: Doc): Record<string, unknown> => (restore ? { _id: d._id } : opts.swapGuards?.get(d._id) ?? seqGuard(d._id, d.seq));
  const updateOf = (d: Doc, landing: MutableLanding): unknown => {
    const quiet = suppressed.has(d._id);
    const stamps = defaults.get(d._id) ?? ({} as Doc);
    if (family === 'files') return fileMetaUpdate(d, { defaults: stamps, restore, suppressed: quiet, deliveredBy: opts.deliveredBy ?? '', landing });
    const carried = carriedFields({ restore, suppressed: quiet });
    // A write guard (`_functionalGuard`, an edge's) crosses only while `from` and `label` are the stored ones: carry-if-unchanged.
    const guarded = new Set([...carried].filter(f => WRITE_GUARD_FIELDS.has(f)));
    return replacementFor(d, stamps, carried, stampOfArrival({ restore, doc: d, deliveredBy: deliveredByOf(d) }), landing, guarded, ownText.get(d._id));
  };
  // The landing each document's update holds by reference: a stand-in while the page is measured, the chunk's own positions once its
  // `withLandingStamp` has taken them (set in place, below), so the memo below is still the only place an update is built.
  const landingOf = new Map<string, MutableLanding>();
  const landingRef = (d: Doc): MutableLanding => {
    let landing = landingOf.get(d._id);
    if (!landing) {
      // The written-here bit is the one predicate's, asked of what will be STORED (the delivery stamp this landing writes, never the document's own claim).
      landing = {
        pos: Number.MAX_SAFE_INTEGER, posAtSeq: Number.MAX_SAFE_INTEGER,
        ...(isWrittenHere({ author: d.author as { instanceId?: unknown } | null | undefined, deliveredBy: stampOfArrival({ restore, doc: d, deliveredBy: deliveredByOf(d) }) }) ? { writtenHere: true as const } : {}),
      };
      landingOf.set(d._id, landing);
    }
    return landing;
  };
  // Built ONCE per document: the update is a copy of the document, read for its size when the page is sliced and again to
  // write it (and once more for a document written on its own after a bulk failure). An id is unique in `toWrite`.
  const updates = new Map<string, unknown>();
  const updateFor = (d: Doc): unknown => {
    if (!updates.has(d._id)) updates.set(d._id, updateOf(d, landingRef(d)));
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
  // A chunk is ONE wire command (`db/one-command.ts`): a bulk write the driver splits is several commands with a deadline
  // of their own each, and the write bound ends a call by the first one's. By bytes as well as by count, because a page
  // is a peer's and 500 documents of 32 KiB already pass the driver's 16 MiB batch limit.
  const chunks = inOneCommandChunks(toWrite, {
    maxItems: READ_CHUNK,
    bytesOf: (d) => (fillOnly ? 0 : operationBytes({ filter: filterOf(d), update: updateFor(d) })),
  });
  for (const chunk of chunks) {
    // The chunk is one write unit, ADMITTED and counted in one step (`admitSpaceWriteUnit`): asked per CHUNK, after every rights door has passed,
    // so an import, a push or a pull admitted before a deletion or wipe of the space registered stops at its next chunk instead of refilling
    // what the act deletes, and an act's drain waits for the chunk in flight. Released in the `finally` below; only declarations stand between.
    const leaveWriteUnit = admitSpaceWriteUnit(spaceId, family);
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
      // FIRST: code 2 is in `DOCUMENT_REFUSAL_CODES`, and a standalone mongod answers an unmeetable `w > 1` with it. Read as
      // the document's, the document is refused by id and dropped from its page for good, over a configuration fault.
      if (isUnsatisfiableWriteConcern(err)) throw stopped(err);
      if (isDuplicateKey(err)) dupes.push(d);
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
      // The chunk's block of positions, held below every position-paged reader until the chunk's writes have settled. Only the WRITES are
      // inside: the read-back of a duplicate is not, because everything awaited under the hold holds every reader of the space.
      await withLandingStamp(spaceId, chunk.map(d => arrivalRow(d.seq ?? 0)), async (patches) => {
        chunk.forEach((d, k) => Object.assign(landingRef(d), patches[k]!));
        if (fillOnly) {
          for (const d of chunk) {
            try {
              const r = await fillFileMetaFromStray(spaceId, d, landingRef(d));
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
            // spend the hold's time on more of the same stall. The page fails whole, to be offered again. So does a write
            // concern the deployment can never meet (Q-343), and BEFORE the document-refusal reading below: it is the
            // deployment's, so asking each document would only repeat it, and a code the refusal list shares (2, on a
            // standalone) would refuse documents that are fine.
            if (isWriteTimeout(err) || isUnsatisfiableWriteConcern(err)) throw stopped(err);
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
      }, `sync.arrive.${family}`);
      if (dupes.length > 0) {
        // Read back: a stored copy AT the planned seq is this version, landed — unless its content differs, which is
        // a divergence (`Q-232`); one above it was written meanwhile and is kept ("skipped"); anything else collided
        // on a unique index other than `_id`.
        // A family that forks is compared by BODY, so the read-back reads the body the hash is made of; any other family has none to disagree about.
        const forking = isForkingFamily(family);
        // A FILE is compared by the authored half the space hash sees (Q-426): the same seq with other content is a divergence of a file too, planned again by
        // the tie, where it used to be taken for the version that was written.
        for (const { planned: d, held: stored, relation } of await readBackDuplicates<Doc, Doc>(collName, dupes, forking ? bodyProjectionOf(family) : family === 'files' ? FILE_HASH_PROJECTION : {})) {
          const held = forking && stored ? { ...stored, bodyHash: authoredContentHash(family, stored) } : stored;
          if (!restore && relation === 'same-version' && forking && divergesFrom(family, d, held)) out.diverged.push(d._id);
          else if (!restore && relation === 'same-version' && family === 'files' && stored && fileContentHash(stored, CONVERGE_BLANKED) !== fileContentHash(d, CONVERGE_BLANKED)) out.diverged.push(d._id);
          else if (!restore && relation === 'same-version') landed.push(d);
          else if (!restore && relation === 'newer') out.newerLocal.push(d._id);
          else out.duplicates.push(d._id);
        }
      }
    } finally {
      leaveWriteUnit();
      // Forgotten AGAIN now the chunk has landed (or stopped part way): a door that built the index between the forget at the top and this write cached one
      // without the legacy ids this chunk brought back, and would keep it for the life of the process (bundle-88 review F5).
      if (restore && family === 'files') forgetLegacyIndex(spaceId);
      // The chunk is written (or the page stopped): its updates are not read again, and `updateFor` built every one of them
      // up front to size the page — kept to the end, a page would be held twice over (round V, S6).
      for (const d of chunk) { updates.delete(d._id); landingOf.delete(d._id); }
      for (const d of landed) (inserted.has(d._id) ? out.inserted : out.updated).push(d._id);
      queued.push(...landed);
      if (!opts.deferEnqueue) {
        await out.enqueue().catch((err: unknown) => log.warn(`${logSafe(where)}: ${landed.length} landed record(s) in `
          + `space '${peerText(spaceId)}' could not be queued for embedding (${logSafe(err instanceof Error ? err.message : String(err))}). `
          + EMBED_REPAIR_HINT));
      }
    }
  }
  // A NEWER version of a file supersedes the tombstones held for its path (Q-229) — only once it has landed, so a write
  // that failed keeps the deletion. A restore replaces whatever is stored and judges nothing by a tombstone.
  // Except onto a row this instance FLAGGED (`deletedAt`, `Q-257`): the merge does not clear the flag, so that row is still
  // the deletion, and the tombstone that records it stays. No sender of this release offers a flagged row; an older one's
  // is stripped of its flag on the wire, so this is the receiver's own guard, asked of the stored row, not of the document.
  if (family === 'files' && !restore) {
    const landedIds = new Set([...out.inserted, ...out.updated]);
    const landedDocs = toWrite.filter(d => landedIds.has(d._id));
    const stored = await readStoredById<{ deletedAt?: string }>(collName, landedDocs.map(d => d._id), { deletedAt: 1 });
    await supersedeFileTombstones(spaceId, landedDocs.filter(d => stored.get(d._id)?.deletedAt === undefined)
      .map(d => ({ path: d._id, seq: d.seq ?? 0 })));
  }
  if (family === 'files' && restore) {
    const flagged = toWrite.filter(d => d['deletedAt'] !== undefined).map(d => d._id);
    const landedIds = new Set([...out.inserted, ...out.updated]);
    out.flagKept = flagged.filter(id => landedIds.has(id));
    out.keysRemoved = [...removable].reduce((n, [id, keys]) => n + (landedIds.has(id) ? keys : 0), 0);
  }

  warnArrivalsNotStored(where, spaceId, family, 'refused', out.refused);
  // A repeated id is a sender's bug or a page that overlapped itself: one copy was kept, by the accept rule.
  warnArrivalsNotStored(where, spaceId, family, 'sent more than once in one page (the newest copy was kept)',
    [...new Set(out.collapsed)]);
  warnArrivalsNotStored(where, spaceId, family, 'not applied: a uniquely-indexed duplicate of a record held '
    + 'here under another id (the local copy is kept)', out.duplicates);
  return out;
}

/**
 * Adopt the AUTHOR's timestamp on file rows that already hold its content at its seq — the equal-seq convergence
 * (`Q-419`), decided by `convergesOnAuthorStamp` and written here.
 *
 * ## Why it is in this file
 *
 * This is the one writer of an arriving record, and `an-arrival-is-written-by-one-writer` holds every door to it. A
 * converge is an arrival's write even though it stores no record: a door that did it for itself would be the second
 * writer of a record collection, which is the thing that gate exists to refuse.
 *
 * ## What it writes, and what it deliberately does not
 *
 * One field. No seq is stamped — the row keeps the author's, which is the whole point, and a seq of ours would outrank
 * the author's next edit. `deliveredBy` is not rewritten: who delivered this row is not what changed. And it never
 * reaches `landed`, so no embed job is queued for a row whose content is identical and no tombstone is superseded.
 *
 * ## The filter is the race
 *
 * Between the plan's read and this write a person can edit the row, a newer copy can arrive, or a delete can flag it.
 * So the write carries everything the verdict rested on — the seq it was planned at, the author it named, the timestamp
 * it meant to replace — and refuses a flagged row. Each clause is one way the verdict can go stale in the gap; a write
 * that matched nothing simply did not converge, and the next cycle asks again.
 */
export async function convergeFileStamps(
  spaceId: string,
  rows: ReadonlyArray<{ _id: string; seq?: number; author?: { instanceId?: string }; updatedAt?: string }>,
  storedStamps: ReadonlyMap<string, string | undefined>,
): Promise<string[]> {
  if (rows.length === 0) return [];
  assertSpaceTakesWrites(spaceId, 'files');
  const coll = col<Record<string, unknown>>(spaceCollection(spaceId, 'files'));
  const converged: string[] = [];
  /*
   * ONE WRITE PER ROW, not a bulk write.
   *
   * A converge page holds only the rows that actually drifted, which is a handful on a space where this happens at
   * all — and per row the driver's own `modifiedCount` IS the answer, so nothing has to be read back to learn which
   * ones took the author's value. A bulk write would report a total and leave that question to a second read.
   */
  for (const d of rows) {
    const r = await coll.updateOne(
      asFilter({
        _id: d._id,
        seq: d.seq,
        'author.instanceId': d.author?.instanceId,
        updatedAt: storedStamps.get(d._id),
        deletedAt: { $exists: false },
      }),
      asUpdate({ $set: { updatedAt: d.updatedAt } }),
    );
    // A filter that went stale in the gap wrote nothing, which is not an error: the row changed under the verdict and
    // the next cycle asks again.
    if (r.modifiedCount > 0) converged.push(d._id);
  }
  return converged;
}
