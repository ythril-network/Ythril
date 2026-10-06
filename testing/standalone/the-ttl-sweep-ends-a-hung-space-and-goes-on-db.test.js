/**
 * The TTL sweep ends a hung space at its bound and goes on to the spaces behind it; a store that does not answer costs ONE bound
 * and ONE ping, not one per space (`Q-358`, `Q-274`; bundle-53 G10). Against the real store: a view whose reads stall, and a relay
 * that freezes.
 *
 * ## The defect it prevents
 *
 * A space whose read never returned held the sweep, and with it every later tick (the sweep's timer skips an overlapping tick,
 * so a hung tick turned the job OFF). A dead store read one space at a time paid the driver's wait once per space.
 *
 * ## What is held
 *
 *  - space 1's facts stall (a view whose read sleeps 4 s, `withStalledReads`), the housekeeping bound is 1 s: the sweep ends in
 *    about one bound, says space 1 once under its own step with the bound in the line, and still sweeps space 2;
 *  - a timeout ends the SPACE, not just the collection: a space with two stalled collections costs one bound and says one line
 *    (the second collection is never read);
 *  - three spaces in a row that time out end the walk once ("the store looks stalled"), the space after them waits for the next
 *    cycle, and the next cycle sweeps it (the three are in quarantine);
 *  - a store that FREEZES (the relay drops bytes and keeps the sockets open): the retention walk over three spaces ends in one
 *    bound plus one ping, reports `storeDown`, says ONE line for the step, and reaches only the first space.
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
import { startFreezableRelay } from './_freezable-relay.mjs';

const skip = await mongoSkipReason();
const PAST = new Date('2020-01-01T00:00:00Z');
const BOUND_MS = 1000;
const STALL_MS = 4000;

const factDoc = (space, id) => ({ _id: id, spaceId: space, content: `expired ${id}`, seq: 1, createdAt: '2020-01-01T00:00:00.000Z', _expireAt: PAST });
const spacesOf = (ids) => ids.map((id) => ({ id, label: id, folders: [] }));

/** Everything the log said while a case ran, and the housekeeping signals. */
async function listen() {
  const logMod = await import('../../server/dist/util/log.js');
  const { onHousekeepingSignal } = await import('../../server/dist/util/housekeeping-signals.js');
  const lines = [];
  const undo = [];
  for (const level of ['info', 'warn', 'error']) {
    const orig = logMod.log[level];
    logMod.log[level] = (m, ...rest) => { lines.push(String(m)); return orig(m, ...rest); };
    undo.push(() => { logMod.log[level] = orig; });
  }
  return { lines, stop: () => undo.forEach((u) => u()), onSignal: onHousekeepingSignal };
}

