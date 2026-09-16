/**
 * `POST /api/tokens` accepts a rights matrix, refuses one above the minter, and refuses both descriptions
 * of access in one request.
 *
 * ## Why "both" is a refusal rather than a precedence rule
 *
 * A body carrying `rights` AND `spaces`/`admin`/`readOnly` describes the same thing twice. Any precedence
 * rule makes one of them silent — the caller states an access, the server ignores it, and both parties
 * believe the request succeeded. That is the failure this whole area keeps producing. Refusing costs one
 * call; guessing costs an access nobody chose.
 *
 * ## Why the cap is asserted on the ROUTE and not only on `capRights`
 *
 * `mint-cannot-exceed-minter.test.js` proves the rule. This proves the route applies it — and that it reads
 * the minter's own matrix rather than trusting the request. A correct rule nobody calls is indistinguishable
 * from no rule, and on this endpoint the difference is an escalation ladder.
 *
 * Run: node --test testing/standalone/mint-accepts-rights-capped.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statementFrom } from './_structural-window.mjs';

const ROOT = process.cwd();
const SRC = 'server/src/api/tokens.ts';
const src = readFileSync(join(ROOT, SRC), 'utf8');
const withoutComments = (text) =>
  text.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const code = withoutComments(src);

describe('minting with a rights matrix', () => {
  it('the create body accepts `rights`', () => {
    // Through the shared `RightsMatrix` since `D-5`. It was declared inline here and again on the edit
    // body — one shape, two copies, which is how a protection reaches one door and not the other.
    assert.match(code, /rights: RightsMatrix/, 'a rights matrix cannot be set on mint, so nothing can use it');
  });

  it('the rights object is itself strict', () => {
    // The same defect the body had: an unknown key inside `rights` would be dropped, and a mis-spelled area
    // would mint a token with less than asked for while reporting success.
    /*
     * EVERY one of them, not the first. There are two — the create body and the update body — and `indexOf` checked
     * only the create route. Found by mutation: loosening the create schema left this green, because the update
     * schema further down still matched. A route that accepts `rights` and silently drops a mis-spelled area is
     * exactly the defect this file is about, so checking one of the two routes was checking the wrong half as
     * often as the right one.
     */
    /*
     * ONE declaration now, and checking it checks both doors — which is what the note above was reaching
     * for by counting to two. `D-5` extracted `RightsMatrix`; both bodies reference it, and
     * `minting-and-editing-share-one-scope-rule` refuses a second declaration, so this cannot quietly go
     * back to being two shapes.
     */
    const at = code.indexOf('const RightsMatrix');
    assert.ok(at > 0, 'RightsMatrix is gone — re-point this gate');
    const matrix = code.slice(at, code.indexOf('}).strict()', at) + 11);
    assert.match(matrix, /\}\)\.strict\(\)/,
      'the rights object accepts unknown keys, so a mis-spelled area mints less than was asked for');
    const users = [...code.matchAll(/rights: RightsMatrix/g)].length;
    assert.ok(users >= 2,
      `expected the create and update bodies to both use RightsMatrix, found ${users}`);
  });

  it('refuses the legacy fields outright, rather than only alongside `rights`', () => {
    /*
     * This asserted a refusal of `rights` AND a legacy field together — one description of access per
     * request, because whichever lost would lose silently. `D-5` removed the legacy fields from this
     * door entirely, so the ambiguity cannot be expressed and the guard against it went with it.
     *
     * What replaces it is stronger: the fields are refused whether or not `rights` is present, and the
     * refusal NAMES the replacement. `.strict()` alone would answer `Unrecognized key(s)`, which tells a
     * caller they are wrong and not what to do — on the endpoint an integrator meets first.
     */
    assert.match(code, /REMOVED_MINT_OPTIONS/,
      'nothing refuses the legacy mint options by name');
    /*
     * A TOP-LEVEL declaration, anchored to the start of a line at exactly two spaces.
     *
     * `code.includes('  spaces: z.')` matched a NESTED field — `spaceAdmin: { floor, spaces }` is indented
     * four, and four spaces contain two. The gate was reporting the legacy option restored by a field that
     * is not it, which is the substring check matching the wrong thing while its title still reads right.
     */
    for (const legacy of ['spaces', 'admin', 'readOnly']) {
      assert.doesNotMatch(code, new RegExp(`^  ${legacy}: z\.`, 'm'),
        `CreateTokenBody still declares \`${legacy}\` at the top level`);
    }
    assert.match(code, /rights\.perSpace|rights\.instanceAdmin|rights\.floor/,
      'the refusal does not say which `rights` field replaces each removed option');
  });

  it('calls the cap, and refuses rather than trimming', () => {
    assert.match(code, /capRights\(/, 'the mint cap is not applied on the route');
    assert.match(code, /status\(403\)/);
    assert.match(code, /cannot mint rights it does not hold/);
    assert.match(code, /describeExcess\(/, 'the refusal must name what was over the line');
  });

  it('derives the minter matrix when the record carries none', () => {
    // OIDC records never pass through the config backfill. Treating a missing matrix as "unrestricted"
    // would be the widening this endpoint exists to prevent, so it is derived from the legacy fields.
    assert.match(code, /migrateToken\(req\.authToken/,
      'a token with no rights would mint unchecked');
  });

  it('the accepted rights actually REACH the stored token', () => {
    // The defect this endpoint already had once: a field accepted, validated, and then dropped on the way to
    // storage. The caller is told 201, the token is minted, and the matrix they asked for is nowhere. Here
    // the drop would be worse than in #750 — the token would fall back to the legacy fields it was meant to
    // replace, so it would work, and work WRONGLY.
    /*
     * BOUNDED BY THE CALL, not by `[^}]*`. The old pattern read from `createToken({` to the first `}`,
     * which is a bet that the call stays on one line with no nested object in it. `D-5` reformatted it
     * and added a conditional spread, so the window closed before `rights` and the gate failed over a
     * property that still held. A gate written against a SPELLING fails when the spelling improves.
     */
    const callAt = code.indexOf('createToken({');
    assert.ok(callAt > 0, 'the createToken call is gone — re-point this gate');
    const call = code.slice(callAt, code.indexOf('});', callAt) + 3);
    assert.match(call, /rights:/,
      'createToken is called without `rights`, so an accepted matrix is silently discarded');
    const store = withoutComments(readFileSync(join(ROOT, 'server/src/auth/tokens.ts'), 'utf8'));
    // The PROPERTY: an explicitly supplied matrix is what gets stored. The old anchor was the conditional
    // spread `opts.rights ? {rights} : {}`, which was removed on purpose — omitting the field left a newly
    // minted token with NO matrix until the next boot, and `enforceAreaRung` passes when rights are absent.
    // Demanding that spread back would demand the hole back.
    assert.match(store, /rights: opts\.rights \?\?/,
      'createToken must store the matrix it was handed, and derive one when it was not');
    assert.match(store, /migrateToken\(\{/,
      'and the fallback must be the shared derivation, not a local re-implementation');
  });

  it('the cap runs BEFORE anything is created', () => {
    const capAt = code.indexOf('capRights(');
    const createAt = code.indexOf('createToken(');
    assert.ok(capAt > 0 && createAt > 0, 'expected both calls to exist');
    assert.ok(capAt < createAt, 'the token is minted before the cap is checked, so the refusal is too late');
  });
});
