/**
 * A request with NO authenticated token is never handed to the legacy-rights derivation.
 *
 * ## The default that failed open
 *
 * Two places in the tokens API read the caller's own rights to decide what a new token may be granted, and
 * both wrote `migrateToken(req.authToken ?? {})`. That `?? {}` is the bug: `migrateToken({})` returns a WRITE
 * floor on `knowledge`, `files`, `schema` and `dataQuality` — every area of every space, including spaces
 * created later. The widest answer the matrix can express, from an input carrying no information.
 *
 * Used as the MINTER's ceiling, it means a request with no authenticated token could mint an instance-wide
 * write token.
 *
 * ## Why the fix is at the CALL SITE and not in `migrateToken`
 *
 * Because that answer is correct for what `migrateToken` is for. In the pre-3.0 model absence carried
 * meaning: no allowlist meant every space, and not-admin-not-readOnly meant write. A genuine old token on
 * disk relies on exactly that reading, and `rights-reach-matches-legacy.test.js` holds the function to those
 * semantics deliberately — it compares the matrix against a written-out statement of the old rule, with `{}`
 * among the shapes it checks.
 *
 * **So changing the function would have changed what a real legacy token gets on upgrade** — locking out
 * somebody's running token to close a hole nothing reaches. That gate failing is what said so, and it was
 * right to.
 *
 * What is wrong is only that a MISSING token was made to look like a legacy one.
 *
 * ## It is not reachable today, and that is stated rather than relied on
 *
 * Both routes sit behind auth, so `req.authToken` is set. Which is precisely why `?? {}` was easy to write
 * and would have stayed until something moved — a default that fails open behind a guard is a hole waiting
 * for the guard to change.
 *
 * Run: node --test testing/standalone/no-information-is-not-permission.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { migrateToken } = await import('../../server/dist/auth/rights-migration.js');

const TOKENS_API = 'server/src/api/tokens.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

describe('the empty legacy record really is the widest one', () => {
  it('migrateToken({}) grants a floor in every area — which is why nothing may pass it `{}`', () => {
    /*
     * Asserted rather than described, because the whole reason the call sites had to change is what this
     * returns. If a later change made an empty record reach nothing, this case fails and the guard below
     * becomes unnecessary — which is worth being told, not worth silently keeping.
     */
    const r = migrateToken({});
    assert.ok(r.floor, 'an empty legacy record no longer grants a floor — re-read the call-site guards');
    assert.deepEqual(Object.keys(r.floor).sort(), ['dataQuality', 'files', 'knowledge', 'networks', 'schema']);
    // Every DATA area at write. `networks` is none below admin (F-34): network routes were instance-admin in the
    // legacy model, so even the widest legacy record gains no network rights.
    for (const area of Object.keys(r.floor)) assert.equal(r.floor[area], area === 'networks' ? 'none' : 'write');
  });

  it('and that reading is deliberate, for a REAL pre-3.0 token', () => {
    // The old model meant "unrestricted" by omission. A token that says `readOnly: false` is saying
    // something, and a write floor is the faithful migration of it.
    const legacy = migrateToken({ admin: false, readOnly: false });
    assert.ok(legacy.floor);
    assert.equal(legacy.floor.knowledge, 'write');
  });
});

describe('no authenticated token is handed to it', () => {
  it('neither call site passes `{}` any more', () => {
    const src = code(TOKENS_API);
    assert.doesNotMatch(src, /migrateToken\(req\.authToken \?\? \{\}\)/,
      'a request with no authenticated token is being read as an empty LEGACY record, which grants a write '
      + 'floor on every area of every space — the widest thing this codebase can express, from nothing');
  });

  it('and both guard on the token being present, then fall back to NOTHING', () => {
    /*
     * Both halves asserted. A guard that falls back to something ELSE wide would pass the case above while
     * changing nothing, and the two call sites are one rule written twice — which is the shape this codebase
     * gets wrong most, so they share the constant rather than each spelling out a narrow default.
     */
    const src = code(TOKENS_API);
    const guards = (src.match(/req\.authToken \? migrateToken\(req\.authToken\) : NO_RIGHTS/g) ?? []).length;
    assert.equal(guards, 2, `expected both call sites to guard, found ${guards}`);
    assert.match(src, /const NO_RIGHTS = \{[^}]*floor: null/,
      'NO_RIGHTS must have no floor — a floor is every space, including spaces created later');
    assert.match(src, /instanceAdmin: false/, 'and no instance admin');
    assert.match(src, /createSpaces: false/, 'and no space creation');
  });

  it('NO_RIGHTS is declared ONCE, not written out per call site', () => {
    // Two narrow defaults spelled separately is how one of them comes to be less narrow.
    const src = code(TOKENS_API);
    assert.equal((src.match(/const NO_RIGHTS =/g) ?? []).length, 1);
  });
});
