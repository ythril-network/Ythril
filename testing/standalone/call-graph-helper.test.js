/**
 * `_call-graph.mjs` sees every call a body makes, wherever it is written — nested as an argument, in a chain, or in a
 * closure built at module scope.
 *
 * ## Why this has its own test (`Q-309`)
 *
 * Every derived gate over the server — the boot walk, the one-writer gate, the door derivations, the log gate — asks
 * this module what a function reaches. A call it does not see is an edge every one of those gates loses, silently: a
 * walk that misses an edge reports a SMALLER reachable set, and a smaller set passes every "nothing reaches X"
 * assertion written over it.
 *
 * Two holes were found from the outside, by gates written on top of it:
 *
 * - **A call nested as the first argument of another call was invisible.** The pattern `(^|[^.\w$])name\(` CONSUMES
 *   the character before a name, so in `f(g(x))` the match for `f(` eats the `(` that `g` needs as its prefix. Seen
 *   as `new Set(accessibleSpaces(req, 'write'))` reading as a route enforced by nothing, and confirmed on
 *   `callsIn('f(g(x)); h( k(1))')` answering `{f, h, k}`. The same consumed prefix sat in `memberCallsIn`,
 *   `referencesIn`, and in a hand copy in `_space-writers.mjs`.
 * - **A closure built at module scope was outside the graph.** `const _syncRunner = createCoalescingRunner({
 *   onQueued: (id) => log.debug(…) })` in the sync engine runs whenever `runSyncForNetwork` calls `_syncRunner.run`,
 *   and no key held it, so no walk could reach what it calls.
 *
 * The cases below pin the spellings, the offsets a positioned scan hands back (a gate reports a line from them), and
 * the module-scope walk on a fixture and on the real tree.
 *
 * Run: node --test testing/standalone/call-graph-helper.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  callsIn, callSitesIn, memberCallsIn, referencesIn, indexSources, moduleIndex, walkFrom, pathTo,
} from './_call-graph.mjs';

const names = set => [...set].sort();
const pairs = list => list.map(([o, p]) => `${o}.${p}`).sort();

describe('a call is seen wherever it is written', () => {
  it('a call nested as the first argument of another: f(g(x))', () => {
    assert.deepEqual(names(callsIn('{ f(g(x)); }')), ['f', 'g']);
  });

  it('a call nested four deep: a(b(c(d())))', () => {
    assert.deepEqual(names(callsIn('{ a(b(c(d()))); }')), ['a', 'b', 'c', 'd']);
  });

  it('a call inside a constructor argument: new Set(accessibleSpaces(req))', () => {
    assert.ok(callsIn('{ const s = new Set(accessibleSpaces(req, \'write\')); }').has('accessibleSpaces'));
  });

  it('a generic call nested in a generic call: f<A>(g<B>(x))', () => {
    assert.deepEqual(names(callsIn('{ f<A>(g<B>(x)); }')), ['f', 'g']);
  });

  it('a member call nested in a member call: a.b(c.d(e.f(1)))', () => {
    assert.deepEqual(pairs(memberCallsIn('{ a.b(c.d(e.f(1))); }')), ['a.b', 'c.d', 'e.f']);
  });

  it('a method chain: each link\'s argument calls are seen, the chain itself is not read as obj.prop', () => {
    const body = '{ items.filter(x => ok(x)).map(y => use(z.w(y))).forEach(log.debug); }';
    assert.deepEqual(names(callsIn(body, { closures: true })), ['ok', 'use']);
    assert.deepEqual(pairs(memberCallsIn(body, { closures: true })), ['items.filter', 'z.w']);
    assert.ok(!pairs(memberCallsIn(body, { closures: true })).includes('filter.map'),
      'a link of a chain is reached through a dot and must not be read as a receiver');
  });

  it('a promise chain hands on what it names: then(save).catch(warn)', () => {
    assert.deepEqual(names(referencesIn('{ p.then(save).catch(warn); }')), ['p', 'save', 'warn']);
  });

  it('a reference nested as an argument: f(g, h(k))', () => {
    const refs = referencesIn('{ f(g, h(k)); }');
    assert.ok(refs.has('g') && refs.has('k'), `references were ${names(refs)}`);
  });

  it('a declaration is still not a call, with the prefix no longer consumed', () => {
    const found = callsIn('{ async function main(x) { run(x); } function* gen() {} const v = function named() {}; }', { closures: true });
    assert.deepEqual(names(found), ['run']);
  });

  it('a dotted call is still not a bare call', () => {
    assert.deepEqual(names(callsIn('{ x.f(1); x?.g(2); }')), []);
  });
});

describe('a positioned scan points at the name it found', () => {
  const body = '{\n  const a = await f(g(1));\n  items.map(x => h(x));\n  async function inner() { k(); }\n}';

  for (const closures of [false, true]) {
    it(`every site's offset is its name, closures ${closures ? 'followed' : 'cut'}`, () => {
      const sites = callSitesIn(body, { closures });
      assert.ok(sites.length > 0, 'no call sites found');
      for (const s of sites) {
        assert.equal(body.slice(s.at, s.at + s.name.length), s.name, `site ${JSON.stringify(s)} does not point at its name`);
        assert.equal(body[s.paren], '(', `site ${JSON.stringify(s)} does not point at its bracket`);
      }
      assert.deepEqual(names(new Set(sites.map(s => s.name))), names(callsIn(body, { closures })),
        'callsIn and callSitesIn must answer the same question');
    });
  }

  it('cutting closures keeps every offset and every line where it was', () => {
    // The concise arrow `x => h(x)` stays, by `withoutNestedClosures`' own rule; the declared function's block goes.
    const cut = callSitesIn(body, { closures: false });
    assert.deepEqual(names(new Set(cut.map(s => s.name))), ['f', 'g', 'h']);
    const line = at => body.slice(0, at).split('\n').length;
    assert.deepEqual(cut.map(s => line(s.at)), [2, 2, 3]);
  });
});

describe('a closure built at module scope is followed', () => {
  const FIXTURE = new Map([
    ['src/runner.ts', [
      'import { report, quiet } from \'./report\';',
      'const _runner = createRunner({',
      '  onQueued: (id) => report(id),',
      '  onRerun: (id) => { quiet(id); },',
      '});',
      'const LIMIT = 10;',
      'export function run(id) {',
      '  return _runner.run(id, () => work(id));',
      '}',
      'function work(id) { return id; }',
      'function createRunner(opts) { return opts; }',
    ].join('\n')],
    ['src/report.ts', [
      'export function report(id) { return id; }',
      'export function quiet(id) { return id; }',
    ].join('\n')],
  ]);
  const index = indexSources(FIXTURE, { functionFloor: 1 });

  it('a module-scope binding whose initializer builds a closure is a key of its own', () => {
    assert.ok(index.bodies.has('src/runner.ts:_runner'), `keys: ${[...index.bodies.keys()].join(', ')}`);
    assert.ok(!index.bodies.has('src/runner.ts:LIMIT'), 'a binding with no closure in it is not a key');
  });

  it('a function that uses the binding reaches what its closures call, when the walk follows closures', () => {
    const { seen, parent } = walkFrom(index, ['src/runner.ts:run'], { closures: true });
    for (const k of ['src/runner.ts:_runner', 'src/report.ts:report', 'src/report.ts:quiet', 'src/runner.ts:work']) {
      assert.ok(seen.has(k), `${k} not reached; reached ${[...seen].join(', ')}`);
    }
    assert.deepEqual(pathTo(parent, 'src/report.ts:report'), ['src/runner.ts:run', 'src/runner.ts:_runner', 'src/report.ts:report']);
  });

  it('the walk of what one call does, once, is unchanged: it does not enter the binding', () => {
    const seen = walkFrom(index, ['src/runner.ts:run']).seen;
    assert.ok(!seen.has('src/runner.ts:_runner'), 'a walk that cuts closures must not follow a closure built elsewhere');
  });

  it('on the real tree: the sync engine reaches its coalescing runner\'s callbacks', () => {
    const real = moduleIndex('server/src');
    const ENGINE = 'server/src/sync/engine.ts';
    assert.ok(real.bodies.has(`${ENGINE}:_syncRunner`), `${ENGINE}:_syncRunner is not a key — re-anchor this case`);
    const { seen, parent } = walkFrom(real, [`${ENGINE}:runSyncForNetwork`], { closures: true });
    assert.ok(seen.has(`${ENGINE}:_syncRunner`), 'runSyncForNetwork does not reach the runner built at module scope');
    assert.equal(pathTo(parent, `${ENGINE}:_syncRunner`).at(-2), `${ENGINE}:runSyncForNetwork`);
  });
});
