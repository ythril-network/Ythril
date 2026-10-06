/**
 * Boot initialises each space in its own step, says a failed one ONCE, and every space that is initialised — at boot, by a reload that
 * adds it, or by a reload that retries it — is handed to the index-readiness confirmation (bundle-53 G32, findings B and D of the
 * end-to-end verification).
 *
 * ## What was wrong
 *
 * `initAllSpaces` was a bare `for … await initSpace(id)`. One space whose init threw ended the loop, so every space AFTER it was never
 * initialised and never marked `building`; no readiness was confirmed for any; and the throw left `initAllSpaces` altogether, so the boot's
 * own next steps (the audit collection, the webhook indexes, the seq watermarks) did not run either. The line it left was the boot's catch-all,
 * `Instance DB initialisation failed (background services will still start)`, which names a driver error and not the space. The isolation gate
 * carried a row that said this MUST stop the boot; it did not: the server started and served.
 *
 * The reload's init (`initAddedSpaces`, G21) already isolates, reports and retries. But a space it initialised was never handed to the
 * confirmation, so a space added or retried by a reload had no `indexStatus` and no readiness line, while one initialised at boot or by
 * `createSpace` did.
 *
 * ## What this holds
 *
 * Three spaces in the config, the middle one's `facts` collection a VIEW (it refuses an index: a failure the store answers, not an outage):
 *
 *  1. `initAllSpaces` does not throw; the first and the third are initialised (collections AND indexes); the middle one is named ONCE in the
 *     shared reporter's words, `space init failed for space '<id>': … — retried next reload`; and it is left owed (`spacesOwedInit`);
 *  2. the first and the third are confirmed (`indexStatus` leaves `building` for a verdict) and the middle one is not, because nothing was
 *     handed over for it;
 *  3. a later reload, handed no added spaces, once the cause is gone: initialises the middle one, and ITS id reaches the confirmation (its
 *     `indexStatus` ends at a verdict) while nobody else is re-initialised;
 *  4. a space a reload ADDS gets the same: initialised, then confirmed.
 *
 * What is asserted is the identity of what was confirmed (the spaces whose status moved), never how many.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failing-space-does-not-stop-the-boot-init-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { withCollectionAsView } from './_write-faults.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const FIRST = 'bootfirst';
const MIDDLE = 'bootmid';
const LAST = 'bootlast';
const ADDED = 'bootadded';
const STEP = 'space init';
/** A verdict the confirmation writes: anything but the `building` the init marks and the `undefined` of a space nobody handed over. */
const SETTLED = ['ready', 'failed'];

describe('boot init isolates a failing space, and every initialised space is confirmed', { skip }, () => {
  let door, lifecycle, loader, db, unsubscribe;
  const lines = [];
  const statusOf = (id) => loader.getConfig().spaces.find(s => s.id === id)?.indexStatus;
  const settled = (id) => waitFor(() => SETTLED.includes(statusOf(id)), 30_000, 50, undefined, { what: `the index confirmation to reach a verdict for '${id}'` });
  const initWarnsFor = (id) => lines.filter(l => l.includes('WARN') && l.includes(`${STEP} failed for space '${id}'`));
  const indexCount = async (id) => (await db.collection(`${id}_facts`).indexes()).length;

  before(async () => {
    door = await openPushDoor({ suite: 'bootinit', spaces: [] });
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    loader = await import('../../server/dist/config/loader.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribe = subscribeLogLines(l => lines.push(l));
    db = door.mongo.getDb();
    // In this order, so the failing space sits BETWEEN the two that must be initialised.
    loader.mutateConfig(cfg => {
      for (const id of [FIRST, MIDDLE, LAST]) cfg.spaces.push({ id, label: id, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } });
    });
  });
  after(async () => { unsubscribe?.(); await door?.close(); });

  it('control: the entry points exist and nothing is owed yet', () => {
    assert.equal(typeof lifecycle.initAllSpaces, 'function');
    assert.equal(typeof lifecycle.initAddedSpaces, 'function');
    assert.deepEqual(lifecycle.spacesOwedInit(), []);
  });

  it('the middle space fails: boot initialises the first and the third, names the middle one once, and leaves it owed', async () => {
    lines.length = 0;
    await withCollectionAsView(db, `${MIDDLE}_facts`, 'bootmid_nothing', async () => {
      await assert.doesNotReject(lifecycle.initAllSpaces(),
        'initAllSpaces threw for one space: every space after it was left un-initialised and the rest of the boot\'s init was skipped');
    });

    for (const id of [FIRST, LAST]) {
      assert.ok((await indexCount(id)) > 1, `'${id}' was not initialised: its facts collection holds only ${await indexCount(id)} index(es)`);
    }
    const said = initWarnsFor(MIDDLE);
    assert.equal(said.length, 1, `${said.length} lines name the failed space, expected one:\n${lines.join('\n')}`);
    assert.match(said[0], new RegExp(`${STEP} failed for space '${MIDDLE}': .* — retried next reload$`), `not the shared reporter's words: ${said[0]}`);
    for (const id of [FIRST, LAST]) assert.equal(initWarnsFor(id).length, 0, `an initialised space was reported: ${initWarnsFor(id)[0]}`);
    assert.deepEqual(lifecycle.spacesOwedInit(), [MIDDLE], 'the failed space is not remembered as owed an init, or an initialised one is');
  });

  it('the spaces that were initialised are confirmed, and the failed one is not handed over', async () => {
    await settled(FIRST);
    await settled(LAST);
    assert.equal(statusOf(MIDDLE), undefined, `the failed space has an indexStatus (${statusOf(MIDDLE)}): it was handed to the confirmation without being initialised`);
  });

  it('a later reload, once the cause is gone, initialises the failed space, and ITS id reaches the confirmation', async () => {
    const audited = [];
    await lifecycle.initAddedSpaces({ added: [], audit: (spaceId, status) => { audited.push({ spaceId, status }); }, rearm: async () => {} });

    assert.deepEqual(audited, [{ spaceId: MIDDLE, status: 200 }], `the retry touched ${JSON.stringify(audited)}; only the failed space was owed`);
    assert.deepEqual(lifecycle.spacesOwedInit(), []);
    assert.ok((await indexCount(MIDDLE)) > 1, 'the retried space has no indexes');
    assert.notEqual(statusOf(MIDDLE), undefined, 'the retried space has no indexStatus: it was initialised and never handed to the confirmation');
    await settled(MIDDLE);
  });

  it('a space a reload ADDS is initialised and then confirmed', async () => {
    loader.mutateConfig(cfg => { cfg.spaces.push({ id: ADDED, label: ADDED, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } }); });
    assert.equal(statusOf(ADDED), undefined);
    await lifecycle.initAddedSpaces({ added: [ADDED], audit: () => {}, rearm: async () => {} });
    assert.ok((await indexCount(ADDED)) > 1, 'the added space was not initialised');
    assert.notEqual(statusOf(ADDED), undefined, 'the added space has no indexStatus: it was initialised and never handed to the confirmation');
    await settled(ADDED);
  });
});
