/**
 * What a test of a SPACE ACT (a deletion, a wipe or a rename of a space, registered and run by the runner) needs, answered once:
 * an act entry as it stands on disk, a latch, an ordered event log, and a way to wait until the runner is idle.
 *
 * ## The question each answers, and what a hand-written copy drops
 *
 * - {@link actEntry} / {@link seedActEntry} — *"what does a registered act look like in `config.pendingSpaceActs`"*. The shape is the
 *   design's `SpaceActEntry` (§2.6) and is spelled here once, so a test that stands an act up by hand cannot spell a field the
 *   runner does not read. It writes THROUGH `mutateConfig`, because an entry the loader's own writer never saw is not on disk.
 * - {@link deferred} — a latch a test releases. Ordering in these tests is by latches and an event log, never by a sleep or a
 *   timestamp (§6.1 v5, TS-2): a hook INSIDE the real body awaits a latch, and the test releases it.
 * - {@link eventLog} — one monotonic sequence written by the hooks and by the fake peer's handler, so *"A before B"* is a comparison
 *   of two integers.
 * - {@link runnerIsIdle} / {@link untilRunnerIdle} — *"nothing is registered-and-waiting, draining or running, and nothing owed is due"*.
 *   An absence assertion made before this holds asserts about a moment the work had not reached (§6.1 v5, TS-6). Bounded by TURNS of
 *   the event loop, never milliseconds, and it THROWS rather than returning when the runner never goes idle.
 *
 * ## What it does not do
 *
 * It does not replace a body, a hook or a knob: those are the runner's own `setSpaceActHooksForTest` / `setSpaceActKnobsForTest`
 * (design §2.5), which a test installs and the harness only resets (`resetRunnerForTest`, which also reopens a runner a test closed).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/** One act entry as the design's §2.6 spells it; `over` replaces fields. */
export function actEntry(over = {}) {
  return {
    id: randomUUID(), kind: 'wipe', localId: 'victim', rounds: [], postSteps: {},
    registeredAt: '2026-10-16T00:00:00.000Z', state: 'registered', attempts: 0,
    ...over,
  };
}

/** Stand an entry up in the live config through the loader's own writer; returns the entry. */
export async function seedActEntry(loader, over = {}) {
  const entry = actEntry(over);
  loader.mutateConfig(cfg => { (cfg.pendingSpaceActs ??= []).push(entry); });
  return entry;
}

/** Take every entry (and a `pendingSpaceOp`) off the live config. */
export function clearActEntries(loader) {
  loader.mutateConfig(cfg => { delete cfg.pendingSpaceActs; delete cfg.pendingSpaceOp; });
}

/** The entries now standing in the live config, as the loader holds them. */
export const entriesOf = (loader) => structuredClone(loader.getConfig().pendingSpaceActs ?? []);

/** A latch: `await latch.promise` parks, `latch.release()` lets it through; `latch.reached` resolves when a hook says it arrived. */
export function deferred() {
  let release; let arrive;
  const promise = new Promise(r => { release = r; });
  const reached = new Promise(r => { arrive = r; });
  return { promise, release, reached, arrive };
}

/** A monotonic event log: `mark('x')` appends, `at('x')` is the first sequence number of `x`, `before('a','b')` compares. */
export function eventLog() {
  const events = [];
  return {
    mark: (name, detail) => { events.push({ name, detail, n: events.length }); },
    at: (name) => events.find(e => e.name === name)?.n ?? -1,
    has: (name) => events.some(e => e.name === name),
    before(a, b) {
      const x = this.at(a); const y = this.at(b);
      assert.ok(x >= 0, `event '${a}' never happened (log: ${events.map(e => e.name).join(' < ')})`);
      assert.ok(y >= 0, `event '${b}' never happened (log: ${events.map(e => e.name).join(' < ')})`);
      return x < y;
    },
    names: () => events.map(e => e.name),
  };
}

/**
 * Is the runner idle: no body in the slot, no entry registered or draining, and no owed entry whose `retryAt` has passed at `now`?
 * Read from the runner's own exports (`spaceActsRunning`) and from the entries on the live config.
 */
export function runnerIsIdle(runner, loader, now = Date.now()) {
  if (runner.spaceActsRunning() !== 0) return false;
  return !entriesOf(loader).some(e => e.state === 'registered' || e.state === 'draining' || e.state === 'running'
    || (e.state === 'owed' && (e.retryAt === undefined || Date.parse(e.retryAt) <= now)));
}

/** Resolve once {@link runnerIsIdle}; throws (never returns) when it is not idle after `maxTurns` turns of the event loop. */
export async function untilRunnerIdle(runner, loader, { maxTurns = 4000, now } = {}) {
  for (let i = 0; i < maxTurns; i++) {
    if (runnerIsIdle(runner, loader, now ?? Date.now())) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`the runner never went idle: running=${runner.spaceActsRunning()}, entries=${JSON.stringify(entriesOf(loader).map(e => [e.kind, e.localId, e.state]))}`);
}

/**
 * A network of this instance holding `rounds`, as the config stores one: the smallest shape the settle reads. `spaces` are the
 * NETWORK's ids for the spaces it carries (no alias, so they equal the local ids).
 */
export function netFixture(id, { rounds = [], spaces = [], type = 'club' } = {}) {
  return {
    id, label: id, type, origin: 'created', syncSchedule: '', spaces, votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', members: [], pendingRounds: rounds,
  };
}

/** A concluded, passed, unvetoed `space_wipe` or `space_deletion` round this instance proposed and has not applied. */
export function passedSpaceRound(roundId, type, spaceId, extra = {}) {
  return {
    roundId, type, spaceId, subjectInstanceId: 'aaaaaaaa-0000-4000-8000-000000005e1f', subjectLabel: 'Self', subjectUrl: '',
    openedAt: '2026-10-16T00:00:00.000Z', deadline: '2099-01-01T00:00:00.000Z', votes: [], concluded: true, passed: true,
    proposedHere: true, ...extra,
  };
}

/** The live round `roundId` of network `netId`, read from the loader's config. */
export const roundOf = (loader, netId, roundId) =>
  loader.getConfig().networks.find(n => n.id === netId)?.pendingRounds.find(r => r.roundId === roundId);

/** The value of one sample of a Prometheus metric (`labels` must all match), 0 when the series does not exist. */
export async function metricSample(name, labels = {}) {
  const { register } = await import('../../server/dist/metrics/registry.js');
  let total = 0;
  for (const line of (await register.metrics()).split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const m = /^([\w:]+)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const have = Object.fromEntries([...(m[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
    if (Object.entries(labels).every(([k, v]) => have[k] === v)) total += Number(m[3]);
  }
  return total;
}

/** Audit rows of one `operation`, polled until `atLeast` exist (the audit write is queued, not awaited), bounded by turns. */
export async function auditRowsOf(mongo, operation, { atLeast = 1, maxTurns = 3000 } = {}) {
  let rows = [];
  for (let i = 0; i < maxTurns; i++) {
    rows = await mongo.col('audit_log').find({ operation }).toArray();
    if (rows.length >= atLeast) return rows;
    await new Promise(resolve => setImmediate(resolve));
  }
  return rows;
}

/** Reset the runner's knobs, hooks and closed state after a row: the in-process boots keep module state (§2.5 seams, TS-3). */
export function resetRunnerForTest(runner) {
  runner.setSpaceActKnobsForTest(null);
  runner.setSpaceActHooksForTest(null);
  runner.reopenSpaceActsForTest();
}
