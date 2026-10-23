/**
 * A predicate cannot read a withheld field by naming it, in either grammar (`Q-446` item 5, `Q-357`).
 *
 * ## The defect
 *
 * A projection can be made to withhold a field and a predicate still reads it: `{deliveredBy: 'peer-a'}` answers
 * one row or none, so a caller learns the peer that delivered a record one bit at a time, and `$size` or a range
 * on the vector does the same for the vector. The sanitizer (`brain/filter-sanitizer.ts`) says of itself that it is
 * not a field allowlist, and that stays true: this refuses the WITHHELD fields only, named directly.
 *
 * ## The rule, per withheld field `f` (read from the build, floor 3)
 *
 * Refused, with ONE message on both grammars (the operator-object grammar through `validateFilterExpression`, raw
 * MongoDB through `sanitizeFilter`; `resolveRecallFilter` is recall's entry to both):
 *  - `f` or `f.<x>` as a key at field position — at the top level and inside `$and` / `$or` / `$nor`, and with any
 *    operator object (`$not` included) other than a lone `$exists`;
 *  - `"$f"` or `"$f.<x>"` as a field path inside `$expr`.
 *
 * Not refused: `{f: {$exists: <bool>}}` at field position (one bit, and `reindex-contract` and
 * `recall-filter-grammar` rely on it — R10), a literal string operand that merely looks like a path, a key relative
 * to an `$elemMatch` element, an embedded-document equality, and a field that only SHARES a prefix (`embeddingModel`).
 * The routes parked as D-58 - `$$ROOT`/`$$CURRENT` paths, `$getField`, `$objectToArray` and `$jsonSchema` - are
 * deliberately not asserted either way here.
 *
 * Run: node --test testing/standalone/a-predicate-cannot-read-a-withheld-field.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let NEVER_RETURNED_FIELDS, sanitizeFilter, validateFilterExpression, resolveRecallFilter;
before(async () => {
  ({ NEVER_RETURNED_FIELDS } = await import('../../server/dist/brain/recall-shape.js'));
  ({ sanitizeFilter } = await import('../../server/dist/brain/filter-sanitizer.js'));
  ({ validateFilterExpression } = await import('../../server/dist/brain/filter.js'));
  ({ resolveRecallFilter } = await import('../../server/dist/brain/recall-filter.js'));
});

/** The refusal `sanitizeFilter` gives, or null when it accepts. */
const rawRefusal = (filter) => { try { sanitizeFilter(filter); return null; } catch (e) { return e.message; } };

/** Raw-grammar predicates that name `f` directly — each must be refused. */
const namedDirectly = (f) => [
  [`{${f}: 'x'}`, { [f]: 'x' }],
  [`{${f}: {$eq: 'x'}}`, { [f]: { $eq: 'x' } }],
  [`{${f}: {$size: 8}}`, { [f]: { $size: 8 } }],
  [`{${f}: {$not: {$eq: 'x'}}}`, { [f]: { $not: { $eq: 'x' } } }],
  [`{'${f}.x': 1}`, { [`${f}.x`]: 1 }],
  [`{$and: [{${f}: 'x'}]}`, { $and: [{ [f]: 'x' }] }],
  [`{$or: [{name: 'a'}, {${f}: 'x'}]}`, { $or: [{ name: 'a' }, { [f]: 'x' }] }],
  [`{$nor: [{${f}: 'x'}]}`, { $nor: [{ [f]: 'x' }] }],
  [`{$or: [{$and: [{'${f}.x': {$gt: 0}}]}]}`, { $or: [{ $and: [{ [`${f}.x`]: { $gt: 0 } }] }] }],
  [`{$expr: {$eq: ['$${f}', 'x']}}`, { $expr: { $eq: [`$${f}`, 'x'] } }],
  [`{$expr: {$gt: [{$size: '$${f}'}, 0]}}`, { $expr: { $gt: [{ $size: `$${f}` }, 0] } }],
  [`{$expr: {$eq: ['$${f}.x', 'x']}}`, { $expr: { $eq: [`$${f}.x`, 'x'] } }],
];

/** Raw-grammar predicates that touch `f` without reading its value — each must be accepted. */
const notRefused = (f) => [
  [`{${f}: {$exists: true}}`, { [f]: { $exists: true } }],
  [`{${f}: {$exists: false}}`, { [f]: { $exists: false } }],
  [`{$and: [{${f}: {$exists: true}}]}`, { $and: [{ [f]: { $exists: true } }] }],
  [`{name: '$${f}'} (a literal string operand)`, { name: `$${f}` }],
  [`{tags: {$elemMatch: {${f}: 'x'}}} (relative to an element)`, { tags: { $elemMatch: { [f]: 'x' } } }],
  [`{properties: {${f}: 'x'}} (an embedded-document equality)`, { properties: { [f]: 'x' } }],
];

