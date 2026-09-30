/**
 * Every write to a space's record collection reaches the search-index lifecycle, and no path can go around it (Q-165).
 *
 * ## The rule
 *
 * A collection's search indexes exist only while it holds a record: built on the first, dropped after the last
 * (`spaces/search-index-presence.ts`). That is only safe if the lifecycle hears about EVERY write — a first record
 * it never heard about lands in a collection with no index, and recall misses it once the fresh-write window
 * closes, with nothing reporting it. There are more than a dozen write paths (both doors, sync ingest, bulk,
 * import, the conversion pipeline, the embedders, merges, re-keys, the TTL sweep, the wipe), so the observation
 * is not placed at any of them: `getDb()` hands out a database whose record collections report their writes.
 *
 * ## What this gate holds, and each part is DERIVED
 *
 *  1. **Every method of the driver's `Collection` is classified** — read out of `Collection.prototype`, so a
 *     driver upgrade that adds a write method fails here on the day it lands instead of becoming an unwatched door.
 *  2. **Every write and delete method REPORTS, with the effect the table claims**, driven through the real wrapper
 *     for every entry of the table — not for the handful a hand-written case would name. Reads report nothing.
 *  3. **A write inside a transaction reports only when its session ends**, because a reader outside the
 *     transaction cannot see it before the commit.
 *  4. **There is one door onto the database.** Every `new MongoClient(` and every `.db(` in the server's tracked
 *     sources is either `getDb()` itself or an exemption with its reason — and the one exemption that WRITES
 *     (a backup restore) is held to reconciling every space after it.
 *  5. **Nothing writes through an aggregation stage**, which the wrapper classifies as a read.
 *  6. **Nothing else builds or drops a search index**: the lifecycle is the only caller of the per-collection
 *     builders, so no path can put an index on an empty collection or take one off a populated one.
 *
 * ## Seen red
 *
 * Each part was mutated by hand and seen failing, then restored by hand: `findOneAndUpdate` deleted from the
 * table (part 1); the wrapper made to skip reporting for `bulkWrite` (part 2); the session check removed (part 3);
 * a `client.db(` added to a scratch source under `server/src` (part 4).
 *
 * Run: node --test testing/standalone/a-record-write-reaches-the-index-presence-observer.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { between } from './_structural-window.mjs';

const require = createRequire(import.meta.url);
const { Collection } = require('mongodb');
const { COLLECTION_METHOD_EFFECT, observeRecordWrites } = await import('../../server/dist/db/record-write-observer.js');

/**
 * Uncommitted files too: a second door onto the database is worth refusing before it is pushed, and a
 * tracked-only listing cannot see one written in the same change.
 */
const SCAN = { specs: false, untracked: true };

/** The driver's own list of what a collection can do — never a list written here. */
const driverMethods = Object.getOwnPropertyNames(Collection.prototype)
  .filter(k => k !== 'constructor' && typeof Object.getOwnPropertyDescriptor(Collection.prototype, k).value === 'function');

describe('1. every driver Collection method is classified', () => {
  it('found the driver\'s methods (floor)', () => {
    assert.ok(driverMethods.length >= 30, `only ${driverMethods.length} methods read off Collection.prototype — the scan is broken`);
    assert.ok(driverMethods.includes('insertOne') && driverMethods.includes('deleteMany'), 'the scan did not see the write methods');
  });

  it('each one has an effect in COLLECTION_METHOD_EFFECT', () => {
    const unclassified = driverMethods.filter(m => !(m in COLLECTION_METHOD_EFFECT));
    assert.deepEqual(unclassified, [],
      `the driver's Collection has method(s) nobody classified: ${unclassified.join(', ')}. Decide whether each can add `
      + 'or remove a record and say so in db/record-write-observer.ts — an unclassified method is a door the search '
      + 'index lifecycle does not watch');
  });
});

/** A stand-in collection: every method resolves, so the wrapper's reporting can be observed method by method. */
function fakeDb() {
  const calls = [];
  const collection = (name) => {
    const c = {};
    for (const m of Object.keys(COLLECTION_METHOD_EFFECT)) {
      c[m] = (...args) => {
        calls.push({ name, m, args });
        if (m === 'initializeOrderedBulkOp' || m === 'initializeUnorderedBulkOp') return { execute: async () => ({ ok: 1 }) };
        return Promise.resolve({ ok: 1 });
      };
    }
    return c;
  };
  return { collection, calls };
}

