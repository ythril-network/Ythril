/**
 * `callBounded` cannot be called without saying what its database inherits and where the call is going (bundle-56
 * round S, R9 part a and R8).
 *
 * ## What it prevents
 *
 * A plain write inside a hold must be sent with `timeoutMS: 0` when the CLIENT carries a `timeoutMS` (`MONGO_URI`),
 * or the driver inherits it and ends the write before the server's deadline (`Q-372`, F1). The fact "the client carries
 * one" reached `callBounded` as an OPTIONAL fourth argument, so a call site that left it out compiled, ran, passed every
 * test that does not touch a database with a `timeoutMS`, and silently put F1 back. The forgettable part was outside the
 * module; it is now a required argument, `{ collection, inheritedTimeoutMs }` (the first says where
 * the call is going, which the backstop's warning names), and omitting it is a TYPE ERROR.
 *
 * ## How it is held
 *
 * By the compiler, not by a pattern over the source: a scratch file under `node_modules/.cache/` imports the real
 * `server/src/db/write-bound.ts` and calls `callBounded` twice — once with the argument stated (it must compile with no
 * error, so that a failure of the other is the argument's and not the setup's) and once without it (it must fail with
 * `TS2554`, "expected 4 arguments"). The scratch folder is removed afterwards. Needs only the TypeScript the repo already
 * has installed; no build of the server.
 *
 * Run: node --test testing/standalone/a-write-bound-cannot-be-called-without-saying-what-it-inherits.test.js
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
export const stated = callBounded('updateOne', [], (a) => a, { collection: 'x_memories', inheritedTimeoutMs: undefined });
export const statedWithOne = callBounded('updateOne', [], (a) => a, { collection: 'x_memories', inheritedTimeoutMs: 300 });
`;
const OMITTED = `import { callBounded } from '${WRITE_BOUND}';
export const omitted = callBounded('updateOne', [], (a) => a);
`;
const HALF_STATED = `import { callBounded } from '${WRITE_BOUND}';
export const half = callBounded('updateOne', [], (a) => a, { inheritedTimeoutMs: undefined });
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

describe('callBounded states what its database inherits', () => {
  before(() => { assert.ok(existsSync(TSC), `TypeScript is not installed at ${TSC}`); mkdirSync(DIR, { recursive: true }); });
  after(() => { rmSync(DIR, { recursive: true, force: true }); });

  it('a call that states the target compiles with no error (the control: a failure below is the argument\'s, not the setup\'s)', () => {
    const r = check('stated', STATED);
    assert.equal(r.status, 0, r.out);
  });

  it('a call that leaves the target out is a type error', () => {
    const r = check('omitted', OMITTED);
    assert.notEqual(r.status, 0, 'a call to callBounded with no target compiled: the F1 neutralisation can be forgotten again');
    assert.match(r.out, /TS2554/, r.out);
  });

  it('a call that states only part of it is a type error too', () => {
    const r = check('half', HALF_STATED);
    assert.notEqual(r.status, 0, 'a target missing a field compiled');
    assert.match(r.out, /TS2345|TS2741/, r.out);
  });
});
