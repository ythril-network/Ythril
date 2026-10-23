/**
 * A contradiction resolve keeps the reviewer's judgement when its link cannot be drawn, and converges on one answer — `Q-442`.
 *
 * ## The defect it prevents
 *
 * `POST /api/contradictions/:id/resolve` with `resolution: 'superseded'` retired the loser, then drew the `supersedes` edge, then
 * closed the candidate — with nothing between the steps. So:
 *
 *  - an edge the space's own rules refuse (a `functional` label that already has a target, an `endpoints` rule the pair does not
 *    meet) threw out of the route as a `500`: the loser marked, the candidate still open, and the reviewer told nothing happened.
 *    The owner's decision D-25 is that the judgement is KEPT: the loser marked, the item closed, and the answer says the link was
 *    refused (`linkRefused`);
 *  - a record of the pair that is gone reached the edge writer, which refuses a dangling end — the same `500`;
 *  - a store failure part-way left a half-done resolve with no word of what was written, and a retry — or a second reviewer —
 *    could pick the OTHER winner, and the space then held two `supersedes` edges pointing opposite ways;
 *  - resolving the same choice twice re-retired the loser, moving its `seq` and `updatedAt` for a write that changed nothing.
 *
 * ## What is held
 *
 * Every case drives the mounted route (`contradictionsRouter`) past authentication, over the pair kinds the scanner yields
 * (fact, entity, chrono — `DEFAULT_TYPES` in `contradiction-scanner.ts`), each case in a space of its own so a schema or a fault
 * in one cannot reach another.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-contradiction-resolve-keeps-the-judgement-and-converges-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, ADMIN_TOKEN, build } from './_push-door.mjs';
import { failWrites } from './_write-faults.mjs';
import { ASYNC_MUTATORS } from './_document-mutators.mjs';
import { callRouteAfterAuth } from './_route-after-auth.mjs';

const skip = await mongoSkipReason();

const LABEL = 'supersedes';
const STRICT = (edgeSchema) => ({ validationMode: 'strict', typeSchemas: { edge: { [LABEL]: edgeSchema } } });

/** One space per case: its meta, and the pair kind its candidate is about. */
const SPACES = {
  functional: { meta: STRICT({ functional: true }) },
  endpoints: { meta: STRICT({ endpoints: { from: ['person'], to: ['person'] } }) },
  'loser-gone': {},
  'winner-gone': {},
  'edge-fails': {},
  'mark-fails': {},
  'opposite-race': {},
  twice: {},
};
const space = (name) => `q442-${name}`;

/** The collection a record kind lives in, and its builder. */
const KIND = {
  fact: { coll: 'facts', make: build.fact },
  entity: { coll: 'entities', make: build.entity },
  chrono: { coll: 'chrono', make: build.chrono },
};

