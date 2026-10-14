/**
 * A STORED rule that no longer compiles is skipped and reported — loudly, once, and without blocking anybody (F-46, ruling R6-4).
 *
 * ## How a stored rule goes bad
 *
 * The save refuses every rule the instance could not apply. Rules still go bad afterwards: a property the rule reads is removed from
 * its type by a later edit, a library entry a type references changes, a peer's layer arrives from a release with a different
 * engine, a `config.json` is edited by hand. The rule is then stored, replicated and evaluated on every write — and if "cannot
 * run" meant "could not evaluate", which is a VIOLATION, one dead rule would refuse every write of its type in a strict space,
 * for every caller, with a message about the record. So a rule that no longer compiles, or reads a property its type no longer
 * declares, is SKIPPED (the other rules still run) and REPORTED:
 *
 * - on `space_meta` as `invalidRules`, names only — never the rule text and never a message (see `cel-rules-on-both-doors-db`);
 * - in the gauge `ythril_schema_rules_invalid`, declared at 0 so it exists before anything is wrong;
 * - as a posture warning, and one `warnOnce` log line per (space, rule, content), so a fix-and-break-again is said again and a
 *   restart loop is not said a hundred times.
 *
 * ## The boot check, and the two ways it is not allowed to be absent
 *
 * `checkStoredRules()` compiles every stored rule at every configured start, in `startConfiguredInstanceServices` — the one function
 * boot and the setup route both run, so a fresh install's first configuration runs it (`pitfall-first-run-skips-the-boot-path`) —
 * after the library is loaded and seeded, so a `$ref` is a definition by then. It STARTS with a canary: one known-good rule is
 * compiled and evaluated first. If that fails the engine is not loaded, and the answer is the opposite of the one above: a
 * posture FAIL and a metric, and every rule reports could-not-evaluate — fail closed, because "the engine is down" is not
 * "the rule is dead", and a strict space must not become open because a file is missing from an image.
 *
 * ## Why the check runs in a child process
 *
 * Process-wide state (a gauge, a once-only warning, a posture row) and an engine that cannot load are both things a test cannot
 * stage in its own process without leaking them into every other case. `_cel-boot-child.mjs` says how.
 *
 * Run: node --test testing/standalone/a-stored-rule-that-no-longer-compiles-is-skipped-and-reported.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';
import {
  rule, DECLARED, strictMeta, recordOf, ruleRows, validateRecord, schemaRules, evaluation, REPO_DIST,
} from './_cel-rules.mjs';

const CHILD = fileURLToPath(new URL('./_cel-boot-child.mjs', import.meta.url));

/** The rule texts, kept apart so "names only" can be asserted against them. */
const BROKEN_TEXT = `self.properties.b < `;
const GONE_TEXT = `self.properties.removed == 'x'`;
const SPACE_BROKEN_TEXT = `size(self.title) >`;
const FINE_TEXT = `self.properties.b < 100.0`;

/** A stored meta with two dead type rules, one dead space rule and one live type rule. */
const damagedMeta = () => ({
  ...strictMeta({
    rules: {
      broken: rule(BROKEN_TEXT, 'this rule is not an expression'),
      gone: rule(GONE_TEXT, 'this rule reads a property the type no longer declares'),
      fine: rule(FINE_TEXT, 'b must be below one hundred'),
    },
    propertySchemas: DECLARED,
  }),
  rules: { spacebroken: rule(SPACE_BROKEN_TEXT, 'a space rule that is not an expression') },
});

