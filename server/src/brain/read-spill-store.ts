/**
 * Where a read result that did not fit goes: an instance store OUTSIDE every space.
 *
 * ## The defect this exists to end (Q-92)
 *
 * A recall whose traversal outgrew the inline cap, or whose remainder the caller asked to keep, used to be
 * written INTO the seed's space: a blob under `_tmp/`, a `<space>_files` record, a seq bump that made the
 * record sync to every peer, and an embed job for the search's own output. A token holding only
 * `knowledge: read` changed a space by searching it, and any `files: read` token could list `_tmp` and read
 * every other caller's spill. Owner, 2026-09-27: *"i somewhere read a search can modify data? sounds like a
 * huge bug and security issue to me!"* The rest of the 2026-08-13 ruling stands — the complete result, a
 * download link, a one-day lifetime, the caller's own token required. Only the LOCATION moved.
 *
 * ## What this module guarantees, so no caller has to remember it
 *
 * - **It writes two collections and nothing else.** `_read_spills` holds one header per spill,
 *   `_read_spill_pages` holds its items as gzip pages. Neither is a `<spaceId>_<suffix>` collection, so sync
 *   never reads them; `db/dump.ts` leaves them out, so no backup carries a copy that outlives the day.
 * - **A spill belongs to the token that caused it.** No issuer, no spill. Its member spaces are derived from
 *   its OWN items, never taken from the caller: the read check has to cover every space whose records are
 *   inside, and a list handed in is a list that can be short.
 * - **A reader never sees a partial spill.** Pages are written first and the header last; deletion goes the
 *   other way. A page missing under a live header is reported as gone (410), never served short.
 * - **Someone else's spill is indistinguishable from none.** Another token, an unknown id and an expired
 *   spill get the same 404; only the owner learns that its spill was evicted (410).
 * - **A token pays for its own spills.** Past its share it evicts its OWN oldest; a spill larger than the
 *   whole share, or one that would pass the instance ceiling, is refused before it is serialised in full.
 *   The ceiling never evicts another caller's spill. A refusal is RETURNED, not thrown: every caller turns
 *   it into `spillRefused` on an answer that still carries `truncated` and `nextSkip`.
 * - **No vector is stored.** The strip runs here, on every item, whichever kind of spill it is.
 *
 * ## Why pages, and why the item is the unit
 *
 * One gzip stream cannot be read from the middle, so paging a single blob would inflate and parse the whole
 * spill for every window — a large spill read page by page is quadratic. Pages are cut on ITEM boundaries
 * (a result match with its `_graph`, or one graph node) at write time, so a window decodes only the pages it
 * touches and an item is never split between two.
 */
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { Binary } from 'mongodb';
import { col, getDb } from '../db/mongo.js';
import { ensureExpiryIndex } from '../db/expiry-index.js';
import { envInt } from '../config/env-num.js';
import { UUID_V4_RE } from './entity-refs.js';
import { NEVER_RETURNED_FIELDS } from './recall-shape.js';
import { budgetMeter } from './result-budget.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const READ_SPILL_HEADERS = '_read_spills';
export const READ_SPILL_PAGES = '_read_spill_pages';

/** Every collection this store owns — what `db/dump.ts` leaves out. */
export const READ_SPILL_COLLECTIONS: readonly string[] = [READ_SPILL_HEADERS, READ_SPILL_PAGES];

/** How many days a spill lives. The owner's ruling (2026-08-13). */
export const SPILL_TTL_DAYS = 1;

/** A page's raw JSON ceiling. Only a single item larger than this may make a larger page. */
export const PAGE_RAW_BYTES = 256 * 1024;

const MIB = 1024 * 1024;

/** The caps, read per call so a test or an operator's env is what applies. Validated at boot (`env-num.ts`). */
function caps() {
  return {
    shareBytes: envInt('READ_SPILL_TOKEN_MAX_MB', 64) * MIB,
    shareCount: envInt('READ_SPILL_TOKEN_MAX_COUNT', 50),
    ceilingBytes: envInt('READ_SPILL_INSTANCE_MAX_MB', 1024) * MIB,
  };
}

export type SpillKind = 'results' | 'graph';

interface SpillHeader {
  _id: string;
  kind: SpillKind;
  issuedTo: string;
  memberSpaceIds: string[];
  /** How many items the spill holds. */
  items: number;
  rawBytes: number;
  createdAt: Date;
  expiresAt: Date;
  request: Record<string, unknown>;
  ceilingHit?: boolean;
  /** Set when the owner's share evicted it: the pages are gone, the header stays until `expiresAt` for the 410. */
  evicted?: boolean;
}

