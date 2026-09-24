/**
 * The second pre-3.0 token field is deleted: `TokenRecord.admin`.
 *
 * ## Why it could go now, and not before
 *
 * Two changes had to land first, and deliberately did so separately:
 *
 * 1. **The evidence** — `rights.instanceAdmin` and the boolean were proved to answer identically for all nine
 *    storable token shapes before the switch.
 * 2. **The switch** — seven call sites that each read `record.admin` their own way became one predicate,
 *    `isInstanceAdmin`.
 *
 * With one reader instead of seven, deleting the field is mechanical rather than a hunt. That sequencing is
 * the shape `auth/space-reach.ts` records for the change in this feature where a mistake is silent widening.
 *
 * ## What must NOT disappear with it
 *
 * - **`migrateToken` still reads it.** `LegacyToken` is its own interface over raw stored config, so a token
 *   minted before the matrix keeps its scope — including `createSpaces`, which the migration also derives
 *   from the old flag.
 * - **`OidcTokenRecord` keeps its own `admin`.** An OIDC session is built per request from a claim mapping
 *   and carries no matrix, so the flag is where its answer legitimately lives. `isInstanceAdmin`'s fallback
 *   is what serves it.
 * - **`createToken` still accepts it**, feeding `migrateToken`. "Mint an admin token" must stay sayable
 *   without hand-building a matrix.
 *
 * Run: node --test testing/standalone/legacy-admin-field-is-gone.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/**
 * The whole `TokenRecord` interface, bounded by its own braces.
 *
 * Two earlier shapes both failed, in different ways, and neither failure was visible in a diff:
 *
 * 1. **An anchor INSIDE the thing being removed.** `spaces?: string[]` anchored this scan until `spaces` was
 *    itself deleted, which broke two gates at once.
 * 2. **A fixed CHARACTER window** — `slice(at, at + 400)`. A count bounds distance, and this working copy is
 *    CRLF while CI checks out LF, so the same number covers a different number of LINES on each. A sibling
 *    gate passed here and failed in CI for exactly that reason, with nothing in the diff to show why.
 *
 * The interface's own braces are neither. They also make the check STRONGER than the forward-only window it
 * replaces: a field re-added above the old anchor is caught too.
 */
function tokenRecordBlock() {
  const types = src('server/src/config/types.ts');
  const at = types.indexOf('export interface TokenRecord {');
  assert.ok(at > 0, 'the TokenRecord interface was not found — the scanner is wrong, not the code');
  const end = types.indexOf('\n}', at);
  assert.ok(end > at, 'the interface has no closing brace at column 0 — the bound is wrong');
  const block = types.slice(at, end);
  assert.match(block, /\bid: string;/, 'and this really is TokenRecord, not an empty slice');
  return block;
}

let isInstanceAdmin, migrateToken;
before(async () => {
  ({ isInstanceAdmin } = await import('../../server/dist/auth/middleware.js'));
  ({ migrateToken } = await import('../../server/dist/auth/rights-migration.js'));
});

