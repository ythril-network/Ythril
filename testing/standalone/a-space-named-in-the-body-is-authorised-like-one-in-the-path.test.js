/**
 * A space named in the request BODY is authorised exactly as strictly as one named in the path.
 *
 * ## Why this exists before the routes do
 *
 * Owner ruling, 2026-09-15: the search family must be able to read across spaces, and *"in that case the
 * route has to change and space moved to parameter."* So `POST /api/brain/spaces/:spaceId/recall` becomes
 * `POST /api/brain/recall` with an optional `space` in the body.
 *
 * Every one of the 84 rows in the rights inventory is `scope: 'path'` or `scope: 'iterates'`. There is no
 * way to authorise on a space that arrives in a body, and adding one is the single most dangerous line in
 * the 5.0 rename — **authorising one reading of a field and acting on another is a vulnerability, not a
 * refactor detail.** A reviewer cannot see that defect by reading the diff, because both readings are
 * spelled identically.
 *
 * ## The three rules, and the third is the one MCP does not have
 *
 * 1. **Read once, act on that value.** The space is resolved into ONE value before any check, and the
 *    handler is handed that same value. Never `req.body.space` twice.
 * 2. **Absent is not a bypass.** A body-scoped route with no space named must not fall through to "no space
 *    to check, therefore allowed". It fans out, and the fan-out is the thing that gets checked.
 * 3. **A cross-space read FILTERS, it does not refuse.** The path-scoped guard refuses unless the token
 *    holds the rung in every target — correct when the caller named one space. Applied to a fan-out it
 *    would refuse a whole cross-space search because one inaccessible space exists on the instance. The
 *    MCP side sidesteps this by skipping the rung check entirely and relying on reach; that is acceptable
 *    for reads and would be a hole on a write, so here the rule is explicit: keep the spaces where the rung
 *    is held, refuse only when none is left.
 *
 * Run: node --test testing/standalone/a-space-named-in-the-body-is-authorised-like-one-in-the-path.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { spacesForBodyScopedRequest } = await import('../../server/dist/auth/body-scoped-space.js');

/** A rights matrix in the shape the server actually stores — see `config/rights-shape.ts`. */
const matrix = (perSpace) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace });

const READER_OF_A = matrix({ a: { knowledge: 'read' } });
const READER_OF_A_AND_B = matrix({ a: { knowledge: 'read' }, b: { knowledge: 'read' } });
const WRITER_OF_A = matrix({ a: { knowledge: 'write' } });

/** Every space on this instance, as the caller's connection could ever see it. */
const ACCESSIBLE = ['a', 'b', 'c'];

describe('a space named in the body', () => {
  it('is checked against the rung, exactly like one in the path', () => {
    const ok = spacesForBodyScopedRequest({
      named: 'a', accessible: ACCESSIBLE, rights: READER_OF_A, area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(ok.spaces, ['a']);
    assert.equal(ok.refusal, null);
  });

  it('is REFUSED when the token does not hold the rung there', () => {
    const out = spacesForBodyScopedRequest({
      named: 'b', accessible: ACCESSIBLE, rights: READER_OF_A, area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(out.spaces, []);
    assert.match(out.refusal ?? '', /knowledge/);
    assert.match(out.refusal ?? '', /'b'/);
  });

  it('is refused when the rung is held but too low', () => {
    // read is not write. The path guard gets this right; a new door that got it wrong would be a silent
    // privilege escalation on every route that moved.
    const out = spacesForBodyScopedRequest({
      named: 'a', accessible: ACCESSIBLE, rights: READER_OF_A, area: 'knowledge', needs: 'write',
    });
    assert.deepEqual(out.spaces, []);
    assert.match(out.refusal ?? '', /write/);
  });

  it('is refused when the token presented no matrix at all', () => {
    // "No matrix reaches NOTHING" — owner, 2026-09-05. A new door must not reintroduce the fallback.
    const out = spacesForBodyScopedRequest({
      named: 'a', accessible: ACCESSIBLE, rights: undefined, area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(out.spaces, []);
    assert.match(out.refusal ?? '', /no rights matrix/);
  });
});

describe('no space named — the cross-space read', () => {
  it('is NOT a bypass: it resolves to spaces, not to "nothing to check"', () => {
    const out = spacesForBodyScopedRequest({
      named: undefined, accessible: ACCESSIBLE, rights: READER_OF_A_AND_B, area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(out.spaces, ['a', 'b']);
    assert.equal(out.refusal, null);
  });

  it('FILTERS to the spaces where the rung is held, rather than refusing the call', () => {
    // The path guard's all-or-nothing loop would refuse this entire search because `c` exists.
    const out = spacesForBodyScopedRequest({
      named: undefined, accessible: ACCESSIBLE, rights: READER_OF_A, area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(out.spaces, ['a']);
    assert.equal(out.refusal, null);
  });

  it('refuses only when the filter leaves nothing', () => {
    const out = spacesForBodyScopedRequest({
      named: undefined, accessible: ACCESSIBLE, rights: matrix({}), area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(out.spaces, []);
    assert.match(out.refusal ?? '', /no space/i);
  });

  it('filters by the rung ASKED FOR, not by whether any rung is held', () => {
    // A token that may read everywhere and write in one place, asking for write across spaces, gets the
    // one. The failure this guards is filtering on reach and calling it authorisation.
    const out = spacesForBodyScopedRequest({
      named: undefined, accessible: ACCESSIBLE, rights: WRITER_OF_A, area: 'knowledge', needs: 'write',
    });
    assert.deepEqual(out.spaces, ['a']);
  });

  it('never returns a space outside what the connection can reach', () => {
    // The matrix may name spaces this request has no business seeing — a proxy narrowing, a revoked
    // membership. `accessible` is the ceiling and the matrix cannot raise it.
    const out = spacesForBodyScopedRequest({
      named: undefined, accessible: ['a'], rights: READER_OF_A_AND_B, area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(out.spaces, ['a']);
  });
});

describe('the value that was authorised is the value handed on', () => {
  it('returns the resolved spaces rather than expecting the caller to re-read the body', () => {
    // The whole point. A handler that reads `req.body.space` again can read something else — a second
    // parse, a mutated body, a differently-trimmed string. The guard returns the list; the handler uses it.
    const out = spacesForBodyScopedRequest({
      named: '  a  ', accessible: ACCESSIBLE, rights: READER_OF_A, area: 'knowledge', needs: 'read',
    });
    assert.deepEqual(out.spaces, ['a'], 'the space was not normalised once, at the gate');
  });

  it('a non-string space is refused rather than coerced', () => {
    // `{"space": ["a"]}` must not become the string "a" somewhere downstream.
    for (const bad of [['a'], { id: 'a' }, 42, true]) {
      const out = spacesForBodyScopedRequest({
        named: bad, accessible: ACCESSIBLE, rights: READER_OF_A, area: 'knowledge', needs: 'read',
      });
      assert.deepEqual(out.spaces, [], `${JSON.stringify(bad)} was accepted as a space`);
      assert.match(out.refusal ?? '', /space/i);
    }
  });
});