function observed() {
  const reports = [];
  const db = observeRecordWrites(fakeDb(), name => name.endsWith('_facts'), (name, effect) => reports.push({ name, effect }));
  return { db, reports };
}

describe('2. every write and delete reports, with the effect the table claims', () => {
  const entries = Object.entries(COLLECTION_METHOD_EFFECT);
  const writers = entries.filter(([, e]) => e !== 'read');

  it('the table has writers and deleters to drive (floor)', () => {
    assert.ok(writers.filter(([, e]) => e.write).length >= 8, 'fewer write methods than insert/update/replace/bulk alone');
    assert.ok(writers.filter(([, e]) => e.delete).length >= 3, 'fewer delete methods than deleteOne/deleteMany/findOneAndDelete');
  });

  for (const [method, effect] of writers) {
    it(`${method} reports ${JSON.stringify(effect)} after it settles`, async () => {
      const { db, reports } = observed();
      const coll = db.collection('space_facts');
      const out = coll[method]({}, {});
      if (out && typeof out.execute === 'function') {
        assert.equal(reports.length, 0, 'a bulk builder writes at execute, so it must not report on creation');
        await out.execute();
      } else {
        await out;
      }
      assert.deepEqual(reports, [{ name: 'space_facts', effect }]);
    });
  }

  it('a write that THROWS still reports — an unordered insertMany that fails on one duplicate inserted the rest', async () => {
    const reports = [];
    const db = observeRecordWrites({ collection: () => ({ insertMany: () => Promise.reject(new Error('E11000')) }) },
      () => true, (name, effect) => reports.push(effect));
    await assert.rejects(db.collection('space_facts').insertMany([{}]));
    assert.deepEqual(reports, [{ write: true }]);
  });

  it('reads report nothing, and a collection the predicate does not name is not wrapped at all', async () => {
    const { db, reports } = observed();
    for (const [m] of entries.filter(([, e]) => e === 'read')) await db.collection('space_facts')[m]({}, {});
    await db.collection('space_tombstones').insertOne({});
    assert.deepEqual(reports, []);
  });
});

describe('3. a write inside a transaction reports when its session ends', () => {
  it('not before', async () => {
    const { db, reports } = observed();
    const session = Object.assign(new EventEmitter(), { inTransaction: () => true });
    await db.collection('space_facts').insertOne({}, { session });
    assert.equal(reports.length, 0, 'reported before the commit: a reader outside the transaction would read the collection empty and drop its index');
    session.emit('ended');
    assert.deepEqual(reports, [{ name: 'space_facts', effect: { write: true } }]);
  });

  it('a session that is not in a transaction reports at once', async () => {
    const { db, reports } = observed();
    const session = Object.assign(new EventEmitter(), { inTransaction: () => false });
    await db.collection('space_facts').deleteOne({}, { session });
    assert.equal(reports.length, 1);
  });
});

