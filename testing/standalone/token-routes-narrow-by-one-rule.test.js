/**
 * Every token route a space-restricted administrator can reach narrows by the SAME rule.
 *
 * ## The gap
 *
 * `requireAdminOrSpaceAdminMfa` admits a space-restricted administrator — a token holding `admin` on all four
 * areas of one space. Three of the four token routes then narrow what it may touch:
 *
 *     GET    /api/tokens        filters the list by `editorScopeFor`
 *     POST   /api/tokens        refuses an out-of-scope grant at mint
 *     PATCH  /api/tokens/:id    runs `refusalsOutsideEditorScope`
 *     DELETE /api/tokens/:id    resolved no scope at all
 *
 * So an administrator of one space could **revoke any token on the instance**, instance-admin tokens included.
 * PATCH's own comment records what its guard exists to prevent — without it "such a token could rename any
 * token on the instance and write `rights.instanceAdmin` onto it" — and revoking is strictly more destructive
 * than renaming.
 *
 * One rule, four implementations, and the missing one on the most destructive verb. That is the defect
 * `CLAUDE.md` names as this repo's most-produced, arriving as an omission rather than as a weaker copy.
 *
 * ## Why the assertion is "all of them" and not "DELETE too"
 *
 * A test naming DELETE would have passed for every one of the five releases before the route existed, and will
 * pass again the day a fifth token route is added without a guard. The property is that the set of routes a
 * space admin can reach and the set that narrows are THE SAME SET, so the gate derives both.
 *
 * Run: node --test testing/standalone/token-routes-narrow-by-one-rule.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statementFrom, blockAfter } from './_structural-window.mjs';

const SRC = readFileSync('server/src/api/tokens.ts', 'utf8')
  .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Guards that admit a space-restricted administrator, so a route behind one must narrow. */
const ADMITS_SPACE_ADMIN = /requireAdminOrSpaceAdmin(Mfa)?\b/;

/** Every route registration in this file: `tokensRouter.VERB('path', ...guards, handler)`. */
function routes() {
  const out = [];
  for (const m of SRC.matchAll(/tokensRouter\.(get|post|patch|put|delete)\('([^']*)'/g)) {
    // The registration's own argument list, structurally — a character window would either miss a
    // multi-line guard list or run into the next route's.
    const args = statementFrom(SRC, m.index, `${m[1]} ${m[2]}`);
    out.push({ verb: m[1].toUpperCase(), path: m[2], at: m.index, args });
  }
  return out;
}

describe('the route surface is discovered, not listed', () => {
  it('finds the token routes', () => {
    // Without this the assertions below pass by examining nothing — the failure mode every coverage gate in
    // this repo has had at least once.
    const all = routes();
    assert.ok(all.length >= 6, `expected several token routes, found ${all.length}`);
    assert.ok(all.some(r => r.verb === 'DELETE'), 'no DELETE route found — re-anchor this gate');
  });

  it('and some of them admit a space administrator, or this gate is about nothing', () => {
    const admitting = routes().filter(r => ADMITS_SPACE_ADMIN.test(r.args));
    assert.ok(admitting.length >= 2,
      `only ${admitting.length} route admits a space admin — the guard names changed, or this file is stale`);
  });
});

