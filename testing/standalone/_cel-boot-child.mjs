/**
 * The child process `a-stored-rule-that-no-longer-compiles-is-skipped-and-reported.test.js` runs the boot check in.
 *
 * ## Why a child
 *
 * The check is process-wide state: a gauge, a once-only warning per (space, rule, content), a posture row. A test that ran it
 * in-process would leave all three behind for every other test in the file, and would read the gauge another case set. And
 * "the engine cannot load" cannot be staged in the test's own process at all, because a hook that refuses `@bufbuild/*` would
 * refuse it for the rest of the file; here it is registered before anything is imported.
 *
 * ## The spec (argv[2], JSON)
 *
 *   { "config": "<path to a config.json>", "engineDown": false, "runs": 2 }
 *
 * Loads the config, runs `checkStoredRules()` `runs` times (the second run is the "said once" question), then prints one JSON
 * line: the invalid-rules gauge, the log lines the check said, the posture rows about rules, `invalidRulesOf` per space, and what
 * validating one record against each space says (so "every rule then reports could-not-evaluate" is read off the same process).
 */
import { register } from 'node:module';
/** Not imported from the fixtures module: that loads the schema bodies, and this process must control what loads first. */
const REPO_DIST = '../../server/dist/';

const spec = JSON.parse(process.argv[2]);
process.env['CONFIG_PATH'] = spec.config;
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

if (spec.engineDown) {
  // Refuse the CEL packages before anything imports them, the way a broken install or a missing native/wasm file would.
  const hooks = `export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@bufbuild/')) throw new Error('the rule engine could not be loaded (refused by the test)');
    return next(specifier, context);
  }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}

const lines = [];
const { subscribeLogLines } = await import(`${REPO_DIST}util/log.js`);
subscribeLogLines((l) => lines.push(l));

const loader = await import(`${REPO_DIST}config/loader.js`);
loader.loadConfig();

const rules = await import(`${REPO_DIST}spaces/schema-rules.js`);
for (let i = 0; i < (spec.runs ?? 1); i++) await rules.checkStoredRules();

const { register: metrics } = await import(`${REPO_DIST}metrics/registry.js`);
const gauge = (await metrics.getSingleMetric('ythril_schema_rules_invalid')?.get())?.values?.map(v => v.value) ?? null;

const { computeSecurityPosture } = await import(`${REPO_DIST}config/security-posture.js`);
const posture = computeSecurityPosture().checks.filter(c => /rule/i.test(`${c.id} ${c.message}`));

const { validateEntity } = await import(`${REPO_DIST}spaces/schema-validation.js`);
const { recordViewOf } = await import(`${REPO_DIST}brain/record-view.js`);
const spaces = {};
for (const s of loader.getConfig().spaces) {
  spaces[s.id] = {
    invalid: rules.invalidRulesOf(s.meta ?? {}),
    validated: validateEntity(s.meta ?? {}, recordViewOf('entity', spec.record ?? { name: 'Acme', type: 'thing', description: '', tags: [], properties: { b: 5 } })),
  };
}

console.log(JSON.stringify({ gauge, lines: lines.filter(l => /rule/i.test(l)), posture, spaces }));
process.exit(0);
