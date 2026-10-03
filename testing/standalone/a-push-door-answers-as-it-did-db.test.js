/**
 * What the sync push door answers today — a CHARACTERIZATION, green before the `Q-107` part 1 rewrite and
 * required to stay green after it.
 *
 * ## Why this file exists before the change
 *
 * The rewrite routes the four single push routes (`POST /api/sync/facts|entities|edges|chrono`) through the
 * same planner and writer as `batch-upsert`, as one-document pages. "Statuses mapped exactly as today" is the
 * promise, and a promise about today can only be checked against a record of today taken BEFORE the code that
 * produced it is gone. Every expectation here is a literal for that reason: derived from the planner, it
 * would compare the new code with itself.
 *
 * ## What it pins
 *
 * - **The single-route status table** — every status each route answers, the stored state behind it, the
 *   400s that survive (fork caps on `/facts`, an unknown chrono type, a malformed body, an implausible seq) and
 *   their error text, and `schemaViolations` only on the exits that KEPT something.
 * - **`P2`, the in-page outcomes of `batch-upsert`** — what sequential processing answers when one page carries
 *   the same id more than once. The counters count ITEMS as processed in order (entity 5 then 6 is `upserted:
 *   2`), and the write is the final winner. `[9, 3]` is the fixture that matters: `[3, 9]` passes even if two
 *   ops are sent for one id, because the last op wins in an unordered bulk write whatever its seq (probe `P1b`).
 *
 * On 5.6.x (ported by `Q-218`) it was run on the unchanged 5.6.1 code first and is green there, which is the proof
 * that it records what 5.6.1 answers. One case is added for the patch: `C8`, a legacy read-spill file record pushed
 * in a batch is `skipped`, as 5.6.0 promised (main counts it `derived`).
 *
 * What it deliberately does NOT pin: the counter, embed jobs and fork seqs — those are what the rewrite changes,
 * and they are held by the red-first files beside this one (`a-push-*-db.test.js`).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-push-door-answers-as-it-did-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'pushpin';
/** A space with a schema, so `schemaViolations` has something to report. */
const SCHEMAED = 'pushpin-schema';
const META = {
  typeSchemas: {
    fact: { note: { propertySchemas: { source: { type: 'string', required: true } } } },
    entity: { person: { propertySchemas: { age: { type: 'number', required: true } } } },
  },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORK_CAP = (id) => `Fork depth limit (10) exceeded for _id '${id}'`;

let door;
const stored = (space, part, _id) => door.coll(space, part).findOne({ _id });

describe('the push door answers as it did (characterization, green before Q-107 part 1)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushpin', spaces: [
      { id: S, label: 'Pins', folders: [], meta: {} },
      { id: SCHEMAED, label: 'Pins with schema', folders: [], meta: META },
    ] });
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); await door.wipe(SCHEMAED); });

  const single = (route, body, space = S) => door.push(route, body, { spaceId: space });

  describe('POST /facts', () => {
    it('a new id is inserted, stored at the sender\'s seq', async () => {
      const r = await single('/facts', build.fact(S, 'f-new', 5));
      assert.deepEqual([r.code, r.body], [200, { status: 'inserted' }]);
      assert.equal((await stored(S, 'facts', 'f-new')).seq, 5);
    });

    it('a higher seq updates; a lower seq and an equal seq with equal text are skipped', async () => {
      await single('/facts', build.fact(S, 'f', 5, { fact: 'v5' }));
      assert.deepEqual((await single('/facts', build.fact(S, 'f', 6, { fact: 'v6' }))).body, { status: 'updated' });
      assert.deepEqual((await single('/facts', build.fact(S, 'f', 4, { fact: 'v4' }))).body, { status: 'skipped' });
      assert.deepEqual((await single('/facts', build.fact(S, 'f', 6, { fact: 'v6' }))).body, { status: 'skipped' });
      const doc = await stored(S, 'facts', 'f');
      assert.deepEqual([doc.seq, doc.fact], [6, 'v6']);
    });

    it('an equal seq with divergent text forks: a new id, forkOf the original, the original untouched', async () => {
      await single('/facts', build.fact(S, 'f', 5, { fact: 'mine' }));
      const r = await single('/facts', build.fact(S, 'f', 5, { fact: 'theirs' }));
      assert.equal(r.code, 200);
      assert.equal(r.body.status, 'forked');
      assert.match(r.body.forkId, UUID);
      assert.deepEqual(Object.keys(r.body).sort(), ['forkId', 'status']);
      const fork = await stored(S, 'facts', r.body.forkId);
      assert.deepEqual([fork.forkOf, fork.fact], ['f', 'theirs']);
      assert.equal((await stored(S, 'facts', 'f')).fact, 'mine');
    });

    it('a tombstone at or above the incoming seq answers tombstoned and stores nothing', async () => {
      await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'f', 'fact', 7));
      for (const seq of [7, 6]) {
        const r = await single('/facts', build.fact(S, 'f', seq));
        assert.deepEqual([r.code, r.body], [200, { status: 'tombstoned' }]);
      }
      assert.equal(await stored(S, 'facts', 'f'), null);
    });

    it('a tombstone below the incoming seq is superseded: the record is inserted and the tombstone removed', async () => {
      await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'f', 'fact', 3));
      assert.deepEqual((await single('/facts', build.fact(S, 'f', 4))).body, { status: 'inserted' });
      assert.equal(await door.coll(S, 'tombstones').countDocuments({ _id: 'f' }), 0);
    });

    it('a fork whose chain is already 10 deep answers 400 with the cap text', async () => {
      // f -> a1 -> ... -> a10: f is 10 forks below its root.
      const chain = Array.from({ length: 10 }, (_, i) => `a${i + 1}`);
      await door.coll(S, 'facts').insertMany([
        build.fact(S, 'f', 5, { fact: 'mine', forkOf: chain[0] }),
        ...chain.map((id, i) => build.fact(S, id, 1, chain[i + 1] ? { forkOf: chain[i + 1] } : {})),
      ]);
      const r = await single('/facts', build.fact(S, 'f', 5, { fact: 'theirs' }));
      assert.deepEqual([r.code, r.body], [400, { error: FORK_CAP('f') }]);
    });

    it('a fork whose parent already has 10 forks answers 400 with the same text', async () => {
      await door.coll(S, 'facts').insertMany([
        build.fact(S, 'f', 5, { fact: 'mine' }),
        ...Array.from({ length: 10 }, (_, i) => build.fact(S, `sib-${i}`, 20 + i, { forkOf: 'f' })),
      ]);
      const r = await single('/facts', build.fact(S, 'f', 5, { fact: 'theirs' }));
      assert.deepEqual([r.code, r.body], [400, { error: FORK_CAP('f') }]);
    });

    it('a malformed body and an implausible seq are refused with their own text', async () => {
      const bad = build.fact(S, 'f', 5); delete bad.fact;
      const malformed = await single('/facts', bad);
      assert.deepEqual([malformed.code, malformed.body], [400, { error: 'Invalid fact document' }]);
      const { MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js');
      const seq = MAX_INGEST_SEQ + 1;
      const r = await single('/facts', build.fact(S, 'f', seq));
      assert.deepEqual([r.code, r.body], [400, { error: `seq ${seq} is too close to the protocol ceiling and was refused` }]);
      assert.equal(await stored(S, 'facts', 'f'), null);
    });

    it('schemaViolations ride on the exits that kept something, and on no other', async () => {
      const inserted = await single('/facts', build.fact(SCHEMAED, 'f', 5, { type: 'note' }), SCHEMAED);
      assert.equal(inserted.body.status, 'inserted');
      assert.ok(Array.isArray(inserted.body.schemaViolations) && inserted.body.schemaViolations.length === 1,
        JSON.stringify(inserted.body));
      const skipped = await single('/facts', build.fact(SCHEMAED, 'f', 4, { type: 'note' }), SCHEMAED);
      assert.deepEqual(skipped.body, { status: 'skipped' });
    });
  });

  describe('POST /entities', () => {
    it('new, newer and older all answer ok; the newer replaces, the older does not', async () => {
      assert.deepEqual((await single('/entities', build.entity(S, 'e', 5, { name: 'v5' }))).body, { status: 'ok' });
      assert.deepEqual((await single('/entities', build.entity(S, 'e', 7, { name: 'v7' }))).body, { status: 'ok' });
      assert.deepEqual((await single('/entities', build.entity(S, 'e', 6, { name: 'v6' }))).body, { status: 'ok' });
      const doc = await stored(S, 'entities', 'e');
      assert.deepEqual([doc.seq, doc.name], [7, 'v7']);
    });

    it('a tombstone at or above answers tombstoned; a malformed body is a 400', async () => {
      await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'e', 'entity', 9));
      assert.deepEqual((await single('/entities', build.entity(S, 'e', 9))).body, { status: 'tombstoned' });
      assert.equal(await stored(S, 'entities', 'e'), null);
      const bad = build.entity(S, 'e2', 1); delete bad.name;
      const r = await single('/entities', bad);
      assert.deepEqual([r.code, r.body], [400, { error: 'Invalid entity document' }]);
    });

    it('schemaViolations ride on the ok it kept', async () => {
      const r = await single('/entities', build.entity(SCHEMAED, 'e', 5, { type: 'person' }), SCHEMAED);
      assert.equal(r.body.status, 'ok');
      assert.equal(r.body.schemaViolations?.length, 1, JSON.stringify(r.body));
    });
  });

  describe('POST /edges', () => {
    it('new and newer answer ok; an older is ok and not applied', async () => {
      assert.deepEqual((await single('/edges', build.edge(S, 'g', 5))).body, { status: 'ok' });
      assert.deepEqual((await single('/edges', build.edge(S, 'g', 7, { weight: 7 }))).body, { status: 'ok' });
      assert.deepEqual((await single('/edges', build.edge(S, 'g', 6, { weight: 6 }))).body, { status: 'ok' });
      assert.deepEqual([(await stored(S, 'edges', 'g')).seq, (await stored(S, 'edges', 'g')).weight], [7, 7]);
    });

    it('a different id on an existing triplet answers duplicate and keeps the local copy', async () => {
      await single('/edges', build.edge(S, 'g1', 5, { from: 'A', to: 'B', label: 'knows' }));
      const r = await single('/edges', build.edge(S, 'g2', 6, { from: 'A', to: 'B', label: 'knows' }));
      assert.deepEqual([r.code, r.body], [200, { status: 'duplicate' }]);
      assert.equal(await stored(S, 'edges', 'g2'), null);
      assert.ok(await stored(S, 'edges', 'g1'));
    });

    it('a tombstone at or above answers tombstoned', async () => {
      await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'g', 'edge', 5));
      assert.deepEqual((await single('/edges', build.edge(S, 'g', 4))).body, { status: 'tombstoned' });
    });
  });

  describe('POST /chrono', () => {
    it('new answers ok; older is ok and not applied; a tombstone at or above answers tombstoned', async () => {
      assert.deepEqual((await single('/chrono', build.chrono(S, 'c', 5, { title: 'v5' }))).body, { status: 'ok' });
      assert.deepEqual((await single('/chrono', build.chrono(S, 'c', 4, { title: 'v4' }))).body, { status: 'ok' });
      assert.equal((await stored(S, 'chrono', 'c')).title, 'v5');
      await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'c2', 'chrono', 5));
      assert.deepEqual((await single('/chrono', build.chrono(S, 'c2', 5))).body, { status: 'tombstoned' });
    });

    it('a type outside the vocabulary is a 400 naming the vocabulary', async () => {
      const r = await single('/chrono', build.chrono(S, 'c', 5, { type: 'not-a-chrono-type' }));
      assert.equal(r.code, 400);
      assert.match(r.body.error, /^`type` must be one of: .*\bevent\b/);
      assert.equal(await stored(S, 'chrono', 'c'), null);
    });
  });

  describe('POST /tombstones', () => {
    it('answers applied with the count it admitted and refused with the rest; an unknown type is a 400', async () => {
      // Bundle-46 (plan row 8): `refused` is additive, and a malformed element is refused on its own rather than
      // refusing the page. An element of a type this receiver does not know (a newer peer's) still answers 400.
      const ok = await door.push('/tombstones', { tombstones: [build.tombstone(S, 'x', 'fact', 3)] }, { spaceId: S });
      assert.deepEqual([ok.code, ok.body], [200, { applied: 1, refused: 0 }]);
      const bad = await door.push('/tombstones', { tombstones: [{ _id: 'y' }] }, { spaceId: S });
      assert.deepEqual([bad.code, bad.body], [200, { applied: 0, refused: 1 }]);
      const newer = await door.push('/tombstones', { tombstones: [build.tombstone(S, 'z', 'a-newer-type', 4)] }, { spaceId: S });
      assert.deepEqual([newer.code, newer.body], [400, { error: 'Invalid tombstone format' }]);
    });
  });

  describe('P2: batch-upsert in-page outcomes, as sequential processing counts them', () => {
    const batch = (body) => door.push('/batch-upsert', body, { spaceId: S });
    const zeroFacts = { inserted: 0, updated: 0, forked: 0, skipped: 0, forkDepthRefused: 0, tombstoned: 0, schemaViolations: 0, rejected: 0 };
    const zeroEnt = { upserted: 0, skipped: 0, tombstoned: 0, schemaViolations: 0, rejected: 0 };
    const zeroEdge = { ...zeroEnt, duplicateTriplets: 0 };

    it('the response carries all six families with their counters', async () => {
      const r = await batch({});
      assert.deepEqual(r.body, {
        status: 'ok', facts: zeroFacts, entities: zeroEnt, edges: zeroEdge,
        chrono: { ...zeroEnt, unknownType: 0 }, links: { upserted: 0, skipped: 0, tombstoned: 0, rejected: 0 },
        filemeta: { upserted: 0, skipped: 0, rejected: 0 },
      });
    });

    it('facts [9, 3] for one id: inserted 1, skipped 1, stored at 9', async () => {
      const r = await batch({ facts: [build.fact(S, 'f', 9, { fact: 'nine' }), build.fact(S, 'f', 3, { fact: 'three' })] });
      assert.deepEqual(r.body.facts, { ...zeroFacts, inserted: 1, skipped: 1 });
      assert.deepEqual([(await stored(S, 'facts', 'f')).seq, (await stored(S, 'facts', 'f')).fact], [9, 'nine']);
    });

    it('facts 5 then 6: inserted 1, updated 1, stored at 6', async () => {
      const r = await batch({ facts: [build.fact(S, 'f', 5, { fact: 'five' }), build.fact(S, 'f', 6, { fact: 'six' })] });
      assert.deepEqual(r.body.facts, { ...zeroFacts, inserted: 1, updated: 1 });
      assert.equal((await stored(S, 'facts', 'f')).seq, 6);
    });

    it('facts at an equal seq: equal text is skipped, divergent text forks', async () => {
      const same = await batch({ facts: [build.fact(S, 'f', 5, { fact: 'x' }), build.fact(S, 'f', 5, { fact: 'x' })] });
      assert.deepEqual(same.body.facts, { ...zeroFacts, inserted: 1, skipped: 1 });
      await door.wipe(S);
      const split = await batch({ facts: [build.fact(S, 'f', 5, { fact: 'x' }), build.fact(S, 'f', 5, { fact: 'y' })] });
      assert.deepEqual(split.body.facts, { ...zeroFacts, inserted: 1, forked: 1 });
      assert.equal(await door.coll(S, 'facts').countDocuments({ forkOf: 'f' }), 1);
    });

    it('entities 5 then 6 count upserted 2 for ONE record at 6; 6 then 5 is upserted 1, skipped 1', async () => {
      const up = await batch({ entities: [build.entity(S, 'e', 5), build.entity(S, 'e', 6, { name: 'six' })] });
      assert.deepEqual(up.body.entities, { ...zeroEnt, upserted: 2 });
      assert.equal(await door.coll(S, 'entities').countDocuments({}), 1);
      assert.equal((await stored(S, 'entities', 'e')).seq, 6);
      await door.wipe(S);
      const down = await batch({ entities: [build.entity(S, 'e', 6), build.entity(S, 'e', 5)] });
      assert.deepEqual(down.body.entities, { ...zeroEnt, upserted: 1, skipped: 1 });
    });

    it('an entity at an equal seq with divergent content is skipped, never forked', async () => {
      const r = await batch({ entities: [build.entity(S, 'e', 5, { name: 'one' }), build.entity(S, 'e', 5, { name: 'two' })] });
      assert.deepEqual(r.body.entities, { ...zeroEnt, upserted: 1, skipped: 1 });
      assert.equal((await stored(S, 'entities', 'e')).name, 'one');
    });

    it('C8: a legacy read-spill file record is counted skipped (as 5.6.0 promised), stored nowhere, rejected 0', async () => {
      // 5.6.x port pin (Q-218 cut C8): main counts this `derived`; 5.6.1 answers `skipped`, and a patch keeps that.
      const spill = '_tmp/results-0f0e0d0c-0b0a-4908-8706-050403020100.json';
      const r = await batch({ filemeta: [build.filemeta(S, spill, 7), build.filemeta(S, 'docs/real.md', 8)] });
      assert.deepEqual(r.body.filemeta, { upserted: 1, skipped: 1, rejected: 0 }, JSON.stringify(r.body.filemeta));
      assert.equal(await stored(S, 'files', spill), null, 'a legacy spill was stored as a file');
    });

    /*
     * `Q-218` round R, item R10 — the batch COUNTERS a 5.6.1 sender acts on (`sync/push-refusals.ts` subtracts
     * `rejected`; an operator reads the rest). Characterization, so green on unchanged 5.6.1 (`d62573ed`) and required
     * to stay green. NOT pinned here: a duplicate LINK, which 5.6.1 answered 500 and 5.6.2 counts `skipped` (`F9`).
     */
    describe('R10: the batch counters a 5.6.1 sender acts on', () => {
      const ALL = ['facts', 'entities', 'edges', 'chrono', 'links', 'filemeta'];
      const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link', filemeta: 'filemeta' };
      /** One document per family that its `Incoming*Doc` refuses — a fixture per family. */
      const MALFORMED = {
        facts: (d) => { delete d.fact; return d; },
        entities: (d) => { delete d.name; return d; },
        edges: (d) => { delete d.label; return d; },
        chrono: (d) => { delete d.title; return d; },
        links: (d) => { delete d.fromKind; return d; },
        filemeta: (d) => ({ ...d, parentFileId: 'some/parent.md' }),
      };
      const uniq = (fam, i) => (fam === 'edges' || fam === 'links' ? { from: `from-${fam}-${i}`, to: `to-${fam}-${i}` } : {});

      it('every family: a schema-invalid document and an implausible seq are each counted rejected; the rest lands', async () => {
        const { MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js');
        const body = Object.fromEntries(ALL.map(fam => [fam, [
          MALFORMED[fam](build[KIND[fam]](S, `${fam}-bad`, 5, uniq(fam, 1))),
          build[KIND[fam]](S, `${fam}-ceiling`, MAX_INGEST_SEQ + 1, uniq(fam, 2)),
          build[KIND[fam]](S, `${fam}-good`, 7, uniq(fam, 3)),
        ]]));
        const r = await batch(body);
        assert.equal(r.code, 200, JSON.stringify(r.body));
        const landedKey = { facts: 'inserted', filemeta: 'upserted' };
        const got = Object.fromEntries(ALL.map(fam => [fam, [r.body[fam].rejected, r.body[fam][landedKey[fam] ?? 'upserted']]]));
        assert.deepEqual(got, Object.fromEntries(ALL.map(fam => [fam, [2, 1]])), JSON.stringify(r.body));
        for (const fam of ALL) {
          const coll = fam === 'filemeta' ? 'files' : fam;
          assert.deepEqual((await door.coll(S, coll).find({}).toArray()).map(d => d._id), [`${fam}-good`], fam);
        }
      });

      it('facts: a divergent copy whose fork chain is at the cap is forkDepthRefused 1 and rejected 1', async () => {
        const chain = Array.from({ length: 10 }, (_, i) => `a${i + 1}`);
        await door.coll(S, 'facts').insertMany([
          build.fact(S, 'f', 5, { fact: 'mine', forkOf: chain[0] }),
          ...chain.map((id, i) => build.fact(S, id, 1, chain[i + 1] ? { forkOf: chain[i + 1] } : {})),
        ]);
        const r = await batch({ facts: [build.fact(S, 'f', 5, { fact: 'theirs' })] });
        assert.deepEqual(r.body.facts, { ...zeroFacts, forkDepthRefused: 1, rejected: 1 });
        assert.equal(await door.coll(S, 'facts').countDocuments({ forkOf: 'f' }), 0);
      });

      it('every family a brain tombstone covers: an arrival at or below the tombstone is tombstoned 1 and not stored', async () => {
        const TOMBED = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link' };
        for (const [fam, type] of Object.entries(TOMBED)) {
          await door.coll(S, 'tombstones').insertOne(build.tombstone(S, `${fam}-gone`, type, 7));
        }
        const r = await batch(Object.fromEntries(Object.keys(TOMBED).map(fam =>
          [fam, [build[KIND[fam]](S, `${fam}-gone`, 6, uniq(fam, 4))]])));
        assert.equal(r.code, 200, JSON.stringify(r.body));
        const got = Object.fromEntries(Object.keys(TOMBED).map(fam => [fam, [r.body[fam].tombstoned, r.body[fam].rejected]]));
        assert.deepEqual(got, Object.fromEntries(Object.keys(TOMBED).map(fam => [fam, [1, 0]])), JSON.stringify(r.body));
        for (const fam of Object.keys(TOMBED)) assert.equal(await stored(S, fam, `${fam}-gone`), null, fam);
      });

      it('chrono: a type outside the vocabulary is unknownType 1 and rejected 1, and not stored', async () => {
        const r = await batch({ chrono: [build.chrono(S, 'c-odd', 5, { type: 'not-a-chrono-type' }), build.chrono(S, 'c-ok', 6)] });
        assert.deepEqual(r.body.chrono, { ...zeroEnt, upserted: 1, unknownType: 1, rejected: 1 });
        assert.equal(await stored(S, 'chrono', 'c-odd'), null);
      });

      it('edges: a new id on a triplet already STORED is duplicateTriplets 1, rejected 0, and the stored edge stays', async () => {
        const twin = { from: 'A', to: 'B', label: 'knows' };
        await door.coll(S, 'edges').insertOne(build.edge(S, 'g-held', 5, twin));
        const r = await batch({ edges: [build.edge(S, 'g-new', 6, twin)] });
        assert.deepEqual(r.body.edges, { ...zeroEdge, duplicateTriplets: 1 });
        assert.deepEqual((await door.coll(S, 'edges').find({}).toArray()).map(d => d._id), ['g-held']);
      });
    });

    it('edges: one id 5 then 6 is upserted 2; two ids on one triplet are upserted 1, duplicateTriplets 1', async () => {
      const same = await batch({ edges: [build.edge(S, 'g', 5), build.edge(S, 'g', 6)] });
      assert.deepEqual(same.body.edges, { ...zeroEdge, upserted: 2 });
      await door.wipe(S);
      const twin = { from: 'A', to: 'B', label: 'knows' };
      const dup = await batch({ edges: [build.edge(S, 'g1', 5, twin), build.edge(S, 'g2', 6, twin)] });
      assert.deepEqual(dup.body.edges, { ...zeroEdge, upserted: 1, duplicateTriplets: 1 });
      assert.deepEqual((await door.coll(S, 'edges').find({}).toArray()).map(d => d._id), ['g1']);
    });
  });
});