describe('every route a space admin can reach narrows by the shared rule', () => {
  it('names refusalsOutsideEditorScope, or filters by editorScopeFor', () => {
    /*
     * Two acceptable shapes, because the routes do genuinely different things with one rule:
     *
     *   a MUTATION refuses  — `refusalsOutsideEditorScope`, which answers 403 naming what is out of scope
     *   a LIST narrows      — `editorScopeFor` in a filter, which returns fewer rows rather than an error
     *
     * Both are the shared resolution. What is refused here is a route that consults NEITHER, which is what
     * DELETE did: it read the token by id from the unfiltered list and deleted it.
     */
    const unnarrowed = routes()
      .filter(r => ADMITS_SPACE_ADMIN.test(r.args))
      .filter(r => {
        // The handler body, bounded by its own brace — the registration line ends before the handler starts,
        // so the guard list alone cannot answer this.
        const body = blockAfter(SRC, r.at, `${r.verb} ${r.path}`);
        // `refusalsToManageToken` is the shared rule fed by the caller's scope (held to that by minting-and-editing-share-one-scope-rule).
        return !/refusalsOutsideEditorScope\(|refusalsToManageToken\(|editorScopeFor\(/.test(body);
      })
      .map(r => `${r.verb} ${r.path}`);

    assert.deepEqual(unnarrowed, [],
      'these token routes admit a space-restricted administrator and never resolve its scope, so it may act on '
      + `tokens for spaces it cannot see:\n  ${unnarrowed.join('\n  ')}\n\n`
      + 'Call `refusalsOutsideEditorScope` (a mutation) or filter by `editorScopeFor` (a read). Do not '
      + 'reimplement the comparison — four copies of "outside your scope" is the defect this file exists for.');
  });

  it('DELETE refuses with a 403 and says what was out of scope', () => {
    // A bare 403 on a matrix of spaces is unactionable, and PATCH already answers with the refusal list. The
    // two must agree, or the same denial reads differently depending on the verb.
    const del = routes().find(r => r.verb === 'DELETE');
    const body = blockAfter(SRC, del.at, 'DELETE /:id');
    assert.match(body, /status\(403\)/, 'an out-of-scope revoke must be refused');
    assert.match(body, /refusals: scopeRefusals/, 'and must name them, as PATCH does');
  });

  it('and the scope guard runs BEFORE the last-admin check', () => {
    // Ordering is a disclosure question, not a style one. Checking last-admin first tells an out-of-scope
    // caller whether the token they cannot see is the instance's only admin.
    const del = routes().find(r => r.verb === 'DELETE');
    const body = blockAfter(SRC, del.at, 'DELETE /:id');
    //
    // ANCHORED ON THE REFUSAL, not on the call that computes it. The first version compared the position of
    // `refusalsOutsideEditorScope(` and SURVIVED moving the whole `if` block below the last-admin check —
    // because the computation stayed where it was and only the response moved. What matters is which answer
    // reaches the caller first, so the assertion is about the two `res.status` lines.
    const scope = body.indexOf('status(403)');
    const lastAdmin = body.indexOf('status(409)');
    assert.ok(scope > -1 && lastAdmin > -1, 'both refusals must still exist — re-anchor this gate');
    assert.ok(lastAdmin > scope,
      'the scope refusal must be answered first, or a refusal leaks a fact about a token the caller cannot see');
  });
});

describe('a revoke reports whether it removed anything', () => {
  it('the boolean is read, not discarded', () => {
    /*
     * `revokeToken` filters `config.tokens` by id and returns false when nothing matched. The route ignored it
     * and answered 204 unconditionally — so a revoke that deleted nothing reported success, and the caller
     * believes a live credential is gone.
     *
     * This is the "assert on the identity the operation returns" failure recorded in this codebase's own
     * lessons: a count, or here a boolean, cannot tell absent from unlooked unless somebody looks.
     */
    const del = routes().find(r => r.verb === 'DELETE');
    const body = blockAfter(SRC, del.at, 'DELETE /:id');
    assert.match(body, /const removed = await revokeToken\(/,
      'the return value must be bound, or nothing can branch on it');
    assert.match(body, /if \(!removed\)/, 'and branched on');
    assert.doesNotMatch(body, /^\s*await revokeToken\(id\);\s*$/m,
      'a bare call discards the only report of whether anything was removed');
  });

  it('and the failure says the credential is STILL VALID', () => {
    // The one thing an operator needs from that response, and the one a generic 500 does not say. They will
    // otherwise assume a transient error and move on with a live token they believe is revoked.
    const del = routes().find(r => r.verb === 'DELETE');
    const body = blockAfter(SRC, del.at, 'DELETE /:id');
    assert.match(body, /still valid/i, 'the response must say the token still authenticates');
    assert.match(body, /not something to retry/i,
      'and that retrying will not help — this is an inconsistency, not a blip');
  });
});
