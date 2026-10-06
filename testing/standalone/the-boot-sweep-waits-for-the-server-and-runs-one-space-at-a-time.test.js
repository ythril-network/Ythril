/**
 * The boot suppression sweep starts once the server is LISTENING, and sweeps one space at a time (bundle-30 I8,
 * pre-ship performance lens).
 *
 * ## The defect
 *
 * `sweepEverySpaceAtBoot` queued every space's sweep at once, from the bootstrap — before `index.ts` had called
 * `listen`. Each sweep is an unindexed `embedding: {$exists: true}` scan per record kind plus the files collection, so
 * an instance with many spaces started its life with every one of those scans in flight together, competing with the
 * boot's own index builds and with the first requests.
 *
 * ## What is asserted
 *
 * - `afterListening` (the one place "once the server listens" is answered) holds work until `markListening`, and
 *   runs work handed to it afterwards at once — so the setup route, which runs after the server listens, is not held.
 * - The listen callback is what marks it, and the bootstrap starts the sweep through it.
 * - The sweep is a promise that settles when every space is swept, awaiting each space before the next.
 *
 * Run: node --test testing/standalone/the-boot-sweep-waits-for-the-server-and-runs-one-space-at-a-time.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const src = (f) => stripComments(readFileSync(f, 'utf8'));
const MODULE = 'server/dist/util/after-listening.js';

describe('the boot sweep waits for the server and runs one space at a time', () => {
  it('afterListening holds work until the server listens, and runs it at once afterwards', async () => {
    assert.ok(existsSync(MODULE), 'there is no one place that answers "once the server listens"');
    const { afterListening, markListening } = await import(`../../${MODULE}`);
    const ran = [];
    afterListening(() => ran.push('early'));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(ran, [], 'work ran before the server was listening');
    markListening();
    assert.deepEqual(ran, ['early'], 'work held for the listen did not run when it came');
    afterListening(() => ran.push('late'));
    assert.deepEqual(ran, ['early', 'late'], 'work handed over after the listen was held');
  });

  it('the listen callback marks it, and the bootstrap starts the sweep through it', () => {
    const index = src('server/src/index.ts');
    const at = index.indexOf('server.listen(');
    assert.ok(at > 0, 'index.ts no longer calls server.listen — re-anchor this gate');
    assert.match(index.slice(at, index.indexOf('});', at)), /markListening\(\)/, 'the listen callback does not mark the server listening');
    const boot = bodyOf(src('server/src/bootstrap.ts'), 'startConfiguredInstanceServices');
    assert.match(boot, /afterListening\([^]*sweepEverySpaceAtBoot/, 'the bootstrap starts the sweep without waiting for the listen');
  });

  it('the sweep settles once every space is swept, one space at a time', () => {
    const body = bodyOf(src('server/src/brain/suppression-sweep.ts'), 'sweepEverySpaceAtBoot');
    assert.match(body, /async function sweepEverySpaceAtBoot\([^)]*\):\s*Promise<void>/, 'the boot sweep is not a promise of its own completion');
    // The walk is `eachSpace` (Q-274, bundle-53 G18). One space at a time is its default, so a `limit` option is how this
    // would stop being true: each sweep is an unindexed scan per record kind.
    assert.match(body, /\bawait eachSpace\(/, 'the boot sweep does not await a walk over the spaces through eachSpace');
    const walk = body.slice(body.search(/\beachSpace\(/));
    assert.match(walk, /\bconcreteSpaces\(\)/, 'the boot sweep no longer walks concreteSpaces() — re-anchor this gate');
    assert.doesNotMatch(walk, /\blimit\s*:/, 'the boot sweep walks several spaces at once');
    assert.match(walk, /\bawait\s+\w*[sS]weep\w*\(/, 'the boot sweep starts a space\'s sweep without waiting for it');
  });
});
