/**
 * A database-level call (`listCollections`, `dropCollection`) carries the bound inside a bound scope, through the one door
 * every collection is reached by (`Q-358`, bundle-53 G5).
 *
 * ## The defect
 *
 * The write bound is applied by `observeRecordWrites` (`db/record-write-observer.ts`) to a COLLECTION's methods. A housekeeping
 * unit also issues two calls on the `Db` itself: `listCollections` (a drain, a spill store, a wipe asks what exists) and
 * `dropCollection` (the stray file-metadata drain). Those went out with no bound at all, so a unit bounded everywhere else could
 * still hang on the one call nothing covered. The proxy returned `Reflect.get` for every property but `collection`.
 *
 * ## The rule
 *
 * - `BOUNDED_DB_OPTIONS_ARGUMENT` names, at the Db level, where each bounded method takes its options (`listCollections`
 *   and `dropCollection`: argument 1). Inside a scope the call receives the bound there; outside, the arguments are the
 *   caller's own, the same objects. A collection's call still goes through the collection table, unchanged: there is ONE door.
 * - `dropCollection` is a WRITE: `maxTimeMS` = the bound, no `timeoutMS` (a client's is switched off), and the client backstop
 *   `SERVER_FIRST_MARGIN_MS` later answers `StoreTimeout`. A drop the bound ended cannot land afterwards (probe P8).
 *   `listCollections` is a READ that returns a cursor synchronously: it carries `maxTimeMS`, and a bound that is refused (a hold
 *   whose time is spent) THROWS where a write REJECTS.
 * - Never both `maxTimeMS` and a positive `timeoutMS`: the driver keeps `timeoutMS` and drops `maxTimeMS`.
 * - The Db-level table and the Db-level classification agree, DERIVED from the exported tables and from the driver's own
 *   `Db.prototype`: every method the driver's `Db` has is classified; every classified method is bounded or named in
 *   `UNBOUNDED_DB_METHODS` with its reason; a bounded one that writes is a plain write.
 *
 * ## Seen red
 *
 * Mutations, by hand and put back by hand: `dropCollection` removed from `BOUNDED_DB_OPTIONS_ARGUMENT`; `listCollections`
 * left out of the proxy's bounded branch; a method added to `Db` classification and left out of both tables.
 *
 * Run: node --test testing/standalone/a-db-level-call-is-bounded-in-a-scope.test.js   (requires a prior build of server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as wb from '../../server/dist/db/write-bound.js';
import { StoreTimeout } from '../../server/dist/db/write-timeout.js';
import * as observer from '../../server/dist/db/record-write-observer.js';
import { sleep } from '../_shared/sleep.mjs';

const require = createRequire(import.meta.url);
const { Db } = require('mongodb');

/** The driver's own list of what a database can do — never a list written here. */
const driverDbMethods = Object.getOwnPropertyNames(Db.prototype)
  .filter(k => k !== 'constructor' && typeof Object.getOwnPropertyDescriptor(Db.prototype, k).value === 'function');

/** A recording stand-in `Db`: each method notes the arguments it was called with and answers; `timeoutMS` is the client's. */
function recordingDb({ timeoutMS, never = false } = {}) {
  const calls = [];
  const answer = (name) => (...args) => {
    calls.push({ name, args });
    return never ? new Promise(() => {}) : Promise.resolve({ ok: 1 });
  };
  const collection = (name) => ({
    find: (...args) => { calls.push({ name: `${name}.find`, args }); return { fake: 'cursor' }; },
    insertOne: (...args) => { calls.push({ name: `${name}.insertOne`, args }); return Promise.resolve({ ok: 1 }); },
  });
  return {
    db: {
      databaseName: 'fake', timeoutMS, collection,
      listCollections: (...args) => { calls.push({ name: 'listCollections', args }); return { fake: 'cursor' }; },
      dropCollection: answer('dropCollection'),
    },
    calls,
  };
}
const observed = (fake) => observer.observeRecordWrites(fake, () => false, () => {});

