/**
 * Every database name a test file claims on the harness Mongo, with the file that claims it — the ONE sweep.
 *
 * Two gates ask "who claims which harness database": `a-db-harness-name-is-unique` (no two files claim one, because the
 * suite runs in parallel and `openTestMongo` drops its database on entry and exit) and
 * `a-db-shards-keep-a-harness-database-on-one-mongo` (the same, held across the shards the `-db` third is spread over).
 * Each holding its own copy of the reader would drift, and the copy that missed a spelling would report clean about the files
 * written in it.
 *
 * ## Read from the syntax tree, however the name reaches the harness (Q-792)
 *
 * The sweep was a regex over literal `openTestMongo('x')` calls and three hand-listed wrappers. About half the claims never
 * matched it — a name held in a `const`, and every door that takes `suite:` (`openPullDoor`, `openFileActDoors`, `openToolDoor`,
 * `openViewDoors`, `openMediaJobDoor`, `startMediaJobChild`, ...) — and a live clash (`gonedel`, an `openPullDoor` and an
 * `openPushDoor` in two files) hid there. So the claims are derived, never listed:
 *
 * - The one sink is the harness's URI builder: the first argument of `testMongoUri` in `_mongo-harness.mjs` names a database.
 * - A function whose parameter reaches a sink argument is a sink too, for that parameter (positional, or a property of an object
 *   parameter: `{ suite }`, `opts.suite`, `const { suite } = opts`, `{ ...opts }`), with the text around it
 *   (`ythril_harness_${suite}`) carried along. Followed across files through imports (static, dynamic, namespace, re-export) and
 *   object methods (`harness.open({ suite })`) to a fixed point, so `openTestMongo`, `openPushDoor` and every wrapper over them are
 *   found from the harness outward, and a new wrapper is in scope the day it is written.
 * - A child process that reads its name from the environment (`process.env.MESH_SUITE`, `JSON.parse(process.env.B89_CHILD).suite`)
 *   is a sink for that variable: the claim is the value a parent puts in an object property of that name (`MESH_SUITE: '...'`,
 *   `B89_CHILD: JSON.stringify({ suite })`), in the parent's file.
 * - Any `suite:` in an object passed to a function whose calls reach the harness is a claim as well, so a door that threads the
 *   name in a way the tracing cannot follow still has its callers checked. (The timing reporter's `suite: 'standalone'` is passed
 *   to a function that reaches no harness, and is no claim.)
 * - A claim's value is a string literal, a template, `+` or `?:` of resolvable parts, or a same-file `const` of one. A sink
 *   argument that resolves to none of these (a loop variable, a field of `this`, a callback's parameter) is an UNRESOLVED site: each
 *   is named in `_harness-names.allow.json` with a reason and a reviewBy date, so a new one fails the gate.
 *
 * The `ythril_harness_` prefix is stripped from every name, so `openTestMongo('x')` and `testMongoUri('ythril_harness_x')` are
 * the same claim. An explicit property wins over a spread in the same object (`{ suite, ...pull }`): a spread is read only for a
 * property the object does not name, because the options a caller spreads in are not where a door's name is written.
 */
import path from 'node:path';
import { readTrackedSources } from './_sources.mjs';
import { blankComments, stripComments } from './_strip-comments.mjs';
import { ts, parseSource, lineOf, unwrapExpression, walkEveryNode } from '../_shared/syntax-tree.mjs';

/** The harness module: it DEFINES the sink and claims no database of a test's own (its `'admin'` is the server's). */
export const HARNESS_MODULE = 'testing/standalone/_mongo-harness.mjs';
const SINK = 'testMongoUri';
const PREFIX = 'ythril_harness_';

/**
 * The sources every sweep reads: the tracked tests and helpers under `testing`, as written, with a floor. The sweep takes the
 * comments out itself (`blankComments` for the files it parses, so reported lines are the file's own; `stripComments` for the
 * spelled-out names), and only for the files it reads: blanking all of them at once held most of a gigabyte of heap.
 */
