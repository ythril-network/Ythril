/**
 * Does a held file tombstone SHADOW an arriving file? — the pure half of the answer, with no store behind it.
 *
 * `files/tombstones.ts` is the one module that reads and writes the tombstone collection, and it reads the tombstones held for an
 * arrival's paths and the live rows beside them. What those rows MEAN for an arrival — by version for metadata, by content for
 * bytes, a sidecar by its parent, which paths decide an arrival, what a door that cannot tell answers — is decided here, over
 * rows already read, so the rule can be read, tested and changed without the reads, and so the collection's module stays the
 * only one that names the collection.
 *
 * ## What it prevents
 *
 * The rule written twice. Every door a file's metadata or bytes arrive by (the metadata writer, the manifest pull, the byte
 * doors, the stray drain) asks the one predicate that lives here; a door that compared a seq or a hash of its own would be the
 * weaker copy that wins silently.
 */
import { heldTombstoneRefuses, isNewerVersionByTheIssuer } from '../sync/upsert-plan.js';
import { StoreTimeout } from '../db/write-timeout.js';
import { parentOfSidecar } from './moved-paths.js';

/** The tombstones this instance holds for a path: what an arriving file is compared with. */
export interface HeldFileTombstone { _id: string; rowSeq?: number; contentHash?: string; issuer?: string; storedVia?: string }

/** The rows of a by-path read of tombstones, grouped by path, as the comparison reads them. */
export function heldByPath(rows: ReadonlyArray<HeldFileTombstone & { path: string }>): Map<string, HeldFileTombstone[]> {
  const out = new Map<string, HeldFileTombstone[]>();
  for (const t of rows) {
    if (!out.has(t.path)) out.set(t.path, []);
    out.get(t.path)!.push({ _id: t._id, ...(t.rowSeq !== undefined ? { rowSeq: t.rowSeq } : {}), ...(t.contentHash !== undefined ? { contentHash: t.contentHash } : {}),
      ...(t.issuer !== undefined ? { issuer: t.issuer } : {}), ...(t.storedVia !== undefined ? { storedVia: t.storedVia } : {}) });
  }
  return out;
}

/** A tombstone that erased REAL content here: it carries the hash of the row it removed. One stored for a path nobody held has none. */
export const erasedContent = (t: { contentHash?: string }): boolean => typeof t.contentHash === 'string' && t.contentHash !== '';

/** Whether a tombstone erased exactly these bytes: it carries a content hash ({@link erasedContent}) and it is theirs. */
export const erasedBy = (t: { contentHash?: string }, sha256: string): boolean => erasedContent(t) && t.contentHash === sha256;

/**
 * An arriving version of a file's metadata: its seq, who wrote it and the peer the door PROVES delivered it. Without a
 * deliverer (a local or admin write, the stray drain) every held tombstone at or above the version shadows it.
 */
export interface MetaArrival { kind: 'meta'; seq: number; author?: string; deliveredBy?: string }

/** One arrival to ask about: its id, its path, and what it is — metadata at a version, or bytes with a hash. */
export type FileArrival = { id: string; path: string } & (MetaArrival | { kind: 'bytes'; sha256: string });

/** What a decision over arrivals came to: the arrivals a deletion shadows, and the ones it could not tell about. */
export interface ArrivalVerdicts {
  /** Ids a held tombstone — published, or pending with its act's bytes already gone — shadows. */
  shadowed: Set<string>;
  /** Ids a pending tombstone WOULD shadow if its act had happened, whose path could not be looked at to tell. */
  undecided: Set<string>;
  /** The first failure to look, when there is an undecided arrival. */
  cause?: unknown;
}

/**
 * Does a held file tombstone SHADOW an arriving file — by VERSION for its metadata, by CONTENT for its bytes? Pure, over
 * the tombstones held for the arrival's path (Q-229).
 *
 * A tombstone is a statement about a version of a path, not about the path for ever:
 *  - **metadata** is shadowed when some held tombstone has `rowSeq >= seq`: the arrival is the version the deletion
 *    erased, or older. A higher seq is a newer version and passes. A tombstone with no `rowSeq` (written before versions
 *    travelled) shadows no metadata, which is how it behaved and the stated limit of the release. And only a tombstone
 *    that speaks against this version's author and deliverer shadows it — the record rule, `heldTombstoneRefuses`: one
 *    another instance issued does not refuse the version its proven author delivers, and one stored for an upstream
 *    does not refuse that upstream's later version. Without it a peer could store a deletion of a path nobody held, at
 *    a high version, and refuse every later file at that path.
 *  - **bytes** are shadowed when some held tombstone's own `contentHash` equals the arriving hash and the path has not been
 *    re-created since it (`liveRowNewer`, read through {@link recreatedSince}: a live row with other bytes, or a newer version
 *    by the tombstone's issuer — identical bytes re-created by their issuer as a newer version arrive with their metadata
 *    first and pass; another author's higher seq never counts). A tombstone with no hash shadows no bytes.
 *
 * What it prevents: without the version half a deleted file's path is poisoned for ever, every later upload of it
 * refused; without the content half a peer's still-live copy of the deleted bytes comes back on every cycle.
 */
