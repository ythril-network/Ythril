/**
 * "Hold a horizon below in-flight writes" is ONE primitive, `heldWhile` in `util/horizon-holds.ts`, and every instance of the
 * hold is built and entered inside `util/position-clock.ts` — the record stream, the file-tombstone stream and the transaction
 * floor (`withPositionFloorHeld`) — through its stream definers (Q-346, bundle-71 D1, gate T6c; rewritten by bundle-81, design
 * rev 8 §1b and §9, amendment decision 35, P29, P49).
 *
 * ## Why it was rewritten, and what the rewrite reads
 *
 * The version it replaces named its instances as FILES (`NAMED_INSTANCES`: `util/seq.ts` and `files/tombstones.ts`) and read them
 * off whoever called `heldWhile`. Bundle-81 extracts the position clock (`util/position-clock.ts`) and removes the seq horizon:
 * the named files stop being instances, and a derivation off the importers of the clock would count every module that merely
 * stamps a position (P49). The instances are now read off the two places an instance can come from:
 *
 *   - **the constructions:** every `new HorizonHolds(` in `server/src`. There is one home for them, the clock module: a hold
 *     built anywhere else is entered and released by whatever that module wrote itself;
 *   - **the `heldWhile` callers:** every module outside the primitive that calls it. The clock is the only caller, so a second
 *     caller is a second place that decides when a hold ends;
 *   - **the stream definers:** every module that imports the clock and declares a stream with it (`PositionStream`). A definer
 *     builds no hold of its own: it hands the clock a stream, and the clock holds it.
 *
 * Floors: at least three instances (the two streams and the floor hold), at least two definers (the records stream in
 * `sync/record-position-stream.ts` and the file-tombstone stream in `files/tombstones.ts`), and the primitive defined once.
 *
 * ## The assumption this makes, and where to move it
 *
 * The clock module's API is not written yet. A stream is recognised by the type name `PositionStream` (annotated, constructed with
 * `new`, or returned by a function named `define…Stream` / `create…Stream`), and the floor hold by an export named
 * `withPositionFloorHeld`. If the build names the stream differently, `DEFINES_A_STREAM` is the one line to change.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: `util/position-clock.ts` does not exist, and `util/seq.ts` and `files/tombstones.ts` still construct
 * `HorizonHolds` and call `heldWhile` themselves. Mutation for the newly covered part: build a `new HorizonHolds(` in
 * `sync/record-position-stream.ts` and the construction case names it. Restore by hand.
 *
 * Run: node --test testing/standalone/a-horizon-hold-has-one-primitive-and-every-instance-calls-it.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const PRIMITIVE_MODULE = 'server/src/util/horizon-holds.ts';
const CLOCK_MODULE = 'server/src/util/position-clock.ts';
/** The stream definers the plan names: the instances' homes outside the clock. A floor on the derivation, not the derivation. */
const NAMED_DEFINERS = ['server/src/sync/record-position-stream.ts', 'server/src/files/tombstones.ts'];
const INSTANCE_FLOOR = 3;
const DEFINER_FLOOR = 2;

