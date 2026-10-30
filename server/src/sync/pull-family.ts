/**
 * One replicated record family, pulled from one peer: page it, accept it, say how far the transfer is complete.
 *
 * Moved out of `sync/engine.ts`, where it was `pullType` — a closure over the cycle's state that the god-file gate kept
 * charging for. What it does not own, and must not grow: WHICH families replicate (`REPLICATED_FAMILIES`), WHAT the
 * receiver stores of a page (`acceptArrivingPage`), and HOW a stream is paged (`pagePositionRuns`).
 *
 * ## The page is the pager's, the accept is the push's
 *
 * `pagePositionRuns` (`sync/position-run-pager.ts`) follows the server's cursor and hands this module each page ONCE, parsed by
 * `parsePageAnswer` (a page without the 6.0 shape throws `PeerPagesBySeq`, which ends the member's turn). So a record is not counted
 * twice, not checked for linkage twice, and not planned twice.
 *
 * The receiver decides what it stores (`sync/accept-page.ts`, `Q-204`): the wire schema per document, held tombstones,
 * forks within the caps, then the one arrival writer (`sync/arrivals.ts`) and its guards — the deliverer is the member the
 * page was read from. A write the store could not do is a RECORD-WRITE failure, not an unreachable peer: the transfer
 * stops, holds `deliveredThrough` below the page, and fetches it again next cycle. It used to escape to the member-level
 * catch, which counts toward PEER UNREACHABLE and names the driver error and nothing else.
 *
 * ## What it reports
 *
 * `deliveredThrough` is what the pager says: the peer's own position this transfer is COMPLETE through (a stop inside a run of equal
 * positions reports the position before it), and `stoppedBy` says whether a stop was the cycle's cap, a hold (the edges family while this instance rebuilds its edge identity index) or a fault. A record carries no position
 * on the wire, so nothing here derives one from a record; there is no author guard either — the mark is the peer's position in ITS stream
 * and a relayed record is as much a part of it as an authored one.
 */
import { peerSafeFetch } from './peer-fetch.js';
import { transferRefusal, turnSignal, type ExchangeTurn } from './held-answer.js';
import { acceptArrivingPage, type AcceptedFamily } from './accept-page.js';
import { mergeSummaries, NOTHING_RECORDED, type RecordedSummary } from './arrival-recording.js';
import { pagePositionRuns } from './position-run-pager.js';
import { stopTransfer, truncationWarn, type TransferOutcome } from './watermark.js';
import { boundedJson } from '../util/bounded-read.js';
import { log, logSafe, peerText } from '../util/log.js';
import { PositionsBuilding, EdgeIdentityBuilding } from '../util/errors.js';
import type { LinkageCheck } from './linkage-check.js';
import type { ReplicatedFamily } from './replicated-families.js';
import type { NetworkMember, FactDoc } from '../config/types.js';

/** What a pull asks for per request. */
const PULL_PAGE = 200;

/** Requests one transfer makes per cycle before it stops as capped; the next cycle resumes from where this one is complete. */
const PULL_MAX_PAGES = 50;

/**
 * `converged`: file rows whose drifted timestamp took the author's (`Q-419`) — counted apart, since nothing was stored.
 * `refused`: elements the receiver's own rules refused (a shape, an implausible seq): passed on and counted, never a reason to stop.
 * `recorded`: what the transfer stored that the local schema does not accept and the copy it replaced lacked, in names and counts (R6-9).
 * `behind`: the peer's `head` was below the mark this pull started from — its positions went backwards — so the transfer restarted from 0.
 */
export type PullResult = {
  count: number; converged: number; refused: number; recorded: RecordedSummary; behind?: { peerHead: number; startedFrom: number };
} & TransferOutcome;

