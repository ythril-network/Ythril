/**
 * Every `new MongoClient(` in `server/src` takes its liveness options from `mongoClientOptions`, or says why it does not
 * (`Q-329`, bundle-53 G6).
 *
 * ## What it prevents
 *
 * `db/client-options.ts` is the ONE place the client's liveness options live: the three defaults, minus every key the
 * connection string names, so an operator's `connectTimeoutMS=3000` in `MONGO_URI` is the figure the driver sees. A
 * client built with an inline `{ serverSelectionTimeoutMS: 10_000 }` beside the same string defeats that without a word:
 * the driver gives an options OBJECT precedence over the string, so the operator's number is thrown away, and the
 * in-flight bound the docs state and the boot line prints describes a client that is not the one running. Before this
 * gate the boot client (`mongo.ts`) and the connection test (`conn-test.ts`) each carried their own figures.
 *
 * ## What it reads, and why it reads the tree
 *
 * Every tracked `.ts` under `server/src`, as a syntax tree: a comment that says `new MongoClient(` (the docblock of
 * `client-options.ts` does) is not a construction. A construction is a `new` of the identifier `MongoClient`, or of a
 * property called `MongoClient` (`new driver.MongoClient(`). The set is DERIVED, never listed, and floored: a scan that
 * reads the tree wrongly finds no client and so passes for every one.
 *
 * It asks one question of each: does the OPTIONS argument (the second) hold a call of `mongoClientOptions`, or of a
 * function built on it? A spread beside it (`{ ...mongoClientOptions(uri, d), socketTimeoutMS }`) counts; a literal object
 * does not. A client with no options argument at all fails the same way. The functions built on it are DERIVED: every
 * function declared in `server/src` whose body calls `mongoClientOptions` (today `boundedClientOptions`, which adds a bound
 * scope's per-operation figure, bundle-157 I4a) - so a wrapper is accepted because it calls the module, never because it
 * is named here.
 *
 * ## The exemptions
 *
 * None today. `db/dump.ts` and `db/restore.ts` were exempt (a whole-database copy with its own 15 s figures) until their
 * clients went through `boundedClientOptions` (bundle-157 I4a), which keeps those figures as caller defaults. A row says
 * why, and the gate holds the row to the site: an exemption for a file with no client in it fails, and so does one for a
 * client that does go through the module (a row that is no longer needed is the stale half of the same defect).
 *
 * The detector is held on samples, so a mutation of the scan fails here and not only on the repository.
 *
 * Run: node --test testing/standalone/every-mongo-client-goes-through-mongo-client-options.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { lineOf, parseSource, ts } from '../_shared/syntax-tree.mjs';

const OPTIONS_BUILDER = 'mongoClientOptions';

/** The files whose client is not the live one, and why. Keyed by repo-relative path. */
const EXEMPT = new Map([]);

/** The fewest clients that means the scan read the tree: the repository holds four today, and a scan that finds none passes everything. */
const CLIENT_FLOOR = 3;

const isClientName = (expr) =>
  (ts.isIdentifier(expr) && expr.text === 'MongoClient')
  || (ts.isPropertyAccessExpression(expr) && expr.name.text === 'MongoClient');

