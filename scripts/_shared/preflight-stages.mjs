/**
 * The preflight's stages in the order they run, and the runner that holds the script to that order and stops it at the first
 * stage that fails.
 *
 * ## What it prevents
 *
 * A full preflight takes about 35 minutes, and its sub-minute text gates (the CHANGELOG entry, docs lint, the todo index, the
 * route list, the CI-reach check) used to run AFTER 26 minutes of standalone test batches, then the run went on to the end
 * and listed the failures there. Every preflight failure on 2026-11-16 was one of those cheap gates, found half an hour late.
 * The rule (flow convention `convention-preflight-cheapest-first-and-parallel`): run the stages that need nothing built, then
 * the builds and the gates that read them, then the test runs, slowest last; stop at the first failing stage and say which
 * stages did not run.
 *
 * - **The order is data, and the script cannot drift from it.** {@link PREFLIGHT_STAGES} is the list, each stage with its
 *   kind. `scripts/preflight.mjs` calls `begin(<name>)` as it enters a stage; a stage entered out of the list's order, or
 *   one the script never enters, throws, so editing the script without the list (or the list without the script) fails the
 *   next run, and the test over this module reads both.
 * - **Kinds are ascending in cost, and a kind never returns.** `source` reads no build output, `build` compiles or imports
 *   what a build wrote, `test` runs a suite. A `build` stage listed after a `test` stage is a gate waiting behind the
 *   slowest work for nothing; {@link stageOrderViolations} names it.
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

/**
 * Every stage, in the order it runs. `static: false` marks a stage a `--static` run leaves out (it runs a suite or reads a
 * build only a suite's run makes). Within a kind, the cheapest first: the stages that ask git alone, then the gates that read
 * a handful of files, then the ones that read the whole tree.
 */
export const PREFLIGHT_STAGES = Object.freeze([
  { name: 'unregistered-local-files', kind: 'source' },
  { name: 'check-changelog', kind: 'source' },
  { name: 'todo:check', kind: 'source' },
  ...SOURCE_GATES.map(([name]) => ({ name, kind: 'source' })),
  { name: 'unrun-tests', kind: 'source' },
  { name: 'lint:docs', kind: 'source' },
  { name: 'test files parse', kind: 'source' },

  { name: 'build:server', kind: 'build' },
  ...BUILT_GATES.map(([name]) => ({ name, kind: 'build' })),
  { name: 'surface-matrix-audit', kind: 'build' },
  { name: 'typecheck:client', kind: 'build' },
  { name: 'build:prod', kind: 'build', static: false },
  { name: 'bundle-budgets', kind: 'build', static: false },

  { name: 'client unit tests', kind: 'test', static: false },
  { name: 'test:standalone (offline subset)', kind: 'test' },
].map(Object.freeze));

/**
 * What is wrong with the order of `stages`, as sentences: a kind it does not know, a stage listed after a costlier kind began,
 * and a name listed twice. Empty means the order holds.
 *
 * @param {ReadonlyArray<{name: string, kind: string}>} stages
 * @returns {string[]}
 */
export function stageOrderViolations(stages) {
  const out = [];
  const seen = new Set();
  let reached = 0;
  for (const [i, s] of stages.entries()) {
    const rank = STAGE_KINDS.indexOf(s.kind);
    if (rank < 0) { out.push(`stage ${i + 1} (${s.name}) has kind ${JSON.stringify(s.kind)}; the kinds are ${STAGE_KINDS.join(', ')}`); continue; }
    if (rank < reached) {
      out.push(`stage ${i + 1} (${s.name}, ${s.kind}) is listed after a ${STAGE_KINDS[reached]} stage: run it before the costlier kind starts`);
    }
    reached = Math.max(reached, rank);
    if (seen.has(s.name)) out.push(`stage ${i + 1} (${s.name}) is listed twice`);
    seen.add(s.name);
  }
  return out;
}

/**
 * The runner the script enters each stage through.
 *
 * @param {object} o
 * @param {Array<{name: string, why: string}>} o.failures the script's own failure list; a stage failing pushes to it
 * @param {boolean} o.isStatic a `--static` run: stages marked `static: false` are not expected
 * @param {(stop: {notRun: string[]}) => never} o.onStop called, once, at the first `begin` that finds a failure; it must not return
 * @param {ReadonlyArray<{name: string, kind: string, static?: boolean}>} [o.stages]
 * @param {() => number} [o.now] the clock, in milliseconds; injected so a test writes the gaps it expects
 * @returns {{ begin: (name: string) => void, end: () => void, timings: () => StageTiming[] }}
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
    /** Entered at the top of a stage: stops the run if an earlier stage failed, else checks this is the stage the list says is next. */
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

/** @typedef {{ name: string, kind: string, ms: number, outcome: 'passed' | 'failed' | 'not-run' }} StageTiming */
