/**
 * A `200` from a peer does not mean every record landed. This is the part that notices.
 *
 * ## What was silent
 *
 * `POST /api/sync/batch-upsert` refuses a fact whose content diverges at an identical `seq` once that
 * record's fork chain is at `MAX_FORK_DEPTH`: the incoming version is discarded and the request still answers
 * `200`. Until now that was counted in the same `skipped` integer as *"I already hold this record, at the same
 * seq or newer"* — which is the common case, is correct, and loses nothing.
 *
 * One number, two opposite meanings. So the lossy one had never been seen.
 *
 * And the pusher checked only `resp.ok`, never the body. It then advanced `lastSeqPushed` past the discarded
 * record and **never offered it again** — a permanent loss, unreported at both ends.
 *
 * ## Why the watermark still advances
 *
 * The receiver would refuse the identical record on every future cycle, so holding the watermark back would
 * stall that space's sync entirely and deliver nothing. **The defect was the silence, not the advance** — the
 * same conclusion the swallowed media-worker writes reached earlier in this release cycle: the fix is
 * visibility, not severity.
 *
 * ## Why this is its own file
 *
 * `no-new-god-files.test.js` freezes `sync/engine.ts` at its current size and says why: *"the failure mode of
 * a god-file is not its size on any given day — it is that every change lands in the same place because that
 * is where the code already is. Put the new behaviour beside it rather than inside it."* It refused this
 * change inside the engine, correctly, so the behaviour lives here and the engine calls it.
 */
import { log } from '../util/log.js';
import { boundedJson } from '../util/bounded-read.js';

/** The per-type counters `batch-upsert` returns. Only the lossy one is named; the rest are not ours to read. */
type BatchUpsertReply = Record<string, { forkDepthRefused?: number } | undefined> | null;

/**
 * Report records the peer accepted the request for and then discarded. Never throws.
 *
 * **`boundedJson` and not `resp.json()`**: this body comes from a peer, and `resp.json()` would read whatever
 * it sends into fact with no ceiling. The batch timeout does not help — it bounds duration, not size, and
 * `upstream-reads-are-bounded.test.js` refuses the unbounded form.
 *
 * **Every failure here is swallowed on purpose, and this is the one place that is right.** The push already
 * succeeded; a peer on an older build sends no such field, and a body that will not parse must not turn a
 * delivery the peer accepted into a failed one. The cost of being wrong is a missing log line, and the
 * alternative is failing sync over a diagnostic.
 */
export async function reportPushRefusals(
  resp: Response,
  payloadKey: string,
  peerLabel: string,
  spaceId: string,
): Promise<void> {
  try {
    const body = await boundedJson<BatchUpsertReply>(
      resp, `batch-upsert ${payloadKey} response from ${peerLabel}`);
    const refused = body?.[payloadKey]?.forkDepthRefused ?? 0;
    if (refused > 0) {
      log.warn(`Batch push ${payloadKey} to ${peerLabel}: ${refused} record(s) DROPPED by the peer `
        + `(fork chain at its cap) in space '${spaceId}'. They will not be offered again — the peer's log `
        + 'names the record ids.');
    }
  } catch { /* a diagnostic must never fail a push the peer accepted */ }
}
