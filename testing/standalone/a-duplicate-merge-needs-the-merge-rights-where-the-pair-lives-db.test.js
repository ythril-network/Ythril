/**
 * A duplicate merge happens only in a space where the token may merge: `dataQuality: write` AND `knowledge: write`
 * in the space the candidate pair lives in.
 *
 * ## The defect (`Q-304`)
 *
 * `POST /api/duplicates/:id/merge` resolved its candidate through `findCandidate`, whose loop ran at
 * `dataQuality: read`, and `denyReadOnly` in front of it asks only whether the token may write ANYWHERE. So a token
 * holding `dataQuality: read` in space S and write in any other space T listed S's candidates (GET, at read) and
 * merged one — deleting an entity in S, where it may only read. Its row says `write` (`auth/space-rights.ts`), and
 * its siblings dismiss and reopen narrow at `write`. The merge was the one loop that did not.
 *
 * And a merge DELETES a knowledge record. The other two doors that run the same merge — the REST entity merge and
 * MCP `graph_merge` — need `knowledge: write` in the space. This door never asked (decision endpoint, 0.88: it must).
 *
 * ## What is asserted, as a truth table over the space the pair lives in
 *
 * Each row runs the route's real middleware after authentication (`denyReadOnly`, then the handler) against a real
 * Mongo, with the token on the request. A refused merge answers 404 — the answer dismiss and reopen give for a
 * candidate outside the token's reach, so the refusal does not say the candidate exists — leaves BOTH entities in
 * place and the candidate open. The pin row, both rights held, merges, so "refused" cannot be "everything refused".
 *
 * Every refused row holds write in another space T (so `denyReadOnly` passes and only the per-space rule can refuse),
 * and the row that is short on knowledge holds `dataQuality: write` in S (so only the knowledge half can refuse).
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-duplicate-merge-needs-the-merge-rights-where-the-pair-lives-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-dupe-merge-rung-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;
// A merge embeds its survivor. Nothing here is about vectors, so the spaces suppress embedding (the merge honours it)
// and the model may not be fetched: without both, the first merge downloads a model into the temp data root.
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

/** S holds the pair; T is the other space a token may write in. */
const S = 'dqpairs';
const T = 'dqother';
const OLDER = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const NEWER = 'aaaaaaaa-0000-4000-8000-0000000000b2';
const CANDIDATE = `entity:${OLDER}:${NEWER}`;

let mongo, spaceCollection, SPACE_AREAS, stack;
/** The other two doors that act on a candidate by id: their layers, found by the same rule. */
const stacks = {};

const coll = (space, kind) => mongo.col(spaceCollection(space, kind));

/** Full rights, every area `none` unless named — the matrix shape `TokenRights` stores. */
function rights(perSpace) {
  const row = (named) => Object.fromEntries(SPACE_AREAS.map(a => [a, named[a] ?? 'none']));
  return {
    instanceAdmin: false, createSpaces: false, floor: null,
    perSpace: Object.fromEntries(Object.entries(perSpace).map(([space, named]) => [space, row(named)])),
  };
}

/**
 * POST /api/duplicates/:id/merge, through the route's own layers after authentication. `requireAuth` resolves a
 * bearer into `req.authToken` and the rate limiter counts; the token is put on the request directly instead, and
 * every other layer — `denyReadOnly` included — runs as it does in production.
 */
async function merge(id, tokenRights) { return act(stack, id, tokenRights); }
async function act(layers, id, tokenRights) {
  const res = {
    statusCode: 200, body: undefined, sent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.sent = true; return this; },
    setHeader() { return this; }, set() { return this; },
  };
  const req = {
    params: { id }, query: {}, body: {}, headers: {}, ip: '127.0.0.1',
    authToken: { id: 'tok-dupe-merge', name: 'dupe merge test', rights: tokenRights },
  };
  for (const layer of layers) {
    if (res.sent) break;
    let advanced = false;
    await layer.handle(req, res, () => { advanced = true; });
    if (!advanced && !res.sent) throw new Error(`the layer ${layer.name} neither answered nor called next()`);
  }
  return { status: res.statusCode, body: res.body };
}

