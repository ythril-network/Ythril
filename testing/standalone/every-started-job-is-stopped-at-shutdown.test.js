/**
 * Every scheduled job the process starts is stopped when it shuts down, before the drain (`Q-317`, bundle-53 G26).
 *
 * ## The defect it prevents
 *
 * `index.ts`'s shutdown handler stopped the sync scheduler, the backup scheduler, the duplicate scanner, the seq watchdog, the two
 * workers, the webhook retry poll and the reindex watcher, **by hand, one call each, from a list written when each of those existed.**
 * The TTL sweep, the candidate prune, the tombstone prune, the contradiction scanner and the audit change-retention sweep were added
 * later and never joined it: each exported a `stop*` that nothing called. So for the whole of the drain (up to the grace the
 * orchestrator allows, and the drain is the part of a shutdown where requests are still finishing) a TTL sweep tick could start a
 * pass over spaces whose database connection was about to be closed under it, and each tick that landed late was a write racing
 * `closeMongo()`. Nothing contradicted it: the process exits 0 either way.
 *
 * ## What it holds, each part derived from the tree
 *
 * The jobs are every registration `_scheduled-jobs.mjs` finds (`intervalJob(` and cron `schedule(`), the one derivation of "what this
 * process runs on a timer". For each, by where it lives:
 *
 * 1. **A job registered in the shutdown handler's own file** (the file that defines `const shutdown = async`, found by that text,
 *    exactly one) is held by a handle, and the handler calls `<handle>.stop()` before the drain.
 * 2. **A job that is stopped in a `finally` of the function that created it** (the embed worker's heartbeat, which lives for one job)
 *    needs no stop at shutdown: the function ends and stops it.
 * 3. **Every other job lives as long as its module**, and then the module exports a `stop…` function that
 *    a. really stops THE job: the function (or anything it calls in the same file) names the job's handle with `.stop(`, which a
 *       stop that clears a different timer, or forgets the handle without clearing it, does not;
 *    b. is called in the shutdown handler, before the drain begins.
 * 4. **Exemptions are named, each with its reason, and each is held true.** {@link NO_STOP} and {@link STOPS_AFTER_THE_DRAIN} are
 *    rows keyed by file, a row that no job needs fails (a row outliving the code), and the reason's checkable half is checked
 *    (a module that claims it touches no database does not import one).
 *
 * ## It cannot pass by reading nothing
 *
 * The derivation throws below its own floors (`_scheduled-jobs.mjs` `JOB_FLOORS`), and this adds three: the files that hold a job, the
 * jobs that are held by module stops, and the stop calls found in the handler. Exactly one file defines the shutdown handler.
 *
 * ## What it does not conclude
 *
 * That a stop WAITS for a tick already running: `stop()` of an interval job does not (a tick in flight keeps its lock and finishes).
 * What the gate closes is a new tick starting during the drain. A worker loop that is not a registration (`workerLoop`) is stopped by
 * its own `stopping` flag, which is the worker's own question.
 *
 * ## Seen red
 *
 * By hand, put back by hand: on the base, where five `stop` exports had no caller; then a call removed from the handler, one moved after
 * the drain, the chunk-cleanup handle's stop removed, a module's stop that no longer stops its job, and a new job in a module with no stop.
 *
 * Run: node --test testing/standalone/every-started-job-is-stopped-at-shutdown.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, walkFrom } from './_call-graph.mjs';
import { scheduledJobs } from './_scheduled-jobs.mjs';
import { balancedFrom } from './_structural-window.mjs';

/**
 * Modules whose job has no stop, each with why it needs none. Held: the module must export no `stop…`, and its `check` must hold.
 */
