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
 * The engine's size is NOT asserted here. It is frozen in the size ratchet (`_oversize-files.mjs`), and by owner
 * rule (2026-09-28) crossing a size limit flags a file for decomposition rather than failing a build — that is the
 * ratchet's report, not this gate's.
 *
 * ## Seen red
 *
 * Red on 797dbb2e: `batchUpsertBySeq` is declared in `sync/engine.ts` and `sync/arrivals.ts` does not exist.
 *
 * Run: node --test testing/standalone/the-pull-page-write-lives-with-the-arrival-writer.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { topLevelFunctions } from './_call-graph.mjs';
import { stripComments } from './_strip-comments.mjs';

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
});
