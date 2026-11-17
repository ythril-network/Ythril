/**
 * The preflight's stages, the order they run in, and the runner that holds the script to that order and stops it at the first
 * stage that fails.
 *
 * ## What it prevents
 *
 * A full preflight takes about 35 minutes, and its sub-minute text gates (the CHANGELOG entry, docs lint, the todo index, the
 * route list, the CI-reach check) used to run AFTER 26 minutes of standalone test batches, then the run went on to the end
 * and listed the failures there. Every preflight failure on 2026-11-16 was one of those cheap gates, found half an hour late.
 * The rule (flow convention `convention-preflight-cheapest-first-and-parallel`): the order is the stages' dependency graph, ties
 * broken by the expected cost of finding a failure; stop at the first failing stage and say which stages did not run. Since
 * Q-865 that order is COMPUTED, not written down: {@link planStages} is the one function that answers it.
 *
 * - **Needs are data, derived from the code a stage runs.** {@link PREFLIGHT_STAGES} lists each stage with its kind and the
 *   stages whose output it reads (`needs`): the gates that import `server/dist` need `build:server`, the budgets need
 *   `build:prod`, and every other source stage needs the first one (`test files parse` writes sibling files, so nothing may run
 *   beside it before the tree is known clean). A test over the list derives the needs from the files each stage runs.
 * - **Kinds are barriers.** `source` reads no build output, `build` compiles or imports what a build wrote, `test` runs a suite:
 *   every stage implicitly waits for every stage of an earlier kind, so an undeclared need cannot put a reader before its build.
 *   Cost orders the stages only within a kind and only among those whose needs have run.
 * - **Cost is measured, from one snapshot.** {@link stageCost} is the median time over the smoothed failure rate, so a cheap
 *   stage that often fails goes before an expensive one that never does. The numbers come from the recorded `Preflight-Run`
 *   records of one runner (`scripts/_shared/preflight-run-record.mjs`, `stageStats`) through the snapshot
 *   `scripts/_shared/stage-costs.mjs` reads; with none, a stale one or a garbage one the order is the list's order, and the
 *   script says so. The plan never reads the instance.
 * - **The script cannot drift from the plan.** `scripts/preflight.mjs` registers a body for every stage by name and hands them to
 *   {@link runStages}, which refuses a registered set that is not the whole list (both ways) before any body runs, awaits each
 *   body, and charges a body's exception to its own stage. {@link createStageRunner} then refuses a plan that lists a kind
 *   after a costlier one, a name twice, or a stage before a stage it needs that the plan holds.
 * - **Every stage is timed by the runner (Q-864).** A stage's time is the clock between its `begin` and the next `begin` or `end`,
 *   read once per boundary; {@link createStageRunner}'s `timings()` lists every planned stage with that time and its outcome
 *   (`passed`, `failed`, or `not-run` with 0 ms). `scripts/_shared/preflight-run-record.mjs` records that list; nothing parses output.
 * - **A failure ends the run at the next stage boundary.** The stage that failed finishes (a batch failing must not hide a
 *   second failure in a later batch of the same stage), and the next `begin` reports it and stops, naming every stage that
 *   did not run. `onStop` is injected so a test can watch the stop without a process dying.
 *
 * Built-ins only.
 */

/** The three kinds, cheapest first. */
export const STAGE_KINDS = Object.freeze(['source', 'build', 'test']);

/** Gates that read SOURCE only: no build required, so they run first and fail fastest. `[name, why]`; the name is the standalone gate's file. */
export const SOURCE_GATES = Object.freeze([
  ['icon-registry-coverage', 'an unregistered icon renders as a blank space, silently'],
  ['scheduler-wiring', 'a background scheduler nobody starts looks exactly like one with nothing to do'],
  ['route-guard-coverage', 'an unguarded route is only visible by reading every router'],
  ['env-var-docs-coverage', 'a setting no doc mentions is one nobody can find'],
  ['config-key-docs-coverage', 'a wrong key in a config example is IGNORED at runtime — no error to search for'],
  ['route-path-docs-coverage', 'a documented endpoint that does not exist 404s with nothing to explain it'],
  ['mcp-tool-docs-coverage', 'a tool documented as blocked for read-only tokens that is not actually blocked'],
  ['doc-cited-constants', 'a number the docs quote that no longer matches the constant it quotes'],
  ['help-docs-coverage', 'a guide that ships but the in-product Help page never offers, or offers and cannot load'],
  ['help-anchor-coverage', 'a help link whose anchor matches no heading — it opens the guide and scrolls nowhere'],
  ['console-redaction-coverage', 'an error written straight to the console, bypassing the redaction log.* applies'],
].map(Object.freeze));

/** Gates that import from server/dist and therefore need a build. */
export const BUILT_GATES = Object.freeze([
  ['audit-route-coverage', 'a mutating route with no audit rule leaves no trace of who changed what'],
].map(Object.freeze));

