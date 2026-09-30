/**
 * A tool's schema and validator are built ONCE per reach, never once per call (`Q-114`).
 *
 * One tool call paid ~3.6 ms on the main thread to build a validator and compile the schema; a reused
 * validator answers in ~1 us. A tool's schema is a pure function of (tool, the ids the token reaches, IN LIST
 * ORDER), so `validatorFor(ids)` keeps a bounded LRU of validators keyed by exactly that.
 *
 * ## What each case guards
 *
 * - the key is the ids IN ORDER: the enum text is the list order and is printed in the error, so `a,b` and
 *   `b,a` are different schemas (a sorted key would serve one caller the other's enum text);
 * - the key cannot collide across different sets (a join with no separator maps ['ab'] and ['a','b'] together);
 * - a one-space token keeps `space` optional (B-6), which is a property of the ids and so of the key;
 * - eviction is LRU and the size stays bounded, or the cache is a leak that grows with every token ever seen;
 * - one validation is one synchronous step: two calls that share a reach cannot read each other's errors;
 * - an id outside `^[a-z0-9-]+$` is never put in a key, and never throws.
 *
 * Needs the PLANNED exports `validatorFor`, `_validatorCacheStats`, `_resetValidatorCache` from
 * `server/dist/mcp/validate-args.js`.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-tool-schema-is-built-once-per-reach.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const va = await import('../../server/dist/mcp/validate-args.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { materialisedSchema, toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');

const CACHE_BOUND = 64;

const reachXY = ['x', 'y'];
const withSpaceEnum = t => materialisedSchema(t, toolSchemasFor(reachXY), reachXY).properties?.space?.enum;

/** A tool whose schema requires `space` for a multi-space token: derived, not named. */
const spaceTool = ALL_TOOLS.find(t => {
  const s = materialisedSchema(t, toolSchemasFor(reachXY), reachXY);
  return Array.isArray(s.required) && s.required.includes('space') && s.properties?.space?.enum;
});
const other = ALL_TOOLS.find(t => t !== spaceTool && withSpaceEnum(t));

/** Valid apart from `space`, which the caller varies. */
function argsFor(space) {
  const schema = materialisedSchema(spaceTool, toolSchemasFor(reachXY), reachXY);
  const args = {};
  for (const k of schema.required ?? []) {
    const p = schema.properties[k];
    args[k] = k === 'space' ? space
      : p.type === 'string' ? 'a'
      : p.type === 'integer' || p.type === 'number' ? 1
      : p.type === 'array' ? []
      : p.type === 'object' ? {}
      : true;
  }
  return args;
}

describe('the planned API exists', () => {
  it('exports validatorFor and the test accessors', () => {
    assert.equal(typeof va.validatorFor, 'function', 'validatorFor(ids) is the one door to a cached validator');
    assert.equal(typeof va._validatorCacheStats, 'function');
    assert.equal(typeof va._resetValidatorCache, 'function');
  });
  it('the gate found tools to drive (floor)', () => {
    assert.ok(ALL_TOOLS.length >= 10, `only ${ALL_TOOLS.length} tools loaded`);
    assert.ok(spaceTool && other, 'no two tools with a required space enum were derived');
  });
});

