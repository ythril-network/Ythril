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
 * A document the writer refused is counted in nothing but does move the position (by a seq the counter could carry): a
 * corrupting shape is refused by every cycle that fetches it, so a position held below it only fetches it again. Its
 * id is named once per window, like a kept-local one (`refusalIsNews`). A document the receiver KEPT its own copy over
 * is not counted as pulled (its text is stored nowhere) but does move the position, as a document already held always
 * has. Every other document is counted and moves both.
 */
import { warnArrivalsNotStored, arrivalId, plausibleSeq, type ArrivalOutcome, type ArrivalVerdict } from './arrivals.js';
import { schemaMisses } from './arrival-shape.js';
import type { ReplicatedFamily } from './replicated-families.js';
import type { NetworkMember } from '../config/types.js';
import { warnOnce } from '../util/warn-once.js';
import { peerText } from '../util/log.js';

/** How long an id already named as a kept-local divergence or a refusal is not named again. */
const REPORT_WINDOW_MS = 10 * 60_000;
/** The most of a space id or a document id a window key holds: an id is a peer's text, and the key must not be as large as it. */
const KEY_PART_MAX = 256;
/** The ids already named, by space, family and id — bounded inside `warnOnce` in count, and by `namedKey` in size. */
const divergedNamed = warnOnce<string>({ every: REPORT_WINDOW_MS });
const refusedNamed = warnOnce<string>({ every: REPORT_WINDOW_MS });

/** The window key of one document of one family in one space, built of bounded parts so no id makes a large key. */
const namedKey = (spaceId: string, collection: string, id: string): string =>
  `${peerText(spaceId, { max: KEY_PART_MAX })}\u0000${collection}\u0000${peerText(id, { max: KEY_PART_MAX })}`;

/**
 * Is this refused document news — not named within the window? Asked once for each refused id by the arrival writer
 * (`ArrivalOptions.namedOnce`), which names only the ids for which it answers `true`.
 */
export function refusalIsNews(spaceId: string, collection: string, id: string): boolean {
  return refusedNamed(namedKey(spaceId, collection, id), () => undefined);
}

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
    written.diverged.filter(id => divergedNamed(namedKey(spaceId, family.collection, id), () => undefined)));

  const refused = new Set(written.refused.map(r => r._id));
  const keptLocal = new Set(written.diverged);
  let count = 0, maxSeq = 0, highSeq = 0;
  for (const doc of docs) {
    const id = arrivalId(doc);
    // A refused document is counted as nothing but still moves the position, by a seq the counter could carry: it is
    // refused again by every cycle that fetches it, so a position held below it only fetches it again.
    const seq = plausibleSeq(doc.seq);
    if (seq !== undefined && seq > maxSeq) maxSeq = seq;
    if (seq !== undefined && seq > highSeq && doc.author?.instanceId === member.instanceId) highSeq = seq;
    if (!refused.has(id) && !keptLocal.has(id)) count++;
  }
  return { count, maxSeq, highSeq };
}