export function sweptSources() {
  return readTrackedSources('testing', { ext: ['.test.js', '.mjs'], floor: 100 })
    .map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), text }));
}

/** The tree's own sweep, read once per process: each gate asks it several questions. */
let treeSweep = null;
function sweepOf(sources) {
  if (sources !== undefined) return { sources, ...harnessSweep(sources) };
  if (!treeSweep) { const own = sweptSources(); treeSweep = { sources: own, ...harnessSweep(own) }; }
  return treeSweep;
}

const UNKNOWN = Object.freeze({ unknown: true });
const ABSENT = Object.freeze({ absent: true });

function resolveModule(from, spec) {
  if (!spec.startsWith('.')) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
}

const hasExportKeyword = (n) => !!n?.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
const isDynamicImport = (e) => ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword
  && e.arguments.length > 0 && ts.isStringLiteralLike(e.arguments[0]);
const bindingName = (el) => (el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteralLike(el.propertyName))
  ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : undefined);
const propName = (p) => (p?.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : undefined);
const isCallOf = (e, obj, name) => ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)
  && e.expression.name.text === name && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === obj;

/** `process.env.X` or `process.env['X']`: the variable's name, or `undefined`. */
function envNameOf(e) {
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return undefined;
  const obj = unwrapExpression(e.expression);
  if (!ts.isPropertyAccessExpression(obj) || obj.name.text !== 'env' || !ts.isIdentifier(obj.expression) || obj.expression.text !== 'process') return undefined;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : undefined;
}

/** One file's imports, exports, named functions and methods, `const`s, destructurings, calls and object properties. */
function modelOf({ file, code }) {
  const sf = parseSource(file, code);
  const m = { file, sf, imports: new Map(), reexports: new Map(), exportsMap: new Map(), functions: new Map(), methods: new Map(),
    consts: new Map(), destructs: new Map(), calls: [], props: [] };
  const add = (map, name, node) => map.set(name, [...(map.get(name) ?? []), node]);
  walkEveryNode(sf, (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause) {
      const mod = resolveModule(file, n.moduleSpecifier.text);
      if (!mod) return;
      const c = n.importClause;
      if (c.name) m.imports.set(c.name.text, { module: mod, name: 'default' });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) m.imports.set(nb.name.text, { module: mod, name: '*' });
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) m.imports.set(el.name.text, { module: mod, name: (el.propertyName ?? el.name).text });
    } else if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
      const from = n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) ? resolveModule(file, n.moduleSpecifier.text) : null;
      for (const el of n.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (from) m.reexports.set(el.name.text, { module: from, name: local });
        else m.exportsMap.set(el.name.text, local);
      }
    } else if (ts.isFunctionDeclaration(n) && n.name) {
      add(m.functions, n.name.text, n);
      if (hasExportKeyword(n)) m.exportsMap.set(n.name.text, n.name.text);
    } else if (ts.isMethodDeclaration(n) && ts.isObjectLiteralExpression(n.parent) && propName(n)) {
      add(m.methods, propName(n), n);
    } else if (ts.isPropertyAssignment(n) && propName(n)) {
      m.props.push(n);
      const init = unwrapExpression(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(m.methods, propName(n), init);
    } else if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = unwrapExpression(n.initializer);
      const list = n.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      if (isDynamicImport(init)) {
        const mod = resolveModule(file, init.arguments[0].text);
        if (mod && ts.isIdentifier(n.name)) m.imports.set(n.name.text, { module: mod, name: '*' });
        if (mod && ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) if (ts.isIdentifier(el.name)) m.imports.set(el.name.text, { module: mod, name: bindingName(el) });
        }
      } else if (ts.isIdentifier(n.name)) {
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(m.functions, n.name.text, init);
        if (isConst) add(m.consts, n.name.text, n.initializer);
        if (hasExportKeyword(list.parent)) m.exportsMap.set(n.name.text, n.name.text);
      } else if (ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          if (ts.isIdentifier(el.name) && !el.dotDotDotToken) add(m.destructs, el.name.text, { init: n.initializer, prop: bindingName(el) });
        }
      }
    }
    if (ts.isCallExpression(n)) m.calls.push(n);
  });
  return m;
}

