/**
 * The walk UP a derived row's `parentFileId` chain is written in one module, and the suppression read, the move plan and the
 * leaked-rows repair all use it (bundle-113, Q-465; vet: challenge 3 "a 4th upward-walk copy", design r4 "one upward chain walk").
 *
 * ## The defect it prevents
 *
 * "Where does this derived row's chain end?" is asked three times in this tree, each with its own loop and its own polarity: the
 * suppression read (`ancestorSuppressed`: a missing ancestor means suppressed, fail closed), the move plan (`holdsAtDestination`,
 * `groupOf`: a chain that ends at an absent or flagged row is debris, one that does not end is foreign) and — new — the repair
 * (a chain that ends at an absent, flagged or foreign row is leaked, one that is too deep is KEPT). Three loops that each bound
 * the walk by `MAX_ANCESTRY` and each decide what "the end" means are three chances for the weaker one to win silently: the
 * repair would delete rows on a reading of the chain that the move plan, which keeps what it cannot explain, would refuse. The
 * walk is written once, with the caller choosing the fields it reads and what the end means.
 *
 * ## The rule, derived and never listed
 *
 *  1. Of every source file under `server/src`, those that contain an UPWARD ancestry loop — a `for` whose header bounds it by
 *     `MAX_ANCESTRY` and whose body READS a row's `parentFileId` to take the next step (a property read, not the filter key a
 *     DOWNWARD walk queries by) — are exactly ONE file. A second is a second copy of the walk.
 *  2. `brain/suppress-embeddings.ts` and `files/move-plan.ts` (the two sites the plan names, and the two that carry a copy today)
 *     and every module that exports `setRepairStepsForTest` (the repair: the seam its test needs) are that file, or import it and
 *     call one of the functions it exports.
 *  3. There is a repair (a floor: a gate over "every repair" that found none says nothing about the repair).
 *
 * The classifier is held by a positive and a negative control over synthetic sources, so a classifier that matched everything or
 * nothing cannot pass rule 1 by being wrong.
 *
 * The scan lists tracked files AND uncommitted ones (`untracked`): the walk module and the repair are new files, and a
 * tracked-only listing cannot see the change that is being made.
 *
 * Seen red: on d81be400 two files hold an upward loop (`suppress-embeddings.ts`, `move-plan.ts`) and no module exports the repair
 * seam. Mutation after the change (put back by hand): paste the loop back into `move-plan.ts`.
 *
 * Run: node --test testing/standalone/the-ancestry-walk-up-parentfileid-is-one-module-and-the-repair-uses-it.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom, blockAfter } from './_structural-window.mjs';
import { relativeImports } from './_call-graph.mjs';

/** A property READ of a row's `parentFileId`: how an upward walk takes its next step. A filter KEY (`{ parentFileId: ... }`) is not one. */
const READS_PARENT = /\.parentFileId\b|\[\s*['"]parentFileId['"]\s*\]/;

/** The bodies of every `for` loop in `src` whose header names `MAX_ANCESTRY`, with the header. `src` is comment-free. */
function ancestryLoops(src) {
  const loops = [];
  for (const m of src.matchAll(/\bfor\s*\(/g)) {
    const header = balancedFrom(src, m.index + m[0].length - 1, 'for header');
    if (!/\bMAX_ANCESTRY\b/.test(header)) continue;
    loops.push({ header, body: blockAfter(src, m.index + m[0].length - 1 + header.length, 'for body') });
  }
  return loops;
}
/** Whether `src` walks UP a `parentFileId` chain: one of its ancestry loops reads a row's `parentFileId` to continue. */
const walksUp = (src) => ancestryLoops(src).some(l => READS_PARENT.test(l.body));

const SOURCES = readTrackedSources('server/src', { ext: ['.ts'], floor: 300, untracked: true })
  .map(({ file, text }) => ({ file, src: stripComments(text) }));
const HAS = new Set(SOURCES.map(s => s.file));
const WALKERS = SOURCES.filter(s => walksUp(s.src)).map(s => s.file);
const exportedFunctions = (src) => [...src.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]);

describe('the walk up parentFileId is one module', () => {
  it('CONTROL: the classifier tells an upward loop from a downward one and from a loop that is not an ancestry walk', () => {
    const upward = 'for (let depth = 0; depth < MAX_ANCESTRY && typeof parentId === "string"; depth++) {\n  const parent = await read(parentId);\n  parentId = parent[\'parentFileId\'];\n}';
    const upwardInMemory = 'for (let depth = 0; depth < MAX_ANCESTRY; depth++) {\n  const parent = byId.get(at)?.parentFileId;\n}';
    const downward = 'for (let depth = 0; depth < MAX_ANCESTRY && frontier.length > 0; depth++) {\n  const rows = await files.find(asFilter({ parentFileId: { $in: part } })).toArray();\n  for (const r of rows) next.push(String(r["_id"]));\n}';
    const notAncestry = 'for (let i = 0; i < 3; i++) {\n  const parent = row.parentFileId;\n}';
    assert.equal(walksUp(upward), true, 'a loop that reads parentFileId off the row it fetched was not classified as an upward walk');
    assert.equal(walksUp(upwardInMemory), true, 'a loop that reads `.parentFileId` of an in-memory row was not classified as an upward walk');
    assert.equal(walksUp(downward), false, 'the downward walk (it queries BY parentFileId) was classified as an upward one');
    assert.equal(walksUp(notAncestry), false, 'a loop not bounded by MAX_ANCESTRY was classified as an ancestry walk');
  });

  it('exactly one source file under server/src holds an upward ancestry loop', () => {
    assert.equal(WALKERS.length, 1,
      `${WALKERS.length} files walk up a derived row's parentFileId chain, each bounded by MAX_ANCESTRY: ${JSON.stringify(WALKERS)}. `
      + 'The suppression read, the move plan and the repair must call one walk (the caller chooses the fields it reads and what the end of the chain means).');
  });

  it('the suppression read, the move plan and every repair use that one walk', () => {
    const repairs = SOURCES.filter(s => /\bsetRepairStepsForTest\b/.test(s.src)).map(s => s.file);
    assert.ok(repairs.length >= 1, 'no module exports setRepairStepsForTest: there is no leaked-rows repair for the walk to serve (a gate over "every repair" that found none says nothing)');
    const [owner] = WALKERS;
    assert.ok(owner, 'no module holds the walk');
    const ownerFns = exportedFunctions(SOURCES.find(s => s.file === owner).src);
    assert.ok(ownerFns.length >= 1, `${owner} holds the walk but exports no function: nothing can call it`);
    const consumers = ['server/src/brain/suppress-embeddings.ts', 'server/src/files/move-plan.ts', ...repairs];
    const failures = [];
    for (const file of [...new Set(consumers)]) {
      const source = SOURCES.find(s => s.file === file);
      assert.ok(source, `${file} is not under server/src any more — re-anchor this gate`);
      if (file === owner) continue;
      const imported = [...relativeImports(source.src, file, p => HAS.has(p)).values()].filter(i => i.file === owner).map(i => i.exported);
      const called = imported.filter(n => ownerFns.includes(n) && new RegExp(`\\b${n}\\s*\\(`).test(source.src));
      if (called.length === 0) failures.push(`${file} does not import and call a function of ${owner} (${ownerFns.join(', ')})`);
    }
    assert.deepEqual(failures, [], 'a module that asks "where does this derived row\'s chain end" without the one walk is the copy this gate exists for');
  });
});
