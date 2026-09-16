/**
 * An OIDC identity is governed by the same rights matrix a PAT is.
 *
 * ## The hole this closes
 *
 * 3.0 made MCP enforce the per-space, per-area rung (S-1). That guard **skips a token with no matrix** — a
 * deliberate pass-through, documented as "the OIDC path builds its record per request from the identity".
 *
 * Which means the S-1 fix covered PATs and left OIDC on the old `readOnly`/`admin` booleans. One policy,
 * two implementations, on the surface nobody had checked — the same shape as the defect it was fixing, one
 * authentication method over. Fixing MCP for PATs and calling S-1 done would have been the half-fix this
 * repo keeps producing.
 *
 * ## Why it derives rather than maps its own
 *
 * `migrateToken` already encodes the decisions this needs, and two of them are the ones that granted whole
 * instances when they were got wrong: `spaces` **absent** means every space (a floor), while `spaces: []`
 * reaches **nothing**. A second hand-rolled claims→rungs mapping would be a fresh chance to confuse those.
 *
 * Nothing is stored, so nothing migrates: the record is built per request either way.
 *
 * Run: node --test testing/standalone/oidc-carries-a-rights-matrix.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSource } from './_tool-dispatch.mjs';
import { balancedFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';

let migrateToken, toolRightsRefusal;

before(async () => {
  ({ migrateToken } = await import('../../server/dist/auth/rights-migration.js'));
  ({ toolRightsRefusal } = await import('../../server/dist/mcp/tool-rights-guard.js'));
});

describe('the matrix an OIDC identity gets', () => {
  it('an admin identity reaches an admin-rung capability', () => {
    const rights = migrateToken({ admin: true, readOnly: false });
    assert.equal(toolRightsRefusal('delete_space_data', rights, 'general'), null,
      'wipe_space carries no area row, so this also proves the instance-level pass-through still holds');
    assert.equal(toolRightsRefusal('delete_fact', rights, 'general'), null);
  });

  it('a read-only identity is refused a write, where before it was refused only by the boolean', () => {
    const rights = migrateToken({ admin: false, readOnly: true });
    const refusal = toolRightsRefusal('save_fact', rights, 'general');
    assert.ok(refusal, 'read-only must not reach a write through the matrix either');
    assert.match(refusal, /knowledge: write/);
  });

  it('a scoped identity reaches its spaces and nothing else', () => {
    const rights = migrateToken({ admin: false, readOnly: false, spaces: ['alpha'] });
    assert.equal(toolRightsRefusal('save_fact', rights, 'alpha'), null);
    assert.ok(toolRightsRefusal('save_fact', rights, 'beta'), 'a claim-granted allowlist is still an allowlist');
  });

  it('an EMPTY spaces claim reaches nothing — the widening that must not happen', () => {
    // `mapOidcClaims` produces `spaces: []` when a `spaces` mapping is configured and the claim is missing
    // or not an array. That is deny. Reading it as "absent, therefore all spaces" would turn the narrowest
    // identity into the widest, which is the exact defect the migration's comments warn about.
    const rights = migrateToken({ admin: false, readOnly: false, spaces: [] });
    assert.ok(toolRightsRefusal('save_fact', rights, 'general'));
    assert.ok(toolRightsRefusal('recall', rights, 'general'));
  });

  it('an ABSENT spaces claim is a floor, not a denial', () => {
    // The other direction, and the two must not be conflated: no allowlist at all meant every space in the
    // old model, including future ones.
    const rights = migrateToken({ admin: false, readOnly: false });
    assert.equal(toolRightsRefusal('save_fact', rights, 'anything-at-all'), null);
  });
});

describe('the record actually carries it', () => {
  const strip = src => src.replace(/(^|[^:])\/\/.*/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

  it('OidcTokenRecord declares rights, and the builder populates it from migrateToken', () => {
    const src = strip(readFileSync('server/src/auth/oidc.ts', 'utf8'));
    assert.match(src, /rights: TokenRights;/, 'the record type must carry the matrix');
    assert.match(src, /rights: migrateToken\(\{/,
      'and it must be DERIVED — a hand-rolled second mapping is the thing this avoids');
    /*
     * A WINDOW, converted, and it was pointing at the wrong object. `admin: perms.admin` appears TWICE — once on
     * the record itself and once inside the `migrateToken({ … })` call the assertion is actually about — so the
     * match started on the OUTER one and reached the inner `readOnly` 400 characters later. Two different objects
     * satisfying one claim about a single object is how a hand-rolled second mapping would have passed here, which
     * is precisely what the assertion exists to refuse. The bound is the CALL's argument list.
     */
    const derivedAt = src.indexOf('rights: migrateToken(');
    assert.ok(derivedAt > -1, 'the derived rights call is gone — re-anchor this gate');
    const derived = balancedFrom(src, src.indexOf('(', derivedAt), 'the migrateToken argument');
    assert.match(derived, /admin: perms\.admin/, 'derived from the mapped claims, not from the raw payload');
    assert.match(derived, /readOnly: perms\.readOnly \?\? false/,
      'and `readOnly` defaulted inside the same call, or an absent claim reads as undefined');
  });

  it('the spaces key is omitted rather than passed as undefined', () => {
    // `migrateToken` branches on ABSENCE (`t.spaces == null`), so spreading a `spaces: undefined` would be
    // read as "no allowlist, therefore every space". Correct here, but only by accident of that check — so
    // the conditional spread is asserted rather than trusted.
    const src = strip(readFileSync('server/src/auth/oidc.ts', 'utf8'));
    assert.match(src, /\.\.\.\(perms\.spaces \? \{ spaces: perms\.spaces \} : \{\}\)/,
      'pass the key only when there is an allowlist');
  });

  it('the MCP helper no longer claims OIDC records have no matrix', () => {
    // That comment was true when it was written and became the documentation of a hole. A stale sentence
    // next to a security decision is worse than no sentence.
    const src = dispatchSource();
    assert.ok(!/`OidcTokenRecord` has no `rights` field/.test(src),
      'the helper documents a shape that no longer exists');
  });
});
