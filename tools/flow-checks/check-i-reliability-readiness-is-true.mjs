#!/usr/bin/env node
/**
 * check-i-reliability-readiness-is-true: the readiness route says "not ready" while a dependency of the app is stopped, and "ready" again once it
 * is started. A readiness route that only says the process is up sends traffic to an instance that cannot serve it.
 *
 * ## The rule this probe asserts
 *
 * Start the app with its database from this checkout's image (the shape in `_stack.mjs`: a scratch compose project, booked, removed when the
 * probe ends). `GET /ready` must answer 200. Then, for each dependency the app's own compose service declares (`depends_on`, read from the
 * configuration the shape started: the one source, so a dependency added tomorrow is tried by this probe without an edit): stop it, and `/ready`
 * must answer 503 within 30 s; start it, and `/ready` must answer 200 again within 240 s. A dependency whose stop leaves `/ready` at 200 is
 * the defect; so is one after which `/ready` never comes back.
 *
 * The optional document sidecars are not asked: the server states, in `health-summary.ts`, that a dead sidecar must not pull a healthy instance
 * out of rotation, and the compose file does not make the app depend on one.
 *
 * ## What it prevents
 *
 * A probe that "holds" about a stack it never stopped anything in: no dependency derived is `cannot answer`, a route that cannot be reached is
 * `cannot answer`, and only a `/ready` that was seen to leave 200 and return is `holds`.
 *
 * `judge` is the pure decision over what was observed (tested on recorded observations); `observe` is what drives the stack; the shape's own test
 * runs both over a fake `spawn`, and `YTHRIL_FLOW_PROBE_LIVE=1` runs the probe against a real scratch stack (about two minutes, 6 GB booked).
 */
import { CannotAnswer, holds, violated, isMain } from './_verdict.mjs';
import { stackProbe } from './_stack.mjs';

/** Seconds `/ready` has to leave 200 after a stop (its probe is cached for 2 s and bounded at 2 s), and to return after a start (Mongo's whole boot). */
const FLIP_S = 30;
const RECOVER_S = 240;
const BASELINE_S = 60;

export const spec = {
  check: 'check-i-reliability-readiness-is-true',
  instances: ['a'],
  sidecars: [],
  drivers: [],
  memGb: 6,
  budgetS: 1200,
  image: 'source',
};

/**
 * The verdict over what was observed: `{ baseline: { status }, deps: [{ service, stopped: {status, seconds}|null, restarted: {status, seconds}|null }] }`.
 * `stopped` is null when `/ready` never answered 503 with the dependency stopped, `restarted` null when it never answered 200 again.
 */
export function judge({ baseline, deps }) {
  if (!deps.length) throw new CannotAnswer('no dependency of the app was derived from its compose service, so nothing was stopped');
  if (baseline.status !== 200) return violated(`/ready answers ${baseline.status} before anything was stopped: a healthy stack must be ready`);
  for (const d of deps) {
    if (!d.stopped) return violated(`/ready stays ready (200) for ${FLIP_S} s with ${d.service} stopped: it reports that the process is up, not that the instance can serve`);
    if (!d.restarted) return violated(`/ready is not ready again ${RECOVER_S} s after ${d.service} was started`);
  }
  const slowest = Math.max(...deps.map((d) => d.restarted.seconds));
  return holds(`/ready answers 503 within ${Math.max(...deps.map((d) => d.stopped.seconds))} s of each of ${deps.length} dependency stop(s) (${deps.map((d) => d.service).join(', ')}) and 200 again within ${slowest} s of each start`);
}

/** Drive the stack: read `/ready`, stop each dependency in turn, wait for the flip, start it, wait for the return. */
export async function observe(ctx) {
  const inst = ctx.instances[0];
  const ready = async () => (await ctx.http(inst, 'GET', '/ready')).status;
  let last = 0;
  const first = await ctx.poll(async () => { last = await ready(); return last === 200; }, { timeoutS: BASELINE_S });
  const baseline = { status: first ? 200 : last };
  const config = await ctx.composeConfig();
  const deps = [];
  for (const service of Object.keys(config.services?.[inst.service]?.depends_on ?? {})) {
    await ctx.stop(service);
    let stopped = null; let restarted = null;
    try {
      const flip = await ctx.poll(async () => (await ready()) === 503, { timeoutS: FLIP_S });
      if (flip) stopped = { status: 503, seconds: flip.seconds };
    } finally {
      await ctx.start(service);
    }
    const back = await ctx.poll(async () => (await ready()) === 200, { timeoutS: RECOVER_S, everyMs: 2000 });
    if (back) restarted = { status: 200, seconds: back.seconds };
    ctx.say(`${service}: ready left 200 in ${stopped ? `${stopped.seconds} s` : 'never'}, back to 200 in ${restarted ? `${restarted.seconds} s` : 'never'}`);
    deps.push({ service, stopped, restarted });
  }
  return { baseline, deps };
}

export const decide = async (ctx) => judge(await observe(ctx));

if (isMain(import.meta.url)) await stackProbe(spec, decide);
