/**
 * Has everything a conclusion or an open STARTED finished — answered once, for every test that asserts an ABSENCE or reads the state after deferred work.
 *
 * ## The question it answers
 *
 * *"Is the instance idle: no member is still being told, no sync cycle is running, and no space act is registered, draining, running or due?"* Work
 * a settle starts is not awaited by the code that starts it — the relay and the cast `void` their acts, the gossip pass `void`s them, the notify is
 * deferred past the caller's save (design v5 section 1.1, 1.6, 6.1 X19, TS-6). A test that reads state, or asserts that something was NOT sent, right
 * after the call asserts about a moment the work had not reached: a *missing* request is only evidence once the three queues that could still send
 * it have drained. This module is that wait, in terms of the three queues themselves and never of milliseconds.
 *
 * ## The three queues, and the export each is read from
 *
 * - the notify queue — `notifySendsPending()` from `server/src/networks/notify-members.ts`: sends queued or in flight, zero when none;
 * - the sync engine — `syncCyclesInFlight()` from `server/src/sync/engine.ts`: cycles running now, zero when none;
 * - the space-act runner — `spaceActsRunning() === 0` from `server/src/spaces/space-act-runner.ts` AND no entry on the live config `registered`,
 *   `draining` or `running`, and no `owed` entry whose `retryAt` has passed at `now` (an owed entry with its `retryAt` in the future is not due:
 *   it is waiting on the clock, and a test that wants it runs the tick at a later `now`).
 *
 * The design names the three quantities and not their exports; these two names are this module's, and the implementation exports exactly them or
 * changes this file in the same commit. A queue whose export is missing THROWS ({@link serverQueues}) — never reads as idle, because an idle that
 * means "could not look" passes every absence assertion written after it.
 *
 * ## The guards a hand-written copy drops
 *
 * - **Idle must HOLD for a few turns, not be seen once.** A completion queues the next thing (a finished act writes its audit and queues a notice; a
 *   concluded round queues a notify on `setImmediate`), so the first idle reading can be the gap between two stages. {@link quiescent} wants
 *   `stable` consecutive idle turns of the event loop.
 * - **It throws, it does not return, when the instance never goes idle**, and the message says WHICH queue was busy.
 * - **Absence rows carry a positive twin.** This module cannot supply one: it says the queues are empty, not that the path under test sends at all.
 *   Every caller that asserts an absence asserts, in the same test, that the opposite configuration DOES send.
 *
 * ## What it does not do
 *
 * It does not pick a `now` (the caller passes the one its owed entries are measured against) and it does not stop or reset anything: resetting the
 * runner between rows is `resetRunnerForTest` (`_space-act-harness.mjs`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runnerIsIdle } from './_space-act-harness.mjs';
import { trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const NOTIFY_MODULE = '../../server/dist/networks/notify-members.js';
const ENGINE_MODULE = '../../server/dist/sync/engine.js';
const RUNNER_MODULE = '../../server/dist/spaces/space-act-runner.js';

/** `module[name]` as a function, or a failure naming the design's file and the export this helper reads from it. */
async function requiredFunction(specifier, name, meaning) {
  let mod;
  try { mod = await import(specifier); } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return assert.fail(`${specifier.replace('../../server/dist/', 'server/src/').replace(/\.js$/, '.ts')} does not exist — quiescence reads ${name}() from it: ${meaning}`);
  }
  assert.equal(typeof mod[name], 'function', `${specifier.replace('../../server/dist/', 'server/src/').replace(/\.js$/, '.ts')} does not export ${name} — quiescence reads it: ${meaning}`);
  return mod[name];
}

/**
 * The three queues of the server, as readers. `loader` is the loader module the instance was booted through (the entries are read from its live
 * config). Throws when an export is missing, naming it.
 */
export async function serverQueues(loader, { now } = {}) {
  const notifySendsPending = await requiredFunction(NOTIFY_MODULE, 'notifySendsPending', 'the number of notices queued or being sent to members');
  const syncCyclesInFlight = await requiredFunction(ENGINE_MODULE, 'syncCyclesInFlight', 'the number of sync cycles running now');
  await requiredFunction(RUNNER_MODULE, 'spaceActsRunning', 'the number of space-act bodies in the slot');
  const runner = await import(RUNNER_MODULE);
  return {
    notify: () => notifySendsPending(),
    cycles: () => syncCyclesInFlight(),
    runner: () => (runnerIsIdle(runner, loader, now ?? Date.now()) ? 0 : 1),
  };
}

/** The names of the queues that are busy, from readers that each answer a count (zero is idle). Pure: the fixture test drives it with fakes. */
export function busyQueues(queues) {
  return Object.entries(queues).filter(([, read]) => read() !== 0).map(([name]) => name);
}

/**
 * Resolve once every queue in `queues` has answered zero for `stable` consecutive turns of the event loop; THROW, naming the busy queues, after
 * `maxTurns` turns without that. Bounded by turns, never by milliseconds.
 */
export async function untilQuiescentOf(queues, { stable = 4, maxTurns = 4000 } = {}) {
  let idleTurns = 0;
  let busy = [];
  for (let i = 0; i < maxTurns; i++) {
    busy = busyQueues(queues);
    if (busy.length === 0) { if (++idleTurns >= stable) return; } else idleTurns = 0;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`the instance never went quiescent: still busy after ${maxTurns} turns: ${busy.join(', ')}`);
}

