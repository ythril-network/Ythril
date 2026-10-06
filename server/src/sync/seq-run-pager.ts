/**
 * "Transfer from a peer that serves its records in seq order" — one pager for the record pull and the tombstone pull,
 * through a server that hands out a position cursor and through one that pages by `seq >` alone (bundle-52, `Q-277`,
 * `Q-295`).
 *
 * ## What it prevents
 *
 * A record keeps its AUTHOR's seq when it replicates, so a peer that relays several authors serves runs of equal seqs,
 * and a page boundary can fall inside a run. A pager that moves on from "the last seq of the page" asks for `seq > last`
 * next and loses the rest of the run — nothing reports it, and the watermark that follows the pager moves past records
 * it never saw. Three more things were each written for tombstones only, inside `pageTombstones`, and each was a way to
 * lose or wedge a transfer:
 *
 *   - the SEEN set grew for the whole transfer, though only what the next ask can serve again can ever be a duplicate;
 *   - a full page of refused elements could not be paged past on any server, so one planted page held a member for ever;
 *   - the position reported on a stop was the seq the transfer had read TO, which for a stop inside a run claims a run
 *     it only began (`watermark.ts`: a watermark at S puts the rest of the run behind it for good).
 *
 * ## The two servers
 *
 * What the server's `nextCursor` looks like decides, page by page, how the transfer continues:
 *
 *   - **A pair cursor** (`util/seq-keyset.ts`: `(seq, _id)`) is FOLLOWED. The server names the position after the last
 *     element it served, so a run is continued exactly and nothing is read twice. The client does not take the server's
 *     word for it: the cursor has to decode to the page's LAST element and be strictly greater than the position the ask
 *     started from, with `_id` ordered as the store orders it (`compareSeqPositions`: UTF-8 bytes, never JavaScript's `<`).
 *     A cursor that does not is a `failed` stop, not a loop. Because the position is the server's and not an element's,
 *     a page of refused elements is passed like any other, and no seq taken from a refused element moves anything.
 *   - **A bare-seq cursor, or none** (a 5.6 server; or a pair too long to carry an id) cannot continue a run. The next
 *     ask is the lowest last ADMITTED seq among the FULL groups, MINUS ONE: that seq is served again, whole, and what was
 *     already handed on is skipped by `(identity, seq)`. A full group with no admitted element, or a run longer than
 *     `maxLimit`, cannot be paged past by seq: the transfer stops, and says which of the two it was.
 *
 * "Full" is the server's word (`nextCursor !== null`) whenever it sends one, and the length of the group when it sends
 * none. A page inflated past `limit` by riders (the tombstones a record page carries) is not "full" for that.
 *
 * ## What it reports
 *
 * `outcome.deliveredThrough` is the last seq the transfer is COMPLETE through — which is what `sync/watermark.ts` needs
 * and what "the last seq delivered" is not. A transfer that ran to the end is complete through its highest admitted seq;
 * one that stopped while the run at its last seq may continue is complete through that seq MINUS ONE. `outcome` is
 * updated as the transfer goes, so a throw from `deliver` leaves it at the last position handed on.
 *
 * ## The seen set, and why it is bounded
 *
 * Only elements at or above the lowest seq the next ask can serve again can arrive twice, so only their keys are kept: a
 * pair cursor re-serves nothing below its own seq, and a legacy ask re-serves from its seq plus one. Everything below is
 * dropped after every page, so a transfer of a million records holds a few pages of keys and not a million.
 */
import { compareSeqPositions, decodeSeqCursor, type SeqPosition } from '../util/seq-keyset.js';
import type { TransferOutcome } from './watermark.js';

/** Requests one transfer makes before it stops as capped, when the caller names no bound of its own. */
export const DEFAULT_MAX_PAGES = 200;

/** Where an ask starts: `cursor` is the SERVER's own cursor (a pair), handed back verbatim; otherwise `sinceSeq` is the position. */
export interface SeqRunAsk {
  sinceSeq: number;
  cursor: string | null;
}

