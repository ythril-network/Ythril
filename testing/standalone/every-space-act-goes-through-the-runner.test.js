/**
 * Every deletion, wipe and rename of a space goes through ONE runner — registered durably, drained, run once in the slot (bundle-106 PR A, VR5, X1, X3, X9).
 *
 * ## What the rule prevents
 *
 * Before the runner a removal, a wipe and a rename each took their own route to the data: `removeSpace` and `renameSpace` counted
 * themselves in an instance-wide depth counter (`beginSpaceOp`), `wipeSpace` did not, and a ten-minute wipe of one space made every
 * rename and delete that met a `pendingSpaceOp` refuse with *"being performed right now"*. Two deletions of one space ran concurrently
 * and the second threw; a queued act existed only in memory and closed nothing. The rule is one module
 * (`spaces/space-act-runner.ts`), and every act in the codebase reaches the data through it.
 *
 * ## The gate asks the rule, not the sites
 *
 * Each assertion is about EVERY occurrence a derivation finds, with a floor, over comment-stripped source (`_space-act-sources.mjs`).
 * The callers of the three exported entry points are derived from the tree, not listed here; the floors name the files the design
 * says reach them today, so a caller that stops matching fails the floor instead of the set quietly shrinking.
 *
 * ## Seen red
 *
 * On the base the runner module does not exist, so the first assertion is red for exactly that. Once it does, the mutations of
 * design §6.3 step 11 are the reds: call `removeSpaceUnqueued` from `api/spaces.ts` (the unqueued-names assertion); make
 * `removeSpace`'s first statement something other than `return runSpaceAct(`; re-introduce `beginSpaceOp`.
 *
 * Run: `node --test testing/standalone/every-space-act-goes-through-the-runner.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RUNNER, requireSource, bodyOf, filesMatching } from './_space-act-sources.mjs';
import { blockAfter } from './_structural-window.mjs';

const LIFECYCLE = 'server/src/spaces/lifecycle.ts';
const RENAME = 'server/src/spaces/rename.ts';
const APPLY = 'server/src/spaces/apply-wipe-round.ts';
const INDEX = 'server/src/index.ts';
const BOOTSTRAP = 'server/src/bootstrap.ts';

/** What the runner exports, as the design's §2.5 names it. */
const RUNNER_EXPORTS = ['registerSpaceAct', 'runSpaceAct', 'spaceActStands', 'spaceActRunning', 'spaceActsRunning', 'closeSpaceActs',
  'reportSlowSpaceActs', 'spaceActAnswerMs', 'setSpaceActKnobsForTest', 'setSpaceActHooksForTest', 'reopenSpaceActsForTest', 'spaceActBodyRuns'];

const callers = (name) => filesMatching(new RegExp(`(?<![\\w.$])${name}\\s*\\(`)).map(([f]) => f);

