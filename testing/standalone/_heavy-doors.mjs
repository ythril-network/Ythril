/**
 * The doors that spend the heavy-call budget, derived from the product's own consumers of the limiter, and the places a test file names one.
 *
 * ## What it prevents
 *
 * A list of "the heavy doors" written in a gate is wrong the day someone prices a new door. The limiter is two functions
 * (`consumeHeavyToolCall`, `heavyRunner`); whatever imports one of them is a PAYER, and whatever reaches a payer is a door. This module reads
 * `server/src` and answers: which tools (`name:` of a tool object that is declared `heavy: true` or reaches a payer), which REST routes
 * (an Express registration that reaches a payer, by the static tail of its path), and which body keys decide whether a door is paid
 * (`x.convertRecords === undefined ? null : schemaConvertPrice(...)`). A door added tomorrow that reaches a payer is a door here.
 *
 * Reaching is by name inside one file, to a fixpoint: a tool whose handler calls a local `runSpaceMetaUpdate` that calls the payer reaches it.
 *
 * Two derivations are not trusted blind: {@link heavyDoors} returns what it found, and the gate asserts the doors the product names in its
 * own refusal sentences are among them, so a derivation that silently found nothing fails instead of clearing every file.
 */
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';
import { ts, parseSource, lineOf, unwrapExpression, routeBlocksOf, walkEveryNode } from '../_shared/syntax-tree.mjs';

const LIMITER_NAMES = ['consumeHeavyToolCall', 'heavyRunner'];
/** The dispatcher consumes the limiter for tools that declare `heavy`; the limiter's own folder is not a payer of anything. */
const NOT_PAYERS = (f) => f.startsWith('server/src/rate-limit/') || f === 'server/src/mcp/call-tool.ts';

/** The identifier names under `node`, leaving out the subtrees in `skip` (a payer call that only a body key decides). */
const idsOf = (node, skip) => {
  const out = new Set();
  const go = (n) => {
    if (skip?.has(n)) return;
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, go);
  };
  go(node);
  return out;
};

/**
 * The payer calls a body key decides: the branch of `<key> === undefined ? null : payer(...)`. Such a call prices a door only when the
 * body carries the key, so the door is recognised by the key (`bodyKeys`), never by its name: `update_space` without `convertRecords` pays nothing.
 */
function keyDecidedCalls(sf, payers) {
  const calls = new Set();
  const keys = new Set();
  walkEveryNode(sf, (n) => {
    if (!ts.isConditionalExpression(n)) return;
    const branches = [n.whenTrue, n.whenFalse].map(unwrapExpression).filter(e => ts.isCallExpression(e) && ts.isIdentifier(e.expression) && payers.has(e.expression.text));
    if (branches.length === 0) return;
    for (const b of branches) calls.add(b);
    walkEveryNode(n.condition, (c) => { if (ts.isPropertyAccessExpression(c) && !ts.isPropertyAccessExpression(c.parent)) keys.add(c.name.text); });
  });
  return { calls, keys };
}
const importedNames = (sf) => {
  const out = new Set();
  walkEveryNode(sf, (n) => {
    if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      for (const el of n.importClause.namedBindings.elements) out.add((el.propertyName ?? el.name).text);
    }
  });
  return out;
};
const exportedNames = (sf) => {
  const out = [];
  for (const st of sf.statements) {
    const exported = ts.getModifiers?.(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name) out.push(st.name.text);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text);
  }
  return out;
};

/** The top-level declarations of `sf` that reach a payer (or `heavy: true`), by name, to a fixpoint. */
function reachingNames(sf, payers, skip) {
  const decls = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) decls.set(st.name.text, idsOf(st, skip));
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) decls.set(d.name.text, idsOf(d.initializer, skip));
  }
  const reach = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, ids] of decls) {
      if (reach.has(name)) continue;
      if ([...ids].some(i => payers.has(i) || reach.has(i))) { reach.add(name); changed = true; }
    }
  }
  return reach;
}

const staticTail = (routePath) => {
  const segs = routePath.split('/');
  let last = -1;
  segs.forEach((s, i) => { if (s.startsWith(':')) last = i; });
  return segs.slice(last + 1).filter(Boolean).map(s => `/${s}`).join('');
};

