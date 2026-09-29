/**
 * A durable config migration is load-bearing on every boot, not once in history.
 *
 * ## What this gate exists to stop, and it is a PLAN rather than a bug
 *
 * `_DEPRECATIONS.md` files one-time migrations under *"DROP once the floor passes it — dead code once no
 * instance can upgrade from before it"*. Four of them shipped at or before the 3.0.0 floor that 4.0 upgrades
 * from, which reads as licence to delete all four.
 *
 * The floor is not the test, and the code says so in its own words. Every one of these is written as
 * **mutate in memory, then attempt to persist, and on failure `log.warn('will retry next boot')`**. That
 * retry path is not decoration: it means the product does not assume the write succeeded, so
 * *"every instance has already been migrated"* is an assumption the implementation itself declines to make.
 * While a stale key survives on disk, the migration is what turns it into the right value — on every boot,
 * for the life of that instance.
 *
 * ## Why the consequence decides it and not the probability
 *
 * These four do not fail by losing a value. They fail by leaving a WRONG DEFAULT, and the defaults moved
 * underneath them:
 *
 * | stale key | what its absence now means | what deleting the migration does |
 * |---|---|---|
 * | `mediaEmbedding.faceRecognition.enabled: false` | the image ladder is the only gate | an `auto` or `recognition` ceiling starts face detection and stores face EMBEDDINGS — biometric data — unasked |
 * | `mediaEmbedding.enabled: false` | media processing is always on, per class | an instance that had media OFF starts captioning and transcribing everything |
 * | `mediaEmbedding.ollamaUrl` and its three siblings | `vision.*` / `stt.*` carry the endpoints | the endpoint silently falls back to the built-in default and captions against whatever answers there |
 * | space `description` | `meta.purpose` is the directive MCP clients read | the space's directive disappears, and the API refuses `description` so the operator cannot even re-send it |
 *
 * Three of those four are the failure this repository has now twice refused to ship: a setting that is
 * present, configures nothing, and produces no error. One of them is biometric. Against that, *"probably no
 * instance still carries the key"* is not a standard — which is why all four were reclassified **KEEP** on
 * 2026-09-02 rather than dropped with the 4.0 batch.
 *
 * ## What is asserted, and why it is the WIRING rather than the behaviour
 *
 * Each migration's translation is already covered case by case (`face-switch-migration.test.js`,
 * `media-embedding-migration.test.js`, `space-purpose-one-field.test.js`, and the alias-lift suite). Those
 * gates fail if a migration starts doing the wrong thing — and pass, all of them, if it stops being CALLED.
 * A deletion takes the function and its test out together and leaves nothing red.
 *
 * So this file asserts the boot wiring, and the SHAPE of it that makes the retry contract true:
 *
 *  1. `loadConfig` still calls every one of them;
 *  2. the call is not inside the `try`, so the in-memory fix applies even when the disk write fails —
 *     which is the whole of the protection on an instance whose config cannot be rewritten;
 *  3. the persist is attempted, and its failure is caught rather than fatal.
 *
 * Point 2 is the one that would go unnoticed. Moving a migration inside its own `try` looks like tidying,
 * costs nothing on a healthy instance, and removes the protection entirely on the only instance that needs
 * it.
 *
 * Run: node --test testing/standalone/a-durable-config-migration-stays-wired.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const LOADER = 'server/src/config/loader.ts';
const CODE = stripComments(readFileSync(LOADER, 'utf8'));

/** `loadConfig`'s body — the boot path, and the only place these may be wired. */
function loadConfigBody() {
  const start = CODE.indexOf('export function loadConfig(): Config {');
  assert.notEqual(start, -1, `loadConfig not found in ${LOADER} — this gate is reading the wrong thing`);
  const end = CODE.indexOf('\n}', start);
  assert.notEqual(end, -1, 'loadConfig has no closing brace at column 0');
  return CODE.slice(start, end);
}

/*
 * The four, and the one line of reasoning each. Kept as data so a fifth migration is one row rather than a
 * new copy of the same three assertions.
 */
const DURABLE = [
  { call: 'migrateFaceRecognitionSwitch', persists: true,
    why: 'deleting it can start face detection and store biometric embeddings on an instance that had faces off' },
  { call: 'migrateMediaEmbeddingMasterSwitch', persists: true,
    why: 'deleting it turns media processing on for an instance that had it off' },
  { call: 'migrateSpaceDescriptionToPurpose', persists: true,
    why: 'deleting it loses the directive MCP clients read, and the API refuses `description` so it cannot be re-sent' },
  // Persists inside its own module (it takes `saveConfig` as an argument), so the try/catch is there rather
  // than at the call site. The call itself must still be here.
  { call: 'migrateMediaAliasesOnBoot', persists: false,
    why: 'deleting it drops the vision/STT endpoints to the built-in default with nothing in the log' },
  { call: 'migrateSyncScheduleShorthands', persists: true,
    why: 'deleting it leaves a stored shorthand unresolvable, so the network silently drops to manual sync — '
       + 'and the shorthands are refused at input now, so the operator cannot put the value back either' },
  { call: 'migrateNetworkSpaceKeys', persists: true,
    why: 'deleting it leaves a network\'s schema layer and membership origin under a renamed space\'s old id, so the '
       + 'space loses that network\'s schema and a joining token can no longer be told apart as its establisher' },
];

