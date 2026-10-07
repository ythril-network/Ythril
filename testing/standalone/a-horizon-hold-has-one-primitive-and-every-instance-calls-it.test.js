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
 * The instances are every tracked server source (comments blanked) outside the primitive's own module that calls `heldWhile(`.
 * The set must hold at least two (the seq horizon and the tombstone position), must include both named modules, and each of
 * them must import the primitive from `util/horizon-holds`. The primitive is DEFINED once, in that module: a second
 * definition of `heldWhile` anywhere in `server/src` is the second implementation, however carefully copied.
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

const codeOf = (file) => blankComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const sources = trackedSources('server/src', { floor: 100 });

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
});