describe('a contradiction resolve keeps the judgement and converges', { skip }, () => {
  let door; let router; let faults; let StoreTimeout;

  before(async () => {
    door = await openPushDoor({
      suite: 'q442resolve',
      spaces: Object.entries(SPACES).map(([name, s]) => ({ id: space(name), label: name, folders: [], ...(s.meta ? { meta: s.meta } : {}) })),
    });
    router = (await import('../../server/dist/api/contradictions.js')).contradictionsRouter;
    ({ StoreTimeout } = await import('../../server/dist/db/write-timeout.js'));
    const { bumpSeq } = await import('../../server/dist/util/seq.js');
    for (const name of Object.keys(SPACES)) await bumpSeq(space(name), 50);
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')), [...ASYNC_MUTATORS]);
  });
  after(async () => {
    faults?.restore();
    await door?.close();
  });

  /**
   * Seed a pair of `kind` records (`present` says which of the two are stored) and an open candidate about them.
   * `extra` adds records of the same kind (an existing target, a third entity) and `types` sets the entity types.
   */
  async function seedPair(name, kind, { present = ['a', 'b'], types = {}, extra = [] } = {}) {
    const sp = space(name);
    const { coll, make } = KIND[kind];
    const ids = { a: `${name}-a`, b: `${name}-b` };
    const docs = present.map((side, i) => make(sp, ids[side], 10 + i, kind === 'entity' ? { type: types[side] ?? 'concept' } : {}));
    for (const d of [...docs, ...extra.map((e, i) => make(sp, e.id, 20 + i, e.extra ?? {}))]) {
      await door.coll(sp, coll).insertOne(d);
    }
    const candidateId = `${ids.a}:${ids.b}`;
    await door.coll(sp, 'contradiction_candidates').insertOne({
      _id: candidateId, spaceId: sp, type: kind, aId: ids.a, aSummary: 'A says 8080', aSeq: 10, bId: ids.b,
      bSummary: 'B says 9090', bSeq: 11, basis: 'nli', confidence: 0.9, status: 'open',
      detectedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    return { sp, coll, ids, candidateId };
  }

  const resolve = (candidateId, winner) => callRouteAfterAuth(router, 'post', '/:id/resolve',
    { params: { id: candidateId }, body: { resolution: 'superseded', winner }, authToken: ADMIN_TOKEN });

  /** The supersedes edges between the pair, either way round. */
  const edgesBetween = (sp, { a, b }) => door.coll(sp, 'edges')
    .find({ label: LABEL, $or: [{ from: a, to: b }, { from: b, to: a }] }).toArray();
  const candidate = (sp, id) => door.coll(sp, 'contradiction_candidates').findOne({ _id: id });
  const record = (sp, coll, id) => door.coll(sp, coll).findOne({ _id: id });
  const codes = (body) => (Array.isArray(body?.notes) ? body.notes.map(n => n?.code) : []);

  /** Arm every write method on one collection to fail with a store timeout; returns how many fired. */
  function failEveryWriteTo(collectionName) {
    for (const m of ASYNC_MUTATORS) faults.fail(m, collectionName, new StoreTimeout(`the write to ${collectionName}`), { times: 1 });
    return () => ASYNC_MUTATORS.reduce((n, m) => n + faults.fired(m, collectionName), 0);
  }

  describe('a refused supersedes link keeps the judgement (D-25)', () => {
    const REFUSALS = [
      {
        name: 'functional', why: 'the label is functional and the winner already supersedes another entity',
        seed: () => seedPair('functional', 'entity', { extra: [{ id: 'functional-c' }] }),
        before: async ({ sp, ids }) => door.coll(sp, 'edges').insertOne(build.edge(sp, 'functional-existing', 30, { from: ids.a, to: 'functional-c', label: LABEL })),
      },
      {
        name: 'endpoints', why: 'the label\'s endpoint rule allows persons and the pair are documents',
        seed: () => seedPair('endpoints', 'entity', { types: { a: 'document', b: 'document' } }),
        before: async () => {},
      },
    ];
    for (const r of REFUSALS) {
      it(`${r.name}: ${r.why} - the loser is marked, the candidate closed, no edge drawn, and the answer says linkRefused`, { timeout: 60_000 }, async () => {
        const seeded = await r.seed();
        await r.before(seeded);
        const { sp, coll, ids, candidateId } = seeded;
        const res = await resolve(candidateId, 'a');
        assert.equal(res.code, 200, `a refused link failed the whole resolve: ${res.code} ${JSON.stringify(res.body)}`);
        assert.ok(codes(res.body).includes('linkRefused'), `the answer does not say the link was refused: ${JSON.stringify(res.body)}`);
        const note = res.body.notes.find(n => n.code === 'linkRefused');
        assert.equal(typeof note.detail, 'string', `a note carries its detail: ${JSON.stringify(note)}`);
        assert.equal(typeof res.body.note, 'string', `\`note\` is still derived from the notes for an older client: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.markedRecord, true, `the loser was not reported marked: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.edge, undefined, `an edge is reported for a link that was refused: ${JSON.stringify(res.body)}`);
        assert.equal((await record(sp, coll, ids.b))?.superseded, true, 'the loser is not marked superseded');
        assert.notEqual((await record(sp, coll, ids.a))?.superseded, true, 'the winner was marked superseded');
        assert.deepEqual(await edgesBetween(sp, ids), [], 'a refused edge was stored');
        const cand = await candidate(sp, candidateId);
        assert.equal(cand.status, 'resolved', 'the candidate was left open');
        assert.ok(Array.isArray(cand.notes) && cand.notes.some(n => n.code === 'linkRefused'), `the note is not kept on the candidate: ${JSON.stringify(cand.notes)}`);
      });
    }
  });

  describe('a record of the pair that is gone skips the link and says which', () => {
    for (const gone of [{ side: 'b', winner: 'a', code: 'loserGone', name: 'loser-gone' }, { side: 'a', winner: 'a', code: 'winnerGone', name: 'winner-gone' }]) {
      it(`${gone.code}: the candidate is closed, no edge is drawn, and the answer carries ${gone.code}`, { timeout: 60_000 }, async () => {
        const { sp, ids, candidateId } = await seedPair(gone.name, 'fact', { present: ['a', 'b'].filter(s => s !== gone.side) });
        const res = await resolve(candidateId, gone.winner);
        assert.equal(res.code, 200, `a gone record failed the resolve: ${res.code} ${JSON.stringify(res.body)}`);
        assert.ok(codes(res.body).includes(gone.code), `the answer does not say ${gone.code}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.edge, undefined, `an edge is reported to a record that is gone: ${JSON.stringify(res.body)}`);
        assert.deepEqual(await edgesBetween(sp, ids), [], 'an edge to a record that is gone was stored');
        assert.equal((await candidate(sp, candidateId)).status, 'resolved', 'the candidate was left open');
      });
    }
  });

  it('a store failure while the edge is written is not taken for a refusal: 503, retryable, and what was written', { timeout: 60_000 }, async () => {
    const { sp, coll, ids, candidateId } = await seedPair('edge-fails', 'fact');
    const fired = failEveryWriteTo(`${sp}_edges`);
    let res;
    try {
      res = await resolve(candidateId, 'a');
      assert.ok(fired() > 0, 'the fault on the edges collection never fired: nothing was injected');
    } finally {
      faults.clear();
    }
    assert.equal(res.code, 503, `a store failure during the edge write was answered ${res.code}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.retryable, true, `the answer is not retryable: ${JSON.stringify(res.body)}`);
    assert.ok(!codes(res.body).includes('linkRefused'), `a store failure was reported as a refused link: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.written, { edge: false, markedRecord: false, closed: false },
      `the answer does not say what was written: ${JSON.stringify(res.body)}`);
    assert.notEqual((await record(sp, coll, ids.b))?.superseded, true, 'the loser was marked although the edge before it failed');
    assert.notEqual((await candidate(sp, candidateId)).status, 'resolved', 'the candidate was closed although the resolve failed');
  });

  it('a failure between the edge and the mark, then a retry with the OPPOSITE winner: 409, and one edge', { timeout: 60_000 }, async () => {
    const { sp, coll, ids, candidateId } = await seedPair('mark-fails', 'fact');
    const fired = failEveryWriteTo(`${sp}_${coll}`);
    let first;
    try {
      first = await resolve(candidateId, 'a');
      assert.ok(fired() > 0, 'the fault on the loser\'s collection never fired: nothing was injected');
    } finally {
      faults.clear();
    }
    const retry = await resolve(candidateId, 'b');
    assert.equal(retry.code, 409, `a retry that picked the other winner was answered ${retry.code}: ${JSON.stringify(retry.body)}`);
    assert.match(JSON.stringify(retry.body), /resolvedOtherwise/, `the refusal does not say resolvedOtherwise: ${JSON.stringify(retry.body)}`);
    const edges = await edgesBetween(sp, ids);
    assert.equal(edges.length, 1, `the space holds ${edges.length} supersedes edges between the pair: ${JSON.stringify(edges.map(e => `${e.from}->${e.to}`))}`);
    assert.deepEqual([edges[0].from, edges[0].to], [ids.a, ids.b], 'the edge is not the first choice\'s');
    assert.notEqual((await record(sp, coll, ids.a))?.superseded, true, 'the first choice\'s winner was marked by the refused retry');
    assert.equal(first.code, 503, `the failed mark was answered ${first.code}: ${JSON.stringify(first.body)}`);
    assert.deepEqual(first.body.written, { edge: true, markedRecord: false, closed: false },
      `the answer does not say the edge was written and the mark was not: ${JSON.stringify(first.body)}`);
  });

  it('two resolves picking opposite winners at once: exactly one is refused 409, and one edge', { timeout: 60_000 }, async () => {
    const { sp, coll, ids, candidateId } = await seedPair('opposite-race', 'entity');
    const answers = await Promise.all([resolve(candidateId, 'a'), resolve(candidateId, 'b')]);
    const statuses = answers.map(r => r.code).sort();
    assert.deepEqual(statuses, [200, 409], `two opposite resolves were answered ${statuses}: ${JSON.stringify(answers.map(r => r.body))}`);
    const won = answers.find(r => r.code === 200);
    const edges = await edgesBetween(sp, ids);
    assert.equal(edges.length, 1, `the space holds ${edges.length} supersedes edges between the pair: ${JSON.stringify(edges.map(e => `${e.from}->${e.to}`))}`);
    const flags = await Promise.all([ids.a, ids.b].map(id => record(sp, coll, id).then(d => d?.superseded === true)));
    assert.equal(flags.filter(Boolean).length, 1, `both records of the pair are marked superseded: ${flags}`);
    assert.equal((await candidate(sp, candidateId)).supersededId, won.body.supersededId, 'the candidate does not record the resolve that won');
  });

  it('resolving the same choice twice converges: the loser\'s seq and updatedAt do not move', { timeout: 60_000 }, async () => {
    const { sp, coll, ids, candidateId } = await seedPair('twice', 'chrono');
    const first = await resolve(candidateId, 'a');
    assert.equal(first.code, 200, JSON.stringify(first.body));
    const after1 = await record(sp, coll, ids.b);
    assert.equal(after1.superseded, true, 'the first resolve did not mark the loser');
    const second = await resolve(candidateId, 'a');
    assert.equal(second.code, 200, `the same choice again was answered ${second.code}: ${JSON.stringify(second.body)}`);
    assert.equal(second.body.markedRecord, true, `an already-marked loser is reported unmarked: ${JSON.stringify(second.body)}`);
    const after2 = await record(sp, coll, ids.b);
    assert.equal(after2.seq, after1.seq, `the second resolve re-retired the loser: seq ${after1.seq} -> ${after2.seq}`);
    assert.equal(after2.updatedAt, after1.updatedAt, 'the second resolve moved the loser\'s updatedAt');
    assert.equal((await edgesBetween(sp, ids)).length, 1, 'resolving twice left more than one edge');
  });
});
