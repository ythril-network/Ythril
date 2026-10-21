/**
 * A restore answers in time however many spaces the instance holds.
 *
 * ## The failure
 *
 * `POST /api/admin/data/restore` rebuilt every space's vector indexes before it answered, and it did so ONE
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
 * - Since bundle-157 the restore is a set of space acts: the route checks the backup, registers one act per
 *   space and answers `202`, and each space's data and indexes are replaced by its act's body in the restore
 *   lane. So the request does no per-space work at all - no load, no index build - and its time does not grow
 *   with the spaces. The progress and the index results are in `GET /restore`.
 *
 * Run: node --test testing/standalone/a-restore-rebuilds-indexes-concurrently.test.js (after `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankComments } from './_strip-comments.mjs';
import { sleep } from '../_shared/sleep.mjs';

let mapLimit;
before(async () => { ({ mapLimit } = await import('../../server/dist/util/map-limit.js')); });

describe('mapLimit, the one bounded-concurrency helper', () => {
  it('never has more than the limit in flight, and keeps the input order', async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit([30, 5, 20, 1, 10, 15], 3, async (ms, i) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await sleep(ms);
      inFlight--;
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3, 4, 5]);
    assert.equal(peak, 3, `peak concurrency was ${peak}, not the limit`);
  });

  it('runs concurrently: six 50 ms items at limit 3 finish in about two rounds, not six', async () => {
    const t0 = Date.now();
    await mapLimit([1, 2, 3, 4, 5, 6], 3, () => sleep(50));
    const took = Date.now() - t0;
    assert.ok(took < 250, `took ${took} ms — the items ran one after another`);
  });

  it('an empty list resolves at once to an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });
});

describe('the restore route', () => {
  const src = blankComments(readFileSync('server/src/api/data.ts', 'utf8'));
  const at = src.indexOf('dataRouter.post(\'/restore\'');
  const body = src.slice(at, src.indexOf('dataRouter.', at + 1));

  it('found the restore handler', () => {
    assert.ok(at > 0 && body.includes('startRestore('), 'the restore handler moved or no longer registers its acts; re-point this gate');
  });

  it('answers 202 once the acts are registered, and does no per-space data or index work in the request', () => {
    assert.match(body, /status\(202\)/, 'the restore route no longer answers 202 at registration: the request waits for the work again');
    for (const work of ['restoreDatabase(', 'reconcileSpaceSearchIndexes(', 'ensureEdgeIdentityIndex(', 'ensureEdgeGuardIndex(', 'initSpace(']) {
      assert.ok(!body.includes(work), `the restore request does ${work.slice(0, -1)} itself: its time grows with every space again`);
    }
  });
});