/** The one stage every other source stage waits for: it asks git alone, and `test files parse` writes sibling files. */
const FIRST_STAGE = 'unregistered-local-files';
const AFTER_FIRST = Object.freeze([FIRST_STAGE]);

/**
 * Every stage with its kind and the stages whose output it reads, in the order they run when nothing is measured (`planStages` with
 * no costs answers exactly this order). `static: false` marks a stage a `--static` run leaves out (it runs a suite or reads a
 * build only a suite's run makes); a need on a stage the mode leaves out counts as met.
 *
 * The needs are what each stage's code reads, not a guess: `audit-route-coverage` and `surface-matrix-audit` import `server/dist`;
 * the standalone batches run pure files that import `server/dist` and read `client/dist` (the bundle-budget and
 * no-external-assets gates); `bundle-budgets` reads the production build's chunk table. The client type-check, the production
 * build and the client unit tests read no build output.
 */
export const PREFLIGHT_STAGES = Object.freeze([
  { name: FIRST_STAGE, kind: 'source' },
  { name: 'check-changelog', kind: 'source', needs: AFTER_FIRST },
  { name: 'todo:check', kind: 'source', needs: AFTER_FIRST },
  ...SOURCE_GATES.map(([name]) => ({ name, kind: 'source', needs: AFTER_FIRST })),
  { name: 'unrun-tests', kind: 'source', needs: AFTER_FIRST },
  { name: 'lint:docs', kind: 'source', needs: AFTER_FIRST },
  { name: 'test files parse', kind: 'source', needs: AFTER_FIRST },

  { name: 'build:server', kind: 'build' },
  ...BUILT_GATES.map(([name]) => ({ name, kind: 'build', needs: ['build:server'] })),
  { name: 'surface-matrix-audit', kind: 'build', needs: ['build:server'] },
  { name: 'typecheck:client', kind: 'build' },
  { name: 'build:prod', kind: 'build', static: false },
  { name: 'bundle-budgets', kind: 'build', static: false, needs: ['build:prod'] },

  { name: 'client unit tests', kind: 'test', static: false },
  { name: 'test:standalone (offline subset)', kind: 'test', needs: ['build:server', 'build:prod'] },
].map(s => Object.freeze(s.needs ? { ...s, needs: Object.freeze([...s.needs]) } : s)));

const rankOf = (kind) => STAGE_KINDS.indexOf(kind);

/**
 * The expected cost of finding a failure in a stage: its median time over its smoothed failure rate, `(failed + 1) / (ran + 2)`. The
 * smoothing keeps the figure finite for a stage that never failed, and for one that failed every run.
 *
 * @param {{ ran: number, failed: number, medianMs: number }} row
 * @returns {number}
 */
export function stageCost({ ran, failed, medianMs }) {
  return medianMs / ((failed + 1) / (ran + 2));
}

/** The stages left after peeling off every stage nothing in the set waits for, and every stage that waits for nothing in it: the members of a cycle. */
function cycleMembers(names, needsOf) {
  const left = new Set(names);
  for (let changed = true; changed;) {
    changed = false;
    for (const n of [...left]) {
      const waits = needsOf(n).some(d => left.has(d));
      const waitedFor = [...left].some(m => needsOf(m).includes(n));
      if (!waits || !waitedFor) { left.delete(n); changed = true; }
    }
  }
  return [...left];
}

/**
 * What is wrong with the graph `stages` make, as sentences: a kind it does not know, a name listed twice, a need that names no
 * stage, a need on a stage of a later kind (it can never be met, since a later kind waits for every earlier one) and a cycle among
 * the needs. Empty means the graph holds. Every stage is judged, the ones a `--static` run drops too: a need on one of those is fine.
 *
 * @param {ReadonlyArray<{name: string, kind: string, needs?: readonly string[]}>} stages
 * @returns {string[]}
 */
export function stageGraphProblems(stages) {
  const out = [];
  const byName = new Map();
  for (const [i, s] of stages.entries()) {
    if (rankOf(s.kind) < 0) out.push(`stage ${i + 1} (${s.name}) has kind ${JSON.stringify(s.kind)}; the kinds are ${STAGE_KINDS.join(', ')}`);
    if (byName.has(s.name)) out.push(`stage ${i + 1} (${s.name}) is listed twice`);
    else byName.set(s.name, s);
  }
  const usable = new Map();
  for (const s of stages) {
    const keep = [];
    for (const need of s.needs ?? []) {
      const target = byName.get(need);
      if (!target) out.push(`stage ${s.name} needs ${need}, which is no stage`);
      else if (rankOf(target.kind) > rankOf(s.kind) && rankOf(s.kind) >= 0) {
        out.push(`stage ${s.name} (${s.kind}) needs ${need} (${target.kind}), a stage of a later kind: it can never run first, because every ${target.kind} stage waits for every ${s.kind} stage (a cycle)`);
      } else keep.push(need);
    }
    if (!usable.has(s.name)) usable.set(s.name, keep);
  }
  const cycle = cycleMembers([...usable.keys()], (n) => usable.get(n) ?? []);
  if (cycle.length) out.push(`the stages ${cycle.join(', ')} need each other: a cycle`);
  return out;
}