describe('a duplicate merge needs the merge rights where the pair lives', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('dupemergerung');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'dupe-merge-rung-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [
        { id: S, label: 'Pairs', folders: [], meta: { suppressEmbeddings: true } },
        { id: T, label: 'Other', folders: [], meta: { suppressEmbeddings: true } },
      ],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ spaceCollection } = await import('../../server/dist/db/space-collection.js'));
    ({ SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js'));
    const { duplicatesRouter } = await import('../../server/dist/api/duplicates.js');
    const layer = duplicatesRouter.stack.find(l => l.route?.path === '/:id/merge' && l.route.methods?.post);
    assert.ok(layer, 'POST /api/duplicates/:id/merge is gone or moved — re-anchor this test');
    // Authentication and rate limiting are the two layers replaced by the token on the request; NAMED, so a guard
    // added to the chain later runs here rather than being skipped by position.
    stack = layer.route.stack.filter(l => !['requireAuth', 'globalRateLimit'].includes(l.name));
    assert.ok(stack.some(l => l.name === 'denyReadOnly'), 'the merge route no longer runs denyReadOnly — re-read this test');
    for (const door of ['dismiss', 'reopen']) {
      const l = duplicatesRouter.stack.find(x => x.route?.path === `/:id/${door}` && x.route.methods?.post);
      assert.ok(l, `POST /api/duplicates/:id/${door} is gone or moved — re-anchor this test`);
      stacks[door] = l.route.stack.filter(x => !['requireAuth', 'globalRateLimit'].includes(x.name));
    }
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [S, T]) {
      for (const kind of ['entities', 'edges', 'facts', 'chrono', 'files', 'links', 'tombstones', 'dupeCandidates']) {
        await coll(space, kind).deleteMany({});
      }
    }
    await coll(S, 'entities').insertMany([
      { _id: OLDER, spaceId: S, name: 'Acme Ltd', type: 'organisation', tags: [], properties: {}, seq: 1 },
      { _id: NEWER, spaceId: S, name: 'Acme Limited', type: 'organisation', tags: [], properties: {}, seq: 2 },
    ]);
    const now = new Date().toISOString();
    await coll(S, 'dupeCandidates').insertOne({
      _id: CANDIDATE, spaceId: S, type: 'entity',
      aId: OLDER, aSummary: 'Acme Ltd', aSeq: 1, bId: NEWER, bSummary: 'Acme Limited', bSeq: 2,
      score: 0.97, status: 'open', detectedAt: now, updatedAt: now,
    });
  });

  /** Both entities still stored and the candidate still open — what a refused merge must leave. */
  async function untouched() {
    const ids = (await coll(S, 'entities').find({}).project({ _id: 1 }).toArray()).map(d => d._id).sort();
    const cand = await coll(S, 'dupeCandidates').findOne({ _id: CANDIDATE });
    return { ids, status: cand?.status };
  }

  const REFUSED = [
    {
      label: "dataQuality 'read' in the pair's space, write in another",
      token: { [S]: { dataQuality: 'read', knowledge: 'write' }, [T]: { dataQuality: 'write', knowledge: 'write' } },
    },
    {
      label: "dataQuality 'write' but knowledge 'read' in the pair's space, write in another",
      token: { [S]: { dataQuality: 'write', knowledge: 'read' }, [T]: { dataQuality: 'write', knowledge: 'write' } },
    },
  ];

  for (const row of REFUSED) {
    it(`refuses as not found, and merges nothing: ${row.label}`, async () => {
      const out = await merge(CANDIDATE, rights(row.token));
      const after = await untouched();
      assert.deepEqual(
        { status: out.status, entities: after.ids, candidate: after.status },
        { status: 404, entities: [OLDER, NEWER], candidate: 'open' },
        `the merge of a pair in '${S}' ran for a token that may not merge there (${row.label}): `
        + `${JSON.stringify(out.body)}`,
      );
    });
  }

  it('PIN: merges when the token holds dataQuality and knowledge write in the pair\'s space', async () => {
    const out = await merge(CANDIDATE, rights({ [S]: { dataQuality: 'write', knowledge: 'write' } }));
    assert.equal(out.status, 200, `the merge was refused for a token that holds both rights: ${JSON.stringify(out.body)}`);
    assert.equal(out.body?.survivorId, OLDER, 'the survivor is the older record by default');
    const after = await untouched();
    assert.deepEqual(after.ids, [OLDER], 'the absorbed entity must be gone after a merge');
    assert.equal(after.status, 'resolved');
  });

  /*
   * The doors beside the merge, and the guard in front of all three. The merge's walk moves onto the shared `findWhereTokenMay`
   * with the rung named at the call, and dismiss/reopen move onto it with the rung they always walked at (write): neither
   * door's behaviour changes, and these hold that, so a rewrite of the lookup cannot swap a guard out unseen
   * (`pitfall-admin-guard-swap-drops-read-only`: `denyReadOnly` stays in front, and a read-only token is a case of its own).
   */
  it('PIN: a read-only token is refused by denyReadOnly, and the merge touches nothing', async () => {
    const readOnly = rights({ [S]: Object.fromEntries(SPACE_AREAS.map(a => [a, 'read'])), [T]: Object.fromEntries(SPACE_AREAS.map(a => [a, 'read'])) });
    const out = await merge(CANDIDATE, readOnly);
    assert.equal(out.status, 403, JSON.stringify(out.body));
    assert.deepEqual(await untouched(), { ids: [OLDER, NEWER], status: 'open' });
  });

  for (const door of ['dismiss', 'reopen']) {
    it(`PIN: ${door} refuses as not found a token holding dataQuality only at 'read' in the pair's space (write in another)`, async () => {
      if (door === 'reopen') await coll(S, 'dupeCandidates').updateOne({ _id: CANDIDATE }, { $set: { status: 'dismissed' } });
      const before = (await coll(S, 'dupeCandidates').findOne({ _id: CANDIDATE })).status;
      const out = await act(stacks[door], CANDIDATE, rights({ [S]: { dataQuality: 'read' }, [T]: { dataQuality: 'write' } }));
      assert.equal(out.status, 404, JSON.stringify(out.body));
      assert.equal((await coll(S, 'dupeCandidates').findOne({ _id: CANDIDATE })).status, before, 'the candidate changed');
    });
  }

  it("PIN: dismiss acts for a token holding dataQuality 'write' in the pair's space", async () => {
    const out = await act(stacks['dismiss'], CANDIDATE, rights({ [S]: { dataQuality: 'write' } }));
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal((await coll(S, 'dupeCandidates').findOne({ _id: CANDIDATE })).status, 'dismissed');
  });
});