interface SpillPage {
  _id: string;
  spillId: string;
  /** Ordinal of the page's first item within the spill. */
  index: number;
  count: number;
  body: Binary;
  rawBytes: number;
  expiresAt: Date;
}

const headers = () => col<SpillHeader>(READ_SPILL_HEADERS);
const pages = () => col<SpillPage>(READ_SPILL_PAGES);

/**
 * Keys whose values are vectors, removed at every depth before anything is stored.
 *
 * `NEVER_RETURNED_FIELDS` is the base — what no read returns — and the rest are what a spill must not carry
 * even where another door may: `faceEmbedding` is a biometric descriptor the face tools read deliberately, and
 * a search dump is not that door. Named, not matched by pattern: `suppressEmbeddings` is a record's own flag and
 * must survive, and `embeddingModel` is a name, not a vector.
 */
const VECTOR_KEYS = new Set([
  ...NEVER_RETURNED_FIELDS, 'embeddings', 'vector', 'vectors', 'contentEmbedding', 'faceEmbedding',
]);

/** Deep copy without any vector field, and without touching the caller's objects. */
export function suppressEmbeddings<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => suppressEmbeddings(v)) as unknown as T;
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (VECTOR_KEYS.has(k)) continue;
    out[k] = suppressEmbeddings(v);
  }
  return out as unknown as T;
}

/**
 * Every space whose records an item carries: its own `spaceId`, and any nested `_graph` node's.
 * `null` when the item itself names none — a spill whose read check cannot be stated is refused.
 */
function spacesOf(item: unknown, into: Set<string>): boolean {
  if (item === null || typeof item !== 'object') return false;
  const own = (item as { spaceId?: unknown }).spaceId;
  if (typeof own !== 'string' || own.length === 0) return false;
  into.add(own);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v === null || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'spaceId' && typeof x === 'string' && x.length > 0) into.add(x);
      else walk(x);
    }
  };
  walk((item as { _graph?: unknown })._graph);
  walk((item as { record?: unknown }).record);
  return true;
}

export interface PutSpillInput {
  kind: SpillKind;
  /** The token id of the caller that caused it. Absent means no spill — there would be nobody to hand it to. */
  issuedTo: string | null | undefined;
  items: readonly unknown[];
  /** What the caller asked for, echoed so the spill describes itself a day later. */
  request: Record<string, unknown>;
  ceilingHit?: boolean;
}

export type PutSpillResult =
  | { id: string; expiresAt: string; items: number; rawBytes: number }
  | { refused: string };

/**
 * Serialise items into pages of whole items, stopping the moment the share is passed — so a spill larger
 * than the share is refused having paid for the items up to the share, not for all of them.
 */
function paginate(items: readonly unknown[], shareBytes: number):
  { pages: { index: number; count: number; json: string }[]; rawBytes: number } | { over: true } {
  const out: { index: number; count: number; json: string }[] = [];
  let parts: string[] = [];
  let partBytes = 2;
  let first = 0;
  let total = 0;
  const flush = () => {
    if (parts.length === 0) return;
    const json = `[${parts.join(',')}]`;
    out.push({ index: first, count: parts.length, json });
    total += Buffer.byteLength(json, 'utf8');
    first += parts.length;
    parts = [];
    partBytes = 2;
  };
  for (const item of items) {
    const s = JSON.stringify(item);
    const b = Buffer.byteLength(s, 'utf8');
    if (parts.length > 0 && partBytes + b + 1 > PAGE_RAW_BYTES) flush();
    parts.push(s);
    partBytes += b + (parts.length > 1 ? 1 : 0);
    if (total + partBytes > shareBytes) return { over: true };
  }
  flush();
  return { pages: out, rawBytes: total };
}

/** Bytes currently held, live spills only, summed from the headers. */
async function heldBytes(match: Record<string, unknown>): Promise<number> {
  const agg = await headers().aggregate<{ n: number }>([
    { $match: { ...match, evicted: { $ne: true }, expiresAt: { $gt: new Date() } } },
    { $group: { _id: null, n: { $sum: '$rawBytes' } } },
  ]).toArray();
  return agg[0]?.n ?? 0;
}

/**
 * Keep one read result that did not fit, for the token that caused it. See the module note for every rule.
 */