const IMPORT_RE = () => /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * The claims and the unresolved sites over `sources` (`[{ file, text }]`, as written). Throws when the harness module
 * is not among them or defines no `testMongoUri`, so a moved harness cannot leave the sweep reporting clean about nothing.
 *
 * Only the files that can claim are parsed: those that reach the harness module through their imports, the files that set a
 * variable a reaching child reads (`B89_CHILD: ...`), and every file that imports one of those. A file outside that set has no
 * call that can reach the harness, and holding the syntax tree of every file under `testing` at once ran a 3 GB runner out of heap.
 *
 * @returns {{ claims: Array<{ file: string, name: string, line: number }>, unresolved: Array<{ file: string, line: number, expression: string }> }}
 */
export function harnessSweep(sources) {
  // Read from the text as written: a comment can only add a file to the set, never take one out of it.
  const importsOf = new Map(sources.map(s => [s.file,
    [...s.text.matchAll(IMPORT_RE())].map(x => resolveModule(s.file, x[1] ?? x[2])).filter(Boolean)]));
  const blanked = new Map();
  const codeOf = (s) => { if (!blanked.has(s.file)) blanked.set(s.file, blankComments(s.text)); return blanked.get(s.file); };
  const seeds = new Set([HARNESS_MODULE]);
  for (;;) {
    const part = new Set(seeds);
    for (let grew = true; grew;) {
      grew = false;
      for (const [f, deps] of importsOf) if (!part.has(f) && deps.some(d => part.has(d))) { part.add(f); grew = true; }
    }
    const result = analyse(sources.filter(s => part.has(s.file)).map(s => ({ file: s.file, code: codeOf(s) })));
    for (const name of result.envNames) {
      const set = new RegExp(`(?:^|[\\s{,'"])${name}['"]?\\s*:`);
      for (const s of sources) if (set.test(s.text)) seeds.add(s.file);
    }
    for (const f of part) seeds.add(f);
    if ([...seeds].every(f => part.has(f))) return { claims: result.claims, unresolved: result.unresolved };
  }
}

