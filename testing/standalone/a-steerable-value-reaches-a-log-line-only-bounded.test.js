/**
 * A value a caller or a peer can steer reaches a log line only bounded — escaped and cut — through `peerText` or
 * `peerList` (`util/log.ts`), or it is a LOCAL value named here with the reason it is local (`Q-231`, `Q-214`,
 * `Q-270`).
 *
 * ## The rule
 *
 * A log line is the one channel an operator trusts to say what this server did. Two things break that, and both
 * arrive through a value the server did not choose:
 *
 *  - **Forging.** A peer label, a document id or an error text carrying `\r\n` ends the line and prints a second one
 *    that reads exactly like this server's own (`Q-231`, `Q-214`: a member label arrives by gossip).
 *  - **Flooding.** A megabyte `seq` or `_id` makes a megabyte line (`Q-270`) — in the ring the log viewer reads, in
 *    the container log, and in every aggregator downstream.
 *
 * `peerText` escapes, redacts and cuts at a code-point boundary saying how much it cut; `peerList` bounds a joined
 * list by count and length. `logSafe` stays as their older name for `peerText`.
 *
 * ## What is derived, and from where
 *
 *  - **The doors**: EVERY mounted route (`_routes.mjs`, which resolves routers mounted without a prefix — not a list of
 *    areas, which is how the files, the audit and the admin routes went unread); `POST /mcp` together with every tool it
 *    dispatches (each tool object with a `name` literal and a `handle`, which is how `toolHandlerRoot` knows a tool) and
 *    the shared dispatch `callTool`; every function of the sync engine and of file sync, which run on the scheduler
 *    rather than behind a route; and the boot path: `startConfiguredInstanceServices` and every function of the process
 *    entry (the file `npm start` runs), which start the workers and the sweeps with nobody behind them.
 *  - **What runs**: the call graph (`_call-graph.mjs`) from those roots, `closures: true` — a line written inside a
 *    `.map(async …)` or a `.catch(err => …)` is caused by the door as surely as one in its body.
 *  - **The sinks**: every call of a method of the `log` object `util/log.ts` exports (however it was imported or
 *    renamed) ANYWHERE in the program; every call of a property a log method was HANDED ON as (`{ warn: log.warn }` makes
 *    the callee's `opts.warn(…)` a sink — `resolveWatermark` is one); and every function whose RESULT is a sink's message
 *    (`truncationWarn`), whose returned text is read as if it were the sink's. `reportServerFailure` is a function with a
 *    `log.error` in it, so it is read like any other. The doors say which half a sink is in (reached, or outside what
 *    the call graph can follow), and the report says it; both halves are judged. The call graph is regex-built and
 *    cannot follow a method on an instance, a function passed as a value or a destructured dynamic import, and the
 *    lines it cannot follow are written by the same server about the same values — a boot migration's network id, a
 *    push door's space id, an external endpoint's error text were the first it missed.
 *  - **The slots**: every `${…}` of a message, every operand of a `+` that builds one, both arms of a `?:` / `??` /
 *    `||`, and every `.join(…)` — a joined list must go through `peerList`.
 *
 * The meta argument (`log.warn(msg, meta)`) is not judged per call: every line is built by `fmt`, so `fmt` is
 * where it is bounded, and that is asserted on `fmt` itself.
 *
 * ## What a slot may be
 *
 *  - `peerText(…)`, `peerList(…)` or `logSafe(…)`.
 *  - A value whose TYPE cannot carry text: a number, a boolean, a literal or a union of literals (`'push' |
 *    'receive'`). The type comes from the compiler, not from a guess at the spelling — so `${count}` passes because
 *    it is a `number`, and `${String(count)}` is judged as the string it is.
 *  - A value the `LOCAL` table names by its DEFINING SITE — the declaration of the parameter, variable or property
 *    it reads — with the reason that value is this instance's own. Keyed by declaration rather than by the line
 *    that logs it, so one reason covers every line that reads the value and a new reader of it needs no new row;
 *    and an entry whose declaration no longer reaches a sink fails, so the table cannot outlive what it excuses.
 *
 * ## Scope, stated rather than implied
 *
 * What the call graph cannot resolve is not WALKED (see `_call-graph.mjs`), but no log call depends on it any more: the
 * sinks are found in every file of the program. What is not judged at all: a `console.*` write, and a message that is
 * not built in the call (`log.warn(someFunctionReturningText())` is read when the function is in this tree and returns
 * a string; a value handed in from outside is judged as a slot). The module scope of every reached file IS read as
 * reached, because a closure built there runs when that file's functions call what it was handed to.
 *
 * The floors are relations between two independent readings, not numbers: the route table against the AST's own count of
 * registrations, the MCP door against the tools `TOOL_RIGHTS` prices, the boot walk against the modules the boot path
 * imports at run time, and the sinks against a comment-free text count of `log.<method>(`.
 *
 * The AST carries no comments, so the docblock explaining a fix can neither satisfy this gate nor fail it.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3, the base of the 5.6.4 patch): `peerText` and `peerList` do not exist, `fmt` appends the meta
 * argument unbounded, and the slot rule reports every raw slot and the defining sites it reads (the counts are in the
 * failure message, and nowhere else). The gate is main's, carried over the release line's doors: nothing in it was re-derived by hand, so the
 * doors, the sinks and the slots are the ones the base tree has. The sweep that makes it green is the patch's own — every
 * raw interpolation it names goes through `peerText` / `peerList` where the value enters the text — and the LOCAL table
 * stays EMPTY unless a site is shown to be this instance's own, with the reason (a reviewer reads each entry).
 *
 * Mutation-checked for the form it newly covers on this line: changing one `${logSafe(where)}` in
 * `sync/tombstone-apply.ts` to `${where}` raised the report by one slot and named the line; the original
 * spelling was put back by hand.
 *
 * Mutation-checked again for the widened doors, by reverting one of 5.6.4 part 1's newly wrapped slots at a time: one
 * in `api/files.ts` (a file route, in no area the earlier gate walked) and one in boot code (`bootstrap.ts`). Each named
 * the line and nothing else; the original spelling was put back by hand each time.
 *
 * Run: node --test testing/standalone/a-steerable-value-reaches-a-log-line-only-bounded.test.js
 * (requires a prior `npm run build` in server/ — the import door is found through the compiled route tables)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { moduleIndex, routeHandlerRoots, walkFrom } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const LOG_MODULE = 'server/src/util/log.ts';
/** The functions that bound a value for a log line. `logSafe` is the older name, kept as an alias of `peerText`. */
const BOUNDING = ['peerText', 'peerList', 'logSafe'];
const ENGINE = 'server/src/sync/engine.ts';
const FILE_SYNC = 'server/src/sync/file-sync.ts';
const CALL_TOOL = 'server/src/mcp/call-tool.ts:callTool';
/** The function that starts every service of a configured instance: the boot root, and the name its callers are found by. */
const BOOT_SERVICES = 'startConfiguredInstanceServices';
const RIGHTS_MODULE = 'server/src/auth/space-rights.ts';
/** The one route file served by a second process with its own port: `mountedRoutes` leaves it out, and so does the count it is held to. */
const CONNECTOR = 'server/src/local-agent-connector/index.ts';

