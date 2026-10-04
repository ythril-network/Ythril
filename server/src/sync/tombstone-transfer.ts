/**
 * The tombstone half of a sync cycle — both directions, side by side.
 *
 * ## Why it lives here rather than in `engine.ts`
 *
 * Pull and push each had their own inline block, twenty lines apart in a thousand-line file, and the two halves of
 * one protocol phase never got read together. That cost something specific: the pull's `!resp.ok` branch **did not
 * exist**. A peer answering `503` to a tombstone fetch applied nothing, logged nothing, and the cycle advanced its
 * watermark past the deletions anyway. The push side had a warn for the same case. One phase, two implementations,
 * and the weaker one silently won — which `CLAUDE.md` names as the defect this codebase produces most.
 *
 * ## Both return a `TransferOutcome`, and that is the point
 *
 * Tombstones travel under the SAME `lastSeqReceived` / `lastSeqPushed` as the record collections. A deletion that
 * did not transfer, followed by a watermark that moved past it, is a deletion that never propagates — the record
 * stays alive on the peer for ever and every later cycle reports success. So each direction reports how far it
 * actually got, and `sync/watermark.ts` limits the shared watermark to it. A stop for ANY reason — a refused
 * request, a throw, a page of one seq that cannot be paged past, the page bound — is a `truncated` outcome.
 *
 * ## Both page with one tie-safe pager (`Q-237`, bundle-46)
 *
 * The pull used to ask once, with no `limit`, so the peer served its default per type and the transfer reported
 * itself complete: every deletion past that was never applied and never asked for again. The push paged by moving
 * its cursor to the last seq of a page and asking for `seq > cursor`, so a run of equal seqs across the boundary
 * lost every element of the run the first page did not hold — and equal seqs are legitimate, because a peer
 * relays tombstones issued by several instances, each with its own clock. `pageTombstones` is the one pager for
 * both; its docblock has the rule.
 *
 * Both doors APPLY through `applyPeerTombstones` (`sync/tombstone-apply.ts`), which owns the shape, seq,
 * admitted-space and authorisation rules and the counter bump.
 */
import { peerSafeFetch } from './peer-fetch.js';
import { boundedJson } from '../util/bounded-read.js';
import { listTombstones } from '../brain/tombstones.js';
import { applyPeerTombstones, admitTombstone, MAX_TOMBSTONES_PER_REQUEST } from './tombstone-apply.js';
import { CounterBehindError } from './counter-after-page.js';
import { log, logSafe, peerText } from '../util/log.js';
import { TOMBSTONE_TYPES, TOMBSTONE_COLLECTION } from '../config/types.js';
import type { NetworkMember } from '../config/types.js';
import type { TransferOutcome } from './watermark.js';

/** What a push asks for per request. A page of one seq is retried once at `MAX_TOMBSTONES_PER_REQUEST`. */
const PUSH_PAGE = 500;

/** Requests one transfer makes per cycle before it stops as truncated, so a cycle is bounded; the next one resumes. */
const MAX_TOMBSTONE_PAGES = 200;

/** What one request came to: the groups as served, each at most `limit` long, or the status a peer refused with. */
type TombstoneFetch = { groups: unknown[][] } | { status: number };

/** The key a tombstone is de-duplicated by across the pages of one transfer: its type and id. */
function dedupeKey(raw: unknown): string | undefined {
  const { _id: id, type } = (raw ?? {}) as { _id?: unknown; type?: unknown };
  return typeof id === 'string' && typeof type === 'string' ? JSON.stringify([type, id]) : undefined;
}

