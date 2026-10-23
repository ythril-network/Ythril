/**
 * A projection never answers a withheld field, and every applier reads its mode the same way (`Q-446`, `Q-357`).
 *
 * ## The rule
 *
 * `NEVER_RETURNED_FIELDS` (`brain/recall-shape.ts`) names what no read returns: the vector, `deliveredBy` and the
 * write-guard fields. A projection is the one parameter a caller can use to ask for a field by name, so it is the
 * one parameter that could make that promise false. The rule, per caller projection:
 *
 *  - a key whose FIRST path segment is a withheld field is dropped (never refused), in either mode;
 *  - the mode is decided by the non-`_id` keys when there are any; a sole truthy `_id` is an inclusion of `_id`;
 *  - an inclusion left with no paths after that drop keeps `_id` — so `{embedding: 1}`, `{_id: 0, embedding: 1}`
 *    and `{_id: 1}` all answer exactly `{_id}`;
 *  - an exclusion (and no projection at all) excludes every withheld field;
 *  - `{_id: 1, description: 0}` stays an exclusion.
 *
 * ## The appliers, and why each one is here
 *
 * Every function that turns a caller's projection into an answer is asked the same question over the same fixture:
 * the in-memory applier (`applyProjection`, used by recall, similar and the graph walks), the Mongo form
 * (`toMongoProjection`), the projection a store read is handed (`mergeEmbeddingExclusion`), recall's `_graph`
 * walk (`mapGraphNodes`) and `graph_traverse`'s body overlay (`shapeTraverseBodies`). The Mongo forms are read back
 * through a literal model of MongoDB's projection semantics below, so "the store returns every field for `{}`" and
 * "`{_id: 0}` alone is an exclusion" are facts this file states rather than borrows from the code under test. The
 * -db twin (`a-withheld-field-is-never-answered-on-any-door-db.test.js`) asks the real store.
 *
 * The withheld set is READ from the build, with a floor, so a fourth withheld field is covered by being named once.
 *
 * Run: node --test testing/standalone/a-projection-never-answers-a-withheld-field.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let NEVER_RETURNED_FIELDS, normaliseProjection, applyProjection, toMongoProjection, mergeEmbeddingExclusion;
let mapGraphNodes, shapeTraverseBodies;
before(async () => {
  ({ NEVER_RETURNED_FIELDS } = await import('../../server/dist/brain/recall-shape.js'));
  ({ normaliseProjection, applyProjection, toMongoProjection } = await import('../../server/dist/brain/projection.js'));
  ({ mergeEmbeddingExclusion } = await import('../../server/dist/brain/query.js'));
  ({ mapGraphNodes } = await import('../../server/dist/brain/recall-graph.js'));
  ({ shapeTraverseBodies } = await import('../../server/dist/brain/traverse-bodies.js'));
});

const truthy = (v) => v === 1 || v === true || v === '1';

/**
 * MongoDB's projection semantics, literally — the fixture must not read the code it tests.
 * `{}` is every field; the non-`_id` keys decide the mode; `{_id: <truthy>}` alone is an inclusion of `_id`;
 * `{_id: 0}` alone is an exclusion; a mixed projection is refused by the server.
 */
function mongoApply(doc, proj) {
  const keys = Object.keys(proj);
  if (keys.length === 0) return structuredClone(doc);
  const nonId = keys.filter(k => k !== '_id');
  const inc = nonId.filter(k => truthy(proj[k]));
  const exc = nonId.filter(k => !truthy(proj[k]));
  if (inc.length && exc.length) throw new Error(`MongoDB refuses a mixed projection: ${JSON.stringify(proj)}`);
  const inclusion = inc.length > 0 || (nonId.length === 0 && truthy(proj._id));
  if (inclusion) {
    const out = {};
    if (!('_id' in proj) || truthy(proj._id)) out._id = doc._id;
    for (const k of inc) {
      const p = k.split('.');
      let cur = doc;
      for (const s of p) cur = cur !== null && typeof cur === 'object' ? cur[s] : undefined;
      if (cur === undefined) continue;
      let dst = out;
      for (const s of p.slice(0, -1)) { dst[s] ??= {}; dst = dst[s]; }
      dst[p.at(-1)] = structuredClone(cur);
    }
    return out;
  }
  const out = structuredClone(doc);
  for (const k of exc) {
    const p = k.split('.');
    let cur = out;
    for (const s of p.slice(0, -1)) { cur = cur?.[s]; if (cur === null || typeof cur !== 'object') break; }
    if (cur && typeof cur === 'object') delete cur[p.at(-1)];
  }
  if ('_id' in proj && !truthy(proj._id)) delete out._id;
  return out;
}

