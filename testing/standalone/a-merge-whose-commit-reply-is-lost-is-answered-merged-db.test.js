/**
 * A merge whose commit LANDED but was reported as failed is answered as merged, and still runs everything that
 * follows a merge (bundle-30 plan §A4 and §B2: `inHeldTransaction` reads back inside the hold on a commit error).
 *
 * ## The defect
 *
 * `executeMerge` (`brain/merge.ts`) runs the relink in one transaction and, only after `withTransaction` returns,
 * queues the re-keyed edges for embedding and emits `entity.merged` / `entity.updated` / `entity.deleted`. A commit
 * that applies and is then reported as an error — `maxCommitTimeMS` firing after the commit applied, which the plan
 * adds as a bound, or a reply lost on the wire — throws out of `withTransaction` past all of that. The caller is
 * told the merge failed over a store in which it happened: the absorbed entity is gone, its edges moved, and
 *
 *  - the re-keyed edges are never queued, so they keep no vector and rank by nothing;
 *  - no webhook says the absorbed entity was deleted, so a subscriber mirroring the graph keeps it for ever;
 *  - and the operator, told "failed", retries a merge of an entity that no longer exists.
 *
 * ## The rule
 *
 * On a commit error the writer reads back what it wrote, inside the hold, before releasing it; **a merge that
 * landed is answered merged, and its post-commit effects run** — the embed jobs and the `entity.merged` event.
 *
 * ## The fault (`_write-faults.mjs loseNextCommitReply`)
 *
 * The next `commitTransaction` really commits; then the caller is handed the error a `MaxTimeMSExpired` commit
 * gives (`MongoServerError` 50, which `withTransaction` does not retry). The one built error in the fault module, and
 * why is written there: no store condition gives "committed, reported failed" on demand.
 *
 * Asked at `executeMerge`, which every merge door calls (REST, `POST /api/duplicates/:id/merge`, MCP `graph_merge`,
 * automerge). The survivor carries the record-tier suppression mark so the merge's inline survivor embed is skipped
 * (no model is loaded); the space is not suppressed, so the re-keyed edge's job is queued as it would be.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-merge-whose-commit-reply-is-lost-is-answered-merged-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { loseNextCommitReply } from './_write-faults.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-lost-commit-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const SPACE = 'general';
const SURVIVOR = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const ABSORBED = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000a3';
const EDGE = 'cccccccc-0000-4000-8000-0000000000c1';
const AUTHOR = { instanceId: 'merge-lost-commit-test', instanceLabel: 'test' };
const ACTOR = { tokenId: 'tok', tokenLabel: 'merge test' };

let mongo, merge, events, unsubscribe;
const seen = [];
const coll = (n) => mongo.col(`${SPACE}_${n}`);

describe('a merge whose commit reply is lost is answered merged', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('mergelostcommit');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'merge-lost-commit-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    merge = await import('../../server/dist/brain/merge.js');
    events = await import('../../server/dist/brain/brain-events.js');
    unsubscribe = events.subscribeBrainChanges(SPACE, ev => { seen.push(ev); });
  });
  after(async () => {
    unsubscribe?.();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'tombstones', 'embed_jobs', 'links', 'files']) await coll(c).deleteMany({});
    await coll('entities').insertMany([
      { _id: SURVIVOR, spaceId: SPACE, name: 'Ada', type: 'person', tags: [], properties: {}, author: AUTHOR, seq: 1, suppressEmbeddings: true },
      { _id: ABSORBED, spaceId: SPACE, name: 'Ada L.', type: 'person', tags: [], properties: {}, author: AUTHOR, seq: 2 },
      { _id: OTHER, spaceId: SPACE, name: 'Babbage', type: 'person', tags: [], properties: {}, author: AUTHOR, seq: 3 },
    ]);
    // The absorbed entity's edge is re-keyed onto the survivor: a post-commit embed job is owed for its new id.
    await coll('edges').insertOne({ _id: EDGE, spaceId: SPACE, from: ABSORBED, to: OTHER, fromKind: 'entity', toKind: 'entity',
      label: 'worked_with', tags: [], author: AUTHOR, seq: 4 });
    seen.length = 0;
  });

  it('control: a merge whose commit is answered queues the re-keyed edge and emits entity.merged', async () => {
    await merge.executeMerge(SPACE, await coll('entities').findOne({ _id: SURVIVOR }), await coll('entities').findOne({ _id: ABSORBED }), {}, ACTOR);
    const moved = await coll('edges').findOne({ from: SURVIVOR, label: 'worked_with' });
    assert.ok(moved, 'the edge was not relinked onto the survivor');
    assert.ok(await coll('embed_jobs').findOne({ _id: `edge:${moved._id}` }), 'the control queued no job for the re-keyed edge');
    assert.ok(seen.some(e => e.event === 'entity.merged'), 'the control emitted no entity.merged');
  });

  it('a commit that landed and was reported failed: answered merged, the edge queued, entity.merged emitted', async () => {
    const lost = await loseNextCommitReply(mongo);
    let outcome;
    try {
      outcome = await merge.executeMerge(SPACE, await coll('entities').findOne({ _id: SURVIVOR }),
        await coll('entities').findOne({ _id: ABSORBED }), {}, ACTOR).then(v => ({ value: v }), e => ({ error: e }));
    } finally {
      lost.restore();
    }
    assert.ok(lost.fired(), 'fixture: no commit was made, so no reply was lost');
    assert.equal(await coll('entities').findOne({ _id: ABSORBED }), null, 'fixture: the commit did not land — the absorbed entity is still here');
    const moved = await coll('edges').findOne({ from: SURVIVOR, label: 'worked_with' });
    assert.ok(moved, 'fixture: the commit did not land — the edge was not relinked');

    assert.equal(outcome.error, undefined,
      `a merge that LANDED was answered as failed (${outcome.error?.message}): the absorbed entity is gone and its edge moved, `
      + 'and the caller is told to retry a merge of an entity that no longer exists');
    assert.ok(await coll('embed_jobs').findOne({ _id: `edge:${moved._id}` }),
      'the re-keyed edge was never queued for embedding: the post-commit step did not run after a commit that landed');
    assert.ok(seen.some(e => e.event === 'entity.merged'),
      `no entity.merged was emitted for a merge that landed (events: ${JSON.stringify(seen.map(e => e.event))})`);
  });
});
