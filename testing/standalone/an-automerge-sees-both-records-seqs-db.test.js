/**
 * The duplicate scanner sees BOTH records of a pair at their real seq, whichever end seeded it (Q-361 item 15).
 *
 * ## The defect
 *
 * `findSimilar` hands the scanner the SEED record from a by-id read that projects no `seq`, so the seed's seq is
 * `undefined` and every consumer reads it as 0. Four consequences, one cause:
 *
 *  - **The survivor depends on which end was the seed.** `tryAutoMerge` decides which record is older by comparing seqs;
 *    with the seed always 0, the seed always counts as the older one. A merge started from the NEWER record (the
 *    insert-time rule, `dupeRulesOnInsert`, seeds from the record just written) keeps the newer record as the survivor
 *    under `dupeMergeSurvivor: 'older'` — the opposite of what 14-duplicates-and-webhooks.md says the setting does — and
 *    the older one under `'newer'`.
 *  - **A pair is stored with a seq of 0 for one end**, and the end that is 0 depends on the seed, so a scan from the
 *    other end reads the stored pair as CHANGED.
 *  - **A refused pair is re-merged on every scan**, once from each end: each is a whole rolled-back transaction and one
 *    warning, for a pair the space has said (a strict schema) it will not take.
 *  - **The manual merge door** picks the survivor from the stored seqs, and a stored 0 makes the older record whichever
 *    has the lower id.
 *
 * ## The rules
 *
 *  - the survivor is the configured one (`older` by default, `newer` when set), whichever end seeded the merge;
 *  - a pair is stored with both records' real seqs;
 *  - a refused pair is attempted ONCE per change — the second end of the same scan, and the next scan, skip it;
 *  - a stored seq that is absent or 0 (a row written by 5.6.3, or by anything before seqs) means UNKNOWN, not CHANGED:
 *    the pair is neither re-fired nor re-opened by it, and its seqs are stored now. A stored pair therefore converges as
 *    each is next scanned, with no burst on upgrade. The same for a dismissed pair's decision, which the contradiction
 *    scanner shares;
 *  - the manual merge door reads both records' CURRENT seqs when a stored one is unknown, and uses the stored ones when
 *    both are known;
 *  - the answer of `similar`, on either door, carries no `seq` on its source: the seq the scanner reads is internal, and
 *    the wire is unchanged (pins, green before the fix).
 *
 * Seen red on 6eb5a333 (5.6.3): the merge from the newer end keeps the newer record, a pair is stored with a 0, a refused
 * pair warns twice in ONE scan, and the manual door follows the ids.
 *
 * Needs a store with a vector index (the harness Mongo is Atlas Local). Run:
 *      node --test testing/standalone/an-automerge-sees-both-records-seqs-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, waitUntilServing } from './_vector-harness.mjs';
import { fakeResponse } from './_fake-response.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-automerge-seq-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

const INSTANCE = 'automerge-seq-receiver';
const AUTHOR = { instanceId: INSTANCE, instanceLabel: 'Receiver' };
const T0 = '2026-09-01T00:00:00.000Z';
const AUTOMERGE = [{ minScore: 0.5, action: 'automerge', types: ['entity'] }];

/** `dupeMergeSurvivor` unset (= older), 'newer', and a strict space whose schema refuses the merged survivor. */
const OLDER = 'amseq-older';
const NEWER = 'amseq-newer';
const STRICT = 'amseq-strict';
const ALL = [OLDER, NEWER, STRICT];

/** Two ids in a fixed lexical order, so the pair's a/b ends are known; seqs are assigned per case. */
const LOW = '00000000-0000-4000-8000-000000000001';
const HIGH = '00000000-0000-4000-8000-000000000002';

let mongo, scanSpace, findSimilar, evaluateRecordForDuplicates, decideDismissed, callTool, log, ADMIN;
const handlers = {};
let serial = 0;