/**
 * What is wrong with the ORDER of `stages` (a plan, or the list): a kind it does not know, a stage listed after a costlier kind began, a
 * name listed twice, and a stage listed before a stage it needs that the list holds. Empty means the order holds. A need on a stage
 * the list does not hold is not a fault here (a static run dropped it); {@link stageGraphProblems} judges the whole graph.
 *
 * @param {ReadonlyArray<{name: string, kind: string, needs?: readonly string[]}>} stages
 * @returns {string[]}
 */
export function stageOrderViolations(stages) {
  const out = [];
  const seen = new Set();
  const at = new Map(stages.map((s, i) => [s.name, i]));
  let reached = 0;
  for (const [i, s] of stages.entries()) {
    const rank = rankOf(s.kind);
    if (rank < 0) { out.push(`stage ${i + 1} (${s.name}) has kind ${JSON.stringify(s.kind)}; the kinds are ${STAGE_KINDS.join(', ')}`); continue; }
    if (rank < reached) {
      out.push(`stage ${i + 1} (${s.name}, ${s.kind}) is listed after a ${STAGE_KINDS[reached]} stage: run it before the costlier kind starts`);
    }
    reached = Math.max(reached, rank);
    if (seen.has(s.name)) out.push(`stage ${i + 1} (${s.name}) is listed twice`);
    seen.add(s.name);
    for (const need of s.needs ?? []) {
      if (at.has(need) && at.get(need) >= i) out.push(`stage ${i + 1} (${s.name}) is listed before ${need}, which it needs`);
    }
  }
  return out;
}

/**
 * The stages in the order they run: the mode applied first (a `--static` run drops the `static: false` stages, and a need on a dropped
 * stage counts as met), then, kind by kind, the stage whose needs have run and whose cost of finding a failure is lowest, ties by list
 * position. A stage the costs do not list (a new stage, or one the snapshot's runs never reached) runs after the listed stages of
 * its kind that are ready, so a measurement is never replaced by a guess. With no costs the answer is the list's own order.
 *
 * @param {ReadonlyArray<{name: string, kind: string, needs?: readonly string[], static?: boolean}>} stages
 * @param {{ stages: Record<string, { ran: number, failed: number, medianMs: number }> } | null | undefined} costs
 * @param {{ static: boolean }} mode
 * @returns {Array<object>} the list's own stage objects
 * @throws {Error} naming each stage involved, when the graph has a problem
 */
export function planStages(stages, costs, { static: isStatic }) {
  const problems = stageGraphProblems(stages);
  if (problems.length) throw new Error(`the preflight's stage graph has problems:\n  ${problems.join('\n  ')}`);
  const kept = stages.filter(s => !(isStatic && s.static === false));
  const position = new Map(kept.map((s, i) => [s.name, i]));
  const table = costs && typeof costs.stages === 'object' && costs.stages !== null ? costs.stages : null;
  // Own keys only: a stage called `constructor` or `toString` must not read a cost off the object's prototype.
  const costOf = (s) => {
    if (!table || !Object.hasOwn(table, s.name)) return null;
    const row = table[s.name];
    if (typeof row !== 'object' || row === null) return null;
    const c = stageCost(row);
    return Number.isFinite(c) ? c : null;
  };
  const plan = [];
  const placed = new Set();
  for (const kind of STAGE_KINDS) {
    const todo = kept.filter(s => s.kind === kind).map(s => ({ s, cost: costOf(s), at: position.get(s.name) }));
    while (todo.length) {
      const ready = todo.filter(({ s }) => (s.needs ?? []).every(n => placed.has(n) || !position.has(n)));
      if (!ready.length) throw new Error(`the preflight cannot order its ${kind} stages: ${todo.map(t => t.s.name).join(', ')} wait for each other`);
      ready.sort((a, b) => (a.cost === null) - (b.cost === null) || (a.cost ?? 0) - (b.cost ?? 0) || a.at - b.at);
      const [next] = ready;
      plan.push(next.s);
      placed.add(next.s.name);
      todo.splice(todo.indexOf(next), 1);
    }
  }
  return plan;
}

