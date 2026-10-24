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
 *  - resolving the same choice twice re-retired the loser, moving its `seq` and `updatedAt` for a write that changed nothing;
 *  - two resolves of the SAME choice at once: the slower one's close missed the claim the faster one had removed, and it was
 *    told `409 resolvedOtherwise` naming its own choice (pre-ship lens L2);
 *  - a claim nobody finished (a crash, a `503` never retried) pinned its choice for ever: every other choice was `409` and the
 *    card looked open. A claim is now on the wire, released by dismiss and reopen, and taken over once older than its bound —
 *    with the abandoned choice's edge and mark undone, so the pair still never holds two opposite judgements (L3).
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
import { failWrites, parkWrites } from './_write-faults.mjs';
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
  'same-race': {},
  'dismiss-releases': {},
  'reopen-releases': {},
  'stale-claim': {},
  'fresh-claim': {},
  'claim-on-wire': {},
  'stale-edited': {},
  'hand-set': {},
  'slow-original': {},
  'resolved-again': {},
  'dep-edge': {},
  'dep-pair': {},
  'dismiss-resolved': {},
  'late-landing': {},
  'reclaim-dismiss': {},
  'functional-wrote': { meta: STRICT({ functional: true }) },
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
    const { raiseVersionTo } = await import('../../server/dist/util/version-stamp.js');
    for (const name of Object.keys(SPACES)) await raiseVersionTo(space(name), 50);
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

  it('two resolves picking the SAME winner at once: both answer 200, and one edge (L2)', { timeout: 60_000 }, async () => {
    const { sp, coll, ids, candidateId } = await seedPair('same-race', 'fact');
    const answers = await Promise.all([resolve(candidateId, 'a'), resolve(candidateId, 'a')]);
    assert.deepEqual(answers.map(r => r.code), [200, 200], `two same-choice resolves were answered ${answers.map(r => r.code)}: ${JSON.stringify(answers.map(r => r.body))}`);
    assert.equal((await edgesBetween(sp, ids)).length, 1, 'two same-choice resolves left more than one edge');
    assert.equal((await record(sp, coll, ids.b))?.superseded, true, 'the loser is not marked');
    assert.equal((await candidate(sp, candidateId)).status, 'resolved');
  });

  describe('a claim nobody finishes does not pin the choice for ever (L3)', () => {
    /**
     * Put a claim for `winner` on the candidate, taken `ageMs` ago, as a resolve that stopped after the claim leaves it — with
     * `wrote`, what that resolve recorded it was about to write (an edge id, a marked record id).
     */
    const claim = (sp, candidateId, winner, ageMs, status = 'open', wrote) => door.coll(sp, 'contradiction_candidates').updateOne({ _id: candidateId },
      { $set: { status, resolving: { resolution: 'superseded', winner, at: new Date(Date.now() - ageMs).toISOString(), ...(wrote ? { wrote } : {}) } } });
    /** What the abandoned resolve keeping `a` wrote: its edge a -> b and its mark on b. Returns the claim's `wrote`. */
    const abandonedEffects = async ({ sp, coll, ids }, edgeId) => {
      await door.coll(sp, 'edges').insertOne(build.edge(sp, edgeId, 40, { from: ids.a, to: ids.b, label: LABEL }));
      await door.coll(sp, coll).updateOne({ _id: ids.b }, { $set: { superseded: true } });
      return { edgeId, markedId: ids.b };
    };
    const staleMs = async () => (await import('../../server/dist/api/contradictions.js')).RESOLVE_CLAIM_STALE_MS + 60_000;

    it('the claim is on the wire, so a reviewer can see the pair is being resolved', { timeout: 60_000 }, async () => {
      const { sp, candidateId } = await seedPair('claim-on-wire', 'fact');
      await claim(sp, candidateId, 'a', 0);
      const res = await callRouteAfterAuth(router, 'get', '/', { query: { space: sp, status: 'open' }, authToken: ADMIN_TOKEN });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      const row = res.body.contradictions.find(c => c.id === candidateId);
      assert.equal(row?.resolving?.resolution, 'superseded', `the open row does not carry its claim: ${JSON.stringify(row)}`);
      assert.equal(row.resolving.winner, 'a');
      assert.equal(typeof row.resolving.at, 'string', 'the claim does not say when it was taken');
    });

    it('a fresh claim of another choice is still refused 409', { timeout: 60_000 }, async () => {
      const { sp, candidateId } = await seedPair('fresh-claim', 'chrono');
      await claim(sp, candidateId, 'a', 0);
      const res = await resolve(candidateId, 'b');
      assert.equal(res.code, 409, `a fresh claim was taken over: ${res.code} ${JSON.stringify(res.body)}`);
    });

    it('a claim older than the bound is taken over by another choice, and the abandoned choice\'s edge and mark go with it', { timeout: 60_000 }, async () => {
      const { RESOLVE_CLAIM_STALE_MS } = await import('../../server/dist/api/contradictions.js');
      assert.equal(typeof RESOLVE_CLAIM_STALE_MS, 'number', 'the stale bound is not exported');
      const seeded = await seedPair('stale-claim', 'fact');
      const { sp, coll, ids, candidateId } = seeded;
      // What the abandoned resolve (keep a) had written before it stopped, and recorded on its claim: its edge and its mark.
      const wrote = await abandonedEffects(seeded, 'stale-claim-abandoned');
      await claim(sp, candidateId, 'a', RESOLVE_CLAIM_STALE_MS + 60_000, 'open', wrote);
      const res = await resolve(candidateId, 'b');
      assert.equal(res.code, 200, `a stale claim was not taken over: ${res.code} ${JSON.stringify(res.body)}`);
      assert.ok(codes(res.body).includes('oppositeChoiceUndone'), `the undo is not reported: ${JSON.stringify(res.body)}`);
      const edges = await edgesBetween(sp, ids);
      assert.deepEqual(edges.map(e => [e.from, e.to]), [[ids.b, ids.a]], 'the space does not hold exactly the standing choice\'s edge');
      const flags = await Promise.all([ids.a, ids.b].map(id => record(sp, coll, id).then(d => d?.superseded === true)));
      assert.deepEqual(flags, [true, false], 'the marks are not the standing choice\'s: the abandoned loser is still marked, or the new one is not');
      const cand = await candidate(sp, candidateId);
      assert.equal(cand.supersededId, ids.a);
      assert.equal(cand.resolving, undefined, 'the closed candidate still carries a claim');
    });

    it('dismissing releases a claim, and undoes what it recorded', { timeout: 60_000 }, async () => {
      const seeded = await seedPair('dismiss-releases', 'fact');
      const { sp, coll, ids, candidateId } = seeded;
      await claim(sp, candidateId, 'a', 0, 'open', await abandonedEffects(seeded, 'dismiss-releases-abandoned'));
      const res = await callRouteAfterAuth(router, 'post', '/:id/dismiss', { params: { id: candidateId }, authToken: ADMIN_TOKEN });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal((await candidate(sp, candidateId)).resolving, undefined, 'the dismissed candidate still carries the claim');
      assert.deepEqual(await edgesBetween(sp, ids), [], 'the released claim\'s edge is still stored');
      assert.notEqual((await record(sp, coll, ids.b))?.superseded, true, 'the released claim\'s mark is still on the record');
      assert.ok(codes(res.body).includes('oppositeChoiceUndone'), `the dismiss does not report the undo: ${JSON.stringify(res.body)}`);
    });

    it('a stale claim that recorded an edge and a mark, taken over by `edited`: both undone, and the answer says so', { timeout: 60_000 }, async () => {
      const seeded = await seedPair('stale-edited', 'fact');
      const { sp, coll, ids, candidateId } = seeded;
      await claim(sp, candidateId, 'a', await staleMs(), 'open', await abandonedEffects(seeded, 'stale-edited-abandoned'));
      const res = await callRouteAfterAuth(router, 'post', '/:id/resolve', { params: { id: candidateId }, body: { resolution: 'edited' }, authToken: ADMIN_TOKEN });
      assert.equal(res.code, 200, `the stale claim was not taken over by edited: ${res.code} ${JSON.stringify(res.body)}`);
      assert.deepEqual(await edgesBetween(sp, ids), [], 'the abandoned choice\'s edge survived the takeover');
      assert.notEqual((await record(sp, coll, ids.b))?.superseded, true, 'the abandoned choice\'s mark survived the takeover');
      assert.ok(codes(res.body).includes('oppositeChoiceUndone'), `the undo is not reported: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.written?.undone, `the undo is not counted in written: ${JSON.stringify(res.body)}`);
    });

    it('a first-time resolve leaves a hand-set mark on the record it keeps, and a hand-drawn opposite edge', { timeout: 60_000 }, async () => {
      const { sp, coll, ids, candidateId } = await seedPair('hand-set', 'fact');
      await door.coll(sp, coll).updateOne({ _id: ids.a }, { $set: { superseded: true } });
      await door.coll(sp, 'edges').insertOne(build.edge(sp, 'hand-set-drawn', 40, { from: ids.b, to: ids.a, label: LABEL }));
      const res = await resolve(candidateId, 'a');
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal((await record(sp, coll, ids.a))?.superseded, true, 'a first-time resolve lifted a mark it never wrote');
      assert.ok((await edgesBetween(sp, ids)).some(e => e._id === 'hand-set-drawn'), 'a first-time resolve deleted an edge it never drew');
      assert.ok(!codes(res.body).includes('oppositeChoiceUndone'), `nothing was undone, yet the answer says so: ${JSON.stringify(res.body)}`);
    });

    it('a slow resolver whose claim is taken over before its edge cannot land that edge', { timeout: 60_000 }, async () => {
      const { sp, coll, ids, candidateId } = await seedPair('slow-original', 'fact');
      const candColl = door.coll(sp, 'contradiction_candidates');
      const park = parkWrites(Object.getPrototypeOf(candColl));
      let slow;
      try {
        // Park the slow resolver's edge write: its claim is taken, its edge not yet stored.
        const parked = park.arm(door.coll(sp, 'edges').collectionName);
        slow = resolve(candidateId, 'a');
        await parked.reached;
        // Its claim goes stale and another choice takes it over and finishes.
        await candColl.updateOne({ _id: candidateId }, { $set: { 'resolving.at': new Date(Date.now() - await staleMs()).toISOString() } });
        const takeover = await resolve(candidateId, 'b');
        assert.equal(takeover.code, 200, `the takeover failed: ${takeover.code} ${JSON.stringify(takeover.body)}`);
        parked.release();
        await slow;
      } finally {
        park.restore();
      }
      const late = await slow;
      assert.equal(late.code, 409, `the slow resolver went on after its claim was taken over: ${late.code} ${JSON.stringify(late.body)}`);
      assert.deepEqual((await edgesBetween(sp, ids)).map(e => [e.from, e.to]), [[ids.b, ids.a]], 'the slow resolver landed its edge after the takeover');
      const flags = await Promise.all([ids.a, ids.b].map(id => record(sp, coll, id).then(d => d?.superseded === true)));
      assert.deepEqual(flags, [true, false], 'the slow resolver landed its mark after the takeover');
    });

    it('a same-choice resolve on a resolved candidate writes no claim', { timeout: 60_000 }, async () => {
      const { sp, candidateId } = await seedPair('resolved-again', 'fact');
      assert.equal((await resolve(candidateId, 'a')).code, 200);
      // Any write it attempted to the edges would fail; a resolve that writes nothing never meets it.
      const fired = failEveryWriteTo(`${sp}_edges`);
      let again;
      try { again = await resolve(candidateId, 'a'); } finally { faults.clear(); }
      assert.equal(again.code, 200, `a same-choice resolve on a resolved candidate was answered ${again.code}: ${JSON.stringify(again.body)}`);
      assert.equal(fired(), 0, 'the same-choice resolve on a resolved candidate wrote an edge');
      assert.equal((await candidate(sp, candidateId)).resolving, undefined, 'the resolved candidate was given a claim');
      assert.equal(again.body.markedRecord, true, JSON.stringify(again.body));
    });

    it('a resolved candidate cannot be dismissed: 409 alreadyResolved naming the resolution, and it stays resolved', { timeout: 60_000 }, async () => {
      const { sp, coll, ids, candidateId } = await seedPair('dismiss-resolved', 'fact');
      assert.equal((await resolve(candidateId, 'a')).code, 200);
      const res = await callRouteAfterAuth(router, 'post', '/:id/dismiss', { params: { id: candidateId }, authToken: ADMIN_TOKEN });
      assert.equal(res.code, 409, `a resolved candidate was dismissed: ${res.code} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, 'alreadyResolved', JSON.stringify(res.body));
      assert.match(res.body.error, /superseded/, `the refusal does not name the resolution: ${JSON.stringify(res.body)}`);
      const cand = await candidate(sp, candidateId);
      assert.equal(cand.status, 'resolved', 'the refused dismiss changed the candidate');
      assert.equal(cand.dismissedContentHash, undefined, 'the refused dismiss stamped a content hash');
      assert.equal((await record(sp, coll, ids.b))?.superseded, true, 'the refused dismiss lifted the mark');
    });

    it('reopening releases a claim, and the other choice can then be taken', { timeout: 60_000 }, async () => {
      const { sp, ids, candidateId } = await seedPair('reopen-releases', 'fact');
      await claim(sp, candidateId, 'a', 0, 'dismissed');
      const res = await callRouteAfterAuth(router, 'post', '/:id/reopen', { params: { id: candidateId }, authToken: ADMIN_TOKEN });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal((await candidate(sp, candidateId)).resolving, undefined, 'the reopened candidate still carries the claim');
      const other = await resolve(candidateId, 'b');
      assert.equal(other.code, 200, `the released candidate refused another choice: ${other.code} ${JSON.stringify(other.body)}`);
      assert.deepEqual((await edgesBetween(sp, ids)).map(e => [e.from, e.to]), [[ids.b, ids.a]]);
    });

    /** Park the next write to the space's candidates that `when` admits; returns the park and its gate. */
    const parkCandidateWrite = (sp, when) => {
      const candColl = door.coll(sp, 'contradiction_candidates');
      const park = parkWrites(Object.getPrototypeOf(candColl));
      return { park, parked: park.arm(candColl.collectionName, { when }) };
    };
    const isClose = (m, args) => m === 'updateOne' && JSON.stringify(args[1] ?? {}).includes('"status":"resolved"');

    /*
     * A recorded mark another pair has come to rely on, by ONE dependency each (round 6): either alone must keep the mark, so
     * each branch of the check in `undoClaim` is held by a case of its own — a case seeding both passed with either deleted.
     */
    const DEPENDENCIES = [
      {
        name: 'dep-edge', what: 'another record\'s supersedes edge points at it',
        seed: async ({ sp, ids }) => door.coll(sp, 'edges').insertOne(build.edge(sp, 'dep-edge-other', 40, { from: 'dep-edge-c', to: ids.b, label: LABEL })),
      },
      {
        name: 'dep-pair', what: 'another resolved finding names it as its loser',
        seed: async ({ sp, ids }) => door.coll(sp, 'contradiction_candidates').insertOne({
          _id: 'dep-pair-c:dep-pair-b', spaceId: sp, type: 'fact', aId: 'dep-pair-c', aSummary: 'C', aSeq: 30, bId: ids.b, bSummary: 'B', bSeq: 11,
          basis: 'nli', confidence: 0.9, status: 'resolved', resolution: 'superseded', supersededId: ids.b,
          detectedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
        }),
      },
    ];
    for (const dep of DEPENDENCIES) {
      it(`a recorded mark is kept when ${dep.what}, and a markKept note says so`, { timeout: 60_000 }, async () => {
        const seeded = await seedPair(dep.name, 'fact');
        const { sp, coll, ids, candidateId } = seeded;
        // C1 (keep a) marked b and was abandoned, having recorded the mark.
        await door.coll(sp, coll).updateOne({ _id: ids.b }, { $set: { superseded: true } });
        await claim(sp, candidateId, 'a', await staleMs(), 'open', { markedId: ids.b });
        await dep.seed(seeded);
        // C1 is taken over: b's mark is relied on elsewhere, and stays.
        const res = await callRouteAfterAuth(router, 'post', '/:id/resolve', { params: { id: candidateId }, body: { resolution: 'edited' }, authToken: ADMIN_TOKEN });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.equal((await record(sp, coll, ids.b))?.superseded, true, `the takeover lifted a mark relied on because ${dep.what}`);
        // A kept mark is its own note (round 5): `oppositeChoiceUndone` says something was taken back, and here nothing was.
        const note = (res.body.notes ?? []).find(n => n.code === 'markKept');
        assert.ok(note && /kept/.test(note.detail), `the answer does not carry a markKept note: ${JSON.stringify(res.body)}`);
        assert.ok(!codes(res.body).includes('oppositeChoiceUndone'), `nothing was undone, yet the answer says oppositeChoiceUndone: ${JSON.stringify(res.body)}`);
      });
    }

    it('a takeover clears an effect the overtaken request landed late, just before it closes', { timeout: 60_000 }, async () => {
      const seeded = await seedPair('late-landing', 'fact');
      const { sp, ids, candidateId } = seeded;
      // The abandoned claim (keep a) recorded its edge and had not yet drawn it.
      await claim(sp, candidateId, 'a', await staleMs(), 'open', { edgeId: 'late-landing-edge' });
      // The takeover's first write to the candidate after its claim: past its first undo, well before its close.
      const { park, parked } = parkCandidateWrite(sp, (m) => m === 'updateOne');
      let takeover;
      try {
        takeover = resolve(candidateId, 'b');
        await parked.reached;
        // The overtaken request's edge lands now, after the takeover's undo and before its close.
        await door.coll(sp, 'edges').insertOne(build.edge(sp, 'late-landing-edge', 41, { from: ids.a, to: ids.b, label: LABEL }));
        parked.release();
        takeover = await takeover;
      } finally {
        park.restore();
      }
      assert.equal(takeover.code, 200, JSON.stringify(takeover.body));
      assert.deepEqual((await edgesBetween(sp, ids)).map(e => [e.from, e.to]), [[ids.b, ids.a]], 'the late-landed edge of the overtaken claim survived the takeover');
    });

    it('a dismiss between a same-choice re-claim and its next write still undoes what the earlier claim recorded', { timeout: 60_000 }, async () => {
      const seeded = await seedPair('reclaim-dismiss', 'fact');
      const { sp, coll, ids, candidateId } = seeded;
      // A crashed resolve (keep a), fresh, recorded and wrote its edge and mark.
      await claim(sp, candidateId, 'a', 0, 'open', await abandonedEffects(seeded, 'reclaim-dismiss-edge'));
      const { park, parked } = parkCandidateWrite(sp, (m) => m === 'updateOne');
      let again;
      try {
        again = resolve(candidateId, 'a');
        await parked.reached;
        const dismissed = await callRouteAfterAuth(router, 'post', '/:id/dismiss', { params: { id: candidateId }, authToken: ADMIN_TOKEN });
        assert.equal(dismissed.code, 200, JSON.stringify(dismissed.body));
        parked.release();
        again = await again;
      } finally {
        park.restore();
      }
      assert.deepEqual(await edgesBetween(sp, ids), [], 'the earlier claim\'s edge was orphaned by the re-claim');
      assert.notEqual((await record(sp, coll, ids.b))?.superseded, true, 'the earlier claim\'s mark was orphaned by the re-claim');
    });

    it('a refused link leaves no edge id on the claim, so a later undo cannot delete an edge drawn by hand', { timeout: 60_000 }, async () => {
      const { sp, ids, candidateId } = await seedPair('functional-wrote', 'entity', { extra: [{ id: 'functional-wrote-c' }] });
      await door.coll(sp, 'edges').insertOne(build.edge(sp, 'functional-wrote-existing', 30, { from: ids.a, to: 'functional-wrote-c', label: LABEL }));
      const { park, parked } = parkCandidateWrite(sp, isClose);
      let res; let wrote;
      try {
        res = resolve(candidateId, 'a');
        await parked.reached;
        wrote = (await candidate(sp, candidateId))?.resolving?.wrote;
        parked.release();
        res = await res;
      } finally {
        park.restore();
      }
      assert.ok(codes(res.body).includes('linkRefused'), JSON.stringify(res.body));
      assert.equal(wrote?.edgeId, undefined, `the claim still records the refused edge: ${JSON.stringify(wrote)}`);
      assert.equal(wrote?.markedId, ids.b, `the claim does not record its mark: ${JSON.stringify(wrote)}`);
    });
  });
});
