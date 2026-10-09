/**
 * The file-stamp report: which of this instance's file rows MAY be a stamp, and what the peers say about each (`Q-433`).
 *
 * ## The problem
 *
 * Between 4.0 and 5.5 a receiver that pulled a peer's file bytes wrote the file row under its OWN author and a fresh local
 * seq (a "stamp"). That row still sits there: the real author's later edits lose the seq compare, the deletion authority
 * reads this instance as the author, and a merkle network reports a divergence for ever. The owner's ruling (D-22, D-26) is a
 * REPORT: nothing is repaired, and a row is called "likely stamped here" only on a peer's own evidence — never on anything
 * local, because an own upload pushed to a peer is locally identical to a stamp (own author, own seq, a `syncBase` for the
 * peer). Only the peer knows who authored the file.
 *
 * ## The evidence, and why it is one walk per peer
 *
 * The peer's file-meta feed (`GET /api/sync/filemeta?full=true`) serves every live file row with its author, seq, creation
 * time and sha256, so ONE walk of it per peer answers for every candidate — a per-path ask would be a request per file. The
 * walk is the pull's own pager (`pageSeqRuns`), through the SSRF-safe client, with a body cap and a narrow schema per row;
 * paths are never sent to a peer, and only rows whose key is a local candidate are kept, in maps dropped when the run ends.
 *
 * ## What it writes
 *
 * Nothing on this instance. The one record of a call — an audit entry — is the DOORS' (`spaces/file-stamp-report-door.ts`),
 * which also own the heavy-call rail and the single flight; the walk does neither, so a caller that holds neither (a test)
 * is not throttled by a rule it did not choose.
 *
 * ## The verdict is a pure function
 *
 * {@link stampVerdict} judges one row from what it holds and what each peer said; every piece of evidence is needed, and each way
 * of lacking one has its own reason in {@link FILE_STAMP_REASONS}, so a reader of the report can tell which. The reasons are
 * FIXED strings: nothing a peer sent reaches the report except typed, re-serialised fields (an id, an integer, an ISO instant, a
 * hash).
 *
 * ## What "likely" does not say
 *
 *  - It is the peer's word. The peer is the only witness, and could claim our own file.
 *  - The same bytes created independently on both sides cannot be excluded from the data.
 *  - The peer named may itself hold a stamp of the same file (a relay): the stamp lives on every instance it reached.
 *  - A clock off by more than {@link CLOCK_TOLERANCE_MS} can turn a genuine own file into "likely", or a stamp into "cannot
 *    tell". The tolerance is this report's own and has nothing to do with `stampSkew.warnMinutes`.
 */
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { col, asFilter } from '../db/mongo.js';
import { withinHousekeepingBound } from '../db/write-bound.js';
import { spaceCollection } from '../db/space-collection.js';
import { authorRef } from '../config/author.js';
import { getSecrets } from '../config/loader.js';
import { isPeerSchemeAllowed } from '../config/transport-security.js';
import type { FileMetaDoc } from '../config/types.js';
import { boundedJson } from '../util/bounded-read.js';
import { SsrfBlockedError } from '../util/ssrf.js';
import { LIVE_FILE_ROW } from './live-file-row.js';
import { fileKeyOf } from './sandbox.js';
import { isMachineMadeSource } from './derived-fields.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { FETCH_TIMEOUT_MS } from '../sync/peer-timeouts.js';
import { pageSeqRuns } from '../sync/seq-run-pager.js';
import { syncBasePath } from '../sync/file-sync.js';
import { peerIdsCarryingSpace, peersCarryingSpace, type PeerForSpace } from '../sync/peer-for-space.js';