const NO_STOP = [
  {
    file: 'server/src/api/invite-sessions.ts',
    why: 'The pairing handshake store is process-lifetime state (an ephemeral key that must never reach disk), so there is no owner to stop its '
      + 'purge; its tick walks an in-memory `Map` and touches no database, and the interval job\'s timer is unref\'d, so it neither holds the '
      + 'process open nor can race the closing connection. The process exit discards the store along with the timer.',
    /** The checkable half of the reason: no database. */
    check: src => !/\b(?:getDb|col|spaceCollection)\s*\(/.test(src),
  },
];

/**
 * Modules whose stop is called AFTER the drain on purpose, with why. The call must still be in the handler.
 */
const STOPS_AFTER_THE_DRAIN = [
  {
    file: 'server/src/metrics/space-activity-store.ts',
    why: 'Its stop stops the timer and then WRITES the last partial minute of per-space usage counters, so it runs after the drain, when '
      + 'calls that finished while connections were closing are counted too, and before `closeMongo`, since the write needs the connection. '
      + 'The timer ticking during the drain only writes the counters it already holds.',
  },
];

const FLOORS = { filesWithJobs: 12, stoppedByModule: 10, stopCalls: 10 };

const index = moduleIndex('server/src');
const { jobs } = scheduledJobs(index);

/** The handler: the text of the arrow function bound to `const shutdown = async`, and where its drain starts. */
function shutdownHandler() {
  const hosts = [...index.sources].filter(([, src]) => /\bconst\s+shutdown\s*=\s*async\b/.test(src));
  assert.equal(hosts.length, 1, `exactly one file defines the shutdown handler (\`const shutdown = async\`), found ${hosts.map(([f]) => f).join(', ') || 'none'}`);
  const [file, src] = hosts[0];
  const at = src.search(/\bconst\s+shutdown\s*=\s*async\b/);
  const arrow = src.indexOf('=>', at);
  const body = balancedFrom(src, src.indexOf('{', arrow), 'the shutdown handler body');
  const drainAt = body.indexOf('server.close(');
  assert.ok(drainAt > -1, 'the handler no longer calls `server.close(`: re-anchor where the drain begins');
  return { file, body, drainAt };
}

/** The `stop…` functions a module exports. */
const exportedStops = src => [...src.matchAll(/\bexport\s+(?:async\s+)?function\s+(stop[A-Za-z0-9_$]*)\s*\(/g)].map(m => m[1]);

/** All the text a function reaches inside its own file: its body and every same-file function it calls. */
function reachInFile(file, name) {
  const key = `${file}:${name}`;
  assert.ok(index.bodies.has(key), `${key} is not a function the index can read: re-anchor this gate`);
  const { seen } = walkFrom(index, [key]);
  return [...seen].filter(k => index.bodies.get(k).file === file).map(k => index.bodies.get(k).body).join('\n');
}

/** Does this text stop `handle`? `handle.stop(`, `handle?.stop(` or `.handle.stop(` — and, with no handle, any `.stop(`. */
const stopsHandle = (text, handle) => (handle
  ? new RegExp(String.raw`\b${handle.replace(/\$/g, '\\$')}\s*\??\.\s*stop\s*\(`).test(text)
  : /\.\s*stop\s*\(/.test(text));

/** The functions that hold a job's registration that stop it in a `finally` of their own. */
function stoppedInFinally(container, handle) {
  const entry = container ? index.bodies.get(container) : null;
  if (!entry || entry.binding || entry.synthetic) return false;
  return [...entry.body.matchAll(/\bfinally\s*\{/g)]
    .some(m => stopsHandle(balancedFrom(entry.body, m.index + m[0].length - 1, 'a finally block'), handle));
}

/**
 * Every job that is NOT held to a stop, and why not — the findings of the rules above.
 *
 * @returns {{ findings: string[], stoppedByModule: number, stopCalls: Set<string>, usedNoStop: Set<string>, usedAfterDrain: Set<string> }}
 */
function audit() {
  const { file: hostFile, body, drainAt } = shutdownHandler();
  const findings = [];
  const stopCalls = new Set();
  const usedNoStop = new Set();
  const usedAfterDrain = new Set();
  let stoppedByModule = 0;
  const called = name => {
    const at = body.search(new RegExp(String.raw`\b${name}\s*\(`));
    return at;
  };

  for (const job of jobs) {
    const where = `${job.file} (${job.kind} job ${job.label.slice(0, 40)})`;

    // 1. a job registered in the handler's own file
    if (job.file === hostFile) {
      const at = job.handle ? body.search(new RegExp(String.raw`\b${job.handle}\s*\??\.\s*stop\s*\(`)) : -1;
      if (!job.handle) findings.push(`${where}: registered in ${hostFile} with no handle, so the shutdown handler has nothing to stop`);
      else if (at < 0) findings.push(`${where}: the shutdown handler never calls \`${job.handle}.stop()\``);
      else if (at > drainAt) findings.push(`${where}: \`${job.handle}.stop()\` is called after the drain begins`);
      else stopCalls.add(`${hostFile}:${job.handle}.stop`);
      continue;
    }

    // 2. stopped in a finally of the function that made it
    if (stoppedInFinally(job.container, job.handle)) continue;

    // 3. lives as long as its module
    const src = index.sources.get(job.file);
    const stops = exportedStops(src);
    const noStop = NO_STOP.find(r => r.file === job.file);
    if (noStop) {
      usedNoStop.add(job.file);
      if (stops.length > 0) findings.push(`${where}: has a NO_STOP row but exports ${stops.join(', ')}: call it from the shutdown handler and drop the row`);
      if (!noStop.check(src)) findings.push(`${where}: the NO_STOP reason (${noStop.why.slice(0, 60)}…) is not true of the module any more`);
      continue;
    }
    if (stops.length === 0) {
      findings.push(`${where}: lives as long as its module and the module exports no \`stop…\`, so the shutdown handler cannot stop it`);
      continue;
    }
    const stopping = stops.filter(name => stopsHandle(reachInFile(job.file, name), job.handle));
    if (stopping.length === 0) {
      findings.push(`${where}: none of ${stops.join(', ')} stops the job${job.handle ? ` (\`${job.handle}.stop()\`)` : ''}`);
      continue;
    }
    const callable = stopping.filter(name => called(name) > -1);
    if (callable.length === 0) {
      findings.push(`${where}: ${stopping.join(' / ')} stops it and the shutdown handler in ${hostFile} never calls it`);
      continue;
    }
    const afterDrain = STOPS_AFTER_THE_DRAIN.find(r => r.file === job.file);
    const early = callable.filter(name => called(name) < drainAt);
    if (afterDrain) {
      usedAfterDrain.add(job.file);
      if (early.length > 0) findings.push(`${where}: has a STOPS_AFTER_THE_DRAIN row but ${early.join(', ')} is called before the drain: drop the row`);
    } else if (early.length === 0) {
      findings.push(`${where}: ${callable.join(' / ')} is called after the drain begins, so a tick can start while requests finish and the connection closes`);
      continue;
    }
    callable.forEach(name => stopCalls.add(`${job.file}:${name}`));
    stoppedByModule++;
  }
  return { findings, stoppedByModule, stopCalls, usedNoStop, usedAfterDrain };
}

describe('every scheduled job is stopped by the shutdown handler', () => {
  const result = audit();

  it('reads a tree worth reading (the floors)', () => {
    const files = new Set(jobs.map(j => j.file));
    assert.ok(files.size >= FLOORS.filesWithJobs, `only ${files.size} file(s) hold a scheduled job`);
    assert.ok(result.stoppedByModule >= FLOORS.stoppedByModule,
      `only ${result.stoppedByModule} job(s) were found stopped by a module's stop: the derivation has stopped reading the stops, and "every job is stopped" is a statement about nothing`);
    assert.ok(result.stopCalls.size >= FLOORS.stopCalls, `only ${result.stopCalls.size} stop call(s) were found in the shutdown handler`);
  });

  it('no job is left running while the process drains', () => {
    assert.deepEqual(result.findings, [],
      `a job that is not stopped at shutdown can start a tick over a closing connection:\n  ${result.findings.join('\n  ')}\n`
      + 'Export a `stop…` that stops the job and call it in `index.ts`\'s shutdown handler before the `server.close(`, or, where a job truly needs none, add a '
      + 'NO_STOP row here with the reason.');
  });

  it('every exemption row is still needed', () => {
    const stale = [
      ...NO_STOP.filter(r => !result.usedNoStop.has(r.file)).map(r => `NO_STOP ${r.file}`),
      ...STOPS_AFTER_THE_DRAIN.filter(r => !result.usedAfterDrain.has(r.file)).map(r => `STOPS_AFTER_THE_DRAIN ${r.file}`),
    ];
    assert.deepEqual(stale, [], `a row outlived the code it excuses: ${stale.join(', ')}`);
  });
});
