/**
 * A space whose init failed is reported as NOT applied, and the next reload initialises it again (bundle-53 G21, Q-274).
 *
 * ## What was wrong
 *
 * `applyConfigFromDisk` initialised each space the reload added in a bare `for … await initSpace(id)`. Two defects shared
 * the loop:
 *
 *  - **The audit said "applied" before the init ran.** Every added space's `space.reload_added` entry was written with status
 *    200 BEFORE any init, so a space whose init then threw was in the audit log as added and fine.
 *  - **A failed init was never tried again.** The reload had already merged the added space into the config, so the next reload
 *    found it in the "before" list and did not call that loop for it. One space that could not be initialised stayed
 *    un-initialised until a restart, and the first space to throw also kept every space after it from being initialised.
 *
 * ## What this holds (`initAddedSpaces`, `spaces/lifecycle.ts`)
 *
 * With one of two added spaces failing for real (its `_facts` collection is a VIEW, which refuses an index):
 *
 *  1. the other space is initialised (its collections exist) — one space's failure does not stop the next;
 *  2. the failed one is audited with the status of its failure, never 200;
 *  3. `rearm` ran anyway (the schedulers must not be left on their old schedule by one bad space);
 *  4. then ONE `AggregateError` is thrown, naming the failed space and no other, holding the failure as a member and none of
 *     the driver's text in its message;
 *  5. the next reload — handed NO added spaces — initialises the failed one again and only that one (the good one is not
 *     audited a second time), and succeeds once the cause is gone;
 *  6. and a reload with nothing owed and nothing added does nothing and throws nothing.
 *
 * The failure is a real one, so no stub stands in for `initSpace`: a view cannot take `createIndex`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-space-whose-init-failed-is-retried-by-the-next-reload-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { withCollectionAsView } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const GOOD = 'initgood';
const BAD = 'initbad';
/** What the driver says about a view that refuses an index — none of it may reach a message. */
const DRIVER_TEXT = /Mongo\w*Error|view|CommandNotSupportedOnView|initbad_facts/i;

