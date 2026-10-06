/**
 * A store that FREEZES costs the TTL retention walk ONE bound and ONE ping, not one per space (`Q-358`, `Q-274`; bundle-53 G10).
 * The freezable relay drops bytes in both directions and keeps the sockets open: a paused store, which a closed port is not.
 *
 * ## The defect it prevents
 *
 * A dead store read one space at a time paid the driver's wait once per space: with N spaces the sweep took N waits to learn what
 * the first one already said. With the verdict, a timeout on a store that does not answer a ping is the STORE's, and ends the walk.
 *
 * ## What is held
 *
 * With three spaces and a frozen store the retention walk ends in about one bound plus one ping, reports `storeDown`, reaches only
 * the first space, says ONE line for the step (`TTL sweep stopped: the store is not answering ...`), and blames no space.
 *
 * It runs `sweepExpiredRecords`, the retention walk alone: the sweep's other steps (chrono retention, spill sweep, the stray
 * drain) are other groups' and are not this walk's question.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/the-ttl-sweep-stops-at-once-on-a-frozen-store-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { setWriteBoundForTest } from './_write-faults.mjs';
import { startFreezableRelay } from './_freezable-relay.mjs';

const skip = await mongoSkipReason();
const PAST = new Date('2020-01-01T00:00:00Z');
const BOUND_MS = 1000;
const PING_MS = 3000;
const QUERY = '&connectTimeoutMS=1000&heartbeatFrequencyMS=500&serverSelectionTimeoutMS=10000';
const R = ['freeze-1', 'freeze-2', 'freeze-3'];

describe('a store that freezes costs the retention walk one bound and one ping', { skip }, () => {
  let relay; let door; let sweepExpiredRecords; let restoreBound; let forgetCachedProbes;
  const lines = [];
  const undo = [];

  before(async () => {
    relay = await startFreezableRelay('ythril_harness_ttlfreeze', { query: QUERY });
    // The relay hands back its address; the door builds its own URI, so only the port is needed.
    const port = Number(relay.address.split(':').at(-1));
    door = await openPushDoor({
      suite: 'ttlfreeze', spaces: R.map((id) => ({ id, label: id, folders: [] })), mongoPort: port, mongoQuery: QUERY,
    });
    ({ sweepExpiredRecords } = await import('../../server/dist/brain/ttl-sweep.js'));
    ({ forgetCachedProbes } = await import('../../server/dist/util/cached-probe.js'));
    restoreBound = await setWriteBoundForTest({ housekeepingOpMs: BOUND_MS });
    for (const id of R) {
      await door.coll(id, 'facts').insertOne({ _id: `${id}-0`, spaceId: id, content: 'expired', seq: 1, createdAt: '2020-01-01T00:00:00.000Z', _expireAt: PAST });
    }
    const logMod = await import('../../server/dist/util/log.js');
    for (const level of ['info', 'warn', 'error']) {
      const orig = logMod.log[level];
      logMod.log[level] = (m, ...rest) => { lines.push(String(m)); return orig(m, ...rest); };
      undo.push(() => { logMod.log[level] = orig; });
    }
  });
  after(async () => {
    undo.forEach((u) => u());
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
    assert.ok(tookMs <= BOUND_MS + PING_MS + 3000, `a frozen store cost ${tookMs} ms: one bound (${BOUND_MS}) and one ping (${PING_MS}) were expected`);
    const stops = lines.filter((l) => /^TTL sweep stopped: the store is not answering/.test(l));
    assert.equal(stops.length, 1, `one store line, got ${stops.length}`);
    assert.equal(lines.filter((l) => /failed for space/.test(l)).length, 0, 'no space is blamed for the store');
  });
});