describe('the Db-level table and classification', () => {
  it('the tables exist, and name the two bounded calls (floor)', () => {
    assert.ok(wb.BOUNDED_DB_OPTIONS_ARGUMENT, 'BOUNDED_DB_OPTIONS_ARGUMENT is not exported');
    assert.deepEqual(Object.keys(wb.BOUNDED_DB_OPTIONS_ARGUMENT).sort(), ['dropCollection', 'listCollections']);
    for (const [method, at] of Object.entries(wb.BOUNDED_DB_OPTIONS_ARGUMENT)) assert.equal(at, 1, `${method} takes its options at argument 1`);
    assert.ok(wb.PLAIN_DB_WRITE_METHODS?.has('dropCollection'), 'dropCollection is a write: it is ended by the server first');
    assert.ok(observer.DB_METHOD_EFFECT && observer.UNBOUNDED_DB_METHODS, 'the Db classification and the unbounded set are not exported');
  });

  it('found the driver\'s Db methods (floor)', () => {
    assert.ok(driverDbMethods.length >= 8, `only ${driverDbMethods.length} method(s) read off Db.prototype — the scan is broken`);
    assert.ok(driverDbMethods.includes('listCollections') && driverDbMethods.includes('dropCollection'));
  });

  it('every method of the driver\'s Db is classified', () => {
    const unclassified = driverDbMethods.filter(m => !(m in observer.DB_METHOD_EFFECT));
    assert.deepEqual(unclassified, [], `Db has method(s) nobody classified: ${unclassified}. Say whether each reads or writes in db/record-write-observer.ts, and bound it or name why it is not`);
  });

  it('every classified method is bounded or named in UNBOUNDED_DB_METHODS with a reason, and never both', () => {
    for (const method of Object.keys(observer.DB_METHOD_EFFECT)) {
      const bounded = wb.BOUNDED_DB_OPTIONS_ARGUMENT[method] !== undefined;
      const reason = observer.UNBOUNDED_DB_METHODS[method];
      assert.ok(bounded !== (reason !== undefined), `${method}: ${bounded ? 'is bounded AND has an unbounded reason' : 'is neither bounded nor given a reason'}`);
      if (reason !== undefined) assert.ok(typeof reason === 'string' && reason.length >= 20, `${method}: the reason is not a sentence`);
    }
    for (const method of Object.keys(observer.UNBOUNDED_DB_METHODS)) assert.ok(method in observer.DB_METHOD_EFFECT, `${method} is named unbounded but is not classified`);
  });

  it('a bounded method is classified, and a bounded one that writes is a plain write (server first), and only those', () => {
    const bounded = Object.keys(wb.BOUNDED_DB_OPTIONS_ARGUMENT);
    for (const m of bounded) assert.ok(m in observer.DB_METHOD_EFFECT, `${m} is bounded but not classified`);
    const writers = bounded.filter(m => observer.DB_METHOD_EFFECT[m] !== 'read');
    assert.ok(writers.length >= 1, 'no bounded Db write to hold (floor)');
    for (const m of writers) assert.ok(wb.PLAIN_DB_WRITE_METHODS.has(m), `${m} writes and is not server-first: a bound that ends it on the client can let it land afterwards`);
    for (const m of wb.PLAIN_DB_WRITE_METHODS) assert.ok(writers.includes(m), `${m} is a plain write but is not a bounded writing method`);
  });

  it('a method that returns a cursor and is bounded is in RETURNS_CURSOR, so a refusal throws', () => {
    assert.ok(wb.RETURNS_CURSOR.has('listCollections'));
    assert.equal(wb.RETURNS_CURSOR.has('dropCollection'), false);
  });

  it('the Db names do not collide with the Collection\'s: one name, one table', () => {
    for (const m of Object.keys(wb.BOUNDED_DB_OPTIONS_ARGUMENT)) assert.equal(wb.BOUNDED_OPTIONS_ARGUMENT[m], undefined, `${m} is in both tables`);
  });
});

