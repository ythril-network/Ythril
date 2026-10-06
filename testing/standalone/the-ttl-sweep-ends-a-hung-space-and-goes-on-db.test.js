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
 *  - space 1's facts stall (a view whose read sleeps 3 s, `withStalledReads`), the housekeeping bound is 1 s: the sweep ends in
 *    about one bound, says space 1 once under its own step with the bound in the line, and still sweeps space 2;
 *  - a timeout ends the SPACE, not just the collection: a space with two stalled collections costs one bound and says one line
 *    (the second collection is never read);
 *  - three spaces in a row that time out end the walk once ("the store looks stalled"), the space after them waits for the next
 *    cycle, and the next cycle sweeps it (the three are in quarantine).
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
import { setWriteBoundForTest, withStalledReads } from './_write-faults.mjs';

const skip = await mongoSkipReason();
const PAST = new Date('2020-01-01T00:00:00Z');
const BOUND_MS = 1000;
const STALL_MS = 3000;
/** What `withStalledReads` costs one source document, ms (`_write-faults.mjs`). */
const STALL_STEP_MS = 200;

const factDoc = (space, id) => ({ _id: id, spaceId: space, content: `expired ${id}`, seq: 1, createdAt: '2020-01-01T00:00:00.000Z', _expireAt: PAST });

/** Reads of `<space>_<part>` stall for at least STALL_MS for the sweep's own query while `fn` runs. */
async function hung(db, space, part, fn) {
  // The sweep's own first read of a collection (`expiredPage`, `brain/ttl-sweep.ts`): `_expireAt <= now`, plus `SWEEP_FILTER[part]` for
  // files (not used here: facts and entities have none). `now` is the sweep's tick, which a later `new Date()` is at or after.
  const readerFilter = { _expireAt: { $lte: new Date() } };
  const seed = Array.from({ length: Math.ceil(STALL_MS / STALL_STEP_MS) }, (_, i) => ({ _id: `__hung_${i}`, _expireAt: PAST }));
  return withStalledReads(db, `${space}_${part}`, `${space}_${part}_src`, { ms: STALL_MS, readerFilter, seed }, fn);
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

  it('space 1 stalled, space 2 healthy: ends in about one bound, says space 1 once, sweeps space 2', { timeout: 120_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(OK1, 'facts').insertMany([0, 1, 2].map((i) => factDoc(OK1, `ok1-${i}`)));
    await hung(db, H1, 'facts', async () => {
      const started = Date.now();
      await sweepExpired(new Date());
      const tookMs = Date.now() - started;
      assert.ok(tookMs >= BOUND_MS - 100, `ended after ${tookMs} ms, before the bound`);
      assert.ok(tookMs < STALL_MS - 500, `the sweep took ${tookMs} ms: it waited out the stall (${STALL_MS} ms) instead of ending at the ${BOUND_MS} ms bound`);
    });
    assert.equal(await door.coll(OK1, 'facts').countDocuments({}), 0, 'the healthy space behind the hung one was swept');
    const said1 = said('TTL sweep: facts', H1);
    assert.equal(said1.length, 1, `space 1 is said once, got ${said1.length}`);
    assert.match(said1[0], /time bound of 1000 ms/);
    assert.ok(walkMod.quarantinedSpaces().includes(H1), 'the hung space is passed over for a while');
  });

  it('a timeout ends the SPACE: two stalled collections cost one bound and say one line', { timeout: 120_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(OK2, 'facts').insertOne(factDoc(OK2, 'ok2-0'));
    await hung(db, H2, 'facts', () => hung(db, H2, 'entities', async () => {
      await sweepExpired(new Date());
    }));
    // The sweep reads the collections in TTL_COLLECTIONS order: the first of the two is read and times out, the second is never read.
    const [first, second] = ['facts', 'entities'].sort((a, b) => TTL_COLLECTIONS.indexOf(a) - TTL_COLLECTIONS.indexOf(b));
    assert.equal(said(`TTL sweep: ${first}`, H2).length, 1);
    assert.equal(said(`TTL sweep: ${second}`, H2).length, 0, 'the second collection was read: a timeout did not end the space');
    assert.equal(await door.coll(OK2, 'facts').countDocuments({}), 0);
  });

  it('three spaces in a row that time out end the walk once; the space behind waits, and the next cycle sweeps it', { timeout: 180_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(TAIL, 'facts').insertOne(factDoc(TAIL, 'tail-0'));
    await hung(db, K1, 'facts', () => hung(db, K2, 'facts', () => hung(db, K3, 'facts', async () => {
      const started = Date.now();
      await sweepExpired(new Date());
      assert.ok(Date.now() - started < 3 * BOUND_MS + 3000, `three bounds were expected, it took ${Date.now() - started} ms`);
    })));
    const stops = lines.filter((l) => /^TTL sweep stopped: 3 spaces timed out in a row; the store looks stalled — retried next cycle$/.test(l));
    assert.equal(stops.length, 1, `one stop line, got ${stops.length}`);
    for (const k of [K1, K2, K3]) assert.equal(said('TTL sweep: facts', k).length, 1, `${k} is said once`);
    assert.equal(await door.coll(TAIL, 'facts').countDocuments({}), 1, 'the walk stopped before the space behind the three');

    await sweepExpired(new Date());
    assert.equal(await door.coll(TAIL, 'facts').countDocuments({}), 0, 'the next cycle sweeps it (the three are in quarantine)');
  });
});
