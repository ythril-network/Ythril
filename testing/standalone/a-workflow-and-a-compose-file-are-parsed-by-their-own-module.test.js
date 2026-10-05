/**
 * A CI workflow and a compose file are each parsed by ONE module, and every gate and script that asks what they say asks it.
 *
 * ## The failure this prevents
 *
 * bundle-56's diff pass found the same two readings written over and over: `scripts/unrun-tests.mjs` parsed `ci.yml` and
 * walked `step.run` beside `testing/_shared/ci-workflow.mjs`, three gates each `yaml.load`ed a compose file, and four
 * resolved `${VAR:-default}` and a size like `1280m` their own way. The copy that matters is the one that RECORDS
 * rather than refuses: a test command moved out of `ci.yml` into a local composite action is still run, but a reader of
 * `step.run` alone sees nothing, derives "no selection" or "no stack", and reports clean. The readers are now
 * `testing/_shared/ci-workflow.mjs` (which follows a local composite action) and `testing/_shared/compose-file.mjs`.
 *
 * ## The rule, and how its subjects are found
 *
 * A file of the repository's scripts, tests and benchmarks that imports `js-yaml` AND names a workflow, a local action or
 * a compose file is a second reader. The set is DERIVED — every tracked `.js`/`.mjs`/`.cjs` under those folders, comments
 * stripped (a docblock explaining the rule names every one of these), with a floor — so a file added next year is held
 * to it without anyone editing a list. The only exemptions are the two modules that own the reading, and this gate,
 * whose fixtures name the paths on purpose.
 *
 * Run: node --test testing/standalone/a-workflow-and-a-compose-file-are-parsed-by-their-own-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { REPO_ROOT, readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The modules that own the reading of each file kind. */
const OWNERS = ['testing/_shared/ci-workflow.mjs', 'testing/_shared/compose-file.mjs'];
const SELF = relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');

const IMPORTS_YAML_PARSER = /['"]js-yaml['"]/;
/** A path or name that says the file is a CI workflow, a local action or a compose file. */
const NAMES_A_YAML_SUBJECT = /\.github[\\/](?:workflows|actions)|\bci\.yml\b|docker-compose[\w.-]*\.ya?ml/;

const sources = () => readTrackedSources(['scripts', 'testing', 'benchmarks'], { ext: ['.js', '.mjs', '.cjs'], floor: 500 })
  .map(({ file, text }) => ({ file, code: stripComments(text) }));

describe('a workflow and a compose file are parsed by their own module', () => {
  it('derives the sources it sweeps, and the two owners are among them', () => {
    const files = sources().map(s => s.file);
    for (const owner of OWNERS) assert.ok(files.includes(owner), `${owner} is not among the swept sources: the derivation is broken`);
  });

  it('no other file parses YAML while naming a workflow, a local action or a compose file', () => {
    const second = sources()
      .filter(({ file }) => !OWNERS.includes(file) && file !== SELF)
      .filter(({ code }) => IMPORTS_YAML_PARSER.test(code) && NAMES_A_YAML_SUBJECT.test(code))
      .map(({ file }) => file);
    assert.deepEqual(second, [],
      'these read a workflow or a compose file themselves: use loadWorkflow/shellOf (testing/_shared/ci-workflow.mjs) or '
      + 'loadCompose/resolveDefaults/memoryMiB (testing/_shared/compose-file.mjs), so a command moved into a composite '
      + 'action, or a value written with a default, is read the same way by every gate');
  });

  it('the pattern fires on each way of being a second reader, and not on prose', () => {
    const second = (code) => IMPORTS_YAML_PARSER.test(stripComments(code)) && NAMES_A_YAML_SUBJECT.test(stripComments(code));
    assert.ok(second("import { load } from 'js-yaml';\nconst f = '.github/workflows/ci.yml';"));
    assert.ok(second("import yaml from \"js-yaml\";\nyaml.load(read('docker-compose.yml'));"));
    assert.ok(second("const { load } = require('js-yaml');\nread('.github/actions/x/action.yml');"));
    assert.ok(!second("// see ci.yml and docker-compose.yml\nimport { load } from 'js-yaml';\nload(text);"), 'a comment was read as naming a subject');
    assert.ok(!second("const f = '.github/workflows/ci.yml'; // js-yaml parses it elsewhere"), 'a comment was read as the import');
    assert.ok(!second("import { load } from 'js-yaml';\nload(read('k8s/app.yaml'));"), 'a different YAML subject was flagged');
  });
});
