/**
 * No promise chain written by hand serves as a lock anywhere in `server/src`: "one at a time, in the order they asked" is
 * `keyedLock` (`util/keyed-lock.ts`), and `config/loader.ts`'s two serialisers go through it (bundle-71, Q-408).
 *
 * ## The defect
 *
 * `keyedLock` was extracted at its second and third callers, and `config/loader.ts` still held two hand-written copies of the
 * same chain — `_reloadChain = _reloadChain.catch(…).then(…)` for the config watcher and `_flushChain = _flushChain.catch(…).then(…)`
 * for the coalesced flush. Each had to remember what the module puts inside: that a failure of one run must not stop the next, and
 * that the tail of the chain never rejects. The module's own docblock says what a copy drops; these two kept it by being careful.
 *
 * ## How a hand-written lock is SEEN
 *
 * Read out of the syntax tree of every tracked file under `server/src` (never from a list of names):
 *   - **a self-chain**: an assignment whose right side is a `.then` / `.catch` / `.finally` chain rooted at the very place it assigns
 *     (`tail = tail.then(…)`, `this.q = this.q.catch(…).then(…)`), which is a queue held in a variable;
 *   - **a keyed tail**: a `<map>.set(key, <chain>)` whose chain is rooted at a value just read from the same map
 *     (`const prior = tails.get(key) …; tails.set(key, prior.then(…))`), which is the per-key form of the same queue.
 * `util/keyed-lock.ts` is the one file allowed to spell either: it is the module.
 *
 * ## Seen red
 *
 * On the base the scan finds two: `config/loader.ts` `_reloadChain` and `_flushChain`.
 *
 * Run: node --test testing/standalone/no-hand-written-promise-chain-is-a-lock.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { ts, parseSource, lineOf } from '../_shared/syntax-tree.mjs';

const THE_MODULE = 'server/src/util/keyed-lock.ts';
const CHAIN_LINKS = new Set(['then', 'catch', 'finally']);

/** The receiver a `.then` / `.catch` / `.finally` chain starts from, or `undefined` when the expression is not such a chain. */
function chainRoot(e) {
  let cur = e;
  let linked = false;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression) && CHAIN_LINKS.has(cur.expression.name.text)) {
    cur = cur.expression.expression;
    linked = true;
  }
  return linked ? cur : undefined;
}

/** The nearest enclosing function-like node of `node`. */
function enclosingFunction(node) {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n;
  return undefined;
}

/** The initialiser of the variable `name` declared in `fn`, or `undefined`. */
function initializerOf(fn, name) {
  let init;
  const visit = (n) => {
    if (init !== undefined) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) init = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(fn);
  return init;
}

/** The text of the map a variable was read from (`const prior = tails.get(key) ?? …` gives `tails`), looked up in `fn`. */
function mapReadInto(fn, name, sf) {
  let init = initializerOf(fn, name);
  while (init && ts.isBinaryExpression(init)) init = init.left;       // `x ?? fallback`
  return init && ts.isCallExpression(init) && ts.isPropertyAccessExpression(init.expression) && init.expression.name.text === 'get'
    ? init.expression.expression.getText(sf) : undefined;
}

/** Every hand-written lock in `text`: `{ line, shape }`. Never reads a name, only the shape. */
export function handWrittenLocks(file, text) {
  const sf = parseSource(file, text);
  const found = [];
  const visit = (n) => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const root = chainRoot(n.right);
      if (root && root.getText(sf) === n.left.getText(sf)) found.push({ line: lineOf(sf, n), shape: `${n.left.getText(sf)} = ${n.left.getText(sf)}.then(…)` });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'set' && n.arguments.length === 2) {
      const fn = enclosingFunction(n);
      // The tail may be written inline or through a named constant (`const tail = prior.then(…); tails.set(key, tail)`).
      const written = ts.isIdentifier(n.arguments[1]) && fn ? (initializerOf(fn, n.arguments[1].text) ?? n.arguments[1]) : n.arguments[1];
      const root = chainRoot(written);
      if (root && ts.isIdentifier(root) && fn && mapReadInto(fn, root.text, sf) === n.expression.expression.getText(sf)) {
        found.push({ line: lineOf(sf, n), shape: `${n.expression.expression.getText(sf)}.set(key, ${root.text}.then(…))` });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('the detector sees the shapes it is about, and only those', () => {
  const seen = (src) => handWrittenLocks('probe.ts', src).length;

  it('sees a self-chain, a property self-chain and a keyed tail', () => {
    assert.equal(seen('let q = Promise.resolve(); function a() { q = q.catch(() => {}).then(() => work()); }'), 1);
    assert.equal(seen('class A { q = Promise.resolve(); a() { this.q = this.q.then(() => work()); } }'), 1);
    assert.equal(seen('const tails = new Map(); function a(k) { const prior = tails.get(k) ?? Promise.resolve(); tails.set(k, prior.then(() => work())); }'), 1);
  });

  it('does not see a chain that is a plain pipeline, or a map written from something else', () => {
    assert.equal(seen('let a, b; function f() { a = b.then(() => 1); }'), 0);
    assert.equal(seen('const m = new Map(); function f(k, p) { m.set(k, p.then(() => 1)); }'), 0);
    assert.equal(seen('function f() { const settled = Promise.resolve().then(() => 1); return settled; }'), 0);
  });

  it('sees the module\'s own shape, a tail written through a named constant, which is why it is the one exemption', () => {
    const text = 'const tails = new Map(); function run(k) { const prior = tails.get(k) ?? Promise.resolve(); const tail = prior.then(() => 1); tails.set(k, tail); }';
    assert.equal(seen(text), 1);
    const real = readTrackedSources('server/src', { floor: 100 }).find(s => s.file === THE_MODULE);
    assert.ok(real, `${THE_MODULE} is not among the tracked sources`);
    assert.equal(handWrittenLocks(real.file, real.text).length, 1, 'the module is where the shape lives: a detector that cannot see it sees nothing');
  });
});

describe('no hand-written promise chain is a lock', () => {
  const sources = readTrackedSources('server/src', { floor: 100 });

  it('outside util/keyed-lock.ts, none remains', () => {
    const found = sources.filter(s => s.file !== THE_MODULE)
      .flatMap(s => handWrittenLocks(s.file, s.text).map(h => `${s.file}:${h.line}  ${h.shape}`));
    assert.deepEqual(found, [], 'a promise chain held in a variable is a lock written by hand: use keyedLock (util/keyed-lock.ts)');
  });

  it('keyedLock has callers outside its own file, and the config loader is one of them (the floor: the scan found something to say about)', () => {
    const callers = sources.filter(s => s.file !== THE_MODULE && /\bkeyedLock\(\)/.test(s.text)).map(s => s.file);
    assert.ok(callers.length >= 1, `nothing outside ${THE_MODULE} calls keyedLock(): the scan is blind or the module is dead`);
    assert.ok(callers.includes('server/src/config/loader.ts'), `config/loader.ts does not take its serialisers from keyedLock (callers: ${callers.join(', ')})`);
  });
});
