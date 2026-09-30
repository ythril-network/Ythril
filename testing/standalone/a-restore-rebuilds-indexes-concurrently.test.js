/**
 * A restore answers in time however many spaces the instance holds.
 *
 * ## The failure
 *
 * `POST /api/admin/data/restore` rebuilds every space's vector indexes before it answers, and it did so ONE
 * SPACE AT A TIME. Each index is dropped and recreated, about two seconds apiece, several per space — so the
 * request grew by several seconds per space. CI's instance held enough test spaces when
 * `restore-preserves-recall` ran that the request passed 300 s, the client gave up, and every later suite
 * read a dead socket. An operator with many spaces behind a proxy's idle timeout would see a failed restore
 * that actually succeeded.
 *
 * ## What this pins
 *
 * - The shared bounded-concurrency helper (`util/map-limit.ts`) really bounds, keeps order, and runs every
 *   item concurrently up to its limit.
 * - The restore route rebuilds through it, rather than awaiting each space in a loop.
 *
 * Run: node --test testing/standalone/a-restore-rebuilds-indexes-concurrently.test.js (after `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankComments } from './_strip-comments.mjs';

let mapLimit;
before(async () => { ({ mapLimit } = await import('../../server/dist/util/map-limit.js')); });

describe('mapLimit, the one bounded-concurrency helper', () => {
  it('never has more than the limit in flight, and keeps the input order', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10, 15], 3, async (ms, i) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, ms));
      inFlight--;
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 3, `peak concurrency was ${peak}, not the limit`);
  });

  it('runs concurrently: six 50 ms items at limit 3 finish in about two rounds, not six', async () => {
    const t0 = Date.now();
    await mapLimit([1, 2, 3, 4, 5, 6], 3, () => new Promise(r => setTimeout(r, 50)));
    const took = Date.now() - t0;
    assert.ok(took < 250, `took ${took} ms — the items ran one after another`);
  });

  it('an empty list resolves at once to an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });
});

describe('the restore route', () => {
  const src = blankComments(readFileSync('server/src/api/data.ts', 'utf8'));
  const at = src.indexOf('await restoreDatabase(');
  const body = src.slice(at, src.indexOf('res.json({ ok: true, vectorIndexes', at));

  it('found the rebuild block', () => {
    assert.ok(at > 0 && body.includes('reconcileSpaceSearchIndexes'), 'the restore rebuild block moved; re-point this gate');
  });

  it('rebuilds the spaces through mapLimit, not one awaited space at a time', () => {
    assert.match(body, /mapLimit\(/, 'the restore rebuild no longer goes through the shared bounded helper');
    assert.doesNotMatch(body, /for\s*\([^)]*\)\s*\{[^}]*await\s+reconcileSpaceSearchIndexes/s,
      'a space-by-space awaited loop is back: the request grows with every space');
  });
});