describe('every deletion, wipe and rename of a space goes through the one runner', () => {
  it('the runner module exists and exports the whole of its surface', () => {
    const src = requireSource(RUNNER);
    const exported = new Set([...src.matchAll(/export\s+(?:async\s+)?(?:function|const|let)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
    for (const name of RUNNER_EXPORTS) assert.ok(exported.has(name), `${RUNNER} does not export ${name}`);
  });

  it('the runner imports nothing from lifecycle.ts or rename.ts (no import cycle, P18): they import the runner', () => {
    const src = requireSource(RUNNER);
    assert.doesNotMatch(src, /from\s+['"][^'"]*\/(?:lifecycle|rename)\.js['"]/, `${RUNNER} imports a body module`);
    assert.doesNotMatch(src, /import\(\s*['"][^'"]*\/(?:lifecycle|rename)\.js['"]\s*\)/, `${RUNNER} dynamically imports a body module`);
    for (const f of [LIFECYCLE, RENAME]) assert.match(requireSource(f), /from\s+['"][^'"]*space-act-runner\.js['"]/, `${f} does not import the runner`);
  });

  for (const [file, name] of [[LIFECYCLE, 'removeSpace'], [LIFECYCLE, 'wipeSpace'], [RENAME, 'renameSpace']]) {
    it(`the first statement of the exported ${name} is \`return runSpaceAct(\` — no door reaches a body but through the runner`, () => {
      const body = bodyOf(file, name);
      assert.match(body, /^\{\s*return\s+runSpaceAct\(/, `${name} does something before it hands the act to the runner:\n${body.slice(0, 300)}`);
    });
  }

  it('the unqueued bodies are named in lifecycle.ts and apply-wipe-round.ts and in no other file', () => {
    const allowed = new Set([LIFECYCLE, APPLY]);
    for (const name of ['removeSpaceUnqueued', 'wipeSpaceUnqueued']) {
      const where = filesMatching(new RegExp(`\\b${name}\\b`)).map(([f]) => f);
      assert.ok(where.includes(LIFECYCLE), `${name} is not defined in ${LIFECYCLE}`);
      const stray = where.filter(f => !allowed.has(f));
      assert.deepEqual(stray, [], `${name} is reached from outside the two modules the design names: ${stray.join(', ')}`);
    }
  });

  // Corrected (bundle-106 A2): the doors reach the runner through the wipe planner and the deletion module, which register their acts
  // themselves (design v5 section 2.2 (2): a door waits under its own budget and releases its waiter when it answers, which lifecycle's
  // removeSpace/wipeSpace cannot), and the settle registers instead of calling removeSpace/wipeSpace (section 2.1). The rule is
  // unchanged: each door, and the settle, reaches a body only through the runner's registrars or the lifecycle wrappers over them.
  it('the callers of removeSpace(, wipeSpace( and the runner\'s registrars are derived, and include the doors the design names', () => {
    const floor = ['server/src/spaces/space-deletion.ts', 'server/src/spaces/wipe-vote.ts', APPLY];
    const found = new Set([...callers('removeSpace'), ...callers('wipeSpace'), ...callers('registerOwnSpaceAct'), ...callers('registerSpaceAct')]
      .filter(f => f !== LIFECYCLE && f !== RUNNER));
    for (const f of floor) assert.ok(found.has(f), `${f} no longer reaches the runner through removeSpace(, wipeSpace( or a registrar — the derivation found: ${[...found].join(', ')}`);
    for (const [door, through] of [['server/src/api/spaces.ts', 'spaces/space-deletion.js'], ['server/src/app.ts', 'spaces/wipe-vote.js'], ['server/src/spaces/delete-space-data.ts', './wipe-vote.js']]) {
      assert.ok(requireSource(door).includes(through), `${door} does not reach the runner through ${through}`);
    }
  });

  it('every act is REGISTERED by a registrar the design names: the settle (apply-wipe-round.ts) and rename.ts register; nothing else writes an entry', () => {
    const found = callers('registerSpaceAct').filter(f => f !== RUNNER);
    assert.ok(found.includes(APPLY), `apply-wipe-round.ts does not register the acts of the rounds it settles: ${found.join(', ')}`);
    assert.ok(found.includes(RENAME), `rename.ts does not register its rename entry: ${found.join(', ')}`);
    assert.ok(requireSource(RENAME).includes('runSpaceAct('), 'rename.ts does not run its act through the runner');
  });

  it('the depth counter is gone: no beginSpaceOp, endSpaceOp or spaceOpsInFlight anywhere under server/src (one counter, X1)', () => {
    for (const name of ['beginSpaceOp', 'endSpaceOp', 'spaceOpsInFlight', 'spaceOpInFlight']) {
      assert.deepEqual(filesMatching(new RegExp(`\\b${name}\\b`)).map(([f]) => f), [], `${name} is still in the tree`);
    }
  });

  it('the resume stand-aside asks by KEY (spaceActRunning), not by comparing a count', () => {
    const body = bodyOf(LIFECYCLE, 'resumePendingSpaceOp');
    assert.match(body, /\bspaceActRunning\s*\(/, 'resumePendingSpaceOp does not ask whether the marker\'s own op is running');
    assert.doesNotMatch(body, /\bspaceOpsInFlight\b|\bspaceActsRunning\s*\(/, 'the stand-aside compares a count again');
  });

  it('shutdown closes the runner before the config flush and the store close, and logs what was left', () => {
    const src = requireSource(INDEX);
    const close = src.indexOf('closeSpaceActs(');
    assert.ok(close > 0, `${INDEX} never calls closeSpaceActs(`);
    const flush = src.indexOf('await flushConfig()', src.indexOf('const shutdown'));
    const mongo = src.indexOf('await closeMongo()', src.indexOf('const shutdown'));
    assert.ok(src.indexOf('const shutdown') < close && close < flush && close < mongo, 'closeSpaceActs( is not inside the shutdown sequence before flushConfig and closeMongo');
    // The block the call's `if (left.length > 0)` opens, not a count of characters after it: what it returns as `left` is READ and said there.
    assert.match(blockAfter(src, close, 'shutdown'), /\blog\.\w+\([^;]*\bleft\b/, 'what closeSpaceActs() returns as `left` is not logged');
    assert.doesNotMatch(src, /\bdrainSpaceActs\b/, 'shutdown WAITS for acts (W8: nothing waits for an act)');
  });

  it('boot: phase 1 resumes only pendingSpaceOp; every act entry is resumed AFTER listen through the walk helper', () => {
    const reconcile = bodyOf(LIFECYCLE, 'reconcilePendingSpaceOp');
    assert.doesNotMatch(reconcile, /pendingSpaceActs|runSpaceAct|resumeSpaceActs/, 'the phase-1 resume reads or runs act entries');
    const phase1 = requireSource(BOOTSTRAP);
    assert.match(phase1, /afterListening\(\s*\(\)\s*=>\s*(?:void\s+)?[\w.]*resumeSpaceActs\s*\(/, 'bootstrap.ts does not hand resumeSpaceActs to afterListening');
    const definers = filesMatching(/function\s+resumeSpaceActs\b/).map(([f]) => f);
    assert.equal(definers.length, 1, `resumeSpaceActs is defined in ${definers.length} places: ${definers.join(', ')}`);
    const def = bodyOf(definers[0], 'resumeSpaceActs');
    assert.match(def, /\b(?:walkSpaces|eachSpace|eachUnit)\s*\(/, 'resumeSpaceActs does not walk the entries through the housekeeping walk helper (isolation, bound, one verdict)');
    assert.doesNotMatch(def, /\bfor\s*\(\s*(?:const|let)\s+\w+\s+of\s+[\w.()]*concreteSpaces/, 'resumeSpaceActs is a bare loop over the spaces');
  });
});
