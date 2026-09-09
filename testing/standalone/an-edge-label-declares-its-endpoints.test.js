/**
 * An edge label can declare what KIND of entity may sit at each end, and whether a subject may have more than
 * one — and the validator reports a stored edge that breaks either.
 *
 * ## What was missing
 *
 * A space could allowlist edge LABELS and say nothing about their ends. `benchmarks/schema/conversation-schema.mjs` declares
 * `"from"` and `"to"` for all fourteen of its labels — twenty-eight endpoint declarations with nowhere to put
 * them — and three of its rows are wrong in ways only an endpoint rule catches. Nothing could express that
 * `reports_to` goes person → person, so a `reports_to` from a document to a deadline stored silently.
 *
 * `functional` is the other half of the same gap: `reports_to` permits one manager and `works_with` permits
 * many, and until now nothing could say which. A second `reports_to` from the same person stored beside the
 * first and both came back as fact.
 *
 * ## Why they ship together
 *
 * They are two attributes of one object, so shipping them apart pays the five-places tax twice: the field, both
 * Zod doors, the collection-scoping row, the docs and the client carry-through are the same work for either.
 * `_REFERENCE.md` also defers edge contradiction warnings on exactly this trigger — *"edges land when edge
 * labels can declare functional-ness"* — so a consumer is already waiting.
 *
 * ## The two decisions this file pins, because both had a plausible wrong answer
 *
 * **Two arrays mean the CROSS PRODUCT.** Owner ruling, 2026-08-31: declaring `from: ['document', 'person'],
 * to: ['project', 'team']` also permits `document → team`, and a caller who needs exactly one pair declares a
 * label per pair. *"No need for restriction. thats obvious logic during definition."* The pairs form was
 * considered and declined, so a test asserts the cross product is ALLOWED rather than leaving the shape to
 * imply pairing.
 *
 * **`functional` means at most one `to` per `(from, label)`.** The word is borrowed from its established sense.
 * Per `(from, to)` is already guaranteed by the unique index, so it would mean nothing; per `to` is the inverse
 * relation, which has its own name. Choosing either of those silently would leave an operator unable to say
 * what they meant.
 *
 * Run: node --test testing/standalone/an-edge-label-declares-its-endpoints.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { validateEdge } = await import('../../server/dist/spaces/schema-validation.js');

/** A space meta declaring one edge label with the given schema. */
const meta = (label, schema) => ({ typeSchemas: { edge: { [label]: schema } } });

/** The reasons `validateEdge` gives for one edge, as plain strings. */
const reasons = (m, edge, resolved) => validateEdge(m, edge, resolved).map(v => `${v.field}: ${v.reason}`);

describe('the validator still does what it did', () => {
  it('a label outside the allowlist is still a violation', () => {
    // Floors the rest: if the widened signature broke the existing check, every case below would pass by
    // reporting nothing at all.
    const v = reasons(meta('knows', {}), { label: 'invented' });
    assert.equal(v.length, 1);
    assert.match(v[0], /allowlist/);
  });

  it('and a declared label with no endpoints rule is clean', () => {
    assert.deepEqual(reasons(meta('knows', {}), { label: 'knows' }), []);
  });

  it('an edge whose types were NOT resolved is not reported', () => {
    /*
     * The caller decides whether to resolve. `validateEdge` is pure and synchronous — two gates import it from
     * `dist` and call it with plain objects — so it cannot look an endpoint up itself, and a path that has not
     * resolved the types must not be told the edge is wrong.
     *
     * Reporting on absent information is how a validator becomes something people turn off.
     */
    const m = meta('reports_to', { endpoints: { from: ['person'], to: ['person'] } });
    assert.deepEqual(reasons(m, { label: 'reports_to' }), [], 'it reported without being given the types');
    assert.deepEqual(reasons(m, { label: 'reports_to' }, {}), []);
  });
});