/**
 * Resolve once the live instance behind `loader` is quiescent (notify queue, sync cycles and the space-act runner all idle); `now` is the clock
 * the runner's owed entries are measured against. Call it before reading a state work was started for, and before every absence assertion.
 */
export async function quiescent(loader, opts = {}) {
  return untilQuiescentOf(await serverQueues(loader, { now: opts.now }), opts);
}

/** The three queues {@link quiescent} reads, by name: what a table row may say covers a background job. */
export const QUEUE_NAMES = ['notify', 'cycles', 'runner'];

/**
 * Every background path in `server/src` that repeats on a clock, by a key that survives a line moving: `<file> :: <label>` for each `intervalJob(` (the
 * label is its first argument, a literal or a `const` of the same file) and `<file> :: cron` for each file that registers a `schedule(` from `node-cron`
 * (the repeating timer's other owner, `util/armed-schedule.ts`). Derived from the source with comments blanked, never listed; the floor is the caller's.
 *
 * The queues the chain drains between a conclusion and its effects (the notify queue, the sync engine's cycles, the runner's registered acts) are the three
 * {@link QUEUE_NAMES}; no other module-level queue has a shape that can be derived, which is why a NEW queue is added to the helper by hand and a new
 * repeating JOB is caught here.
 */
export function backgroundJobsInSource() {
  const keys = [];
  for (const file of trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts'))) {
    if (file === 'server/src/util/interval-job.ts') continue;
    const src = blankComments(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/(?<![.\w$])intervalJob\s*\(\s*([^,]+),/g)) {
      const arg = m[1].trim();
      const literal = /^'([^']*)'$/.exec(arg)?.[1];
      const named = /^[A-Za-z_$][\w$]*$/.test(arg) ? new RegExp(`const\\s+${arg}\\s*=\\s*'([^']*)'`).exec(src)?.[1] : undefined;
      assert.ok(literal ?? named, `${file}: intervalJob(${arg}, ...) has a label this helper cannot resolve to a string: name it with a literal or a const of the same file`);
      keys.push(`${file} :: ${literal ?? named}`);
    }
    if (/import\s*\{[^}]*\bschedule\b[^}]*\}\s*from\s*'node-cron'/.test(src)) keys.push(`${file} :: cron`);
  }
  return keys;
}

/** Background jobs whose work the three queues DRAIN, with the queues that do. A job here is awaited by {@link quiescent} through them. */
export const COVERED_BY_QUEUES = {
  'server/src/networks/round-expiry.ts :: Vote round expiry': ['runner', 'notify'],
  'server/src/sync/scheduler.ts :: cron': ['cycles'],
};

/** Background jobs {@link quiescent} does NOT wait for, each with the one line that says why a test window may ignore it. */
export const UNAWAITED_BACKGROUND = {
  'server/src/api/invite-sessions.ts :: Invite session purge': 'drops expired in-memory invite sessions; sends and writes no network state',
  'server/src/audit/change-retention.ts :: Audit change retention': 'redacts aged audit `changes`; touches no round, act, notice or cycle',
  'server/src/brain/candidate-prune.ts :: Candidate prune': 'prunes link candidates inside a space; no network state',
  'server/src/brain/embed-worker.ts :: Brain embedding stall sweep': 'requeues stalled embedding jobs; local derived data only',
  'server/src/brain/embed-worker.ts :: Brain embedding heartbeat': 'a liveness stamp for the embedding worker; no network state',
  'server/src/brain/reindex.ts :: Reindex watcher': 'advances this instance\'s own index builds; no network state',
  'server/src/brain/tombstone-prune.ts :: Tombstone prune': 'prunes old tombstones after their retention; sends nothing and starts no round or act',
  'server/src/brain/ttl-sweep.ts :: TTL sweep': 'deletes records past their LOCAL retention; its tombstones travel on a later cycle, and it starts no round, act or notice',
  'server/src/files/media/worker.ts :: Media stall sweep': 'requeues stalled media embedding jobs; local derived data only',
  'server/src/files/media/worker.ts :: Media provider refresh': 'refreshes the media provider list; no network state',
  'server/src/index.ts :: Stale chunk cleanup': 'removes abandoned upload chunks from disk; no network state',
  'server/src/metrics/space-activity-store.ts :: Space activity flush': 'flushes activity counters to the store; no network state',
  'server/src/util/horizon-holds.ts :: Horizon hold watchdog': 'warns about a held read horizon; sends nothing',
  'server/src/webhooks/dispatcher.ts :: Webhook retry poll': 'retries OPERATOR webhooks, never a member notice or a round; a row asserting a webhook ABSENCE (R-X10d) drains the dispatcher itself, since it is not a network-state writer',
  'server/src/db/backup-scheduler.ts :: cron': 'dumps the database on the operator\'s schedule; writes no network state',
  'server/src/brain/dupe-scanner.ts :: cron': 'off by default; writes duplicate candidates inside a space, no network state',
  'server/src/brain/contradiction-scanner.ts :: cron': 'off by default; writes contradiction candidates inside a space, no network state',
};
