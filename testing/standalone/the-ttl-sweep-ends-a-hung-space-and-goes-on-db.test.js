/**
 * The TTL sweep ends a hung space at its bound and goes on to the spaces behind it (`Q-358`, `Q-274`; bundle-53 G10). Against the
 * real store: a view whose reads stall. (A store that freezes is `the-ttl-sweep-stops-at-once-on-a-frozen-store-db.test.js`: a
 * second door cannot be opened in one process, so it is a file of its own.)
 *
 * ## The defect it prevents
 *
 * A space whose read never returned held the sweep, and with it every later tick (the sweep's timer skips an overlapping tick,
 * so a hung tick turned the job OFF).
 *
 * ## What is held
 *
 *  - space 1's facts stall (a view whose read sleeps far longer than the bound, `withStalledReads`), the housekeeping bound is 2.5 s: the sweep ends in
 *    about one bound, says space 1 once under its own step with the bound in the line, and still sweeps space 2;
 *  - a timeout ends the SPACE, not just the collection: a space with two stalled collections costs one bound and says one line
 *    (the second collection is never read);
 *  - three spaces in a row that time out end the walk once ("the store looks stalled"), the space after them waits for the next
 *    cycle, and the next cycle sweeps it (the three are in quarantine).
 *
 * ## Why a healthy space that passed the bound is swept once more (`Q-954`)
 *
 * The bound is the housekeeping bound, and it binds every space the sweep walks, the healthy ones too. At 1 s a loaded shard ran
 * the healthy space's own call past it (main run 44845573169: "TTL sweep: facts failed for space hang-ok-1: a database operation
 * ran past its time bound of 1000 ms"), the space was quarantined instead of swept, and the case failed on a product that had not
 * changed. The bound is 2.5 s now (the file takes about 46 s alone against 37 s at 1 s: the third case waits three bounds), and a
 * healthy space the sweep ended at its OWN bound, in this case or an earlier one, is a space the sweep went on to. Such a space is let out of quarantine
 * and swept once more alone, and that sweep must empty it. The planted defect (the sweep stopping at the hung space) never reaches
 * the healthy space, so it neither empties it nor says it, and the case still fails on it.
 *
 * ## What the stall costs, and why the fixture is given the reader's filter and its own seeds
 *
 * `withStalledReads` makes a source document cost a read one sleep, but the sweep reads with `_expireAt <= now`, and the server
 * evaluates that cheap predicate BEFORE the view's sleeping stage, so the fixture's own default seeds (which carry no `_expireAt`)
 * cost nothing to THIS read: it measured 161 ms against a 3 s stall. The test passes the sweep's filter as `readerFilter`, so the
 * fixture's guard reads with it, and expired documents as `seed`, so each one the sweep's filter lets through pays the sleep.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-ttl-sweep-ends-a-hung-space-and-goes-on-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { setWriteBoundForTest, withStalledReadsMany } from './_write-faults.mjs';

const skip = await mongoSkipReason();
const PAST = new Date('2020-01-01T00:00:00Z');
// 2.5 s, not 1: the bound binds the healthy spaces too, and a loaded shard ran one past 1 s (`Q-954`, see the header).
const BOUND_MS = 2500;
// Far above the bound: "the sweep ended at the bound, not at the stall" is told apart by STALL_MS - 500, and the sweep's own work on
// the healthy spaces counts into the same clock. At 3000 the margin was 1.5 s and four -db files running at once used it up
// (2820 ms, bundle-211). The fixture's guard waits the stall out once per case, however many views the case stalls
// (`withStalledReadsMany` guards them together), so a longer stall costs the run its length once per case.
const STALL_MS = 8000;
/** What `withStalledReads` costs one source document, ms (`_write-faults.mjs`). */
const STALL_STEP_MS = 200;

const factDoc = (space, id) => ({ _id: id, spaceId: space, content: `expired ${id}`, seq: 1, createdAt: '2020-01-01T00:00:00.000Z', _expireAt: PAST });

/**
 * Reads of each `[space, part]` (`<space>_<part>`) stall for at least STALL_MS for the sweep's own query while `fn` runs, all of
 * them together and each one guarded.
 */
async function hung(db, views, fn) {
  // The sweep's own first read of a collection (`expiredPage`, `brain/ttl-sweep.ts`): `_expireAt <= now`, plus `SWEEP_FILTER[part]` for
  // files (not used here: facts and entities have none). `now` is the sweep's tick, which a later `new Date()` is at or after.
  const readerFilter = { _expireAt: { $lte: new Date() } };
  const seed = () => Array.from({ length: Math.ceil(STALL_MS / STALL_STEP_MS) }, (_, i) => ({ _id: `__hung_${i}`, _expireAt: PAST }));
  const specs = views.map(([space, part]) => ({ name: `${space}_${part}`, viewOn: `${space}_${part}_src`, ms: STALL_MS, readerFilter, seed: seed() }));
  return withStalledReadsMany(db, specs, fn);
}