describe('a validator is built once per reach', () => {
  beforeEach(() => va._resetValidatorCache());

  it('the same ids compile a tool once, however many calls', () => {
    const ids = ['alpha', 'beta'];
    for (let i = 0; i < 25; i++) assert.equal(va.validatorFor([...ids]).validate(spaceTool, argsFor('alpha')), null);
    const stats = va._validatorCacheStats();
    assert.equal(stats.size, 1);
    assert.equal(stats.compiles, 1, `25 calls on one reach compiled ${stats.compiles} times`);
    assert.equal(va.validatorFor(['alpha', 'beta']), va.validatorFor(['alpha', 'beta']), 'one reach, one validator object');
  });

  it('a second tool on the same reach compiles once more, not once per call', () => {
    const ids = ['alpha', 'beta'];
    for (let i = 0; i < 5; i++) {
      va.validatorFor(ids).validate(spaceTool, argsFor('alpha'));
      va.validatorFor(ids).validate(other, {});
    }
    assert.equal(va._validatorCacheStats().compiles, 2);
  });

  it('a,b and b,a never share an entry, and print the enum in their own order', () => {
    const ab = va.validatorFor(['alpha', 'beta']).validate(spaceTool, argsFor('nope'));
    const ba = va.validatorFor(['beta', 'alpha']).validate(spaceTool, argsFor('nope'));
    assert.match(ab, /\(alpha, beta\)/);
    assert.match(ba, /\(beta, alpha\)/);
    assert.notEqual(va.validatorFor(['alpha', 'beta']), va.validatorFor(['beta', 'alpha']));
    assert.equal(va._validatorCacheStats().size, 2);
  });

  it('different sets never share an enum', () => {
    const one = va.validatorFor(['alpha', 'beta']);
    const two = va.validatorFor(['alpha', 'beta', 'gamma']);
    assert.notEqual(one.validate(spaceTool, argsFor('gamma')), null, 'gamma is outside the first reach');
    assert.equal(two.validate(spaceTool, argsFor('gamma')), null);
    // and the other way round, after both are cached
    assert.notEqual(va.validatorFor(['alpha', 'beta']).validate(spaceTool, argsFor('gamma')), null);
  });

  it('a one-space token keeps `space` optional, a two-space token does not (B-6)', () => {
    const missing = argsFor('x');
    delete missing.space;
    assert.equal(va.validatorFor(['solo']).validate(spaceTool, missing), null);
    assert.match(va.validatorFor(['solo', 'duo']).validate(spaceTool, missing), /missing required property 'space'/);
    // the one-space entry is not reused for the two-space reach, nor the reverse, called in the other order
    assert.equal(va.validatorFor(['solo']).validate(spaceTool, missing), null);
  });

  it('the key cannot collide across different sets', () => {
    const joined = va.validatorFor(['ab']);
    const split = va.validatorFor(['a', 'b']);
    const dashed = va.validatorFor(['a-b']);
    assert.equal(new Set([joined, split, dashed]).size, 3);
    assert.match(split.validate(spaceTool, argsFor('ab')), /\(a, b\)/);
    assert.match(joined.validate(spaceTool, argsFor('a')), /\(ab\)/);
    assert.equal(va._validatorCacheStats().size, 3);
  });

  it('eviction is LRU: a touched entry survives, size stays bounded', () => {
    const first = va.validatorFor(['s0']);
    const second = va.validatorFor(['s1']);
    for (let i = 2; i < CACHE_BOUND; i++) va.validatorFor([`s${i}`]);
    assert.equal(va._validatorCacheStats().size, CACHE_BOUND);
    assert.equal(va.validatorFor(['s0']), first, 'touch the oldest');
    va.validatorFor(['over']); // one past the bound evicts the LEAST recently used, which is now s1
    assert.equal(va._validatorCacheStats().size, CACHE_BOUND);
    assert.equal(va.validatorFor(['s0']), first, 'the touched entry survived the eviction');
    assert.notEqual(va.validatorFor(['s1']), second, 's1 was the least recently used and was evicted');
    for (let i = 0; i < 300; i++) va.validatorFor([`churn${i}`]);
    assert.equal(va._validatorCacheStats().size, CACHE_BOUND, 'churn past the bound never grows the cache');
  });

  it('two validations that overlap on one reach do not see each other\'s errors', () => {
    const ids = ['alpha', 'beta'];
    const v = va.validatorFor(ids);
    let inner = null;
    let armed = true;
    const outerArgs = argsFor('alpha');
    // Read mid-validation, this getter runs a SECOND validation of the same tool on the same reach.
    Object.defineProperty(outerArgs, 'space', {
      enumerable: true,
      get() {
        if (armed) { armed = false; inner = v.validate(spaceTool, { ...argsFor('alpha'), innerBogus: 1 }); }
        return 'outer-not-a-space';
      },
    });
    const outer = v.validate(spaceTool, outerArgs);
    assert.ok(inner && /innerBogus/.test(inner), String(inner));
    assert.ok(outer && /\(alpha, beta\)/.test(outer), `outer error lost: ${outer}`);
    assert.doesNotMatch(outer, /innerBogus/, 'the outer call read the inner call\'s errors');
    assert.doesNotMatch(inner, /allowed values/, 'the inner call read the outer call\'s errors');
  });

  it('an id that is not [a-z0-9-]+ falls back to an uncached validator and does not throw', () => {
    const before = va._validatorCacheStats().size;
    for (const bad of [['Upper'], ['has space'], ['a\0b'], [''], ['ok', 'Not Ok']]) {
      let v;
      assert.doesNotThrow(() => { v = va.validatorFor(bad); }, JSON.stringify(bad));
      const r = v.validate(spaceTool, argsFor('nope'));
      assert.match(r, /Invalid arguments/, 'the fallback still validates');
    }
    assert.equal(va._validatorCacheStats().size, before, 'nothing unkeyable was stored under a key');
    // a NUL-joined pair must not alias the two-id set it would spell
    assert.notEqual(va.validatorFor(['a\0b']), va.validatorFor(['a', 'b']));
  });
});
