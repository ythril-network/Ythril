/**
 * Every token record that can reach a handler carries a rights matrix, and a record without one reaches
 * NOTHING rather than everything.
 *
 * ## The default that was the wrong way round
 *
 * "Which spaces may this token see" had two implementations: the rights matrix, and the pre-3.0 `spaces`
 * allowlist as a fallback for a record that had no matrix. The fallback's own rule was carefully written —
 * an ABSENT allowlist is every space, an EMPTY one is none, never length-as-truthiness — and it was correct
 * for the legacy field it was reading.
 *
 * Put the two together and the composite answer was **fail-open**: no matrix AND no allowlist returned every
 * space in the instance. `spacesWhereTokenMay` did it explicitly, and `middleware.ts` did it twice more.
 * That is defensible for a legacy token, whose absent allowlist genuinely meant "unrestricted" — and it is
 * not defensible as the answer to "this record has no scope information at all", which is what it had become.
 *
 * ## Why the fallback is unreachable, established rather than assumed
 *
 * There is exactly ONE place a record is attached to a request — `attachToken`, fed by `resolveAuthOrFail`,
 * fed by `resolveBearer` — and `resolveBearer` has two branches:
 *
 *  - **PAT.** `createToken` always writes a matrix, and `migrateTokenRightsOnBoot` derives one IN MEMORY for
 *    any stored record that lacks it. The in-memory half is what matters here: it mutates the same config
 *    object `findMatchingToken` reads, so a pre-matrix token on disk still arrives with a matrix.
 *  - **OIDC.** `validateOidcJwt` derives one per request through the same `migrateToken` the migration uses,
 *    which is the fix that closed a hole where OIDC connections were governed by the old booleans while PATs
 *    were enforced per space.
 *
 * So a record with no matrix cannot reach a handler. This file asserts each of those three facts, because
 * "cannot happen" is worth exactly as much as the thing that stops it happening — and then asserts that if
 * one ever did, the answer is no spaces rather than all of them.
 *
 * ## What this is NOT
 *
 * Not the removal of the legacy FIELDS. `admin`, `readOnly` and `spaces` are still on the record type, still
 * written by `createToken` and the OIDC mapping, and still returned by the tokens API; deleting them is a
 * separate job that produced 55 type errors across 14 files when measured. What goes here is their last use
 * as a SCOPING INPUT — the second implementation of the reach rule.
 *
 * Run: node --test testing/standalone/a-token-without-a-matrix-reaches-nothing.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/*
 * The config is written and `CONFIG_PATH` set at MODULE scope, before anything imports the loader.
 *
 * `CONFIG_PATH` is read when `config/loader.js` is first evaluated, and `auth/reachable-spaces.js` imports
 * it — so setting the variable inside a later `before` has no effect, and `loadConfig()` then throws and
 * CANCELS the block rather than failing it. A cancelled block reports `fail 0`, which reads as a pass at a
 * glance. Same trap the removed-env-var suite records.
 */
const cfgDir = mkdtempSync(join(tmpdir(), 'ythril-reach-'));
const CFG = join(cfgDir, 'config.json');
process.env['CONFIG_PATH'] = CFG;
writeFileSync(CFG, JSON.stringify({
  instanceId: 'reach-test', instanceLabel: 'test', tokens: [], networks: [],
  spaces: [
    { id: 'alpha', label: 'Alpha', builtIn: true, folders: [] },
    { id: 'beta', label: 'Beta', folders: [] },
  ],
}, null, 2), { mode: 0o600 });

const MIDDLEWARE = 'server/src/auth/middleware.ts';
const REACH = 'server/src/auth/reachable-spaces.ts';

