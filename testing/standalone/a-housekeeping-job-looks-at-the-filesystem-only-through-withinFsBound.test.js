/**
 * A housekeeping or interval job looks at the filesystem only inside a `withinFsBound` callback; today's bare looks are a named
 * baseline that may only shrink (Q-792 part 7, bundle-288).
 *
 * ## The defect, and what bought this check
 *
 * Housekeeping steps and interval jobs run single-flight: the next step waits for the one before it. A filesystem call on a hung
 * mount (an NFS or SMB volume that stopped answering) never returns, so a daily sweep doing an `lstat` per row stalls every later
 * housekeeping step for as long as the mount stays hung, and nothing says why. `withinFsBound` (server/src/util/time-bound.ts) is
 * the bound written for exactly this, and the absent-bytes sweep and the space-act runner use it; nothing made the next job use it.
 *
 * ## The rule, over the whole set
 *
 * The JOB SET is derived from the repository, never listed by hand: every tracked `server/src` module importing
 * `util/interval-job.js` or `util/housekeeping-walk.js`, plus `server/src/files/absent-bytes-sweep.ts` (floored, so a broken
 * derivation fails instead of passing over nothing).
 *
 * In a job module a LOOK is a call of one of {@link VERBS} (async or `Sync` form) on `fs` or `fs/promises` under any import alias
 * (default, namespace, named, `fs.promises`), or a call of an imported helper function (one level: a function exported by a
 * `server/src` module, together with the same-module functions that helper calls) whose body makes such a call itself. A look
 * is BOUNDED when it sits inside the callback passed to `withinFsBound`, or inside a same-module function every use of which is
 * itself bounded. Any other look is a HIT, keyed `file :: function :: verb` (never a line: a line moves with every edit above it).
 *
 * Every hit must be named in the baseline beside this file (`<this name>.baseline.json`) as `{ file, function, verb, path, reason,
 * reviewBy }`; a request-path function inside a job module (an upload path in chunks.ts) has `path: "request"` and a reason
 * starting "request path", every other entry `path: "job"`. A
 * hit not in the baseline fails; a baseline entry whose hit is gone fails too, so the list only shrinks. Wrapping today's live
 * sites is its own ticket (an orphaned fs call keeps one of libuv's four threads; see the design's part 7), not this check.
 *
 * Comments: the detector reads the syntax tree (testing/_shared/syntax-tree.mjs), where a comment is trivia and never a node,
 * so a comment naming a call can neither make nor hide a hit; the self-test below plants one to prove it.
 *
 * Not seen (said so the gap is known): a helper passed as a VALUE and called later (`const ask = steps?.look ?? bytesHeldAt`)
 * is judged where it is called, not where it is named; helpers two imports away are not followed.
 *
 * ## Seen red
 *
 * Before the baseline existed this failed on today's tree, listing every bare look; the positive control copies the call of a
 * real baseline site into a new function of its own module and sees the lint fail on it, and pass when the same call is wrapped.
 *
 * Run: node --test testing/standalone/a-housekeeping-job-looks-at-the-filesystem-only-through-withinFsBound.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { ts, parseSource, lineOf, walkEveryNode } from '../_shared/syntax-tree.mjs';

/** The filesystem verbs that can hang on a dead mount, as the design names them. */
export const VERBS = Object.freeze(['lstat', 'stat', 'readdir', 'opendir', 'access', 'realpath', 'open', 'readFile', 'unlink', 'rm',
  'rename', 'mkdir', 'writeFile', 'copyFile']);
const VERB_SET = new Set(VERBS);
const FS_SPEC = /^(node:)?fs(\/promises)?$/;
const JOB_MODULES = ['server/src/util/interval-job.ts', 'server/src/util/housekeeping-walk.ts'];
const ALWAYS_JOB = ['server/src/files/absent-bytes-sweep.ts'];
const BOUND_MODULE = 'server/src/util/time-bound.ts';
/** Measured 2026-11-15 at 44; a derivation that finds fewer has stopped reaching the code. */
const JOB_SET_FLOOR = 40;

const HERE = fileURLToPath(import.meta.url);
const BASELINE_PATH = HERE.replace(/\.test\.js$/, '.baseline.json');

