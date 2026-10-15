/**
 * A merge judges an undeclared property key the way a write does, on every door that can run one (`Q-93`, R6-10).
 *
 * ## The rule, for a merge
 *
 * A type that declares at least one property refuses (strict) / flags (warn) / ignores (off) a property key a write ADDS
 * that the type does not declare. A merge's "write" is the survivor's merged properties, and the P-6 split is what keeps
 * it from judging what it did not change:
 *
 *  - a key the SURVIVOR already stores passes, whether or not the type declares it: the merge did not add it. The plan
 *    must not blame it (a stored undeclared `legacy` is the survivor's own history);
 *  - a key BROUGHT IN from the absorbed record that the survivor lacks is introduced, so in strict the merge is refused
 *    (`400`, nothing written), in warn it lands and is flagged, in off nothing is evaluated;
 *  - a relinked edge is judged with a before/after split too: what the relink changes can be introduced, and the edge's own
 *    stored undeclared key is not something the relink changed.
 *
 * ## The doors
 *
 * Four callers run `mergeEntities`, DERIVED from the source and held to a floor (the same derivation as
 * `a-refused-merge-answers-alike-on-every-door-db.test.js`): the REST merge route, the duplicate review's
 * `POST /api/duplicates/:id/merge`, the `graph_merge` tool through `callTool`, and the duplicate scanner's unattended
 * `automerge`. A caller without a driver here fails the derivation. The three request doors are driven through the real
 * app (REST over HTTP, the tool through `callTool`) on the shared strict / warn / off spaces; automerge is reached through
 * a real scan.
 *
 * ## What is asserted, per door
 *
 *  - strict: a merge bringing in `extra` is refused as the caller's error (`400`) naming `extra` and not `legacy`, and
 *    writes NOTHING (every record collection, the tombstones, the embed queue, compared whole before and after);
 *  - the controls, which the base already satisfies: the survivor's own `legacy` passes and is kept; a property the type
 *    DECLARES that the absorbed brings in is fine; a relinked edge carrying a stored undeclared key does not refuse;
 *  - warn: the same merge lands, `extra` is on the survivor and a warning line names it; off: it lands and nothing is flagged.
 *
 * ## Automerge needs `$vectorSearch`
 *
 * The scanner finds a pair by the stored vectors, which a plain `mongod` cannot rank. The automerge cases are written in
 * full and SKIP off CI when the harness database has no vector search (`requireInput`, which is `absentInputReason`'s
 * test-body door: it throws on CI instead of reporting green having asserted nothing). They assert what the model's
 * automerge driver asserts: the refused pair stays open, ONE warning line per pair per scan names both ids, an unchanged
 * second scan does not warn again, and nothing is written.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-undeclared-property-key-is-judged-on-every-merge-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { snapshotParts, changedParts, RECORD_PARTS } from './_space-snapshot.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { requireInput } from '../_shared/absent-input.mjs';
import { relinkProblems, vectorOf } from './_merge-hub.mjs';
import { openUndeclaredKeyDoors, MODES, spaceOf, DECLARING, DECLARED, namesTheKey } from './_undeclared-key-doors.mjs';

const skip = await mongoSkipReason();

const SUITE = 'undeclkeysmerge';
const AUTHOR = { instanceId: `${SUITE}-receiver`, instanceLabel: 'Receiver' };
const T0 = '2026-09-01T00:00:00.000Z';
const DIMS = 768;

/** The key the survivor already stores (undeclared), and the key the absorbed brings in (undeclared). Literal on purpose. */
const LEGACY = 'legacy';
const EXTRA = 'extra';
const TYPE = DECLARING.entity;            // `service`: declares `status` only
const EDGE_LABEL = DECLARING.edge;        // `depends_on`: declares `since` only

/**
 * Spaces for the automerge cases: the shared fixture's schema, one per mode, with an automerge rule and NO embedding
 * suppression (the scanner ranks by stored vectors). The shared spaces carry no rules, so these are this file's own.
 */
