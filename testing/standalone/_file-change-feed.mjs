/**
 * The client file change feed on both of its doors, opened once: `GET /api/files/:spaceId/changes` over the real application on a
 * loopback socket and the MCP tool `file_changes` over `POST /mcp`, both as a real token (bundle-255, Q-724 follow-up).
 *
 * ## The question it answers
 *
 * "What does each door answer a caller who asks what changed in a space since a cursor?" - written once for the four -db tests that
 * ask it (order and resume, the markers a deletion leaves, the floor, the refusals), so no test carries a second copy of how a door is
 * called or how a page is drained.
 *
 * ## The contract it encodes (the plan, `design-final.md` and the vets)
 *
 *  - route `GET /api/files/:spaceId/changes?cursor=&prefix=&limit=`; MCP tool `file_changes` with the same parameters plus `space`;
 *  - answer `{ items, nextCursor, through, head }`; the last page carries an ENCODED cursor, never null;
 *  - an item is `{ path, sha256, sizeBytes, updatedAt, deleted }`; a deleted item is `{ path, deleted: true, updatedAt }` only;
 *  - a cursor older than what is kept is refused: status `410`, `code: 'cursor_expired'` (the MCP result carries the same `code`).
 *
 * ## What a hand-written copy drops
 *
 * **The assertion that the door SERVES the feed before a test reads a refusal.** A refusal test that never saw the feed answer 200 for an
 * authorised caller passes on a build with no such route (an unknown path answers 404, an unknown tool is an error): `served` is that
 * precondition, with the door, the status and the start of the body in its message, so a red run says "the feed is not served" and not
 * a bare assertion about a status.
 */
import assert from 'node:assert/strict';
import { openViewDoors } from './_view-doors.mjs';

export const DOORS = Object.freeze(['REST', 'MCP']);

/** The parsed JSON of `text`, or null. */
const parsed = (text) => { try { return JSON.parse(text); } catch { return null; } };

/**
 * Open both doors over `spaces` under the harness database of `suite`, with an instance-admin token for the acts and the reads.
 * @returns the view doors (`rest`, `mcp`, `mint`, `row`, `loader`, `door`, ...) plus `admin`, `read`, `page`, `drain`.
 */
export async function openFeedDoors({ suite, spaces }) {
  const d = await openViewDoors({ suite, spaces });
  const admin = await d.mint('feed-admin', {}, { admin: true });

  /**
   * One read of the feed through `via` (`REST` or `MCP`) as the holder of `key`.
   * @returns `{ failed, status, code, error, body, text }`: `status` is the HTTP status on REST and 200 or undefined on MCP (a result's
   *   `isError` is the failure); `code` is the refusal's `code` (the body's, or found in the text); `body` is the answer.
   */
  async function read(via, { space, cursor, prefix, limit } = {}, key = admin.key) {
    if (via === 'REST') {
      const q = new URLSearchParams();
      if (cursor !== undefined) q.set('cursor', cursor);
      if (prefix !== undefined) q.set('prefix', prefix);
      if (limit !== undefined) q.set('limit', String(limit));
      const qs = q.toString();
      const a = await d.rest(key, 'GET', `/api/files/${encodeURIComponent(space)}/changes${qs ? `?${qs}` : ''}`);
      return { failed: a.status >= 400, status: a.status, code: a.body?.code, error: a.error, body: a.body, text: a.text };
    }
    const args = { space, ...(cursor !== undefined ? { cursor } : {}), ...(prefix !== undefined ? { prefix } : {}), ...(limit !== undefined ? { limit } : {}) };
    const a = await d.mcp(key, 'file_changes', args);
    const body = a.structured ?? parsed(a.text);
    const code = body?.code ?? (/cursor_expired/.test(a.text) ? 'cursor_expired' : undefined);
    return { failed: a.isError, status: a.isError ? undefined : 200, code, error: a.isError ? a.text : '', body, text: a.text };
  }

  /** The answer of a read that must SERVE the feed: asserted, with the door and what it said when it did not. */
  function served(a, via, what = 'the feed') {
    assert.ok(!a.failed && Array.isArray(a.body?.items),
      `${via}: ${what} is not served (${a.status ?? 'tool error'}): ${String(a.text).slice(0, 200)}`);
    return a.body;
  }

  /** One page, asserted served. */
  async function page(via, args, key) { return served(await read(via, args, key), via); }

  /**
   * Page from `cursor` until a page comes back empty, as a client does. Returns every item in order, the last page's `nextCursor`
   * (the cursor a client keeps), the last `through`, and the number of pages. Bounded, so a feed that never ends is a failure.
   */
  async function drain(via, { space, cursor, prefix, limit = 50 }, key) {
    const items = [];
    let next = cursor, through, pages = 0;
    for (; pages < 200; pages += 1) {
      const body = await page(via, { space, cursor: next, prefix, limit }, key);
      items.push(...body.items);
      next = body.nextCursor;
      through = body.through;
      if (body.items.length === 0) return { items, cursor: next, through, pages: pages + 1 };
      assert.equal(typeof next, 'string', `${via}: a page with items answered nextCursor ${JSON.stringify(next)}, not an encoded cursor`);
    }
    assert.fail(`${via}: the feed did not end in 200 pages`);
  }

  return { ...d, admin, read, served, page, drain, async close() { await d.close(); } };
}

/** The paths of a list of items, in order. */
export const pathsOf = (items) => items.map(i => i.path);

/** `[path, deleted]` of each item, in order. */
export const stateOf = (items) => items.map(i => [i.path, i.deleted === true]);

/** The keys of an item, sorted: what a deleted item and a live one carry. */
export const keysOf = (item) => Object.keys(item).sort();
