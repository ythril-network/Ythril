/**
 * A database test never lets the local embedding model download: the harness forbids it, once, for every file that
 * reaches it, and no file in its reach keeps a copy of that rule (Q-583).
 *
 * ## The failure this prevents
 *
 * A test that opens the test Mongo can reach the model loader without meaning to: a recall through a door goes
 * through `recallGlobal`, which embeds the query before it asks whether search is available; a write, a merge or a
 * file embed can embed too. On a cold cache with nothing forbidding it, the loader DOWNLOADS the model (about 274 MB
 * from huggingface) inside the test's timeout. The personal-view test did exactly that in bundle-169's preflight and
 * timed out at 60 s, at base too; `a-peer-token-meets-a-held-space-on-the-search-doors-db`'s controls case downloaded
 * 523 MB in 72 s when probed. The guard was a copy: about ninety files wrote `process.env['YTHRIL_MODELS_OFFLINE'] = '1'`
 * themselves, and about two hundred and fifty harness users had none, so whether a test could download depended on
 * whether its author had remembered.
 *
 * Offline alone is half the guard: offline with a WARM default cache still loads and runs the real model. So the
 * harness also points `MODEL_CACHE_DIR` at a path that holds no model and is never created, which makes the loader
 * answer "unavailable" at once.
 *
 * ## What it asserts
 *
 * - (a) its subjects are DERIVED: every tracked file under `testing/` whose relative-import closure reaches
 *   `_mongo-harness.mjs`, at any depth, with a floor; plus everything those files import or start by path.
 * - (b) the harness assigns `YTHRIL_MODELS_OFFLINE` and `MODEL_CACHE_DIR` at top level: parsed, so a comment or a
 *   string is not an assignment, and not inside a function, so importing it is enough.
 * - (c) a child started with `testChildEnv` (from an environment holding none of the four variables) that imports
 *   ONLY the harness sees `modelsOffline()` true and a `MODEL_CACHE_DIR` that does not exist, so no model's
 *   `config.json` is in it and the harness did not create it.
 * - (d) no subject assigns, deletes or spread-overrides `YTHRIL_MODELS_OFFLINE`, `HF_HUB_OFFLINE`,
 *   `TRANSFORMERS_OFFLINE` or `MODEL_CACHE_DIR`, nor creates or writes the `MODEL_CACHE_DIR` path. A copy there is
 *   either redundant or overrides the one guard. **Kept copies are derived, not listed:** a file that also runs where
 *   the harness never loads — a helper imported by a test outside the closure, or a script started by URL or path from
 *   one — needs its own assignment, and is printed with that reason. A file that itself reaches the harness is never
 *   exempt, whoever else names it: wherever it runs, the harness has run first.
 *
 * ## What it does not assert, and who does
 *
 * (c) checks the harness's INPUTS to the loader. That those inputs make the loader refuse without touching the
 * network, and that they reach the supervised inference child, is held by the outcome tests:
 * `local-pipeline-loader.test.js`, `no-runtime-model-egress.test.js`, `local-inference-host.test.js` and
 * `local-inference-child-lifecycle.test.js`.
 *
 * Run: node --test testing/standalone/a-database-test-never-downloads-a-model.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackedSources, REPO_ROOT, isTestFile } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { parseSource, lineOf, walkOwnCode, walkEveryNode, unwrapExpression, ts } from '../_shared/syntax-tree.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { WRITES, NOT_WRITES, GRAPH, HARNESS as GRAPH_HARNESS, GRAPH_EXPECTED } from './_fixtures/model-env-writes.mjs';

const HARNESS = 'testing/standalone/_mongo-harness.mjs';
/** The variables that decide whether the local model may download, and where it is looked for. */
const MODEL_ENV = ['YTHRIL_MODELS_OFFLINE', 'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'MODEL_CACHE_DIR'];
/** What the harness must assign: the explicit offline spelling, and a cache holding no model. */
const HARNESS_ASSIGNS = ['YTHRIL_MODELS_OFFLINE', 'MODEL_CACHE_DIR'];
/** The model the server loads when nothing names another (`config/loader.ts`). A literal: this is the expected value. */
const DEFAULT_MODEL = 'nomic-ai/nomic-embed-text-v1.5';
/** Calls that create or write the path in their first argument. */
const CREATES = new Set(['mkdirSync', 'mkdir', 'mkdtempSync', 'mkdtemp', 'writeFileSync', 'writeFile', 'cpSync', 'cp',
  'copyFileSync', 'copyFile', 'appendFileSync', 'appendFile', 'createWriteStream']);
/** The fewest files reaching the harness that means the scan worked (421 when written; far under it on purpose). */
const REACH_FLOOR = 300;

// ─── reading a source ────────────────────────────────────────────────────────────────────────────────────────────────

const isProcessEnv = (e) => {
  const x = unwrapExpression(e);
  return !!x && ts.isPropertyAccessExpression(x) && x.name.text === 'env'
    && ts.isIdentifier(x.expression) && x.expression.text === 'process';
};

/** The model variable `e` reads off `process.env` (`process.env.X`, `process.env['X']`), or null. */
function envMember(e) {
  const x = unwrapExpression(e);
  if (!x) return null;
  if (ts.isPropertyAccessExpression(x) && isProcessEnv(x.expression)) return MODEL_ENV.includes(x.name.text) ? x.name.text : null;
  if (ts.isElementAccessExpression(x) && isProcessEnv(x.expression) && ts.isStringLiteralLike(x.argumentExpression)) {
    return MODEL_ENV.includes(x.argumentExpression.text) ? x.argumentExpression.text : null;
  }
  return null;
}

/** The model variable an object literal's property names (`X:`, `'X':`, `['X']:`, `X` shorthand), or null. */
function propertyName(p) {
  if (ts.isShorthandPropertyAssignment(p)) return MODEL_ENV.includes(p.name.text) ? p.name.text : null;
  if (!ts.isPropertyAssignment(p)) return null;
  const n = p.name;
  const text = ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text
    : ts.isComputedPropertyName(n) && ts.isStringLiteralLike(n.expression) ? n.expression.text : null;
  return text && MODEL_ENV.includes(text) ? text : null;
}

const ASSIGNING = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.PlusEqualsToken]);