/** One stored document holding every withheld field — as an object, so a dotted path into it reaches something. */
function stored(id = 'r1') {
  const doc = {
    _id: id, spaceId: 'general', name: 'API', type: 'service', tags: ['infra'], description: 'a long prose body',
    properties: { status: 'open', owner: 'platform' }, seq: 7, createdAt: 'c', updatedAt: 'u',
  };
  for (const f of NEVER_RETURNED_FIELDS) doc[f] = { x: `withheld-${f}`, y: 1 };
  return doc;
}

/** The answer the RULE gives for a projection over `stored()` — written from the rule, not from the code. */
function expected(doc, proj) {
  const W = new Set(NEVER_RETURNED_FIELDS);
  const visible = Object.fromEntries(Object.entries(doc).filter(([k]) => !W.has(k)));
  if (!proj || Object.keys(proj).length === 0) return visible;
  const kept = Object.entries(proj).filter(([k]) => k === '_id' || !W.has(k.split('.')[0]));
  const nonIdAll = Object.keys(proj).filter(k => k !== '_id');
  const include = nonIdAll.length > 0 ? nonIdAll.some(k => truthy(proj[k])) : truthy(proj._id);
  const P = Object.fromEntries(kept);
  if (include) {
    const paths = Object.keys(P).filter(k => k !== '_id' && truthy(P[k]));
    // An inclusion left with no paths keeps `_id`, whatever `_id` said.
    const keepId = paths.length === 0 || !('_id' in P) || truthy(P._id);
    return mongoApply(visible, { ...(keepId ? {} : { _id: 0 }), ...Object.fromEntries(paths.map(p => [p, 1])), ...(keepId && paths.length === 0 ? { _id: 1 } : {}) });
  }
  const drops = Object.keys(P).filter(k => k !== '_id' && !truthy(P[k]));
  const excl = { ...Object.fromEntries(drops.map(p => [p, 0])), ...('_id' in P && !truthy(P._id) ? { _id: 0 } : {}) };
  return Object.keys(excl).length ? mongoApply(visible, excl) : visible;
}

/** The shapes item 7 of the design names, per withheld field `f`. */
const shapesFor = (f) => [
  ['absent', undefined],
  [`{${f}:1}`, { [f]: 1 }],
  [`{${f}:0}`, { [f]: 0 }],
  [`{${f}:1,name:1}`, { [f]: 1, name: 1 }],
  ['{_id:1}', { _id: 1 }],
  ['{_id:true}', { _id: true }],
  ["{_id:'1'}", { _id: '1' }],
  ['{_id:0}', { _id: 0 }],
  [`{_id:1,${f}:1}`, { _id: 1, [f]: 1 }],
  [`{_id:1,${f}:0}`, { _id: 1, [f]: 0 }],
  [`{_id:0,${f}:1}`, { _id: 0, [f]: 1 }],
  [`{'${f}.x':1}`, { [`${f}.x`]: 1 }],
  [`{'${f}.x':0}`, { [`${f}.x`]: 0 }],
  [`{'${f}.x':1,name:1}`, { [`${f}.x`]: 1, name: 1 }],
];

/** Every applier, as `(doc, projection) => answer`. */
const APPLIERS = () => [
  ['applyProjection', (doc, p) => applyProjection(doc, normaliseProjection(p))],
  ['toMongoProjection (as MongoDB reads it)', (doc, p) => mongoApply(doc, toMongoProjection(normaliseProjection(p)))],
  ['mergeEmbeddingExclusion (the store read)', (doc, p) => mongoApply(doc, mergeEmbeddingExclusion(p))],
  ["recall's _graph node (mapGraphNodes)", (doc, p) =>
    mapGraphNodes([{ edges: [], node: doc, paths: [['s', doc._id]] }], d => d, true, normaliseProjection(p))[0].node],
];

const leaks = (out) => NEVER_RETURNED_FIELDS.filter(f => out !== null && typeof out === 'object' && f in out);

describe('the withheld set the rule is held to', () => {
  it('is read from the build and has a floor (the vector, deliveredBy and at least one write guard)', () => {
    assert.ok(Array.isArray(NEVER_RETURNED_FIELDS) && NEVER_RETURNED_FIELDS.length >= 3,
      `NEVER_RETURNED_FIELDS holds ${NEVER_RETURNED_FIELDS?.length}: an empty set passes every loop below`);
    for (const f of ['embedding', 'deliveredBy']) assert.ok(NEVER_RETURNED_FIELDS.includes(f), `${f} is not withheld`);
  });
});