/**
 * @param {{ file: string, text: string }[]} serverFiles every tracked `server/src` TypeScript file
 * @returns {{ payers: string[], tools: string[], routes: { file: string, route: string, tail: string }[], bodyKeys: string[], unrecognised: string[] }}
 */
export function heavyDoors(serverFiles) {
  const parsed = serverFiles.map(({ file, text }) => ({ file, sf: parseSource(file, text) }));
  const consumers = parsed.filter(({ file, sf }) => !file.startsWith('server/src/rate-limit/') && [...importedNames(sf)].some(n => LIMITER_NAMES.includes(n)));
  const payers = new Set(consumers.filter(c => !NOT_PAYERS(c.file)).flatMap(c => exportedNames(c.sf)));
  // The dispatcher's own reading of `heavy: true` is not an export; tools carry the flag, read below.
  const tools = new Set();
  const routes = [];
  const bodyKeys = new Set();
  const unrecognised = [];
  for (const { file, sf } of parsed) {
    const { calls: skip, keys } = keyDecidedCalls(sf, payers);
    for (const k of keys) bodyKeys.add(k);
    const reach = reachingNames(sf, payers, skip);
    if (file.startsWith('server/src/mcp/tools/')) {
      walkEveryNode(sf, (n) => {
        if (!ts.isObjectLiteralExpression(n)) return;
        const prop = (k) => n.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(sf) === k);
        const name = prop('name')?.initializer;
        if (!name || !ts.isStringLiteralLike(name) || !prop('handle') && !prop('inputSchema')) return;
        const heavy = prop('heavy')?.initializer?.kind === ts.SyntaxKind.TrueKeyword;
        const ids = idsOf(n, skip);
        if (heavy || [...ids].some(i => payers.has(i) || reach.has(i))) tools.add(name.text);
      });
    }
    if (file.startsWith('server/src/api/')) {
      for (const block of routeBlocksOf(sf)) {
        const ids = idsOf(block.node, skip);
        if (![...ids].some(i => payers.has(i) || reach.has(i))) continue;
        const routePath = block.route.split(' ')[1];
        const tail = staticTail(routePath);
        routes.push({ file, route: block.route, tail });
      }
    }
  }
  for (const r of routes) if (r.tail === '' && bodyKeys.size === 0) unrecognised.push(`${r.file}: ${r.route}`);
  return { payers: [...payers].sort(), tools: [...tools].sort(), routes, bodyKeys: [...bodyKeys].sort(), unrecognised };
}

const escape = escapeRegExp;

/** The text a string-like or template node spells, with each `${...}` as the one character `§`. */
function flatText(n) {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => `§${s.literal.text}`).join('');
  return null;
}

/**
 * Every place `text` names a heavy door: a tool's name as a whole string or as `/api/<tool>`, a route's static tail inside a `/api/` path,
 * a deciding body key as a name.
 *
 * @returns {{ node: import('typescript').Node, line: number, door: string }[]}
 */
export function doorSitesIn(file, text, doors) {
  const sf = parseSource(file, text);
  const toolRes = doors.tools.map(t => ({ door: `tool ${t}`, re: new RegExp(`^${escape(t)}$|/api/${escape(t)}(?![\\w-])`) }));
  const tails = [...new Set(doors.routes.map(r => r.tail).filter(Boolean))];
  const routeRes = tails.map(t => ({ door: `route ...${t}`, re: new RegExp(`/api/.*${escape(t)}(?![\\w-])`) }));
  const out = [];
  walkEveryNode(sf, (n) => {
    const flat = ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) ? flatText(n) : null;
    if (flat != null) {
      for (const { door, re } of [...toolRes, ...routeRes]) if (re.test(flat)) out.push({ node: n, line: lineOf(sf, n), door });
      for (const k of doors.bodyKeys) if (flat === k && ts.isStringLiteralLike(n)) out.push({ node: n, line: lineOf(sf, n), door: `body key ${k}` });
    }
    if (ts.isIdentifier(n) && doors.bodyKeys.includes(n.text)) out.push({ node: n, line: lineOf(sf, n), door: `body key ${n.text}` });
  });
  return out;
}
