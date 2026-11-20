/**
 * A stored record the file names only as an object is a known end (bundle-270 review U3, slice S3).
 *
 * ## The doubt, and whose it is
 *
 * The translator reads one subject's group at a time, so an edge's end that is a record the FILE never describes (only an object of someone's
 * triple) can be known to it only through the context's `stored` map. If the act built that map from the file's subjects alone, every such end
 * would be answered `edge-end-unknown` and a strict import would refuse valid links. The map is the act's to build, so what the act must pass is
 * what this file pins on the translator's side:
 *
 *  - `ctx.stored` holds EVERY record the store has that the file names at all, in object position too (any kind a link or an edge may end at),
 *    keyed `recordKey(kind, id)` with its stored document; the translator asks only whether the key is held;
 *  - an end held there is a known end (no reason, an edge made), the same end absent from the map is `edge-end-unknown` (the control, so the
 *    first is the map's doing), and an end the file names that the store lacks and the index minted is known by its minted id.
 *
 * Run: node --test testing/standalone/the-rdf-translator-knows-an-end-the-file-names-only-as-an-object.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { META, BASE } from './_rdf-writer-fixtures.mjs';
import { fn, reverse, contextFor, assertAccounted, iri, q, RDF } from './_quads-to-ops-doors.mjs';

const vocabulary = await import('../../server/dist/rdf/ythril-vocabulary.js');
const Y = vocabulary.YTHRIL_NS;
const V = `${BASE}vocab/`;
const KNOWS = `${V}edge/knows`;
const at = (kind, id) => `${BASE}${kind}/${id}`;
const EDGE_ID = '99999999-9999-4999-8999-999999999999';

/** The group of entity `a1` (stored) stating one edge to `b1`, which the file never describes. */
function translate({ storedRows, minted = new Map() }) {
  const a = at('entity', 'a1');
  const b = at('entity', 'b1');
  const group = [q(a, `${RDF}type`, `${Y}Entity`), q(a, KNOWS, b)];
  const recordKey = fn('recordKey');
  const stored = new Map(storedRows.map(([kind, doc]) => [recordKey(kind, doc._id), { doc, links: {} }]));
  const tripletKey = fn('tripletKey');
  minted.set(tripletKey(iri(a), iri(KNOWS), iri(b)), { kind: 'edge', id: EDGE_ID });
  const names = reverse.addressNames(META);
  const ctx = contextFor({ meta: META, names, quads: group, stored, minted });
  const out = fn('quadsToOps')(group, ctx);
  assertAccounted(group, out, 'an end named only as an object');
  return out;
}

const A = ['entity', { _id: 'a1', name: 'A', type: 'person' }];
const B = ['entity', { _id: 'b1', name: 'B', type: 'person' }];

describe('an end the file names only as an object', () => {
  it('is a known end when the context holds it as stored: the edge is made and no reason is answered', () => {
    const out = translate({ storedRows: [A, B] });
    assert.deepEqual(out.reasons.map(r => r.code), []);
    const edge = out.ops.find(op => op.kind === 'edge');
    assert.ok(edge, `no edge was made: ${JSON.stringify(out.ops)}`);
    assert.deepEqual([edge.fields.from, edge.fields.to, edge.fields.label], ['a1', 'b1', 'knows']);
  });

  it('is edge-end-unknown when the context was built from the file\'s subjects alone (what the act must not do)', () => {
    const out = translate({ storedRows: [A] });
    assert.deepEqual(out.ops.filter(op => op.kind === 'edge'), []);
    assert.deepEqual([...new Set(out.reasons.map(r => r.code))], ['edge-end-unknown']);
  });

  it('is known by its minted id when the store lacks it and the index minted it', () => {
    const minted = new Map([[at('entity', 'b1'), { kind: 'entity', id: '77777777-7777-4777-8777-777777777777' }]]);
    const out = translate({ storedRows: [A], minted });
    const edge = out.ops.find(op => op.kind === 'edge');
    assert.ok(edge, `no edge was made: ${JSON.stringify(out.reasons)}`);
    assert.equal(edge.fields.to, '77777777-7777-4777-8777-777777777777');
  });
});