// ── constants ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How much earlier than ours a peer's creation time has to be before it counts as earlier: two minutes, strictly more. NTP-synced
 * servers differ by seconds; a wider figure (the board's post-stamp tolerance is forty minutes) would, with a pull every fifteen
 * minutes, rule out nearly every real stamp. One constant, no per-space override.
 */
export const CLOCK_TOLERANCE_MS = 120_000;

/** The whole run's budget across every peer and page; an `AbortSignal` over every request carries it, below any HTTP timeout. */
export const FILE_STAMP_REPORT_DEADLINE_MS = 60_000;

/** The most requests one peer's feed walk makes in one run; rows not reached by then are "not checked". */
export const MAX_FEED_PAGES_PER_PEER = 50;

/** What a feed page asks for (the feed's own ceiling), and the most bytes one answer may be: a peer decides what it sends. */
const FEED_PAGE = 500;
const FEED_PAGE_MAX_BYTES = 16 * 1024 * 1024;

/** The bounds of the caller's parameters, as the doors state them. */
export const FILE_STAMP_REPORT_MAX_LIMIT = 5000;
/** What a door asks for when the caller names no `limit`. */
export const FILE_STAMP_REPORT_DEFAULT_LIMIT = 1000;
export const FILE_STAMP_REPORT_CURSOR_MAX = 1024;

/**
 * Every way a row ends, as FIXED sentences. A reason is a constant and not a place for peer text: a report is read by an
 * operator and pasted into tickets. The unit table (`a-file-stamp-verdict-says-likely-only-on-every-piece-of-evidence`) holds
 * each of them reachable.
 */
export const FILE_STAMP_REASONS = Object.freeze({
  LIKELY: 'Likely stamped here: a peer that is itself the file\'s author holds it, created earlier, with the same bytes. '
    + 'This is the peer\'s word and not proof, and the peer may itself hold a stamp.',
  PEER_SAYS_SELF: 'Cannot tell: the peer reports this instance as the file\'s author — an own upload the peer received, '
    + 'or a stamp that already reached it.',
  RELAYED: 'Cannot tell: the peer reports a third instance as the author, so the peer may itself hold a stamp of that author\'s file.',
  PEER_ROW_INCOMPLETE: 'Cannot tell: the peer\'s record of this file names no author.',
  PEER_HOLDS_NOTHING: 'Cannot tell: no peer that shares this space reported a record of this file.',
  PEER_HOLDS_PLACEHOLDER: 'Cannot tell: the peer holds only an arrival placeholder for this file, not an authored record.',
  CREATED_NOT_EARLIER: 'Cannot tell: the peer\'s record was not created earlier than this one by more than the clock tolerance.',
  CREATED_UNPARSABLE: 'Cannot tell: a creation time could not be read.',
  HASH_UNKNOWN: 'Cannot tell: the content hash is missing here or on the peer, so the bytes cannot be compared.',
  HASH_DIFFERS: 'Cannot tell: the peer holds other bytes under this path.',
  EDITED_HERE: 'Cannot tell: this row\'s description, tags or properties were edited here and differ from the peer\'s.',
  PEERS_DISAGREE: 'Cannot tell: the peers name different authors for this file.',
  PEER_UNREACHABLE: 'Cannot tell: the peer did not answer (a timeout, a server error, a rate limit or an unreadable answer).',
  PEER_REFUSED: 'Cannot tell: the peer refused this instance\'s credentials.',
  PEER_TOO_OLD: 'Cannot tell: the peer has no file feed route, which is an older version.',
  PEER_ADDRESS_REFUSED: 'Cannot tell: the peer\'s address is refused by this instance\'s outbound-address policy.',
  NO_CREDENTIALS: 'Cannot tell: this instance holds no credentials for the peer.',
  NOT_CHECKED_BEFORE_DEADLINE: 'Cannot tell: not checked — the run\'s time or page limit ended before the peer\'s feed reached this path.',
});

/** The one sentence per rule that keeps a row out of the report. No path, no count. */
export const FILE_STAMP_RULES: readonly string[] = Object.freeze([
  'Only live files this instance authored are listed: a file another instance authored is never listed, because an edit made '
  + 'here to it cannot be told from a legitimate local edit.',
  'Only files with a sync base recorded for a peer that shares this space are listed: a file moved or renamed here, or whose '
  + 'recorded peer no longer shares the space, is not.',
  'Deleted files and the pieces a file was split into are never listed, and a file deleted while the report ran is dropped.',
  'A peer is asked only through a network that currently carries this space, and only for its file feed: no path is sent to it.',
]);

// ── the verdict (pure) ──────────────────────────────────────────────────────────────────────────────────────────────

/** Why a peer could not give evidence. */
export type StampFailure = 'unreachable' | 'refused' | 'too-old' | 'address-refused' | 'no-credentials' | 'not-checked';

/** What this instance's row holds, as the verdict reads it. */
export interface StampOurs {
  seq?: number | undefined;
  createdAt?: string | undefined;
  sha256?: string | undefined;
  description?: string | undefined;
  descriptionSource?: string | undefined;
  tags?: readonly string[] | undefined;
  properties?: Record<string, unknown> | undefined;
}

/** What one peer's file feed holds for the same path. `author` is the author's instance id. */
export interface PeerFeedRow {
  author?: string | undefined;
  seq?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  sha256?: string | undefined;
  description?: string | undefined;
  tags?: readonly string[] | undefined;
  properties?: Record<string, unknown> | undefined;
}

/** One peer asked: its row, or why it gave none; an entry with neither says the peer holds nothing for the path. */
export interface PeerEvidence {
  peerId: string;
  row?: PeerFeedRow | undefined;
  failure?: StampFailure | undefined;
}

export type StampVerdictKind = 'likely-stamped-here' | 'cannot-tell';

export interface StampVerdict {
  verdict: StampVerdictKind;
  reason: string;
  /** The peer whose evidence made it likely; absent otherwise. */
  peerId?: string;
}

const FAILURE_REASON: Readonly<Record<StampFailure, string>> = Object.freeze({
  'unreachable': FILE_STAMP_REASONS.PEER_UNREACHABLE,
  'refused': FILE_STAMP_REASONS.PEER_REFUSED,
  'too-old': FILE_STAMP_REASONS.PEER_TOO_OLD,
  'address-refused': FILE_STAMP_REASONS.PEER_ADDRESS_REFUSED,
  'no-credentials': FILE_STAMP_REASONS.NO_CREDENTIALS,
  'not-checked': FILE_STAMP_REASONS.NOT_CHECKED_BEFORE_DEADLINE,
});

/** An ISO-shaped instant in ms, or `undefined` for anything else: `Date.parse` alone reads "2026" and "1" as dates. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function instantOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 64 || !INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** A sha256 as lowercase hex, or `undefined` for anything else (an absent hash is never a match, on either side). */
const SHA256_HEX = /^[0-9a-f]{64}$/i;
function hashOf(value: unknown): string | undefined {
  return typeof value === 'string' && SHA256_HEX.test(value) ? value.toLowerCase() : undefined;
}

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const hasEntries = (v: unknown): boolean => typeof v === 'object' && v !== null && Object.keys(v).length > 0;

/**
 * Whether the row's content is something a person did HERE: a description not made from the bytes that differs from the peer's, or
 * tags or properties that differ from the peer's. A row that only holds what the peer holds (the 5.6.3 stray-metadata drain copied
 * the publisher's words onto the receiver's row) was edited by nobody here, and a row with no content of its own was not either.
 */
function editedHere(ours: StampOurs, peer: PeerFeedRow): boolean {
  if (hasText(ours.description) && !isMachineMadeSource(ours.descriptionSource) && ours.description !== peer.description) return true;
  if (ours.tags !== undefined && ours.tags.length > 0 && !isDeepStrictEqual(ours.tags, peer.tags)) return true;
  if (hasEntries(ours.properties) && !isDeepStrictEqual(ours.properties, peer.properties)) return true;
  return false;
}

interface Judged {
  peerId: string;
  likely: boolean;
  reason: string;
  /** The non-self author this peer's row names, if it names one. */
  author?: string;
  /** How informative the reason is when nothing is likely: a row's own content, then "self", then a failure, then nothing. */
  rank: number;
}

function judgePeer(selfId: string, ours: StampOurs, e: PeerEvidence): Judged {
  const R = FILE_STAMP_REASONS;
  const out = (reason: string, rank: number, extra: Partial<Judged> = {}): Judged => ({ peerId: e.peerId, likely: false, reason, rank, ...extra });
  if (e.failure !== undefined) return out(FAILURE_REASON[e.failure], 2);
  const row = e.row;
  if (row === undefined) return out(R.PEER_HOLDS_NOTHING, 3);
  if (!hasText(row.author)) return out(R.PEER_ROW_INCOMPLETE, 0);
  if (row.author === selfId) return out(R.PEER_SAYS_SELF, 1);
  const named = { author: row.author };
  if (row.author !== e.peerId) return out(R.RELAYED, 0, named);
  if (!(typeof row.seq === 'number' && Number.isInteger(row.seq) && row.seq > 0)) return out(R.PEER_HOLDS_PLACEHOLDER, 0, named);
  const oursAt = instantOf(ours.createdAt);
  const theirsAt = instantOf(row.createdAt);
  if (oursAt === undefined || theirsAt === undefined) return out(R.CREATED_UNPARSABLE, 0, named);
  if (!(oursAt - theirsAt > CLOCK_TOLERANCE_MS)) return out(R.CREATED_NOT_EARLIER, 0, named);
  const oursHash = hashOf(ours.sha256);
  const theirsHash = hashOf(row.sha256);
  if (oursHash === undefined || theirsHash === undefined) return out(R.HASH_UNKNOWN, 0, named);
  if (oursHash !== theirsHash) return out(R.HASH_DIFFERS, 0, named);
  if (editedHere(ours, row)) return out(R.EDITED_HERE, 0, named);
  return { peerId: e.peerId, likely: true, reason: R.LIKELY, author: row.author, rank: 0 };
}

/**
 * The verdict on one row. PURE, and it throws on an absent `selfId`: "the peer's author is not us" would be true of every
 * author-less row.
 *
 * Combining peers: a peer that says "author self", is unreachable, or holds nothing gives no evidence. "Likely" needs at least
 * one peer giving likely evidence and no peer naming a DIFFERENT non-self author (that is "the peers disagree"). When nothing
 * is likely the reason is the most informative one the peers gave.
 */
export function stampVerdict(input: { selfId: string; ours: StampOurs; evidence: readonly PeerEvidence[] }): StampVerdict {
  const { selfId, ours, evidence } = input;
  if (typeof selfId !== 'string' || selfId === '') throw new TypeError('stampVerdict: selfId is required — without it every author-less row reads as "not us"');
  const judged = evidence.map(e => judgePeer(selfId, ours, e));
  const likely = judged.find(j => j.likely);
  if (likely !== undefined) {
    const authors = new Set(judged.flatMap(j => (j.author !== undefined ? [j.author] : [])));
    if (authors.size > 1) return { verdict: 'cannot-tell', reason: FILE_STAMP_REASONS.PEERS_DISAGREE };
    return { verdict: 'likely-stamped-here', reason: FILE_STAMP_REASONS.LIKELY, peerId: likely.peerId };
  }
  const best = judged.reduce<Judged | undefined>((a, j) => (a === undefined || j.rank < a.rank ? j : a), undefined);
  return { verdict: 'cannot-tell', reason: best?.reason ?? FILE_STAMP_REASONS.PEER_HOLDS_NOTHING };
}

// ── the peer's feed ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A feed walk that could not give evidence, with the reason it could not. Thrown inside a walk, answered by `walkFeed`. */
class FeedFailure extends Error {
  constructor(readonly failure: StampFailure) { super(failure); this.name = 'FeedFailure'; }
}

/** An id as a peer names it: bounded and plain, so no peer text but an identifier can reach a report. */
const ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const idOf = z.string().regex(ID);

/** What the report reads of one served row: each field typed and bounded on its own, a malformed one becoming "absent". */
const FeedRow = z.object({
  _id: z.string().min(1).max(4096),
  author: z.object({ instanceId: idOf }).optional().catch(undefined),
  seq: z.number().int().nonnegative().optional().catch(undefined),
  createdAt: z.string().max(64).optional().catch(undefined),
  updatedAt: z.string().max(64).optional().catch(undefined),
  sha256: z.string().max(128).optional().catch(undefined),
  description: z.string().optional().catch(undefined),
  tags: z.array(z.string()).optional().catch(undefined),
  properties: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

/** A key a candidate and a peer's row are matched by, or `null` for a path that has none (it leaves the space). */
function keyOf(spaceId: string, path: string): string | null {
  try { return fileKeyOf(spaceId, path).key; } catch { return null; }
}

/** What a run holds about its clock and its budget. */
interface RunClock {
  startedMs: number;
  deadlineMs: number;
  now: () => number;
  /** Aborts every request at the deadline, whatever the injected clock says. */
  signal: AbortSignal;
}

const expired = (c: RunClock): boolean => c.signal.aborted || c.now() - c.startedMs >= c.deadlineMs;

const failureOfStatus = (status: number): StampFailure => (status === 401 || status === 403 ? 'refused' : status === 404 ? 'too-old' : 'unreachable');

/** What an error from the client means for the rows: a refused address, the deadline, or an unreachable peer. */
function failureOfError(err: unknown, clock: RunClock): StampFailure {
  if (err instanceof FeedFailure) return err.failure;
  if (err instanceof SsrfBlockedError) return 'address-refused';
  return expired(clock) ? 'not-checked' : 'unreachable';
}

/** The sentinel a walk's delivery returns when every wanted key has an answer, so the pager stops without reading on. */
const ALL_ANSWERED = 'every wanted file has been answered';

/**
 * Walk one peer's file feed through one network, adding to `found` the row of every key in `wanted` the feed serves. Returns why
 * it could not finish, or `undefined` when it read to the end (or until every wanted key was answered). No retry: the first
 * failure ends the walk, and the caller's answer for what it did not reach is that failure.
 */
async function walkFeed(
  spaceId: string, target: PeerForSpace, token: string, wanted: ReadonlySet<string>, found: Map<string, PeerFeedRow>, clock: RunClock,
): Promise<StampFailure | undefined> {
  if (!isPeerSchemeAllowed(target.member.url)) return 'address-refused';
  const outcome = { deliveredThrough: 0, truncated: false };
  let pages = 0;
  let answered = false;
  const headers = { 'Authorization': `Bearer ${token}` };
  try {
    await pageSeqRuns({
      outcome,
      limit: FEED_PAGE,
      maxPages: MAX_FEED_PAGES_PER_PEER,
      fetch: async (ask, limit) => {
        if (expired(clock)) throw new FeedFailure('not-checked');
        pages++;
        const params = new URLSearchParams({
          spaceId: target.remoteSpaceId, networkId: target.networkId, sinceSeq: String(ask.sinceSeq), limit: String(limit), full: 'true',
          ...(ask.cursor ? { cursor: ask.cursor } : {}),
        });
        // A fresh signal per request: one shared across sequential asks would starve the later ones.
        const signal = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), clock.signal]);
        const resp = await peerSafeFetch(`${target.member.url}/api/sync/filemeta?${params}`, { headers, signal }, { streamBody: true });
        if (!resp.ok) {
          await resp.body?.cancel().catch(() => {});
          throw new FeedFailure(failureOfStatus(resp.status));
        }
        const page = await boundedJson<unknown>(resp, 'file stamp feed', FEED_PAGE_MAX_BYTES);
        if (typeof page !== 'object' || page === null) throw new FeedFailure('unreachable');
        const { items, nextCursor } = page as { items?: unknown; nextCursor?: unknown };
        return {
          groups: [Array.isArray(items) ? items.filter(it => !(it && typeof it === 'object' && (it as { deletedAt?: unknown }).deletedAt)) : []],
          nextCursor: typeof nextCursor === 'string' ? nextCursor : nextCursor === null ? null : undefined,
        };
      },
      admit: (raw) => {
        const { _id: id, seq } = (raw ?? {}) as { _id?: unknown; seq?: unknown };
        return typeof id === 'string' && id !== '' && typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? { seq, key: id } : null;
      },
      deliver: async (fresh) => {
        for (const raw of fresh) {
          const parsed = FeedRow.safeParse(raw);
          if (!parsed.success) continue;
          const key = keyOf(spaceId, parsed.data._id);
          if (key === null || !wanted.has(key)) continue;
          const d = parsed.data;
          found.set(key, {
            author: d.author?.instanceId, seq: d.seq, createdAt: d.createdAt, updatedAt: d.updatedAt,
            sha256: d.sha256, description: d.description, tags: d.tags, properties: d.properties,
          });
        }
        if ([...wanted].every(k => found.has(k))) { answered = true; return ALL_ANSWERED; }
        return null;
      },
      stopped: () => { /* the walk's answer is its return value: a stop is a failure to read on, said per row */ },
    });
  } catch (err) {
    return failureOfError(err, clock);
  }
  if (answered || !outcome.truncated) return undefined;
  return pages >= MAX_FEED_PAGES_PER_PEER ? 'not-checked' : 'unreachable';
}