/**
 * What one request came to: the groups as served (a record page has one; a tombstone answer has one per type), and the
 * server's cursor — a string is its cursor, `null` says this was the last page, `undefined` says the server has no
 * cursor at all (a 5.6 tombstone route). Or the status a peer refused with.
 */
export type SeqRunPage = { groups: unknown[][]; nextCursor?: string | null | undefined } | { status: number };

/** What the caller's admission rule says about one element: the seq it vouches for and the identity it is de-duplicated by. */
export interface SeqRunAdmission {
  seq: number;
  key: string;
}

/** A position an element names, or `undefined` for one that names none (no string `_id`, or a seq that is not a whole number). */
function positionOf(raw: unknown): SeqPosition | undefined {
  const { _id: id, seq } = (raw ?? {}) as { _id?: unknown; seq?: unknown };
  return typeof id === 'string' && id !== '' && typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? { seq, id } : undefined;
}

/** The greatest position among the elements of every group, or `undefined` when there are none or one names no position. */
function lastPositionOf(groups: readonly (readonly unknown[])[]): SeqPosition | undefined {
  let last: SeqPosition | undefined;
  for (const group of groups) {
    for (const raw of group) {
      const at = positionOf(raw);
      if (at === undefined) return undefined;
      if (last === undefined || compareSeqPositions(at, last) > 0) last = at;
    }
  }
  return last;
}

/**
 * Page a transfer from `outcome.deliveredThrough` until the peer has nothing more, or stop and say where.
 *
 * @param o.limit what a request asks for; `o.maxLimit` (default `o.limit`) is the one larger ask a legacy page made of a
 *   single seq is retried at before the transfer gives up; `o.maxPages` (default {@link DEFAULT_MAX_PAGES}) bounds the
 *   requests of one call, after which the transfer stops as capped and the next cycle resumes.
 * @param o.admit the caller's ONE admission rule: `null` for an element it refuses. Only an admitted element counts as
 *   handed on, and only an admitted seq may move anything this reports.
 * @param o.deliver hand on `fresh` — what was not handed on before, refused elements included so the caller counts them.
 *   Returns `null` when delivered, or why the transfer must stop. A throw ends the transfer and leaves `outcome` as it was.
 * @param o.stopped how a stop is logged: what stopped it and the seq the transfer is held at.
 */