describe('no applier answers a withheld field, for any projection, absent included', () => {
  it('every applier x every withheld field x every shape answers no withheld field', () => {
    const wrong = [];
    for (const [name, apply] of APPLIERS()) {
      for (const f of NEVER_RETURNED_FIELDS) {
        for (const [label, p] of shapesFor(f)) {
          let out;
          try { out = apply(stored(), p); } catch (e) { wrong.push(`${name} ${label}: threw ${e.message}`); continue; }
          const l = leaks(out);
          if (l.length) wrong.push(`${name} ${label}: answered ${l.join(', ')}`);
        }
      }
    }
    assert.deepEqual(wrong, [], 'a withheld field reached the answer through a projection');
  });

  it('every applier answers exactly what the rule gives, for every shape', () => {
    const wrong = [];
    for (const [name, apply] of APPLIERS()) {
      for (const f of NEVER_RETURNED_FIELDS) {
        for (const [label, p] of shapesFor(f)) {
          let out;
          try { out = apply(stored(), p); } catch (e) { wrong.push(`${name} ${label}: threw ${e.message}`); continue; }
          try { assert.deepEqual(out, expected(stored(), p)); }
          catch { wrong.push(`${name} ${label}: ${JSON.stringify(Object.keys(out ?? {}).sort())} where the rule gives ${JSON.stringify(Object.keys(expected(stored(), p)).sort())}`); }
        }
      }
    }
    assert.deepEqual(wrong, []);
  });
});

describe('the mode is decided once, and every applier agrees about it (R3, R4)', () => {
  const ID_ONLY = [
    ['{embedding:1}', { embedding: 1 }],
    ['{_id:0, embedding:1}', { _id: 0, embedding: 1 }],
    ['{_id:1}', { _id: 1 }],
  ];
  for (const [label, p] of ID_ONLY) {
    it(`${label} answers exactly {_id} on every applier`, () => {
      const got = APPLIERS().map(([name, apply]) => [name, apply(stored(), p)]);
      for (const [name, out] of got) assert.deepEqual(out, { _id: 'r1' }, `${name} answered ${JSON.stringify(Object.keys(out).sort())}`);
    });
  }

  it('the store projection of an id-only inclusion is never empty and never a bare `_id: 0` (both read as "every field")', () => {
    for (const [label, p] of ID_ONLY) {
      for (const [name, form] of [['toMongoProjection', toMongoProjection(normaliseProjection(p))], ['mergeEmbeddingExclusion', mergeEmbeddingExclusion(p)]]) {
        assert.deepEqual(form, { _id: 1 }, `${name} of ${label} is ${JSON.stringify(form)}`);
      }
    }
  });

  it('`{_id:1, description:0}` stays an exclusion: every field but the described and the withheld ones', () => {
    for (const [name, apply] of APPLIERS()) {
      const out = apply(stored(), { _id: 1, description: 0 });
      assert.deepEqual(out, expected(stored(), { _id: 1, description: 0 }), `${name}: ${JSON.stringify(Object.keys(out).sort())}`);
      assert.equal(out.name, 'API', `${name} read {_id:1, description:0} as an inclusion`);
    }
  });

  it('`{_id:0}` alone is an exclusion of _id and of every withheld field', () => {
    for (const [name, apply] of APPLIERS()) {
      const want = expected(stored(), { _id: 0 });
      assert.equal('_id' in want, false);
      assert.deepEqual(apply(stored(), { _id: 0 }), want, name);
    }
  });
});

describe("graph_traverse's body overlay follows the same rule (R7)", () => {
  const lean = () => ({
    nodes: [{ _id: 'n1', depth: 0 }, { _id: 'n2', depth: 1 }],
    edges: [{ _id: 'e1', from: 'n1', to: 'n2', label: 'depends_on' }],
  });
  const bodies = () => [
    new Map([['n1', stored('n1')], ['n2', stored('n2')]]),
    new Map([['e1', { ...stored('e1'), from: 'n1', to: 'n2', label: 'depends_on' }]]),
  ];

  it('no withheld field on any node or edge, for any shape, absent included', () => {
    const wrong = [];
    for (const f of NEVER_RETURNED_FIELDS) {
      for (const [label, p] of shapesFor(f)) {
        const out = shapeTraverseBodies(lean(), ...bodies(), normaliseProjection(p), true);
        for (const r of [...out.nodes, ...out.edges]) {
          const l = leaks(r);
          if (l.length) wrong.push(`${label} on ${r._id}: ${l.join(', ')}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  it('`{_id:1}` is the lean answer: a node is {_id, depth}, an edge {_id, from, to, label}', () => {
    for (const p of [{ _id: 1 }, { _id: true }, { embedding: 1 }, { _id: 0, embedding: 1 }]) {
      const out = shapeTraverseBodies(lean(), ...bodies(), normaliseProjection(p), false);
      assert.deepEqual(out.nodes, lean().nodes, `${JSON.stringify(p)} nodes: ${JSON.stringify(out.nodes.map(n => Object.keys(n).sort()))}`);
      assert.deepEqual(out.edges, lean().edges, `${JSON.stringify(p)} edges: ${JSON.stringify(out.edges.map(n => Object.keys(n).sort()))}`);
    }
  });
});
