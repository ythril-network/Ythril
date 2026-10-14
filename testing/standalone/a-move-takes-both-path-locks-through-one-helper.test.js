/**
 * A step that works on two stored paths takes both paths' locks through ONE helper, in sorted order, and the sort is inside it
 * (bundle-44, D-29, Q-437; ruling 44).
 *
 * ## The rule
 *
 * Two moves that cross (A to B while B to A) deadlock if each takes the source's lock and waits for the destination's. The order is
 * therefore the same for every caller: both resolved paths, sorted, the first taken and then the second (the same lock once when the paths
 * resolve alike). That order was written out in each function that takes two locks (`moveStored`, `moveStoredIfFree`,
 * `finishInterruptedLink`): three copies of the one line a new fourth function would leave out. It is `withPathLocks`, and a caller cannot drop
 * the sort because the sort is not the caller's.
 *
 * ## What is derived, never listed
 *
 * The subjects are the functions of `files/stored-bytes.ts` whose parameters are a source path and a destination path (`srcAbs`, `dstAbs`),
 * found in the source. A floor on them stops an empty derivation passing.
 *
 * ## What is asserted
 *
 *  1. every such function takes its locks through `withPathLocks(` and spells no sort of its own;
 *  2. `withPathLocks` is the one place in the module that sorts the resolved paths;
 *  3. crossing moves of one pair of paths, started together, both end (no deadlock) and leave one file at one path.
 *
 * ## Seen red
 *
 * Mutation (put back by hand): write `[path.resolve(srcAbs), path.resolve(dstAbs)].sort()` back into `finishInterruptedLink`, or swap the
 * helper's sort for the pair in call order.
 *
 * Run: node --test testing/standalone/a-move-takes-both-path-locks-through-one-helper.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const FILE = 'server/src/files/stored-bytes.ts';
const src = stripComments(readFileSync(FILE, 'utf8'));

/** The functions of the module with a source and a destination path among their parameters, with their bodies. */
function twoPathFunctions() {
  const out = [];
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/gm)) {
    const params = balancedFrom(src, m.index + m[0].length - 1, `${m[1]} parameters`);
    if (!/\bsrcAbs\b/.test(params) || !/\bdstAbs\b/.test(params)) continue;
    const bodyAt = src.indexOf('{', m.index + m[0].length - 1 + params.length);
    out.push({ name: m[1], body: balancedFrom(src, bodyAt, `${m[1]} body`) });
  }
  return out;
}
const bodyOf = (name) => {
  const m = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*(?:<[^>]*>)?\\(`, 'm').exec(src);
  assert.ok(m, `${FILE} has no function ${name}`);
  const params = balancedFrom(src, m.index + m[0].length - 1, `${name} parameters`);
  return balancedFrom(src, src.indexOf('{', m.index + m[0].length - 1 + params.length), `${name} body`);
};

describe('every step on two stored paths takes both locks through one helper', () => {
  // The steps that take a lock at all: `readDestination` and `destinationStateAt` read two paths and hold nothing.
  const subjects = twoPathFunctions().filter(f => f.name !== 'withPathLocks' && /\bwithPathLock|\bpathLocks\b/.test(f.body));

  it('finds the steps, so an empty derivation cannot pass', () => {
    assert.ok(subjects.length >= 3, `only ${subjects.length} function(s) of ${FILE} take a source and a destination path (${subjects.map(s => s.name)}): the derivation is broken`);
    for (const n of ['moveStored', 'moveStoredIfFree', 'finishInterruptedLink']) assert.ok(subjects.some(s => s.name === n), `${n} is not found among the two-path steps`);
  });

  it('each takes its locks through withPathLocks and sorts nothing itself', () => {
    const own = subjects.filter(s => !/\bwithPathLocks\s*\(/.test(s.body) || /\.sort\s*\(/.test(s.body)).map(s => s.name);
    assert.deepEqual(own, [], 'these steps take their two locks by hand or sort the pair themselves: the next one written the same way leaves the order out and two crossing moves deadlock');
  });

  it('withPathLocks is the only function of the module that sorts a pair of resolved paths', () => {
    const helper = bodyOf('withPathLocks');
    assert.match(helper, /path\.resolve\(/, 'the helper does not resolve the paths it orders');
    assert.match(helper, /\.sort\s*\(/, 'the helper does not sort');
    const sorting = [...src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)].map(m => m[1]).filter(n => n !== 'withPathLocks' && /\.sort\s*\(/.test(bodyOf(n)));
    assert.deepEqual(sorting, [], 'another function of the module sorts for itself');
  });
});

describe('crossing moves of one pair of paths do not deadlock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-locks-'));
  process.env['DATA_ROOT'] = root;
  let stored;
  before(async () => { stored = await import('../../server/dist/files/stored-bytes.js'); });
  after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it('A to B while B to A: both calls end, and one file stands at one of the paths', async () => {
    const a = path.join(root, 'cross-a.txt');
    const b = path.join(root, 'cross-b.txt');
    fs.writeFileSync(a, 'A');
    const ended = Promise.allSettled([stored.moveStored(a, b), stored.moveStored(b, a), stored.moveStored(a, b), stored.moveStored(b, a)]);
    const result = await Promise.race([ended, new Promise(r => setTimeout(() => r('deadlock'), 10_000))]);
    assert.notEqual(result, 'deadlock', 'two crossing moves did not end: each held one lock and waited for the other');
    assert.equal([a, b].filter(p => fs.existsSync(p)).length, 1, 'the file is gone or was copied');
  });
});
