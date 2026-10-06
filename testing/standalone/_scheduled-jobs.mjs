/**
 * Every scheduled job in `server/src` — read out of the registrations themselves, once, for every gate that asks.
 *
 * ## The question it answers
 *
 * *"What does this process run on a timer?"* A job is one of two things: an `intervalJob(label, everyMs, run)` (`util/interval-job.ts`,
 * the only owner of `setInterval`) or a cron registration, `schedule(expression, run)` from `node-cron`. This module finds every
 * registration, says which function (if any) it sits in, which function is its `run`, and what handle it is kept in.
 *
 * ## What it prevents
 *
 * Two gates held a hand-written list of the modules that schedule work (`single-flight.test.js`'s `SWEEPS`,
 * `scheduler-wiring.test.js`'s `SCHEDULERS`), and a list of modules is a list of last year's modules: the sweep that moved to
 * `intervalJob` kept its row and the gates went red for a reason nobody had written, and a job added tomorrow has no row at all.
 * The isolation gate (`every-housekeeping-space-walk-is-isolated`) needed the same set as ROOTS, and a root set written beside the
 * list of jobs is a third opinion about what is scheduled. So there is one derivation, and the gates that need it read it here.
 *
 * ## The guards a hand-written copy drops
 *
 * - **An unfollowable `run` is returned, never dropped.** `intervalJobRuns` (`_call-graph.mjs`) hands back `key: null` for a run it
 *   cannot resolve (`this.run`, a call result), because a derivation that skips what it cannot read is a smaller set that every
 *   loop over it passes. A caller must name it in an exemption or fail.
 * - **The floors.** `scheduledJobs` throws when it finds fewer registrations of either kind than {@link JOB_FLOORS}: a regex edited
 *   to match nothing makes every gate over "all the jobs" a green tick about none of them. They are the counts on the tree this was
 *   written against; raise them as the tree grows, never lower one to make a run pass.
 * - **A cron registration is recognised by its import**, `import { schedule } from 'node-cron'`, not by the spelling `schedule(`:
 *   `spaces/search-index-presence.ts` has a function of its own called `schedule` and is not a cron job.
 *
 * ## What it does not answer
 *
 * Whether a job is STARTED (that a `start*` is called from another file) and whether it is bounded: those are the gates'
 * questions, built on `container` and `handle` here. A worker that sleeps between passes, or a chain of `setTimeout`s, has no
 * registration and is not a job in this sense (`every-repeating-timer-is-an-interval-job` says so).
 */
import assert from 'node:assert/strict';
import { argumentsOf } from './_structural-window.mjs';
import { intervalJobRuns } from './_call-graph.mjs';

/** The fewest registrations of each kind that may be found before this throws. */
export const JOB_FLOORS = Object.freeze({ interval: 12, cron: 4 });

/**
 * @param {ReturnType<import('./_call-graph.mjs').moduleIndex>} index
 * @returns {{
 *   jobs: {kind: 'interval'|'cron', file: string, at: number, label: string, run: string, runKey: string|null,
 *          how: 'closure'|'reference'|'unfollowable', container: string|null, handle: string|null}[],
 *   found: {interval: number, cron: number}
 * }}
 *   `container` is the key of the function (or binding) whose source holds the registration, `null` at module scope;
 *   `handle` is the name the registration is assigned to (`const pruneJob = intervalJob(…)`, `_task = schedule(…)`), or `null`
 *   when it is used in place (`intervalJob(…).start()`).
 */
export function scheduledJobs(index) {
  const jobs = [];

  for (const r of intervalJobRuns(index)) {
    jobs.push({ kind: 'interval', file: r.file, at: r.at, label: r.label, run: r.run, runKey: r.key, how: r.how });
  }

  for (const [file, src] of index.sources) {
    // The name the file gives `schedule` — `import { schedule as cronSchedule }` is how the sync scheduler spells it.
    const local = /\bimport\s*\{[^}]*\bschedule(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*[,}][^}]*\}\s*from\s*['"]node-cron['"]/.exec(src);
    if (!local) continue;
    const name = local[1] ?? 'schedule';
    for (const m of src.matchAll(new RegExp(`(?<![.\\w$])${name}\\s*\\(`, 'g'))) {
      const open = m.index + m[0].length - 1;
      const args = argumentsOf(src, open, `the cron registration in ${file}`);
      const run = args[1] ?? '';
      const key = `${file}:schedule@${m.index}`;
      if (!index.bodies.has(key)) {
        const start = src.indexOf(run, open);
        index.bodies.set(key, { file, name: `schedule@${m.index}`, body: run, start, end: start + run.length, synthetic: true });
      }
      jobs.push({ kind: 'cron', file, at: m.index, label: args[0] ?? '', run, runKey: key, how: 'closure' });
    }
  }

  for (const job of jobs) {
    const src = index.sources.get(job.file);
    // The innermost real function or binding holding the registration (a synthetic body is not a container).
    const holders = [...index.bodies.entries()]
      .filter(([, e]) => e.file === job.file && !e.synthetic && job.at >= e.start && job.at < e.end)
      .sort(([, a], [, b]) => (a.end - a.start) - (b.end - b.start));
    job.container = holders[0]?.[0] ?? null;
    const before = src.slice(Math.max(0, job.at - 80), job.at);
    job.handle = /([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*$/.exec(before)?.[1] ?? null;
  }

  const found = { interval: jobs.filter(j => j.kind === 'interval').length, cron: jobs.filter(j => j.kind === 'cron').length };
  for (const [kind, floor] of Object.entries(JOB_FLOORS)) {
    assert.ok(found[kind] >= floor,
      `the job derivation found ${found[kind]} '${kind}' registration(s), below the floor of ${floor} (found: ${JSON.stringify(found)}). `
      + 'The derivation is broken, not the code — a thin set makes every gate over "all the scheduled jobs" pass about none of them.');
  }
  return { jobs, found };
}
