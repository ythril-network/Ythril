/**
 * What the server is doing on one collection RIGHT NOW — the question "is a write of mine still alive", answered
 * from the server's own account (`currentOp`) rather than from the client's promise.
 *
 * ## Why a module
 *
 * A client promise that settled says the CLIENT stopped waiting. A driver timer fires before the server's own, so a
 * write answered "timed out" can still be alive in the server and land later (`Q-372`). Everything that must know the
 * write has really ENDED — a lock handed back (`_write-faults.mjs`), a space wiped (`_push-door.mjs`), the tests of
 * both — asks the server, and asks it the same way: this.
 *
 * ## The guard a hand-written copy drops
 *
 * **The poll's own command.** `currentOp` lists itself when it runs; filtered to a collection's namespace it does not
 * (its namespace is `admin.$cmd`), but a filter that was typed wrongly would match nothing, and "no active operation"
 * would pass over a write that is very much alive. So the namespace is built from the connected database's own name,
 * and `activeOperations` is exercised against a real stalled write by the tests that use it (`a-released-lock-leaves-no-live-write-db`).
 */

import assert from 'node:assert/strict';
import { waitFor, holdsWithin } from '../_shared/wait-for.mjs';
import { sleep } from '../_shared/sleep.mjs';

/** Command names a `command` operation carries when it is a write (`findAndModify` is the one that is reported as a command). */
const WRITE_COMMANDS = new Set(['findAndModify', 'findandmodify', 'insert', 'update', 'delete']);

/**
 * The WRITES active on `collName` of the connected database: `[{ op, ns, secs_running, writeConflicts, … }]`.
 *
 * **Writes only, and why.** A change stream's cursor is a `getMore` that is active for as long as the stream is open
 * (the push door's spaces keep one on their collections), so "no active operation" over everything would never hold
 * and a drain would wait for ever. Nothing but a write can land a document after the caller moved on.
 */
export async function activeOperations(mongo, collName) {
  const ns = `${mongo.getDb().databaseName}.${collName}`;
  const r = await mongo.getMongo().db('admin').command({ currentOp: 1, active: true, ns });
  return r.inprog.filter(o => ['insert', 'update', 'remove'].includes(o.op)
    || (o.op === 'command' && WRITE_COMMANDS.has(Object.keys(o.command ?? {})[0])));
}

/** How long a drain waits for the server to go quiet before it throws, unless the caller says otherwise. */
export const DEFAULT_DRAIN_MS = 5000;

/** How long a fixture waits for the write it stalled to become ALIVE in the server, unless the caller says otherwise. */
export const DEFAULT_START_MS = 5000;

/**
 * Wait until a write is ALIVE on `collName` — the half of the question `drainWrites` does not ask ("has it started",
 * where a drain asks "has it ended"). Answers `true` when one became active, `false` when none did within `startMs`.
 *
 * ## What it prevents
 *
 * A test that stalls a write behind a lock and then releases, wipes or counts while the write has not yet reached
 * the server proves nothing: the lock was never held against anything. The caller asserts on the answer with its own
 * message (`fixture: the write behind the lock was never active — the stall is not real`), so a stall that never took
 * hold fails as a broken fixture rather than passing as a held bound. It answers a verdict and does not throw because
 * what to say about an absent write is the caller's: a drain's failure is a defect, this one's is a fixture.
 *
 * @param {object} mongo  the server's `db/mongo.js` module
 * @param {string} collName
 * @param {{ startMs?: number }} [o]
 * @returns {Promise<boolean>}
 */
export function waitForLiveWrite(mongo, collName, { startMs = DEFAULT_START_MS } = {}) {
  return holdsWithin(async () => (await activeOperations(mongo, collName)).length > 0, startMs, 10,
    { what: `a write alive on ${collName} in ${mongo.getDb().databaseName}` });
}

/**
 * Whether a write was alive on `collName` at ANY moment before `done()` turned true — the proof that a lock stalled
 * something, for a call that is waiting for the whole of a bound. Polled every 50 ms: the stall lasts far longer.
 *
 * Not {@link waitForLiveWrite}: that waits for the FIRST live write and stops; this watches a window that is closed
 * by the caller's own call answering, and answers after it. The loop has no deadline of its own (`done` is the end).
 *
 * @param {object} mongo
 * @param {string} collName
 * @param {() => boolean} done
 * @returns {Promise<boolean>}
 */
export async function sawLiveWrite(mongo, collName, done) {
  let saw = false;
  while (!done()) {
    if (!saw && (await activeOperations(mongo, collName)).length > 0) saw = true;
    await sleep(50);
  }
  return saw;
}

/**
 * Wait until no write is alive on ANY of `collNames`, or THROW naming the collections and what was still running.
 *
 * ## What it prevents
 *
 * A caller that releases a lock, or wipes a space, and moves on while a write it stalled is still alive in the server:
 * the write lands after the caller's next step (`Q-372`). Two helpers needed the wait (`_write-faults.mjs` `release`,
 * `_push-door.mjs` `wipe`); this is the one copy, and it is where the forgettable half lives — **it throws**. A drain
 * that gave up quietly would hand back a clean-looking collection over a live write, which is the defect.
 *
 * @param {object} mongo  the server's `db/mongo.js` module
 * @param {readonly string[]} collNames  at least one — a drain over nothing waits for nothing
 * @param {{ drainMs?: number }} [o]
 */
export async function drainWrites(mongo, collNames, { drainMs = DEFAULT_DRAIN_MS } = {}) {
  assert.ok(collNames.length > 0, 'a drain over no collections waits for nothing');
  const alive = async () => (await Promise.all(collNames.map(async c => (await activeOperations(mongo, c)).map(o => ({ ...o, collName: c }))))).flat();
  await waitFor(async () => (await alive()).length === 0, drainMs, 25,
    async () => `still alive: ${describeOperations(await alive())}`,
    { what: `no write alive on ${collNames.join(', ')} in ${mongo.getDb().databaseName}` });
}

/** One line per operation, for a failure message. */
export function describeOperations(ops) {
  return ops.map(o => `${o.op} on ${o.ns} running ${o.secs_running ?? '?'} s${o.writeConflicts ? `, ${o.writeConflicts} write conflicts` : ''}`).join('; ');
}