describe('the field is gone from the record and the plumbing', () => {
  it('TokenRecord no longer declares it', () => {
    assert.doesNotMatch(tokenRecordBlock(), /\n\s+admin: boolean;/, 'the stored field must be gone');
  });

  it('nothing writes it onto a record — on either minting path', () => {
    // Two paths mint: `createToken` and the OAuth one. The second was missed once before, when the matrix
    // was made unconditional, so it is asserted by count rather than by finding one.
    const tokens = src('server/src/auth/tokens.ts');
    assert.doesNotMatch(tokens, /^ {4}admin: opts\.admin \?\? false,/m, 'no record literal may carry it');
    assert.equal((tokens.match(/^ {6}admin: opts\.admin \?\? false,/gm) ?? []).length, 2,
      'both minting paths must still FEED migrateToken with it — that is the whole safety property');
  });

  it('ToolContext no longer declares isAdmin, and the MCP server no longer takes it', () => {
    assert.doesNotMatch(src('server/src/mcp/tools/types.ts'), /isAdmin\?: boolean;/,
      'it followed readOnly out for the same reason');
    assert.doesNotMatch(src('server/src/mcp/router.ts'), /createGlobalMcpServer\(tokenSpaces\?: string\[\], isAdmin/,
      'the parameter must be gone from the signature');
  });

  it('and no tool re-checks it, because the dispatcher already refused them', () => {
    // The three handlers that did — create_space, reindex, wipe_space — are each declared `admin: true`, so
    // `toolIsVisible` refuses the call before the handler runs. A second copy one layer down is the shape
    // that made `update_space` refuse a space administrator the guard had just admitted.
    // `git grep` exits 1 on no match, and shell `||` is not portable here — catch instead, as the readOnly
    // gate does. No match IS the passing case.
    let out = '';
    try {
      out = execSync('git grep -n "ctx\\.isAdmin" -- server/src', { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch { out = ''; }
    assert.equal(out, '', `these still read a context flag that no longer exists:\n${out}`);

    // And the destructure form, which is how all three actually read it.
    let destructured = '';
    try {
      destructured = execSync('git grep -n ", isAdmin }" -- server/src', { encoding: 'utf8', stdio: 'pipe' }).trim();
    } catch { destructured = ''; }
    assert.equal(destructured, '', `these still destructure it off the context:\n${destructured}`);
  });
});

describe('the search shape that missed one', () => {
  /**
   * `isNonPeerSyncWrite` read `authToken['admin']` — BRACKET notation. Every audit I ran used the dotted
   * form (`record.admin`, `.admin`), which does not match it, so the sweep reported clean while the sync
   * WRITE guard kept reading a field that was being deleted.
   *
   * The consequence was not subtle: with the field gone, every admin token became a non-peer there and the
   * whole sync write surface refused it. CI reported it as fifty-one failures in brain CRUD, because the
   * integration suite seeds records through that endpoint — nowhere near the change, and nothing in the
   * message pointing at it.
   *
   * So this asserts on the SHAPE rather than on the instance: no property access of the legacy fields in
   * either spelling, outside the places that legitimately own them.
   */
  const OWNERS = [
    'server/src/auth/instance-admin.ts',   // the predicate's own fallback
    'server/src/auth/oidc.ts',             // OidcTokenRecord, built from a claim mapping
    'server/src/auth/rights-migration.ts', // LegacyToken, the migration input
    'server/src/auth/tokens.ts',           // feeds migrateToken at mint time
  ];

  it('nothing outside the owners reads the legacy fields, in EITHER spelling', () => {
    const files = execSync('git ls-files "server/src/**/*.ts"', { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean).filter(f => !OWNERS.includes(f));
    assert.ok(files.length > 100, `only walked ${files.length} modules — the enumeration is broken`);

    // Both spellings, and `readOnly` too — it was deleted one PR earlier and deserves the same guard.
    // `?.` is two characters, and the first draft of this pattern allowed only a bare `?` before the
    // bracket — so it did not match `authToken?.['admin']`, the exact access it exists to catch. Its own
    // mutation check is what said so.
    // The accessor is REQUIRED, and that took two goes. Making it optional matched the bare words `t admin`
    // inside ordinary prose — "the last admin token" — and flagged two files that read nothing. A pattern
    // that cries wolf gets loosened until it catches nothing, which is how the original miss happened.
    const BAD = /\b(?:authToken|record|token|target|t)\s*\??\.\s*(?:admin|readOnly)\b|\b(?:authToken|record|token|target|t)\s*\??\.?\s*\[\s*['"](?:admin|readOnly)['"]\s*\]/;
    const offenders = files.filter(f => BAD.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(offenders, [],
      'these read a deleted field — ask `isInstanceAdmin` / the rights matrix instead:\n  ' + offenders.join('\n  '));
  });

  it('nor probes for them with `in`, which answers "unrestricted" once they are gone', () => {
    // The fourth instance of this shape, and the first I caused rather than found. `GET /api/spaces` asked
    // `'spaces' in req.authToken` — true while the field existed, false for every PAT the moment it was
    // deleted — so the listing silently stopped filtering and showed a scoped token every space on the
    // instance.
    //
    // `in` is invisible to a property-access sweep, exactly as bracket notation was. Same lesson, third
    // spelling: search for the QUESTION, not for one way of writing it.
    const files = execSync('git ls-files "server/src/**/*.ts"', { encoding: 'utf8' })
      .split('\n').map(s => s.trim()).filter(Boolean);
    const probes = files.filter(f =>
      /['"](?:spaces|admin|readOnly)['"]\s+in\s+/.test(stripComments(readFileSync(f, 'utf8'))));
    assert.deepEqual(probes, [],
      'these probe for a deleted field and read its absence as "no restriction":\n  ' + probes.join('\n  '));
  });

  it('and the detector really matches the bracket form that got through', () => {
    // Mutation-proof for the pattern itself: a gate whose regex misses the case it was written for is worse
    // than none, because it reports clean.
    // `?.` is two characters, and the first draft of this pattern allowed only a bare `?` before the
    // bracket — so it did not match `authToken?.['admin']`, the exact access it exists to catch. Its own
    // mutation check is what said so.
    // The accessor is REQUIRED, and that took two goes. Making it optional matched the bare words `t admin`
    // inside ordinary prose — "the last admin token" — and flagged two files that read nothing. A pattern
    // that cries wolf gets loosened until it catches nothing, which is how the original miss happened.
    const BAD = /\b(?:authToken|record|token|target|t)\s*\??\.\s*(?:admin|readOnly)\b|\b(?:authToken|record|token|target|t)\s*\??\.?\s*\[\s*['"](?:admin|readOnly)['"]\s*\]/;
    assert.ok(BAD.test("if (authToken?.['admin'] === true) return false;"), 'the shape that escaped');
    assert.ok(BAD.test('if (record.admin) return true;'), 'and the dotted one');
    assert.ok(!BAD.test('rights.instanceAdmin === true'), 'but not the matrix field');
    assert.ok(!BAD.test("mapping.admin ? evaluateClaimRule(payload, mapping.admin) : false"), 'nor a claim rule');
  });
});

describe('what still answers the question', () => {
  it('one predicate, reading the matrix', () => {
    assert.equal(isInstanceAdmin({ rights: { instanceAdmin: true, createSpaces: false, floor: null, perSpace: {} } }), true);
    assert.equal(isInstanceAdmin({ rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} } }), false);
  });

  it('and the OIDC fallback, which is now its only legacy reader', () => {
    // An OIDC record carries no matrix by design. Without this branch every OIDC admin would lose access —
    // a silent NARROWING, which is the opposite failure and just as bad.
    assert.equal(isInstanceAdmin({ admin: true }), true);
    assert.equal(isInstanceAdmin({}), false);
  });

  it('OidcTokenRecord keeps its own admin field', () => {
    assert.match(src('server/src/auth/oidc.ts'), /admin: perms\.admin/,
      'the claim mapping is where that flag is legitimately produced');
  });

  it('the token listing derives instance-admin from the matrix', () => {
    assert.match(src('server/src/mcp/tools/spaces.ts'), /t\.rights\?\.instanceAdmin \? 'instance-admin'/,
      'not from a field that no longer exists');
  });
});

describe('a pre-matrix token keeps everything the flag gave it', () => {
  it('migrateToken still turns admin into instanceAdmin', () => {
    assert.equal(migrateToken({ admin: true }).instanceAdmin, true);
    assert.equal(migrateToken({}).instanceAdmin, false);
  });

  it('and into createSpaces, which is easy to forget', () => {
    // The migration derives TWO instance-level flags from the one boolean. A deletion that preserved only
    // the first would quietly remove space-creation from every legacy admin.
    assert.equal(migrateToken({ admin: true }).createSpaces, true);
    assert.equal(migrateToken({}).createSpaces, false);
  });

  it('and still gives it the admin rung, not merely the flags', () => {
    const r = migrateToken({ admin: true, spaces: ['qa'] });
    for (const area of ['knowledge', 'files', 'schema', 'dataQuality']) {
      assert.equal(r.perSpace.qa[area], 'admin', `${area} must come back as admin`);
    }
  });
});
