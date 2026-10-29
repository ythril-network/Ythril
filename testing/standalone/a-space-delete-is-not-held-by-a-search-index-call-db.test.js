/**
 * A space delete is not held by a search-index call, and it drops every search index its collections carry (Q-176).
 *
 * ## What it prevents
 *
 * A delete of a space whose vector index had only just been created was reported to wait about four minutes. It was not
 * reproduced: a fresh space deletes in 120 to 420 ms here, whatever state its index is in. What the code showed is that the
 * delete's first step listed and dropped the `_embedding` index of each collection one after another through calls that no
 * bound ends (a search-index call waits on mongot, and `db/write-bound.ts` leaves them unbounded on purpose, for an index BUILD
 * that scales with the data), so whatever mongot was doing, the delete waited for it. And that step was a second, weaker copy
 * of `dropCollectionSearchIndexes`: it named one index per collection, so the face gallery and a swap stand-in were left to
 * the collection drop, and on atlas-local an index dropped only through its collection lingers for 3 to 30 s and is listed again
 * on a collection recreated under the same name.
 *
 * Now the step is `dropCollectionSearchIndexes` for every collection, in parallel, each bounded by
 * `SPACE_ACT_SEARCH_INDEX_MS` and non-fatal, inside `dropSpaceData` so the boot resume has the bound too.
 *
 * ## Cases
 *
 *  1. A real create, a first fact, the index listed, then the delete: under five seconds, and no search index with the space's
 *     prefix remains. Holds the done-when of the ticket: a fresh space is not slow to delete.
 *  2. The store holds a `dropSearchIndex` (a relay between the server and the test Mongo): the delete answers within the bound
 *     and not when the call is released, with its marker cleared and the space gone.
 *  3. A `files` collection carrying the face gallery's index: the delete drops it by an explicit command of its own.
 *     It also says, through the shared failure reporter (`space delete search-index drop`, counted), that the collection's drop did not
 *     finish (bundle-95 review, D4: a drop that answers false or is ended by the bound used to be silent at debug).
 *  4. The bound does not cancel the drop (bundle-95 review, D3): a create under the deleted id while the drop is still running is refused
 *     (`retry`, a retryable `503` on REST, code `space_still_being_removed`), and once it settles the new space's index is not dropped
 *     by what was left running. 5. The same for a rename INTO the id.
 *
 * ## Seen red
 *
 * At the base (a71370b0d): case 2 waits for the release (the delete does not answer in six seconds); case 3 sees no
 * `dropSearchIndex` for the gallery. Case 1 passes there and holds the guard.
 *
 * At 1add3cb2f (D3): 4 creates at once (no refusal) and 5 renames at once; the orphaned drop is free to remove the new index.
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 * Run: node --test testing/standalone/a-space-delete-is-not-held-by-a-search-index-call-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, openFixtureMongo, closeTestMongo, mongoSkipReason, TEST_MONGO_HOST, TEST_MONGO_PORT } from './_mongo-harness.mjs';
import { startDelayedWriteRelay } from './_delayed-write-relay.mjs';
import { waitUntilTrue } from './_vector-harness.mjs';
import { elapse } from '../_shared/sleep.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-delete-index-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const T = { timeout: 180_000 };
const SUITE = 'deleteindex';
const FAST_MS = 5_000;
const KNOB_MS = 1_000;
const ANSWER_MS = 6_000;

describe('a space delete and a search-index call', { skip }, () => {
  let relay, mongo, fixture, loader, lifecycle, runner;

  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'delete-index', instanceLabel: 'test', tokens: [], networks: [], spaces: [],
    }, null, 2), { mode: 0o600 });
    relay = await startDelayedWriteRelay({ host: TEST_MONGO_HOST, port: TEST_MONGO_PORT, deliverAfterClientCloses: true });
    mongo = await openTestMongo(SUITE, { port: relay.port });
    fixture = await openFixtureMongo(SUITE);
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => {
    runner?.setSpaceActKnobsForTest(null);
    relay?.releaseAll();
    await fixture?.close();
    await closeTestMongo();
    await relay?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const listed = async (coll) => {
    try { return (await fixture.col(coll).listSearchIndexes().toArray()).map(i => i.name).sort(); } catch { return []; }
  };
  /** A real create and a first record in `suffix`, then wait until that collection's search index is listed. */
  async function createWithIndex(id, suffix, doc) {
    await lifecycle.createSpace({ id, label: id }, { tokenId: null });
    await mongo.col(`${id}_${suffix}`).insertOne({ _id: `${id}-1`, spaceId: id, tags: [], seq: 1, ...doc });
    await waitUntilTrue(`${id}_${suffix}'s search index to be listed`, async () => {
      const names = await listed(`${id}_${suffix}`);
      return names.length > 0 ? true : names;
    }, 60_000, 100);
  }
  const prefixed = async (id) => {
    const out = [];
    for (const s of ['facts', 'entities', 'edges', 'chrono', 'files']) out.push(...(await listed(`${id}_${s}`)).filter(n => n.startsWith(`${id}_`)));
    return out;
  };

  it('1. a fresh space whose index has just been created deletes in seconds, with no index of its prefix left', T, async () => {
    const id = 'fresh-del';
    await createWithIndex(id, 'facts', { fact: 'hello' });
    const started = Date.now();
    const outcome = await lifecycle.removeSpace(id);
    const took = Date.now() - started;
    assert.equal(outcome, true, 'the delete did not complete');
    assert.ok(took < FAST_MS, `the delete took ${took} ms`);
    assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the delete left its marker behind');
    assert.deepEqual(await prefixed(id), [], 'a search index of the deleted space is still listed');
  });

  it('2. a search-index call the store holds does not hold the delete past its bound', T, async () => {
    const id = 'held-del';
    await createWithIndex(id, 'facts', { fact: 'hello' });
    runner.setSpaceActKnobsForTest({ SPACE_ACT_SEARCH_INDEX_MS: KNOB_MS });
    const held = relay.hold((c) => 'dropSearchIndex' in c);
    // D4: a collection whose drop the bound ended is said, through the shared reporter (counted, once per window), naming the space.
    const { onHousekeepingSignal } = await import('../../server/dist/util/housekeeping-signals.js');
    const said = [];
    const stopListening = onHousekeepingSignal(e => { if (e.type === 'space-failure' && /search-index drop/.test(e.step)) said.push(e); });
    let deleting;
    try {
      deleting = lifecycle.removeSpace(id).then(v => ({ v }), err => ({ err }));
      const outcome = await Promise.race([deleting, elapse(ANSWER_MS, 'race timeout: the delete must answer within its bound, not when the call is released').then(() => 'held')]);
      assert.equal(held.held.length >= 1, true, 'fixture: the delete never sent a dropSearchIndex for the relay to hold');
      assert.notEqual(outcome, 'held', `the delete was still waiting on the held search-index call after ${ANSWER_MS} ms (the bound is ${KNOB_MS} ms)`);
      assert.equal(outcome.v, true, `the delete did not complete: ${outcome.err?.message ?? outcome.v}`);
      assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the delete left its marker behind');
      assert.ok(!loader.getConfig().spaces.some(s => s.id === id), 'the space is still configured');
      assert.equal(said.length >= 1, true, 'the delete lost its search-index drop to the bound and said nothing through the failure reporter');
    } finally {
      stopListening();
      relay.releaseAll();
      runner.setSpaceActKnobsForTest(null);
      await deleting;
    }
  });

  it('3. the face gallery index of the files collection is dropped by the delete, by a command of its own', T, async () => {
    const id = 'face-del';
    await createWithIndex(id, 'files', { name: 'a.png', path: 'a.png' });
    const gallery = `${id}_files_faceEmbedding`;
    // The first record of `files` brings up both of its indexes (face recognition is on by default, `getFaceRecognitionConfig`).
    await waitUntilTrue(`${gallery} to be listed`, async () => {
      const names = await listed(`${id}_files`);
      return names.includes(gallery) ? true : names;
    }, 60_000, 100);
    const drops = relay.record((c) => 'dropSearchIndex' in c);
    try {
      assert.equal(await lifecycle.removeSpace(id), true, 'the delete did not complete');
    } finally {
      drops.stop();
    }
    const dropped = drops.commands.map(c => c['name']);
    assert.ok(dropped.includes(gallery), `the delete did not drop ${gallery} itself; it dropped: ${JSON.stringify(dropped)}`);
    assert.ok(dropped.includes(`${id}_files_embedding`), 'the delete did not drop the embedding index either');
  });

  /** Delete `id` while the store holds its search-index drop past the bound: the delete answers, the drop is still running. */
  async function deleteWithDropStillRunning(id) {
    await createWithIndex(id, 'facts', { fact: 'hello' });
    runner.setSpaceActKnobsForTest({ SPACE_ACT_SEARCH_INDEX_MS: KNOB_MS });
    const held = relay.hold((c) => 'dropSearchIndex' in c);
    assert.equal(await lifecycle.removeSpace(id), true, 'the delete did not complete');
    assert.equal(held.held.length >= 1, true, 'fixture: the delete never sent a dropSearchIndex for the relay to hold');
    return held;
  }

  it('4. a space created under the id of a delete whose index drop is still running is refused, and its index survives the drop', T, async () => {
    const id = 'recreated-del';
    await deleteWithDropStillRunning(id);
    let created;
    try {
      const { planSpaceCreate, applySpaceCreate } = await import('../../server/dist/spaces/space-create.js');
      const plan = planSpaceCreate({ id, label: id });
      assert.equal(plan.ok, true, 'fixture: the create body was refused');
      created = await applySpaceCreate(plan.plan, { tokenId: null });
      assert.equal(created.outcome, 'retry', `a create over a running drop answered ${JSON.stringify(created)}`);
      assert.equal(created.code, 'space_still_being_removed');
      assert.equal(created.retryAfterSeconds > 0, true, 'the answer carries no wait');
      assert.ok(!loader.getConfig().spaces.some(s => s.id === id), 'the refused create left a space behind');
    } finally {
      relay.releaseAll();
      runner.setSpaceActKnobsForTest(null);
    }
    // The drop settles; the id is then free, and the index of the space built on it is not dropped by what was left running.
    const settle = await import('../../server/dist/spaces/search-index-drops-in-flight.js');
    await settle.settleSearchIndexDropsOf(id);
    const second = await lifecycle.createSpace({ id, label: id }, { tokenId: null });
    assert.equal(second.id, id);
    await mongo.col(`${id}_facts`).insertOne({ _id: `${id}-2`, spaceId: id, tags: [], seq: 1, fact: 'again' });
    const index = `${id}_facts_embedding`;
    await waitUntilTrue(`${index} to be listed`, async () => ((await listed(`${id}_facts`)).includes(index) ? true : false), 60_000, 100);
    await elapse(2_000, 'absence window: a drop left running would remove the new index in this time');
    assert.ok((await listed(`${id}_facts`)).includes(index), 'the new space\'s search index was dropped by the old space\'s drop');
  });

  it('5. a rename into the id of a delete whose index drop is still running is refused, retryable, with the same code', T, async () => {
    const id = 'renamed-into-del';
    await lifecycle.createSpace({ id: 'rename-src', label: 'src' }, { tokenId: null });
    await deleteWithDropStillRunning(id);
    try {
      const { renameSpaceAct } = await import('../../server/dist/spaces/rename.js');
      const r = await renameSpaceAct('rename-src', { newId: id });
      assert.equal(r.status, 503, `a rename over a running drop answered ${JSON.stringify(r)}`);
      assert.equal(r.code, 'space_still_being_removed');
      assert.equal(r.retryAfterSeconds > 0, true, 'the answer carries no wait');
      assert.equal(loader.getConfig().pendingSpaceOp, undefined, 'the refused rename left a marker');
      assert.ok(loader.getConfig().spaces.some(s => s.id === 'rename-src') && !loader.getConfig().spaces.some(s => s.id === id), 'the refused rename changed the config');
    } finally {
      relay.releaseAll();
      runner.setSpaceActKnobsForTest(null);
    }
  });
});
