/**
 * One replicated record family, pulled from one peer: page it, accept it, say how far the transfer is complete.
 *
 * Moved out of `sync/engine.ts`, where it was `pullType` — a closure over the cycle's state that the god-file gate kept
 * charging for. What it does not own, and must not grow: WHICH families replicate (`REPLICATED_FAMILIES`), WHAT the
 * receiver stores of a page (`acceptArrivingPage`), and HOW a run of equal seqs is paged (`pageSeqRuns`).
 *
 * ## The page is the pager's, the accept is the push's
 *
 * `pageSeqRuns` (`sync/seq-run-pager.ts`) follows the server's cursor or, from a 5.6 server that cannot continue a run,
 * re-asks at the last full seq minus one — and hands this module ONLY what it has not handed on before. So a record a
 * legacy re-ask serves twice reaches `acceptArrivingPage` once: it is not counted twice, not checked for linkage twice, and
 * not planned twice.
 *
 * The receiver decides what it stores (`sync/accept-page.ts`, `Q-204`): the wire schema per document, held tombstones,
 * forks within the caps, then the one arrival writer (`sync/arrivals.ts`) and its guards — the deliverer is the member the
 * page was read from. A write the store could not do is a RECORD-WRITE failure, not an unreachable peer: the transfer
 * stops, holds `deliveredThrough` below the page, and fetches it again next cycle. It used to escape to the member-level
 * catch, which counts toward PEER UNREACHABLE and names the driver error and nothing else.
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
import { acceptArrivingPage, type AcceptedFamily } from './accept-page.js';
import { arrivalRefusal } from './arrivals.js';
import { pageSeqRuns, serverCursorOf } from './seq-run-pager.js';
import { truncationWarn, type TransferOutcome } from './watermark.js';
import { log, logSafe, peerText } from '../util/log.js';
import type { LinkageCheck } from './linkage-check.js';
import type { ReplicatedFamily } from './replicated-families.js';
import type { NetworkMember, FactDoc } from '../config/types.js';

/** What a pull asks for per request, and the one larger ask a server that cannot continue a run is retried at (its own clamp). */
const PULL_PAGE = 200;
const PULL_MAX_PAGE = 500;

/** Requests one transfer makes per cycle before it stops as capped; the next cycle resumes from where this one is complete. */
const PULL_MAX_PAGES = 50;

export type PullResult = { count: number; highSeq: number; maxSeq: number } & TransferOutcome;

type ServedPage = { items?: unknown; nextCursor?: unknown };

/** A tombstone riding in a page: applied by `pullTombstones` before the records, so it is not a document to accept. */
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
  linkage: LinkageCheck;
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
    admit: (raw) => (arrivalRefusal(raw, { seqOptional: false }) === null
      ? { seq: (raw as { seq: number }).seq, key: `${key}\u0000${(raw as { _id: string })._id}` } : null),
    deliver: async (fresh) => {
      const docs = fresh as FactDoc[];
      let written: AcceptedFamily;
      try {
        written = (await acceptArrivingPage(spaceId, { [key]: docs },
          { door: 'pull', deliveredBy: member.instanceId, from: peerLabel, linkage: o.linkage }))[key];
      } catch (err) {
        return `a record write failed in space '${peerText(spaceId)}' (${logSafe(err instanceof Error ? err.message : String(err))}); `
          + 'this is this instance\'s database, not the peer, and the page is fetched again next cycle';
      }
      for (const [i, doc] of docs.entries()) {
        if (written.verdicts[i] === 'rejected') continue;
        count++;
        if (doc.seq > maxSeq) maxSeq = doc.seq;
        if (doc.seq > highSeq && doc.author?.instanceId === member.instanceId) highSeq = doc.seq;
      }
      return null;
    },
    // A transfer that stopped has more to give, so it caps the watermark AND keeps making progress next cycle.
    stopped: (why, heldAt) => log.warn(peerText(truncationWarn(`Pull ${key} from`, member.label ?? '', spaceId, why, heldAt))),
  });
  return { count, highSeq, maxSeq, ...outcome };
}
