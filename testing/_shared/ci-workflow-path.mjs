/**
 * Where the CI workflow lives — the one place the path is written.
 *
 * It is a module of its own, with no import, because its readers do not all have the dependencies the parsed
 * reading needs: `ci-workflow.mjs` parses YAML with `js-yaml`, which a job that runs `npm ci` has and the timings
 * summary job (`node scripts/test-times.mjs --summary`, which only downloads artifacts) does not. A script that
 * only needs to NAME the workflow — `test-times.mjs` recognises a run by it — imports this and nothing heavier;
 * everything that reads the workflow's contents comes through `ci-workflow.mjs`, which re-exports it.
 */
export const CI_WORKFLOW = '.github/workflows/ci.yml';

/**
 * The full run's workflow, and the prefix of the refs it runs for — the one place both are written.
 *
 * **What a full run is.** The bundle's one full run of every suite on CI, made on its branch before its pull request is
 * opened (owner decision D-15). `full-run.yml` is a two-line caller of `ci.yml`: a push to a ref under `FULL_RUN_PREFIX`
 * runs the whole graph, and nothing else runs without a pull request.
 *
 * **Why a ref of its own.** A push trigger on the pull request's branch would run the graph twice on every later push
 * (the push, then the pull_request synchronize) for as long as the pull request is open. The bundle's commits are pushed to
 * `<FULL_RUN_PREFIX><bundle>` instead, and the branch the pull request is opened from carries the same commits later.
 *
 * **Why its checks are named differently.** A called workflow's jobs report as `<caller job name> / <called job name>`, so
 * the gate reports as `Full run / Build & Test` and never as the exact context the ruleset requires on `main`. The pull
 * request's own `Build & Test` stays the only merge gate, and a red full run blocks nothing that merges.
 *
 * Import-free for the reason `CI_WORKFLOW` is: a script that only has to NAME the workflow or the prefix must not need
 * `js-yaml`; everything that reads the workflow's contents comes through `ci-workflow.mjs`, which re-exports these.
 */
export const FULL_RUN_WORKFLOW = '.github/workflows/full-run.yml';
export const FULL_RUN_PREFIX = 'full-run/';
