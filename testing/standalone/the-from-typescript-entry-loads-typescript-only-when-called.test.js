/**
 * The schema package's from-typescript entry loads the TypeScript compiler only when it is called, from the caller's own install, and says what to
 * install when it cannot (Q-687, design v3 items 2 and 3; the lenses: testing S1 and S5, security S6, reliability).
 *
 * ## The rule held
 *
 * The schema package depends on no compiler: `typescript` is an OPTIONAL peer (`>=5.4`, no ceiling, so an app on 7 still installs the package) that only
 * the one entry reads. So:
 *
 * - **The main entry never loads it.** `dist/index.js` and `dist/internal.js` import, and run the converter and the validator, without
 *   one request for `typescript`. Held in a child whose resolve hook reports every request and refuses it, with a TRIPWIRE in the same
 *   child: a direct `import('typescript')` sees the hook's error, and the entry, imported and called, rejects naming the install. A hook
 *   that never fired would make "never asked" true of anything.
 * - **Without the compiler the call rejects, naming the fix.** One Error that names `npm install typescript@6` and the `typescript`
 *   option; a module with no `createProgram` (TS 7, whose API is another package's) says the same and also names the alias install that
 *   keeps the app's own 7 (`npm install typescript-6@npm:typescript@6`); every other load error is rethrown as it is.
 * - **A source over SOURCE_MAX is refused before the compiler loads.** The child sees no request.
 * - **An injected compiler is used and never memoised.** The option beats whatever the entry loaded for itself, and it is never
 *   kept as the default.
 * - **A rejection is not memoised, and the import is.** Two concurrent first calls share one in-flight import (one request, both
 *   rejected); a later call, after the install, loads and reads.
 *
 * Before the entry exists every case is red for the one reason the first case names (the entry is not built).
 *
 * Run: node --test testing/standalone/the-from-typescript-entry-loads-typescript-only-when-called.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { entry, read, CONTROL_SOURCE, assertRead, countingCompiler } from './_from-typescript.mjs';

const CHILD = fileURLToPath(new URL('./_from-typescript-boot-child.mjs', import.meta.url));

/** One child run of a scenario, cached: the child prints one JSON line. */
const runs = new Map();
function child(scenario) {
  if (!runs.has(scenario)) {
    const r = spawnSync(process.execPath, [CHILD, JSON.stringify({ scenario })], { encoding: 'utf8', timeout: 90_000, env: testChildEnv() });
    const line = r.stdout.trim().split('\n').filter(Boolean).at(-1);
    assert.ok(line, `the ${scenario} child printed nothing (exit ${r.status}): ${r.stderr.slice(0, 1200)}`);
    const out = JSON.parse(line);
    assert.equal(out.importFailed, undefined, `the ${scenario} child imports schema/dist/from-typescript.js: ${out.importFailed?.message}`);
    runs.set(scenario, out);
  }
  return runs.get(scenario);
}

/** The Error every "cannot use a compiler" path rejects with: one message, naming the install and the option. */
function assertInstallError(rejected, why) {
  assert.ok(rejected, `${why}: expected a rejection`);
  assert.equal(rejected.isError ?? rejected instanceof Error, true, `${why}: rejects with an Error`);
  const message = rejected.message;
  assert.ok(message.includes('npm install typescript@6'), `${why}: names "npm install typescript@6", got: ${message}`);
  assert.match(message, /`typescript` option|typescript option|options\.typescript/i, `${why}: names the typescript option, got: ${message}`);
}

/** The Error for a loaded typescript with no compiler API: the install error, plus the alias install that keeps the app's own typescript. */
function assertNoCompilerApiError(rejected, why) {
  assertInstallError(rejected, why);
  assert.ok(rejected.message.includes('npm install typescript-6@npm:typescript@6'), `${why}: names the alias install, got: ${rejected.message}`);
}

describe('the entry is built', () => {
  it('schema/dist/from-typescript.js exists and exports the names these tests read', async () => {
    await entry();
  });
});

describe('the main entry never loads typescript', () => {
  it('index.js and internal.js, imported and run, make no request for typescript; the tripwires in the same child fire', () => {
    const out = child('main-entry');
    assert.equal(out.askedByMainEntry, 0, 'importing the main entries and running typesOfSpaceMeta and validateSpaceMeta asked for typescript');
    assert.equal(out.tripwireDirect.code, 'ERR_MODULE_NOT_FOUND', 'tripwire: a direct import of typescript sees the hook (the hook is live)');
    assert.match(out.tripwireDirect.message, /refused by the test hook/);
    assert.equal(out.entry.importFailed, undefined, `tripwire: the entry imports in the same child (${out.entry.importFailed?.message})`);
    assertInstallError(out.entry.rejected, 'tripwire: the entry, called in the same child, sees the hook\'s refusal and names the install');
  });
});