export async function pullFamily(o: {
  family: ReplicatedFamily;
  member: NetworkMember;
  spaceId: string;
  remoteSpaceId: string;
  networkId: string;
  /** The peer's position this instance is complete through for the space (the mark), 0 when none. */
  since: number;
  /** The request init for a batch-sized answer (`BATCH_FETCH_TIMEOUT_MS`). */
  requestInit: () => RequestInit;
  linkage: LinkageCheck;
  /** The space's turn with this member: its signal cuts the page in flight, and a refusal the peer answers is handed to it. */
  turn?: ExchangeTurn;
}): Promise<PullResult> {
  const { family, member, spaceId, remoteSpaceId, networkId, since } = o;
  const key = family.payloadKey;
  const peerLabel = member.label ?? member.instanceId;
  const outcome: TransferOutcome = { deliveredThrough: since, truncated: false };
  let count = 0, converged = 0, refused = 0;
  let recorded: RecordedSummary = NOTHING_RECORDED;
  let behind: PullResult['behind'];

  await pagePositionRuns({
    outcome,
    limit: PULL_PAGE,
    maxPages: PULL_MAX_PAGES,
    fetch: async (ask, limit) => {
      const params = new URLSearchParams({
        spaceId: remoteSpaceId, networkId, limit: String(limit), full: 'true',
        ...(ask.cursor ? { cursor: ask.cursor } : { afterPos: String(ask.afterPos) }),
      });
      const init = o.requestInit();
      const resp = await peerSafeFetch(`${member.url}/api/sync/${key}?${params}`, { ...init, signal: turnSignal(init.signal, o.turn) });
      if (!resp.ok) { o.turn?.refusedBy(await transferRefusal(resp)); await resp.body?.cancel().catch(() => {}); return { status: resp.status }; }
      return { body: await boundedJson<unknown>(resp, 'sync peer') };
    },
    deliver: async (items) => {
      const docs = items as FactDoc[];
      let written: AcceptedFamily;
      try {
        written = (await acceptArrivingPage(spaceId, { [key]: docs },
          { door: 'pull', deliveredBy: member.instanceId, from: peerLabel, linkage: o.linkage }))[key];
      } catch (err) {
        // A space that owes its positions is held, not failed: the engine reads this instance's own readiness before the turn, and this
        // is the backstop for one that began to owe in between (the throw ends the turn as a hold).
        if (isPositionsBuilding(err)) throw err;
        // A page of fork edges for a space still rebuilding its edge identity index waits for it (design 5.4): the family stops as HELD, with the mark where
        // it stands, and the space's other families go on in the same cycle. Never rethrown: that would end the space's whole turn.
        if (err instanceof EdgeIdentityBuilding) {
          const reason = `the ${key} family is held: this instance is rebuilding its edge identity index for space '${peerText(spaceId)}'`;
          stopTransfer(outcome, () => {}, reason, 'held');   // said once, by the pager's own stop for the reason handed back
          return reason;
        }
        return `a record write failed in space '${peerText(spaceId)}' (${logSafe(err instanceof Error ? err.message : String(err))}); `
          + "this is this instance's database, not the peer, and the page is fetched again next cycle";
      }
      for (const verdict of written.verdicts) {
        // A fork dropped at its cap and a malformed fork row are refused, not stored: counted as the receiver's own rules refusing them (Q-624).
        if (verdict === 'rejected' || verdict === 'forkRefused' || verdict === 'invalidFork' || verdict === 'underivedId') { refused++; continue; }
        if (verdict === 'converged') converged++;
        count++;
      }
      // What the page stored against the local schema's rules, by names and counts — the cycle's history row keeps it.
      recorded = mergeSummaries(recorded, written.summary);
      return null;
    },
    onBehind: (peerHead, startedFrom) => { behind = { peerHead, startedFrom }; },
    // A transfer that stopped has more to give, so it caps the mark AND keeps making progress next cycle.
    stopped: (why, heldAt) => log.warn(peerText(truncationWarn(`Pull ${key} from`, member.label ?? '', spaceId, why, heldAt))),
  });
  return { count, converged, refused, recorded, ...(behind ? { behind } : {}), ...outcome };
}

const isPositionsBuilding = (err: unknown): boolean => err instanceof PositionsBuilding;