export function shadowDecision(
  held: ReadonlyArray<{ rowSeq?: number; contentHash?: string; issuer?: string; storedVia?: string }>,
  arrival: MetaArrival | { kind: 'bytes'; sha256: string; liveRowNewer: boolean },
): boolean {
  if (arrival.kind === 'meta') {
    return held.some(t => typeof t.rowSeq === 'number' && t.rowSeq >= arrival.seq
      && heldTombstoneRefuses(t, arrival.author, arrival.deliveredBy));
  }
  if (arrival.liveRowNewer) return false;
  return held.some(t => erasedBy(t, arrival.sha256));
}

/**
 * The failure of a door that cannot tell whether a delete already happened: a retryable `503`, in the one shape every door
 * answers a failure on the store's side with (`StoreTimeout` — `classifyReadFailure` answers it `503` with `Retry-After`, and the
 * sender does not remember it). Neither guess is safe: "it did not happen" stores bytes a delete erased, and "it did"
 * tells the sender the path is tombstoned for good (`200 { tombstoned: true }` is remembered until it restarts).
 */
export const cannotTellIfDeleted = (cause: unknown): StoreTimeout =>
  new StoreTimeout('Looking at a path to tell whether its file was deleted here', { cause });

/**
 * The paths whose tombstones decide arrivals at `paths`: each path, and for a SIDECAR (`_converted/<p>.md`, `_extracted/<p>/…`)
 * the file `<p>` it is a product of — its deletion is the parent's, and a sidecar has no tombstone of its own (Q-349,
 * {@link parentShadows}). The one place the parent's path is added, so every door that asks reads the same set.
 */
export function pathsDecidingArrivals(paths: readonly string[]): string[] {
  const asked = new Set(paths);
  for (const p of paths) {
    const parent = parentOfSidecar(p)?.parent;
    if (parent !== undefined) asked.add(parent);
  }
  return [...asked];
}

/**
 * What a verdict reads of the stored row at a path: its version, the hash of its bytes, whether a soft delete flagged it, who wrote
 * and delivered it. The projection to read it with is {@link STORED_ROW_PROJECTION}.
 */
export interface StoredFileRow { seq?: number; sha256?: string; deletedAt?: string; author?: { instanceId?: string }; deliveredBy?: string }

/** The fields of a stored file row that {@link recreatedSince} and {@link parentShadows} read — one projection, so a read cannot ask for less than the verdict needs. */
export const STORED_ROW_PROJECTION = { seq: 1, sha256: 1, deletedAt: 1, author: 1, deliveredBy: 1 } as const;

/**
 * Has the path a tombstone erased been RE-CREATED since? THE one answer, for the file's own bytes and for its sidecars alike.
 *
 * A LIVE row at the path (a soft-deleted one is the deletion itself, never a re-creation) whose bytes hash differently from the
 * content the tombstone erased, or one at a newer version by the tombstone's ISSUER (`isNewerVersionByTheIssuer`, which compares
 * seq only through `isNewerCopy`). Never the version alone across authors: two instances' counters are not one clock, so another
 * author's high number says nothing about whether the deleted content came back, and a peer's low-seq re-creation would otherwise
 * be outranked by this instance's high one for ever.
 *
 * **A tombstone with no hash** ({@link erasedContent} is false: one that has just ARRIVED from a peer, which names an issuer and the
 * version it erased but never the bytes — a hash is what THIS instance records when it removes a row) has nothing to compare a row's
 * bytes with, so the byte half does not speak and the answer is the version half alone: a newer version by the issuer. Without that,
 * every row with a hash would count as "re-created" for a tombstone that has none, and nothing would ever be deleted.
 *
 * What it prevents: the file's byte decision compared seq across authors while the sidecar rule did not, so the same path under the
 * same tombstone was "re-created" for one and "not" for the other (Q-407); and the peer apply (`applyPeerFileTombstones`) kept a file
 * whose seq was above the tombstone's `rowSeq` whoever wrote it — the third copy of that comparison (Q-409).
 */
export function recreatedSince(t: Pick<HeldFileTombstone, 'contentHash' | 'issuer' | 'rowSeq'>, row: StoredFileRow | undefined): boolean {
  if (row === undefined || row.deletedAt !== undefined) return false;
  if (erasedContent(t) && typeof row.sha256 === 'string' && row.sha256 !== t.contentHash) return true;
  return isNewerVersionByTheIssuer(t, row);
}

/**
 * Do the tombstones `here` held for a sidecar's parent shadow the sidecar? Pure, over the parent's stored row (`stored`, `undefined`
 * when there is none). A row a soft delete flagged is the deletion itself, not a re-creation, and speaks for nobody.
 *
 * It speaks against the parent when it **erased real content here** (the caller passes only those: {@link erasedContent}), the
 * who-half the parent's own arrival gets (`heldTombstoneRefuses`) judged by the PARENT row's author and deliverer where a live
 * one exists — never the sidecar row's, whose author is whoever delivered it, which would let every sidecar through, including
 * for a tombstone this instance issued itself — and the parent has not been **re-created** ({@link recreatedSince}).
 */
export function parentShadows(here: readonly HeldFileTombstone[], stored: StoredFileRow | undefined): boolean {
  const live = stored !== undefined && stored.deletedAt === undefined ? stored : undefined;
  return here.some(t => !recreatedSince(t, live) && heldTombstoneRefuses(t, live?.author?.instanceId, live?.deliveredBy));
}