/**
 * What one peer says of the wanted keys: rows found, and why the rest were not reached. The networks through which the peer may
 * be asked are tried in the order the resolver gives; a network that fails is not asked again, and the next is tried unless the
 * failure is one a second network cannot change (no credentials; the run's own time or page limit).
 */
async function askPeer(
  spaceId: string, peerId: string, wanted: ReadonlySet<string>, clock: RunClock,
): Promise<{ found: Map<string, PeerFeedRow>; failure?: StampFailure }> {
  const found = new Map<string, PeerFeedRow>();
  const token = getSecrets().peerTokens[peerId];
  if (!token) return { found, failure: 'no-credentials' };
  let first: StampFailure | undefined;
  for (const target of peersCarryingSpace(spaceId, peerId)) {
    const failure = await walkFeed(spaceId, target, token, wanted, found, clock);
    if (failure === undefined) return { found };
    first ??= failure;
    if (failure === 'not-checked') break;
  }
  return first === undefined ? { found } : { found, failure: first };
}

// ── the report ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FileStampRow {
  path: string;
  verdict: StampVerdictKind;
  reason: string;
  ours: { seq: number; createdAt?: string; updatedAt?: string; sha256?: string };
  peer?: { instanceId: string; author?: string; seq?: number; createdAt?: string; updatedAt?: string; sha256?: string };
}

