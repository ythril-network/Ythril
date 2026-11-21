/**
 * No request handler loads a module while it answers: an Express route callback, an MCP tool's `handle`, and every function of the same file
 * they reach, hold no `import(...)` (the owner's rule "no dynamic import in a request handler", bundle-270 common rules).
 *
 * ## The failure that bought it
 *
 * `schema_update` and `update_space` loaded the settings planner and the face-width check with `await import(...)` inside the call
 * (`mcp/tools/spaces.ts`, found while designing the schema-from-RDF door, Q-754). A module loaded at request time fails at request time: a
 * renamed export, a module that throws while it loads or an import cycle surfaces as one caller's 500 instead of a failed start, and the
 * first caller pays the load. Nothing refused it; the rule lived in a document.
 *
 * ## How it reads
 *
 * From the syntax tree (`parseSource`, `walkEveryNode`), never a regex, so a fixture string or a comment that spells `await import(` is no
 * hit. Its scope comes from the repository: every tracked `.ts` file under the server code roots (`SERVER_CODE_ROOTS`). A handler is a function passed to a route
 * registration (`<router|app>.<get|post|put|patch|delete|all|use>(…)`, given inline or by the name of a function of the file) or the `handle`
 * of a tool object (an object literal with a `name` and a `handle`). From each handler the walk follows every function of the same file it
 * names, so a helper the handler calls (`runSpaceMetaUpdate` was one) is read as part of it.
 *
 * ## Exceptions
 *
 * Only in `a-request-handler-loads-no-module-at-request-time.allow.json`, one row per file and module, each with its reason and a review date;
 * a row without either, past its date, or matching nothing fails. The run reports how many rows it used.
 *
 * Run: node --test testing/standalone/a-request-handler-loads-no-module-at-request-time.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { ts, parseSource, walkEveryNode, lineOf } from '../_shared/syntax-tree.mjs';

const ALLOW_FILE = 'a-request-handler-loads-no-module-at-request-time.allow.json';
const ALLOW = JSON.parse(readFileSync(new URL(`./${ALLOW_FILE}`, import.meta.url), 'utf8')).entries;

const VERBS = /^(get|post|put|patch|delete|all|use)$/;
const RECEIVER = /(?:^|\.)(?:\w*[rR]outer|app)$/;

/** The functions declared at the top of a file, by name: `function f() {}` and `const f = () => {}` / `const f = function () {}`. */
function fileFunctions(sf) {
  const out = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) out.set(d.name.text, d.initializer);
      }
    }
  }
  return out;
}

/** The handlers of a file: `{ node, name }` for each route callback and each tool's `handle`. */
function handlersOf(sf, functions) {
  const out = [];
  walkEveryNode(sf, (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && VERBS.test(n.expression.name.text)
      && RECEIVER.test(n.expression.expression.getText(sf))) {
      const route = ts.isStringLiteralLike(n.arguments[0] ?? n) ? `${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}` : `${n.expression.name.text} at line ${lineOf(sf, n)}`;
      for (const a of n.arguments) {
        if (ts.isFunctionLike(a)) out.push({ node: a, name: route });
        else if (ts.isIdentifier(a) && functions.has(a.text)) out.push({ node: functions.get(a.text), name: `${route} (${a.text})` });
      }
    }
    if (ts.isObjectLiteralExpression(n)) {
      const props = n.properties;
      const named = props.some(p => p.name && ts.isIdentifier(p.name) && p.name.text === 'name');
      for (const p of props) {
        if (!named || !p.name || !ts.isIdentifier(p.name) || p.name.text !== 'handle') continue;
        if (ts.isMethodDeclaration(p)) out.push({ node: p, name: 'a tool\'s handle' });
        else if (ts.isPropertyAssignment(p) && ts.isFunctionLike(p.initializer)) out.push({ node: p.initializer, name: 'a tool\'s handle' });
      }
    }
  });
  return out;
}

/**
 * Every `import(...)` a handler of `text` reaches, as `{ file, line, module, from }`: the scan over the repository and the fixture case below
 * call the same function.
 */