/** The `.ts` file a relative import specifier of `from` names, or null (a package, or a file that does not exist). */
function resolveSpec(from, spec, exists) {
  if (!spec.startsWith('.')) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  for (const cand of [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`]) if (exists(cand)) return cand;
  return null;
}

/** The value imports of a source: `{ local, imported, spec, kind: 'named'|'default'|'namespace' }`, type-only imports left out. */
function importsOf(sf) {
  const out = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const spec = st.moduleSpecifier.text;
    if (clause.name) out.push({ local: clause.name.text, imported: 'default', spec, kind: 'default' });
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.push({ local: nb.name.text, imported: '*', spec, kind: 'namespace' });
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) if (!el.isTypeOnly) out.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, spec, kind: 'named' });
    }
  }
  return out;
}

/** The fs bindings of a source: namespace locals (`fs`, `fsp`, `fs.promises` as a named import) and named verb imports. */
function fsBindingsOf(imports) {
  const ns = new Set();
  const direct = new Map();
  for (const im of imports) {
    if (!FS_SPEC.test(im.spec)) continue;
    if (im.kind !== 'named' || im.imported === 'promises') ns.add(im.local);
    else {
      const base = im.imported.replace(/Sync$/, '');
      if (VERB_SET.has(base)) direct.set(im.local, im.imported);
    }
  }
  return { ns, direct };
}

/** The fs verb a call makes (`lstat`, `lstatSync`), or null. */
function fsVerbOf(call, fsb) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return fsb.direct.get(callee.text) ?? null;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const name = callee.name.text;
  if (!VERB_SET.has(name.replace(/Sync$/, ''))) return null;
  let obj = callee.expression;
  if (ts.isPropertyAccessExpression(obj) && obj.name.text === 'promises') obj = obj.expression;
  return ts.isIdentifier(obj) && fsb.ns.has(obj.text) ? name : null;
}

/** The nearest named function around a node: a declaration, a method, or a `const f = () =>` / `key: () =>` binding. */
function enclosingFunction(node) {
  let binding = null; // a module-level `const job = intervalJob(..., () => look())` names its anonymous callback
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) binding = n.name.text;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n)) && n.name) return { node: n, name: n.name.getText() };
    if (ts.isConstructorDeclaration(n)) return { node: n, name: 'constructor' };
    if ((ts.isFunctionExpression(n) || ts.isArrowFunction(n)) && n.parent) {
      const p = n.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return { node: n, name: p.name.text };
      if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.name) return { node: n, name: p.name.getText() };
    }
  }
  return { node: null, name: binding ?? '<module>' };
}

/** Whether `node` sits inside the callback (first argument) of a call of one of `boundNames`. */
function insideFsBound(node, boundNames) {
  for (let n = node; n?.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isFunctionLike(n) && ts.isCallExpression(p) && p.arguments[0] === n
      && ts.isIdentifier(p.expression) && boundNames.has(p.expression.text)) return true;
  }
  return false;
}

/**
 * The same-module named functions every use of which is bounded: a use inside a `withinFsBound` callback, or inside another such
 * function. The greatest fixpoint, so a recursive walk called only from inside the bound counts as bounded.
 */
function boundedFunctions(sf, boundNames) {
  const fns = new Map(); // name -> function node
  const uses = new Map(); // name -> [identifier nodes]
  walkEveryNode(sf, (n) => {
    if (!ts.isFunctionLike(n)) return;
    if (!n.body) return;
    const { node, name } = enclosingFunction(n.body);
    if (node === n && name !== '<module>' && name !== 'constructor') fns.set(name, n);
  });
  walkEveryNode(sf, (n) => {
    if (!ts.isIdentifier(n) || !fns.has(n.text)) return;
    const p = n.parent;
    if ((ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)
      || ts.isPropertyDeclaration(p)) && p.name === n) return;
    if (ts.isPropertyAccessExpression(p) && p.name === n && p.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return;
    (uses.get(n.text) ?? uses.set(n.text, []).get(n.text)).push(n);
  });
  const bounded = new Set([...fns.keys()].filter(name => (uses.get(name) ?? []).length > 0));
  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...bounded]) {
      const ok = uses.get(name).every(u => insideFsBound(u, boundNames) || bounded.has(enclosingFunction(u).name));
      if (!ok) { bounded.delete(name); changed = true; }
    }
  }
  return bounded;
}

/** The local names `withinFsBound` is imported under in a source. */
function boundNamesOf(file, imports, exists) {
  const names = new Set();
  for (const im of imports) {
    if (im.kind === 'named' && im.imported === 'withinFsBound' && resolveSpec(file, im.spec, exists) === BOUND_MODULE) names.add(im.local);
  }
  if (file === BOUND_MODULE) names.add('withinFsBound');
  return names;
}

/** Whether a function is a hit-free look of its own: a site is bounded when inside the bound or in a function every use of which is. */
function isBounded(node, boundNames, bounded) {
  return insideFsBound(node, boundNames) || bounded.has(enclosingFunction(node).name);
}

/**
 * The fs verbs one exported helper of a module looks with, unbounded: its own direct calls plus those of the same-module functions
 * it calls (the module is read whole; its own imports are not followed). Memoised per `file :: name`.
 */
function helperVerbs(file, name, read, exists, memo) {
  const key = `${file} :: ${name}`;
  if (memo.has(key)) return memo.get(key);
  memo.set(key, []);
  const text = read(file);
  if (text == null) return [];
  const sf = parseSource(file, text);
  const imports = importsOf(sf);
  const fsb = fsBindingsOf(imports);
  const boundNames = boundNamesOf(file, imports, exists);
  const local = new Map();
  walkEveryNode(sf, (n) => {
    if (!ts.isFunctionLike(n) || !n.body) return;
    const ef = enclosingFunction(n.body);
    if (ef.node === n && !local.has(ef.name)) local.set(ef.name, n);
  });
  const exported = new Set();
  for (const st of sf.statements) {
    const isExp = st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExp && ts.isFunctionDeclaration(st) && st.name) exported.add(st.name.text);
    if (isExp && ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) exported.add(d.name.text);
  }
  if (!exported.has(name) || !local.has(name)) return [];
  const verbs = new Set();
  const seen = new Set();
  const visitFn = (fnName) => {
    if (seen.has(fnName) || !local.has(fnName)) return;
    seen.add(fnName);
    const fn = local.get(fnName);
    walkEveryNode(fn, (n) => {
      if (!ts.isCallExpression(n) || insideFsBound(n, boundNames)) return;
      const v = fsVerbOf(n, fsb);
      if (v) verbs.add(v);
      else if (ts.isIdentifier(n.expression) && local.has(n.expression.text)) visitFn(n.expression.text);
    });
  };
  visitFn(name);
  const out = [...verbs].sort();
  memo.set(key, out);
  return out;
}

/**
 * Every unbounded look of one job module: `{ key, file, function, verb, line, call }`. The ONE detector, so the sweep and the
 * self-tests read the same rule. `read(path)` answers a repo file's text (or null); `exists(path)` whether it is a tracked source.
 */
export function bareLooks(file, text, { read, exists, memo = new Map() }) {
  const sf = parseSource(file, text);
  const imports = importsOf(sf);
  const fsb = fsBindingsOf(imports);
  const boundNames = boundNamesOf(file, imports, exists);
  const bounded = boundedFunctions(sf, boundNames);
  const helpers = new Map(); // local name -> { target, imported }
  const namespaces = new Map(); // namespace local -> target
  for (const im of imports) {
    const target = resolveSpec(file, im.spec, exists);
    if (!target || !target.startsWith('server/src/')) continue;
    if (im.kind === 'named') helpers.set(im.local, { target, imported: im.imported });
    if (im.kind === 'namespace') namespaces.set(im.local, target);
  }
  const hits = new Map();
  const add = (node, verb) => {
    const fn = enclosingFunction(node).name;
    const key = `${file} :: ${fn} :: ${verb}`;
    if (!hits.has(key)) hits.set(key, { key, file, function: fn, verb, line: lineOf(sf, node), call: node.getText(sf) });
  };
  walkEveryNode(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const direct = fsVerbOf(n, fsb);
    let viaVerbs = [];
    let via = null;
    if (!direct) {
      const c = n.expression;
      if (ts.isIdentifier(c) && helpers.has(c.text)) {
        const h = helpers.get(c.text);
        via = h.imported;
        viaVerbs = helperVerbs(h.target, h.imported, read, exists, memo);
      } else if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && namespaces.has(c.expression.text)) {
        via = c.name.text;
        viaVerbs = helperVerbs(namespaces.get(c.expression.text), via, read, exists, memo);
      }
    }
    if (!direct && viaVerbs.length === 0) return;
    if (isBounded(n, boundNames, bounded)) return;
    if (direct) add(n, direct);
    for (const v of viaVerbs) add(n, `${v} via ${via}`);
  });
  return [...hits.values()];
}

/** The job set: tracked server/src modules importing the interval-job or housekeeping-walk module, plus the absent-bytes sweep. */
export function jobSet(sources, read, exists) {
  const out = [];
  for (const file of sources) {
    if (ALWAYS_JOB.includes(file)) { out.push(file); continue; }
    const imports = importsOf(parseSource(file, read(file)));
    if (imports.some(im => JOB_MODULES.includes(resolveSpec(file, im.spec, exists)))) out.push(file);
  }
  return out.sort();
}

const SOURCES = trackedSources(SERVER_CODE_ROOTS, { floor: 300, specs: false });
const TRACKED = new Set(SOURCES);
const textCache = new Map();
const read = (f) => {
  if (!textCache.has(f)) textCache.set(f, TRACKED.has(f) && existsSync(join(REPO_ROOT, f)) ? readFileSync(join(REPO_ROOT, f), 'utf8') : null);
  return textCache.get(f);
};
const exists = (f) => TRACKED.has(f);
const memo = new Map();
const JOBS = jobSet(SOURCES, read, exists);
const SWEEP = JOBS.flatMap(file => bareLooks(file, read(file), { read, exists, memo }));
const BASELINE = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).entries : [];
const keyOf = (e) => `${e.file} :: ${e.function} :: ${e.verb}`;

describe('a housekeeping job looks at the filesystem only through withinFsBound', () => {
  it('the job set is derived and reaches the modules it is known to have', () => {
    assert.ok(JOBS.length >= JOB_SET_FLOOR, `only ${JOBS.length} job modules derived (floor ${JOB_SET_FLOOR}): the derivation stopped reaching the code`);
    for (const f of ['server/src/files/absent-bytes-sweep.ts', 'server/src/files/chunk-cleanup-job.ts', 'server/src/brain/ttl-sweep.ts']) {
      assert.ok(JOBS.includes(f), `the job set does not hold ${f}`);
    }
  });

  it('the detector sees today\'s bounded looks as bounded (the absent-bytes sweep and the space-act runner use withinFsBound)', () => {
    const sweep = SWEEP.filter(s => s.file === 'server/src/files/absent-bytes-sweep.ts');
    assert.ok(!sweep.some(s => ['walkFor', 'look'].includes(s.function)), `a look inside withinFsBound was read as bare: ${sweep.map(s => s.key).join(', ')}`);
  });

  it('every bare look in a job module is named in the baseline', () => {
    const named = new Set(BASELINE.map(keyOf));
    const unnamed = SWEEP.filter(s => !named.has(s.key));
    assert.ok(unnamed.length === 0,
      `${unnamed.length} bare look(s): a housekeeping or interval job looks at the filesystem outside withinFsBound (server/src/util/time-bound.ts); on a hung mount `
      + 'it stalls every later step. Put the look inside a withinFsBound callback; a request-path function goes in the baseline with a reason saying so.\n'
      + unnamed.map(s => `  ${s.key} (line ${s.line})`).sort().join('\n'));
  });

  it('every baseline entry is still a live bare look (the baseline only shrinks)', () => {
    const live = new Set(SWEEP.map(s => s.key));
    assert.deepEqual(BASELINE.filter(e => !live.has(keyOf(e))).map(keyOf), [],
      'a baseline entry no longer matches a bare look: remove it, so the list shrinks with the code');
  });

  it('every baseline entry carries a reason and a reviewBy date not yet past', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const e of BASELINE) {
      assert.ok(typeof e.reason === 'string' && e.reason.length > 30, `${keyOf(e)}: a reason is a sentence, not a label`);
      assert.match(String(e.reviewBy), /^\d{4}-\d{2}-\d{2}$/, `${keyOf(e)}: reviewBy is a YYYY-MM-DD date`);
      assert.ok(e.reviewBy >= today, `${keyOf(e)}: reviewBy ${e.reviewBy} has passed: review the entry`);
      assert.ok(e.path === 'job' || e.path === 'request', `${keyOf(e)}: path is 'job' or 'request'`);
      if (e.path === 'request') assert.match(e.reason, /^request path/, `${keyOf(e)}: a request-path entry says so in its reason`);
    }
    assert.equal(new Set(BASELINE.map(keyOf)).size, BASELINE.length, 'a baseline entry is listed twice');
  });

  describe('the detector is seen to find (positive control and self-tests)', () => {
    it('a bare call copied from a real baseline site, planted in a new function of its own module, fails the lint; wrapped, it passes', () => {
      const site = SWEEP.find(s => !s.verb.includes(' via ') && BASELINE.some(e => keyOf(e) === s.key))
        ?? SWEEP.find(s => !s.verb.includes(' via '));
      assert.ok(site, 'no direct bare look found to copy: the control has nothing real to plant');
      const original = read(site.file);
      const planted = `${original}\nexport async function plantedBareLook(): Promise<unknown> { return ${site.call}; }\n`;
      const before = new Set(bareLooks(site.file, original, { read, exists, memo: new Map() }).map(s => s.key));
      const hits = bareLooks(site.file, planted, { read, exists, memo: new Map() }).filter(s => !before.has(s.key));
      assert.deepEqual(hits.map(s => s.key), [`${site.file} :: plantedBareLook :: ${site.verb}`], 'the planted bare look was not found');
      assert.ok(!BASELINE.some(e => keyOf(e) === hits[0].key), 'the planted look is not named, so the baseline test fails on it');
      const wrapped = `import { withinFsBound as plantedBound } from '${posix.relative(posix.dirname(site.file), BOUND_MODULE).replace(/^(?!\.)/, './').replace(/\.ts$/, '.js')}';\n${original}\n`
        + `export async function plantedBoundLook(): Promise<unknown> { return plantedBound(() => ${site.call}, 1000, 'planted'); }\n`;
      const wrappedHits = bareLooks(site.file, wrapped, { read, exists, memo: new Map() }).filter(s => s.function === 'plantedBoundLook');
      assert.deepEqual(wrappedHits, [], 'the same call inside withinFsBound was still read as bare');
    });

    const fake = (files) => ({
      read: (f) => files[f] ?? null,
      exists: (f) => f in files || f === BOUND_MODULE,
      memo: new Map(),
    });
    const keys = (file, files) => bareLooks(file, files[file], fake(files)).map(s => `${s.function} :: ${s.verb}`).sort();

    it('every import alias of fs and fs/promises, and sync forms, are looks', () => {
      const file = 'server/src/x/job.ts';
      const files = { [file]: `import fs from 'fs/promises'; import * as nfs from 'node:fs'; import { lstat as ls, readdirSync } from 'node:fs/promises';
        import { promises as fsp } from 'fs';
        export async function a(p) { await fs.lstat(p); }
        export function b(p) { return nfs.statSync(p); }
        export async function c(p) { await ls(p); readdirSync(p); }
        export async function d(p) { await fsp.unlink(p); await nfs.promises.rm(p); }` };
      assert.deepEqual(keys(file, files), ['a :: lstat', 'b :: statSync', 'c :: lstat', 'c :: readdirSync', 'd :: rm', 'd :: unlink']);
    });

    it('a comment and a string naming a call are not looks; a call inside withinFsBound, or in a function used only there, is bounded', () => {
      const file = 'server/src/x/job.ts';
      const files = { [file]: `import fs from 'node:fs/promises'; import { withinFsBound } from '../util/time-bound.js';
        // await fs.lstat(p)
        export const s = 'fs.stat(p)';
        async function inner(p) { return fs.readdir(p); }
        export async function a(p) { return withinFsBound(() => fs.lstat(p), 10, 'x'); }
        export async function b(p) { return withinFsBound(async () => inner(p), 10, 'x'); }` };
      assert.deepEqual(keys(file, files), []);
      const used = { [file]: `${files[file]}\nexport async function c(p) { return inner(p); }` };
      assert.deepEqual(keys(file, used), ['inner :: readdir'], 'a same-module function also called outside the bound is a bare look');
    });

    it('an imported helper that looks itself is a look one level out; one that does not is not', () => {
      const file = 'server/src/x/job.ts';
      const files = {
        [file]: `import { walk, pure } from './helper.js'; import * as h from './helper.js'; import { withinFsBound } from '../util/time-bound.js';
          export async function a(p) { await walk(p); pure(p); }
          export async function b(p) { await h.walk(p); }
          export async function c(p) { await withinFsBound(() => walk(p), 10, 'x'); }`,
        'server/src/x/helper.ts': `import { opendir } from 'node:fs/promises';
          async function deeper(p) { return opendir(p); }
          export async function walk(p) { return deeper(p); }
          export function pure(p) { return p.length; }`,
      };
      assert.deepEqual(keys(file, files), ['a :: opendir via walk', 'b :: opendir via walk']);
    });

    it('the bound is recognised by what it imports, not by a function of the same name', () => {
      const file = 'server/src/x/job.ts';
      const files = { [file]: `import fs from 'node:fs/promises'; const withinFsBound = (fn) => fn();
        export async function a(p) { return withinFsBound(() => fs.lstat(p)); }` };
      assert.deepEqual(keys(file, files), ['a :: lstat']);
    });
  });
});
