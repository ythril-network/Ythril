/**
 * The link conversion happens at boot, because the documented way to run it cannot be run.
 *
 * ## The report
 *
 * The canary operator, 2026-09-15T0034Z: `npm run links:convert` fails on a deployed instance with
 * `Cannot find module '/app/scripts/convert-links.mjs'`. The npm script survives into the image and
 * resolves its path correctly; `scripts/` is not copied. So it presents as a Node stack trace rather than
 * `missing script`, and reads like a broken installation of theirs.
 *
 * `04g-links-api.md` documents that script as THE mechanism and there is no second route — the pre-flight
 * only reports, and `POST /links` writes one link at a time. "Spaces converted" was a set a container
 * deployment could not join, and the 5.0 removal of the six link ARRAY fields is gated on exactly it.
 *
 * Owner, 2026-09-17: *"make the script autorun at startup … to force conversion when updating to >=5.0.
 * remove that on 6.0."*
 *
 * ## What this gate holds, and why each half is here
 *
 * The behaviour — arrays become link records — is covered by the conversion's own tests. What is NOT
 * covered by those, and is the whole of this change, is that it RUNS: wired into boot, after the
 * collection renames, skipping what is already done, and not able to take an instance down.
 *
 * Run: node --test testing/standalone/links-convert-runs-at-boot.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const INDEX = 'server/src/index.ts';
const MODULE = 'server/src/brain/links-convert-on-boot.ts';
const src = (p) => stripComments(readFileSync(p, 'utf8'));
/** The checkout's own line ending, so a block-close check works on CRLF and LF alike. */
const nl = readFileSync(INDEX, 'utf8').includes('\r\n') ? '\r\n' : '\n';

describe('the conversion is wired into boot', () => {
  it('index.ts calls it during startup', () => {
    const boot = src(INDEX);
    assert.match(boot, /convertLinksOnBoot\(\)/,
      'nothing calls the conversion at boot, so an operator is back to a script that cannot run');
  });

  it('and AFTER the collection renames, which it depends on', () => {
    /*
     * It walks `<space>_facts`, so the rename has to have happened. Ordered by POSITION rather than by
     * asserting the rename exists somewhere — the failure being prevented is a reorder, and a reorder
     * leaves both calls present.
     */
    const boot = src(INDEX);
    const rename = boot.indexOf('renameMemoriesToFacts()');
    const rekey = boot.indexOf('rekeyMemoryKindToFact()');
    const convert = boot.indexOf('convertLinksOnBoot()');
    assert.ok(rename > 0 && rekey > 0 && convert > 0, 'one of the three boot migrations is missing');
    assert.ok(convert > rename && convert > rekey,
      'the conversion runs before the collections are under their new names, so it would walk nothing');
  });

  it('and before the services that read those collections start', () => {
    const boot = src(INDEX);
    assert.ok(boot.indexOf('convertLinksOnBoot()') < boot.indexOf('startConfiguredInstanceServices()'),
      'the conversion runs after the services do, so a service can read a half-converted space');
  });

  it('and INSIDE the first-run guard, because on a first run there is no config to read', () => {
    /*
     * The bug this is here for, found by the test stack rather than by reading: the call sat beside the
     * two collection renames, which need no config and run unconditionally. This one reads the space
     * list, and `getConfig()` throws `Config not loaded` before setup has written one — so a FRESH
     * instance could not boot at all. `ythril-c exited (1)`.
     *
     * Bounded by the `if (!isFirstRun) {` block rather than by proximity: the failure is the call being
     * moved out of it, and a character window would not notice a move of a few lines.
     */
    const boot = src(INDEX);
    const call = boot.indexOf('convertLinksOnBoot()');
    assert.ok(call > 0, 'the conversion is not called at boot');
    // The guard that ENCLOSES the call — the last one before it. `index.ts` has three, and
    // `lastIndexOf` finds one further down the file, which passes for a call that is not guarded at all.
    const guard = boot.lastIndexOf('if (!isFirstRun) {', call);
    assert.ok(guard > 0,
      'the conversion runs outside the first-run guard, so a fresh instance dies reading a config that '
      + 'does not exist yet');
    // …and the guard has not closed before the call.
    assert.ok(!boot.slice(guard, call).includes(nl + '  }'),
      'the first-run block closes before the conversion, so the guard is above it rather than around it');
  });
});

describe('what it does to a space, and what it refuses to do', () => {
  const mod = src(MODULE);

  it('skips a space that is already converted', () => {
    // The marker means the space refuses array writes, so no new arrays can appear in it. Without this
    // every boot re-walks every collection on the instance for nothing.
    assert.match(mod, /completeLinkage !== true/,
      'it re-walks converted spaces, so steady-state boot pays for a migration that is done');
  });

  it('skips a proxy, which holds no documents of its own', () => {
    // A proxy aggregates its members. Walking one finds nothing and would then mark it complete on the
    // strength of that — the marker is the dangerous half, not the walk.
    assert.match(mod, /proxyFor/,
      'a proxy space would be walked and marked complete on an empty result');
  });

  it('marks ONLY on a clean walk', () => {
    /*
     * `completeLinkage` makes a space refuse array writes. Marking a space whose walk had failures starts
     * refusing writes for links that were never created — the one way this migration could lose data
     * rather than merely not finish.
     */
    assert.match(mod, /report\.failed > 0/,
      'it does not check the failure count, so a partial walk can mark the space complete');
    const markAt = mod.indexOf('completeLinkage: true');
    const checkAt = mod.indexOf('report.failed > 0');
    assert.ok(checkAt > 0 && checkAt < markAt, 'the failure check must come before the mark');
  });

  it('cannot take the boot down', () => {
    /*
     * Deliberate, and the reasoning is in the module. A space whose walk throws is left UNMARKED, which
     * means it keeps reading its arrays and keeps accepting array writes — exactly its behaviour before
     * this ran. Refusing to serve would turn a recoverable data problem into an instance nobody can log
     * into to look at it.
     */
    assert.doesNotMatch(mod, /process\.exit|throw new/,
      'a failed conversion must not stop an instance that would otherwise serve correctly');
    assert.match(mod, /catch \(err\)/, 'a throwing space must be caught and reported, not propagated');

    /*
     * THE EXPORTED FUNCTION'S OWN BODY IS A TRY, and this half was added after the per-space catch
     * turned out not to be enough. `getConfig()` threw before the loop was reached, from outside every
     * guard the module had — the promise "it cannot take a boot down" was true of the body and false of
     * the first line.
     */
    const entry = mod.slice(mod.indexOf('export async function convertLinksOnBoot'));
    const body = entry.slice(entry.indexOf('{') + 1);
    assert.match(body.trimStart().slice(0, 6), /^try/,
      'the exported entry point does work outside a try, so anything it reads before the loop can take '
      + 'the boot down');
  });

  it('says loudly which spaces did NOT convert', () => {
    // The whole guarantee this offers the array removal: after a boot, a space is either marked or named
    // in an error. A silent partial failure would leave the removal with no way to tell the two apart.
    assert.match(mod, /log\.error\(/,
      'a space that failed to convert is not reported at error level, so nobody learns it is unconverted');
  });
});
