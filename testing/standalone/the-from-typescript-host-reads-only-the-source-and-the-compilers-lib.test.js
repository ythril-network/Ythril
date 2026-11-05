/**
 * The compile `@ythril/schema/from-typescript` runs is closed: its host serves the source it was given and the compiler's own lib files,
 * and nothing else on the machine (Q-687, design v3 items 4 and 5; D-70, decision 19: the schema package imports no file of an app's,
 * and the entry's one file access is the lib; the lens: security S1).
 *
 * ## The rule held
 *
 * - **Only the lib is read.** Lib text comes through the loaded module's own `sys.readFile`, for exact `lib.*.d.ts` names inside the
 *   directory the module's `getDefaultLibFilePath` names. Held with a RECORDING fake `sys` (a Proxy over the real one) that allows only
 *   those paths and FAILS on any other file-system call, with a floor on how many lib files were read (a fake that was never asked
 *   would pass).
 * - **Any other path is answered absent, without a read.** The test's compiler hands the entry's host a list of paths that reach for
 *   something else (an absolute path, a `..` out of the lib directory, a subdirectory, a sibling directory with the lib's prefix, a
 *   name that only looks like a lib file) and the host says no to each, and the fake `sys` never sees one.
 * - **The options are the closed set**: strict, noEmit, `types: []`, noResolve, `lib: ['lib.es2022.d.ts']`, skipLibCheck, and
 *   `libReplacement: false` (5.4's option, why the peer's floor is 5.4: without it a package could answer a lib name).
 * - **Parsed lib files are cached per loaded module.** A second read with the same module asks `sys.readFile` for nothing; a new module
 *   starts again.
 * - **A lib that cannot be read is the environment's fault.** The call REJECTS with an Error that names the lib; it never answers a
 *   refusal, because the source is not what is wrong.
 *
 * Before the entry exists every case is red for the one reason the first case names.
 *
 * Run: node --test testing/standalone/the-from-typescript-host-reads-only-the-source-and-the-compilers-lib.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  entry, read, CONTROL_SOURCE, assertRead, recordingCompiler, isLibPath, sourceOfMeta, gardenFixtures,
} from './_from-typescript.mjs';

/** The fewest lib files lib.es2022.d.ts reaches: es5 and every edition up to 2022 with their parts (57 on TypeScript 5.9). */
const LIB_FLOOR = 30;