/**
 * Page a tombstone transfer from `outcome.deliveredThrough` up to the horizon, or stop and say where.
 *
 * ## The rule
 *
 * - Each request asks for `seq > cursor`, `limit` per group (the pull's groups are the peer's per-type answers; the
 *   push has one).
 * - A group that came back FULL may have more at its last seq, so the next cursor is the lowest last seq among the
 *   full groups, MINUS ONE: the next request serves that seq again, whole. Admitted elements already handed on are
 *   skipped by `(type, _id)`. A request with no full group was the last.
 * - The last seq of a group is taken only from elements that pass `admitTombstone` — a refused element at the top
 *   of a page must not move the cursor past the real deletions after it.
 * - A full group that is all ONE seq cannot be paged past by seq. It is asked again once at
 *   `MAX_TOMBSTONES_PER_REQUEST`; still full, the transfer stops `truncated`, held below that seq, and says so.
 *   Ties come only from relayed tombstones of several issuers, so this needs that many deletions at one seq.
 * - `MAX_TOMBSTONE_PAGES` requests per cycle, then `truncated`: the next cycle resumes from where this one held.
 *
 * The cost, stated: the groups that were NOT full are served again from the new cursor, and skipped.
 *
 * `outcome` is updated as the transfer goes, so a throw from `deliver` leaves it at the last position delivered.
 */
async function pageTombstones(o: {
  outcome: TransferOutcome;
  limit: number;
  fetch: (cursor: number, limit: number) => Promise<TombstoneFetch>;
  /** Hand on the elements not handed on before. Returns `null` when delivered, or why the transfer must stop. */
  deliver: (fresh: unknown[]) => Promise<string | null>;
  /** How a stop is logged: what stopped it, and the seq the transfer is held at. */
  stopped: (why: string, heldAt: number) => void;
}): Promise<void> {
  const { outcome } = o;
  const seen = new Set<string>();
  let cursor = outcome.deliveredThrough;
  let limit = o.limit;
  const stop = (why: string): void => { outcome.truncated = true; o.stopped(why, cursor); };
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_TOMBSTONE_PAGES) { stop(`the ${MAX_TOMBSTONE_PAGES}-request bound of one cycle was reached`); return; }
    const got = await o.fetch(cursor, limit);
    if ('status' in got) { stop(`the peer answered ${got.status}`); return; }
    const fresh: unknown[] = [];
    let fullLast = Infinity;
    for (const group of got.groups) {
      let last = -1;
      for (const raw of group) {
        const a = admitTombstone(raw);
        // Only an ADMITTED element counts as handed on: a forged copy refused on one page must not hide the honest
        // copy of the same id that a later page serves.
        const key = 'tombstone' in a ? dedupeKey(raw) : undefined;
        if ('tombstone' in a && a.tombstone.seq > last) last = a.tombstone.seq;
        if (key !== undefined) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        fresh.push(raw);
      }
      if (group.length >= limit && last < fullLast) fullLast = last;
    }
    if (fresh.length > 0) {
      const refusal = await o.deliver(fresh);
      if (refusal !== null) { stop(refusal); return; }
    }
    if (fullLast === Infinity) return;
    const next = fullLast - 1;
    if (next <= cursor) {
      if (limit < MAX_TOMBSTONES_PER_REQUEST) { limit = MAX_TOMBSTONES_PER_REQUEST; continue; }
      stop(`more than ${limit} tombstones share seq ${cursor + 1}, which no request can page past`);
      return;
    }
    cursor = next;
    outcome.deliveredThrough = cursor;
    limit = o.limit;
  }
}

/**
 * Fetch the peer's tombstones since `sinceSeq` and apply them to the LOCAL space `spaceId`.
 *
 * Called BEFORE the record pull so deletions land before anything that would re-upsert a deleted doc. A counter
 * that could not be advanced past what was delivered is thrown (`CounterBehindError`), so the cycle counts an
 * error; any other failure holds the watermark and is logged.
 */