describe('through observeRecordWrites, over a recording Db', () => {
  let holdTheLoop;
  before(() => { wb.setWriteBoundForTest({ writeTimeoutMs: 6000, holdDeadlineMs: 20_000, housekeepingOpMs: 7000 }); holdTheLoop = setInterval(() => {}, 60_000); });
  after(() => { wb.setWriteBoundForTest(null); clearInterval(holdTheLoop); });

  it('inside a housekeeping scope listCollections receives maxTimeMS = the figure, and keeps the caller\'s own options', async () => {
    const { db, calls } = recordingDb();
    await wb.withinHousekeepingBound(async () => { observed(db).listCollections({ name: 'x' }, { nameOnly: true }); });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args[0], { name: 'x' });
    assert.deepEqual(calls[0].args[1], { nameOnly: true, maxTimeMS: 7000 });
  });

  it('listCollections with no arguments at all still receives the bound, with the filter left to the driver\'s default', async () => {
    const { db, calls } = recordingDb();
    await wb.withinHousekeepingBound(async () => { observed(db).listCollections(); });
    assert.deepEqual(calls[0].args[1], { maxTimeMS: 7000 });
  });

  it('inside a housekeeping scope dropCollection receives maxTimeMS = the figure and no driver timeoutMS', async () => {
    const { db, calls } = recordingDb();
    await wb.withinHousekeepingBound(() => observed(db).dropCollection('stray'));
    assert.equal(calls[0].args[0], 'stray');
    assert.deepEqual(calls[0].args[1].maxTimeMS, 7000);
    assert.equal('timeoutMS' in calls[0].args[1], false);
  });

  it('a client timeoutMS is switched off for both, so the figure is the one clock', async () => {
    const { db, calls } = recordingDb({ timeoutMS: 300 });
    await wb.withinHousekeepingBound(async () => { observed(db).listCollections({}, {}); await observed(db).dropCollection('x'); });
    for (const c of calls) {
      assert.equal(c.args[1].timeoutMS, 0, `${c.name}: the client's 300 ms clock would end it before the server's deadline`);
      assert.equal(c.args[1].maxTimeMS, 7000, c.name);
    }
  });

  it('a caller\'s own lower maxTimeMS is kept; a higher one is lowered; neither adds a timeoutMS', async () => {
    const { db, calls } = recordingDb();
    await wb.withinHousekeepingBound(async () => {
      observed(db).listCollections({}, { maxTimeMS: 90 });
      observed(db).listCollections({}, { maxTimeMS: 99_999 });
      await observed(db).dropCollection('x', { maxTimeMS: 90 });
    });
    assert.deepEqual(calls.map(c => c.args[1].maxTimeMS), [90, 7000, 90]);
    for (const c of calls) assert.equal('timeoutMS' in c.args[1], false, `${c.name}: maxTimeMS and timeoutMS together are read as timeoutMS alone`);
  });

  it('inside a hold the Db-level calls carry the write bound, as a collection\'s do', async () => {
    const { db, calls } = recordingDb();
    await wb.withinWriteBound(async () => { observed(db).listCollections(); await observed(db).dropCollection('x'); });
    assert.deepEqual(calls.map(c => c.args[1].maxTimeMS), [6000, 6000]);
  });

  it('outside any scope the arguments reach the driver untouched, the same objects', async () => {
    const { db, calls } = recordingDb();
    const filter = { name: 'x' }; const options = { nameOnly: true };
    observed(db).listCollections(filter, options);
    await observed(db).dropCollection('x', options);
    assert.equal(calls[0].args[0], filter);
    assert.equal(calls[0].args[1], options);
    assert.equal(calls[1].args[1], options);
    assert.deepEqual(options, { nameOnly: true }, 'the caller\'s own options object was mutated');
  });

  it('a hold whose time is spent refuses the drop unsent (rejected) and the listing unsent (thrown, as a cursor method does)', async () => {
    wb.setWriteBoundForTest({ holdDeadlineMs: 20 });
    try {
      const { db, calls } = recordingDb();
      await wb.withinWriteBound(async () => {
        await sleep(60);
        assert.throws(() => observed(db).listCollections(), StoreTimeout);
        await assert.rejects(observed(db).dropCollection('x'), StoreTimeout);
      });
      assert.deepEqual(calls, [], 'a refused call was sent');
    } finally {
      wb.setWriteBoundForTest({ holdDeadlineMs: 20_000 });
    }
  });

  it('a drop that never settles is answered StoreTimeout at the figure plus the backstop margin', async () => {
    const { db } = recordingDb({ never: true });
    const t0 = Date.now();
    const error = await wb.withinHousekeepingBound(() => observed(db).dropCollection('x').then(() => null, (e) => e), { opMs: 60 });
    assert.ok(error instanceof StoreTimeout, `answered ${error}`);
    assert.ok(Date.now() - t0 >= 60 + wb.SERVER_FIRST_MARGIN_MS - 50, 'answered before the server\'s deadline plus the margin: the drop could still land');
  });

  it('a collection call still goes through the collection table: the one door is unchanged', async () => {
    const { db, calls } = recordingDb();
    await wb.withinHousekeepingBound(async () => {
      observed(db).collection('sp_facts').find({}, {});
      await observed(db).collection('sp_facts').insertOne({}, {});
    });
    assert.equal(calls.find(c => c.name === 'sp_facts.find').args[1].timeoutMS, 7000, 'a read carries timeoutMS');
    assert.equal(calls.find(c => c.name === 'sp_facts.insertOne').args[1].maxTimeMS, 7000, 'a plain write carries maxTimeMS');
  });

  it('a Db method that is in neither table is returned as the driver\'s own', () => {
    const { db } = recordingDb();
    db.createCollection = () => 'plain';
    assert.equal(observed(db).createCollection, db.createCollection);
  });
});
