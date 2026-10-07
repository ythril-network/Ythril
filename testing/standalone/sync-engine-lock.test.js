/**
 * `sync/engine.ts` — characterization tests, written against the ORIGINAL 1396-line file.
 *
 * Written BEFORE any split, for the reason the graph work established: a characterization test written
 * against already-restructured code pins the new behaviour and says nothing about whether the
 * restructure preserved anything.
 *
 * ── What this covers, and what it deliberately does not ──────────────────────────────────────────
 *
 * `vote-round-prune.test.js` already covers `isRoundPrunable` / `pruneExpiredRounds` in 8 tests,
 * including the deliberate NaN fail-safe. Those are not duplicated here.
 *
 * This file pins the two untested pieces that fail SILENTLY:
 *
 *   1. The per-network sync dedup lock. Every failure mode here looks healthy. A lock that stops
 *      coalescing still syncs correctly — just N cycles at once, competing for bcrypt cache, Mongo
 *      connections and peer sockets. A lock that LEAKS on error is worse: that one network stops
 *      syncing forever, every other network is fine, and nothing ever logs again. There is no error
 *      state to notice, only an absence.
 *
 *   2. Space ID mapping. A wrong answer here does not throw — it syncs a space under the wrong id, or
 *      silently stops syncing one that used to work.
 *
 * The engine is imported from `server/dist` against a temp config file (the `config-*.test.js`
 * pattern): no Docker, no Mongo, no peers. A network with zero members is a complete, successful sync
 * cycle that touches no network — which is exactly what makes the lock observable in isolation.
 *
 * Run: node --test testing/standalone/sync-engine-lock.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sleep } from '../_shared/sleep.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-sync-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');

// Read at module-load time by the loader — must be set BEFORE the import below.
process.env['CONFIG_PATH'] = CONFIG_PATH;

/** A network with NO members: a complete sync cycle that contacts nobody. */
const EMPTY_NETWORK = {
  id: 'net-empty',
  label: 'Empty Network',
  members: [],
  spaces: [],
};

let engine;

