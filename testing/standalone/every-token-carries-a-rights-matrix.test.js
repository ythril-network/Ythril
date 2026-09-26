/**
 * Every token carries a rights matrix — at mint, not only after a restart.
 *
 * ## The hole this closes, measured
 *
 * `enforceAreaRung` returns `true` when a record has no `rights`, so the per-space rung is not checked at all for
 * such a token. The load-time backfill derived a matrix for every token in the config — but only for the tokens
 * that were already there. A token minted afterwards had none until the next boot.
 *
 * Probed against a running instance on 2026-08-13:
 *
 * | token | `DELETE /api/brain/spaces/general/facts/:id` |
 * |---|---|
 * | minted with an explicit `rights` matrix (`knowledge: write`) | **403** `Token needs 'admin' on knowledge…` |
 * | minted with no rights at all | **204** — the rung was never consulted |
 *
 * Owner ruling, 2026-08-13: *"translate old tokens into matrix rights and overwrite on update. only matrix from
 * now on."*
 *
 * ## What this gate holds, and why by source
 *
 * The behaviour needs a running server and a config write, which the integration suite covers. What this gate
 * pins is cheaper and catches the regression that actually happened: the code paths that can produce a token
 * must all produce a matrix, and nothing may edit the legacy fields afterwards.
 *
 * Run: node --test testing/standalone/every-token-carries-a-rights-matrix.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const read = p => stripComments(readFileSync(p, 'utf8'));
const TOKENS = 'server/src/auth/tokens.ts';
// The boot step moved out of the loader when persisting it pushed that file past its god-file freeze.
const BOOT = 'server/src/auth/backfill-token-rights.ts';

describe('a minted token has a matrix', () => {
  const src = read(TOKENS);

  it('createToken derives one when the caller did not supply it', () => {
    // NOT `...(opts.rights ? {rights} : {})` — that spread is what left a new token matrix-less until the next
    // boot, and the rung silently unenforced in the meantime.
    assert.match(src, /rights: opts\.rights \?\? \(migrateToken\(\{/,
      'createToken must fall back to a derived matrix rather than omitting the field');
    assert.ok(!/\.\.\.\(opts\.rights \? \{ rights: opts\.rights \} : \{\}\)/.test(src),
      'the conditional spread is back — a token minted without explicit rights would carry no matrix');
  });

  it('the derivation is the shared one, not a second opinion', () => {
    // `migrateToken` is the single translation from legacy fields. A local re-implementation would be the
    // two-implementations-of-one-rule defect this repo produces most.
    assert.match(src, /import \{ migrateToken \} from '\.\/rights-migration\.js'/);
  });
});

/*
 * ── THIS SUITE ASSERTED THE OPPOSITE, AND WAS SATISFIED BY A CALL THAT ALWAYS THREW ──────────────
 *
 * It read the source for `persist(config)` and for the words *"will retry next boot"*, and both were
 * there — so it passed, for as long as it has existed, over a function that could never write anything.
 * `defaultSave` reached for `require('../config/loader.js')` and `server/package.json` is
 * `"type": "module"`, so the call threw on every boot and the surrounding catch logged the very sentence
 * this gate was matching on. A source-reading gate asserting an OUTCOME rather than a shape is only ever
 * asserting intent.
 *
 * And the intent was wrong. `loadConfig` states the decision, with its reason: *"IN MEMORY ONLY, and
 * deliberately not persisted: enforcement still reads the legacy fields, so this run is an observation
 * rather than a change."* That reason is still true — `spaces` is still the scoping input in ten modules
 * (`_DEPRECATIONS.md` row 1.7) — so persisting the derivation now would make a derivation defect durable
 * before anything had compared it against the behaviour it reproduces.
 *
 * Three other places already said in-memory-only. This was the one that disagreed, and it disagreed with
 * observable reality as well as with the other three.
 */
describe('the boot migration derives in memory and writes nothing', () => {
  const src = read(BOOT);

  it('it still runs, and still on both counts', () => {
    // The half that was right and stays: the step does two things — derive a missing matrix and repair a
    // malformed one — and `if (filled === 0)` alone would skip a repair.
    const after = bodyOf(src, 'migrateTokenRightsOnBoot');
    assert.match(after, /if \(filled === 0 && repaired === 0\) return 0;/,
      'the step no longer short-circuits on both counts, so a repair can be skipped');
    assert.match(read('server/src/config/loader.ts'), /migrateTokenRightsOnBoot\(_config\)/,
      'the loader no longer calls it, so a token with no matrix reaches nothing');
  });

  it('and it has no way to write, not merely no working one', () => {
    /*
     * Absence is the assertion. "The save is broken" was the state this was written from; "there is no
     * save" is the state the design describes, and it is the only version a reader cannot undo by
     * fixing what looks like an unrelated error.
     */
    const after = bodyOf(src, 'migrateTokenRightsOnBoot');
    assert.doesNotMatch(after, /persist\(|saveConfig|defaultSave/,
      'the derivation writes, or tries to — `D-2` is where persistence arrives, after the scoping is '
      + 'unified and the matrix is shown to reproduce the enforcement it replaces');
    assert.doesNotMatch(after, /will retry next boot/i,
      'it still promises a retry of a write it no longer attempts');
  });
});

describe('nothing edits the legacy fields after mint', () => {
  it('the legacy-allowlist writer is gone, not merely unused', () => {
    // `updateTokenSpaces` had zero callers and its whole job was editing `spaces` — the field the matrix
    // replaces. Kept around, it is the obvious thing for a future caller to reach for, and it would put the two
    // descriptions of access back out of step.
    // `git grep` exits 1 with no output when nothing matches, and does not see this file until it is tracked —
    // so both "no hits" and "only this file" are the healthy answers, and anything else is a real reference.
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-l', 'updateTokenSpaces', '--', 'server/src', 'client/src', 'testing'],
        { encoding: 'utf8', cwd: process.cwd() }).trim();
    } catch { /* exit 1 = no matches */ }
    const others = hits.split('\n').map(l => l.trim().replace(/\\/g, '/')).filter(Boolean)
      .filter(f => !f.endsWith('every-token-carries-a-rights-matrix.test.js'));
    assert.deepEqual(others, [], `updateTokenSpaces is referenced again by: ${others.join(', ')}`);
  });

  it('rights are replaced wholesale, never merged', () => {
    // A merge would let a caller widen one area while believing they had described the whole token.
    const src = read(TOKENS);
    // Through `withInstanceAdminGrants` (S-11): it returns the whole rights object with the instance-admin grant
    // applied, so the assignment is still wholesale.
    assert.match(src, /config\.tokens\[idx\]!\.rights = (withInstanceAdminGrants\(rights\)|rights);/,
      'setTokenRights must assign, not merge');
  });
});