/**
 * Values that are this instance's own, keyed by the declaration they are read from, grouped under the reason.
 *
 * Site shapes (what `definingSite` prints, and what the failure message lists): `file:Type.prop` for a property of
 * a named type, `file:fn(param)` for a parameter, `file:fn>name` for a local, `file:name` for a module-level binding,
 * `String(site)` / `JSON.stringify(site)` for a library rendering of one. A site that no slot reads any more fails
 * the last case below. A reason must say why a caller or a peer cannot choose the value — "it is an id" is not one.
 *
 * @type {{ why: string, sites: string[] }[]}
 */
const LOCAL = [
];
const LOCAL_SITES = new Map(LOCAL.flatMap(g => g.sites.map(s => [s, g.why])));

// ---------------------------------------------------------------------------------------------------------------
// The program, the call graph and the doors.

const posix = p => p.split(sep).join('/');
const repoPath = abs => posix(relative(REPO_ROOT, abs));

const PROGRAM = (() => {
  const cfgPath = join(REPO_ROOT, 'server', 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, join(REPO_ROOT, 'server'));
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
})();
const CHECKER = PROGRAM.getTypeChecker();
const SOURCE = new Map(PROGRAM.getSourceFiles().map(sf => [repoPath(sf.fileName), sf]));
const inTree = file => file.startsWith('server/src/');

const INDEX = moduleIndex('server/src');
const ROUTES = mountedRoutes();
const ROUTE_ROOTS = new Map(ROUTES.map(r => [`${r.method} ${r.path}`, routeHandlerRoots(INDEX, r)]));
const ROUTE_BY_KEY = new Map(ROUTES.map(r => [`${r.file}:${r.method} ${r.path}`, r]));

/** Every tool `POST /mcp` dispatches: a top-level object with a `name` literal and a `handle` method. */
const TOOL_ROOTS = [...INDEX.objects.values()]
  .filter(o => o.strings.get('name') && INDEX.bodies.has(`${o.file}:${o.name}.handle`))
  .map(o => `${o.file}:${o.name}.handle`);