export async function pageSeqRuns(o: {
  outcome: TransferOutcome;
  limit: number;
  maxLimit?: number;
  maxPages?: number;
  fetch: (ask: SeqRunAsk, limit: number) => Promise<SeqRunPage>;
  admit: (raw: unknown) => SeqRunAdmission | null;
  deliver: (fresh: unknown[]) => Promise<string | null>;
  stopped: (why: string, heldAt: number) => void;
}): Promise<void> {
  const { outcome } = o;
  const maxLimit = Math.max(o.limit, o.maxLimit ?? o.limit);
  const maxPages = o.maxPages ?? DEFAULT_MAX_PAGES;
  /** `identity@seq` -> seq, for what was handed on and can still be served again. */
  const seen = new Map<string, number>();
  const forgetBelow = (seq: number): void => { for (const [key, at] of seen) if (at < seq) seen.delete(key); };
  let ask: SeqRunAsk = { sinceSeq: outcome.deliveredThrough, cursor: null };
  /** The position the current ask reads AFTER: a bare seq, or the pair cursor last followed. */
  let floor: SeqPosition = { seq: ask.sinceSeq };
  let limit = o.limit;
  let highestAdmitted = -1;
  const stop = (why: string): void => { outcome.truncated = true; o.stopped(why, outcome.deliveredThrough); };

  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) { stop(`the ${maxPages}-request bound of one cycle was reached`); return; }
    const got = await o.fetch(ask, limit);
    if ('status' in got) { stop(`the peer answered ${got.status}`); return; }
    const { groups, nextCursor } = got;

    // What the server's cursor is, read before anything is handed on: a cursor that cannot be followed ends the transfer.
    let pair: SeqPosition | undefined;
    if (typeof nextCursor === 'string') {
      const named = decodeSeqCursor(nextCursor);
      if (named === undefined) { stop('the peer handed back a cursor that cannot be read'); return; }
      if (named.id !== undefined) {
        const last = lastPositionOf(groups);
        if (last === undefined || compareSeqPositions(named, last) !== 0) {
          stop('the peer\'s cursor is not the position of the last element it served'); return;
        }
        if (compareSeqPositions(named, floor) <= 0) { stop('the peer\'s cursor does not move past the position it was asked from'); return; }
        pair = named;
      }
    }

    const fresh: unknown[] = [];
    /** The lowest last admitted seq among the FULL groups (-1 for a full group with none), and whether that group held a refusal. */
    let fullLast = Infinity;
    let fullRefused = false;
    let pageHighest = -1;
    for (const group of groups) {
      let last = -1;
      let refused = false;
      for (const raw of group) {
        const a = o.admit(raw);
        if (a === null) { refused = true; fresh.push(raw); continue; }
        if (a.seq > last) last = a.seq;
        // Only an ADMITTED element counts as handed on: a forged copy refused on one page must not hide the honest copy
        // of the same id that a later page serves. The seq is part of the identity: a record changed between two asks is
        // a new version, not a repeat.
        const id = `${a.seq}\u0000${a.key}`;
        if (seen.has(id)) continue;
        seen.set(id, a.seq);
        fresh.push(raw);
      }
      if (last > pageHighest) pageHighest = last;
      const full = nextCursor === undefined ? group.length >= limit : nextCursor !== null;
      if (full && last < fullLast) { fullLast = last; fullRefused = refused; }
    }
    if (pageHighest > highestAdmitted) highestAdmitted = pageHighest;

    if (fresh.length > 0) {
      const refusal = await o.deliver(fresh);
      if (refusal !== null) { stop(refusal); return; }
    }

    if (pair !== undefined) {
      // Complete through the highest admitted seq — less one when the cursor sits inside that seq's run.
      if (pageHighest >= 0) outcome.deliveredThrough = Math.max(outcome.deliveredThrough, pageHighest >= pair.seq ? pageHighest - 1 : pageHighest);
      forgetBelow(pair.seq);
      // `sinceSeq` rides beside the cursor as the seq BELOW the position, so a server that reads it instead of the cursor (one
      // rolled back between two asks) re-serves the run at that seq, which the seen set absorbs, and never skips the rest of it.
      ask = { sinceSeq: Math.max(0, pair.seq - 1), cursor: nextCursor as string };
      floor = pair;
      limit = o.limit;
      continue;
    }

    if (fullLast === Infinity) {
      // The last page. Complete through the highest ADMITTED seq: a refused element's seq vouches for nothing.
      outcome.deliveredThrough = Math.max(outcome.deliveredThrough, highestAdmitted);
      return;
    }

    // A server that cannot continue a run: ask again at the lowest last seq of a full group, minus one, so the run at
    // that seq is served whole and what was handed on is skipped.
    const next = fullLast - 1;
    if (next <= floor.seq) {
      if (limit < maxLimit) { limit = maxLimit; continue; }
      stop(fullRefused
        ? `a full page of ${limit} holds elements this instance refused and none after them that it admitted, so it cannot be paged past by seq `
          + `(a peer that sends a forged or malformed element at the head of a page)`
        : `more than ${limit} elements share seq ${floor.seq + 1}, which no request can page past`);
      return;
    }
    forgetBelow(fullLast);
    ask = { sinceSeq: next, cursor: null };
    floor = { seq: next };
    outcome.deliveredThrough = Math.max(outcome.deliveredThrough, next);
    limit = o.limit;
  }
}