describe('the gate reads the boot path', () => {
  it('finds loadConfig, and it is not empty', () => {
    const body = loadConfigBody();
    assert.ok(body.length > 500, `loadConfig body is ${body.length} chars — the parse is wrong`);
    assert.match(body, /readFileSync/, 'loadConfig must still be the function that reads the file');
  });

  it('FLAGS a migration moved inside its own try, and allows the real shape', () => {
    // Mutation-check on the predicate that matters most, since that edit looks like tidying.
    const wrong = 'try {\n  if (migrateX(_config)) { saveConfig(_config); }\n} catch (err) { log.warn(err); }';
    const right = 'if (migrateX(_config)) {\n  try { saveConfig(_config); } catch (err) { log.warn(err); }\n}';
    assert.ok(!callIsOutsideTry(wrong, 'migrateX'), 'a call inside the try must be flagged');
    assert.ok(callIsOutsideTry(right, 'migrateX'), 'the real shape must be allowed');
  });
});

/**
 * Whether every occurrence of `call` sits at try-depth zero.
 *
 * Counts `try {` and `catch` textually rather than parsing: this only has to distinguish "the migration runs
 * unconditionally" from "the migration runs inside a block whose failure skips it", and the file's shape is
 * flat enough that a counter answers it. A parser here would be a second implementation of something with
 * one caller.
 */
function callIsOutsideTry(body, call) {
  let depth = 0;
  let sawCall = false;
  for (const line of body.split('\n')) {
    if (line.includes(`${call}(`)) {
      sawCall = true;
      if (depth > 0) return false;
    }
    if (/\btry\s*\{/.test(line)) depth += 1;
    if (/^\s*\}\s*catch\b/.test(line)) depth = Math.max(0, depth - 1);
  }
  return sawCall;
}

describe('every durable config migration is still wired at boot', () => {
  for (const { call, persists, why } of DURABLE) {
    it(`${call} is called by loadConfig`, () => {
      assert.match(loadConfigBody(), new RegExp(`${call}\\(`),
        `${call} is no longer called at boot. It shipped before the 3.0.0 floor, which is NOT licence to `
        + `delete it: the migration warns "will retry next boot" when the write fails, so a stale key can `
        + `still be on disk — and ${why}.`);
    });

    it(`${call} applies in memory even when the disk write fails`, () => {
      assert.ok(callIsOutsideTry(loadConfigBody(), call),
        `${call} runs inside a try/catch, so a failed save skips the fix entirely — on exactly the instance `
        + 'that needs it, since the fix is only load-bearing where the config cannot be rewritten. Mutate '
        + 'first, then attempt the save inside the try.');
    });

    if (persists) {
      it(`${call} attempts to persist, and a failure is caught rather than fatal`, () => {
        const body = loadConfigBody();
        const at = body.indexOf(`${call}(`);
        // Structural window: from the call to the end of the block it opens, not a character count — the
        // same span is a different number of characters on CRLF and on CI's LF.
        const after = body.slice(at, body.indexOf('\n  }', at) + 4);
        assert.match(after, /saveConfig\(/, `${call} changes the config but never writes it — it would re-run for ever`);
        assert.match(after, /catch/, `${call}'s save must be caught: an unwritable config must not stop the boot`);
        assert.match(after, /retry next boot/,
          'the warning must say the migration retries — that sentence is the contract this whole gate rests on');
      });
    }
  }

  it('and the list is the whole list — a new migration cannot arrive unpinned', () => {
    /*
     * The inverse assertion. Without it, adding a fifth durable migration and forgetting this file leaves
     * the new one with no wiring gate at all, which is the state every row above was in until 4.0.
     */
    const declared = new Set(DURABLE.map(d => d.call));
    const wired = [...loadConfigBody().matchAll(/\b(migrate[A-Za-z]+)\(/g)].map(m => m[1]);
    const unknown = [...new Set(wired)].filter(c => !declared.has(c) && c !== 'migrateProviderApiKeysOnBoot'
      && c !== 'migrateTokenRightsOnBoot');
    assert.deepEqual(unknown, [],
      `loadConfig calls ${unknown.join(', ')}, which this gate does not know about. Add a row to DURABLE `
      + 'with the one line of reasoning for what deleting it would do, or say here why it needs no pin. '
      + '(`migrateTokenRightsOnBoot` is IN MEMORY only by design AND by construction since 2026-09-05 — it '
      + 'has no save path at all, which is what makes this exemption true rather than merely stated; and '
      + '`migrateProviderApiKeysOnBoot` carries '
      + 'a secret and is tracked separately — both are exempt on purpose, with their reasons in the loader.)');
  });
});