const coll = (space, part) => mongo.col(`${space}_${part}`);
const entity = (space, _id, seq) => ({ _id, spaceId: space, name: `Entity ${_id.slice(-1)}`, type: 'thing', tags: [], properties: {},
  author: AUTHOR, createdAt: T0, updatedAt: T0, seq, embedding: unitAt(0, DIMS), embeddingModel: 'stub', matchedText: `entity ${_id.slice(-1)}` });

/** Seed two entities — `lowSeq` on the lower id, `highSeq` on the higher — and wait until the index serves both. */
async function seedPair(space, lowSeq, highSeq) {
  await coll(space, 'entities').insertMany([entity(space, LOW, lowSeq), entity(space, HIGH, highSeq)]);
  await waitUntilServing(mongo, `${space}_entities`, `${space}_entities_embedding`, { dims: DIMS, n: 2 });
}
const survivors = async (space) => (await coll(space, 'entities').find({}).toArray()).map(d => d._id);

/** The warnings logged while `fn` runs that name either end of the pair. */
async function warnings(fn) {
  const lines = [];
  const orig = log.warn;
  log.warn = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { log.warn = orig; }
  return lines.filter(l => l.includes(LOW) || l.includes(HIGH));
}
const refusals = (lines) => lines.filter(l => /Auto-merge REFUSED/.test(l));

const token = () => ({ id: `amseq-${++serial}`, name: 'amseq', rights: ADMIN });
const request = (extra) => ({ params: {}, query: {}, body: {}, headers: {}, ip: '127.0.0.1', authToken: token(), get: () => undefined, ...extra });

