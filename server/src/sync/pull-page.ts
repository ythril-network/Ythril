/**
 * Write one PULLED page through the arrival writer and say what it decided — the part of `pullType` (`sync/engine.ts`)
 * that stores the page and reports on it, so the engine keeps the paging and the position.
 *
 * ## What it decides, and what a page that holds the position is
 *
 * The page goes through the one writer (`writeArrivals`: a malformed id or seq refused per document, the retag, the
 * collapse of a repeated id, the sender's local-only fields dropped and this instance's own carried, the guard against
 * a newer stored copy, the counter bumped per landed chunk, every landed record queued for embedding by THIS instance's
 * rules). A write the store could not do is a RECORD-WRITE failure, not an unreachable peer (`F10`): the transfer stops,
 * holds `deliveredThrough` below the page, and fetches it again next cycle. So do a counter that could not be moved
 * past the page (`Q-218` R3) and a document the STORE refuses (cut `C3`: never counted as delivered). Each answers
 * `held`, and the caller stops.
 *
 * ## What a pull says about a page it STORED (`Q-225` and `Q-232`, the pull halves a 5.6.x patch carries)
 *
 * Owner decision D-10 is "fixes only": the pull's behaviour is unchanged, and a pull that decided about a document says so.
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
 * the way a refusal's is. They are reported only for a page that is DONE: a page that holds the position is fetched
 * again, and would be reported twice.
 */
import { writeArrivals, warnArrivalsNotStored, type ArrivalOutcome, type ArrivalVerdict } from './arrivals.js';
import { schemaMisses } from './arrival-shape.js';
import { RECORD_TYPE_OF, type ReplicatedFamily } from './replicated-families.js';
import { warnOnce } from '../util/warn-once.js';
import { log, logSafe } from '../util/log.js';

/** How long an id already named as a kept-local divergence is not named again. */
const DIVERGED_REPORT_WINDOW_MS = 10 * 60_000;
/** The ids already named, by space, family and id — bounded inside `warnOnce`, because an id is a peer's text. */
const divergedNamed = warnOnce<string>({ every: DIVERGED_REPORT_WINDOW_MS });

const KEPT_LOCAL: ArrivalVerdict = (n) => `kept the local copy; ${n} document(s) arrived at the same seq with different text`;
const STORED_NOT_MATCHING: ArrivalVerdict = (n) => `stored ${n} document(s) that do not match their schema`;

/**
 * Store `docs`, one page of `family` pulled from `peer`, and report on it. `held` when the page is not done and the
 * transfer must stop at `deliveredThrough` (it says why, in the log, before it answers).
 */
export async function writePulledPage(
  spaceId: string, family: ReplicatedFamily, docs: unknown[], peer: string, deliveredThrough: number,
): Promise<{ held: true } | { held: false; written: ArrivalOutcome }> {
  const heldAt = `This is this instance's database, not the peer: the transfer holds at ${logSafe(deliveredThrough)}`;
  const misses = schemaMisses(family.payloadKey, docs);
  let written: ArrivalOutcome;
  try {
    written = await writeArrivals(spaceId, family.collection, RECORD_TYPE_OF[family.collection], docs, { from: peer });
  } catch (err) {
    log.warn(`sync pull ${spaceId} ${family.collection}: record write failed: `
      + `${logSafe(err instanceof Error ? err.message : String(err))} (from ${logSafe(peer)}). `
      + `${heldAt} and the page is fetched again next cycle.`);
    return { held: true };
  }
  if (written.counterBehind) {
    // `Q-218` R3: the page is stored, but this counter may be behind it, so the position is not vouched for.
    log.warn(`sync pull ${spaceId} ${family.collection}: record write failed: the seq counter could not be moved `
      + `past the page from ${logSafe(peer)}. The transfer holds at ${logSafe(deliveredThrough)} `
      + 'and the page is fetched again next cycle.');
    return { held: true };
  }
  if (written.storeRefused.length > 0) {
    // The documents are named once, by the writer's own summary (`warnArrivalsNotStored`); this says what it costs.
    log.warn(`sync pull ${spaceId} ${family.collection}: record write failed: the store refused `
      + `${written.storeRefused.length} document(s) from ${logSafe(peer)}. The `
      + `transfer holds at ${logSafe(deliveredThrough)} and the page is fetched again next cycle.`);
    return { held: true };
  }
  const where = `Pull from ${peer} '${spaceId}'`;
  const stored = new Set([...written.inserted, ...written.updated]);
  warnArrivalsNotStored(where, spaceId, family.collection, STORED_NOT_MATCHING, misses.filter(m => stored.has(m._id)));
  const unreported = written.diverged
    .filter(id => divergedNamed(`${spaceId}\u0000${family.collection}\u0000${id}`, () => undefined));
  warnArrivalsNotStored(where, spaceId, family.collection, KEPT_LOCAL, unreported);
  return { held: false, written };
}
