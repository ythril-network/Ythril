/**
 * The data-quality routes filter their ITERATION SET, and an empty allowlist means none rather than all.
 *
 * ## Why the loop and not the call
 *
 * These routes name no space. They walk every space the token can reach and resolve the space from the
 * record. Refusing the call would block a token that legitimately reaches some of the spaces behind it;
 * letting the loop run unfiltered leaves the Data quality column decorative. So the list the loop walks IS
 * the enforcement point.
 *
 * ## The conflation this removes
 *
 * The old filter read `!tokenSpaces || tokenSpaces.length === 0` as "unrestricted". An **absent** allowlist
 * does mean every space; an **empty** one means none, and they are opposite. Anything holding `spaces: []`
 * was handed the whole instance — the widest possible reading of the narrowest possible token, in the one
 * place where nobody would look for it because the routes take no space at all.
 *
 * That is the same trap `migrateToken` avoids by checking `undefined` rather than length. This removes the
 * second copy rather than fixing it twice.
 *
 * Run: node --test testing/standalone/iterating-routes-filter-the-loop.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { mountedRoutes } from './_routes.mjs';
import { argumentsOf, statementAround } from './_structural-window.mjs';

const ROOT = process.cwd();
const read = (p) => stripComments(readFileSync(join(ROOT, p), 'utf8'));

const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');

/*
 * The ITERATING set is DERIVED, not listed: every route whose rights row is `iterates` over `dataQuality`, matched to
 * the file that really registers it. A fourth Data quality router needs no edit here — and a row nothing registers is
 * reported, because a rule asserted over the routes this gate FOUND says nothing about the ones it missed.
 */
const DQ_ROWS = ROUTE_RIGHTS.filter(r => r.scope === 'iterates' && r.area === 'dataQuality');
assert.ok(DQ_ROWS.length > 0, 'no Data quality iterates rows were found — the derivation stopped matching');
const mounted = mountedRoutes();
const DQ_ROUTES = DQ_ROWS.map(row => {
  const hit = mounted.find(m => m.method === row.method && m.path === row.route);
  assert.ok(hit, `${row.method} ${row.route} has a Data quality row and no registration — re-anchor this gate`);
  return { row, hit };
});
const ITERATING_FILES = [...new Set(DQ_ROUTES.map(r => r.hit.file))];
assert.ok(ITERATING_FILES.length > 1, 'the iterating routers resolved to one file or none — the derivation stopped matching');
const dupesFile = DQ_ROUTES.find(r => r.row.route === '/api/duplicates').hit.file;
const dupes = read(dupesFile);
const helper = read('server/src/auth/reachable-spaces.ts');

/**
 * The arguments of every call to an ITERATION-SET primitive in `src` — `spacesWhereTokenMay` (a list) and
 * `findWhereTokenMay` (a record by id) — as `{ at, name, args }`. Offsets are into `src`.
 */
