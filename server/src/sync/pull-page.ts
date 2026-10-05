/**
 * What a PULLED page says about itself once the arrival writer has stored it — the reports an operator reads and what
 * the page adds to the transfer's totals and position (`pullType`, `sync/engine.ts`, keeps the paging and the write).
 *
 * ## What a pull says about a page it STORED (`Q-225` and `Q-232`, the pull halves a 5.6.x patch carries)
 *
 * Owner decision D-10 is "fixes only": the pull's behaviour is unchanged, and a pull that decided about a document
 * says so.
 *
 *  - **The local copy was kept** over a pulled one at the SAME seq with DIFFERENT text (`diverged`): a push forks such a
 *    document, a pull never has on 5.6.x, so the pulled text is stored nowhere. The receiver has decided about it —
 *    its position advances past it, because fetching it again every cycle would change nothing — and says which. One
 *    line per page: `kept the local copy; N document(s) arrived at the same seq with different text: <ids>`. An id is
 *    named ONCE per window (`warnOnce`): the cycle that offers it again says nothing more, or a peer that holds the
 *    other text would fill the log with one fact for as long as the two instances differ.
 *  - **A document was stored that does not match its schema** (`schemaMisses`): a pull cannot tell its sender from what
 *    the sender's own copy was, so it stores what it is served — as 5.6.3 did — and reports each, once per page, with the
 *    count, the ids and bounded reasons: `stored N document(s) that do not match their schema: <ids> (<reasons>)`. A
 *    document the writer refuses (a malformed id or seq, a non-string `parentFileId`) is not in it: it was not stored,
 *    and the writer's own summary names it.
 *
 * Both are rendered by the one summary renderer (`warnArrivalsNotStored`), so every id is escaped, bounded and capped
 * the way a refusal's is. They are reported only for a page that is DONE — the caller asks after the page is stored and
 * its position is not held; a page that holds the position is fetched again, and would be reported twice.
 *
 * ## What the page adds to the totals and the position
 *
 * A document the writer refused is counted in nothing and moves nothing. A document the receiver KEPT its own copy over
 * is not counted as pulled (its text is stored nowhere) but does move the position, as a document already held always
 * has. Every other document is counted and moves both.
 */
import { warnArrivalsNotStored, arrivalId, type ArrivalOutcome, type ArrivalVerdict } from './arrivals.js';
import { schemaMisses } from './arrival-shape.js';
import type { ReplicatedFamily } from './replicated-families.js';
import type { NetworkMember } from '../config/types.js';
import { warnOnce } from '../util/warn-once.js';

/** How long an id already named as a kept-local divergence is not named again. */
const DIVERGED_REPORT_WINDOW_MS = 10 * 60_000;
/** The ids already named, by space, family and id — bounded inside `warnOnce`, because an id is a peer's text. */
const divergedNamed = warnOnce<string>({ every: DIVERGED_REPORT_WINDOW_MS });

const KEPT_LOCAL: ArrivalVerdict = (n) => `kept the local copy; ${n} document(s) arrived at the same seq with different text`;
const STORED_NOT_MATCHING: ArrivalVerdict = (n) => `stored ${n} document(s) that do not match their schema`;

/** The part of a pulled document the totals read. */
interface PulledDoc { _id?: unknown; seq: number; author?: { instanceId?: string } }

/**
 * Report on one pulled page that was written (`written`) and say what it adds to the transfer: `count` documents, the
 * highest `seq` it carried (`maxSeq`), and the highest one the peer itself AUTHORED (`highSeq`, 0 when none).
 */
export function settlePulledPage(
  spaceId: string, family: ReplicatedFamily, docs: readonly PulledDoc[], written: ArrivalOutcome, member: NetworkMember,
): { count: number; maxSeq: number; highSeq: number } {
  const peer = member.label ?? member.instanceId;
  const where = `Pull from ${peer} '${spaceId}'`;
  const stored = new Set([...written.inserted, ...written.updated]);
  warnArrivalsNotStored(where, spaceId, family.collection, STORED_NOT_MATCHING,
    schemaMisses(family.payloadKey, docs).filter(m => stored.has(m._id)));
  warnArrivalsNotStored(where, spaceId, family.collection, KEPT_LOCAL,
    written.diverged.filter(id => divergedNamed(`${spaceId}\u0000${family.collection}\u0000${id}`, () => undefined)));

  const refused = new Set(written.refused.map(r => r._id));
  const keptLocal = new Set(written.diverged);
  let count = 0, maxSeq = 0, highSeq = 0;
  for (const doc of docs) {
    const id = arrivalId(doc);
    if (refused.has(id)) continue;
    if (!keptLocal.has(id)) count++;
    if (doc.seq > maxSeq) maxSeq = doc.seq;
    if (doc.seq > highSeq && doc.author?.instanceId === member.instanceId) highSeq = doc.seq;
  }
  return { count, maxSeq, highSeq };
}
