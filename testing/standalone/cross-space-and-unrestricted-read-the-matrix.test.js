/**
 * Two more scoping decisions that read the DEAD allowlist, and so answered "unrestricted" for every modern
 * token.
 *
 * ## The class, third and fourth instances
 *
 * `spaces` is `undefined` on every token minted since the rights matrix — the editor writes
 * `rights.perSpace`, the mint body has `spaces` optional, `createToken` stores it verbatim, and the mint
 * route's own refusal map tells a caller to use `rights.perSpace` instead. So any check shaped
 * `!tokenSpaces` or `if (token.spaces)` silently means "no restriction" on a token that is in fact scoped.
 *
 * The sync routes had it (19 copies of one line). These two are the same defect on different surfaces:
 *
 * | Site | Read as | Actually |
 * | --- | --- | --- |
 * | cross-space `recall` | search every space | search only what the token reaches |
 * | signing-key rotation | unrestricted admin | a space-restricted admin was let through |
 *
 * The second is the sharper one: the instance signing key is the credential every peer pins, and continuity
 * proofs are signed with it.
 *
 * ## Why these use two different helpers
 *
 * They ask different questions. Cross-space recall wants the SET of spaces to search, at `knowledge: read` —
 * `spacesWhereTokenMay`. Rotation wants a yes/no about being unrestricted — `editorScopeFor`, which returns
 * `undefined` for a token that reaches everything and a list for one that does not. Using the set-builder for
 * the boolean would have meant comparing lengths against the config, making the answer depend on how many
 * spaces happen to exist.
 *
 * Run: node --test testing/standalone/cross-space-and-unrestricted-read-the-matrix.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let editorScopeFor;
before(async () => {
  ({ editorScopeFor } = await import('../../server/dist/auth/editor-scope.js'));
});

const ALL = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r });
const rights = (over = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

describe('"unrestricted" is answered from the matrix', () => {
  it('a matrix-scoped token is NOT unrestricted', () => {
    // The bug: this token has no `spaces` array, so `if (token.spaces)` was false and it read as
    // unrestricted — with the instance signing key behind that check.
    const scope = editorScopeFor({ rights: rights({ perSpace: { qa: ALL('admin') } }) });
    assert.notEqual(scope, undefined, 'a token scoped to one space must not read as unrestricted');
    assert.deepEqual([...scope], ['qa']);
  });

  it('a floor that grants something IS unrestricted', () => {
    // The floor applies to every space including ones created later, which is what unrestricted means here.
    assert.equal(editorScopeFor({ rights: rights({ floor: ALL('read') }) }), undefined);
  });

  it('a MISSING RECORD is not a scope question', () => {
    /*
     * That a record with NO MATRIX — or only the pre-3.0 allowlist — answers `[]` rather than unrestricted
     * is asserted, for every guard, in `no-matrix-reaches-nothing-not-everything.test.js` (`Q-45.4`).
     *
     * `undefined` for a missing record is a different question: there is no token to scope, which is the
     * caller having nothing rather than a token having everything.
     */
    assert.equal(editorScopeFor(undefined), undefined, 'no record at all is still not a scope question');
  });

  it('and the rotation route really asks it that way', () => {
    const src = stripComments(readFileSync('server/src/app.ts', 'utf8'));
    assert.match(src, /editorScopeFor\(req\.authToken\) !== undefined/,
      'signing-key rotation must not test the dead allowlist for truthiness');
    assert.doesNotMatch(src, /if \(req\.authToken\?\.spaces\)/,
      'the old truthiness check must be gone, not merely joined');
  });
});

describe('cross-space recall searches only what the token reaches', () => {
  it('the route builds its set from the matrix helper', () => {
    const src = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    assert.match(src, /spacesWhereTokenMay\(/, 'not a hand-rolled filter over cfg.spaces');
    assert.doesNotMatch(src, /!tokenSpaces \|\| tokenSpaces\.includes/,
      'the truthiness filter must be gone — it kept every space for a modern token');
  });

  it('and asks for knowledge:read, which is what a recall is', () => {
    const src = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
    assert.match(src, /'knowledge',\s*'read',/,
      'a token holding files-only in a space should not have its records ranked here');
  });

  // That the helper it uses has no allowlist left, and closes the absent-matrix case explicitly, is asserted
  // in `no-matrix-reaches-nothing-not-everything.test.js` (`Q-45.4`).
});

describe('the legacy reads that remain are deliberate', () => {
  it('they are matrix-first with the allowlist only as a fallback', () => {
    // Not every `record.spaces` is a defect. The middleware and `editorScopeFor` read it only when there is
    // no matrix, which keeps a pre-matrix token working; those go with the field itself in D-8d. What must
    // not exist is a read that consults the allowlist FIRST, or instead.
    for (const f of ['server/src/auth/middleware.ts', 'server/src/auth/editor-scope.ts']) {
      const src = stripComments(readFileSync(f, 'utf8'));
      assert.match(src, /rights/, `${f} must consult the matrix`);
      assert.doesNotMatch(src, /const \w+ = record\.spaces;\s*if \(/,
        `${f} must not branch on the allowlist before the matrix`);
    }
  });
});