/** A REST door that IS a tool (`callTool({ name: 'recall' })`) reaches that tool's handler. */
const DISPATCH_BY_NAME = /\bcallTool\s*\(\s*\{\s*name:\s*['"]([a-z_]+)['"]/g;
const TOOL_BY_NAME = new Map([...INDEX.objects.values()]
  .filter(o => o.strings.get('name') && INDEX.bodies.has(`${o.file}:${o.name}.handle`))
  .map(o => [o.strings.get('name'), `${o.file}:${o.name}.handle`]));
const dispatchedTools = entry => [...entry.body.matchAll(DISPATCH_BY_NAME)].map(m => TOOL_BY_NAME.get(m[1])).filter(Boolean);

const walk = roots => walkFrom(INDEX, roots, { closures: true, edges: dispatchedTools }).seen;
const routeDoor = r => ({ name: `${r.method} ${r.path}`, roots: ROUTE_ROOTS.get(`${r.method} ${r.path}`) });

const bodiesOf = file => [...INDEX.bodies.keys()].filter(k => k.startsWith(`${file}:`));

/** The process entry: the file `npm start` runs (`node dist/<entry>.js`), read from the server's own package.json. */
const ENTRY = (() => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'server', 'package.json'), 'utf8'));
  const m = /\bnode\s+dist\/(\S+?)\.js\b/.exec(pkg.scripts?.start ?? '');
  assert.ok(m, 'server/package.json `scripts.start` no longer runs `node dist/<entry>.js` — re-anchor the boot root');
  return `server/src/${m[1]}.ts`;
})();
/** Where the instance's services are started: the key of `startConfiguredInstanceServices` wherever it is defined. */
const BOOT_SERVICES_KEY = [...INDEX.bodies.keys()].find(k => k.endsWith(`:${BOOT_SERVICES}`));

/**
 * Every door, by what it is. A route is a door because the server MOUNTS it (`mountedRoutes`, all of them: a hand-picked
 * list of areas is how the files, the audit and the admin routes went unread), `POST /mcp` carries every tool, the
 * scheduler runs the sync engine and file sync with no request behind them, and the boot path runs
 * `startConfiguredInstanceServices` and the process entry with nobody behind them at all.
 */
const DOORS = (() => {
  const doors = {};
  doors.routes = ROUTES.map(routeDoor);
  const mcp = ROUTES.filter(r => r.method === 'POST' && r.path === '/mcp');
  doors.mcp = mcp.map(r => ({ ...routeDoor(r), roots: [...routeDoor(r).roots, CALL_TOOL, ...TOOL_ROOTS] }));
  doors.boot = [{ name: 'boot', roots: [...(BOOT_SERVICES_KEY ? [BOOT_SERVICES_KEY] : []), ...bodiesOf(ENTRY)] }];
  doors.engine = [{ name: 'the sync engine', roots: bodiesOf(ENGINE) }];
  doors.fileSync = [{ name: 'file sync', roots: bodiesOf(FILE_SYNC) }];
  return doors;
})();

const REACHED = (() => {
  const seen = new Set();
  for (const list of Object.values(DOORS)) for (const d of list) for (const k of walk(d.roots)) seen.add(k);
  return seen;
})();

// ---------------------------------------------------------------------------------------------------------------
// From a call-graph key to the AST node that is its body.

const unwrap = e => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)
    || ts.isTypeAssertionExpression?.(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
  return e;
};
const isFn = n => n && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
  || ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isConstructorDeclaration(n));

function topLevelNamed(sf, name) {
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d;
      }
    }
  }
  return null;
}

/** The AST node(s) a reached key names, or [] when the gate cannot read it (reported, never skipped silently). */
function nodesOf(key) {
  const entry = INDEX.bodies.get(key);
  const target = entry?.alias ?? key;
  const at = target.indexOf('.ts:') + 3;
  const file = target.slice(0, at);
  const name = target.slice(at + 1);
  const sf = SOURCE.get(file);
  if (!sf) return [];
  const route = ROUTE_BY_KEY.get(target);
  if (route) {
    const out = [];
    const visit = n => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.name.text === route.method.toLowerCase()
        && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text === route.routePath) out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }
  const dot = name.indexOf('.');
  if (dot === -1) {
    const n = topLevelNamed(sf, name);
    return n ? [n] : [];
  }
  const decl = topLevelNamed(sf, name.slice(0, dot));
  const obj = decl && ts.isVariableDeclaration(decl) ? unwrap(decl.initializer) : null;
  if (!obj || !ts.isObjectLiteralExpression(obj)) return [];
  const prop = obj.properties.find(p => p.name && ts.isIdentifier(p.name) && p.name.text === name.slice(dot + 1));
  return prop ? [prop] : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Symbols: what a name refers to, through imports.

const symbolOf = node => {
  let s = CHECKER.getSymbolAtLocation(node);
  if (s && (s.flags & ts.SymbolFlags.Alias)) s = CHECKER.getAliasedSymbol(s);
  return s;
};
const declOf = node => symbolOf(node)?.declarations?.[0];
const fileOf = node => repoPath(node.getSourceFile().fileName);