/** Does `node`, or anything it holds, call one of `builders` (`mongoClientOptions`, or a function built on it)? */
function callsBuilder(node, builders = new Set([OPTIONS_BUILDER])) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && builders.has(n.expression.text)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** The names of the functions declared in `text` whose body calls `mongoClientOptions`: builders on it, derived and never listed. */
export function buildersIn(file, text) {
  const sf = parseSource(file, text);
  const names = [];
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && node.name.text !== OPTIONS_BUILDER && callsBuilder(node.body)) names.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/** Every `new MongoClient(` in `text`: `{ line, viaBuilder }` — `viaBuilder` says the options argument calls one of `builders`. */
export function mongoClients(file, text, builders = new Set([OPTIONS_BUILDER])) {
  const sf = parseSource(file, text);
  const clients = [];
  const visit = (node) => {
    if (ts.isNewExpression(node) && isClientName(node.expression)) {
      const options = node.arguments?.[1];
      clients.push({ line: lineOf(sf, node), viaBuilder: options !== undefined && callsBuilder(options, builders) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return clients;
}

const sources = () => trackedSources(['server/src'], { floor: 100 });
const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('mongoClients (the detector, held on samples)', () => {
  it('finds a client built with a literal options object as not going through the builder', () => {
    assert.deepEqual(mongoClients('x.ts', 'const c = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });'), [{ line: 1, viaBuilder: false }]);
  });
  it('finds a client built with no options at all as not going through the builder', () => {
    assert.deepEqual(mongoClients('x.ts', 'const c = new MongoClient(uri);'), [{ line: 1, viaBuilder: false }]);
  });
  it('finds the builder handed directly, or spread beside other options', () => {
    const text = 'const a = new MongoClient(uri, mongoClientOptions(uri));\nconst b = new MongoClient(uri, { ...mongoClientOptions(uri, d), socketTimeoutMS: 5 });';
    assert.deepEqual(mongoClients('x.ts', text), [{ line: 1, viaBuilder: true }, { line: 2, viaBuilder: true }]);
  });
  it('finds a client built through a namespace, and not a comment or a string that names one', () => {
    const text = ['const a = new driver.MongoClient(uri, {});', '// new MongoClient(uri, mongoClientOptions(uri))', "const s = 'new MongoClient(uri)';"].join('\n');
    assert.deepEqual(mongoClients('x.ts', text), [{ line: 1, viaBuilder: false }]);
  });
  it('does not take the builder named only in the FIRST argument for the options', () => {
    assert.deepEqual(mongoClients('x.ts', 'new MongoClient(mongoClientOptions(uri), {});'), [{ line: 1, viaBuilder: false }]);
  });
  it('derives a function built on the builder, and accepts a client built through it', () => {
    const text = 'export function wrapped(uri) { return { ...mongoClientOptions(uri), timeoutMS: 5 }; }\nfunction unrelated() { return {}; }';
    assert.deepEqual(buildersIn('x.ts', text), ['wrapped']);
    const builders = new Set([OPTIONS_BUILDER, 'wrapped']);
    assert.deepEqual(mongoClients('y.ts', 'new MongoClient(uri, wrapped(uri));\nnew MongoClient(uri, unrelated());', builders),
      [{ line: 1, viaBuilder: true }, { line: 2, viaBuilder: false }]);
  });
});

describe('every MongoClient is built from mongoClientOptions', () => {
  const builders = new Set([OPTIONS_BUILDER]);
  for (const file of sources()) for (const name of buildersIn(file, read(file))) builders.add(name);
  const found = [];
  for (const file of sources()) for (const c of mongoClients(file, read(file), builders)) found.push({ file, ...c });

  it('the scan reads enough to mean something (a floor on the clients found)', () => {
    assert.ok(found.length >= CLIENT_FLOOR,
      `only ${found.length} \`new MongoClient(\` found in server/src (floor ${CLIENT_FLOOR}): the scan is reading the tree wrongly, and an empty answer passes every loop below.`);
  });

  it('every client takes its liveness options from mongoClientOptions, or its file is an exemption with a reason', () => {
    const bad = found.filter(c => !c.viaBuilder && !EXEMPT.has(c.file)).map(c => `${c.file}:${c.line}`);
    assert.deepEqual(bad, [],
      `${bad.length} MongoClient(s) built without mongoClientOptions: ${bad.join(', ')}. The driver gives an options object precedence over `
      + 'the connection string, so an inline serverSelectionTimeoutMS / connectTimeoutMS / heartbeatFrequencyMS throws the operator\'s MONGO_URI '
      + 'figure away with no error. Build it as new MongoClient(uri, mongoClientOptions(uri, callerDefaults?)); a caller whose own figures differ '
      + 'passes them as callerDefaults, and the string still wins over those.');
  });

  it('every exemption names a client that exists and does not use the builder (a stale row fails)', () => {
    for (const [file, why] of EXEMPT) {
      assert.ok(why.length > 40, `${file}: the exemption must say why`);
      const here = found.filter(c => c.file === file);
      assert.ok(here.length > 0, `${file} is exempt but builds no MongoClient: remove the row`);
      assert.ok(here.every(c => !c.viaBuilder), `${file} is exempt but its client goes through ${OPTIONS_BUILDER}: remove the row`);
    }
  });
});