describe('a space whose init failed is retried by the next reload', { skip }, () => {
  let door, lifecycle, loader, db;
  /** What each call of `initAddedSpaces` was given to call back: the audit rows, in order, and how often `rearm` ran. */
  let audited, rearmed;
  const callbacks = () => ({
    audit: (spaceId, status) => { audited.push({ spaceId, status }); },
    rearm: async () => { rearmed++; },
  });

  before(async () => {
    door = await openPushDoor({ suite: 'initretry', spaces: [] });
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    loader = await import('../../server/dist/config/loader.js');
    db = door.mongo.getDb();
    // Both spaces are added to the config the way a reload leaves them: present, and not yet initialised.
    loader.mutateConfig(cfg => {
      for (const id of [GOOD, BAD]) cfg.spaces.push({ id, label: id, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } });
    });
  });
  after(async () => { await door?.close(); });

  const collectionNames = async (space) => (await db.listCollections({ name: new RegExp(`^${space}_`) }).toArray()).map(c => c.name);

  it('control: the entry point exists', () => {
    assert.equal(typeof lifecycle.initAddedSpaces, 'function', 'spaces/lifecycle.ts exports no initAddedSpaces');
    assert.equal(typeof lifecycle.spacesOwedInit, 'function', 'spaces/lifecycle.ts exports no spacesOwedInit');
  });

  it('one of two added spaces fails: the other is initialised, the failed one is not audited as applied, and ONE aggregate error names it', async () => {
    audited = []; rearmed = 0;
    let thrown;
    await withCollectionAsView(db, `${BAD}_facts`, 'initbad_nothing', async () => {
      try { await lifecycle.initAddedSpaces({ added: [GOOD, BAD], ...callbacks() }); } catch (err) { thrown = err; }
    });

    assert.ok(thrown, 'initAddedSpaces returned although one space could not be initialised');
    assert.ok(thrown instanceof AggregateError, `it threw ${thrown?.constructor?.name}, not one AggregateError over the failures`);
    assert.equal(thrown.errors.length, 1, `the aggregate holds ${thrown.errors.length} member(s); exactly the failed space's failure was expected`);
    assert.match(thrown.message, new RegExp(BAD), `the message does not name the failed space: ${thrown.message}`);
    assert.doesNotMatch(thrown.message, new RegExp(GOOD), `the message names a space that was initialised: ${thrown.message}`);
    assert.doesNotMatch(thrown.message, DRIVER_TEXT, `the message carries the driver's text: ${thrown.message}`);

    assert.ok((await collectionNames(GOOD)).length > 0, 'the space that did not fail was not initialised: its collections are missing');
    const good = audited.filter(a => a.spaceId === GOOD);
    assert.deepEqual(good.map(a => a.status), [200], `the initialised space is audited once, as applied: ${JSON.stringify(audited)}`);
    const bad = audited.filter(a => a.spaceId === BAD);
    assert.equal(bad.length, 1, `the failed space has ${bad.length} audit entries`);
    assert.notEqual(bad[0].status, 200, 'the space whose init failed was audited as applied (status 200)');
    assert.ok(bad[0].status >= 400, `the failed space's audit status ${bad[0].status} does not say it failed`);
    assert.equal(rearmed, 1, 'the schedulers were not re-armed after a space failed: one bad space leaves them on their old schedule');
    assert.deepEqual(lifecycle.spacesOwedInit(), [BAD], 'the failed space is not remembered as un-initialised');
  });

  it('the next reload, handed NO added spaces, initialises the failed one again and only that one', async () => {
    audited = []; rearmed = 0;
    // Still failing: the retry happens, fails again, and the space stays owed.
    let thrown;
    await withCollectionAsView(db, `${BAD}_facts`, 'initbad_nothing', async () => {
      try { await lifecycle.initAddedSpaces({ added: [], ...callbacks() }); } catch (err) { thrown = err; }
    });
    assert.ok(thrown instanceof AggregateError, 'a reload that added nothing did not retry the space that failed: it threw nothing');
    assert.match(thrown.message, new RegExp(BAD));
    assert.deepEqual(audited.map(a => a.spaceId), [BAD], `the retry touched ${JSON.stringify(audited)}; only the failed space was owed`);
    assert.deepEqual(lifecycle.spacesOwedInit(), [BAD]);

    // The cause is gone (the view is an ordinary collection again): the retry lands and the debt is cleared.
    audited = []; rearmed = 0;
    await lifecycle.initAddedSpaces({ added: [], ...callbacks() });
    assert.deepEqual(audited, [{ spaceId: BAD, status: 200 }], `the successful retry is audited once, as applied: ${JSON.stringify(audited)}`);
    assert.equal(rearmed, 1, 'a reload that succeeded did not re-arm the schedulers');
    assert.deepEqual(lifecycle.spacesOwedInit(), [], 'the space was initialised and is still remembered as un-initialised');
    const ix = await db.collection(`${BAD}_facts`).indexes();
    assert.ok(ix.length > 1, `the retried space has only ${ix.map(i => i.name)}: its indexes were not created`);
  });

  it('a reload with nothing owed and nothing added audits nothing and throws nothing, and still re-arms', async () => {
    audited = []; rearmed = 0;
    await lifecycle.initAddedSpaces({ added: [], ...callbacks() });
    assert.deepEqual(audited, []);
    assert.equal(rearmed, 1);
  });

  it('a space removed from the config before the retry is dropped from what is owed, not retried', async () => {
    audited = []; rearmed = 0;
    loader.mutateConfig(cfg => { cfg.spaces.push({ id: 'initgone', label: 'g', folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } }); });
    await withCollectionAsView(db, 'initgone_facts', 'initgone_nothing', async () => {
      await assert.rejects(lifecycle.initAddedSpaces({ added: ['initgone'], ...callbacks() }), AggregateError);
    });
    assert.deepEqual(lifecycle.spacesOwedInit(), ['initgone']);
    loader.mutateConfig(cfg => { cfg.spaces = cfg.spaces.filter(s => s.id !== 'initgone'); });
    audited = [];
    await lifecycle.initAddedSpaces({ added: [], ...callbacks() });
    assert.deepEqual(lifecycle.spacesOwedInit(), [], 'a space that is no longer configured is still owed an init');
    assert.deepEqual(audited, [], 'a removed space was audited as added');
  });
});