const AUTOMERGE_RULES = [{ minScore: 0.5, action: 'automerge', types: ['entity'] }];
const autoSpaceOf = (mode) => `${SUITE}auto${mode}`;
const autoSpaces = () => MODES.map(mode => ({
  id: autoSpaceOf(mode), label: autoSpaceOf(mode), folders: [], completeLinkage: true, dupeRules: AUTOMERGE_RULES,
  meta: {
    validationMode: mode,
    typeSchemas: {
      entity: { [TYPE]: { propertySchemas: { [DECLARED.entity]: { type: 'string' } } } },
      edge: { [EDGE_LABEL]: { propertySchemas: { [DECLARED.edge]: { type: 'string' } } } },
    },
  },
}));

let doors, door, mongo, log, findSimilar, scanSpace, vectorsAvailable = false;

const coll = (space, part) => door.coll(space, part);
/** Every space a case may have written: the shared three and the automerge three. */
const allSpaces = () => [...MODES.map(spaceOf), ...MODES.map(autoSpaceOf)];

/** Everything a merge could have written, whole and in a stable order. */
async function snapshot(space) {
  const out = await snapshotParts(mongo, space, RECORD_PARTS);
  out.counter = (await mongo.col('ythril_counters').findOne({ _id: space }))?.seq ?? 0;
  return out;
}

/**
 * Seed a pair of `service` entities straight into the store (the merge is under test, not the write path), the survivor
 * the OLDER record (lower seq) as the duplicate routes pick under the default policy. With `edge`, the absorbed entity
 * also has an edge to a third entity, authored HERE so the merge re-keys it, carrying `edge.properties`.
 */
async function seedPair(space, { survivorProps = {}, absorbedProps = {}, vector, edge } = {}) {
  let seq = 1;
  const survivorId = crypto.randomUUID();
  const absorbedId = crypto.randomUUID();
  const entity = (_id, name, properties, type = TYPE) => ({
    _id, spaceId: space, name, type, tags: [], properties, author: AUTHOR, createdAt: T0, updatedAt: T0, seq: seq++,
    ...(vector ? { embedding: vector, embeddingModel: 'seeded' } : {}),
  });
  const names = { survivor: 'North Service', absorbed: 'South Service' };
  await coll(space, 'entities').insertMany([
    entity(survivorId, names.survivor, survivorProps), entity(absorbedId, names.absorbed, absorbedProps),
  ]);
  const hub = { survivorId, absorbedId, names, edgeTargets: [], linkSources: [], faceIds: [], thirdId: undefined, edgeId: undefined };
  if (edge) {
    const thirdId = crypto.randomUUID();
    const edgeId = crypto.randomUUID();
    // The third end is a type that declares nothing (open), so it cannot be what a schema refuses.
    await coll(space, 'entities').insertOne(entity(thirdId, 'Third Party', {}, 'scratch'));
    await coll(space, 'edges').insertOne({
      _id: edgeId, spaceId: space, from: absorbedId, to: thirdId, label: EDGE_LABEL, tags: [],
      properties: edge.properties, author: AUTHOR, createdAt: T0, updatedAt: T0, seq: seq++,
    });
    Object.assign(hub, { thirdId, edgeId, edgeTargets: [thirdId] });
  }
  await door.setCounter(space, seq - 1);
  return hub;
}

/** `log.warn` lines written while `fn` runs, and what it returned: in-process, so every door's warnings are seen. */
async function withWarnings(fn) {
  const lines = [];
  const orig = log.warn;
  log.warn = (...a) => { lines.push(a.join(' ')); };
  try { return { value: await fn(), lines }; } finally { log.warn = orig; }
}

// ── the doors: each answers { status, text, body } — status a number for the request doors, 'merged' / 'refused' for automerge ──

