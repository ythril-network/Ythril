/**
 * One replicated record family, pulled from one peer: page it, write it, say how far the transfer is complete.
 *
 * Moved out of `sync/engine.ts`, where it was `pullType` — a closure over the cycle's state that the god-file gate kept
 * charging for. What it does not own, and must not grow: WHICH families replicate (`REPLICATED_FAMILIES`), WHAT the
 * receiver stores of a page (`writeArrivals`, `sync/arrivals.ts`), what a page says about itself (`settlePulledPage`,
 * `sync/pull-page.ts`), and HOW a run of equal seqs is paged (`pageSeqRuns`).
 *
 * ## The page is the pager's, the write is the arrival writer's
 *
 * `pageSeqRuns` (`sync/seq-run-pager.ts`) follows the server's cursor or, from a 5.6 server that cannot continue a run,
 * re-asks at the last full seq minus one — and hands this module ONLY what it has not handed on before. So a record a
 * legacy re-ask serves twice reaches the writer once: it is not counted twice and not planned twice.
 *
 * The receiver decides what it stores, through the one arrival writer (`sync/arrivals.ts`): a malformed id or an
 * implausible seq refused per document (warned), the retag to the local space, a repeated id collapsed to its highest seq,
 * the sender's local-only fields dropped and this instance's own carried across the replace, the guard against a newer
 * stored copy, the counter bumped per landed chunk, and every landed record queued for embedding by THIS instance's rules.
 * A write the store could not do is a RECORD-WRITE failure, not an unreachable peer (`F10`): the transfer stops, holds
 * `deliveredThrough` below the page, and fetches it again next cycle. A bump that failed (`counterBehind`) and a document
 * the STORE refuses hold the position the same way.
 *
 * ## What it reports
 *
 * `deliveredThrough` is what the pager says: the last seq the transfer is COMPLETE through (a stop inside a run of equal
 * seqs reports that seq minus one). `highSeq` is the highest seq among records AUTHORED by the peer — the author guard,
 * which is about whose records may move the watermark and is not about whether the transfer finished. Both are needed
 * and answer different questions (`sync/watermark.ts`).
 */
import { peerSafeFetch } from './peer-fetch.js';
import { boundedJson } from '../util/bounded-read.js';
import { arrivalRefusal, writeArrivals, type ArrivalOutcome } from './arrivals.js';
import { settlePulledPage, refusalIsNews } from './pull-page.js';
import { pageSeqRuns, serverCursorOf } from './seq-run-pager.js';
import { truncationWarn, type TransferOutcome } from './watermark.js';
import { log, logSafe } from '../util/log.js';
import { RECORD_TYPE_OF, type ReplicatedFamily } from './replicated-families.js';
import type { NetworkMember } from '../config/types.js';

/** What a pull asks for per request, and the one larger ask a server that cannot continue a run is retried at (its own clamp). */
const PULL_PAGE = 200;
const PULL_MAX_PAGE = 500;

/** Requests one transfer makes per cycle before it stops as capped; the next cycle resumes from where this one is complete. */
const PULL_MAX_PAGES = 50;

export type PullResult = { count: number; highSeq: number; maxSeq: number } & TransferOutcome;

type ServedPage = { items?: unknown; nextCursor?: unknown };

/** A tombstone riding in a page: applied by `pullTombstones` before the records, so it is not a document to write. */
const isRider = (item: unknown): boolean => Boolean(item && typeof item === 'object' && (item as { deletedAt?: unknown }).deletedAt);

export async function pullFamily(o: {
  family: ReplicatedFamily;
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  sinceSeq: number;
  /** The request init for a batch-sized answer (`BATCH_FETCH_TIMEOUT_MS`). */
  requestInit: () => RequestInit;
}): Promise<PullResult> {
  const { family, member, spaceId, remoteSpaceId, networkId, sinceSeq } = o;
  const key = family.payloadKey;
  const peerLabel = member.label ?? member.instanceId;
  const outcome: TransferOutcome = { deliveredThrough: sinceSeq, truncated: false };
  let count = 0, highSeq = sinceSeq, maxSeq = 0;

  await pageSeqRuns({
    outcome,
    limit: PULL_PAGE,
    maxLimit: PULL_MAX_PAGE,
    maxPages: PULL_MAX_PAGES,
    fetch: async (ask, limit) => {
      const params = new URLSearchParams({
        spaceId: remoteSpaceId, networkId, sinceSeq: String(ask.sinceSeq), limit: String(limit), full: 'true',
        ...(ask.cursor ? { cursor: ask.cursor } : {}),
      });
      const resp = await peerSafeFetch(`${member.url}/api/sync/${key}?${params}`, o.requestInit());
      if (!resp.ok) return { status: resp.status };
      const page = await boundedJson<ServedPage>(resp, 'sync peer');
      return {
        groups: [(Array.isArray(page.items) ? page.items : []).filter(item => !isRider(item))],
        nextCursor: serverCursorOf(page.nextCursor),
      };
    },
    // The writer's own shape rule: an element it would refuse names no seq the transfer may stand on.
    admit: (raw) => (arrivalRefusal(raw, { seq: 'required', fileRow: family.collection === 'files' }) === null
      ? { seq: (raw as { seq: number }).seq, key: `${key}\u0000${(raw as { _id: string })._id}` } : null),
    deliver: async (fresh) => {
      let written: ArrivalOutcome;
      try {
        written = await writeArrivals(spaceId, family.collection, RECORD_TYPE_OF[family.collection], fresh,
          { from: peerLabel, namedOnce: id => refusalIsNews(spaceId, family.collection, id) });
      } catch (err) {
        return `sync pull ${logSafe(spaceId)} ${family.collection}: record write failed: `
          + `${logSafe(err instanceof Error ? err.message : String(err))} (from ${logSafe(peerLabel)}). `
          + 'This is this instance\'s database, not the peer: the page is fetched again next cycle';
      }
      if (written.counterBehind) {
        // `Q-218` R3: the page is stored, but this counter may be behind it, so the position is not vouched for.
        return `sync pull ${logSafe(spaceId)} ${family.collection}: record write failed: the seq counter could not be moved `
          + `past the page from ${logSafe(peerLabel)}; the page is fetched again next cycle`;
      }
      if (written.storeRefused.length > 0) {
        // The documents are named once, by the writer's own summary (`warnArrivalsNotStored`); this says what it costs.
        return `sync pull ${logSafe(spaceId)} ${family.collection}: record write failed: the store refused `
          + `${written.storeRefused.length} document(s) from ${logSafe(peerLabel)}; the page is fetched again next cycle`;
      }
      // What the page said about itself (`sync/pull-page.ts`): the reports an operator reads and what it adds to the
      // transfer's totals — a refused or kept-local document is counted in nothing. The POSITION is the pager's.
      const seen = settlePulledPage(spaceId, family, fresh as { seq: number; author?: { instanceId?: string } }[], written, member);
      count += seen.count;
      maxSeq = Math.max(maxSeq, seen.maxSeq);
      highSeq = Math.max(highSeq, seen.highSeq);
      return null;
    },
    // A transfer that stopped has more to give, so it caps the watermark AND keeps making progress next cycle.
    stopped: (why, heldAt) => log.warn(truncationWarn(`Pull ${key} from`, peerLabel, spaceId, why, heldAt)),
  });
  return { count, highSeq, maxSeq, ...outcome };
}