export async function pullTombstones(opts: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  sinceSeq: number;
  requestInit: () => RequestInit;
}): Promise<TransferOutcome> {
  const { member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit } = opts;
  const outcome: TransferOutcome = { deliveredThrough: sinceSeq, truncated: false };
  const peer = logSafe(member.label ?? member.instanceId);
  const where = `sync pull tombstones from ${member.label ?? member.instanceId}`;
  try {
    await pageTombstones({
      outcome,
      limit: MAX_TOMBSTONES_PER_REQUEST,
      fetch: async (cursor, limit) => {
        const url = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}`
          + `&networkId=${encodeURIComponent(networkId)}&sinceSeq=${cursor}&limit=${limit}`;
        const resp = await peerSafeFetch(url, requestInit());
        if (!resp.ok) { await resp.body?.cancel().catch(() => {}); return { status: resp.status }; }
        // Keyed by COLLECTION name, as `GET /api/sync/tombstones` derives them from `TOMBSTONE_TYPES`. A key missing
        // here is a delete a peer told us about and we dropped on the floor.
        const data = await boundedJson<Record<string, unknown>>(resp, 'sync peer');
        return { groups: TOMBSTONE_TYPES.map(t => data?.[TOMBSTONE_COLLECTION[t]]).map(g => (Array.isArray(g) ? g : [])) };
      },
      deliver: async (fresh) => {
        // The peer pulled from is the authenticated source: its own tombstones are authorised, one it relays for a
        // third author is refused here and applied when this instance syncs with that author directly.
        const out = await applyPeerTombstones(spaceId, fresh, { peerInstanceId: member.instanceId }, where);
        return out.unknownTypes.length > 0 ? 'a tombstone type this instance does not know' : null;
      },
      stopped: (why, heldAt) => log.warn(`Pull tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' stopped: ${logSafe(why)} — `
        + `delivered through seq ${heldAt}, so the receive watermark is held there and the rest is asked for next cycle.`),
    });
  } catch (err) {
    if (err instanceof CounterBehindError) throw err;
    outcome.truncated = true;
    log.warn(`Pull tombstones from ${peerText(peer)} for space '${peerText(spaceId)}' failed: `
      + `${logSafe(err instanceof Error ? err.message : String(err))} — delivered through seq `
      + `${outcome.deliveredThrough}, so the receive watermark is held there.`);
  }
  return outcome;
}

/** Send our tombstones newer than `lastSeqPushed`, paging until the peer has them all. */
export async function pushTombstones(opts: {
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  lastSeqPushed: number;
  requestInit: () => RequestInit;
}): Promise<TransferOutcome> {
  const { member, spaceId, remoteSpaceId, networkId, lastSeqPushed, requestInit } = opts;
  const outcome: TransferOutcome = { deliveredThrough: lastSeqPushed, truncated: false };
  const peer = logSafe(member.label ?? member.instanceId);
  const endpoint = `${member.url}/api/sync/tombstones?spaceId=${encodeURIComponent(remoteSpaceId)}`
    + `&networkId=${encodeURIComponent(networkId)}`;
  let refused = 0;
  const stopped = (why: string, heldAt: number): void => log.warn(`Push tombstones to ${peerText(peer)} for space '${peerText(spaceId)}' `
    + `stopped: ${logSafe(why)} — delivered through seq ${heldAt}, so the push watermark is held there.`);
  // A throw (an unreachable peer, this instance's own store) fails the member's sync, as it always has.
  await pageTombstones({
    outcome,
    limit: PUSH_PAGE,
    fetch: async (cursor, limit) => ({ groups: [await listTombstones(spaceId, cursor, limit)] }),
    deliver: async (fresh) => {
      const resp = await peerSafeFetch(endpoint, {
        ...requestInit(), method: 'POST', body: JSON.stringify({ tombstones: fresh }),
      });
      if (!resp.ok) { await resp.body?.cancel().catch(() => {}); return `the peer answered ${resp.status}`; }
      // `refused` is additive (bundle-46): an older peer does not send it. A refusal is by shape or seq, which a
      // re-send cannot change, so the push still advances past it — as a record push does past `rejected`.
      const body = await boundedJson<{ refused?: unknown }>(resp, 'sync peer').catch(() => ({}) as { refused?: unknown });
      if (typeof body.refused === 'number' && body.refused > 0) refused += body.refused;
      return null;
    },
    stopped,
  });
  if (refused > 0) {
    log.warn(`Push tombstones to ${peerText(peer)} for space '${peerText(spaceId)}': the peer refused ${refused} tombstone(s) by shape or `
      + 'seq; its own log names them.');
  }
  return outcome;
}
