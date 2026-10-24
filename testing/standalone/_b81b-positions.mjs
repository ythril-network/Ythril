/**
 * What bundle-81's slice-B tests need beside the shared doors: the position marks, rows that carry a position, and the ids
 * an answer names (bundle-81, slice B).
 *
 * ## The marks
 *
 * 6.0 pages by position, so a member's marks are `lastPosReceived`, `lastPosPushed` and `lastPosServed` (design rev 8 §3a). They
 * are named here once, as the keys the member row carries, and a test that asserts "a mark did not move" starts it at a
 * SENTINEL and asserts it is still exactly that, not NaN and not absent (§9 rules).
 *
 * ## Rows with a position
 *
 * A row a fixture inserts by hand carries `pos` and `posAtSeq` the way a carried row does: `pos = seq`, the legacy band, which
 * is below every clock position. A tombstone issued here carries `issuedHere`; a local record carries `writtenHere`.
 */
import { build } from './_push-door.mjs';

export const MARK = Object.freeze({ received: 'lastPosReceived', pushed: 'lastPosPushed', served: 'lastPosServed' });

/** The member row's mark for `space`, or `undefined` when none is recorded. */
export const readMark = (door, kind, space) => door.member()[MARK[kind]]?.[space];

/** Put a mark on the member row, as a carried or earlier mark stands there. */
export function setMark(door, kind, space, value) {
  const m = door.member();
  m[MARK[kind]] = { ...(m[MARK[kind]] ?? {}), [space]: value };
}

/** Take every position mark off the member row: what `door.reset` does for the seq marks, whose new names it does not know. */
export function clearPositionMarks(door) {
  const m = door.member();
  for (const key of Object.values(MARK)) delete m[key];
}

/** Every `_id` a body names, however deep and whatever its shape: the grouped 5.x tombstone body and the 6.0 `{ items }` body alike. */
export function idsIn(body) {
  const ids = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      if (typeof v._id === 'string') ids.push(v._id);
      Object.values(v).forEach(walk);
    }
  };
  walk(body);
  return ids;
}

/**
 * Does this build treat `pos` and `posAtSeq` as local-only fields (the `POSITION_FIELDS` class, design rev 8 §2)? On a build that
 * does not, a row that carries them is served with them, and the strict file-row schema (`IncomingFileMetaDoc`, `.strict()`)
 * refuses the whole row: a fixture for a file row must then leave them off, or every case that moves a file row proves nothing about
 * the rule it is for.
 */
export const POSITIONS_ARE_LOCAL_ONLY = (await import('../../server/dist/sync/local-only-fields.js')).POSITION_FIELDS !== undefined;

/** A record as a carried row stands: its position is its seq (the identity band). A file row carries it only where that is legal. */
export function positioned(doc, extra = {}) {
  const out = { ...doc, pos: doc.seq, posAtSeq: doc.seq, ...extra };
  if (typeof doc.path === 'string' && !POSITIONS_ARE_LOCAL_ONLY) { delete out.pos; delete out.posAtSeq; }
  return out;
}

/** A tombstone row with a position. */
export const positionedTombstone = (space, id, type, seq, extra = {}) => positioned(build.tombstone(space, id, type, seq, extra));

/**
 * Store rows in a space's collection and settle the counter past them, as `seedPeerRecords` does for the peer's side.
 * `part` is the collection suffix (`facts`, `tombstones`, …).
 */
export async function seedRows(door, space, part, docs) {
  if (docs.length === 0) return;
  await door.coll(space, part).insertMany(docs.map(d => ({ ...d })), { ordered: false });
  await door.bumpSeq(space, docs.reduce((m, d) => Math.max(m, d.seq), 0));
}