describe('4. there is one door onto the database', () => {
  const sources = readTrackedSources('server/src', SCAN).map(s => ({ ...s, code: blankComments(s.text) }));

  /**
   * The files allowed a door of their own, each with the reason it is not a write the lifecycle misses.
   * A reason is what a reviewer can disagree with; a bare path is not.
   */
  const OWN_DOOR = {
    'server/src/db/mongo.ts': 'IS the door: connectMongo builds the client and getDb wraps it.',
    'server/src/db/conn-test.ts': 'A connection test: it pings admin and writes nothing.',
    'server/src/db/dump.ts': 'A backup: it reads every collection and writes nothing.',
    'server/src/db/restore.ts': 'WRITES, and is the one door the lifecycle cannot see — held below to a forced reconcile of every space after it.',
    'server/src/ready.ts': 'A readiness probe: admin ping and listSearchIndexes, both reads.',
    'server/src/api/about.ts': 'serverInfo for the About page — a read of the admin database.',
  };

  const doors = sources.filter(s => /new\s+MongoClient\s*\(|\.db\s*\(/.test(s.code)).map(s => s.file);

  it('found the doors (floor)', () => {
    assert.ok(doors.includes('server/src/db/mongo.ts'), 'the scan did not find mongo.ts itself — it is broken');
  });

  it('every door is getDb or an exemption with its reason', () => {
    const unexplained = doors.filter(f => !(f in OWN_DOOR));
    assert.deepEqual(unexplained, [],
      `a second way onto the database: ${unexplained.join(', ')}. Writes through it would never reach the search `
      + 'index lifecycle, so a first record could land in a collection with no index. Use getDb()/col(), or add an '
      + 'exemption here that says why it cannot write a record');
  });

  it('no exemption is stale', () => {
    const stale = Object.keys(OWN_DOOR).filter(f => !doors.includes(f));
    assert.deepEqual(stale, [], `exemptions for files that no longer open a door: ${stale.join(', ')}`);
  });

  it('getDb wraps the database in the write observer', () => {
    const mongo = sources.find(s => s.file === 'server/src/db/mongo.ts').code;
    const body = between(mongo, 'export function getDb(', 'export function col<', 'getDb');
    assert.match(body, /observeRecordWrites\(\s*client\.db\(/, 'getDb no longer hands out the observed database');
  });

  it('the restore — the one door that writes — is followed by a forced reconcile of every space', () => {
    const data = sources.find(s => s.file === 'server/src/api/data.ts').code;
    // From the restore to the response that reports it: the rebuild has to happen before the operator is told.
    const afterRestore = between(data, 'await restoreDatabase(', 'res.json({ ok: true, vectorIndexes', 'the restore route');
    assert.match(afterRestore, /reconcileSpaceSearchIndexes\([^)]*force:\s*true/,
      'records restored through their own client would sit in collections with no search index');
  });
});

describe('5. nothing writes through an aggregation stage', () => {
  it('no $merge or $out stage in the server', () => {
    const hits = readTrackedSources('server/src', SCAN)
      .filter(s => /['"`]?\$(merge|out)['"`]?\s*:/.test(blankComments(s.text))).map(s => s.file);
    assert.deepEqual(hits, [], `an aggregation that writes another collection, which the observer counts as a read: ${hits.join(', ')}`);
  });
});

describe('6. only the lifecycle builds or drops a collection\'s search indexes', () => {
  const sources = readTrackedSources('server/src', SCAN).map(s => ({ ...s, code: blankComments(s.text) }));
  const BUILDERS = /\b(ensureCollectionSearchIndexes|dropCollectionSearchIndexes|ensureVectorSearchIndex)\s*\(/;
  const ALLOWED = new Set(['server/src/spaces/vector-index.ts', 'server/src/spaces/search-index-presence.ts']);

  it('no other module calls the per-collection builders', () => {
    const callers = sources.filter(s => BUILDERS.test(s.code)).map(s => s.file);
    assert.ok(callers.includes('server/src/spaces/search-index-presence.ts'), 'the lifecycle no longer calls the builders — the scan is broken');
    const outside = callers.filter(f => !ALLOWED.has(f));
    assert.deepEqual(outside, [],
      `${outside.join(', ')} builds or drops a search index directly — on an empty collection that is the cost this rule `
      + 'removes, and on a populated one a drop loses its search. Go through reconcileSpaceSearchIndexes');
  });

  it('the lifecycle subscribes to the observer, and initSpace arms it before it reconciles', () => {
    const presence = sources.find(s => s.file === 'server/src/spaces/search-index-presence.ts').code;
    assert.match(presence, /^onRecordCollectionWrite\(/m, 'the lifecycle no longer subscribes at module load');
    const life = sources.find(s => s.file === 'server/src/spaces/lifecycle.ts').code;
    const init = between(life, 'export async function initSpace(', 'export async function initAllSpaces(', 'initSpace');
    const arm = init.indexOf('armSearchIndexPresence()');
    const rec = init.indexOf('reconcileSpaceSearchIndexes(');
    assert.ok(arm > 0 && rec > arm, 'initSpace must arm the observer BEFORE it reads the collections, or a write between the read and the arming is lost');
  });
});