export async function putSpill(input: PutSpillInput): Promise<PutSpillResult> {
  const issuedTo = input.issuedTo;
  if (typeof issuedTo !== 'string' || issuedTo.length === 0) {
    return { refused: 'no-token: a spill belongs to the token that caused it, and this call has none' };
  }
  const members = new Set<string>();
  if (input.items.length === 0) return { refused: 'empty: there is nothing to keep' };
  for (const item of input.items) {
    if (!spacesOf(item, members)) {
      return { refused: 'unattributed: an item names no space, so who may read the spill cannot be decided' };
    }
  }

  const { shareBytes, shareCount, ceilingBytes } = caps();
  // The vector strip, on every item, before anything is measured or stored.
  const cut = paginate(input.items.map(i => suppressEmbeddings(i)), shareBytes);
  if ('over' in cut) {
    return { refused: `over-share: larger than one token's share (READ_SPILL_TOKEN_MAX_MB=${shareBytes / MIB})` };
  }

  // The ceiling counts what the instance holds for OTHER callers plus what this token keeps after evicting
  // its own oldest to make room — so a token at its share is never refused for its own spills.
  const others = await heldBytes({ issuedTo: { $ne: issuedTo } });
  const own = await ownLive(issuedTo);
  let ownKept = own.reduce((n, h) => n + h.rawBytes, 0);
  let ownCount = own.length;
  for (const h of own) {
    if (ownKept + cut.rawBytes <= shareBytes && ownCount + 1 <= shareCount) break;
    ownKept -= h.rawBytes;
    ownCount -= 1;
  }
  if (others + ownKept + cut.rawBytes > ceilingBytes) {
    return { refused: `instance-ceiling: the instance holds its maximum of read spills (READ_SPILL_INSTANCE_MAX_MB=${ceilingBytes / MIB})` };
  }

  const id = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SPILL_TTL_DAYS * 86_400_000);
  const docs: SpillPage[] = [];
  for (const p of cut.pages) {
    const body = await gzipAsync(Buffer.from(p.json, 'utf8'));
    docs.push({
      _id: `${id}:${p.index}`, spillId: id, index: p.index, count: p.count,
      body: new Binary(body), rawBytes: Buffer.byteLength(p.json, 'utf8'), expiresAt,
    });
  }
  // Pages FIRST, header LAST: a reader finds the header only once every page it names exists.
  await pages().insertMany(docs, { ordered: true });
  await headers().insertOne({
    _id: id, kind: input.kind, issuedTo, memberSpaceIds: [...members].sort(),
    items: input.items.length, rawBytes: cut.rawBytes, createdAt, expiresAt,
    request: input.request,
    ...(input.ceilingHit ? { ceilingHit: true } : {}),
  });

  // After the insert, and in a loop: two concurrent puts by one token both converge under the share.
  await evictOwnOverShare(issuedTo, shareBytes, shareCount);

  return { id, expiresAt: expiresAt.toISOString(), items: input.items.length, rawBytes: cut.rawBytes };
}

async function ownLive(issuedTo: string): Promise<{ _id: string; rawBytes: number }[]> {
  return headers().find(
    { issuedTo, evicted: { $ne: true }, expiresAt: { $gt: new Date() } },
    { projection: { _id: 1, rawBytes: 1 }, sort: { createdAt: 1, _id: 1 } },
  ).toArray() as Promise<{ _id: string; rawBytes: number }[]>;
}

async function evictOwnOverShare(issuedTo: string, shareBytes: number, shareCount: number): Promise<void> {
  const own = await ownLive(issuedTo);
  let bytes = own.reduce((n, h) => n + h.rawBytes, 0);
  let count = own.length;
  for (const h of own) {
    if (bytes <= shareBytes && count <= shareCount) break;
    // Header first: from this moment the owner reads 410 and nobody reads a half-deleted spill.
    await headers().updateOne({ _id: h._id }, { $set: { evicted: true } });
    await pages().deleteMany({ spillId: h._id });
    bytes -= h.rawBytes;
    count -= 1;
  }
}

export interface ReadSpillRequest {
  id: string;
  issuedTo: string | null | undefined;
  skip?: number;
  /** Ceiling on the window in UTF-8 bytes. */
  maxBytes?: number | null;
  /** Ceiling on the window in characters. */
  maxChars?: number | null;
  /**
   * The caller's rights over the spill's member spaces, asked before anything is decoded. A `false` is the
   * same 404 as an unknown id. Absent means only the issuer check applies (the store's own tests).
   */
  mayRead?: (memberSpaceIds: readonly string[]) => boolean;
}

export type ReadSpillPage =
  | {
    status: 200; kind: SpillKind; request: Record<string, unknown>; total: number; expiresAt: string;
    ceilingHit?: boolean; items: unknown[]; skip: number; nextSkip?: number; truncated: boolean;
    charsReturned: number; bytesReturned: number;
  }
  | { status: 404 }
  | { status: 410 };