const DRIVERS = {
  /** POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId */
  'server/src/api/brain/entities.ts': async (space, hub) => {
    const r = await doors.rest('POST', `/api/brain/spaces/${space}/entities/${hub.survivorId}/merge/${hub.absorbedId}`, {});
    return { status: r.status, text: r.text, body: r.body };
  },
  /** POST /api/duplicates/:id/merge: the candidate the scanner would have recorded. */
  'server/src/api/duplicates.ts': async (space, hub) => {
    const [aId, bId] = [hub.survivorId, hub.absorbedId].sort();
    const _id = `entity:${aId}:${bId}`;
    const seqOf = (id) => (id === hub.survivorId ? 1 : 2);
    await coll(space, 'dupe_candidates').insertOne({ _id, spaceId: space, type: 'entity', aId, bId,
      aSeq: seqOf(aId), bSeq: seqOf(bId), score: 0.99, status: 'open', detectedAt: 'x', updatedAt: 'x' });
    const r = await doors.rest('POST', `/api/duplicates/${encodeURIComponent(_id)}/merge`, {});
    return { status: r.status, text: r.text, body: r.body };
  },
  /** `graph_merge` through `callTool`: MCP and `POST /api/graph_merge` alike. */
  'server/src/mcp/tools/entity.ts': async (space, hub) => {
    const r = await doors.mcp('graph_merge', { space, survivorId: hub.survivorId, absorbedId: hub.absorbedId });
    return { status: r.status, text: r.text, body: r.body };
  },
  /** The duplicate scanner's `automerge` rule, reached through a real scan (needs `$vectorSearch`). */
  'server/src/brain/dupe-scanner.ts': async (space, hub) => {
    // The pair must be visible to $vectorSearch before the scan, or the scan finds nothing and "not merged" would read as a refusal.
    await waitFor(async () => {
      const r = await findSimilar(space, hub.survivorId, 'entity', 5, ['entity']).catch(() => ({ results: [] }));
      return r.results.some(x => x._id === hub.absorbedId);
    }, 60_000, 250, 'the vector index never saw the seeded pair, so automerge cannot be asked',
    { what: 'the vector index to see the seeded pair' });
    const { lines } = await withWarnings(() => scanSpace(space, { reset: true }));
    const merged = !(await coll(space, 'entities').findOne({ _id: hub.absorbedId }));
    const candidate = await coll(space, 'dupe_candidates').findOne({});
    // Only the lines about THIS pair: the survivor's re-embed warns that the (offline) model is unavailable, which is the
    // merge's business and not the refusal's.
    const aboutPair = (ls) => ls.filter(l => l.includes(hub.absorbedId) || l.includes(hub.survivorId));
    return { status: merged ? 'merged' : 'refused', text: aboutPair(lines).join('\n'), lines: aboutPair(lines), candidate,
      again: async () => aboutPair((await withWarnings(() => scanSpace(space, { reset: true }))).lines) };
  },
};
const SCANNER = 'server/src/brain/dupe-scanner.ts';
const REQUEST_DOORS = Object.entries(DRIVERS).filter(([file]) => file !== SCANNER);

/**
 * The merge doors, read from the source with comments stripped: every caller of `mergeEntities` (the one sequence every
 * door runs) minus its definition.
 */