function analyse(sources) {
  const models = new Map(sources.map(s => [s.file, modelOf(s)]));
  const callable = new Set();
  for (const m of models.values()) for (const map of [m.functions, m.methods]) for (const list of map.values()) for (const fn of list) callable.add(fn);

  function exported(module, name, depth = 0) {
    const m = models.get(module);
    if (!m || depth > 8) return [];
    const re = m.reexports.get(name);
    if (re) return exported(re.module, re.name, depth + 1);
    const local = m.exportsMap.get(name);
    if (!local) return [];
    if (m.functions.has(local)) return m.functions.get(local);
    const imp = m.imports.get(local);
    return imp && imp.name !== '*' ? exported(imp.module, imp.name, depth + 1) : [];
  }

  // A call's callees do not change between rounds of the fixed point: each is worked out once.
  const calleeCache = new Map();
  const nearCache = new Map();
  function calleesOf(call, m) {
    if (!calleeCache.has(call)) calleeCache.set(call, calleesOnce(call, m));
    return calleeCache.get(call);
  }

  /** The functions a call may call: a local or imported function, a namespace member, or an object method of this file or a module it imports. */
  function calleesOnce(call, m) {
    const e = unwrapExpression(call.expression);
    if (ts.isIdentifier(e)) {
      if (m.functions.has(e.text)) return m.functions.get(e.text);
      const imp = m.imports.get(e.text);
      if (imp && imp.name !== '*') return exported(imp.module, imp.name);
    } else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && m.imports.get(e.expression.text)?.name === '*') {
      return exported(m.imports.get(e.expression.text).module, e.name.text);
    } else if (ts.isPropertyAccessExpression(e)) {
      const name = e.name.text;
      if (!nearCache.has(m)) nearCache.set(m, [m, ...new Set([...m.imports.values()].map(i => models.get(i.module)).filter(Boolean))]);
      return nearCache.get(m).flatMap(x => x.methods.get(name) ?? []);
    }
    return [];
  }

  /** The parameter slot an identifier names in the nearest function declaring it, or `null`. */
  function paramOf(id) {
    for (let n = id.parent; n; n = n.parent) {
      if (!ts.isFunctionLike(n) || !n.parameters) continue;
      for (const [index, p] of n.parameters.entries()) {
        if (ts.isIdentifier(p.name) && p.name.text === id.text) return { fn: n, index, prop: null };
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) if (ts.isIdentifier(el.name) && el.name.text === id.text) return { fn: n, index, prop: bindingName(el) };
        }
      }
    }
    return null;
  }

  /** Concatenation of resolved parts: every combination of their strings, or one traced parameter with fixed text around it. */
  function concat(parts) {
    if (parts.some(p => p.unknown || p.absent || p.env)) return UNKNOWN;
    const at = parts.findIndex(p => p.param);
    if (at === -1) return { strs: parts.reduce((acc, p) => acc.flatMap(a => p.strs.map(s => a + s)), ['']) };
    if (parts.some((p, i) => i !== at && (p.param || p.strs.length !== 1))) return UNKNOWN;
    const p = parts[at];
    return { param: p.param, pre: parts.slice(0, at).map(x => x.strs[0]).join('') + p.pre, post: p.post + parts.slice(at + 1).map(x => x.strs[0]).join('') };
  }

  const withProp = (r, prop) => (r.param && r.param.prop === null ? { ...r, param: { ...r.param, prop } }
    : r.env && r.env.json && r.env.prop === null ? { env: { ...r.env, prop } } : UNKNOWN);

  function resolve(expr, m, seen = new Set()) {
    const e = unwrapExpression(expr);
    if (!e) return ABSENT;
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return { strs: [e.text] };
    if (ts.isTemplateExpression(e)) {
      const parts = [{ strs: [e.head.text] }];
      for (const span of e.templateSpans) parts.push(resolve(span.expression, m, seen), { strs: [span.literal.text] });
      return concat(parts);
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return concat([resolve(e.left, m, seen), resolve(e.right, m, seen)]);
    }
    if (ts.isConditionalExpression(e)) {
      const [a, b] = [resolve(e.whenTrue, m, seen), resolve(e.whenFalse, m, seen)];
      return a.strs && b.strs ? { strs: [...new Set([...a.strs, ...b.strs])] } : UNKNOWN;
    }
    const env = envNameOf(e);
    if (env) return { env: { name: env, json: false, prop: null } };
    if (isCallOf(e, 'JSON', 'parse') && e.arguments[0]) {
      let arg = unwrapExpression(e.arguments[0]);
      if (ts.isBinaryExpression(arg) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(arg.operatorToken.kind)) arg = arg.left;
      const r = resolve(arg, m, seen);
      return r.env && !r.env.json ? { env: { ...r.env, json: true } } : UNKNOWN;
    }
    if (ts.isIdentifier(e)) {
      const p = paramOf(e);
      if (p) return { param: p, pre: '', post: '' };
      if (seen.has(e.text)) return UNKNOWN;
      const next = new Set([...seen, e.text]);
      const inits = m.consts.get(e.text) ?? [];
      if (inits.length === 1) return resolve(inits[0], m, next);
      if (inits.length > 1) {
        // The same name declared in several scopes of one file: a claim only when every declaration says the same.
        const vals = inits.map(i => resolve(i, m, next));
        return vals.every(v => v.strs && v.strs.join('\0') === vals[0].strs?.join('\0')) ? vals[0] : UNKNOWN;
      }
      const ds = m.destructs.get(e.text) ?? [];
      if (ds.length === 1) return withProp(resolve(ds[0].init, m, next), ds[0].prop);
      return UNKNOWN;
    }
    if (ts.isPropertyAccessExpression(e)) return withProp(resolve(e.expression, m, seen), e.name.text);
    return UNKNOWN;
  }

  /** The value an object expression holds under `prop`: an explicit property first, else a spread it carries. */
  function propValue(objExpr, prop, m) {
    const e = unwrapExpression(objExpr);
    if (!ts.isObjectLiteralExpression(e)) {
      const r = resolve(objExpr, m);
      return r.absent ? ABSENT : withProp(r, prop);
    }
    for (const p of [...e.properties].reverse()) {
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === prop) return resolve(p.name, m);
      if (ts.isPropertyAssignment(p) && propName(p) === prop) return resolve(p.initializer, m);
    }
    const spreads = e.properties.filter(p => ts.isSpreadAssignment(p));
    if (spreads.length === 1) return withProp(resolve(spreads[0].expression, m), prop);
    return spreads.length ? UNKNOWN : ABSENT;
  }

  /** The value a call hands a sink's slot: an argument, or a property of an object argument. */
  function valueAt(call, slot, m) {
    const args = call.arguments;
    if (args.slice(0, slot.index + 1).some(a => ts.isSpreadElement(a))) return UNKNOWN;
    const arg = args[slot.index];
    if (!arg) return ABSENT;
    return slot.prop === null ? resolve(arg, m) : propValue(arg, slot.prop, m);
  }

  /** The text a site hands a slot, for an unresolved site's report and its allowlist entry. */
  function slotText(node, prop, m) {
    const e = unwrapExpression(node);
    const at = prop !== null && ts.isObjectLiteralExpression(e)
      ? e.properties.find(p => propName(p) === prop) ?? e.properties.find(p => ts.isSpreadAssignment(p)) ?? node
      : node;
    return at.getText(m.sf).replace(/\s+/g, ' ');
  }

  // The sinks, from the harness outward: per function its slots, per environment variable what a child reads of it.
  const sinks = new Map();
  const envSinks = new Map();
  const keyOf = (d) => JSON.stringify([d.index, d.prop, d.json, d.pre, d.post]);
  const addTo = (map, at, d) => {
    const have = map.get(at) ?? new Map();
    if (have.has(keyOf(d))) return false;
    map.set(at, have.set(keyOf(d), d));
    return true;
  };
  for (const fn of models.get(HARNESS_MODULE)?.functions.get(SINK) ?? []) addTo(sinks, fn, { index: 0, prop: null, pre: '', post: '' });
  if (sinks.size === 0) throw new Error(`${HARNESS_MODULE} is not swept or defines no ${SINK} — the sweep has no sink to start from`);

  const reaching = new Set();
  /** The slots this call hands a name: the callee's traced sinks, plus each object argument's `suite:` when the callee reaches the harness. */
  function slotsAt(call, fn) {
    const list = [...(sinks.get(fn)?.values() ?? [])];
    if (reaching.has(fn)) {
      call.arguments.forEach((a, index) => {
        const e = unwrapExpression(a);
        if (!ts.isObjectLiteralExpression(e) || !e.properties.some(p => propName(p) === 'suite')) return;
        if (!list.some(d => d.index === index && d.prop === 'suite')) list.push({ index, prop: 'suite', pre: '', post: '' });
      });
    }
    return list;
  }

  /**
   * Every site that hands a name on: `visit(m, node, value, d, textOf)` for each sink slot of each call, and for each object property
   * a parent sets for a child that reads it from the environment.
   */
  function eachSite(visit) {
    for (const m of models.values()) {
      for (const call of m.calls) {
        for (const fn of calleesOf(call, m)) {
          if (!sinks.has(fn) && !reaching.has(fn)) continue;
          for (const d of slotsAt(call, fn)) {
            visit(m, call, valueAt(call, d, m), d, fn, () => (call.arguments[d.index] ? slotText(call.arguments[d.index], d.prop, m) : ''));
          }
        }
      }
      for (const p of m.props) {
        for (const d of envSinks.get(propName(p))?.values() ?? []) {
          let r;
          const v = unwrapExpression(p.initializer);
          if (!d.json) r = resolve(v, m);
          else if (isCallOf(v, 'JSON', 'stringify') && v.arguments[0]) r = propValue(v.arguments[0], d.prop, m);
          else r = UNKNOWN;
          visit(m, p, r, d, null, () => slotText(p.initializer, d.json ? d.prop : null, m));
        }
      }
    }
  }

  for (let changed = true; changed;) {
    changed = false;
    eachSite((m, node, r, d, fn) => {
      if (fn) {
        for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n) && !reaching.has(n)) { reaching.add(n); changed = true; }
      }
      if (r.param && addTo(sinks, r.param.fn, { index: r.param.index, prop: r.param.prop, pre: d.pre + r.pre, post: r.post + d.post })) changed = true;
      if (r.env && addTo(envSinks, r.env.name, { prop: r.env.prop, json: r.env.json, pre: d.pre, post: d.post, readAt: { m, node } })) changed = true;
    });
  }

  const claims = [];
  const unresolved = [];
  const seen = new Set();
  const unresolvedAt = (m, node, expression) => {
    const line = lineOf(m.sf, node);
    const key = `u\0${m.file}\0${expression}\0${line}`;
    if (!seen.has(key)) { seen.add(key); unresolved.push({ file: m.file, line, expression }); }
  };
  const provided = new Set();
  eachSite((m, node, r, d, fn, textOf) => {
    if (!fn) provided.add(propName(node));
    if (m.file === HARNESS_MODULE) return;
    if (r.strs) {
      const line = lineOf(m.sf, node);
      for (const s of r.strs) {
        const full = d.pre + s + d.post;
        const name = full.startsWith(PREFIX) ? full.slice(PREFIX.length) : full;
        const key = `c\0${m.file}\0${name}\0${line}`;
        if (!seen.has(key)) { seen.add(key); claims.push({ file: m.file, name, line }); }
      }
    } else if (r.unknown || (r.param && !callable.has(r.param.fn)) || (r.env && ((r.env.json && r.env.prop === null) || (!r.env.json && r.env.prop !== null)))) {
      // A parameter of a function nothing calls by name (a callback) is as unresolved as an unknown value, and so is an
      // environment variable read whole as JSON or read as a property without JSON.
      unresolvedAt(m, node, textOf());
    }
  });
  // A variable a child reads that no parent sets in an object property: the name it claims is nowhere the sweep can see.
  for (const [name, ds] of envSinks) {
    if (provided.has(name)) continue;
    for (const d of ds.values()) unresolvedAt(d.readAt.m, d.readAt.node, `process.env.${name}`);
  }
  return { claims, unresolved, envNames: [...envSinks.keys()] };
}