describe('a rule that cannot run is skipped, and the rules beside it still run', () => {
  it('a dead rule makes no row; the live one on the same record does', async () => {
    const rows = ruleRows(await validateRecord(damagedMeta(), 'entity', recordOf.entity({ properties: { b: 500 } })));
    assert.deepEqual(rows.map(r => r.field), ['rules.fine'],
      `expected only the live rule to speak: a dead rule was ${rows.some(r => /broken|gone|spacebroken/.test(r.field)) ? 'reported as a violation (it would refuse every write of its type)' : 'not skipped'}; got ${JSON.stringify(rows)}`);
  });

  it('a space with only dead rules refuses nothing: skipped is not could-not-evaluate', async () => {
    const meta = { validationMode: 'strict', ...strictMeta({ rules: { broken: rule(BROKEN_TEXT, 'dead'), gone: rule(GONE_TEXT, 'dead') } }) };
    const { writeValidation } = await evaluation();
    const check = writeValidation.classifyEntityUpsertAgainst(meta, null,
      { name: 'Acme', type: 'thing', description: '', tags: [], properties: { b: 5 } });
    assert.deepEqual(ruleRows(check.introduced), [], `a dead rule introduced a violation: ${JSON.stringify(check.introduced)}`);
    assert.equal(check.blocked, false, 'a dead stored rule blocked a write in a strict space');
    // The control that gives the silence meaning: the same classification, with a LIVE rule beside the dead ones, does refuse.
    const live = { ...meta, typeSchemas: strictMeta({ rules: { broken: rule(BROKEN_TEXT, 'dead'), fine: rule(FINE_TEXT, 'b below 100') } }).typeSchemas };
    const refused = writeValidation.classifyEntityUpsertAgainst(live, null,
      { name: 'Acme', type: 'thing', description: '', tags: [], properties: { b: 500 } });
    assert.deepEqual(ruleRows(refused.introduced).map(v => v.field), ['rules.fine'], 'the live rule did not speak, so nothing above proves a dead one is skipped');
    assert.equal(refused.blocked, true);
  });

  it('the property a rule reads is checked against what the type declares NOW, not what it declared when the rule was saved', async () => {
    const declaredNow = strictMeta({ rules: { gone: rule(GONE_TEXT, 'reads removed') }, propertySchemas: { removed: { type: 'string' } } });
    const rows = ruleRows(await validateRecord(declaredNow, 'entity', recordOf.entity({ properties: { removed: 'y' } })));
    assert.deepEqual(rows.map(r => r.field), ['rules.gone'], 'the control: with the property declared the rule is live and fails this record');
    const rowsAfter = ruleRows(await validateRecord(damagedMeta(), 'entity', recordOf.entity({ properties: { removed: 'y', b: 5 } })));
    assert.deepEqual(rowsAfter, [], 'a rule on a property the type no longer declares still ran');
  });
});

describe('what is reported about a dead rule is its name, and only that', () => {
  it('invalidRulesOf lists the dead rules of a meta, and says nothing of the live one', async () => {
    const { invalidRulesOf } = await schemaRules();
    const listed = JSON.stringify(invalidRulesOf(damagedMeta()));
    for (const name of ['broken', 'gone', 'spacebroken']) assert.match(listed, new RegExp(name), `${name} is not reported: ${listed}`);
    assert.doesNotMatch(listed, /fine/, 'a live rule is reported as invalid');
    for (const text of [BROKEN_TEXT, GONE_TEXT, SPACE_BROKEN_TEXT]) {
      assert.ok(!listed.includes(text.trim()), `the report quotes a rule's text (${text.trim()}): it is names only`);
    }
    assert.doesNotMatch(listed, /not an expression|no longer declares/, 'the report quotes a rule\'s message');
  });

  it('a meta with nothing wrong reports nothing', async () => {
    const { invalidRulesOf } = await schemaRules();
    assert.deepEqual(invalidRulesOf(strictMeta({ rules: { fine: rule(FINE_TEXT, 'b below 100') } })), []);
    assert.deepEqual(invalidRulesOf({ validationMode: 'strict' }), []);
  });
});

describe('the gauge exists before anything is wrong', () => {
  it('ythril_schema_rules_invalid is exported at 0 by a process that has checked nothing', async () => {
    const { register } = await import(`${REPO_DIST}metrics/registry.js`);
    const text = await register.metrics();
    assert.match(text, /^ythril_schema_rules_invalid 0$/m,
      'the gauge is not declared at zero: an alert on it has nothing to read until the first rule goes bad');
  });
});