/**
 * Every place `text` changes a model variable or creates the cache path, as `{ line, name, form }`. Parsed, so a
 * comment or a string is never a write; nested functions included, because a `before()` hook's write is the file's.
 */
export function modelEnvWrites(file, text) {
  if (!MODEL_ENV.some(n => text.includes(n))) return [];
  const sf = parseSource(file, text);
  const found = [];
  const add = (node, name, form) => found.push({ line: lineOf(sf, node), name, form });
  // Bindings that hold the cache path, so `mkdir(join(cache, …))` is seen as creating it.
  const cacheBindings = new Set();
  walkEveryNode(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && walkOwnCode(n.initializer, (x) => envMember(x) === 'MODEL_CACHE_DIR')) cacheBindings.add(n.name.text);
  });
  const namesCachePath = (arg) => walkOwnCode(arg, (x) => envMember(x) === 'MODEL_CACHE_DIR'
    || (ts.isIdentifier(x) && cacheBindings.has(x.text)));
  walkEveryNode(sf, (n) => {
    if (ts.isBinaryExpression(n) && ASSIGNING.has(n.operatorToken.kind)) {
      const name = envMember(n.left);
      if (name) add(n, name, 'assigns');
    } else if (ts.isDeleteExpression(n)) {
      const name = envMember(n.expression);
      if (name) add(n, name, 'deletes');
    } else if (ts.isCallExpression(n)) {
      const callee = unwrapExpression(n.expression);
      const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      const objectArgs = (args) => args.map(unwrapExpression).filter(a => a && ts.isObjectLiteralExpression(a));
      if (calleeName === 'assign' && n.arguments[0] && isProcessEnv(n.arguments[0])) {
        for (const o of objectArgs(n.arguments.slice(1))) for (const p of o.properties) {
          const name = propertyName(p);
          if (name) add(p, name, 'Object.assign onto process.env');
        }
      } else if (calleeName === 'testChildEnv') {
        for (const o of objectArgs(n.arguments.slice(0, 1))) for (const p of o.properties) {
          const name = propertyName(p);
          if (name) add(p, name, "testChildEnv's extra overrides");
        }
      } else if (CREATES.has(calleeName) && n.arguments[0] && namesCachePath(n.arguments[0])) {
        add(n, 'MODEL_CACHE_DIR', `creates the cache path (${calleeName})`);
      }
    } else if (ts.isObjectLiteralExpression(n) && n.properties.some(p => ts.isSpreadAssignment(p) && isProcessEnv(p.expression))) {
      for (const p of n.properties) {
        const name = propertyName(p);
        if (name) add(p, name, 'spreads process.env and overrides');
      }
    }
  });
  return found;
}

/** Top-level (never inside a function) assignments to model variables in `text`, by name. */
function topLevelAssignments(file, text) {
  const sf = parseSource(file, text);
  const names = new Set();
  walkOwnCode(sf, (n) => {
    if (ts.isBinaryExpression(n) && ASSIGNING.has(n.operatorToken.kind)) {
      const name = envMember(n.left);
      if (name) names.add(name);
    }
    return false;
  });
  return names;
}