describe('the TTL sweep ends a hung space at its bound and goes on', { skip }, () => {
  const H1 = 'hang-1'; const OK1 = 'hang-ok-1';
  const H2 = 'hang-2'; const OK2 = 'hang-ok-2';
  const K1 = 'hang-k1'; const K2 = 'hang-k2'; const K3 = 'hang-k3'; const TAIL = 'hang-tail';
  let door; let sweepExpired; let walkMod; let restoreBound; let TTL_COLLECTIONS;
  const lines = [];
  const undo = [];

  before(async () => {
    door = await openPushDoor({
      suite: 'ttlhang',
      spaces: [H1, OK1, H2, OK2, K1, K2, K3, TAIL].map((id) => ({ id, label: id, folders: [] })),
    });
    ({ sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js'));
    // Loaded after the door: the server's config module reads its path when first imported.
    ({ TTL_COLLECTIONS } = await import('../../server/dist/brain/ttl.js'));
    walkMod = await import('../../server/dist/util/housekeeping-walk.js');
    restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    const logMod = await import('../../server/dist/util/log.js');
    for (const level of ['info', 'warn', 'error']) {
      const orig = logMod.log[level];
      logMod.log[level] = (m, ...rest) => { lines.push(String(m)); return orig(m, ...rest); };
      undo.push(() => { logMod.log[level] = orig; });
    }
  });
  after(async () => {
    undo.forEach((u) => u());
    await restoreBound?.();
    await door?.close();
  });

  const said = (step, space) => lines.filter((l) => l.startsWith(`${step} failed for space '${space}'`));

  /**
   * Hold that the sweep went on to the healthy `space` and swept it. Swept at once is the usual answer; a space the sweep ended at its
   * own bound (a line naming the space and the bound; an earlier case's sweep counts, since it left the space in quarantine) was reached too, on a runner too slow for the bound, and is
   * let out of quarantine and swept once more alone, which must empty it (the slow-load pitfall: a unit that missed a time bound is
   * tried once more before it is reported; the retry is printed so a space that keeps needing one is seen). A space the sweep never
   * reached has neither, and fails here.
   */
  async function assertSwept(space, msg) {
    if (await door.coll(space, 'facts').countDocuments({}) === 0) return;
    // Any step, not only facts: the sweep reads a space's collections in TTL_COLLECTIONS order, and a healthy space whose first,
    // empty read passed the bound is said under that step and its facts are never read.
    const ownBound = lines.filter((l) => /^TTL sweep: \S+ failed for space '/.test(l) && l.includes(`failed for space '${space}'`) && l.includes(`time bound of ${BOUND_MS} ms`));
    assert.ok(ownBound.length > 0, `${msg}: it holds its expired facts and the sweep said nothing about it, so it was never reached`);
    console.log(`# retry: ${space} was ended at its own ${BOUND_MS} ms bound on this runner; swept once more alone`);
    walkMod.liftQuarantine(space);
    await sweepExpired(new Date());
    assert.equal(await door.coll(space, 'facts').countDocuments({}), 0, `${msg}: the sweep ended it at its own bound, and a second sweep alone did not sweep it either`);
  }

  it('space 1 stalled, space 2 healthy: ends in about one bound, says space 1 once, sweeps space 2', { timeout: 120_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(OK1, 'facts').insertMany([0, 1, 2].map((i) => factDoc(OK1, `ok1-${i}`)));
    await hung(db, [[H1, 'facts']], async () => {
      const started = Date.now();
      await sweepExpired(new Date());
      const tookMs = Date.now() - started;
      assert.ok(tookMs >= BOUND_MS - 100, `ended after ${tookMs} ms, before the bound`);
      assert.ok(tookMs < STALL_MS - 500, `the sweep took ${tookMs} ms: it waited out the stall (${STALL_MS} ms) instead of ending at the ${BOUND_MS} ms bound`);
    });
    await assertSwept(OK1, 'the healthy space behind the hung one');
    const said1 = said('TTL sweep: facts', H1);
    assert.equal(said1.length, 1, `space 1 is said once, got ${said1.length}`);
    assert.match(said1[0], new RegExp(`time bound of ${BOUND_MS} ms`));
    assert.ok(walkMod.quarantinedSpaces().includes(H1), 'the hung space is passed over for a while');
  });

  it('a timeout ends the SPACE: two stalled collections cost one bound and say one line', { timeout: 120_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(OK2, 'facts').insertOne(factDoc(OK2, 'ok2-0'));
    await hung(db, [[H2, 'facts'], [H2, 'entities']], async () => {
      await sweepExpired(new Date());
    });
    // The sweep reads the collections in TTL_COLLECTIONS order: the first of the two is read and times out, the second is never read.
    const [first, second] = ['facts', 'entities'].sort((a, b) => TTL_COLLECTIONS.indexOf(a) - TTL_COLLECTIONS.indexOf(b));
    assert.equal(said(`TTL sweep: ${first}`, H2).length, 1);
    assert.equal(said(`TTL sweep: ${second}`, H2).length, 0, 'the second collection was read: a timeout did not end the space');
    await assertSwept(OK2, 'the healthy space behind the space with two stalled collections');
  });

  it('three spaces in a row that time out end the walk once; the space behind waits, and the next cycle sweeps it', { timeout: 180_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(TAIL, 'facts').insertOne(factDoc(TAIL, 'tail-0'));
    await hung(db, [[K1, 'facts'], [K2, 'facts'], [K3, 'facts']], async () => {
      const started = Date.now();
      await sweepExpired(new Date());
      // Told apart from the defect by its own duration: one of the three spaces waiting its stall out costs two bounds and a stall.
      assert.ok(Date.now() - started < 2 * BOUND_MS + STALL_MS - 500, `three bounds were expected, it took ${Date.now() - started} ms: a space waited out its stall (${STALL_MS} ms)`);
    });
    const stops = lines.filter((l) => /^TTL sweep stopped: 3 spaces timed out in a row; the store looks stalled — retried next cycle$/.test(l));
    assert.equal(stops.length, 1, `one stop line, got ${stops.length}`);
    for (const k of [K1, K2, K3]) assert.equal(said('TTL sweep: facts', k).length, 1, `${k} is said once`);
    assert.equal(await door.coll(TAIL, 'facts').countDocuments({}), 1, 'the walk stopped before the space behind the three');

    await sweepExpired(new Date());
    await assertSwept(TAIL, 'the next cycle sweeps the space behind the three (they are in quarantine)');
  });
});
