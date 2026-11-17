/**
 * A test that reads a space's count or whole listing twice reads a space of its own (`Q-866`).
 *
 * ## The failure this prevents
 *
 * `files.test.js` read the stats of the shared `general` space, uploaded one file, read them again and asserted the
 * count had gone up. Every integration file writes into `general` at the same time, and some of them delete, so PR
 * #1631's run read `before=54, after=46` and failed on a change that touched no server code. The directory tests in
 * the same file had the same race in a quieter form: they listed a page of `general`, filtered it by their folder, and
 * asserted on what they found, so a page filled by other files' uploads failed the "before" check, and an "after"
 * check that nothing remains passed whether or not the delete worked. A test owns a count only in a space nobody else
 * writes: `createTestSpace` in `testing/sync/helpers.js`.
 *
 * ## The rule
 *
 * In one test body, two or more AGGREGATE reads of the same FIXED space are refused. An aggregate read answers for the
 * whole space, so another file's write moves it:
 *
 * - a call that names the tool `'space_stats'` (`callTool`, `bothDoors`, `mcpCall`, `tool`): its space is the `space`
 *   property of an object among its arguments;
 * - a string or template naming the route `/spaces/<id>/stats`, or `/api/space_stats` (space as above);
 * - a call to an imported helper whose name says stats (`/stats/i`), with a fixed space among its arguments;
 * - `readCollection(base, token, space, collection, args)` whose `args` carry only paging keys (`limit`, `skip`, ...), so
 *   it lists the whole collection: two pages of a space others insert into can overlap, since a new record shifts every
 *   page after it;
 * - a call to a function declared in the same file whose body makes one of the reads above: its space is the argument
 *   at the parameter that reaches the inner read, or that parameter's DEFAULT when the call leaves it out
 *   (`listFileMeta()` reads `'general'`), and a listing's narrowing is read through the same parameter.
 *
 * A space is FIXED when it is a string literal, or a name bound by `const` in the file to one. A template with a
 * substitution (`stats-${RUN}`) or any other expression is a space the test made: not refused. One read of a fixed
 * space is not refused either, since nothing is compared with it.
 *
 * ## What it does not see
 *
 * A read whose space it cannot resolve (an imported helper that fills the space in itself, a space passed through two
 * variables) is not counted. Only files under `testing/` are read: a client spec answers HTTP from a mock, which no
 * other test writes into. The truth table below decides each shape the rule names, and the tree assertions carry a
 * floor, so a detector that stopped seeing reads fails here instead of passing everything.
 *
 * Run: node --test testing/standalone/a-count-or-listing-is-read-on-a-space-of-its-own.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { testFiles, testBodies, calleeName } from './_test-bodies.mjs';
import { parseSource, lineOf } from '../_shared/syntax-tree.mjs';

const STATS_TOOL = 'space_stats';
/** Keys that only page or budget a listing. Any other key (`filter`, `path`, `tag`, `search`, ...) narrows it to the test's own records. */
const PAGING_KEYS = new Set(['limit', 'skip', 'sort', 'dir', 'maxChars', 'maxBytes', 'maxTokens', 'maxTimeMS', 'includeDiagnostics', 'projection']);
const WHOLE = { narrowed: false };

const isFunctionLike = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n);
const propName = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? p.name.text : null);