describe('without the compiler the entry rejects, naming the install', () => {
  it('a typescript that cannot be found rejects with one Error naming npm install typescript@6 and the typescript option, after one request', () => {
    const out = child('missing');
    assertInstallError(out.answer.rejected, 'typescript not found');
    assert.equal(out.asked, 1, 'one request for typescript');
  });

  it('a module with a default export and no createProgram (TS 7 shaped) names typescript@6', () => {
    assertNoCompilerApiError(child('ts7').answer.rejected, 'a TS-7-shaped default export');
  });

  it('a module with only named exports and no createProgram names typescript@6', () => {
    assertNoCompilerApiError(child('ts7-named').answer.rejected, 'a TS-7-shaped namespace');
  });

  it('every other load error is rethrown as it is, never taken for a missing install', () => {
    const { rejected } = child('other-error').answer;
    assert.ok(rejected, 'the load error rejects');
    assert.equal(rejected.code, 'EIO');
    assert.match(rejected.message, /the disk is on fire/);
    assert.ok(!rejected.message.includes('npm install'), 'not dressed as a missing install');
  });

  it('a source over SOURCE_MAX is refused source-too-large before the compiler loads: no request for typescript', () => {
    const out = child('too-large');
    assert.equal(out.answer.rejected, undefined, `the size refusal does not need the compiler: ${JSON.stringify(out.answer.rejected)}`);
    assert.equal(out.answer.resolved.ok, false);
    assert.ok(out.answer.resolved.reasons.includes('source-too-large'));
    assert.equal(out.asked, 0, 'the compiler was asked for before the size was checked');
  });
});

describe('a rejection is not memoised, and the import is', () => {
  it('two concurrent first calls share one import (one request, both rejected); a later call loads the compiler and reads', () => {
    const out = child('fail-then-succeed');
    for (const [i, c] of out.concurrent.entries()) assertInstallError(c.rejected, `concurrent call ${i + 1}`);
    assert.equal(out.askedAfterConcurrent, 1, 'two concurrent calls made one request: the import is memoised while in flight');
    assert.equal(out.third.rejected, undefined, `the later call is not served the earlier rejection: ${JSON.stringify(out.third.rejected)}`);
    assert.equal(out.third.ok, true, 'the later call reads');
    assert.equal(out.askedAfterThird, 1, 'the later call asked again: the rejection was not kept');
  });

  it('with nothing in the way the entry loads typescript itself and reads', () => {
    const out = child('default-load');
    assert.equal(out.answer.rejected, undefined, JSON.stringify(out.answer.rejected));
    assert.equal(out.answer.resolved.ok, true);
    assert.equal(out.asked, 1);
  });
});

describe('an injected typescript option', () => {
  it('is used for the compile, and a module the entry loaded for itself does not replace it', async () => {
    assertRead(await read(CONTROL_SOURCE), 'the default compiler reads the control source (loads and memoises the entry\'s own)');
    const first = countingCompiler();
    const second = countingCompiler();
    assertRead(await read(CONTROL_SOURCE, { typescript: first.compiler }), 'injected compiler one');
    assertRead(await read(CONTROL_SOURCE, { typescript: second.compiler }), 'injected compiler two');
    assert.equal(first.state.programs, 1, 'the first injected compiler built the first program');
    assert.equal(second.state.programs, 1, 'the second injected compiler built its own: the first was not memoised');
  });

  it('is never kept as the default: a call without it afterwards does not reach the injected compiler', async () => {
    const injected = countingCompiler();
    assertRead(await read(CONTROL_SOURCE, { typescript: injected.compiler }), 'injected compiler');
    assertRead(await read(CONTROL_SOURCE), 'the default compiler');
    assertRead(await read(CONTROL_SOURCE), 'the default compiler again');
    assert.equal(injected.state.programs, 1, 'a later call without the option used the injected compiler');
  });

  it('is read as m.default ?? m, so an imported module namespace works as well as the module', async () => {
    const namespace = await import('typescript');
    assert.equal(typeof namespace.default?.createProgram, 'function', 'precondition: the namespace of the CJS compiler has a default export');
    assertRead(await read(CONTROL_SOURCE, { typescript: namespace }), 'the imported namespace');
  });

  it('with no createProgram (TS 7 shaped) rejects naming typescript@6, the way a missing install does', async () => {
    for (const shaped of [{}, { version: '7.0.0' }, { default: { version: '7.0.0' } }]) {
      await assert.rejects(read(CONTROL_SOURCE, { typescript: shaped }), (error) => { assertNoCompilerApiError(error, `injected ${JSON.stringify(shaped)}`); return true; });
    }
  });
});
