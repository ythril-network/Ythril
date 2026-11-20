/**
 * An edge address converges onto its own edge and onto no other (bundle-270 review F3, slice S3).
 *
 * ## The defect this prevents
 *
 * A subject `<base>edge/X` whose `rdf:reifies` states A-knows-C, while the stored edge X is A-knows-B, became a converge onto X carrying X's
 * type, weight, description, tags and properties with from and to set to A and C. The planner keys edges by their triplet, so the commit
 * inserted a NEW edge A-knows-C holding X's values: the file's statement and the address contradict, and the address must not win quietly.
 *
 * ## What it holds
 *
 * When an edge's address is this space's and its edge is stored, the statement must name that edge's own ends and label (and end kinds):
 * the same statement converges, and a statement that changes the from end, the to end, the label or an end's kind, in either reification
 * form, is answered `contradicting-kind` and produces no operation, with every quad accounted for.
 *
 * Run: node --test testing/standalone/an-rdf-edge-address-converges-only-onto-its-own-edge.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, BASE } from './_rdf-writer-fixtures.mjs';
import { fn, reverse, contextFor, assertAccounted, iri, lit, q, RDF } from './_quads-to-ops-doors.mjs';

const V = `${BASE}vocab/`;
const TYPE = `${RDF}type`;
const at = (kind, id) => `${BASE}${kind}/${id}`;
const KNOWS = `${V}edge/knows`;
const WORKS = `${V}edge/worksWith`;

const stored = (kind, doc, links) => [kind, doc, links ?? {}];
const ROWS = [
  stored('entity', { _id: 'e1', name: 'E1', type: 'person' }),
  stored('entity', { _id: 'e2', name: 'E2', type: 'person' }),
  stored('entity', { _id: 'e3', name: 'E3', type: 'person' }),
  stored('fact', { _id: 'f1', fact: 'a fact' }),
  stored('edge', { _id: 'X', from: 'e1', to: 'e2', label: 'knows', weight: 0.5, type: 'friend', description: 'd', tags: ['t'], properties: { since: '2001-01-01' } }),
];

/** The triple term of a statement of the edge X, in the form `reifies` or the three parts. */
function statement(form, s, p, o) {
  const x = at('edge', 'X');
  if (form === 'reifies') return [q(x, `${RDF}reifies`, { kind: 'triple', subject: iri(s), predicate: iri(p), object: iri(o) })];
  return [q(x, `${RDF}subject`, s), q(x, `${RDF}predicate`, p), q(x, `${RDF}object`, o)];
}

function translate(quads, asserted) {
  const recordKey = fn('recordKey');
  const map = new Map(ROWS.map(([kind, doc, links]) => [recordKey(kind, doc._id), { doc, links }]));
  const names = reverse.addressNames(META);
  const ctx = contextFor({ meta: META, names, quads: [...quads, ...asserted], stored: map });
  const out = fn('quadsToOps')(quads, ctx);
  assertAccounted(quads, out, 'edge address');
  return out;
}

const E = (id) => at('entity', id);
/** The group of the edge X stating `s p o` with the type `label`, and the asserted triple (which sits in the from record's group). */
function group(form, label, s, p, o) {
  return [q(at('edge', 'X'), TYPE, label), ...statement(form, s, p, o), q(at('edge', 'X'), 'http://schema.org/keywords', lit('u'))];
}

describe('an edge address converges only onto its own edge', () => {
  for (const form of ['reifies', 'parts']) {
    it(`${form}: the statement of the stored edge's own ends and label converges onto it, keeping its values`, () => {
      const out = translate(group(form, KNOWS, E('e1'), KNOWS, E('e2')), [q(E('e1'), KNOWS, E('e2'))]);
      assert.deepEqual(out.reasons.map(r => r.code), []);
      assert.equal(out.ops.length, 1);
      assert.equal(out.ops[0].op, 'converge');
      assert.equal(out.ops[0].id, 'X');
      assert.deepEqual([out.ops[0].fields.from, out.ops[0].fields.to, out.ops[0].fields.label, out.ops[0].fields.weight], ['e1', 'e2', 'knows', 0.5]);
    });

    const CONTRADICTIONS = [
      ['a different to end (the review\'s trigger: A-knows-C against the stored A-knows-B)', E('e1'), KNOWS, E('e3')],
      ['a different from end', E('e3'), KNOWS, E('e2')],
      ['a different label', E('e1'), WORKS, E('e2')],
      ['a different kind of to end', E('e1'), KNOWS, at('fact', 'f1')],
    ];
    for (const [why, s, p, o] of CONTRADICTIONS) {
      it(`${form}: a statement with ${why} is answered contradicting-kind and converges onto nothing`, () => {
        const label = p === WORKS ? WORKS : KNOWS;
        const out = translate(group(form, label, s, p, o), [q(s, p, o)]);
        assert.deepEqual(out.ops, [], `an operation was made: ${JSON.stringify(out.ops)}`);
        assert.deepEqual([...new Set(out.reasons.map(r => r.code))], ['contradicting-kind']);
      });
    }
  }
});