describe('a record cannot reach a handler without a matrix', () => {
  it('there is exactly ONE place a record is attached to a request', () => {
    /*
     * The whole argument rests on this. Two attachment points and the second one is where a record with no
     * matrix gets in — which is the shape of the OIDC hole that was closed in 3.0, one surface out.
     */
    const s = src(MIDDLEWARE);
    const assigns = [...s.matchAll(/req\.authToken\s*=/g)].length;
    assert.equal(assigns, 1, `req.authToken is assigned ${assigns} times — every record must come through one door`);
  });

  it('and one place a bearer is resolved into one, with two branches', () => {
    const s = src(MIDDLEWARE);
    const at = s.indexOf('async function resolveBearer(');
    assert.notEqual(at, -1, 'resolveBearer is gone — this gate is reading the wrong thing');
    const fn = s.slice(at, s.indexOf('\n}', at));
    assert.match(fn, /isPat\(bearer\)/, 'the PAT branch');
    assert.match(fn, /validateOidcJwt\(bearer\)/, 'the OIDC branch');
    // A third source of records would need its own proof that it attaches a matrix.
    const returns = [...fn.matchAll(/return\s+/g)].length;
    assert.ok(returns <= 4, `resolveBearer has ${returns} returns — a new record source needs a row in this gate`);
  });

  it('the PAT branch: createToken writes a matrix, and the boot backfill covers what is stored', () => {
    assert.match(src('server/src/auth/tokens.ts'), /rights/,
      'createToken must write a rights matrix for every token it mints');
    assert.match(src('server/src/config/loader.ts'), /migrateTokenRightsOnBoot\(_config\)/,
      'the in-memory backfill must still run at boot — it is what makes a pre-matrix token on disk arrive '
      + 'with one');
  });

  it('the OIDC branch: a matrix is derived per request, from the same migration', () => {
    const s = src('server/src/auth/oidc.ts');
    assert.match(s, /rights:\s*migrateToken\(/,
      'the OIDC record must derive its matrix through migrateToken — hand-rolling it is what granted whole '
      + 'instances when it was got wrong before');
  });
});

describe('and if one ever did, it reaches nothing', () => {
  let spacesWhereTokenMay;
  before(async () => {
    ({ spacesWhereTokenMay } = await import('../../server/dist/auth/reachable-spaces.js'));
  });

  it('an absent matrix answers NO spaces, not every space', () => {
    /*
     * The default that was the wrong way round. This used to fall through to the legacy allowlist, and an
     * absent allowlist meant "unrestricted" — so a record carrying neither piece of scope information
     * reached everything in the instance.
     */
    assert.deepEqual(spacesWhereTokenMay(undefined, 'dataQuality', 'read'), [],
      'a record with no matrix must reach nothing — the answer to "no scope information" is none, not all');
  });

  it('and the source says so, rather than arriving there by accident', () => {
    const s = src(REACH);
    assert.doesNotMatch(s, /legacySpaces/,
      'the legacy allowlist must no longer be a scoping input — it was the second implementation of this rule');
    assert.match(s, /if \(!rights\) return \[\]/,
      'the absent-matrix case must be an explicit, fail-closed return');
  });

  it('no caller threads a legacy allowlist into the reach rule any more', () => {
    /*
     * Eight call sites passed one. Each was dead — and each was a place the fail-open composite could be
     * reached from if the assumption above ever broke.
     *
     * **Swept, not named.** This listed six files, and the claim in the title is about every caller: a
     * seventh route calling the reach rule with a legacy allowlist would be exactly the one nobody had
     * thought about, and a name list cannot see it. The scope is now every server source that calls the
     * rule, plus the two auth modules that thread scope into it.
     */
    const callers = trackedSources('server/src')
      .filter(f => /spacesWhereTokenMay\(|legacySpacesOf\(/.test(src(f)));
    assert.ok(callers.length >= 4,
      `only ${callers.length} caller(s) of the reach rule found — the sweep is wrong, and an empty one `
      + 'reports every caller clean');
    const offenders = [];
    for (const f of [...new Set([...callers, MIDDLEWARE, 'server/src/auth/proxy-reach.ts'])]) {
      const s = src(f);
      if (/legacySpacesOf\(/.test(s)) offenders.push(`${f}: passes a legacy allowlist`);
      if (/spacesWhereTokenMay\([^)]*\?\.spaces/.test(s)) offenders.push(`${f}: passes record.spaces`);
    }
    assert.deepEqual(offenders, [], `${offenders.join('\n  ')}`);
  });

  it('the helper module that existed only to read the field is gone', () => {
    let present = true;
    try { readFileSync('server/src/auth/legacy-spaces.ts', 'utf8'); } catch { present = false; }
    assert.equal(present, false,
      'auth/legacy-spaces.ts still exists — it wrapped the legacy allowlist for the scoping callers, and a '
      + 'helper with no callers gets callers by accident');
  });
});

describe('the matrix itself still answers what it always did', () => {
  /*
   * A real config, because the matrix arm reads `getConfig().spaces` and the fail-closed arm returns before
   * it does. Without one, "reaches nothing" would pass for both the right reason and the wrong one — a
   * helper that threw on every input satisfies every assertion in the block above.
   */
  let spacesWhereTokenMay;
  before(async () => {
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ spacesWhereTokenMay } = await import('../../server/dist/auth/reachable-spaces.js'));
  });

  it('a matrix is still consulted per space and per rung', () => {
    /*
     * The inverse of everything above: fail-closed is also what you get by breaking the helper, so the
     * matrix arm has to be exercised or "reaches nothing" would pass for the wrong reason.
     */
    // Through `holdsRung`, which is where that pair of calls moved at 5.0 — it had four longhand sites
    // and both arguments are strings, so the wrong order would have compiled and passed. The rule is that
    // the matrix is read per space and area and compared against the rung asked for; WHERE that happens is
    // an implementation detail, so the assertion follows it instead of pinning the old spelling.
    const s = src(REACH);
    assert.match(s, /holdsRung\(rights, id, area, needs\)/,
      'the per-space listing must ask the shared predicate');
    assert.match(s, /satisfies\(effectiveRung\(rights, space, area\), needs\)/,
      'and that predicate must read the matrix per space and area, compared against the rung needed');
  });

  it('a matrix that grants one space reaches that space and no other', () => {
    // The arm that has to keep working. Granted per space, so the answer is a SUBSET and not everything.
    const rights = { instanceAdmin: false, createSpaces: false, floor: null,
      perSpace: { alpha: { dataQuality: 'read' } } };
    assert.deepEqual(spacesWhereTokenMay(rights, 'dataQuality', 'read'), ['alpha']);
  });

  it('a matrix granting a lower rung than needed reaches nothing', () => {
    // And the rung is compared, not merely present — otherwise "has a matrix" would be the whole test.
    const rights = { instanceAdmin: false, createSpaces: false, floor: null,
      perSpace: { alpha: { dataQuality: 'read' } } };
    assert.deepEqual(spacesWhereTokenMay(rights, 'dataQuality', 'write'), []);
  });

  it('a floor grants every space, including one the matrix never names', () => {
    const rights = { instanceAdmin: false, createSpaces: false,
      floor: { dataQuality: 'read' }, perSpace: {} };
    assert.deepEqual(spacesWhereTokenMay(rights, 'dataQuality', 'read').sort(), ['alpha', 'beta']);
  });
});