/**
 * Every suite name handed to the harness, however it gets there, with the file and line that claim it.
 *
 * @param {Array<{ file: string, text: string }>} [sources] the sources to read, as written (a planted control passes its own); the tree's by default
 * @returns {Array<{ file: string, name: string, line: number }>}
 */
export function harnessNames(sources) {
  return sweepOf(sources).claims;
}

/**
 * Every harness site whose name the sweep cannot resolve (a loop variable, a field of `this`, a callback's parameter, a database
 * name read from a running container). Each must be named in `_harness-names.allow.json`.
 *
 * @returns {Array<{ file: string, line: number, expression: string }>}
 */
export function unresolvedHarnessSites(sources) {
  return sweepOf(sources).unresolved;
}

/**
 * Every `ythril_harness_<name>` database a file spells out in full, beside the names it hands the harness: the spelling a
 * file uses to reach its own database through the driver (`driverWriteFailures('ythril_harness_x')`), which no harness
 * function takes. A template (`ythril_harness_${SUITE}`) handed to the harness is resolved by `harnessNames`.
 *
 * @returns {Array<{ file: string, name: string }>}
 */
export function harnessDatabaseClaims(sources) {
  const sweep = sweepOf(sources);
  const found = sweep.claims.map(({ file, name }) => ({ file, name }));
  for (const { file, text } of sweep.sources) {
    if (file === HARNESS_MODULE) continue;
    for (const m of stripComments(text).matchAll(/ythril_harness_([A-Za-z0-9_]+)/g)) found.push({ file, name: m[1] });
  }
  return found;
}
