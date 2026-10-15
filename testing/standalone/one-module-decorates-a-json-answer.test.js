/**
 * One module wraps `res.json`, and everything that decorates an answer goes through it (Q-320, bundle-128, design-v3 section 2a
 * and 8.2 G14).
 *
 * ## The rule
 *
 * `statesRetryability` wrapped `res.json` by hand; the unknown-field judge is the second site. A wrapper written twice differs in
 * the half nobody remembers (copy versus mutate, throw versus pass through, stacking), so the shape is extracted into
 * `api/decorate-json-answer.ts`, whose contract is: plain objects only, copies, never throws, one wrapper per request per
 * decorator. This gate holds the extraction: NO assignment to a `.json` property anywhere in `server/src` except in that module,
 * and at least two modules USE it (the floor — the judge's door and `statesRetryability`).
 *
 * Seen red on the unchanged base: `api/brain/_read-failure.ts` assigns `res.json = …` itself and the module does not exist. The
 * controls show the assignment pattern matching a wrapper in any spelling and nothing else.
 *
 * Run: node --test testing/standalone/one-module-decorates-a-json-answer.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { maskStrings } from './_brain-write-pairs.mjs';

const MODULE = 'server/src/api/decorate-json-answer.ts';

/** An assignment to a `.json` property (not a comparison, not a call). Built fresh per use. */
const assignments = (src) => [...maskStrings(stripComments(src)).matchAll(new RegExp('[\\w$\\]\\)]\\s*\\.\\s*json\\s*=(?!=)', 'g'))];

describe('the instrument', () => {
  // CONTROLS (pass on the unchanged base by design).
  it('finds a wrapper however it is spelled, and ignores a call, a comparison and a string', () => {
    assert.equal(assignments('const o = res.json.bind(res); res.json = (b) => o(b);').length, 1);
    assert.equal(assignments('(res as any).json = fn;').length, 1);
    assert.equal(assignments('res.json({ ok: true }); if (res.json === x) {} const s = "res.json = 1";').length, 0);
  });
});

describe('res.json is decorated in one module', () => {
  const sources = trackedSources(['server/src'], { floor: 100, untracked: true });

  it('the module exists', () => {
    assert.ok(existsSync(MODULE), `${MODULE} does not exist`);
  });

  it('no file outside it assigns a `.json` property', () => {
    const offenders = sources.filter(f => f !== MODULE && assignments(readFileSync(f, 'utf8')).length > 0);
    assert.deepEqual(offenders, [], 'these files wrap `res.json` by hand: the second implementation of a shape the module holds');
  });

  it('at least two modules go through it, and statesRetryability is one of them (a floor)', () => {
    const users = sources.filter(f => f !== MODULE && /from '[^']*decorate-json-answer\.js'/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.ok(users.length >= 2, `only ${users.length} module(s) use ${MODULE}: ${users.join(', ') || 'none'}`);
    assert.ok(users.includes('server/src/api/brain/_read-failure.ts'), '`statesRetryability` (api/brain/_read-failure.ts) still wraps `res.json` on its own');
  });
});