function walksIn(src) {
  const out = [];
  for (const m of src.matchAll(/\b(spacesWhereTokenMay|findWhereTokenMay)\s*(?:<[^>(]*>)?\s*\(/g)) {
    out.push({ at: m.index, name: m[1], args: argumentsOf(src, m.index + m[0].length - 1, `${m[1]} call`) });
  }
  return out;
}

/** The handler of a registration found by `mountedRoutes`: its LAST argument, bounded by the call's own bracket. */
function handlerOf(route) {
  const src = read(route.file);
  return argumentsOf(src, src.indexOf('(', route.at), `${route.method} ${route.path}`).at(-1);
}

describe('the shared filter', () => {
  it('has no allowlist to conflate any more', () => {
    /*
     * This asserted the legacy rule inside the shared filter: `undefined` is every space, `[]` is none —
     * the distinction whose conflation was the original bug. Both halves were right about the field.
     *
     * 4.0 removed the arm, so there is no allowlist here to read either way. The stronger statement that
     * replaces it: no matrix reaches NOTHING, where the old composite (no matrix AND no allowlist) reached
     * everything. The conflation cannot come back because the input is gone.
     */
    assert.doesNotMatch(helper, /legacySpaces/,
      'the shared filter must take the matrix and nothing else');
    assert.match(helper, /if \(!rights\) return \[\]/,
      'and fail closed explicitly, rather than arriving at an empty answer by accident');
  });

  it('reads the rights matrix when the record has one', () => {
    assert.match(helper, /satisfies\(effectiveRung\(/,
      'the filter ignores the matrix, so the Data quality column governs nothing');
  });

  it('and the reason the fallback existed has expired', () => {
    /*
     * The fallback was justified as "OIDC records never pass the config backfill — without this they would
     * reach nothing at all". The OIDC path derives a matrix per request now, through the same `migrateToken`
     * the migration uses, so that sentence stopped being true and the arm served nobody.
     *
     * Asserted against the OIDC source rather than restated here, because the claim is about that file.
     */
    const oidc = read('server/src/auth/oidc.ts');
    assert.match(oidc, /rights:\s*(withInstanceAdminGrants\()?migrateToken\(/,
      'the OIDC record must still derive a matrix — it is what makes failing closed safe everywhere else');
  });
});

describe('every iterating router', () => {
  it('carries no copy of the empty-means-all conflation', () => {
    // Three copies of one rule existed. Fixing the reported one and stopping is how it survived in the other
    // two, so this asserts across the set rather than the file that was reported.
    for (const file of ITERATING_FILES) {
      const src = read(file);
      assert.doesNotMatch(src, /tokenSpaces\.length === 0/,
        `${file} still reads an empty allowlist as unrestricted`);
      assert.match(src, /spacesWhereTokenMay\(/, `${file} does not use the shared filter`);
    }
  });

  it('none of them declares its own space filter any more', () => {
    // A local copy is what drifts. The helper takes the request, not a raw allowlist, so a caller cannot
    // hand it the wrong thing.
    for (const file of ITERATING_FILES) {
      assert.doesNotMatch(read(file), /function accessibleSpaces\(tokenSpaces/,
        `${file} still has the old signature, which takes a raw allowlist`);
    }
  });
});

describe('the Data quality routes', () => {
  it('the duplicates router no longer carries its own copy of the rule', () => {
    assert.doesNotMatch(dupes, /tokenSpaces\.length === 0/,
      'a second copy of the empty-means-all conflation survives in this file');
    assert.match(dupes, /spacesWhereTokenMay\(/, 'the routes do not use the shared filter');
  });

  /*
   * Re-anchored by Q-304: the per-router `accessibleSpaces(req, needs = 'read')` wrapper is gone — its DEFAULT rung
   * is how the merge door came to walk at `read` — and every walk now names its area and rung at the call, through
   * `spacesWhereTokenMay` (a list) or `findWhereTokenMay` (a record by id). The rung each route walks at is checked
   * against its rights row structurally by `an-iterates-row-loops-at-its-rung.test.js`; these keep the spelling.
   */
  for (const { row, hit } of DQ_ROUTES) {
    it(`${row.method} ${row.route} walks the Data quality spaces at exactly ${row.needs}`, () => {
      // A mutating route filtered at `read` would let a read-only token act on every space it can see; the list
      // filtered at `write` would hide findings from a read-only token. Each route is held to ITS row's rung, so
      // one route drifting is named rather than lost in a count of the rest.
      const walks = walksIn(handlerOf(hit)).filter(w => w.args[1] === "'dataQuality'");
      assert.ok(walks.length > 0,
        `${row.method} ${row.route}: its handler walks no Data quality spaces, so nothing narrows what it reaches`);
      for (const w of walks) {
        assert.equal(w.args[2], `'${row.needs}'`,
          `${row.method} ${row.route}: ${w.name} walks at ${w.args[2]}, the row names '${row.needs}'`);
      }
    });
  }

  it('scan intersects before acting, not after', () => {
    // `/scan` triggers automerge and notification. Filtering after the destructive step would be a log entry
    // rather than a guard.
    const hit = DQ_ROUTES.find(r => r.row.route === '/api/duplicates/scan').hit;
    const handler = handlerOf(hit);
    const walk = walksIn(handler).find(w => w.args[1] === "'dataQuality'");
    assert.ok(walk, 'the scan handler walks no Data quality spaces');
    const scans = [...handler.matchAll(/\bscanSpace\s*\(/g)];
    assert.ok(scans.length > 0, 'the scan handler no longer calls scanSpace — re-anchor this gate');
    for (const s of scans) {
      assert.ok(s.index > walk.at, 'scanSpace runs before the handler has narrowed what the token may touch');
    }
    // The walk's RESULT must be what the loop runs over: `const allowed = new Set(walk)`, then the list the loop
    // iterates is built from `allowed`. A walk whose result is never used narrows nothing.
    const bound = /\b(?:const|let)\s+(\w+)\s*=/.exec(statementAround(handler, walk.at));
    assert.ok(bound, 'the walk is not bound to a name, so nothing downstream can depend on it');
    // The loop over the spaces is `scanSpacesInRequest`'s (`brain/scan-spaces-in-request.ts`, which a failing space does not
    // end): the list the handler hands it is the one that must be built from the walk.
    const request = /\bscanSpacesInRequest\s*\(\s*'[^']*'\s*,\s*(\w+)\s*,/.exec(handler);
    assert.ok(request && request.index < scans[0].index, 'scanSpace is not called through scanSpacesInRequest over a derived list');
    const iterable = request[1];
    const declared = new RegExp(`\\b(?:const|let)\\s+${iterable}\\s*=`).exec(handler);
    assert.ok(declared && declared.index > walk.at, `\`${iterable}\` is not declared after the walk`);
    assert.match(statementAround(handler, declared.index), new RegExp(`\\b${bound[1]}\\b`),
      `the list scanSpace runs over (\`${iterable}\`) is not built from the walk's result (\`${bound[1]}\`)`);
  });
});