const CALLS_IT = /\bheldWhile\s*\(/;
const DEFINES_IT = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+heldWhile\b|(?:^|\n)\s*(?:export\s+)?const\s+heldWhile\b/;
const IMPORTS_THE_PRIMITIVE = /from\s+['"][^'"]*util\/horizon-holds\.js['"]|from\s+['"]\.\/horizon-holds\.js['"]/;
const IMPORTS_THE_CLOCK = /from\s+['"][^'"]*util\/position-clock\.js['"]|from\s+['"]\.\/position-clock\.js['"]/;
/** A construction of an instance, with or without a type argument: `new HorizonHolds(` and `new HorizonHolds<string>(`. */
const CONSTRUCTS_ONE = /\bnew\s+HorizonHolds\s*(?:<[^>(]*>)?\s*\(/;
/** The variable an instance is bound to: `const positionHolds: HorizonHolds<string> = new HorizonHolds<string>(`. */
const CONSTRUCTED_INTO = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*new\s+HorizonHolds\b/g;
/** A module declares a stream: annotated, constructed, or returned by a definer function. */
const DEFINES_A_STREAM = /:\s*PositionStream\b|\bnew\s+PositionStream\b|\b(?:define|create)\w*Stream\s*\(/;

const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const sources = trackedSources('server/src', { floor: 100 });

/**
 * The instances `code` builds that are never handed to `heldWhile` — by their variable, as its first argument — and so are
 * entered and released by whatever the module wrote itself. A construction bound to no variable is one nothing can hand to it.
 */
function instancesNotHeldByThePrimitive(code) {
  const bound = [...code.matchAll(CONSTRUCTED_INTO)].map(m => m[1]);
  const constructions = code.match(new RegExp(CONSTRUCTS_ONE.source, 'g'))?.length ?? 0;
  const unbound = Math.max(0, constructions - bound.length);
  return [
    ...bound.filter(name => !new RegExp(`\\bheldWhile\\s*\\(\\s*${name.replace(/\$/g, '\\$')}\\s*,`).test(code)),
    ...Array.from({ length: unbound }, () => '(a construction bound to no variable)'),
  ];
}

/** The instances of the hold, derived: the constructions, the `heldWhile` callers and the stream definers. */
function instances() {
  const constructors = sources.filter(f => f !== PRIMITIVE_MODULE && CONSTRUCTS_ONE.test(codeOf(f)));
  const callers = sources.filter(f => f !== PRIMITIVE_MODULE && CALLS_IT.test(codeOf(f)));
  const definers = sources.filter(f => f !== CLOCK_MODULE && IMPORTS_THE_CLOCK.test(codeOf(f)) && DEFINES_A_STREAM.test(codeOf(f)));
  return { constructors, callers, definers };
}

describe('the detector reads constructions, callers and definers', () => {
  it('sees a construction that is entered by hand (the red case, from a real module shape)', () => {
    assert.equal(instancesNotHeldByThePrimitive('const h = new HorizonHolds<number>({});\nheldWhile(h, s, x, f);').length, 0);
    assert.equal(instancesNotHeldByThePrimitive('export const h = new HorizonHolds({});').length, 1);
    assert.equal(instancesNotHeldByThePrimitive('register(new HorizonHolds<string>({}));').length, 1);
    assert.deepEqual(instancesNotHeldByThePrimitive('const positionHolds = new HorizonHolds({});\npositionHolds.enter(x);'), ['positionHolds']);
  });
  it('recognises a stream definition in each of the three spellings', () => {
    for (const src of ['export const records: PositionStream = {}', 'const s = new PositionStream(cfg)', 'export function defineRecordStream() {}\nconst x = defineRecordStream(c)']) {
      assert.ok(DEFINES_A_STREAM.test(src), src);
    }
    assert.ok(!DEFINES_A_STREAM.test('const positionHolds = 1; // PositionStreamless'));
  });
});

describe('the horizon hold is one primitive and every instance is built in the position clock', () => {
  it('the primitive lives in util/horizon-holds.ts, exports heldWhile, and is defined once', () => {
    assert.ok(existsSync(join(REPO_ROOT, PRIMITIVE_MODULE)), `${PRIMITIVE_MODULE} does not exist`);
    assert.ok(/export\s+(?:async\s+)?function\s+heldWhile\b/.test(codeOf(PRIMITIVE_MODULE)), `${PRIMITIVE_MODULE} exports no heldWhile`);
    assert.deepEqual(sources.filter(f => DEFINES_IT.test(codeOf(f))), [PRIMITIVE_MODULE],
      'a hold primitive defined anywhere else is a second implementation of the release, the bound and the report');
  });

  it('util/position-clock.ts exists, imports the primitive and calls it, and exports the transaction floor hold', () => {
    assert.ok(existsSync(join(REPO_ROOT, CLOCK_MODULE)),
      `${CLOCK_MODULE} does not exist: the record stream, the file-tombstone stream and the floor hold are three instances with no common home, so `
      + 'each is still its own registry, release and report');
    const code = codeOf(CLOCK_MODULE);
    assert.match(code, IMPORTS_THE_PRIMITIVE, 'the clock does not import heldWhile from util/horizon-holds: it holds by its own machinery');
    assert.match(code, CALLS_IT, 'the clock never calls heldWhile');
    assert.match(code, /export\s+(?:async\s+)?(?:function|const)\s+withPositionFloorHeld\b/, 'the clock exports no withPositionFloorHeld (the floor hold of a transaction)');
  });

  it('every construction of a HorizonHolds is in the clock module, and every one is handed to heldWhile', () => {
    const { constructors } = instances();
    const strays = constructors.filter(f => f !== CLOCK_MODULE);
    assert.deepEqual(strays, [],
      'a HorizonHolds built outside util/position-clock.ts is an instance the clock does not know: its release, bound and report are its own');
    assert.ok(constructors.includes(CLOCK_MODULE), `${CLOCK_MODULE} constructs no HorizonHolds: the clock holds nothing (derived constructors: ${constructors})`);
    assert.deepEqual(instancesNotHeldByThePrimitive(codeOf(CLOCK_MODULE)).map(n => `${CLOCK_MODULE}: ${n}`), [],
      'an instance entered and released by hand is a second implementation of the release, the bound and the report, however it is named');
  });

  it('the clock is the only caller of heldWhile', () => {
    const { callers } = instances();
    assert.deepEqual(callers.filter(f => f !== CLOCK_MODULE), [],
      'a module outside the clock decides by itself when a hold ends: hand the clock a stream instead');
    assert.ok(callers.includes(CLOCK_MODULE), `${CLOCK_MODULE} does not call heldWhile`);
  });

  it('the stream definers are derived, at least the two the plan names, and none builds a hold itself', () => {
    const { definers, constructors, callers } = instances();
    assert.ok(definers.length >= DEFINER_FLOOR, `only ${definers.length} stream definer(s) derived (${definers}): the derivation is broken, or the streams are not declared through the clock`);
    for (const named of NAMED_DEFINERS) {
      assert.ok(definers.includes(named), `${named} does not declare a stream through ${CLOCK_MODULE} (derived: ${definers})`);
    }
    assert.deepEqual(definers.filter(f => constructors.includes(f) || callers.includes(f)), [],
      'a stream definer builds or enters a hold itself: it is a second instance outside the clock');
  });

  it('there are at least three instances: the record stream, the file-tombstone stream and the floor hold', () => {
    const { definers } = instances();
    const code = existsSync(join(REPO_ROOT, CLOCK_MODULE)) ? codeOf(CLOCK_MODULE) : '';
    const floorHold = /export\s+(?:async\s+)?(?:function|const)\s+withPositionFloorHeld\b/.test(code) ? 1 : 0;
    const total = definers.length + floorHold;
    assert.ok(total >= INSTANCE_FLOOR,
      `${total} instance(s) derived (${definers.length} stream definer(s) and ${floorHold} floor hold): the plan has two streams and the floor hold, so a derivation that finds fewer is looking at a copy`);
  });
});