// ─── the derived rule ────────────────────────────────────────────────────────────────────────────────────────────────

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.\.?\/[^'"]+)['"]/g;
const SCRIPT_LITERAL = /['"`]((?:\.?\.?\/)?[\w@.\-/]+\.[cm]?js)['"`]/g;

/**
 * Who reaches the harness, who is a subject, and who is exempt — over `files` (path -> text, repo-relative).
 *
 * - reaching: files whose import closure contains `harness` (reverse closure over relative imports).
 * - subjects: reaching, plus everything they import or start by path, transitively.
 * - reachedFromOutside: what a test file NOT reaching the harness imports or starts, transitively, never walking into
 *   a reaching file (that file loads the harness wherever it runs) — mapped to the test it was reached from.
 */
export function harnessReach(files, harness) {
  const has = (f) => files.has(f);
  const imports = new Map();
  const starts = new Map();
  for (const [f, raw] of files) {
    const code = stripComments(raw);
    const dir = posix.dirname(f);
    const imp = new Set();
    for (const m of code.matchAll(IMPORT)) {
      const p = posix.normalize(posix.join(dir, m[1]));
      if (has(p)) imp.add(p);
    }
    const st = new Set();
    for (const m of code.matchAll(SCRIPT_LITERAL)) {
      for (const p of [posix.normalize(posix.join(dir, m[1])), posix.normalize(m[1])]) {
        if (has(p) && p !== f && !imp.has(p) && !isTestFile(p)) st.add(p);
      }
    }
    imports.set(f, imp);
    starts.set(f, st);
  }
  const importers = new Map();
  for (const [f, deps] of imports) for (const d of deps) (importers.get(d) ?? importers.set(d, []).get(d)).push(f);
  const reaching = new Set([harness]);
  for (const queue = [harness]; queue.length;) {
    for (const i of importers.get(queue.pop()) ?? []) if (!reaching.has(i)) { reaching.add(i); queue.push(i); }
  }
  const subjects = new Set(reaching);
  for (const queue = [...reaching]; queue.length;) {
    const f = queue.pop();
    for (const d of [...imports.get(f), ...starts.get(f)]) if (!subjects.has(d)) { subjects.add(d); queue.push(d); }
  }
  const reachedFromOutside = new Map();
  for (const root of [...files.keys()].filter(f => isTestFile(f) && !reaching.has(f)).sort()) {
    const seen = new Set([root]);
    for (const queue = [root]; queue.length;) {
      const f = queue.pop();
      const via = [...[...imports.get(f)].map(d => [d, 'imported']), ...[...starts.get(f)].map(d => [d, 'started by path'])];
      for (const [d, how] of via) {
        if (seen.has(d) || reaching.has(d)) continue;
        seen.add(d);
        queue.push(d);
        if (!reachedFromOutside.has(d)) reachedFromOutside.set(d, `${how}${f === root ? '' : ' (through ' + f + ')'} by ${root}, which never loads the harness`);
      }
    }
  }
  return { reaching, subjects, reachedFromOutside };
}

/** Every file in `files` that writes a model variable, sorted into forbidden, exempt (with its reason) and outside. */
export function modelGuardVerdict(files, harness) {
  const { reaching, subjects, reachedFromOutside } = harnessReach(files, harness);
  const forbidden = [];
  const exempt = [];
  const outside = [];
  for (const [f, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (f === harness) continue;
    const writes = modelEnvWrites(f, text);
    if (writes.length === 0) continue;
    if (reaching.has(f) || (subjects.has(f) && !reachedFromOutside.has(f))) forbidden.push({ file: f, writes });
    else if (reachedFromOutside.has(f)) exempt.push({ file: f, writes, reason: reachedFromOutside.get(f) });
    else outside.push({ file: f, writes });
  }
  return { reaching, subjects, forbidden, exempt, outside };
}

// ─── the parser sees every form ──────────────────────────────────────────────────────────────────────────────────────

describe('what the detector reads as a write to a model variable', () => {
  for (const { form, name, source } of WRITES) {
    it(`finds it: ${form}`, () => {
      const got = modelEnvWrites('x.test.js', source);
      assert.equal(got.length, 1, `expected one write in: ${source}\ngot ${JSON.stringify(got)}`);
      assert.equal(got[0].name, name);
    });
  }

  it('reads, mentions, comments, strings and other variables are not writes', () => {
    for (const source of NOT_WRITES) assert.deepEqual(modelEnvWrites('x.test.js', source), [], `wrongly found in: ${source}`);
  });

  it('sorts the shapes of the derived rule: in the closure forbidden, reached from outside exempt, outside not a subject', () => {
    const v = modelGuardVerdict(new Map(Object.entries(GRAPH)), GRAPH_HARNESS);
    assert.deepEqual(v.forbidden.map(x => x.file), GRAPH_EXPECTED.forbidden);
    assert.deepEqual(v.exempt.map(x => x.file), GRAPH_EXPECTED.exempt);
    assert.deepEqual(v.outside.map(x => x.file), GRAPH_EXPECTED.outside);
    for (const e of v.exempt) assert.match(e.reason, /never loads the harness/);
  });
});

// ─── the repository ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('a database test never downloads a model', () => {
  const files = new Map(trackedSources('testing', { ext: ['.js', '.mjs', '.cjs'], floor: 500 })
    .map(f => [f, readFileSync(join(REPO_ROOT, f), 'utf8')]));

  it('(a) the files reaching the harness are derived from the import graph (floor)', (t) => {
    assert.ok(files.has(HARNESS), `${HARNESS} is not tracked — re-anchor this gate`);
    const { reaching, subjects } = harnessReach(files, HARNESS);
    t.diagnostic(`${reaching.size} file(s) reach the harness; ${subjects.size} subject(s) with what they import or start`);
    assert.ok(reaching.size >= REACH_FLOOR,
      `only ${reaching.size} file(s) reach ${HARNESS} — the import scan is broken, and a short set passes every assertion below`);
    assert.ok(subjects.size >= reaching.size);
  });

  it('(b) the harness assigns the offline flag and an empty model cache at top level, not inside a function', () => {
    const assigned = topLevelAssignments(HARNESS, readFileSync(join(REPO_ROOT, HARNESS), 'utf8'));
    const missing = HARNESS_ASSIGNS.filter(n => !assigned.has(n));
    assert.deepEqual(missing, [],
      `${HARNESS} does not assign ${missing.join(' and ')} at top level. Every database test imports it, so it is the one `
      + 'place the guard cannot be forgotten: offline forbids the download, and a cache holding no model stops a warm '
      + 'default cache from running the real model.');
  });

  it('(c) a child importing only the harness is offline, with a model cache that does not exist', () => {
    const dist = join(REPO_ROOT, 'server/dist/brain/models-offline.js');
    assert.ok(existsSync(dist), `${dist} is missing — build the server (npm run build) before this gate`);
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !MODEL_ENV.includes(k.toUpperCase())));
    const code = [
      `await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, HARNESS)).href)});`,
      `const { modelsOffline } = await import(${JSON.stringify(pathToFileURL(dist).href)});`,
      "const { existsSync } = await import('node:fs');",
      "const { join } = await import('node:path');",
      "const dir = process.env['MODEL_CACHE_DIR'] ?? null;",
      `const config = dir === null ? null : existsSync(join(dir, ...${JSON.stringify(DEFAULT_MODEL.split('/'))}, 'config.json'));`,
      "console.log(JSON.stringify({ offline: modelsOffline(), dir, exists: dir === null ? null : existsSync(dir), config }));",
    ].join('\n');
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      { cwd: REPO_ROOT, env: testChildEnv({}, base), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `the child failed: ${r.stderr}`);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(seen.offline, true, `a process that imported only the harness may download the model: ${JSON.stringify(seen)}`);
    assert.equal(typeof seen.dir, 'string', `the harness leaves MODEL_CACHE_DIR unset, so the default cache is used: ${JSON.stringify(seen)}`);
    assert.equal(seen.config, false, `the harness's model cache holds ${DEFAULT_MODEL}: ${JSON.stringify(seen)}`);
    assert.equal(seen.exists, false, `the harness's model cache path exists (${seen.dir}); it is never created: ${JSON.stringify(seen)}`);
  });

  it('(d) no file in the harness\'s reach keeps its own copy of the rule; kept copies are derived and printed', (t) => {
    const v = modelGuardVerdict(files, HARNESS);
    for (const e of v.exempt) {
      t.diagnostic(`kept: ${e.file} (${e.writes.map(w => `${w.name} :${w.line}`).join(', ')}) - ${e.reason}`);
    }
    const lines = v.forbidden.flatMap(f => f.writes.map(w => `${f.file}:${w.line}  ${w.form} ${w.name}`));
    assert.deepEqual(lines, [],
      `${v.forbidden.length} file(s) in the harness's reach change a model variable themselves (${lines.length} site(s)). `
      + 'The harness forbids the download for every one of them; a copy is redundant at best and overrides the guard at '
      + 'worst. A test that needs ranking uses the stub embedder (EMBEDDING_URL), which the offline flag does not touch:\n  '
      + lines.join('\n  '));
  });
});