const LOG_DECL = (() => {
  const sf = SOURCE.get(LOG_MODULE);
  assert.ok(sf, `${LOG_MODULE} is not in the program — re-anchor LOG_MODULE`);
  const d = topLevelNamed(sf, 'log');
  assert.ok(d && ts.isVariableDeclaration(d) && ts.isObjectLiteralExpression(unwrap(d.initializer)),
    `${LOG_MODULE} no longer exports a \`log\` object literal — re-anchor how the sinks are found`);
  return d;
})();
const LOG_METHODS = new Set(unwrap(LOG_DECL.initializer).properties.map(p => p.name?.text).filter(Boolean));

/** `log.warn` (any import name for `log`), as a callee or as a value. */
const isLogMethod = e => {
  e = unwrap(e);
  return !!e && ts.isPropertyAccessExpression(e) && LOG_METHODS.has(e.name.text) && declOf(e.expression) === LOG_DECL;
};

const isBoundingCall = e => {
  e = unwrap(e);
  if (!e || !ts.isCallExpression(e)) return false;
  const d = declOf(ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression);
  return !!d && fileOf(d) === LOG_MODULE && BOUNDING.includes(d.name?.text);
};

// ---------------------------------------------------------------------------------------------------------------
// Where a value is defined — the key `LOCAL` is written in.

function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if ((ts.isMethodDeclaration(n) || ts.isPropertyAssignment(n)) && n.name && ts.isIdentifier(n.name)) {
      const owner = n.parent?.parent;
      const ownerName = owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name) ? `${owner.name.text}.` : '';
      return `${ownerName}${n.name.text}`;
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isFn(unwrap(n.initializer))) return n.name.text;
    if (ts.isClassDeclaration(n) && n.name) return n.name.text;
  }
  return null;
}

