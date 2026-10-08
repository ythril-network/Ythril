/**
 * "Hold a horizon below in-flight writes" is ONE primitive, `heldWhile` in `util/horizon-holds.ts`, and every instance of the
 * hold — the seq horizon and the file-tombstone position — calls it (Q-346, bundle-71 D1, gate T6c).
 *
 * ## Why this is the gate the hold's other gates stand on
 *
 * The seq hold's gates (`a-write-inside-a-seq-hold-always-ends-db`, the four `a-write-the-bound-ended-never-lands*-db`,
 * `a-stalled-seq-hold-is-reported-db`) each prove one property of the machinery: the write ends within the bound, the hold
 * is released in a `finally`, a stall is reported by a line and a gauge. They were written for ONE instance, so a second
 * hold written by hand beside it — its own registry, its own release, its own report — passes every one of them and is held
 * to none. The position hold was about to be that copy. This file is what makes the second instance a caller of the first's
 * machinery rather than a sibling of it, and what makes a THIRD one visible: the instances are DERIVED from who calls the
 * primitive, so each new one is owed the same cases the day it is written.
 *
 * ## What is derived, and the floor
 *
 * An instance is read off TWO sites, because either one alone leaves a hole. The callers: every tracked server source (comments
 * blanked) outside the primitive's own module that calls `heldWhile(`. The constructions: every one that builds a
 * `new HorizonHolds(` — an instance that is entered and released by hand is a construction no caller of `heldWhile` names, so
 * a derivation read only off the callers cannot see it. Each set must hold at least two (the seq horizon and the tombstone
 * position) and include both named modules; each caller must import the primitive from `util/horizon-holds`; and every
 * construction must be handed to `heldWhile` by the variable that holds it. The primitive is DEFINED once, in that module: a
 * second definition of `heldWhile` anywhere in `server/src` is the second implementation, however carefully copied.
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
/** The instances the plan names. Not the derivation — a floor on it: the derivation must find at least these two. */
const NAMED_INSTANCES = ['server/src/util/seq.ts', 'server/src/files/tombstones.ts'];
const CALLS_IT = /\bheldWhile\s*\(/;
const DEFINES_IT = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+heldWhile\b|(?:^|\n)\s*(?:export\s+)?const\s+heldWhile\b/;
const IMPORTS_THE_MODULE = /from\s+['"][^'"]*util\/horizon-holds\.js['"]|from\s+['"]\.\/horizon-holds\.js['"]/;

/** A construction of an instance, with or without a type argument: `new HorizonHolds(` and `new HorizonHolds<string>(`. */
const CONSTRUCTS_ONE = /\bnew\s+HorizonHolds\s*(?:<[^>(]*>)?\s*\(/;
/** The variable an instance is bound to: `const positionHolds: HorizonHolds<string> = new HorizonHolds<string>(`. */
const CONSTRUCTED_INTO = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*new\s+HorizonHolds\b/g;

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

describe('the horizon hold is one primitive and every instance calls it', () => {
  it('the primitive lives in util/horizon-holds.ts and exports heldWhile', () => {
    assert.ok(existsSync(join(REPO_ROOT, PRIMITIVE_MODULE)),
      `${PRIMITIVE_MODULE} does not exist: the hold machinery (registry, holder check, release line, watchdog scan) is still seq's own, `
      + 'so a second hold has nothing to call and would have to copy it');
    assert.ok(/export\s+(?:async\s+)?function\s+heldWhile\b/.test(codeOf(PRIMITIVE_MODULE)), `${PRIMITIVE_MODULE} exports no heldWhile`);
  });

  it('heldWhile is defined once, in the primitive\'s module', () => {
    const definers = sources.filter(f => DEFINES_IT.test(codeOf(f)));
    assert.deepEqual(definers, [PRIMITIVE_MODULE],
      'a hold primitive defined anywhere else is a second implementation of the release, the bound and the report');
  });

  it('the instances are derived from the callers of the primitive, and there are at least two', () => {
    const instances = sources.filter(f => f !== PRIMITIVE_MODULE && CALLS_IT.test(codeOf(f)));
    assert.ok(instances.length >= 2,
      `only ${instances.length} module(s) call heldWhile (${instances}): the seq horizon and the file-tombstone position are two instances `
      + 'of one primitive, and a derivation that finds fewer is looking at a copy');
    for (const named of NAMED_INSTANCES) {
      assert.ok(instances.includes(named), `${named} does not call the shared heldWhile — it is not an instance of the primitive (derived: ${instances})`);
    }
  });

  it('every instance imports the primitive from util/horizon-holds, never a local one', () => {
    const instances = sources.filter(f => f !== PRIMITIVE_MODULE && CALLS_IT.test(codeOf(f)));
    assert.ok(instances.length >= 2, 'fixture: fewer than two instances derived — see the case above');
    const own = instances.filter(f => !IMPORTS_THE_MODULE.test(codeOf(f)));
    assert.deepEqual(own, [], 'these call a heldWhile that is not the shared one');
  });

  it('the instances are also derived from the constructions, there are at least two, and every one is held by the primitive', () => {
    const constructors = sources.filter(f => f !== PRIMITIVE_MODULE && CONSTRUCTS_ONE.test(codeOf(f)));
    assert.ok(constructors.length >= 2,
      `only ${constructors.length} module(s) construct a HorizonHolds (${constructors}): a derivation that finds fewer is not reading the construction site`);
    for (const named of NAMED_INSTANCES) {
      assert.ok(constructors.includes(named), `${named} constructs no HorizonHolds — it is not an instance of the primitive (derived: ${constructors})`);
    }
    const byHand = constructors.flatMap(f => instancesNotHeldByThePrimitive(codeOf(f)).map(name => `${f}: ${name}`));
    assert.deepEqual(byHand, [],
      'an instance entered and released by hand is a second implementation of the release, the bound and the report, however it is named');
  });

  it('the check sees a construction that is entered by hand (the red case, read from a real instance)', () => {
    const real = codeOf('server/src/files/tombstones.ts');
    assert.deepEqual(instancesNotHeldByThePrimitive(real), [], 'fixture: the real module is held by the primitive');
    const byHand = real.replace(/\bheldWhile\s*\(\s*positionHolds\s*,/g, 'positionHolds.enter(');
    assert.notEqual(byHand, real, 'fixture: the mutation changed nothing, so it proves nothing');
    assert.deepEqual(instancesNotHeldByThePrimitive(byHand), ['positionHolds']);
    assert.equal(instancesNotHeldByThePrimitive('const h = new HorizonHolds<number>({});\nheldWhile(h, s, x, f);').length, 0);
    assert.equal(instancesNotHeldByThePrimitive('export const h = new HorizonHolds({});').length, 1);
    assert.equal(instancesNotHeldByThePrimitive('register(new HorizonHolds<string>({}));').length, 1);
  });
});