/** THE refusal for "not yours", "unknown" and "expired" alike. One object, so they cannot drift apart. */
const NOT_FOUND = { status: 404 } as const;


/**
 * One window of a spill, for its owner. Decodes only the pages the window touches. Every item is whole: the
 * first item is returned even when it alone passes the ceiling, or it could never be read.
 */
export async function readSpillPage(req: ReadSpillRequest): Promise<ReadSpillPage> {
  // A spill id is a `randomUUID()`; anything else cannot name one, and must not reach the query as an object.
  if (typeof req.id !== 'string' || !UUID_V4_RE.test(req.id)) return { ...NOT_FOUND };
  if (typeof req.issuedTo !== 'string' || req.issuedTo.length === 0) return { ...NOT_FOUND };
  const h = await headers().findOne({ _id: req.id });
  if (!h || h.issuedTo !== req.issuedTo || h.expiresAt.getTime() <= Date.now()) return { ...NOT_FOUND };
  if (req.mayRead && !req.mayRead(h.memberSpaceIds)) return { ...NOT_FOUND };
  if (h.evicted) return { status: 410 };

  const skip = Math.max(0, Math.floor(req.skip ?? 0));
  // The same admission rule every search answer is held to, applied as the pages are decoded.
  const meter = budgetMeter({ chars: req.maxChars ?? Number.POSITIVE_INFINITY, bytes: req.maxBytes ?? null });
  const items: unknown[] = [];
  let next = skip;
  let stopped = false;

  if (skip < h.items) {
    const start = await pages().find({ spillId: h._id, index: { $lte: skip } })
      .sort({ index: -1 }).limit(1).project<{ index: number }>({ index: 1 }).toArray();
    let pageIndex = start[0]?.index;
    if (pageIndex === undefined) return { status: 410 };
    while (!stopped && pageIndex < h.items) {
      const page = await pages().findOne({ spillId: h._id, index: pageIndex });
      if (!page) return { status: 410 };
      const body = JSON.parse((await gunzipAsync(Buffer.from(page.body.buffer))).toString('utf8')) as unknown[];
      for (let i = Math.max(0, next - page.index); i < body.length; i++) {
        if (!meter.admit(body[i])) { stopped = true; break; }
        items.push(body[i]);
        next = page.index + i + 1;
      }
      pageIndex = page.index + page.count;
    }
  }

  const truncated = next < h.items;
  return {
    status: 200, kind: h.kind, request: h.request, total: h.items, expiresAt: h.expiresAt.toISOString(),
    ...(h.ceilingHit ? { ceilingHit: true } : {}),
    items, skip, ...(truncated ? { nextSkip: next } : {}), truncated,
    charsReturned: meter.chars(), bytesReturned: meter.bytes(),
  };
}

/** A deleted or wiped space leaves no spill holding its records. Header first, so no reader sees it half gone. */
export async function dropSpillsForSpace(spaceId: string): Promise<void> {
  const ids = (await headers().find({ memberSpaceIds: spaceId }, { projection: { _id: 1 } }).toArray())
    .map(h => h._id);
  if (ids.length === 0) return;
  await headers().deleteMany({ _id: { $in: ids } });
  await pages().deleteMany({ spillId: { $in: ids } });
}

/** A renamed space's spills follow it, so the owner's read check still names a space that exists. */
export async function renameSpillsForSpace(from: string, to: string): Promise<void> {
  if (from === to) return;
  await headers().updateMany({ memberSpaceIds: from }, { $addToSet: { memberSpaceIds: to } });
  await headers().updateMany({ memberSpaceIds: from }, { $pull: { memberSpaceIds: from } });
}

/**
 * The TTL and lookup indexes. Idempotent; a TTL index created with another lifetime, under any name, is
 * corrected in place. A failure is logged naming the collection — the read-time expiry check would otherwise
 * hide a missing TTL index until the ceiling refused every spill.
 */
export async function ensureReadSpillIndexes(): Promise<void> {
  const db = getDb();
  for (const name of READ_SPILL_COLLECTIONS) {
    const existing = await db.listCollections({ name }).toArray();
    if (existing.length === 0) await db.createCollection(name).catch(() => { /* raced into existence */ });
    await ensureExpiryIndex(name, 'expiresAt', 0);
  }
  await headers().createIndex({ issuedTo: 1, createdAt: 1 });
  await headers().createIndex({ memberSpaceIds: 1 });
  await pages().createIndex({ spillId: 1, index: 1 }, { unique: true });
}