function typeOwnerName(member) {
  const p = member.parent;
  if ((ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.text;
  if (ts.isTypeLiteralNode(p)) {
    for (let n = p.parent; n; n = n.parent) {
      if (ts.isTypeAliasDeclaration(n)) return n.name.text;
      if (ts.isParameter(n) && ts.isIdentifier(n.name)) return `${enclosingName(n) ?? '?'}(${n.name.text})`;
      if (ts.isPropertySignature(n) && ts.isIdentifier(n.name)) return `${typeOwnerName(n)}.${n.name.text}`;
    }
  }
  return enclosingName(member) ?? '?';
}

/** The declaration key of `d`, or null when it is not a declaration in this tree. */
function declKey(d) {
  if (!d) return null;
  const file = fileOf(d);
  if (!inTree(file)) return null;
  const name = d.name && (ts.isIdentifier(d.name) || ts.isStringLiteralLike(d.name)) ? d.name.text : null;
  if (!name) return null;
  if (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) return `${file}:${typeOwnerName(d)}.${name}`;
  if (ts.isParameter(d)) return `${file}:${enclosingName(d) ?? '?'}(${name})`;
  if (ts.isBindingElement(d)) {
    let root = d;
    while (root && !ts.isParameter(root) && !ts.isVariableDeclaration(root)) root = root.parent;
    const fn = enclosingName(d);
    if (root && ts.isParameter(root)) return `${file}:${fn ?? '?'}({${name}})`;
    return fn ? `${file}:${fn}>${name}` : `${file}:${name}`;
  }
  if (ts.isVariableDeclaration(d) || ts.isFunctionDeclaration(d)) {
    const fn = enclosingName(d);
    return fn && fn !== name ? `${file}:${fn}>${name}` : `${file}:${name}`;
  }
  if (ts.isPropertyAssignment(d) || ts.isShorthandPropertyAssignment(d)) return `${file}:${enclosingName(d) ?? '?'}{${name}}`;
  return `${file}:${enclosingName(d) ?? '?'}>${name}`;
}

/** The defining site of an expression's value, as `LOCAL` keys it. */
function definingSite(e) {
  e = unwrap(e);
  if (ts.isIdentifier(e)) return declKey(declOf(e)) ?? `?${e.text}`;
  if (ts.isPropertyAccessExpression(e)) return declKey(declOf(e.name)) ?? `${definingSite(e.expression)}.${e.name.text}`;
  if (ts.isElementAccessExpression(e)) return `${definingSite(e.expression)}[]`;
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    const arg = e.arguments[0] ? definingSite(e.arguments[0]) : '';
    // A library function of a value (`String(err)`, `JSON.stringify(stats)`) is keyed by the value it renders.
    const d = declOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    if (d && !inTree(fileOf(d)) && (ts.isIdentifier(callee) || ts.isIdentifier(unwrap(callee.expression)) && !declKey(declOf(callee.expression)))) {
      return `${callee.getText()}(${arg})`;
    }
    if (ts.isPropertyAccessExpression(callee)) return `${definingSite(callee.expression)}.${callee.name.text}()`;
    if (ts.isIdentifier(callee)) return `${callee.text}(${arg})`;
  }
  return `?${e.getText().replace(/\s+/g, ' ').slice(0, 60)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Slots: what a message is made of, and whether each is bounded.

const TEXT_FREE = ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null
  | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never | ts.TypeFlags.StringLiteral | ts.TypeFlags.EnumLike;

/** A type no value of which can carry text: numbers, booleans, literals and unions of them. */
function cannotCarryText(type) {
  if (type.isUnion()) return type.types.every(cannotCarryText);
  return (type.flags & TEXT_FREE) !== 0;
}

/**
 * The function an in-tree call resolves to, when its result is a string — a message BUILDER whose returned text
 * is read as the message (`truncationWarn`). Null for anything else.
 */
function builderOf(call) {
  const callee = unwrap(call.expression);
  const d = declOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
  if (!d || !inTree(fileOf(d))) return null;
  const fn = ts.isVariableDeclaration(d) ? unwrap(d.initializer) : d;
  if (!isFn(fn) || !fn.body) return null;
  const ret = CHECKER.getTypeAtLocation(call);
  if (!(ret.flags & ts.TypeFlags.StringLike)) return null;
  return fn;
}

const returnsOf = fn => {
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  const visit = n => {
    if (n !== fn.body && isFn(n)) return;
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
};

/**
 * Every unbounded slot in a message expression, as `{ node, site, kind }`. `seen` keeps a builder read once and
 * cuts a cycle.
 */
function slotsOf(expr, seen, out) {
  const e = unwrap(expr);
  if (!e) return out;
  if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return out;
  if (ts.isTemplateExpression(e)) {
    for (const span of e.templateSpans) valueSlot(span.expression, seen, out);
    return out;
  }
  if (ts.isBinaryExpression(e) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]
    .includes(e.operatorToken.kind)) {
    slotsOf(e.left, seen, out);
    slotsOf(e.right, seen, out);
    return out;
  }
  if (ts.isConditionalExpression(e)) {
    slotsOf(e.whenTrue, seen, out);
    slotsOf(e.whenFalse, seen, out);
    return out;
  }
  return valueSlot(e, seen, out);
}

function valueSlot(expr, seen, out) {
  const e = unwrap(expr);
  if (isBoundingCall(e)) return out;
  if (ts.isTemplateExpression(e) || ts.isConditionalExpression(e)
    || (ts.isBinaryExpression(e) && e.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken
      && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(e.operatorToken.kind))) {
    return slotsOf(e, seen, out);
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(unwrap(e.expression)) && unwrap(e.expression).name.text === 'join') {
    const list = unwrap(e.expression).expression;
    out.push({ node: e, site: definingSite(list), kind: 'joined list' });
    return out;
  }
  if (cannotCarryText(CHECKER.getTypeAtLocation(e))) return out;
  // A `const` that holds a message built earlier (`const msg = \`…\`; log.warn(msg)`) is read as that message.
  if (ts.isIdentifier(e)) {
    const d = declOf(e);
    const init = d && ts.isVariableDeclaration(d) ? unwrap(d.initializer) : null;
    const composed = init && (ts.isTemplateExpression(init) || ts.isConditionalExpression(init) || ts.isStringLiteralLike(init)
      || ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || isBoundingCall(init)
      || (ts.isBinaryExpression(init) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]
        .includes(init.operatorToken.kind)));
    if (composed && (ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) {
      if (!seen.has(d)) {
        seen.add(d);
        slotsOf(d.initializer, seen, out);
      }
      return out;
    }
  }
  if (ts.isCallExpression(e)) {
    const fn = builderOf(e);
    if (fn) {
      if (!seen.has(fn)) {
        seen.add(fn);
        for (const r of returnsOf(fn)) slotsOf(r, seen, out);
      }
      return out;
    }
  }
  out.push({ node: e, site: definingSite(e), kind: 'value' });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The sinks in what runs.

/** The function a call resolves to, when it is declared in this tree. */
function calleeFn(call) {
  const callee = unwrap(call.expression);
  const d = declOf(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
  if (!d || !inTree(fileOf(d))) return null;
  const fn = ts.isVariableDeclaration(d) ? unwrap(d.initializer) : d;
  return isFn(fn) ? fn : null;
}

const SINKS = (() => {
  const calls = new Map();
  const handedOn = [];
  const rawHandOff = [];
  const unread = [];
  const readNodes = [];
  const files = new Set();
  for (const key of REACHED) {
    const nodes = nodesOf(key);
    if (nodes.length === 0) { unread.push(key); continue; }
    readNodes.push(...nodes);
    files.add(fileOf(nodes[0]));
  }
  /*
   * The MODULE SCOPE of every file a door reaches, too: a closure built at module level — `singleFlight({ onQueued:
   * (id) => log.debug(…) })` in the engine — runs because a function of that file calls the thing it was handed to,
   * and the call graph has no key for it. A top-level function or object of functions is NOT included here: it has
   * its own key and is read when, and only when, a door reaches it.
   */
  for (const file of files) {
    for (const st of SOURCE.get(file).statements) {
      if (ts.isFunctionDeclaration(st) || ts.isImportDeclaration(st) || ts.isInterfaceDeclaration(st)
        || ts.isTypeAliasDeclaration(st) || ts.isExportDeclaration(st) || ts.isClassDeclaration(st)) continue;
      if (ts.isVariableStatement(st) && st.declarationList.declarations.every(d => {
        const init = unwrap(d.initializer);
        return !init || isFn(init) || ts.isObjectLiteralExpression(init);
      })) continue;
      readNodes.push(st);
    }
  }
  /*
   * What the walk read is `readNodes`; the sinks are then found in EVERY file of the program, not only there. The call
   * graph is regex-built and cannot follow a method on an instance, a function passed as a value or a destructured dynamic
   * import — and the log lines in what it could not follow are written by the same server, about the same steerable values
   * (a network id in a boot migration, a push door's space id, an external endpoint's error text). A sink the walk did not
   * reach is judged all the same and tagged, so a report says which half it came from.
   */
  const reachedByFile = new Map();
  for (const n of readNodes) {
    const f = fileOf(n);
    if (!reachedByFile.has(f)) reachedByFile.set(f, []);
    reachedByFile.get(f).push(n);
  }
  const addCall = (call, how) => {
    const id = `${fileOf(call)}@${call.pos}`;
    if (!calls.has(id)) calls.set(id, { call, how, reached: (reachedByFile.get(fileOf(call)) ?? []).some(n => n.pos <= call.pos && call.end <= n.end) });
  };
  const visit = n => {
    if (ts.isCallExpression(n) && isLogMethod(n.expression)) addCall(n, 'log');
    if (ts.isPropertyAssignment(n) && isLogMethod(n.initializer)) handedOn.push(n);
    else if (ts.isCallExpression(n) && n.arguments.some(a => isLogMethod(a))) rawHandOff.push(n);
    ts.forEachChild(n, visit);
  };
  for (const [file, sf] of SOURCE) if (inTree(file) && !file.endsWith('.d.ts')) visit(sf);

  // `{ warn: log.warn }` handed to a function makes that function's `opts.warn(…)` / `warn(…)` a sink.
  for (const prop of handedOn) {
    let call = prop.parent;
    while (call && !ts.isCallExpression(call)) call = call.parent;
    const fn = call ? calleeFn(call) : null;
    if (!fn) { rawHandOff.push(prop); continue; }
    const name = prop.name.text;
    const inner = n => {
      if (ts.isCallExpression(n)) {
        const c = unwrap(n.expression);
        if ((ts.isIdentifier(c) && c.text === name) || (ts.isPropertyAccessExpression(c) && c.name.text === name)) addCall(n, `handed on as ${name}`);
      }
      ts.forEachChild(n, inner);
    };
    inner(fn);
  }
  return { calls: [...calls.values()], unread, rawHandOff, readNodes };
})();

/** Every `log.<method>(` a comment-free reading of the same files spells — a count the AST match is held to, found without the checker. */
const TEXTUAL_LOG_CALLS = [...SOURCE.keys()]
  .filter(f => inTree(f) && !f.endsWith('.d.ts'))
  .reduce((n, f) => n + (stripComments(readFileSync(join(REPO_ROOT, f), 'utf8')).match(new RegExp(`\\blog\\.(?:${[...LOG_METHODS].join('|')})\\s*\\(`, 'g')) ?? []).length, 0);

/** The route registrations the program spells — `router.get('/x', …)`, `app.post('/y', …)` — found by the AST, not by `mountedRoutes`' pattern. */
const REGISTERED_ROUTES = (() => {
  const keys = [];
  for (const [file, sf] of SOURCE) {
    if (!inTree(file) || file === CONNECTOR) continue;
    const visit = n => {
      const c = ts.isCallExpression(n) ? n.expression : null;
      if (c && ts.isPropertyAccessExpression(c) && ['get', 'post', 'put', 'patch', 'delete'].includes(c.name.text)
        && ts.isIdentifier(c.expression) && /(?:\w*[Rr]outer|^app)$/.test(c.expression.text)
        && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) keys.push(`${file}:${c.name.text} ${n.arguments[0].text}`);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return keys;
})();

/** The tools `TOOL_RIGHTS` prices — every one is a tool the MCP door dispatches. Read from the table's own AST. */
const PRICED_TOOLS = (() => {
  const sf = SOURCE.get(RIGHTS_MODULE);
  const table = sf && topLevelNamed(sf, 'TOOL_RIGHTS');
  const list = table && ts.isVariableDeclaration(table) ? unwrap(table.initializer) : null;
  if (!list || !ts.isArrayLiteralExpression(list)) return [];
  return list.elements.map(el => unwrap(el))
    .filter(el => ts.isObjectLiteralExpression(el))
    .map(el => el.properties.find(p => p.name && p.name.getText() === 'tool')?.initializer)
    .filter(init => init && ts.isStringLiteralLike(init)).map(init => init.text);
})();

const where = node => {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${repoPath(sf.fileName)}:${line + 1}`;
};

const VIOLATIONS = (() => {
  const out = [];
  const seenBuilders = new Set();
  for (const { call, how, reached } of SINKS.calls) {
    const msg = call.arguments[0];
    if (!msg) continue;
    const slots = slotsOf(msg, seenBuilders, []);
    for (const s of slots) out.push({ ...s, at: where(s.node), text: s.node.getText().replace(/\s+/g, ' ').slice(0, 90), how, reached });
  }
  // One finding per slot node, whichever sink reached it first.
  const byNode = new Map();
  for (const v of out) if (!byNode.has(v.node)) byNode.set(v.node, v);
  return [...byNode.values()];
})();

// ---------------------------------------------------------------------------------------------------------------

/*
 * Every floor below is DERIVED: it compares one reading of the tree with a second, independent one (the route table
 * against the AST's own count of registrations, the doors against the tool table, the sinks against a comment-free
 * text count) or with a structural minimum. A number written here would be the one place the tree could outgrow
 * unnoticed; a relation between two readings fails the moment either stops matching.
 */
describe('the derivation works', () => {
  it('every route the program registers is a door, and every door has a handler to walk from', () => {
    assert.ok(REGISTERED_ROUTES.length > 0, 'the AST finds no route registration — the independent reading is broken');
    const mounted = new Set(ROUTES.map(r => `${r.file}:${r.method.toLowerCase()} ${r.routePath}`));
    assert.deepEqual(REGISTERED_ROUTES.filter(k => !mounted.has(k)), [],
      'registered in the program but absent from the mounted routes — mount it, or drop the dead route: a door the scan cannot see is a door unread');
    assert.deepEqual(DOORS.routes.filter(d => !d.roots || d.roots.length === 0).map(d => d.name), [],
      'mounted routes whose handler the call graph could not root — their log lines would go unjudged by the walk');
    assert.equal(DOORS.routes.length, ROUTES.length, 'a mounted route is not a door');
  });

  it('the MCP door dispatches every tool the rights table prices', () => {
    assert.ok(PRICED_TOOLS.length > 0, `${RIGHTS_MODULE} \`TOOL_RIGHTS\` yields no tool names — re-anchor how it is read`);
    assert.deepEqual(PRICED_TOOLS.filter(t => !TOOL_BY_NAME.has(t)), [], 'priced tools with no handler the MCP door can root');
    assert.ok(TOOL_ROOTS.length >= PRICED_TOOLS.length, `${TOOL_ROOTS.length} tool handler(s) rooted for ${PRICED_TOOLS.length} priced tool(s)`);
    assert.ok(DOORS.mcp.length > 0, 'no `POST /mcp` among the mounted routes');
  });

  it('the boot door starts at the process entry and at the function that starts the services, and walks beyond them', () => {
    assert.ok(BOOT_SERVICES_KEY, `no function \`${BOOT_SERVICES}\` is indexed — re-anchor BOOT_SERVICES`);
    const roots = DOORS.boot[0].roots;
    assert.ok(bodiesOf(ENTRY).length > 0, `the process entry ${ENTRY} has no indexed function`);
    const reached = walk(roots);
    assert.ok(reached.has(BOOT_SERVICES_KEY), 'the boot walk does not reach the function that starts the services');
    assert.ok(reached.size > roots.length, 'the boot walk reaches nothing beyond its own roots');
    // Everything `startConfiguredInstanceServices` and the entry import at run time (`await import('./x.js')`) must have a
    // function the walk reached — or the walk went blind on dynamic imports and "what it starts" is unread.
    const reachedFiles = new Set([...reached].map(k => k.slice(0, k.indexOf('.ts:') + 3)));
    const blind = [];
    for (const file of new Set([BOOT_SERVICES_KEY.slice(0, BOOT_SERVICES_KEY.indexOf('.ts:') + 3), ENTRY])) {
      const text = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      for (const m of text.matchAll(/\bimport\(\s*'(\.[^']+)\.js'\s*\)/g)) {
        const target = posix(join(file, '..', `${m[1]}.ts`));
        if (bodiesOf(target).length > 0 && !reachedFiles.has(target)) blind.push(`${file} imports ${target} at run time, and the boot walk reaches none of it`);
      }
    }
    assert.deepEqual(blind, []);
  });

  it('the sync engine and file sync have functions to root at, and the doors together reach more files than there are routes', () => {
    for (const [door, file] of [[DOORS.engine[0], ENGINE], [DOORS.fileSync[0], FILE_SYNC]]) {
      assert.ok(door.roots.length > 0, `no function of ${file} is indexed — re-anchor`);
    }
    const files = new Set([...REACHED].map(k => k.slice(0, k.indexOf('.ts:') + 3)));
    assert.ok(files.size > ROUTES.length, `the doors reach ${files.size} file(s) for ${ROUTES.length} routes — the walk is broken`);
  });

  it('read every function it reached, and found every log call the program spells', () => {
    assert.deepEqual(SINKS.unread, [], 'reached function(s) the gate could not find in the AST, so their log lines '
      + 'would go unjudged — teach nodesOf their shape');
    assert.ok(TEXTUAL_LOG_CALLS > 0, 'the comment-free text count finds no `log.<method>(` — the independent reading is broken');
    assert.ok(SINKS.calls.length >= TEXTUAL_LOG_CALLS,
      `the AST resolves ${SINKS.calls.length} log call(s) and the text spells ${TEXTUAL_LOG_CALLS} — a call to \`log\` the checker cannot resolve goes unjudged`);
    assert.ok(SINKS.calls.some(s => s.reached), 'no log call lies inside what the doors reach — the walk is broken');
    assert.ok(SINKS.calls.some(s => s.how.startsWith('handed on')), 'no handed-on log method found (`warn: log.warn`) — '
      + 'resolveWatermark used to be one; re-anchor or drop this check with the reason');
  });
});

