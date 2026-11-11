/**
 * The client FILE CHANGE FEED: what changed in a space's files since a cursor, in position order, on both doors (`GET /api/files/:spaceId/changes` and the
 * MCP tool `file_changes`) — bundle-255, Q-724.
 *
 * ## The question it answers
 *
 * "Which paths of this space changed since cursor C, and how does each stand now?" One position-ordered read of the space's `files` collection
 * (`readAfterPosition`, the peer pager's own keyset, settled cap and readiness check), file rows only (a chunk is not a file), each row once at its latest
 * position: a live row as `{ path, sha256, sizeBytes, updatedAt, deleted: false }`, a deletion row (a flagged audit row or a feed marker) as
 * `{ path, deleted: true, updatedAt }`. With no cursor it pages from the start, so paging it to the end IS the listing; every page, the last included,
 * carries an encoded cursor (the last one sits at `through`, so the next read starts exactly after everything delivered).
 *
 * ## What it refuses, and why each
 *
 * - a cursor below the space's floor (`files/file-feed-floor.ts`): `410 cursor_expired` — a deletion it would page past was forgotten; start again;
 * - a cursor this space did not hand out (malformed, or another space's: the cursor carries the space's stream tag): `400 invalid_cursor`, never
 *   `cursor_expired` (a client that re-lists on a forged cursor would loop);
 * - a view id: answered as an unknown space ({@link fileChangesSpaceRefusal}), because one cursor cannot cover several spaces' streams;
 * - a peer-bound token: `403`, because a peer reads deletions as tombstones on its own protocol and the feed's deleted paths are for clients.
 *
 * ## What it hides
 *
 * The derived trees and legacy spills the listing hides (`isHiddenFilePath`, `files/derived-trees.ts`): one rule, not a second spelling.
 */
import { z } from 'zod';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readAfterPosition, encodePositionCursor, decodePositionCursor, comparePositionStarts, type PositionStart } from '../util/position-keyset.js';
import { underPrefix } from '../util/under-prefix.js';
import { isViewId } from '../config/view-shape.js';
import { unknownSpaceSentence } from '../spaces/unknown-space.js';
import { fileFeedStateOf } from './file-feed-floor.js';
import { isHiddenFilePath } from './derived-trees.js';

/** The most items one page answers; the default when none is asked. */
export const FILE_CHANGES_MAX_LIMIT = 1000;
export const FILE_CHANGES_DEFAULT_LIMIT = 200;
/** The longest cursor and prefix a request may send. */
export const FILE_CHANGES_MAX_CURSOR = 2048;
export const FILE_CHANGES_MAX_PREFIX = 4096;
/** The most rows one page examines (hidden rows included) before it answers what it found and a cursor at the last row examined. */
export const FILE_CHANGES_EXAMINE_BOUND = 5000;
/** The time bound of each read a page makes, in ms. */
export const FILE_CHANGES_READ_MS = 10_000;

/** The parameters of a read, validated alike on both doors: the route parses its query with it, the tool's input schema states the same bounds. */
export const FileChangesQuery = z.object({
  cursor: z.string().min(1).max(FILE_CHANGES_MAX_CURSOR).optional(),
  prefix: z.string().max(FILE_CHANGES_MAX_PREFIX).optional(),
  limit: z.coerce.number().int().min(1).max(FILE_CHANGES_MAX_LIMIT).optional(),
// Strict: a parameter the feed does not take is refused, never ignored, so `cursor[$ne]=x` (an operator smuggled in a key) is a 400, not a read from the start.
}).strict();
export type FileChangesParams = z.infer<typeof FileChangesQuery>;

/** One change: a live file, or a deleted one (no hash, no size: the deletion stripped them). */
export type FileChangeItem =
  | { path: string; sha256?: string; sizeBytes: number; updatedAt: string; deleted: false }
  | { path: string; deleted: true; updatedAt: string; reason?: FileChangeReason };

/**
 * Why a deletion row is in the feed when it is not a person's delete: `bytes_lost` is the absent-bytes sweep (Q-337), which removed the record of
 * a file whose bytes THIS instance lost, here only. A client that mirrors the space keeps its own copy, which may be the last one. Absent on a delete.
 */
export type FileChangeReason = 'bytes_lost';

export interface FileChangesAnswer { items: FileChangeItem[]; nextCursor: string; through: number; head: number }
/** A read's outcome: the page, or the refusal with its status and code (both doors send it as they send any refusal). */
export type FileChangesOutcome =
  | { ok: true; body: FileChangesAnswer }
  | { ok: false; status: number; body: { error: string; code?: string } };

const CURSOR_PREFIX = 'f1.';
const STREAM_TAG = /^[0-9a-f]{16}$/;

const invalidCursor = (): FileChangesOutcome => ({ ok: false, status: 400, body: {
  error: 'The cursor is not one this space\'s file change feed handed out. Send back a nextCursor exactly as it was answered, or start again with no cursor.',
  code: 'invalid_cursor',
} });

/** The cursor a client keeps: the space's stream tag and a position (`p1.` keyset cursor). */
function encodeFeedCursor(stream: string, start: PositionStart): string {
  return `${CURSOR_PREFIX}${stream}.${encodePositionCursor(start)}`;
}