export interface FileStampAnswer {
  space: string;
  startedAt: string;
  candidates: number;
  checked: number;
  likely: number;
  cannotTell: number;
  truncated: boolean;
  nextAfter?: string;
  rows: FileStampRow[];
  rules: string[];
}

/** The row a candidate is read as: only the keys the verdict and the report read, never `deliveredBy` or a vector. */
type CandidateDoc = Pick<FileMetaDoc, '_id' | 'seq' | 'createdAt' | 'updatedAt' | 'sha256' | 'description' | 'descriptionSource' | 'tags' | 'properties'>
  & { syncBase?: Record<string, unknown> };

/** An instant re-serialised from what was read (never forwarded as written), or `undefined` when it is not one. */
function isoOf(value: unknown): string | undefined {
  const ms = instantOf(value);
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

const integerOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

function oursOf(doc: CandidateDoc): StampOurs {
  return {
    seq: doc.seq, createdAt: doc.createdAt, sha256: doc.sha256, description: doc.description,
    descriptionSource: doc.descriptionSource, tags: doc.tags, properties: doc.properties as Record<string, unknown> | undefined,
  };
}

/** Which row's evidence the report prints: the likely peer's, else the first peer that held a row. */
function shownPeer(verdict: StampVerdict, evidence: readonly PeerEvidence[]): { peerId: string; row: PeerFeedRow } | undefined {
  const pick = verdict.peerId !== undefined ? evidence.find(e => e.peerId === verdict.peerId) : evidence.find(e => e.row !== undefined);
  return pick?.row === undefined ? undefined : { peerId: pick.peerId, row: pick.row };
}

function rowOf(doc: CandidateDoc, verdict: StampVerdict, evidence: readonly PeerEvidence[]): FileStampRow {
  const createdAt = isoOf(doc.createdAt);
  const updatedAt = isoOf(doc.updatedAt);
  const sha256 = hashOf(doc.sha256);
  const shown = shownPeer(verdict, evidence);
  const peer = shown === undefined ? undefined : {
    instanceId: shown.peerId,
    ...(shown.row.author !== undefined ? { author: shown.row.author } : {}),
    ...(integerOf(shown.row.seq) !== undefined ? { seq: integerOf(shown.row.seq) as number } : {}),
    ...(isoOf(shown.row.createdAt) !== undefined ? { createdAt: isoOf(shown.row.createdAt) as string } : {}),
    ...(isoOf(shown.row.updatedAt) !== undefined ? { updatedAt: isoOf(shown.row.updatedAt) as string } : {}),
    ...(hashOf(shown.row.sha256) !== undefined ? { sha256: hashOf(shown.row.sha256) as string } : {}),
  };
  return {
    path: String(doc._id), verdict: verdict.verdict, reason: verdict.reason,
    ours: {
      seq: integerOf(doc.seq) ?? 0,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(sha256 !== undefined ? { sha256 } : {}),
    },
    ...(peer !== undefined ? { peer } : {}),
  };
}

/**
 * The candidates, ascending by path: LIVE files this instance authored that record a sync base for some peer that currently
 * shares the space. `take` is the limit plus one, so a full page that ends the space is not called truncated. A read under the
 * store bound: `syncBase` is not indexed, so `take` bounds the rows returned and not the rows scanned.
 */
async function readCandidates(spaceId: string, self: string, peerIds: readonly string[], after: string | undefined, take: number): Promise<CandidateDoc[]> {
  if (peerIds.length === 0) return [];
  const filter = {
    ...LIVE_FILE_ROW,
    'author.instanceId': self,
    $or: peerIds.map(p => ({ [syncBasePath(p)]: { $exists: true } })),
    ...(after !== undefined ? { _id: { $gt: after } } : {}),
  };
  const projection = {
    _id: 1, seq: 1, createdAt: 1, updatedAt: 1, sha256: 1, description: 1, descriptionSource: 1, tags: 1, properties: 1,
    ...Object.fromEntries(peerIds.map(p => [syncBasePath(p), 1])),
  };
  return withinHousekeepingBound(() => col<CandidateDoc>(spaceCollection(spaceId, 'files'))
    .find(asFilter<CandidateDoc>(filter), { projection }).sort({ _id: 1 }).limit(take).toArray() as Promise<CandidateDoc[]>);
}

/** The ids among `ids` that are still live files of this instance: a row deleted or replaced since it was read is not reported. */
async function stillCandidates(spaceId: string, self: string, ids: readonly string[]): Promise<Set<string>> {
  const rows = await withinHousekeepingBound(() => col<{ _id: string }>(spaceCollection(spaceId, 'files'))
    .find(asFilter<{ _id: string }>({ ...LIVE_FILE_ROW, 'author.instanceId': self, _id: { $in: ids } }), { projection: { _id: 1 } }).toArray());
  return new Set(rows.map(r => String(r._id)));
}

/**
 * The report for one space. Reads the candidates (one page: `limit` rows after `after`), walks each peer that shares the space and
 * holds a base for any of them, and judges every candidate. Every candidate in the answer has a verdict: a row the run could not
 * reach says why, and `candidates === checked + the rows not checked before the deadline`.
 *
 * @param o.limit what an answer holds at most (1 to {@link FILE_STAMP_REPORT_MAX_LIMIT}); `truncated` says a `limit + 1` read found more
 * @param o.after the last path of the previous answer (`nextAfter`)
 * @param o.deadlineMs the whole run's budget; a test seam, the doors take the default
 * @param o.now the clock; a test seam
 */
export async function fileStampReport(
  spaceId: string,
  o: { limit: number; after?: string | undefined; deadlineMs?: number | undefined; now?: (() => number) | undefined },
): Promise<FileStampAnswer> {
  const { limit, after } = o;
  if (!Number.isInteger(limit) || limit < 1 || limit > FILE_STAMP_REPORT_MAX_LIMIT) throw new RangeError(`limit must be an integer from 1 to ${FILE_STAMP_REPORT_MAX_LIMIT}`);
  if (after !== undefined && (typeof after !== 'string' || after.length > FILE_STAMP_REPORT_CURSOR_MAX)) throw new RangeError(`after must be a string of at most ${FILE_STAMP_REPORT_CURSOR_MAX} characters`);
  const self = authorRef().instanceId;
  if (typeof self !== 'string' || self === '') throw new Error('file stamp report: this instance has no instance id, so no row can be called its own');
  const now = o.now ?? Date.now;
  const deadlineMs = o.deadlineMs ?? FILE_STAMP_REPORT_DEADLINE_MS;
  const startedMs = now();
  const clock: RunClock = { startedMs, deadlineMs, now, signal: AbortSignal.timeout(deadlineMs) };

  const peerIds = peerIdsCarryingSpace(spaceId).filter(id => id !== self);
  const read = await readCandidates(spaceId, self, peerIds, after, limit + 1);
  const truncated = read.length > limit;
  const page = truncated ? read.slice(0, limit) : read;

  // What each peer is asked for: the keys of the candidates that record a base for it.
  const keys = new Map<string, string | null>(page.map(d => [String(d._id), keyOf(spaceId, String(d._id))]));
  const peersOf = (d: CandidateDoc): string[] => peerIds.filter(p => d.syncBase !== undefined && Object.hasOwn(d.syncBase, p));
  const wantedBy = new Map<string, Set<string>>();
  for (const d of page) {
    const key = keys.get(String(d._id));
    for (const p of peersOf(d)) {
      if (key === null || key === undefined) continue;
      (wantedBy.get(p) ?? wantedBy.set(p, new Set()).get(p) as Set<string>).add(key);
    }
  }

  // Peers one at a time, in id order: the walk is the instance's bandwidth and every peer's, and a fixed order is a stable answer.
  const answers = new Map<string, { found: Map<string, PeerFeedRow>; failure?: StampFailure }>();
  for (const peerId of peerIds) {
    const wanted = wantedBy.get(peerId);
    if (wanted !== undefined && wanted.size > 0) answers.set(peerId, await askPeer(spaceId, peerId, wanted, clock));
  }

  // A file deleted (or replaced by another author's) between the read and the verdict is not reported.
  const live = await stillCandidates(spaceId, self, page.map(d => String(d._id)));
  const rows: FileStampRow[] = [];
  for (const d of page) {
    if (!live.has(String(d._id))) continue;
    const key = keys.get(String(d._id)) ?? null;
    const evidence: PeerEvidence[] = peersOf(d).map(peerId => {
      const answer = answers.get(peerId);
      const row = key === null ? undefined : answer?.found.get(key);
      if (row !== undefined) return { peerId, row };
      return answer?.failure !== undefined ? { peerId, failure: answer.failure } : { peerId };
    });
    rows.push(rowOf(d, stampVerdict({ selfId: self, ours: oursOf(d), evidence }), evidence));
  }

  const notChecked = rows.filter(r => r.reason === FILE_STAMP_REASONS.NOT_CHECKED_BEFORE_DEADLINE).length;
  const likely = rows.filter(r => r.verdict === 'likely-stamped-here').length;
  const last = page.at(-1);
  return {
    space: spaceId,
    startedAt: new Date(startedMs).toISOString(),
    candidates: rows.length,
    checked: rows.length - notChecked,
    likely,
    cannotTell: rows.length - likely,
    truncated,
    ...(truncated && last !== undefined ? { nextAfter: String(last._id) } : {}),
    rows,
    rules: [...FILE_STAMP_RULES],
  };
}