describe('endpoints — what may sit at each end', () => {
  const m = meta('reports_to', { endpoints: { from: ['person'], to: ['person'] } });

  it('accepts the declared pair', () => {
    assert.deepEqual(reasons(m, { label: 'reports_to' }, { fromType: 'person', toType: 'person' }), []);
  });

  it('reports a wrong FROM type, naming what was declared', () => {
    const v = reasons(m, { label: 'reports_to' }, { fromType: 'document', toType: 'person' });
    assert.equal(v.length, 1);
    assert.match(v[0], /^fromType:/);
    assert.match(v[0], /person/, 'the reason must say what IS allowed, not only that this is not');
  });

  it('reports a wrong TO type', () => {
    const v = reasons(m, { label: 'reports_to' }, { fromType: 'person', toType: 'deadline' });
    assert.equal(v.length, 1);
    assert.match(v[0], /^toType:/);
  });

  it('reports BOTH ends when both are wrong', () => {
    // One violation per end, because an operator fixing one should not have to re-run to discover the other —
    // the same reasoning the edge write path already uses for `from` and `to` existence.
    const v = reasons(m, { label: 'reports_to' }, { fromType: 'document', toType: 'deadline' });
    assert.equal(v.length, 2);
  });

  it('an absent side constrains nothing', () => {
    /*
     * The case that keeps the feature usable. In the fourteen-label benchmark model `likes` permits seven of
     * nine types on `to`, and a rule that must enumerate seven of nine is a list somebody will forget to
     * extend. So `{ from: ['person'] }` pins the subject and leaves the object open.
     */
    const only = meta('likes', { endpoints: { from: ['person'] } });
    assert.deepEqual(reasons(only, { label: 'likes' }, { fromType: 'person', toType: 'anything' }), []);
    assert.equal(reasons(only, { label: 'likes' }, { fromType: 'document', toType: 'anything' }).length, 1);
  });

  it('UNTYPED is admissible by SAYING so', () => {
    /*
     * An entity with no type is a real, ordinary thing. Refusing it by silence would make the feature unusable
     * in exactly the spaces that have not finished typing their data — which is most of them, most of the time.
     * So it is a member of the vocabulary rather than an exception in the code.
     */
    const m2 = meta('mentions', { endpoints: { to: ['UNTYPED'] } });
    assert.deepEqual(reasons(m2, { label: 'mentions' }, { fromType: 'person', toType: null }), []);
    assert.equal(reasons(m2, { label: 'mentions' }, { fromType: 'person', toType: 'person' }).length, 1);
  });

  it('an UNTYPED entity where a type is required IS a violation', () => {
    /*
     * The hole this closes, and the reason `null` and `undefined` mean different things here.
     *
     * The first draft used `undefined` for both "the entity has no type" and "the caller did not look". They
     * are opposite situations: one is an edge that breaks the declaration, the other is a path that has no
     * business being told so. Collapsed into one value, every untyped entity slipped past every endpoint rule
     * — silently, and most in the spaces least finished with their typing.
     *
     * So `null` is "resolved: it has no type" and `undefined` is "not resolved".
     */
    const m2 = meta('reports_to', { endpoints: { from: ['person'], to: ['person'] } });
    const v = reasons(m2, { label: 'reports_to' }, { fromType: null, toType: 'person' });
    assert.equal(v.length, 1, 'an untyped entity passed a rule that names one type');
    assert.match(v[0], /^fromType:/);
  });

  it('the entity: prefix means the same as a bare name', () => {
    // Reserved grammar, so the vocabulary can widen if memory or chrono links ever become edges. Accepting it
    // now and treating it as equivalent is what makes that widening a no-op for anybody already using it.
    const m2 = meta('knows', { endpoints: { from: ['entity:person'] } });
    assert.deepEqual(reasons(m2, { label: 'knows' }, { fromType: 'person', toType: 'x' }), []);
  });

  it('two arrays mean the CROSS PRODUCT — the owner ruled, so it is asserted', () => {
    /*
     * `belongs_to` may be `document → project` and `person → team` in one space; declaring both arrays also
     * permits `document → team`. That is the semantics rather than a gap: *"if they really want to make sure
     * 1-1 they need to define multiple edge schemas."*
     *
     * Asserted as ALLOWED, because the shape invites the opposite reading and a future reader would otherwise
     * be free to "fix" it into pairing.
     */
    const m2 = meta('belongs_to', { endpoints: { from: ['document', 'person'], to: ['project', 'team'] } });
    for (const [f, t] of [['document', 'project'], ['person', 'team'], ['document', 'team'], ['person', 'project']]) {
      assert.deepEqual(reasons(m2, { label: 'belongs_to' }, { fromType: f, toType: t }), [],
        `${f} → ${t} was refused, so the cross product has been narrowed into pairing`);
    }
  });
});

describe('functional — at most one subject per label', () => {
  const m = meta('reports_to', { functional: true });

  it('one existing edge from the same subject is a violation', () => {
    /*
     * At most one `to` per `(from, label)`. The caller supplies the count because `validateEdge` cannot query —
     * the same reason it cannot resolve endpoint types.
     */
    const v = reasons(m, { label: 'reports_to' }, { fromType: 'p', toType: 'p', otherEdgesFromSubject: 1 });
    assert.equal(v.length, 1);
    assert.match(v[0], /^functional:/);
    assert.match(v[0], /one/i, 'the reason must say what the limit IS');
  });

  it('none is clean, and the count being absent is clean', () => {
    assert.deepEqual(reasons(m, { label: 'reports_to' }, { otherEdgesFromSubject: 0 }), []);
    assert.deepEqual(reasons(m, { label: 'reports_to' }, {}), [],
      'a caller that did not count must not be told the edge is wrong');
  });

  it('a label that is NOT functional permits many', () => {
    const m2 = meta('works_with', { functional: false });
    assert.deepEqual(reasons(m2, { label: 'works_with' }, { otherEdgesFromSubject: 7 }), []);
    const m3 = meta('works_with', {});
    assert.deepEqual(reasons(m3, { label: 'works_with' }, { otherEdgesFromSubject: 7 }), [],
      'absent must mean unconstrained, not false');
  });
});