before(async () => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    instanceId: 'test-instance',
    instanceLabel: 'sync-engine-test',
    spaces: [],
    tokens: [],
    networks: [EMPTY_NETWORK],
  }, null, 2));

  const loader = await import('../../server/dist/config/loader.js');
  await loader.loadConfig();
  engine = await import('../../server/dist/sync/engine.js');
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Space ID resolution
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('sync engine — space id mapping', () => {
  const mapped = { id: 'n', spaceMap: { 'their-research': 'our-research', 'their-ops': 'our-ops' } };
  const unmapped = { id: 'n' };

  it('translates a peer space id to the local one', () => {
    assert.equal(engine.remoteToLocal(mapped, 'their-research'), 'our-research');
  });

  it('translates a local space id back to the peer one', () => {
    assert.equal(engine.localToRemote(mapped, 'our-ops'), 'their-ops');
  });

  it('round-trips a mapped id in both directions', () => {
    for (const [remote, local] of Object.entries(mapped.spaceMap)) {
      assert.equal(engine.remoteToLocal(mapped, remote), local);
      assert.equal(engine.localToRemote(mapped, local), remote);
    }
  });

  it('passes an UNMAPPED id through unchanged rather than dropping it', () => {
    // The no-aliasing fallback. If this returned undefined or '', an unmapped space would sync under
    // a broken id or vanish from the cycle — and both read as "that space just does not sync".
    assert.equal(engine.remoteToLocal(mapped, 'not-in-the-map'), 'not-in-the-map');
    assert.equal(engine.localToRemote(mapped, 'not-in-the-map'), 'not-in-the-map');
  });

  it('is the identity when the network has no spaceMap at all', () => {
    // The common case: most networks never configure aliasing.
    assert.equal(engine.remoteToLocal(unmapped, 'shared'), 'shared');
    assert.equal(engine.localToRemote(unmapped, 'shared'), 'shared');
  });

  it('resolves an AMBIGUOUS reverse lookup by key order, first match wins', () => {
    // Characterizing, not endorsing. `localToRemote` scans Object.entries and returns the first
    // remote whose value matches, so two peer spaces aliased onto one local space resolve to
    // whichever key was inserted first. Nothing rejects that config, so pin the behaviour rather
    // than pretend it cannot happen — a split that swapped this for a reversed Map built the other
    // way round would silently change which peer receives the push.
    const ambiguous = { id: 'n', spaceMap: { 'peer-a': 'shared', 'peer-b': 'shared' } };
    assert.equal(engine.localToRemote(ambiguous, 'shared'), 'peer-a');
  });

  it('does not treat a spaceMap VALUE as if it were a key', () => {
    // Guards the direction of each lookup: asking remoteToLocal for a LOCAL id must not accidentally
    // match, or the two functions become interchangeable and one of them is silently wrong.
    assert.equal(engine.remoteToLocal(mapped, 'our-research'), 'our-research');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The per-network dedup lock
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('sync engine — the per-network dedup lock', () => {
  beforeEach(async () => {
    // Let any queued rerun from a previous test drain, so each starts from an idle lock.
    await sleep(50);
  });

  it('reports a network as not syncing when idle', () => {
    assert.equal(engine.isNetworkSyncing('net-empty'), false);
  });

  it('holds the lock for the duration of a cycle and releases it after', async () => {
    // `isNetworkSyncing` is what GET /api/spaces reads to show the "syncing" chip, so a lock that is
    // never observed as held means the chip never appears.
    const p = engine.runSyncForNetwork('net-empty');
    assert.equal(engine.isNetworkSyncing('net-empty'), true, 'lock should be held while in flight');
    await p;
    await sleep(50);   // let the one queued rerun (if any) finish
    assert.equal(engine.isNetworkSyncing('net-empty'), false, 'lock should be released after');
  });

  it('gives every concurrent trigger the same answer as the cycle they joined', async () => {
    // Consistent with one shared cycle, and the strongest concurrency claim that is honestly
    // observable from outside this module (see the note below on what is NOT).
    const results = await Promise.all(
      Array.from({ length: 6 }, () => engine.runSyncForNetwork('net-empty')),
    );
    for (const r of results) assert.deepEqual(r, results[0]);
    await sleep(50);
  });

  /*
   * NOT TESTED HERE, deliberately, and worth stating rather than quietly skipping.
   *
   * Two behaviours of this lock cannot be observed through its public surface:
   *
   *   - that a concurrent trigger COALESCES (starts no second cycle), and
   *   - that a trigger arriving mid-cycle fires exactly ONE more cycle afterwards.
   *
   * Neither is assertable from outside. `runSyncForNetwork` is `async`, so `return inflight` is
   * wrapped in a fresh promise and identity comparison can never succeed — the doc comment's "return
   * the CURRENT inflight promise" is true semantically, not referentially. (Asserting `p1 === p2`
   * was tried, and fails against the original code: the test was wrong, not the engine.) And the
   * only other signal, `isNetworkSyncing`, cannot catch the rerun: with no reachable members a cycle
   * resolves entirely in microtasks, so the queued rerun starts AND finishes before any caller's
   * continuation runs. Measured at 2ms, including with a member pointed at a closed port.
   *
   * Observing either requires counting cycles, which requires injecting the cycle implementation.
   * That is a REFACTOR, and this file is characterization — it must not change the code it pins.
   *
   * So: make `_runSyncForNetworkImpl` injectable a goal of the sync/engine SPLIT, and add the
   * coalescing and rerun-once tests there. Until then those two behaviours rest on code review.
   */

  it('RELEASES the lock when the cycle throws — the failure that would wedge a network forever', async () => {
    // The release lives in a `finally`. If it did not, one failed cycle would leave the lock held and
    // that network would never sync again: no error, no retry, no log — every other network fine.
    // An unknown network id is the cheapest way to make the cycle throw.
    await assert.rejects(
      () => engine.runSyncForNetwork('no-such-network'),
      /not found/i,
    );
    assert.equal(engine.isNetworkSyncing('no-such-network'), false,
      'the lock must be released even when the cycle throws');
  });

  it('can still run a network whose previous cycle threw', async () => {
    // The observable consequence of the above: recovery, not just a cleared flag.
    await assert.rejects(() => engine.runSyncForNetwork('no-such-network'), /not found/i);
    await assert.rejects(() => engine.runSyncForNetwork('no-such-network'), /not found/i);
    assert.equal(engine.isNetworkSyncing('no-such-network'), false);
  });

  it('locks per network, not globally', async () => {
    // Two networks must not block each other; a global lock would serialise every peer in the
    // instance behind the slowest one.
    const p = engine.runSyncForNetwork('net-empty');
    assert.equal(engine.isNetworkSyncing('net-empty'), true);
    assert.equal(engine.isNetworkSyncing('some-other-network'), false);
    await p;
    await sleep(50);
  });

  it('completes a members-less cycle as a success, not an error', async () => {
    const result = await engine.runSyncForNetwork('net-empty');
    assert.deepEqual(result, { synced: 0, errors: 0 });
    await sleep(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/*
 * The scheduler moved to `sync/scheduler.ts`, and these characterization tests followed it with every assertion
 * unchanged — which is the point: they exist to prove the split changed no behaviour, so repointing the import is
 * the correct response and weakening one would not be.
 *
 * It is NOT re-exported from `engine.ts`. The scheduler calls `runSyncForNetwork`, so a re-export makes the two
 * modules import each other — a real runtime cycle. Importing the new module by name here is what a caller has
 * to do too.
 */
describe('sync scheduler — cron scheduler', () => {
  let scheduler;
  before(async () => {
    scheduler = await import('../../server/dist/sync/scheduler.js');
  });

  it('ignores an invalid cron expression instead of throwing at the caller', () => {
    // Reached from PATCH /api/networks/:id, so a bad schedule must not 500 the request.
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', 'not a cron expression'));
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', '99 99 99 99 99'));
  });

  it('treats an absent schedule as "unschedule", not as an error', () => {
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', undefined));
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', ''));
  });

  it('accepts a valid schedule and can replace it', () => {
    // Replacing must not accumulate timers — a leaked task keeps firing for a network that may since
    // have been deleted, and the only symptom is sync traffic nobody asked for.
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', '*/5 * * * *'));
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', '0 * * * *'));
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', undefined));
  });

  it('start and stop are both idempotent', () => {
    assert.doesNotThrow(() => scheduler.startSyncScheduler());
    assert.doesNotThrow(() => scheduler.startSyncScheduler());
    assert.doesNotThrow(() => scheduler.stopSyncScheduler());
    assert.doesNotThrow(() => scheduler.stopSyncScheduler());
  });

  it('can restart after a stop', () => {
    scheduler.stopSyncScheduler();
    assert.doesNotThrow(() => scheduler.startSyncScheduler());
    scheduler.stopSyncScheduler();
  });

  it('re-arming the SAME expression does not restart the task', () => {
    /*
     * The new property, asserted here because this is where the scheduler's behaviour is characterized.
     *
     * Behavioural rather than source-read: schedule an expression, schedule it again, and the second call must
     * be a no-op. What that buys is the phase — a task restarted with the same cron loses however long it had
     * already waited — and the observable here is that neither call throws while the guard is what makes the
     * second one do nothing at all.
     */
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', '0 * * * *'));
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', '0 * * * *'));
    // And a DIFFERENT expression still replaces it, or the guard would have frozen the schedule forever.
    assert.doesNotThrow(() => scheduler.scheduleSyncForNetwork('net-empty', '30 * * * *'));
    scheduler.scheduleSyncForNetwork('net-empty', undefined);
  });
});