describe('the boot check', () => {
  let dir;
  const configWith = (spaces) => {
    const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file, JSON.stringify({ instanceId: 'rules-boot', instanceLabel: 'test', tokens: [], networks: [], spaces }, null, 2), { mode: 0o600 });
    return file;
  };
  const space = (id, meta) => ({ id, label: id, folders: [], completeLinkage: true, meta });
  const inChild = (spec) => {
    const r = spawnSync(process.execPath, [CHILD, JSON.stringify(spec)], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_PATH: spec.config, DATA_ROOT: path.join(dir, 'data') } });
    assert.equal(r.status, 0, `the child failed (${r.signal ?? r.status}): ${`${r.stderr}`.slice(-1500)}`);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };

  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-rules-boot-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('counts the dead rules of every space in the gauge, once each however often it runs, and names them to the log once', () => {
    const config = configWith([space('damaged', damagedMeta()), space('healthy', strictMeta({ rules: { fine: rule(FINE_TEXT, 'b below 100') } }))]);
    const out = inChild({ config, runs: 2 });
    assert.deepEqual(out.gauge, [3], `the gauge says ${JSON.stringify(out.gauge)}: three rules are dead, and a second run must not count them again`);
    assert.deepEqual(out.spaces['healthy'].invalid, []);
    assert.match(JSON.stringify(out.spaces['damaged'].invalid), /broken/);
    for (const name of ['broken', 'gone', 'spacebroken']) {
      const said = out.lines.filter(l => l.includes(name));
      assert.equal(said.length, 1, `'${name}' was said ${said.length} times over two runs, expected once (a warnOnce per space, rule and content):\n${out.lines.join('\n')}`);
    }
    assert.ok(out.lines.every(l => !l.includes(BROKEN_TEXT.trim()) && !l.includes(GONE_TEXT)), 'a log line quotes a rule\'s text');
    const posture = out.posture.find(p => p.level === 'warn');
    assert.ok(posture, `no posture warning for the dead rules: ${JSON.stringify(out.posture)}`);
    assert.ok(!out.posture.some(p => p.level === 'fail'), 'dead rules are a warning; only a dead ENGINE is a failure');
  });

  it('a healthy instance has a zero gauge, no lines and no posture row', () => {
    const out = inChild({ config: configWith([space('healthy', strictMeta({ rules: { fine: rule(FINE_TEXT, 'b below 100') } }))]) });
    assert.deepEqual(out.gauge, [0]);
    assert.deepEqual(out.lines, [], `the check said something about a healthy instance: ${out.lines.join(' | ')}`);
    assert.deepEqual(out.posture.filter(p => p.level !== 'pass'), []);
  });

  it('the canary: when the engine cannot load, that is a posture FAIL and every rule reports could-not-evaluate', () => {
    const config = configWith([space('healthy', strictMeta({ rules: { fine: rule(FINE_TEXT, 'b below 100') } }))]);
    const out = inChild({ config, engineDown: true, record: { name: 'Acme', type: 'thing', description: '', tags: [], properties: { b: 5 } } });
    const fail = out.posture.find(p => p.level === 'fail');
    assert.ok(fail, `an engine that cannot load is not a posture failure: ${JSON.stringify(out.posture)}`);
    const rows = ruleRows(out.spaces['healthy'].validated);
    assert.equal(rows.length, 1, `with the engine down the rule must still speak, and fail closed: ${JSON.stringify(out.spaces['healthy'].validated)}`);
    assert.match(rows[0].reason, /could not (be )?evaluate/i, rows[0].reason);
    assert.deepEqual(out.spaces['healthy'].invalid, [], 'a live rule was called dead because the ENGINE was down: that opens a strict space');
    assert.ok(out.lines.some(l => /engine/i.test(l)), `the engine failure was not said: ${out.lines.join(' | ')}`);
  });
});

describe('the boot check runs at every configured start', () => {
  const src = (f) => stripComments(readFileSync(f, 'utf8'));
  const BOOT_FN = 'startConfiguredInstanceServices';

  it('both doors to a configured instance run the one bootstrap function (a fresh install included)', () => {
    for (const f of ['server/src/index.ts', 'server/src/setup/routes.ts']) {
      assert.match(src(f), new RegExp(`await ${BOOT_FN}\\(\\)`), `${f} no longer runs ${BOOT_FN}`);
    }
  });

  it('the bootstrap runs the check once, unconditionally, after the shipped library entries are seeded', () => {
    const body = bodyOf(src('server/src/bootstrap.ts'), BOOT_FN);
    const calls = [...body.matchAll(/\bcheckStoredRules\(/g)].map(m => m.index);
    assert.equal(calls.length, 1, `${BOOT_FN} calls checkStoredRules ${calls.length} time(s), expected exactly one`);
    const seeded = body.search(/\bseedShippedLibraryEntries\(/);
    assert.ok(seeded > -1, 'the anchor moved: the shipped library entries are no longer seeded here, re-anchor this gate');
    assert.ok(calls[0] > seeded, 'the check runs BEFORE the library is seeded, so a $ref type is not yet a definition');
    // Unconditional: no `if`, `&&`, `?` or `isFirstRun` on the statement or any enclosing block but a `try`.
    const before = body.slice(0, calls[0]);
    const blockOpeners = [];
    let depth = 0;
    for (let i = before.length - 1; i >= 0; i--) {
      if (before[i] === '}') depth++;
      else if (before[i] === '{') { if (depth === 0) blockOpeners.push(before.slice(Math.max(0, before.lastIndexOf('\n', i) + 1), i + 1).trim()); else depth--; }
    }
    const enclosing = blockOpeners.slice(0, -1); // the last is the function's own brace
    assert.ok(enclosing.every(h => /^(\}\s*)?try\s*\{$/.test(h)), `the check sits under a condition: ${enclosing.join(' | ')}`);
  });

  it('the check is called from nowhere that could skip it for a fresh install: index.ts does not run it itself', () => {
    assert.doesNotMatch(src('server/src/index.ts'), /\bcheckStoredRules\(/,
      'index.ts runs the check in its own branch: the setup route\'s first configuration would not');
  });
});