function moduleLoadsInHandlers(file, text) {
  const sf = parseSource(file, text);
  const functions = fileFunctions(sf);
  const found = new Map();
  for (const h of handlersOf(sf, functions)) {
    const seen = new Set([h.node]);
    const queue = [h.node];
    while (queue.length > 0) {
      const fn = queue.shift();
      walkEveryNode(fn, (n) => {
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const line = lineOf(sf, n);
          const arg = n.arguments[0];
          const module = arg && ts.isStringLiteralLike(arg) ? arg.text : (arg?.getText(sf) ?? '');
          if (!found.has(line)) found.set(line, { file, line, module, from: h.name });
        }
        if (ts.isIdentifier(n) && functions.has(n.text)) {
          const target = functions.get(n.text);
          if (!seen.has(target)) { seen.add(target); queue.push(target); }
        }
      });
    }
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** The handlers a file registers, counted (for the floor below). */
const handlerCount = (file, text) => { const sf = parseSource(file, text); return handlersOf(sf, fileFunctions(sf)).length; };

const sources = () => trackedSources(SERVER_CODE_ROOTS, { ext: ['.ts'], floor: 100 }).map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));

describe('no request handler loads a module at request time', () => {
  it('every import() a handler reaches is refused, unless a row of the allowlist names its file and module', (t) => {
    const today = new Date().toISOString().slice(0, 10);
    const used = new Set();
    const hits = [];
    for (const { file, text } of sources()) {
      for (const hit of moduleLoadsInHandlers(file, text)) {
        const row = ALLOW.findIndex(e => e.file === hit.file && e.module === hit.module);
        if (row >= 0) { used.add(row); continue; }
        hits.push(`${hit.file}:${hit.line} import('${hit.module}'), reached from ${hit.from}`);
      }
    }
    t.diagnostic(`allowlist rows used: ${used.size} of ${ALLOW.length}`);
    assert.deepEqual(hits, [], 'a request handler loads a module while it answers; import it at the top of the file:\n  ' + hits.join('\n  '));
    const bad = ALLOW.map((e, i) => (!e.reason || !e.reviewBy ? `row ${i} (${e.file}) has no reason or review date`
      : e.reviewBy < today ? `row ${i} (${e.file}) is past its review date ${e.reviewBy}`
        : !used.has(i) ? `row ${i} (${e.file}, ${e.module}) matches no import a handler reaches: remove it` : null)).filter(Boolean);
    assert.deepEqual(bad, [], `${ALLOW_FILE}:\n  ${bad.join('\n  ')}`);
  });

  it('the scan sees the handlers it judges: route callbacks and tool handles across the server', () => {
    let routes = 0, tools = 0;
    for (const { file, text } of sources()) {
      const n = handlerCount(file, text);
      if (file.startsWith('server/src/mcp/')) tools += n; else routes += n;
    }
    assert.ok(routes > 100, `only ${routes} route handlers were found; the registration pattern is broken`);
    assert.ok(tools > 50, `only ${tools} tool handlers were found; the tool pattern is broken`);
  });

  it('a route callback, a tool handle and a helper they call are read; a string, a comment and an unreached function are not', () => {
    const q = '\x27';
    const fixture = [
      'import { Router } from "express";',
      'export const spacesRouter = Router();',
      `spacesRouter.get(${q}/a${q}, async (req, res) => { const m = await import(${q}./a.js${q}); res.json(m); });`,
      `spacesRouter.post(${q}/b${q}, async (req, res) => { await helper(); res.json({}); });`,
      `async function helper() { const { x } = await import(${q}./b.js${q}); return x; }`,
      `export const tool = { name: ${q}t${q}, async handle(ctx) { return (await import(${q}./c.js${q})).run(ctx); } };`,
      `spacesRouter.put(${q}/d${q}, (req, res) => { res.json({ text: ${q}await import(./d.js)${q} }); /* await import(${q}./e.js${q}) */ });`,
      `async function unreached() { return import(${q}./f.js${q}); }`,
      '',
    ].join('\n');
    const hits = moduleLoadsInHandlers('server/src/api/fixture.ts', fixture);
    assert.deepEqual(hits.map(h => [h.line, h.module]), [[3, './a.js'], [5, './b.js'], [6, './c.js']]);
    assert.match(hits[1].from, /POST \/b/, 'the helper\'s import is named with the handler that reaches it');
  });
});
