/**
 * The schema package's from-typescript entry reads the same on TypeScript 6.x as on the compiler the repository tests with (Q-687, design v3 item
 * 3; the lens: testing S5 "the peer range is unproved at both ends").
 *
 * ## The rule held
 *
 * The peer range is `>=5.4`, and the repository's own `typescript` is a 5.x. A range proved at one end is a claim about the other. So
 * the 6.x end is run: `typescript-6` (an alias, `npm:typescript@^6`) is a devDependency of the schema package, outside the production
 * closure, and this file runs the harness with it injected as the compiler (the `typescript` option, which is also how an app on TS 7
 * hands the entry a 6.x it installed under an alias):
 *
 * - the garden round trip and every row of `_from-typescript-rows.mjs`, the same assertions as on 5.x;
 * - a diagnostic with its code, which is the part of an answer a compiler version could change;
 * - the closed host with the recording fake `sys`: only lib paths, a floor on the lib files read.
 *
 * Before the devDependency exists every case is red for the one reason the first case names (the package is absent); before the entry
 * exists they are red for the entry's.
 *
 * Run: node --test testing/standalone/from-typescript-reads-the-same-on-typescript-6.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  entry, read, sourceOf, assertRead, gardenFixtures, sourceOfMeta, assertAgrees, recordingCompiler, CONTROL_SOURCE, typescript6,
} from './_from-typescript.mjs';
import { ROUND_TRIP_ROWS, SOURCE_ROWS, roundTrip, runSourceRow } from './_from-typescript-rows.mjs';

/** The fewest lib files lib.es2022.d.ts reaches on 6.x: es5 and the editions to 2022, with their parts. */
const LIB_FLOOR_6 = 20;

describe('the harness on TypeScript 6.x', () => {
  it('typescript-6 is installed, is a 6.x, and the entry is built', async () => {
    const ts6 = await typescript6();
    assert.match(ts6.version, /^6\./, `typescript-6 is npm:typescript@^6, got ${ts6.version}`);
    assert.equal(typeof ts6.createProgram, 'function');
    await entry();
  });

  for (const { name, meta } of gardenFixtures()) {
    it(`${name} round-trips on 6.x with the same agreement as on 5.x`, async () => {
      const ts6 = await typescript6();
      assertAgrees(await read(sourceOfMeta(meta), { typescript: ts6 }), meta, `${name} on ${ts6.version}`);
    });
  }

  for (const row of ROUND_TRIP_ROWS) {
    it(`${row.title} (6.x)`, async () => {
      const ts6 = await typescript6();
      row.check(await roundTrip(row.meta, `${row.title} on ${ts6.version}`, { typescript: ts6 }));
    });
  }

  for (const row of SOURCE_ROWS) {
    it(`${row.title} (6.x)`, async () => {
      await runSourceRow(row, { typescript: await typescript6() });
    });
  }

  it('a name that does not exist is refused source-does-not-compile with TS2304 on 6.x too', async () => {
    const answer = await read(sourceOf('name: Zzzqq;'), { typescript: await typescript6() });
    assert.equal(answer.ok, false);
    const refusal = answer.refusals.find(r => r.reason === 'source-does-not-compile');
    assert.ok(refusal, JSON.stringify(answer.refusals));
    assert.equal(refusal.code, 2304);
  });

  it('the closed host holds on 6.x: a fake sys that allows only lib paths is never asked for another, and its lib files are read through it', async () => {
    const ts6 = await typescript6();
    const fake = recordingCompiler({}, ts6);
    assertRead(await read(CONTROL_SOURCE, { typescript: fake.compiler }), 'the control source on 6.x');
    assert.deepEqual(fake.violations, []);
    const reads = fake.libReads();
    assert.ok(reads.length >= LIB_FLOOR_6, `floor: at least ${LIB_FLOOR_6} lib files read through sys.readFile on 6.x, got ${reads.length}`);
    assert.ok(reads.includes('lib.es2022.d.ts') && reads.includes('lib.es5.d.ts'), `lib.es2022.d.ts and lib.es5.d.ts were read, got ${reads.slice(0, 5).join(', ')}...`);
  });
});