function mergeDoors() {
  return readTrackedSources('server/src', { untracked: true, floor: 300 })
    .filter(({ text }) => /\bmergeEntities\s*\(/.test(stripComments(text).replace(/(?:async\s+)?function\s+mergeEntities\s*\(/g, '')))
    .map(f => f.file)
    .filter(f => f !== 'server/src/brain/merge.ts');
}

const survivorOf = (space, hub) => coll(space, 'entities').findOne({ _id: hub.survivorId });
const absorbedOf = (space, hub) => coll(space, 'entities').findOne({ _id: hub.absorbedId });

describe('an undeclared property key is judged on every merge door', { skip }, () => {
  before(async () => {
    doors = await openUndeclaredKeyDoors({ suite: SUITE, extraSpaces: autoSpaces() });
    door = doors.door;
    mongo = door.mongo;
    ({ log } = await import('../../server/dist/util/log.js'));
    ({ findSimilar } = await import('../../server/dist/brain/recall.js'));
    ({ scanSpace } = await import('../../server/dist/brain/dupe-scanner.js'));
    // The stage probe answers `available` on a plain mongod 8.x, which RECOGNISES `$vectorSearch` but has no search component
    // to run it: ask the search component itself too (a mongod without mongot refuses `listSearchIndexes`, code 31082).
    const stage = (await mongo.checkVectorSearchAvailability()).available;
    const component = await mongo.col(`${SUITE}_search_probe`).listSearchIndexes().toArray().then(() => true, () => false);
    vectorsAvailable = stage && component;
    if (vectorsAvailable) {
      const { initSpace } = await import('../../server/dist/spaces/lifecycle.js');
      for (const mode of MODES) await initSpace(autoSpaceOf(mode), { waitForVectorReady: true });
    }
  });

  after(async () => { await doors?.close(); });

  beforeEach(async () => {
    for (const space of allSpaces()) {
      await door.wipe(space);
      await coll(space, 'dupe_candidates').deleteMany({});
    }
  });

  it('every merge door has a driver here, and there are at least four', () => {
    const found = mergeDoors();
    assert.ok(found.length >= 4, `only ${found.length} caller(s) of mergeEntities found — the derivation is broken: ${found}`);
    assert.deepEqual([...found].sort(), Object.keys(DRIVERS).sort(),
      'a merge door has no driver in this file (or a driver names a file that no longer merges) — every door a merge can '
      + 'run through must be asked how it judges an undeclared key');
  });

  for (const [file, drive] of REQUEST_DOORS) {
    describe(file, () => {
      const strict = spaceOf('strict');
      const warn = spaceOf('warn');
      const off = spaceOf('off');

      it('control: the survivor keeps a stored undeclared key and takes a declared one from the absorbed (the P-6 split)', async () => {
        const hub = await seedPair(strict, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [DECLARED.entity]: 'up' } });
        const out = await drive(strict, hub);
        assert.equal(out.status, 200,
          `${file} refused a merge whose only undeclared key is one the survivor already stores — a stored key is not one the merge adds: ${out.text}`);
        assert.equal(await absorbedOf(strict, hub), null, `${file}: the absorbed entity is still stored after a merge that answered 200`);
        const survivor = await survivorOf(strict, hub);
        assert.equal(survivor?.properties?.[LEGACY], 'old', `${file}: the survivor lost its own stored key '${LEGACY}'`);
        assert.equal(survivor?.properties?.[DECLARED.entity], 'up', `${file}: the declared key the absorbed brought in did not land`);
      });

      it('control: a property the type declares, brought in by the absorbed, is fine in strict', async () => {
        const hub = await seedPair(strict, { survivorProps: {}, absorbedProps: { [DECLARED.entity]: 'up' } });
        const out = await drive(strict, hub);
        assert.equal(out.status, 200, `${file} refused a merge that brings in only a declared key: ${out.text}`);
        assert.equal((await survivorOf(strict, hub))?.properties?.[DECLARED.entity], 'up', `${file}: the declared key did not reach the survivor`);
      });

      it('strict: a key brought in from the absorbed that the survivor lacks refuses the merge as the caller\'s error, naming it, and writes nothing', async () => {
        const hub = await seedPair(strict, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [EXTRA]: 'new' } });
        const before_ = await snapshot(strict);
        const out = await drive(strict, hub);
        const after_ = await snapshot(strict);
        assert.equal(out.status, 400,
          `${file} answered ${out.status} for a merge that brings the undeclared key '${EXTRA}' into a strict space — the survivor `
          + `would store a key its type does not declare, and the refusal is the caller's (400): ${out.text}`);
        assert.ok(namesTheKey(out.text, EXTRA), `${file}: the refusal does not name '${EXTRA}' and say it is not declared: ${out.text}`);
        assert.ok(!out.text.includes(LEGACY), `${file}: the refusal blames '${LEGACY}', the survivor's own stored key, which the merge did not add: ${out.text}`);
        if (Array.isArray(out.body?.violations)) {
          const fields = out.body.violations.map(v => v.field);
          assert.ok(fields.includes(`properties.${EXTRA}`), `${file}: no violation row for properties.${EXTRA}: ${fields}`);
          assert.ok(!fields.includes(`properties.${LEGACY}`), `${file}: a violation row blames properties.${LEGACY}: ${fields}`);
        }
        assert.ok(await absorbedOf(strict, hub), `${file}: the absorbed entity is gone after a refused merge`);
        assert.equal((await survivorOf(strict, hub))?.properties?.[EXTRA], undefined, `${file}: the survivor stores '${EXTRA}' after a refused merge`);
        // The counter is not compared: a refusal MAY have taken a seq it never used, which is a gap and safe by design.
        assert.deepEqual(changedParts(before_, after_, { ignore: ['counter'] }), [], `${file}: a refused merge changed the space`);
      });

      it('warn: the same merge lands with the key on the survivor, and a warning names it', async () => {
        const hub = await seedPair(warn, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [EXTRA]: 'new' } });
        const { value: out, lines } = await withWarnings(() => drive(warn, hub));
        assert.equal(out.status, 200, `${file} refused a merge in a warn space: ${out.text}`);
        const survivor = await survivorOf(warn, hub);
        assert.equal(survivor?.properties?.[EXTRA], 'new', `${file}: '${EXTRA}' is not on the survivor`);
        assert.equal(survivor?.properties?.[LEGACY], 'old', `${file}: the survivor lost '${LEGACY}'`);
        const about = lines.filter(l => l.includes(hub.survivorId) || l.includes(hub.absorbedId));
        assert.ok(about.some(l => namesTheKey(l, EXTRA)),
          `${file}: a warn space let a merge bring in the undeclared key '${EXTRA}' and warned about nothing naming it (lines about the pair: ${JSON.stringify(about)})`);
        assert.ok(!about.some(l => l.includes(LEGACY)), `${file}: the warning blames '${LEGACY}', which the survivor already stored`);
      });

      it('off: the same merge lands and nothing is flagged', async () => {
        const hub = await seedPair(off, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [EXTRA]: 'new' } });
        const { value: out, lines } = await withWarnings(() => drive(off, hub));
        assert.equal(out.status, 200, `${file} refused a merge in an off space: ${out.text}`);
        assert.equal((await survivorOf(off, hub))?.properties?.[EXTRA], 'new', `${file}: '${EXTRA}' is not on the survivor`);
        assert.deepEqual(lines.filter(l => l.includes(EXTRA)), [], `${file}: an off space flagged the undeclared key '${EXTRA}'`);
      });

      it('relinked edges: an edge\'s own stored undeclared key does not refuse a strict merge, and the edge lands on the survivor with it', async () => {
        const hub = await seedPair(strict, { edge: { properties: { [DECLARED.edge]: '2020', old: 'x' } } });
        const out = await drive(strict, hub);
        assert.equal(out.status, 200,
          `${file} refused a merge because a relinked edge carries a stored undeclared key 'old' — the relink moves the edge's end and `
          + `adds no key, so it is judged with a before/after split and 'old' is pre-existing: ${out.text}`);
        assert.deepEqual(await relinkProblems({ coll: (part) => coll(strict, part), hub }), [], `${file}: the merge did not relink whole`);
        const landed = await coll(strict, 'edges').find({ from: hub.survivorId, to: hub.thirdId }).toArray();
        assert.equal(landed.length, 1, `${file}: the absorbed entity's edge is not on the survivor exactly once`);
        assert.equal(landed[0].label, EDGE_LABEL, `${file}: the relinked edge lost its label`);
        assert.equal(landed[0].properties?.old, 'x', `${file}: the relinked edge lost its stored key 'old'`);
        assert.equal(landed[0].properties?.[DECLARED.edge], '2020', `${file}: the relinked edge lost its declared key`);
      });
    });
  }

  /*
   * Automerge: the scanner finds the pair by `$vectorSearch` over the stored vectors, which a plain mongod cannot rank, so each
   * case skips there (and throws on CI). The assertions are the ones the refused-merge model makes of this door.
   */
  describe(`${SCANNER} (automerge)`, () => {
    const needsVectors = (t) => requireInput(t, vectorsAvailable,
      'the harness database has no $vectorSearch, so the duplicate scanner cannot find the seeded pair (use an Atlas Local mongod)');

    it('control: a pair whose survivor keeps its own stored undeclared key is merged', async (t) => {
      if (!needsVectors(t)) return;
      const space = autoSpaceOf('strict');
      const hub = await seedPair(space, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [DECLARED.entity]: 'up' }, vector: vectorOf(DIMS) });
      const out = await DRIVERS[SCANNER](space, hub);
      assert.equal(out.status, 'merged', `automerge left a pair whose only undeclared key is the survivor's own stored one: ${out.text}`);
      assert.equal((await survivorOf(space, hub))?.properties?.[LEGACY], 'old', 'the survivor lost its own stored key');
    });

    it('strict: a pair whose merge would bring in an undeclared key is skipped, left open, warned about once, and nothing is written', async (t) => {
      if (!needsVectors(t)) return;
      const space = autoSpaceOf('strict');
      const hub = await seedPair(space, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [EXTRA]: 'new' }, vector: vectorOf(DIMS) });
      const before_ = await snapshot(space);
      const out = await DRIVERS[SCANNER](space, hub);
      const after_ = await snapshot(space);
      assert.equal(out.status, 'refused', `automerge merged a pair that brings the undeclared key '${EXTRA}' into a strict space: ${out.text}`);
      assert.match(out.text, new RegExp(hub.absorbedId), 'the refusal was not reported naming the absorbed entity');
      assert.match(out.text, new RegExp(hub.survivorId), 'the refusal was not reported naming the survivor');
      assert.ok(namesTheKey(out.text, EXTRA), `the warning does not name '${EXTRA}' and say it is not declared: ${out.text}`);
      assert.ok(!out.text.includes(LEGACY), `the warning blames '${LEGACY}', the survivor's own stored key: ${out.text}`);
      assert.equal(out.lines.length, 1, `one scan warned ${out.lines.length} times about one pair:\n${out.text}`);
      assert.equal(out.candidate?.status, 'open', 'a refused pair must stay open for review');
      assert.deepEqual(await out.again(), [], 'an unchanged refused pair was warned about again');
      assert.deepEqual(changedParts(before_, after_, { ignore: ['counter'] }), [], 'a refused automerge changed the space');
    });

    it('warn: the pair is merged, with the key on the survivor', async (t) => {
      if (!needsVectors(t)) return;
      const space = autoSpaceOf('warn');
      const hub = await seedPair(space, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [EXTRA]: 'new' }, vector: vectorOf(DIMS) });
      const out = await DRIVERS[SCANNER](space, hub);
      assert.equal(out.status, 'merged', `automerge refused a pair in a warn space: ${out.text}`);
      assert.equal((await survivorOf(space, hub))?.properties?.[EXTRA], 'new', `'${EXTRA}' is not on the survivor`);
    });

    it('off: the pair is merged and nothing is flagged', async (t) => {
      if (!needsVectors(t)) return;
      const space = autoSpaceOf('off');
      const hub = await seedPair(space, { survivorProps: { [LEGACY]: 'old' }, absorbedProps: { [EXTRA]: 'new' }, vector: vectorOf(DIMS) });
      const out = await DRIVERS[SCANNER](space, hub);
      assert.equal(out.status, 'merged', `automerge refused a pair in an off space: ${out.text}`);
      assert.equal((await survivorOf(space, hub))?.properties?.[EXTRA], 'new', `'${EXTRA}' is not on the survivor`);
      assert.ok(!out.lines.some(l => l.includes(EXTRA)), `an off space flagged the undeclared key '${EXTRA}': ${out.text}`);
    });

    it('relinked edges: an edge\'s own stored undeclared key does not stop automerge in strict', async (t) => {
      if (!needsVectors(t)) return;
      const space = autoSpaceOf('strict');
      const hub = await seedPair(space, { edge: { properties: { [DECLARED.edge]: '2020', old: 'x' } }, vector: vectorOf(DIMS) });
      const out = await DRIVERS[SCANNER](space, hub);
      assert.equal(out.status, 'merged', `automerge skipped a pair because a relinked edge carries a stored undeclared key: ${out.text}`);
      assert.deepEqual(await relinkProblems({ coll: (part) => coll(space, part), hub }), [], 'the merge did not relink whole');
    });
  });
});
