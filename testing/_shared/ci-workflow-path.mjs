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