/**
 * The runner the script enters each stage through.
 *
 * @param {object} o
 * @param {Array<{name: string, why: string}>} o.failures the script's own failure list; a stage failing pushes to it
 * @param {boolean} o.isStatic a `--static` run: stages marked `static: false` are not expected
 * @param {(stop: {notRun: string[]}) => never} o.onStop called, once, at the first `begin` that finds a failure; it must not return
 * @param {ReadonlyArray<{name: string, kind: string, needs?: readonly string[], static?: boolean}>} [o.stages] the plan, in run order
 * @param {() => number} [o.now] the clock, in milliseconds; injected so a test writes the gaps it expects
 * @returns {{ failures: Array<{name: string, why: string}>, begin: (name: string) => void, end: () => void, timings: () => StageTiming[] }}
 */
export function createStageRunner({ failures, isStatic, onStop, stages = PREFLIGHT_STAGES, now = Date.now }) {
  const bad = stageOrderViolations(stages);
  if (bad.length) throw new Error(`the preflight's stage list is out of order:\n  ${bad.join('\n  ')}`);
  const plan = stages.filter(s => !(isStatic && s.static === false));
  let next = 0;
  const notRun = () => plan.slice(next).map(s => s.name);

  // The stage open now: when it began and how many failures there were before it, so the failure that ENDS it is the one it caused.
  let open = null;
  const finished = [];
  const closeOpen = (at = now()) => {
    if (!open) return;
    finished.push({ name: open.stage.name, kind: open.stage.kind, ms: Math.max(0, Math.round(at - open.startedAt)), outcome: failures.length > open.failuresBefore ? 'failed' : 'passed' });
    open = null;
  };

  return {
    /** The failure list the runner was made with: {@link runStages} pushes a body's exception to it. */
    failures,
    /** Entered at the top of a stage: stops the run if an earlier stage failed, else checks this is the stage the plan says is next. */
    begin(name) {
      // The previous stage ends where this one begins; a failure it caused is known only now, so it is closed before the stop is decided.
      const at = now();
      closeOpen(at);
      if (failures.length > 0) {
        onStop({ notRun: notRun(), stages: this.timings() });
        throw new Error('onStop returned: it must end the run');
      }
      const expected = plan[next];
      if (!expected || expected.name !== name) {
        throw new Error(`preflight stage order drifted: entered ${JSON.stringify(name)} but the stage list says ${expected ? JSON.stringify(expected.name) : 'the run is over'} is next`);
      }
      next++;
      open = { stage: expected, startedAt: at, failuresBefore: failures.length };
    },
    /** Entered after the last stage: a stage the script never entered is a gate that stopped running. */
    end() {
      closeOpen();
      if (next < plan.length) throw new Error(`preflight ended without entering: ${notRun().join(', ')}`);
    },
    /**
     * Every planned stage in order, each with the time the runner measured between its own begin and the next: `passed`, or `failed`
     * when the run's failure list grew during it; a stage the run never reached is `not-run` with 0 ms. A stage still open is
     * closed first, so the list is whole whenever it is asked for.
     */
    timings() {
      closeOpen();
      return [...finished, ...plan.slice(next).map(s => ({ name: s.name, kind: s.kind, ms: 0, outcome: 'not-run' }))];
    },
  };
}

/**
 * Run the plan: enter each stage through `runner` and await its body, one at a time. The registered `bodies` (a Map of stage name to
 * function) must be the stage list's names, both ways, checked before any body runs: a listed stage with no body would be planned and
 * never run, a body with no stage never planned. A body that rejects, or throws, is a failure of ITS stage (the first line of its
 * message), so the run stops at the next boundary; the runner's own refusals and `onStop`'s end of the run propagate.
 *
 * @param {ReadonlyArray<{name: string}>} plan from {@link planStages}
 * @param {ReadonlyMap<string, (ctx: object) => unknown>} bodies
 * @param {{ failures: Array<{name: string, why: string}>, begin: (name: string) => void }} runner from {@link createStageRunner}
 * @param {object} [ctx] handed to every body: what one stage leaves for another to read
 */
export async function runStages(plan, bodies, runner, ctx = {}) {
  const listed = PREFLIGHT_STAGES.map(s => s.name);
  const registered = [...bodies.keys()];
  const difference = [
    ...registered.filter(n => !listed.includes(n)).map(n => `${JSON.stringify(n)} has a body but is no listed stage`),
    ...listed.filter(n => !registered.includes(n)).map(n => `${JSON.stringify(n)} is a listed stage with no body`),
  ];
  if (difference.length) throw new Error(`the stages the script registered are not the stage list:\n  ${difference.join('\n  ')}`);
  for (const s of plan) {
    runner.begin(s.name);
    try {
      await bodies.get(s.name)(ctx);
    } catch (err) {
      runner.failures.push({ name: s.name, why: String(err?.message ?? err).split('\n')[0] });
    }
  }
}

/** @typedef {{ name: string, kind: string, ms: number, outcome: 'passed' | 'failed' | 'not-run' }} StageTiming */
