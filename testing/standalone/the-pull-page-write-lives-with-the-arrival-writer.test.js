/**
 * The pull's page write lives in `sync/arrivals.ts`, and moving it out of `sync/engine.ts` does not grow the engine
 * (`Q-107` part 1, design v3 item 1).
 *
 * ## The rule
 *
 * `batchUpsertBySeq` stored a pulled page in the engine, with its own subset of the arrival preconditions. The
 * arrival writer owns all of them now, and the page write moves INTO it rather than being wrapped by it: a
 * wrapper leaves the old function callable, and a second caller of the old one is a door without the writer's
 * guards. So it is not declared in the engine any more, and it is declared beside `writeArrivals`.
 *
 * The engine is frozen in the size ratchet (`_oversize-files.mjs`), and a move OUT of a frozen file that leaves it
 * larger is not a move. Its limit is read from the ratchet rather than restated here, so lowering the frozen
 * entry when the file shrinks tightens this too.
 *
 * ## Seen red
 *
 * Red on 797dbb2e: `batchUpsertBySeq` is declared in `sync/engine.ts` and `sync/arrivals.ts` does not exist. The size
 * half is green there (784 code lines against a frozen 802) and was seen red by planting lines in the engine by
 * hand and removing them by hand.
 *
 * Run: node --test testing/standalone/the-pull-page-write-lives-with-the-arrival-writer.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { topLevelFunctions } from './_call-graph.mjs';
import { stripComments } from './_strip-comments.mjs';
import { FROZEN, codeLines, oversizeFiles } from './_oversize-files.mjs';

const ENGINE = 'server/src/sync/engine.ts';
const ARRIVALS = 'server/src/sync/arrivals.ts';
const PAGE_WRITE = 'batchUpsertBySeq';

const declared = (file) => (existsSync(file) ? [...topLevelFunctions(stripComments(readFileSync(file, 'utf8'))).keys()] : []);

describe('the pull page write lives with the arrival writer', () => {
  it('the engine is the file this gate thinks it is (floor)', () => {
    const fns = declared(ENGINE);
    assert.ok(fns.length >= 10, `only ${fns.length} function(s) declared in ${ENGINE} — the parse is broken, or the engine moved`);
    assert.ok(fns.includes('pullFromPeer'), `${ENGINE} declares no pullFromPeer — re-anchor this gate`);
  });

  it('the engine no longer declares the page write', () => {
    assert.ok(!declared(ENGINE).includes(PAGE_WRITE),
      `${ENGINE} still declares ${PAGE_WRITE}: the pull stores its page outside the arrival writer, with its own `
      + 'subset of the preconditions');
  });

  it('the arrival writer\'s module declares it, beside writeArrivals', () => {
    const fns = declared(ARRIVALS);
    assert.ok(fns.includes('writeArrivals'), `${ARRIVALS} declares no writeArrivals`);
    assert.ok(fns.includes(PAGE_WRITE), `${ARRIVALS} declares no ${PAGE_WRITE} — it was dropped rather than moved`);
  });

  it('and the engine did not grow past its frozen size doing it', () => {
    assert.ok(ENGINE in FROZEN, `${ENGINE} has no frozen entry in _oversize-files.mjs — re-anchor this gate`);
    const code = codeLines(readFileSync(ENGINE, 'utf8'));
    const over = oversizeFiles([{ file: ENGINE, code }]);
    assert.deepEqual(over, [],
      `${ENGINE} is ${code} code lines, over its frozen ${FROZEN[ENGINE]}. Moving the page write out must leave the `
      + 'engine smaller, not hand its lines to new pull plumbing');
  });
});
