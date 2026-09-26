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

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
  .replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

const ITERATING = ['duplicates', 'contradictions', 'conflicts'];
const dupes = read('server/src/api/duplicates.ts');
const helper = read('server/src/auth/reachable-spaces.ts');

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
    const oidc = stripComments(readFileSync('server/src/auth/oidc.ts', 'utf8'));
    assert.match(oidc, /rights:\s*(withInstanceAdminGrants\()?migrateToken\(/,
      'the OIDC record must still derive a matrix — it is what makes failing closed safe everywhere else');
  });
});

describe('every iterating router', () => {
  it('carries no copy of the empty-means-all conflation', () => {
    // Three copies of one rule existed. Fixing the reported one and stopping is how it survived in the other
    // two, so this asserts across the set rather than the file that was reported.
    for (const name of ITERATING) {
      const src = read(`server/src/api/${name}.ts`);
      assert.doesNotMatch(src, /tokenSpaces\.length === 0/,
        `${name}.ts still reads an empty allowlist as unrestricted`);
      assert.match(src, /spacesWhereTokenMay\(/, `${name}.ts does not use the shared filter`);
    }
  });

  it('none of them declares its own space filter any more', () => {
    // A local copy is what drifts. The helper takes the request, not a raw allowlist, so a caller cannot
    // hand it the wrong thing.
    for (const name of ITERATING) {
      const src = read(`server/src/api/${name}.ts`);
      assert.doesNotMatch(src, /function accessibleSpaces\(tokenSpaces/,
        `${name}.ts still has the old signature, which takes a raw allowlist`);
    }
  });
});

describe('the duplicates routes', () => {
  it('no longer carry their own copy of the rule', () => {
    assert.doesNotMatch(dupes, /tokenSpaces\.length === 0/,
      'a second copy of the empty-means-all conflation survives in this file');
    assert.match(dupes, /spacesWhereTokenMay\(/, 'the routes do not use the shared filter');
  });

  it('ask for WRITE on the mutating routes, not read', () => {
    // Dismiss, reopen and scan change records. Filtering them at `read` would let a read-only token act on
    // every space it can see — the column would exist and permit everything anyway.
    const writes = [...dupes.matchAll(/accessibleSpaces\(req, 'write'\)/g)];
    assert.ok(writes.length >= 3, `expected the mutating routes to require write, found ${writes.length}`);
  });

  it('the listing route asks only for READ', () => {
    assert.match(dupes, /accessibleSpaces\(req\)(?!\s*,)/,
      'the list route demands write, which would hide findings from a read-only token');
  });

  it('scan intersects before acting, not after', () => {
    // `/scan` triggers automerge and notification. Filtering after the destructive step would be a log entry
    // rather than a guard.
    const i = dupes.indexOf("accessibleSpaces(req, 'write')", dupes.indexOf('/scan'));
    const j = dupes.indexOf('targets', i);
    assert.ok(i > 0 && j > i, 'the scan route no longer intersects its targets with what the token may touch');
  });
});