describe('the TTL sweep ends a hung space at its bound and goes on', { skip }, () => {
  const H1 = 'hang-1'; const OK1 = 'hang-ok-1';
  const H2 = 'hang-2'; const OK2 = 'hang-ok-2';
  const K1 = 'hang-k1'; const K2 = 'hang-k2'; const K3 = 'hang-k3'; const TAIL = 'hang-tail';
  let door; let sweepExpired; let walkMod; let restoreBound; let heard;

  before(async () => {
    door = await openPushDoor({ suite: 'ttlhang', spaces: spacesOf([H1, OK1, H2, OK2, K1, K2, K3, TAIL]) });
    ({ sweepExpired } = await import('../../server/dist/brain/ttl-sweep.js'));
    walkMod = await import('../../server/dist/util/housekeeping-walk.js');
    restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    heard = await listen();
  });
  after(async () => {
    heard?.stop();
    await restoreBound?.();
    await door?.close();
  });

  const said = (step, space) => heard.lines.filter((l) => l.startsWith(`${step} failed for space '${space}'`));

  it('space 1 stalled, space 2 healthy: ends in about one bound, says space 1 once, sweeps space 2', { timeout: 120_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(OK1, 'facts').insertMany([0, 1, 2].map((i) => factDoc(OK1, `ok1-${i}`)));
    await withStalledReads(db, `${H1}_facts`, `${H1}_facts_src`, { ms: STALL_MS }, async () => {
      const started = Date.now();
      await sweepExpired(new Date());
      const tookMs = Date.now() - started;
      assert.ok(tookMs >= BOUND_MS - 100, `ended after ${tookMs} ms, before the bound`);
      assert.ok(tookMs < STALL_MS - 500, `the sweep took ${tookMs} ms: it waited out the stall (${STALL_MS} ms) instead of ending at the ${BOUND_MS} ms bound`);
    });
    assert.equal(await door.coll(OK1, 'facts').countDocuments({}), 0, 'the healthy space behind the hung one was swept');
    const lines = said('TTL sweep: facts', H1);
    assert.equal(lines.length, 1, `space 1 is said once, got ${lines.length}`);
    assert.match(lines[0], /time bound of 1000 ms/);
    assert.ok(walkMod.quarantinedSpaces().includes(H1), 'the hung space is passed over for a while');
  });

  it('a timeout ends the SPACE: two stalled collections cost one bound and say one line', { timeout: 120_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(OK2, 'facts').insertOne(factDoc(OK2, 'ok2-0'));
    await withStalledReads(db, `${H2}_facts`, `${H2}_facts_src`, { ms: STALL_MS }, () =>
      withStalledReads(db, `${H2}_entities`, `${H2}_entities_src`, { ms: STALL_MS }, async () => {
        await sweepExpired(new Date());
      }));
    assert.equal(said('TTL sweep: facts', H2).length, 1);
    assert.equal(said('TTL sweep: entities', H2).length, 0, 'the second collection was read: a timeout did not end the space');
    assert.equal(await door.coll(OK2, 'facts').countDocuments({}), 0);
  });

  it('three spaces in a row that time out end the walk once; the space behind waits, and the next cycle sweeps it', { timeout: 180_000 }, async () => {
    const db = door.mongo.getDb();
    await door.coll(TAIL, 'facts').insertOne(factDoc(TAIL, 'tail-0'));
    const stalled = (space, fn) => withStalledReads(db, `${space}_facts`, `${space}_facts_src`, { ms: STALL_MS }, fn);
    await stalled(K1, () => stalled(K2, () => stalled(K3, async () => {
      const started = Date.now();
      await sweepExpired(new Date());
      assert.ok(Date.now() - started < 3 * BOUND_MS + 3000, `three bounds were expected, it took ${Date.now() - started} ms`);
    })));
    const stops = heard.lines.filter((l) => /^TTL sweep stopped: 3 spaces timed out in a row; the store looks stalled — retried next cycle$/.test(l));
    assert.equal(stops.length, 1, `one stop line, got ${stops.length}`);
    for (const k of [K1, K2, K3]) assert.equal(said('TTL sweep: facts', k).length, 1, `${k} is said once`);
    assert.equal(await door.coll(TAIL, 'facts').countDocuments({}), 1, 'the walk stopped before the space behind the three');

    await sweepExpired(new Date());
    assert.equal(await door.coll(TAIL, 'facts').countDocuments({}), 0, 'the next cycle sweeps it (the three are in quarantine)');
  });
});

describe('a store that freezes costs the retention walk one bound and one ping', { skip }, () => {
  const QUERY = '&connectTimeoutMS=1000&heartbeatFrequencyMS=500&serverSelectionTimeoutMS=10000';
  const R = ['freeze-1', 'freeze-2', 'freeze-3'];
  let relay; let door; let sweepExpiredRecords; let restoreBound; let heard; let forgetCachedProbes;

  before(async () => {
    relay = await startFreezableRelay('ythril_harness_ttlfreeze', { query: QUERY });
    // The relay hands back its address; the door builds its own URI, so only the port is needed.
    const port = Number(relay.address.split(':').at(-1));
    door = await openPushDoor({ suite: 'ttlfreeze', spaces: spacesOf(R), mongoPort: port, mongoQuery: QUERY });
    ({ sweepExpiredRecords } = await import('../../server/dist/brain/ttl-sweep.js'));
    ({ forgetCachedProbes } = await import('../../server/dist/util/cached-probe.js'));
    restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    for (const id of R) await door.coll(id, 'facts').insertOne(factDoc(id, `${id}-0`));
    heard = await listen();
  });
  after(async () => {
    heard?.stop();
    relay?.thaw();
    await restoreBound?.();
    await door?.close();
    await relay?.close();
  });

  it('ends at one bound plus one ping, reports storeDown, says ONE line, and reaches only the first space', { timeout: 120_000 }, async () => {
    // The ping is memoised for ten seconds in production; an earlier answer ("the store answers") must not stand in for this one.
    forgetCachedProbes();
    relay.freeze();
    let result; let tookMs;
    try {
      const started = Date.now();
      result = await sweepExpiredRecords(new Date());
      tookMs = Date.now() - started;
    } finally { relay.thaw(); }

    assert.equal(result.walk.storeDown, true, 'a store that does not answer is the walk\'s stop, not the first space\'s failure');
    assert.equal(result.walk.outcomes.length, 1, 'only the first space was reached: the walk did not pay a bound per space');
    assert.ok(tookMs >= BOUND_MS - 100, `ended after ${tookMs} ms, before the bound`);
    assert.ok(tookMs <= BOUND_MS + 3000 + 3000, `a frozen store cost ${tookMs} ms: one bound (${BOUND_MS}) and one ping (3000) were expected`);
    const stops = heard.lines.filter((l) => /^TTL sweep stopped: the store is not answering/.test(l));
    assert.equal(stops.length, 1, `one store line, got ${stops.length}`);
    assert.equal(heard.lines.filter((l) => /failed for space/.test(l)).length, 0, 'no space is blamed for the store');
  });
});