describe('the withheld set the predicate rule is held to', () => {
  it('is read from the build and has a floor', () => {
    assert.ok(NEVER_RETURNED_FIELDS.length >= 3, `NEVER_RETURNED_FIELDS holds ${NEVER_RETURNED_FIELDS.length}`);
  });
});

describe('raw MongoDB (filter, and recall\'s raw grammar): a withheld field named directly is refused', () => {
  it('every withheld field x every direct naming is refused, and the refusal names the field', () => {
    const wrong = [];
    for (const f of NEVER_RETURNED_FIELDS) {
      for (const [label, filter] of namedDirectly(f)) {
        const msg = rawRefusal(filter);
        if (msg === null) wrong.push(`${label}: accepted`);
        else if (!msg.includes(f)) wrong.push(`${label}: refused without naming ${f}: ${msg}`);
      }
    }
    assert.deepEqual(wrong, [], 'a predicate can read a withheld field');
  });

  it('`$exists` at field position, a literal operand, an $elemMatch-relative key and an embedded equality stay accepted', () => {
    const wrong = [];
    for (const f of NEVER_RETURNED_FIELDS) {
      for (const [label, filter] of notRefused(f)) {
        const msg = rawRefusal(filter);
        if (msg !== null) wrong.push(`${label}: refused: ${msg}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it('a field that only shares a prefix with a withheld one is not refused (whole-segment comparison)', () => {
    for (const filter of [{ embeddingModel: 'stub' }, { 'embeddingModel.x': 1 }, { $expr: { $eq: ['$embeddingModel', 'stub'] } }, { deliveredByX: 1 }]) {
      assert.equal(rawRefusal(filter), null, JSON.stringify(filter));
    }
  });
});

describe('the operator-object grammar refuses the same fields with the same message', () => {
  it('`{f: {eq}}`, `{f: {gt}}` and `{f.x: {eq}}` are refused for every withheld field', () => {
    const wrong = [];
    for (const f of NEVER_RETURNED_FIELDS) {
      for (const expr of [{ [f]: { eq: 'x' } }, { [f]: { gt: 0 } }, { [`${f}.x`]: { eq: 1 } }]) {
        const msg = validateFilterExpression(expr);
        if (msg === null) wrong.push(`${JSON.stringify(expr)}: accepted`);
        else if (!msg.includes(f)) wrong.push(`${JSON.stringify(expr)}: refused without naming ${f}: ${msg}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  it('`{f: {exists}}` and a shared prefix stay accepted', () => {
    for (const f of NEVER_RETURNED_FIELDS) {
      assert.equal(validateFilterExpression({ [f]: { exists: true } }), null, `{${f}: {exists: true}}`);
      assert.equal(validateFilterExpression({ [f]: { exists: false } }), null, `{${f}: {exists: false}}`);
    }
    assert.equal(validateFilterExpression({ embeddingModel: { eq: 'stub' } }), null);
  });

  it('one message: the two grammars refuse one field in the same words', () => {
    for (const f of NEVER_RETURNED_FIELDS) {
      const raw = rawRefusal({ [f]: 'x' });
      const expr = validateFilterExpression({ [f]: { eq: 'x' } });
      assert.ok(raw && expr, `${f}: raw ${raw === null ? 'accepted' : 'refused'}, operator-object ${expr === null ? 'accepted' : 'refused'}`);
      assert.equal(raw, expr, `${f}: the grammars word the refusal differently`);
    }
  });
});

describe("recall's filter entry refuses on both grammars", () => {
  it('resolveRecallFilter refuses a withheld field in either grammar, with the one message, and accepts $exists', () => {
    const wrong = [];
    for (const f of NEVER_RETURNED_FIELDS) {
      const raw = resolveRecallFilter({ [f]: { $eq: 'x' } });
      const expr = resolveRecallFilter({ [f]: { eq: 'x' } });
      if (raw.ok) wrong.push(`raw {${f}: {$eq}}: accepted`);
      if (expr.ok) wrong.push(`operator-object {${f}: {eq}}: accepted`);
      if (!raw.ok && !expr.ok && raw.error !== expr.error) wrong.push(`${f}: two messages: ${raw.error} | ${expr.error}`);
      if (!resolveRecallFilter({ [f]: { $exists: true } }).ok) wrong.push(`raw {${f}: {$exists: true}}: refused`);
      if (!resolveRecallFilter({ [f]: { exists: true } }).ok) wrong.push(`operator-object {${f}: {exists: true}}: refused`);
    }
    assert.deepEqual(wrong, []);
  });
});