describe('the duplicate scanner sees both records of a pair at their real seq', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('amseq');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: INSTANCE, instanceLabel: 'Receiver', tokens: [], networks: [],
      dupeScanner: { types: ['entity'] },
      spaces: [
        { id: OLDER, label: 'Older', folders: [], completeLinkage: true, meta: {}, dupeRules: AUTOMERGE, dupeRulesOnInsert: true },
        { id: NEWER, label: 'Newer', folders: [], completeLinkage: true, meta: {}, dupeRules: AUTOMERGE, dupeRulesOnInsert: true, dupeMergeSurvivor: 'newer' },
        // An allowlist of entity types the seeded entities ('thing') are not in: the merged survivor breaks it.
        { id: STRICT, label: 'Strict', folders: [], completeLinkage: true, dupeRules: AUTOMERGE,
          meta: { validationMode: 'strict', typeSchemas: { entity: { person: {} } } } },
      ],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    await mongo.checkVectorSearchAvailability();
    const { initSpace } = await import('../../server/dist/spaces/lifecycle.js');
    for (const s of ALL) await initSpace(s, { waitForVectorReady: true });
    ({ scanSpace, evaluateRecordForDuplicates, decideDismissed } = await import('../../server/dist/brain/dupe-scanner.js'));
    ({ findSimilar } = await import('../../server/dist/brain/recall.js'));
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ log } = await import('../../server/dist/util/log.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const final = (router, method, p) => {
      const layer = router.stack.find(l => l.route?.path === p && l.route.methods?.[method]);
      assert.ok(layer, `${method.toUpperCase()} ${p} is gone or moved — re-anchor this test`);
      return layer.route.stack.at(-1).handle;
    };
    handlers.merge = final((await import('../../server/dist/api/duplicates.js')).duplicatesRouter, 'post', '/:id/merge');
    handlers.similar = final((await import('../../server/dist/api/brain/search.js')).searchRouter, 'post', '/similar');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const s of ALL) for (const part of ['entities', 'edges', 'links', 'tombstones', 'dupe_candidates', 'embed_jobs']) await coll(s, part).deleteMany({});
  });

  // The two seed orders: the merge starts from the NEWER record (what the insert-time rule does) or the OLDER one.
  // `lowIsOlder` says whether the lower id is the older record, so both a/b orderings of the pair are asked.
  for (const lowIsOlder of [true, false]) {
    const seqs = lowIsOlder ? [10, 20] : [20, 10];
    const olderId = lowIsOlder ? LOW : HIGH;
    const newerId = lowIsOlder ? HIGH : LOW;

    for (const [space, wanted] of [[OLDER, olderId], [NEWER, newerId]]) {
      const policy = space === OLDER ? 'older (the default)' : 'newer';
      it(`a merge started from the NEWER record keeps the ${policy} one (the ${lowIsOlder ? 'lower' : 'higher'} id is older)`, async () => {
        await seedPair(space, ...seqs);
        await evaluateRecordForDuplicates(space, 'entity', newerId);
        assert.deepEqual(await survivors(space), [wanted],
          `dupeMergeSurvivor '${space === OLDER ? 'older' : 'newer'}': the survivor is not the ${policy} record — the seed was counted as the older one`);
      });

      it(`PIN a merge started from the OLDER record keeps the ${policy} one too (the ${lowIsOlder ? 'lower' : 'higher'} id is older)`, async () => {
        await seedPair(space, ...seqs);
        await evaluateRecordForDuplicates(space, 'entity', olderId);
        assert.deepEqual(await survivors(space), [wanted]);
      });
    }
  }

  it('a pair is stored with both records\' real seqs, whichever end seeded it', async () => {
    await seedPair(STRICT, 10, 20);
    await scanSpace(STRICT, { reset: true });
    const rows = await coll(STRICT, 'dupe_candidates').find({}).toArray();
    assert.equal(rows.length, 1, `expected the one candidate for the pair, got ${JSON.stringify(rows)}`);
    assert.deepEqual([rows[0].aId, rows[0].bId, rows[0].aSeq, rows[0].bSeq], [LOW, HIGH, 10, 20],
      'the pair was stored with a 0 for the end that seeded it');
  });

  it('a refused pair is attempted once: one warning in the first scan (not one per end), none in the next', async () => {
    await seedPair(STRICT, 10, 20);
    const first = refusals(await warnings(() => scanSpace(STRICT, { reset: true })));
    const second = refusals(await warnings(() => scanSpace(STRICT, { reset: true })));
    assert.equal(first.length, 1, `the first scan refused the same pair ${first.length} time(s): once from each end? ${JSON.stringify(first)}`);
    assert.equal(second.length, 0, `the second scan re-merged a pair nothing had changed: ${JSON.stringify(second)}`);
    assert.equal((await survivors(STRICT)).length, 2, 'a refused merge removed a record');
  });

  describe('a stored seq that is 0 or absent is unknown, not changed', () => {
    const legacy = (seqs) => ({ _id: `entity:${LOW.length}:${LOW}:${HIGH}`, spaceId: STRICT, type: 'entity', aId: LOW, bId: HIGH,
      aSeq: seqs[0], bSeq: seqs[1], score: 1, status: 'open', detectedAt: T0, updatedAt: T0 });

    for (const stored of [[0, 20], [10, 0], [0, 0]]) {
      it(`an open pair stored as seqs ${JSON.stringify(stored)} (as 5.6.3 wrote it) is not re-attempted, and its seqs are stored now`, async () => {
        await seedPair(STRICT, 10, 20);
        await coll(STRICT, 'dupe_candidates').insertOne(legacy(stored));
        const lines = refusals(await warnings(() => scanSpace(STRICT, { reset: true })));
        assert.deepEqual(lines, [], 'a pair whose stored seq was merely unknown was treated as changed and merged again');
        const row = await coll(STRICT, 'dupe_candidates').findOne({});
        assert.deepEqual([row.aSeq, row.bSeq], [10, 20], 'the real seqs were not stored for the next comparison');
      });
    }

    it('a dismissed pair\'s decision does not reopen on an unknown stored seq (the contradiction scanner shares it)', () => {
      for (const stored of [{ aSeq: 0, bSeq: 20 }, { aSeq: 10, bSeq: 0 }, { aSeq: undefined, bSeq: 20 }]) {
        const decision = decideDismissed({ ...stored, dismissedContentHash: 'the-hash-it-was-dismissed-at' }, 10, 20, 'a-different-hash');
        assert.notEqual(decision, 'reopen', `${JSON.stringify(stored)}: an unknown stored seq reopened a dismissed pair`);
      }
    });

    it('PIN known seqs that differ still reopen a dismissed pair whose content changed', () => {
      assert.equal(decideDismissed({ aSeq: 5, bSeq: 20, dismissedContentHash: 'h0' }, 10, 20, 'h1'), 'reopen');
      assert.equal(decideDismissed({ aSeq: 10, bSeq: 20, dismissedContentHash: 'h0' }, 10, 20, 'h1'), 'keep');
    });
  });

  describe('the manual merge door', () => {
    /** A candidate row as stored, then POST /api/duplicates/:id/merge; answers the survivor it merged into. */
    async function mergeThrough(space, stored) {
      const _id = `entity:${LOW.length}:${LOW}:${HIGH}`;
      await coll(space, 'dupe_candidates').insertOne({ _id, spaceId: space, type: 'entity', aId: LOW, bId: HIGH,
        aSeq: stored[0], bSeq: stored[1], score: 1, status: 'open', detectedAt: T0, updatedAt: T0 });
      const res = fakeResponse();
      await handlers.merge(request({ params: { id: _id } }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      return res.body.survivorId;
    }

    // Both orientations (the lower id older, then newer) against every shape of unknown stored seq: a door that follows the
    // ids, or that reads a stored 0 as "older", is right in some cells and wrong in others — every cell is asked.
    for (const [lowSeq, highSeq] of [[20, 10], [10, 20]]) {
      const wanted = lowSeq < highSeq ? LOW : HIGH;
      for (const stored of [[0, 0], [0, 10], [20, 0], [0, 20], [10, 0]]) {
        it(`current seqs LOW ${lowSeq} / HIGH ${highSeq}, stored ${JSON.stringify(stored)} (unknown): the survivor is the record with the lower CURRENT seq`, async () => {
          await coll(OLDER, 'entities').insertMany([entity(OLDER, LOW, lowSeq), entity(OLDER, HIGH, highSeq)]);
          assert.equal(await mergeThrough(OLDER, stored), wanted, `the survivor is not the older record (seq ${Math.min(lowSeq, highSeq)})`);
        });
      }
    }

    it('PIN known stored seqs are used as stored', async () => {
      await coll(OLDER, 'entities').insertMany([entity(OLDER, LOW, 20), entity(OLDER, HIGH, 10)]);
      assert.equal(await mergeThrough(OLDER, [5, 9]), LOW, 'the stored seqs (LOW older) were overridden by the current ones');
    });
  });

  describe('the answer of similar carries no seq on its source (the seq the scanner reads is internal)', () => {
    it('REST: POST /api/brain/similar', async () => {
      await seedPair(OLDER, 10, 20);
      const res = fakeResponse();
      await handlers.similar(request({ resolvedSpaceId: OLDER, authorisedSpaces: [OLDER],
        body: { space: OLDER, entryId: LOW, entryType: 'entity', topK: 5, targetTypes: ['entity'] } }), res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      // What crosses the wire: a key whose value is undefined is not sent, so the answer is read as JSON.
      const wire = JSON.parse(JSON.stringify(res.body));
      assert.ok(wire.source?._id === LOW, `fixture check: the answer has no source (${JSON.stringify(wire)})`);
      assert.equal('seq' in wire.source, false, 'the source of a similar answer now carries seq');
      assert.deepEqual(wire.results.filter(r => 'seq' in r), [], 'a result carries seq without includeRecordMeta');
    });

    it('MCP: the similar tool', async () => {
      await seedPair(OLDER, 10, 20);
      const out = await callTool({
        name: 'similar', args: { space: OLDER, entryId: LOW, entryType: 'entity', topK: 5, targetTypes: ['entity'], traverse: 1 },
        caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 'amseq-mcp', tokenLabel: 'amseq' },
      });
      const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
      const body = JSON.parse(text);
      assert.ok(body.source?.id === LOW, `fixture check: the answer has no source (${text.slice(0, 300)})`);
      assert.doesNotMatch(text, /"seq"/, 'the answer of the similar tool now carries a seq');
    });
  });
});