describe('the closed host serves the source and the lib only', () => {
  it('the entry is built', async () => {
    await entry();
  });

  it('a garden source compiles under a fake sys that allows only lib paths and fails on any other: no stray call, lib files read through the module\'s own sys', async () => {
    const plants = gardenFixtures().find(f => f.name === 'garden-plants.json');
    const fake = recordingCompiler();
    const answer = await read(sourceOfMeta(plants.meta), { typescript: fake.compiler });
    assertRead(answer, 'the garden-plants source, compiled with the recording fake');
    assert.deepEqual(fake.violations, [], 'the host reached the file system for something that is not a lib file');
    const reads = fake.libReads();
    assert.ok(reads.length >= LIB_FLOOR, `floor: at least ${LIB_FLOOR} lib files read through sys.readFile, got ${reads.length}`);
    for (const name of ['lib.es2022.d.ts', 'lib.es5.d.ts', 'lib.es2015.core.d.ts']) assert.ok(reads.includes(name), `${name} was read through the module's sys`);
    for (const call of fake.calls.filter(c => ['readFile', 'fileExists'].includes(c.method))) {
      assert.ok(isLibPath(call.path, fake.libDir), `sys.${call.method} was asked for ${call.path}, which is not an exact lib path of ${fake.libDir}`);
    }
  });

  it('compiles with the closed options: strict, noEmit, types [], noResolve, lib [lib.es2022.d.ts], skipLibCheck, libReplacement false', async () => {
    const fake = recordingCompiler();
    assertRead(await read(CONTROL_SOURCE, { typescript: fake.compiler }), 'the control source');
    assert.equal(fake.programs.length, 1, 'one program for one read');
    const { options, rootNames } = fake.programs[0];
    assert.equal(options.strict, true);
    assert.equal(options.noEmit, true);
    assert.deepEqual(options.types, []);
    assert.equal(options.noResolve, true);
    assert.deepEqual(options.lib, ['lib.es2022.d.ts']);
    assert.equal(options.skipLibCheck, true);
    assert.equal(options.libReplacement, false);
    assert.equal(rootNames.length, 1, 'the source is the one root');
  });

  it('serves the source from memory and a lib file from the module\'s sys, and answers every other path absent without a read', async () => {
    let probed = false;
    const fake = recordingCompiler({
      probe: ({ rootNames, host, compiler }) => {
        probed = true;
        const libDir = fake.libDir;
        const target = compiler.ScriptTarget.ES2022;
        // What the host serves: the source (by its root name) and exact lib names inside the lib directory.
        assert.equal(host.getSourceFile(rootNames[0], target)?.text, CONTROL_SOURCE, 'the host serves the source it was given');
        assert.equal(host.fileExists(rootNames[0]), true);
        assert.equal(host.readFile(rootNames[0]), CONTROL_SOURCE);
        assert.equal(host.fileExists(`${libDir}/lib.es5.d.ts`), true, 'an exact lib name inside the lib directory exists');
        assert.match(host.getSourceFile(`${libDir}/lib.es5.d.ts`, target)?.text ?? '', /interface Array<T>/, 'and is the compiler\'s own text');
        // What it answers absent, and the sys is never asked about.
        const escapes = [
          '/etc/passwd',
          `${libDir}/../package.json`,
          `${libDir}/../lib/lib.es5.d.ts`,
          `${libDir}/lib.es5.d.ts/../../package.json`,
          `${libDir}/sub/lib.es5.d.ts`,
          `${libDir}-evil/lib.es5.d.ts`,
          `${libDir}/lib.es5.d.ts.map`,
          `${libDir}/notlib.d.ts`,
          `${libDir}/lib.es5.json`,
          `${libDir}\\..\\package.json`,
          `${libDir}/lib.es5.d.ts\u0000.png`,
          'lib.es5.d.ts',
          './package.json',
        ];
        for (const path of escapes) {
          const shown = JSON.stringify(path);
          assert.equal(host.fileExists(path), false, `fileExists(${shown}) answers absent`);
          assert.equal(host.readFile(path), undefined, `readFile(${shown}) answers absent`);
          assert.equal(host.getSourceFile(path, target), undefined, `getSourceFile(${shown}) answers absent`);
          if (host.directoryExists) assert.equal(host.directoryExists(path), false, `directoryExists(${shown}) answers absent`);
          if (host.getDirectories) assert.deepEqual(host.getDirectories(path), [], `getDirectories(${shown}) answers none`);
        }
        const stray = fake.calls.filter(c => escapes.includes(c.path));
        assert.deepEqual(stray, [], 'the sys was asked about a path the host must answer absent without a read');
      },
    });
    assertRead(await read(CONTROL_SOURCE, { typescript: fake.compiler }), 'the control source');
    assert.ok(probed, 'the probe ran: the entry built a program through the module\'s createProgram');
    assert.deepEqual(fake.violations, []);
  });

  it('caches the parsed lib per loaded module: a second read with the same module reads no lib, a new module reads again', async () => {
    const fake = recordingCompiler();
    assertRead(await read(CONTROL_SOURCE, { typescript: fake.compiler }), 'first read');
    const afterFirst = fake.readCount();
    assert.ok(afterFirst >= LIB_FLOOR, `the first read took the lib through sys.readFile (${afterFirst})`);
    assertRead(await read(CONTROL_SOURCE, { typescript: fake.compiler }), 'second read, same module');
    assert.equal(fake.readCount(), afterFirst, 'the second read with the same module asked sys.readFile for nothing');
    const other = recordingCompiler();
    assertRead(await read(CONTROL_SOURCE, { typescript: other.compiler }), 'a read with a new module');
    assert.ok(other.readCount() >= LIB_FLOOR, 'a new module starts with an empty cache');
  });
});

describe('a lib that cannot be read is the environment\'s fault, never the source\'s', () => {
  it('a lib file whose read answers nothing rejects with an Error that names the lib; it does not answer a refusal', async () => {
    const fake = recordingCompiler({ failLibRead: name => name === 'lib.es5.d.ts' });
    await assert.rejects(read(CONTROL_SOURCE, { typescript: fake.compiler }), (error) => {
      assert.ok(error instanceof Error, 'rejects with an Error');
      assert.match(error.message, /lib/i, `names the lib: ${error.message}`);
      return true;
    });
  });

  it('no lib at all (every lib read answers nothing) rejects with an Error too', async () => {
    const fake = recordingCompiler({ failLibRead: () => true });
    await assert.rejects(read(CONTROL_SOURCE, { typescript: fake.compiler }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /lib/i, `names the lib: ${error.message}`);
      return true;
    });
  });

  it('a source that does not compile is still the source\'s fault with the same module: a refusal, not a rejection', async () => {
    const answer = await read('export interface SpaceTypes { "entity": { "thing": { properties: { a: Zzzqq; } } } }', { typescript: recordingCompiler().compiler });
    assert.equal(answer.ok, false);
    assert.ok(answer.refusals.some(r => r.reason === 'source-does-not-compile'));
  });
});