/** The stream tag and position a cursor names, or `undefined` for one this feed never hands out. */
function decodeFeedCursor(cursor: string): { stream: string; start: PositionStart } | undefined {
  if (!cursor.startsWith(CURSOR_PREFIX)) return undefined;
  const rest = cursor.slice(CURSOR_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return undefined;
  const stream = rest.slice(0, dot);
  if (!STREAM_TAG.test(stream)) return undefined;
  const start = decodePositionCursor(rest.slice(dot + 1));
  return start === undefined ? undefined : { stream, start };
}

/**
 * The refusal both doors give BEFORE anything is read: a view id answers as an unknown space (the same words, so a view's existence is not told apart from
 * an id that never was), and a peer-bound token is refused. `null` when the caller may read the feed of `spaceId`.
 */
export function fileChangesSpaceRefusal(spaceId: string, peerId: string | undefined): { status: number; body: { error: string; code?: string } } | null {
  if (isViewId(spaceId)) return { status: 404, body: { error: unknownSpaceSentence(spaceId) } };
  if (peerId !== undefined) {
    return { status: 403, body: {
      error: 'The file change feed is for clients. This token is bound to a peer (a sync credential), which reads deletions as file tombstones through the sync door. Use an operator token.',
      code: 'peer_token_refused',
    } };
  }
  return null;
}

/** The fields a row is read with: what an item says, and what tells a deletion row from a live one. */
const PROJECTION = { _id: 1, sha256: 1, sizeBytes: 1, updatedAt: 1, deletedAt: 1, feedMarker: 1, retiredBy: 1 } as const;
type FeedRow = { _id: string; sha256?: string; sizeBytes?: number; updatedAt?: string; deletedAt?: string; feedMarker?: true; retiredBy?: string };

function itemOf(row: FeedRow): FileChangeItem {
  if (row.deletedAt !== undefined || row.feedMarker === true) {
    return { path: row._id, deleted: true, updatedAt: String(row.deletedAt ?? row.updatedAt ?? ''), ...(row.retiredBy === 'bytes-lost' ? { reason: 'bytes_lost' as const } : {}) };
  }
  return {
    path: row._id,
    ...(typeof row.sha256 === 'string' ? { sha256: row.sha256 } : {}),
    sizeBytes: typeof row.sizeBytes === 'number' ? row.sizeBytes : 0,
    updatedAt: String(row.updatedAt ?? ''),
    deleted: false,
  };
}

/**
 * One page of the feed of `spaceId` after `params.cursor` (from the start without one). The caller has asked {@link fileChangesSpaceRefusal} and the space's
 * existence; this validates the cursor against the space's stream and floor, then reads.
 */
export async function readFileChanges(spaceId: string, params: FileChangesParams): Promise<FileChangesOutcome> {
  const limit = params.limit ?? FILE_CHANGES_DEFAULT_LIMIT;
  const { stream, floor } = await fileFeedStateOf(spaceId);
  // From the start: below position 0, so a row the carry put at position 0 (an arrival's version 0) is read too.
  let after: PositionStart = { pos: -1 };
  if (params.cursor !== undefined) {
    const decoded = decodeFeedCursor(params.cursor);
    if (!decoded || decoded.stream !== stream) return invalidCursor();
    if (decoded.start.pos < floor) {
      return { ok: false, status: 410, body: {
        error: 'This cursor points into file history the space no longer keeps (a deletion it recorded was purged, or the space was wiped or restored). '
          + 'Start again with no cursor: page the feed from the start and replace what you hold with what it lists.',
        code: 'cursor_expired',
      } };
    }
    after = decoded.start;
  }
  // File rows only (a chunk or a face row is not a file), under the prefix as TEXT (`underPrefix` escapes it).
  const extra = { parentFileId: { $exists: false }, ...(params.prefix ? { _id: underPrefix(params.prefix) } : {}) };
  const items: FileChangeItem[] = [];
  let at = after;
  let examined = 0;
  let more = true;
  let cap = 0;
  while (items.length < limit && examined < FILE_CHANGES_EXAMINE_BOUND) {
    const want = Math.min(limit - items.length, FILE_CHANGES_EXAMINE_BOUND - examined);
    const read = await readAfterPosition<FeedRow>(spaceId, 'files', at, { limit: want + 1, extra, projection: PROJECTION, maxTimeMS: FILE_CHANGES_READ_MS });
    cap = read.cap;
    const page = read.rows.slice(0, want);
    for (const r of page) {
      examined += 1;
      at = { pos: r.pos, id: r.row._id };
      if (!isHiddenFilePath(r.row._id)) items.push(itemOf(r.row));
    }
    more = read.rows.length > page.length;
    if (!more) break;
  }
  // The feed's head: the latest position its rows hold below the settled cap, and never below the floor (after a wipe the rows are gone and the floor is
  // where the history starts). Read from the rows, not the clock, so two reads of one state answer one head on either door.
  const head = Math.max(floor, await topFilePositionBelow(spaceId, cap));
  if (more) {
    // Stopped by the page size or the examine bound: the next page starts right after the last row examined; complete through the position before it.
    return { ok: true, body: { items, nextCursor: encodeFeedCursor(stream, at), through: Math.max(0, at.pos - 1), head } };
  }
  // The end: complete through the head, and the cursor sits there (never behind where this read started).
  const end: PositionStart = comparePositionStarts(at, { pos: head }) > 0 ? at : { pos: head };
  return { ok: true, body: { items, nextCursor: encodeFeedCursor(stream, end), through: Math.max(head, end.pos), head } };
}

/** The highest position any row of the space's `files` holds below `cap` (0 when none): the `(pos, _id)` index read backwards, one row. */
async function topFilePositionBelow(spaceId: string, cap: number): Promise<number> {
  const top = await col<{ _id: string; pos?: number }>(spaceCollection(spaceId, 'files'))
    .find(asFilter<{ _id: string }>({ pos: { $lt: cap, $type: 'number' } }), { projection: { pos: 1 }, maxTimeMS: FILE_CHANGES_READ_MS })
    .sort({ pos: -1, _id: -1 }).limit(1).next();
  return typeof top?.pos === 'number' ? top.pos : 0;
}
