/**
 * A pull that stopped at the cycle cap is PARTIAL, and a page error after earlier pages advanced the mark is a FAILURE (bundle-81,
 * design rev 8 §6 "A capped pull is partial, not failed" and the parent's decision 33; §7 "Re-read").
 *
 * ## The defect, and the reading decision 33 corrects
 *
 * A pull reads at most 50 pages of 200 per family per cycle (`sync/pull-family.ts`). Stopping there is not a fault, but the engine took
 * every stopped pull as an incomplete transfer, counted the member a failure and recorded the cycle `failed`: a large re-read (D-20) or
 * a long absence showed its member as unreachable. Rev 8 §6 proposed telling the two apart by comparing the mark before and after the
 * turn; decision 33 narrows it: a pull is partial ONLY when it stopped at the cycle cap with no page error. A page error after earlier
 * pages advanced the mark is a failure, because the mark moved for the pages that landed and the peer still failed.
 * `pull-family` returns why it stopped (`cap`, `error` or `done`), and the engine reads that, not the mark comparison.
 *
 * ## What the cases assert
 *
 * The peer's real page handler is asked for one record a page (the test forces `limit=1`), so the cap is reached with 50 records and
 * the peer still holds more. The network cycle runs as the scheduler runs it (`runSyncForNetwork`); the receive mark starts at a SENTINEL.
 *
 * - **cap, no error:** the receive mark moved above the sentinel, `ythril_sync_cycles_total{status="partial"}` counts the cycle and
 *   `failed` does not, and the member's `consecutiveFailures` did not move.
 * - **page error after progress:** the mark moved (three pages landed) AND the cycle is a failure: `failed` counted, `partial` not, the
 *   failure count +1. This is the case a mark-comparison engine gets wrong.
 * - **page error without progress:** the mark is exactly the sentinel, and it is a failure (today's behaviour, kept).
 *
 * ## Red at 9a7ab3f7
 *
 * Case 1 fails: base counts a capped pull as a failure (the failure count moves, the cycle is `failed`, no `partial`). Case 2 fails on the
 * mark (`lastPosReceived`, a name nothing writes at base), after its failure assertions, which hold at base. Case 3 holds at base.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-capped-pull-is-partial-and-a-page-error-after-progress-is-a-failure-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { clearPositionMarks, readMark, setMark, positioned } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'cappull';
const SENTINEL = 3;
/** The peer holds more than one cycle can read at one record a page (the cap is 50 requests per family). */
const PEER_RECORDS = 120;
/** Positions well above the sentinel, so a mark that moved is told from one that stayed. */
const BASE = 100;

let door, engine, syncCyclesTotal;

/** `facts` pages of ONE record each from the real handler; after `failAfter` of them the peer answers 500. */
function pagedAtOne({ failAfter = Infinity } = {}) {
  let served = 0;
  return async (req, res, family) => {
    if (family !== 'facts') { await door.serveFamily(req, res, family); return; }
    served++;
    if (served > failAfter) { res.status(500).json({ error: 'the peer failed on this page' }); return; }
    Object.defineProperty(req, 'query', { value: { ...req.query, limit: '1' }, writable: true, configurable: true, enumerable: true });
    await door.serveFamily(req, res, family);
  };
}

const statusCount = async (status) => {
  const { values } = await syncCyclesTotal.get();
  return values.filter(v => v.labels.network === door.NET && v.labels.status === status).reduce((n, v) => n + v.value, 0);
};
const received = () => door.coll(S, 'facts').countDocuments();

/** One network cycle, and what it did to the cycle counters and the member's failure count. */
async function cycle() {
  const before = { partial: await statusCount('partial'), failed: await statusCount('failed') };
  await engine.runSyncForNetwork(door.NET);
  await door.settled();
  return {
    partial: await statusCount('partial') - before.partial,
    failed: await statusCount('failed') - before.failed,
    failures: door.member().consecutiveFailures ?? 0,
  };
}

describe('a capped pull is partial, a page error after progress is a failure', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'b81tB_cap', spaces: [S], direction: 'pull' });
    engine = await import('../../server/dist/sync/engine.js');
    ({ syncCyclesTotal } = await import('../../server/dist/metrics/registry.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'pull' });
    clearPositionMarks(door);
    door.member().consecutiveFailures = 0;
    const docs = Array.from({ length: PEER_RECORDS }, (_, i) => positioned(build.fact(S, `cap-${String(i + 1).padStart(3, '0')}`, BASE + i + 1, { author: PEER_AUTHOR })));
    await door.seedPeerRecords(S, 'facts', docs);
    setMark(door, 'received', S, SENTINEL);
  });

  it('stopped at the cycle cap with no page error: the mark moved, the cycle is partial, no failure is counted', async () => {
    door.state.family = pagedAtOne();
    const out = await cycle();
    const asked = door.state.familyRequests.filter(r => r.family === 'facts').length;
    const have = await received();
    assert.ok(asked >= 50 && have > 0 && have < PEER_RECORDS,
      `control: the cycle asked for ${asked} pages and received ${have} of ${PEER_RECORDS}: it did not stop at the cap with records left, so this is not a capped pull`);
    assert.deepEqual({ partial: out.partial, failed: out.failed, failures: out.failures }, { partial: 1, failed: 0, failures: 0 },
      'a pull that stopped at the cycle cap was not counted partial: it was counted a failure of the member (a large re-read shows its member unreachable)');
    const mark = readMark(door, 'received', S);
    assert.ok(Number.isSafeInteger(mark) && mark > SENTINEL, `lastPosReceived is ${String(mark)}: a capped pull that landed ${have} records left the mark at the sentinel`);
  });

  it('a page error after earlier pages advanced the mark is a failure, and not partial', async () => {
    door.state.family = pagedAtOne({ failAfter: 3 });
    const out = await cycle();
    assert.equal(await received(), 3, 'control: the three pages before the error did not land, so no progress was made to judge');
    assert.deepEqual({ partial: out.partial, failed: out.failed, failures: out.failures }, { partial: 0, failed: 1, failures: 1 },
      'a page error after progress was not counted a failure: the engine read "the mark moved" as "partial"');
    const mark = readMark(door, 'received', S);
    assert.ok(Number.isSafeInteger(mark) && mark > SENTINEL, `lastPosReceived is ${String(mark)}: the pages that landed did not advance the mark`);
  });

  it('a page error with no progress is a failure and leaves the mark exactly where it was', async () => {
    door.state.family = pagedAtOne({ failAfter: 0 });
    const out = await cycle();
    assert.deepEqual({ partial: out.partial, failed: out.failed, failures: out.failures }, { partial: 0, failed: 1, failures: 1 }, 'a pull that failed on its first page was not counted a failure');
    assert.ok(readMark(door, 'received', S) === SENTINEL, `lastPosReceived is ${String(readMark(door, 'received', S))}: a pull that landed nothing moved the mark`);
  });
});
