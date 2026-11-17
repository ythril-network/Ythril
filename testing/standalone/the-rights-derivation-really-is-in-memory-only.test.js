/**
 * The token rights derivation is in-memory only — and it must be so BY CONSTRUCTION, not by accident.
 *
 * ## What was actually happening
 *
 * Three places say this migration never writes to disk. `loadConfig`'s own comment: *"IN MEMORY ONLY, and
 * deliberately not persisted: enforcement still reads the legacy fields, so this run is an observation
 * rather than a change. Writing it to config.json would make a derivation defect durable before anything
 * has compared it against the behaviour it is meant to reproduce."* The durable-migration gate exempts it
 * in as many words. And `a-token-without-a-matrix-reaches-nothing.test.js` describes it the same way.
 *
 * The code did the opposite. `migrateTokenRightsOnBoot` resolved `persist = save ?? defaultSave` and called
 * it whenever it had derived or repaired anything — so every boot ATTEMPTED the write the design forbids.
 *
 * **It was in-memory only by accident.** `defaultSave` reached for `require('../config/loader.js')` to keep
 * the import graph one-way, and `server/package.json` is `"type": "module"`, where `require` does not
 * exist. So the call threw, the surrounding `catch` logged *"Could not persist derived token rights (will
 * retry next boot)"*, and the boot carried on. Every boot, for ever, on every instance.
 *
 * ## Why that is worse than an ordinary bug, and why fixing the obvious thing would have been the defect
 *
 * The warning names a recovery that cannot happen — *retry next boot* is not a retry when the failure is
 * a missing language feature. It reads like a full disk. And anyone who "fixed" it the obvious way, by
 * swapping the `require` for a real import, would have silently INVERTED a deliberate decision: the
 * derivation would start being written to `config.json` before it had ever been compared against the
 * enforcement it is meant to reproduce, which is the exact outcome the loader's comment exists to prevent.
 *
 * So the fix is to make the stated design true: this function does not write, and cannot be asked to.
 *
 * ## What this gate holds
 *
 * That the in-memory promise is structural. Not "the save path is currently broken" — no save path.
 * `D-2` is where persisting happens, deliberately, once the comparison it waits on has been done.
 *
 * Run: node --test testing/standalone/the-rights-derivation-really-is-in-memory-only.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const BACKFILL = 'server/src/auth/backfill-token-rights.ts';
const LOADER = 'server/src/config/loader.ts';
const code = (f) => stripComments(readFileSync(f, 'utf8'));

/** The body of a top-level function, bounded by its own closing brace at column 0. */
function bodyOf(src, name) {
  const at = src.indexOf(`function ${name}`);
  assert.ok(at > 0, `${name} is gone — re-point this gate`);
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const end = src.indexOf(`${nl}}`, at);
  assert.ok(end > at, `could not find the end of ${name}`);
  return src.slice(at, end);
}

describe('no CommonJS require survives in an ESM package', () => {
  it('the package really is ESM, or this whole gate is about nothing', () => {
    const pkg = JSON.parse(readFileSync('server/package.json', 'utf8'));
    assert.equal(pkg.type, 'module',
      'server/package.json is no longer an ES module, so re-derive what this gate is protecting');
  });

  it('and nothing in server/src calls require()', () => {
    /*
     * Swept rather than fixed at the one reported site. There was exactly one, which is the answer this
     * gate now pins: in an ESM package every `require(` is a guaranteed runtime throw, and the one that
     * existed sat inside a try/catch that turned it into a warning nobody could act on.
     *
     * Comments are stripped first — this file's own docblock says the word, and so does an eslint-disable
     * line, which is how a source-reading gate fires on the explanation of the fix.
     *
     * **DERIVED, because the title says "nothing in server/src" and the body used to name five files.**
     * Those five were the ones being read on the day the sweep happened; a sixth written since then was
     * outside everything this gate looked at while the assertion message went on claiming the directory.
     * `Q-6`, 2026-09-07.
     */
    const files = trackedSources(SERVER_CODE_ROOTS);

    const offenders = files.filter(f => /\brequire\s*\(/.test(code(f)));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} calls require() in an ESM package — it throws at the moment it runs, and a `
      + 'try/catch around it turns a permanent failure into a warning that names a retry that cannot happen');
  });
});

describe('the derivation cannot write, by construction', () => {
  it('migrateTokenRightsOnBoot has no save path at all', () => {
    /*
     * The assertion is about ABSENCE, and that is deliberate. "The save is broken" was the state this
     * gate was written from; "there is no save" is the state the design describes.
     */
    const body = bodyOf(code(BACKFILL), 'migrateTokenRightsOnBoot');
    assert.doesNotMatch(body, /saveConfig|persist\(|defaultSave/,
      'the derivation writes, or tries to. The loader states it must not: enforcement still takes its '
      + 'SCOPE from the legacy fields, so a persisted derivation makes a derivation defect durable before '
      + 'anything has compared it against the behaviour it reproduces. That is `D-2`, not this function');
  });

  it('and it takes no injectable save either', () => {
    // A `save?` parameter is a save path with the safety catch off: the next caller passes one and the
    // decision above is reversed at a call site, where no reviewer is looking for it.
    const src = code(BACKFILL);
    const at = src.indexOf('function migrateTokenRightsOnBoot');
    const sig = src.slice(at, src.indexOf('{', at));
    assert.doesNotMatch(sig, /save/,
      'the signature still accepts a save function, so any caller can make the derivation durable');
  });

  it('the loader still calls it, and still with one argument', () => {
    // Not a persistence question — this is the one thing that must not regress while the rest is removed.
    assert.match(code(LOADER), /migrateTokenRightsOnBoot\(_config\)/,
      'the derivation is no longer wired into loadConfig, so a token with no matrix reaches nothing');
  });

  it('and the loader says WHY it is not persisted, where the decision lives', () => {
    /*
     * The reason is load-bearing rather than decorative: without it the next reader sees a derivation
     * thrown away every boot and "fixes" it. Read from the RAW source, because the reason is a comment.
     */
    const raw = readFileSync(LOADER, 'utf8');
    const at = raw.indexOf('migrateTokenRightsOnBoot(_config)');
    const nl = raw.includes('\r\n') ? '\r\n' : '\n';
    const lines = raw.slice(0, at).split(nl).slice(-10).join(nl);
    assert.match(lines, /IN MEMORY ONLY|not persisted/,
      'nothing above the call says the derivation is deliberately discarded, so the next reader makes it '
      + 'durable and takes a decision they did not know was one');
  });
});

describe('the durable-migration gate exempts it for a reason that is now true', () => {
  it('the exemption names it, and the code agrees', () => {
    /*
     * The exemption said *"`migrateTokenRightsOnBoot` is IN MEMORY only by design"* while the function
     * attempted a write on every boot. A gate whose exemption reason is contradicted by the code it
     * exempts is not an exemption, it is a blind spot with a sentence in front of it.
     */
    const gate = readFileSync('testing/standalone/a-durable-config-migration-stays-wired.test.js', 'utf8');
    assert.match(gate, /migrateTokenRightsOnBoot/,
      'the durable-migration gate no longer mentions this function — if it is now durable it needs a row '
      + 'there instead of an exemption');
    const body = bodyOf(code(BACKFILL), 'migrateTokenRightsOnBoot');
    assert.doesNotMatch(body, /retry next boot/,
      'the function still warns about retrying a write it no longer attempts');
  });
});