describe('a steerable value reaches a log line only bounded', () => {
  it('util/log.ts exports peerText and peerList, and logSafe is peerText', () => {
    const sf = SOURCE.get(LOG_MODULE);
    for (const name of ['peerText', 'peerList', 'logSafe']) {
      assert.ok(topLevelNamed(sf, name), `${LOG_MODULE} has no top-level \`${name}\``);
    }
    const alias = topLevelNamed(sf, 'logSafe');
    const init = ts.isVariableDeclaration(alias) ? unwrap(alias.initializer) : null;
    assert.ok(init && ts.isIdentifier(init) && init.text === 'peerText',
      '`logSafe` must BE `peerText` (`export const logSafe = peerText`), not a second implementation of the rule');
  });

  it('fmt bounds the meta argument: every line is built there, so that is where a meta value is bounded', () => {
    const fmt = topLevelNamed(SOURCE.get(LOG_MODULE), 'fmt');
    assert.ok(fmt, `${LOG_MODULE} has no \`fmt\` — re-anchor`);
    const metaParam = fmt.parameters[2]?.name?.getText();
    assert.ok(metaParam, '`fmt` takes no meta parameter — re-anchor');
    const unbounded = [];
    const visit = n => {
      if (ts.isIdentifier(n) && n.text === metaParam && !ts.isParameter(n.parent)) {
        let inBound = false;
        for (let p = n.parent; p && p !== fmt; p = p.parent) if (isBoundingCall(p)) { inBound = true; break; }
        // The meta value may be TESTED (`meta === undefined`, `meta instanceof Error`) without being bounded.
        const tested = ts.isBinaryExpression(n.parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
          ts.SyntaxKind.InstanceOfKeyword].includes(n.parent.operatorToken.kind);
        if (!inBound && !tested) unbounded.push(n.parent.getText().slice(0, 80));
      }
      ts.forEachChild(n, visit);
    };
    visit(fmt.body);
    assert.deepEqual(unbounded, [], '`fmt` writes the meta argument into the line outside peerText/peerList');
  });

  it('no log method is handed a value it cannot bound (`.catch(log.warn)` logs whatever was thrown, raw)', () => {
    assert.deepEqual(SINKS.rawHandOff.map(n => `${where(n)}  ${n.getText().replace(/\s+/g, ' ').slice(0, 90)}`), []);
  });

  it('every slot of every log message in the program is bounded, or a LOCAL value with its reason', () => {
    // A joined list is never LOCAL: its COUNT is unbounded whatever its elements are, which is what peerList is for.
    const raw = VIOLATIONS.filter(v => !(v.kind === 'value' && LOCAL_SITES.has(v.site)));
    const bySite = new Map();
    for (const v of raw) {
      if (!bySite.has(v.site)) bySite.set(v.site, []);
      bySite.get(v.site).push(`    ${v.at}  ${v.kind}${v.reached ? '' : ' (outside what the doors reach)'}: ${v.text}`);
    }
    const groups = [...bySite].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([site, lines]) => `  ${site}  (${lines.length})\n${lines.sort().join('\n')}`);
    assert.equal(raw.length, 0,
      `${raw.length} slot(s), reading ${bySite.size} defining site(s), write a value into a log line unbounded. `
      + 'Wrap each in peerText/peerList where the value enters the text, or — for a value that is this instance\'s '
      + 'own — name its defining site in LOCAL with the reason. By defining site:\n' + groups.join('\n'));
  });

  it('every LOCAL site is one some slot still reads, under a reason', () => {
    const used = new Set(VIOLATIONS.map(v => v.site));
    const stale = [...LOCAL_SITES.keys()].filter(k => !used.has(k));
    assert.deepEqual(stale, [], 'LOCAL sites no slot reads any more — delete them');
    for (const g of LOCAL) assert.ok(typeof g.why === 'string' && g.why.length >= 40, `${g.sites[0]}: give the reason`);
    assert.equal(LOCAL_SITES.size, LOCAL.reduce((n, g) => n + g.sites.length, 0), 'a site is listed under two reasons');
  });
});
