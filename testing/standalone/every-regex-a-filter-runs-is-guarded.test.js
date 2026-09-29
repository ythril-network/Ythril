/**
 * Every regex a filter can make MongoDB run passes the catastrophic-pattern guard (`Q-118`).
 *
 * The guard read only keys named `$regex`, while `$expr` is allowed — so `{$expr: {$regexMatch: {input: '$name',
 * regex: '(a+)+$'}}}` ran a catastrophic pattern past it on every filter door, pinning Mongo's CPU for the whole
 * `maxTimeMS`, per member space on a proxy. The aggregation forms take their pattern from `regex`, which may also be
 * a field path — a pattern read out of stored data, which no guard can inspect — so a non-literal one is refused.
 *
 * `sanitizeFilter` is the one guard the filter tool, recall's filter and `/query` all run, so testing it tests every
 * door; the operator set is read from the module, not listed here.
 *
 * Run: node --test testing/standalone/every-regex-a-filter-runs-is-guarded.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const sanitizer = await import('../../server/dist/brain/filter-sanitizer.js');
const CATASTROPHIC = '(a+)+$';

describe('the aggregation regex operators are guarded like $regex', () => {
  it('the module names every regex-evaluating operator it guards', () => {
    assert.ok(sanitizer.REGEX_OPERATORS instanceof Set || Array.isArray(sanitizer.REGEX_OPERATORS),
      'REGEX_OPERATORS does not exist — the set the guard covers has no home');
    const ops = [...sanitizer.REGEX_OPERATORS];
    for (const op of ['$regex', '$regexMatch', '$regexFind', '$regexFindAll']) assert.ok(ops.includes(op), `${op} is not guarded`);
  });

  for (const op of ['$regexMatch', '$regexFind', '$regexFindAll']) {
    it(`${op} with a catastrophic pattern is refused, at any depth`, () => {
      const top = { $expr: { [op]: { input: '$name', regex: CATASTROPHIC } } };
      const nested = { $and: [{ type: 'x' }, { $expr: { $and: [{ [op]: { input: '$name', regex: CATASTROPHIC } }] } }] };
      assert.throws(() => sanitizer.sanitizeFilter(top), /catastrophic/, `${op} ran a catastrophic pattern past the guard`);
      assert.throws(() => sanitizer.sanitizeFilter(nested), /catastrophic/, `${op} nested inside $and was not guarded`);
    });

    it(`${op} with a pattern read from a field is refused — no guard can inspect it`, () => {
      assert.throws(() => sanitizer.sanitizeFilter({ $expr: { [op]: { input: '$name', regex: '$storedPattern' } } }),
        /literal/);
      assert.throws(() => sanitizer.sanitizeFilter({ $expr: { [op]: { input: '$name', regex: { $concat: ['(a+)', '+'] } } } }),
        /literal/);
    });

    it(`${op} with a plain pattern still works`, () => {
      const f = { $expr: { [op]: { input: '$name', regex: '^Ada', options: 'i' } } };
      assert.deepEqual(sanitizer.sanitizeFilter(f), f);
    });
  }

  it('$regex keeps its guard', () => {
    assert.throws(() => sanitizer.sanitizeFilter({ name: { $regex: CATASTROPHIC } }), /catastrophic/);
    assert.deepEqual(sanitizer.sanitizeFilter({ name: { $regex: '^Ada' } }), { name: { $regex: '^Ada' } });
  });
});

describe('the filter tool publishes what is enforced', () => {
  it('its description names the refused operators, from the set that refuses them', async () => {
    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const { toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');
    const tool = ALL_TOOLS.find(t => t.name === 'filter');
    const text = tool.inputSchema(toolSchemasFor(['general'])).properties.filter.description;
    assert.doesNotMatch(text, /Only these operators are allowed/,
      'the description promises an allowlist that nothing enforces — every query operator but three is accepted');
    for (const op of sanitizer.REFUSED_OPERATORS) assert.ok(text.includes(op), `the description does not name the refused ${op}`);
    for (const op of ['$regexMatch', '$regexFind', '$regexFindAll']) assert.ok(text.includes(op), `the description does not say ${op} is guarded`);
  });
});