/** Names bound by `const` to a plain string anywhere in the file: `const SPACE = 'general'`. */
function constStrings(sf) {
  const out = new Map();
  const visit = (n) => {
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.Const)) {
      for (const d of n.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteralLike(d.initializer)) out.set(d.name.text, d.initializer.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * What an expression says about a space, inside a scope whose parameters are `params` (empty in a test body):
 * `{ fixed }` for a literal or a const-held literal, `{ param }` for a parameter of the enclosing helper, else null.
 */
function spaceOf(expr, ctx) {
  if (!expr) return null;
  if (ts.isStringLiteralLike(expr)) return { fixed: expr.text };
  if (ts.isIdentifier(expr)) {
    const i = ctx.params.indexOf(expr.text);
    if (i >= 0) return { param: i };
    if (ctx.consts.has(expr.text)) return { fixed: ctx.consts.get(expr.text) };
  }
  return null;
}

/** The `space` property of the first object literal among `args` (searched through `JSON.stringify(...)` too). */
function spaceProperty(args, ctx) {
  for (const a of args) {
    let found = null;
    const visit = (n) => {
      if (found) return;
      if (ts.isObjectLiteralExpression(n)) {
        for (const p of n.properties) {
          if (ts.isPropertyAssignment(p) && propName(p) === 'space') { found = spaceOf(p.initializer, ctx) ?? { unknown: true }; return; }
          if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'space') { found = spaceOf(p.name, ctx) ?? { unknown: true }; return; }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(a);
    if (found) return found.unknown ? null : found;
  }
  return null;
}

/** A listing's narrowing: an object literal with `path`/`tag`, a parameter of the helper, or (absent) the whole collection. */
function narrowingOf(expr, ctx) {
  if (!expr) return WHOLE;
  if (ts.isObjectLiteralExpression(expr)) {
    // A spread or a computed key could carry anything: read as narrowed, out of sight like any listing built elsewhere.
    return { narrowed: expr.properties.some(p => !PAGING_KEYS.has(propName(p) ?? '')) };
  }
  if (ts.isIdentifier(expr)) {
    const i = ctx.params.indexOf(expr.text);
    if (i >= 0) return { param: i };
  }
  return { narrowed: true }; // a listing built elsewhere: not counted, the docblock says so
}

/**
 * The space a route string names: `/spaces/<id>/stats` or `/api/space_stats`. An id starting with `:` is a route
 * PATTERN (`/spaces/:spaceId/stats`, a route-map or metrics label), not a space anything is written into.
 */
function routeRead(node, call, ctx) {
  if (ts.isStringLiteralLike(node)) {
    const m = /\/spaces\/([^/:`'"?\s][^/`'"?\s]*)\/stats\b/.exec(node.text);
    if (m) return { space: { fixed: m[1] } };
    if (/\/api\/space_stats\b/.test(node.text)) return { space: call ? spaceProperty(call.arguments, ctx) : null };
    return null;
  }
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text, ...node.templateSpans.map(s => s.literal.text)];
    for (let i = 0; i < node.templateSpans.length; i++) {
      if (/\/spaces\/$/.test(parts[i]) && /^\/stats\b/.test(parts[i + 1])) return { space: spaceOf(node.templateSpans[i].expression, ctx) };
    }
    const LITERAL_ROUTE = /\/spaces\/([^/:`'"?\s$][^/`'"?\s$]*)\/stats\b/;
    const literal = parts.find(p => LITERAL_ROUTE.test(p));
    if (literal) return { space: { fixed: LITERAL_ROUTE.exec(literal)[1] } };
    if (parts.some(p => /\/api\/space_stats\b/.test(p))) return { space: call ? spaceProperty(call.arguments, ctx) : null };
  }
  return null;
}

/**
 * The aggregate read a call makes, or null: `{ space, narrowing }` with each resolved as far as `ctx` allows.
 * `ctx.helpers` holds the same file's helpers already summarised.
 */
function callRead(call, ctx) {
  const name = calleeName(call);
  const args = [...call.arguments];
  const helper = ts.isIdentifier(call.expression) ? ctx.helpers.get(name) : undefined;
  if (helper) {
    const resolve = (s, fallback) => (s && 'param' in s ? (args[s.param] ? fallback(args[s.param]) : helper.defaults[s.param]) : s);
    const space = resolve(helper.space, (e) => spaceOf(e, ctx));
    const narrowing = resolve(helper.narrowing, (e) => narrowingOf(e, ctx)) ?? WHOLE;
    return { space: space ?? null, narrowing };
  }
  if (args.some(a => ts.isStringLiteralLike(a) && a.text === STATS_TOOL)) return { space: spaceProperty(args, ctx), narrowing: WHOLE };
  if (name === 'readCollection') return { space: spaceOf(args[2], ctx), narrowing: narrowingOf(args[4], ctx) };
  for (const a of args) {
    const r = routeRead(a, call, ctx);
    if (r) return { ...r, narrowing: WHOLE };
  }
  if (/stats/i.test(name) && !ctx.declared.has(name)) {
    const fixed = args.map(a => spaceOf(a, ctx)).find(s => s && 'fixed' in s);
    if (fixed) return { space: fixed, narrowing: WHOLE };
  }
  return null;
}

/**
 * Every aggregate read under `node`, in source order, as `{ node, space, narrowing }`. A read is counted once, at its
 * outermost site; a helper declared inside is skipped (its calls are the reads).
 */
function readsUnder(node, ctx) {
  const out = [];
  const visit = (n) => {
    if (n !== node && isNamedHelper(n)) return;
    if (ts.isCallExpression(n)) {
      const r = callRead(n, ctx);
      if (r) { out.push({ node: n, ...r }); return; }
    }
    if (ts.isStringLiteralLike(n) || ts.isTemplateExpression(n)) {
      const r = routeRead(n, null, ctx);
      if (r) { out.push({ node: n, ...r, narrowing: WHOLE }); return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** `function name() {}` or `const name = () => {}` / `function () {}`: a helper a test calls by name. */
function isNamedHelper(n) {
  if (ts.isFunctionDeclaration(n) && n.name) return true;
  return ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isFunctionLike(n.initializer);
}

const helperParts = (n) => (ts.isFunctionDeclaration(n) ? { name: n.name.text, fn: n } : { name: n.name.text, fn: n.initializer });

/** The default each parameter takes, resolved like a space: `spaceId = 'general'` gives `{ fixed: 'general' }`. */
const defaultsOf = (fn, ctx) => fn.parameters.map(p => (p.initializer
  ? (ts.isObjectLiteralExpression(p.initializer) ? narrowingOf(p.initializer, ctx) : spaceOf(p.initializer, ctx))
  : null));

/**
 * The aggregate reads of one file's test bodies, grouped per body: `[{ name, line, reads }]`. Helpers declared in
 * the file are summarised first (three passes, so a helper that calls a helper resolves).
 */
export function aggregateReads(file, text) {
  const sf = parseSource(file, text);
  const consts = constStrings(sf);
  const declared = new Set();
  const decls = [];
  const collect = (n) => { if (isNamedHelper(n)) { const h = helperParts(n); declared.add(h.name); decls.push(h); } ts.forEachChild(n, collect); };
  collect(sf);
  const helpers = new Map();
  for (let pass = 0; pass < 3; pass++) {
    for (const { name, fn } of decls) {
      const params = fn.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : ''));
      const ctx = { params, consts, helpers, declared };
      const body = fn.body ?? fn;
      const first = readsUnder(body, ctx).find(r => r.space);
      if (first) helpers.set(name, { space: first.space, narrowing: first.narrowing, defaults: defaultsOf(fn, ctx) });
    }
  }
  const ctx = { params: [], consts, helpers, declared };
  return testBodies(sf).map(({ name, fn }) => ({
    name,
    line: lineOf(sf, fn),
    reads: readsUnder(fn.body ?? fn, ctx).filter(r => r.space && 'fixed' in r.space && !r.narrowing?.narrowed)
      .map(r => ({ space: r.space.fixed, line: lineOf(sf, r.node) })),
  }));
}

/** The bodies of `file` that read one fixed space twice or more: `<file>:<line> '<test>' reads '<space>' at lines a, b`. */
export function sharedCountReads(file, text) {
  const found = [];
  for (const body of aggregateReads(file, text)) {
    const bySpace = new Map();
    for (const r of body.reads) (bySpace.get(r.space) ?? bySpace.set(r.space, []).get(r.space)).push(r.line);
    for (const [space, lines] of bySpace) {
      if (lines.length >= 2) found.push(`${file}:${body.line} '${body.name}' reads the fixed space '${space}' at lines ${lines.join(', ')}`);
    }
  }
  return found;
}

const src = (...lines) => lines.join('\n');
const refused = (text) => sharedCountReads('testing/integration/snippet.test.js', text);

describe('the detector decides every shape the rule names', () => {
  const MUST_BE_REFUSED = {
    'the files.test.js stats test before the fix (a local helper over a stats URL)': src(
      "async function getStats(token, spaceId) {",
      "  const url = `${INSTANCES.a}/api/brain/spaces/${spaceId}/stats`;",
      "  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });",
      "  return { status: r.status, body: await r.json() };",
      "}",
      "it('Brain stats endpoint includes files count', async () => {",
      "  const before = await getStats(tokenA, 'general');",
      "  await uploadFile(tokenA, 'general', `stats-count-${RUN}.txt`, 'counting');",
      "  const after = await getStats(tokenA, 'general');",
      "  assert.ok(after.body.files >= before.body.files + 1);",
      "});"),
    'the directory tests before the fix (a listing helper that defaults to general)': src(
      "const listFileMeta = (args = {}, spaceId = 'general') => readCollection(INSTANCES.a, tokenA, spaceId, 'files', args);",
      "it('Deleting a directory removes metadata', async () => {",
      "  const before = await listFileMeta();",
      "  await del(dir);",
      "  const after = await listFileMeta({ limit: 200 });",
      "});"),
    'the tool named by string through callTool': src(
      "it('x', async () => {",
      "  const a = await session.callTool('space_stats', { space: 'general' });",
      "  const b = await session.callTool('space_stats', { space: 'general' });",
      "});"),
    'the tool named by string through a two-door helper': src(
      "it('x', async () => {",
      "  const a = await bothDoors('space_stats', { space: 'general' });",
      "  await write();",
      "  const b = await bothDoors('space_stats', { space: 'general' });",
      "});"),
    'a literal stats route fetched twice': src(
      "it('x', async () => {",
      "  const a = await fetch(`${INSTANCES.a}/api/brain/spaces/general/stats`, opts);",
      "  const b = await fetch(`${INSTANCES.a}/api/brain/spaces/general/stats`, opts);",
      "});"),
    'the tool route with a space in its body': src(
      "it('x', async () => {",
      "  const a = await fetch(`${INSTANCES.a}/api/space_stats`, { method: 'POST', body: JSON.stringify({ space: 'general' }) });",
      "  const b = await fetch(`${INSTANCES.a}/api/space_stats`, { method: 'POST', body: JSON.stringify({ space: 'general' }) });",
      "});"),
    'a fixed space held in a const': src(
      "const SPACE = 'general';",
      "it('x', async () => {",
      "  const a = await getSpaceStats(token, SPACE);",
      "  const b = await getSpaceStats(token, SPACE);",
      "});"),
    'an imported stats helper spelled in capitals': src(
      "it('x', async () => {",
      "  const a = await readSTATS(token, 'shared-space');",
      "  const b = await readSTATS(token, 'shared-space');",
      "});"),
    'a whole-collection listing read directly': src(
      "it('x', async () => {",
      "  const a = await readCollection(INSTANCES.a, token, 'general', 'entities', { limit: 200 });",
      "  const b = await readCollection(INSTANCES.a, token, 'general', 'entities');",
      "});"),
    'a helper that calls a helper': src(
      "async function getStats(token, spaceId) { return fetch(`${A}/api/brain/spaces/${spaceId}/stats`); }",
      "const filesIn = (spaceId = 'general') => getStats(tokenA, spaceId);",
      "it('x', async () => { const a = await filesIn(); const b = await filesIn(); });"),
    'two pages of the whole of general (brain.test.js before the fix)': src(
      "it('skip pagination returns disjoint results', async () => {",
      "  const page1 = await readCollection(INSTANCES.a, token(), 'general', 'facts', { limit: 3, skip: 0 });",
      "  const page2 = await readCollection(INSTANCES.a, token(), 'general', 'facts', { limit: 3, skip: 3 });",
      "});"),
    'a read inside a callback the test passes on': src(
      "it('x', async () => {",
      "  const a = await getSpaceStats(token, 'general');",
      "  await waitForReading(() => getSpaceStats(token, 'general'), (s) => s.files > 0, 5000, 100);",
      "});"),
  };
  for (const [name, code] of Object.entries(MUST_BE_REFUSED)) {
    it(`refuses: ${name}`, () => {
      assert.equal(refused(code).length, 1, `not refused:\n${code}`);
    });
  }

  const MUST_PASS = {
    'the stats test after the fix (a space of its own)': src(
      "async function getStats(token, spaceId) { return fetch(`${A}/api/brain/spaces/${spaceId}/stats`); }",
      "it('x', async () => {",
      "  const space = await createTestSpace('stats-count', [[INSTANCES.a, tokenA]]);",
      "  const before = await getStats(tokenA, space.id);",
      "  const after = await getStats(tokenA, space.id);",
      "});"),
    'the listing helper pointed at the test\'s own space': src(
      "const listFileMeta = (args = {}, spaceId = 'general') => readCollection(INSTANCES.a, tokenA, spaceId, 'files', args);",
      "it('x', async () => { const a = await listFileMeta({}, SPACE_ID); const b = await listFileMeta({}, SPACE_ID); });"),
    'a timestamped space through the tool': src(
      "const testSpaceId = `mcp-files-${Date.now()}`;",
      "it('x', async () => {",
      "  const a = await session.callTool('space_stats', { space: testSpaceId });",
      "  const b = await session.callTool('space_stats', { space: testSpaceId });",
      "});"),
    'one read of general, nothing compared with it': src(
      "it('x', async () => {",
      "  const r = await session.callTool('space_stats', { space: 'general' });",
      "  assert.equal(typeof JSON.parse(r.content[0].text).files, 'number');",
      "});"),
    'listings narrowed to the test\'s own path': src(
      "const listFileMeta = (args = {}, spaceId = 'general') => readCollection(INSTANCES.a, tokenA, spaceId, 'files', args);",
      "it('x', async () => {",
      "  const q1 = await listFileMeta({ path: filePath });",
      "  const q2 = await listFileMeta({ path: filePath });",
      "});"),
    'listings narrowed by a filter to the test\'s own records, directly and through a helper': src(
      "const byId = (collection, id) => readCollection(INSTANCES.a, token, 'general', collection, { filter: { _id: id }, limit: 1 });",
      "it('x', async () => {",
      "  const e = await byId('entities', ids.e);",
      "  const f = await byId('facts', ids.f);",
      "  const a = await readCollection(INSTANCES.a, token, 'general', 'entities', { filter: { name: `${n}-A` } });",
      "  const b = await readCollection(INSTANCES.a, token, 'general', 'entities', { filter: { name: `${n}-B` } });",
      "});"),
    'a route PATTERN, not a space (a route-map or metrics label)': src(
      "it('x', () => {",
      "  assert.equal(labelOf('/api/brain/spaces/:spaceId/stats'), 'GET /api/brain/spaces/:spaceId/stats');",
      "  assert.equal(labelOf(`/api/brain/spaces/:spaceId/stats`), 'x');",
      "});"),
    'reads of two different fixed spaces, once each': src(
      "it('x', async () => {",
      "  const a = await session.callTool('space_stats', { space: 'general' });",
      "  const b = await session.callTool('space_stats', { space: 'other' });",
      "});"),
    'a stats helper with no space argument (out of sight, see the docblock)': src(
      "it('x', async () => { const a = await restStats(); const b = await restStats(); });"),
    'two stats reads in two different tests': src(
      "it('x', async () => { await session.callTool('space_stats', { space: 'general' }); });",
      "it('y', async () => { await session.callTool('space_stats', { space: 'general' }); });"),
  };
  for (const [name, code] of Object.entries(MUST_PASS)) {
    it(`passes: ${name}`, () => {
      assert.deepEqual(refused(code), [], `refused although it ${name}`);
    });
  }
});

describe('no test in the repository reads a shared count twice', () => {
  const files = testFiles().filter(f => f.file.startsWith('testing/'));

  it('the scan sees the test files and the reads in them (a floor)', () => {
    assert.ok(files.length >= 500, `only ${files.length} test files under testing/ - the listing is broken`);
    const all = files.flatMap(f => aggregateReads(f.file, f.text).flatMap(b => b.reads));
    assert.ok(all.length >= 3, `only ${all.length} aggregate read(s) of a fixed space found in the whole tree - the detector stopped seeing them`);
  });

  it('every count or whole listing a test compares is of a space of its own', () => {
    const found = files.flatMap(f => sharedCountReads(f.file, f.text));
    assert.deepEqual(found, [],
      'these tests read the count or the whole listing of a space other test files write into, more than once, so a '
      + 'concurrent write moves the answer between the reads. Make the space with createTestSpace (testing/sync/helpers.js) '
      + 'and remove it after:\n  ' + found.join('\n  '));
  });
});
