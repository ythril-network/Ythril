/**
 * `callBounded` cannot be called without saying where the call is going, and at which level (bundle-56 round S, R8; bundle-53 G5).
 *
 * ## What it prevents
 *
 * The target a call states is what the backstop's warning names (the collection, and the space read from its name, or the
 * database), and its SHAPE is how the bound knows which method table the call is held to: a collection's
 * (`BOUNDED_OPTIONS_ARGUMENT`) or the database's own (`BOUNDED_DB_OPTIONS_ARGUMENT`). An optional argument is how a call came
 * to leave it out, so it is required, and the level is stated by the target's shape, never defaulted.
 *
 * Until `Q-716` the target also had to state the `timeoutMS` the client inherits, so a plain write could switch it off. From
 * driver 7.8.0 a client's `timeoutMS` does nothing, and the bound uses none (`no-server-code-uses-the-drivers-client-timeout`),
 * so that half of the target is gone with the rows that held it.
 *
 * ## How it is held
 *
 * By the compiler, not by a pattern over the source: a scratch file under `node_modules/.cache/` imports the real
 * `server/src/db/write-bound.ts` and calls `callBounded` with the target stated (it must compile with no error, so that a
 * failure of the others is the argument's and not the setup's), without it (`TS2554`), and with a target of neither shape. The
 * scratch folder is removed afterwards. Needs only the TypeScript the repo already has installed; no build of the server.
 *
 * Run: node --test testing/standalone/a-write-bound-cannot-be-called-without-saying-where-it-goes.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './_sources.mjs';

const DIR = join(REPO_ROOT, 'node_modules', '.cache', 'call-bounded-typecheck');
const TSC = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const WRITE_BOUND = '../../../server/src/db/write-bound.js';

const STATED = `import { callBounded } from '${WRITE_BOUND}';
export const stated = callBounded('updateOne', [], (a) => a, { collection: 'x_memories' });
`;
const OMITTED = `import { callBounded } from '${WRITE_BOUND}';
export const omitted = callBounded('updateOne', [], (a) => a);
`;
// A Db-level call states its LEVEL in the target (`database`), never as a defaulted extra parameter (bundle-53 G5): a call
// that says neither a collection nor a database does not compile.
const DB_STATED = `import { callBounded } from '${WRITE_BOUND}';
export const dbStated = callBounded('dropCollection', [], (a) => a, { database: 'ythril' });
`;
const NO_LEVEL = `import { callBounded } from '${WRITE_BOUND}';
export const noLevel = callBounded('dropCollection', [], (a) => a, {});
`;

function check(name, source) {
  const file = join(DIR, `${name}.ts`);
  writeFileSync(file, source);
  writeFileSync(join(DIR, `${name}.tsconfig.json`), JSON.stringify({
    extends: '../../../tsconfig.base.json',
    compilerOptions: { noEmit: true, declaration: false, declarationMap: false, sourceMap: false },
    files: [`${name}.ts`],
  }));
  const r = spawnSync(process.execPath, [TSC, '-p', join(DIR, `${name}.tsconfig.json`)], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 180_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

describe('callBounded states where the call is going', () => {
  before(() => { assert.ok(existsSync(TSC), `TypeScript is not installed at ${TSC}`); mkdirSync(DIR, { recursive: true }); });
  after(() => { rmSync(DIR, { recursive: true, force: true }); });

  it('a call that states the target compiles with no error (the control: a failure below is the argument\'s, not the setup\'s)', () => {
    const r = check('stated', STATED);
    assert.equal(r.status, 0, r.out);
  });

  it('a call that leaves the target out is a type error', () => {
    const r = check('omitted', OMITTED);
    assert.notEqual(r.status, 0, 'a call to callBounded with no target compiled: the backstop\'s warning would name nothing');
    assert.match(r.out, /TS2554/, r.out);
  });

  it('a Db-level call states its database and compiles (the control for the row below)', () => {
    const r = check('dbstated', DB_STATED);
    assert.equal(r.status, 0, r.out);
  });

  it('a target that states neither a collection nor a database is a type error: the level is never defaulted', () => {
    const r = check('nolevel', NO_LEVEL);
    assert.notEqual(r.status, 0, 'a target with no level compiled');
    assert.match(r.out, /TS2345|TS2741/, r.out);
  });
});
