/**
 * `enforceAdmin` — the one function behind every admin route — now asks the rights matrix.
 *
 * ## The change this is, and the change it is not
 *
 * It reads `rights.instanceAdmin`, falling back to the legacy `admin` boolean only for a record that carries
 * no matrix. That fallback is not decoration: an OIDC session is built per request from the identity and
 * legitimately has none, while every PAT carries one — `createToken` always writes it and a boot migration
 * backfills the rest.
 *
 * **No token's access changes.** The two provably answer the same question, which is what the previous PR
 * established over all nine storable legacy shapes, and the mint route refuses `admin` as an input so a
 * divergent pair cannot be created. This is the switch that evidence existed for.
 *
 * ## Why one predicate rather than five
 *
 * `record.admin` was read directly at five decision sites: this guard, the space-admin guard, the scoped
 * guard, the peer-relay check in `notify`, the trusted-relay check in `sync/tombstones`, the `maxGiB`
 * carve-out, and the last-admin lockout guard. Five copies of one authorization question, and the failure
 * mode of a copy that drifts is the worst available — a token reaching a route it never could, silently.
 *
 * They all call `isInstanceAdmin` now. That is also what makes the field deletion mechanical rather than a
 * hunt.
 *
 * Run: node --test testing/standalone/enforce-admin-reads-the-matrix.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

let isInstanceAdmin, migrateToken;
before(async () => {
  ({ isInstanceAdmin } = await import('../../server/dist/auth/middleware.js'));
  ({ migrateToken } = await import('../../server/dist/auth/rights-migration.js'));
});

const rights = (over = {}) => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace: {}, ...over });

describe('the predicate reads the matrix first', () => {
  it('a matrix saying instanceAdmin is an admin', () => {
    assert.equal(isInstanceAdmin({ rights: rights({ instanceAdmin: true }) }), true);
  });

  it('a matrix saying otherwise is NOT — even with the legacy flag set', () => {
    // The direction that matters. If a record ever carries a stale `admin: true` beside a matrix that says
    // no, the matrix wins — otherwise the deprecated field would still be granting access.
    assert.equal(isInstanceAdmin({ admin: true, rights: rights({ instanceAdmin: false }) }), false);
  });

  it('and a matrix saying yes wins over a legacy flag saying no', () => {
    assert.equal(isInstanceAdmin({ admin: false, rights: rights({ instanceAdmin: true }) }), true);
  });

  it('a record with NO matrix falls back to the legacy flag', () => {
    // OIDC sessions are built per request and legitimately carry no matrix. Refusing them here would be a
    // silent narrowing — the opposite failure, and just as bad.
    assert.equal(isInstanceAdmin({ admin: true }), true);
    assert.equal(isInstanceAdmin({ admin: false }), false);
    assert.equal(isInstanceAdmin({}), false);
  });

  it('and an admin rung on every space is still NOT an instance admin', () => {
    // The distinction SA-1 rests on: administering every space that exists today says nothing about spaces
    // created tomorrow, nor about instance-shaped routes. Only `instanceAdmin` or a floor does.
    const everySpace = rights({ perSpace: { a: allAdmin(), b: allAdmin() } });
    assert.equal(isInstanceAdmin({ rights: everySpace }), false);
  });

  const allAdmin = () => ({ knowledge: 'admin', files: 'admin', schema: 'admin', dataQuality: 'admin' });
});

describe('it agrees with the migration for every legacy shape', () => {
  // The same nine shapes the evidence PR checked, now asserted through the PREDICATE rather than through
  // `migrateToken` alone — so the guard and the migration cannot drift apart either.
  for (const [label, legacy] of [
    ['plain write', {}],
    ['plain write, scoped', { spaces: ['qa'] }],
    ['read-only', { readOnly: true }],
    ['read-only, scoped', { readOnly: true, spaces: ['qa'] }],
    ['admin', { admin: true }],
    ['admin, scoped', { admin: true, spaces: ['qa'] }],
    ['admin AND read-only', { admin: true, readOnly: true }],
    ['empty allowlist', { spaces: [] }],
    ['schema-library', { schemaLibrary: true, spaces: [] }],
  ]) {
    it(label, () => {
      const migrated = { admin: legacy.admin === true, rights: migrateToken(legacy) };
      assert.equal(isInstanceAdmin(migrated), legacy.admin === true && !legacy.schemaLibrary,
        'the guard must answer what the legacy flag answered, for every storable shape');
    });
  }
});

describe('every decision site asks the one predicate', () => {
  it('the three guards in middleware.ts', () => {
    const mw = src('server/src/auth/middleware.ts');
    assert.doesNotMatch(mw, /if \(!record\.admin\)/, 'no guard may read the legacy field directly');
    assert.doesNotMatch(mw, /if \(record\.admin\) return true;/, 'nor the space-admin one');
    assert.match(mw, /isInstanceAdmin\(record\)/, 'all of them go through the predicate');
  });

  it('and the four outside it', () => {
    // Each of these was a separate copy of "is this an instance admin", and each would have had to be found
    // by hand when the field is deleted.
    for (const [f, what] of [
      ['server/src/api/notify.ts', 'the peer-relay check'],
      ['server/src/api/sync/tombstones.ts', 'the trusted-relay check'],
      ['server/src/api/spaces.ts', 'the maxGiB carve-out'],
      ['server/src/api/tokens.ts', 'the last-admin lockout guard'],
    ]) {
      assert.match(src(f), /isInstanceAdmin\(/, `${what} in ${f} must ask the predicate`);
    }
  });

  /**
   * Where the legacy flag may legitimately be touched, with the reason on each row.
   *
   * An exemption list is what this repository has a rule against, so two things keep it honest: the FILE SET
   * it is applied to is derived rather than named, and a row that stops matching FAILS below. A stale
   * exemption is how a page goes unchecked for weeks while every run reports clean.
   */
  const MAY_READ_IT = new Map([
    ['server/src/auth/instance-admin.ts', 'the predicate itself — this is where the fallback lives'],
    ['server/src/auth/rights-migration.ts', 'reads the legacy token to BUILD the matrix, which is its whole job'],
    ['server/src/auth/oidc.ts', 'maps a CLAIM to the flag; the flag is produced here rather than consumed'],
    ['server/src/mcp/oauth.ts', 'logs the flag on a minted identity — a log line, not a decision'],
    ['server/src/auth/tokens.ts', 'the create route, where the flag is written onto a NEW token from its options'],
  ]);

  it('nothing else reads the legacy admin flag to make an authorization decision', () => {
    /*
     * **DERIVED, because the title claims the whole server and the body read ONE file.** `middleware.ts` was
     * where the seven copies happened to be found; every other module was outside everything this gate
     * looked at while the sentence went on covering all of them (`Q-6`, 2026-09-07).
     *
     * The pattern excludes `.admin(` — `db.admin()` is the Mongo driver and has nothing to do with tokens —
     * and `admin:` , which is an object KEY rather than a read.
     */
    const files = execFileSync('git', ['ls-files', 'server/src'], { maxBuffer: 32 * 1024 * 1024 })
      .toString('utf8').split('\n').filter(f => f.endsWith('.ts'));
    assert.ok(files.length > 100, `only ${files.length} server sources found; the listing is broken`);

    /*
     * `tool.admin` is EXCLUDED, and it is not a near-miss — it is a different fact with the same spelling.
     * A tool's `admin` says *this tool requires an administrator*; a token's says *this caller is one*. The
     * first sweep flagged `mcp/router.ts` and `mcp/tool-visibility.ts` on it, and exempting those two files
     * by name would have blinded the gate to a real token read appearing in either of them later.
     *
     * `.admin(` is out too — `db.admin()` is the Mongo driver — and `admin:` is an object KEY, not a read.
     */
    const READS_IT = /(?<!tool)\.admin\s*(?![(:])/;
    const readers = files.filter(f => READS_IT.test(src(f)));

    // A stale exemption fails. If a file stopped reading the flag, its row is a claim about code that no
    // longer exists, and the next person to add a read there inherits a pass nobody granted.
    const dead = [...MAY_READ_IT.keys()].filter(f => !readers.includes(f));
    assert.deepEqual(dead, [],
      `${dead.join(', ')} is exempted here and no longer reads the flag at all. Delete the row: an exemption `
      + 'nobody re-reads is how a file goes unchecked while every run reports clean.');

    const offenders = readers.filter(f => !MAY_READ_IT.has(f));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} reads the legacy admin flag directly. Ask isInstanceAdmin() instead — it `
      + 'consults the rights matrix and falls back to the flag, and a copy that drifts means a token '
      + 'reaching a route it never could, with nothing in the response to say so.');
  });
});
