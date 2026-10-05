/**
 * `_call-graph.mjs`'s POSITIONED scans (`callSitesIn`, `memberCallSitesIn`) see every call a body makes, wherever it
 * is written, and say where.
 *
 * ## Why this has its own test (`Q-309`, carried to 5.6.x for `Q-304`'s derived gate)
 *
 * `an-iterates-row-loops-at-its-rung.test.js` asks the call graph which rung each `iterates` handler's space loop
 * runs at. The pattern `(^|[^.\w$])name\(` CONSUMES the character before a name, so in `f(g(x))` the match for `f(`
 * eats the `(` that `g` needs as its prefix: `new Set(accessibleSpaces(req, 'write'))` showed the scan no call at
 * all, and `POST /api/duplicates/scan` read as enforced by nothing. A call the scan does not see is an edge every
 * gate built on the module loses, silently — and a smaller reachable set passes every "nothing reaches X" assertion.
 *
 * The positioned scans match by lookbehind and hand back OFFSETS INTO THE BODY, so a gate can read the arguments of
 * the call it found. Cutting a nested closure keeps every offset (blanks, not a shorter stub).
 *
 * `callsIn` keeps its old spelling on the release line: re-pointing it would change the edges of every call-graph
 * gate, which a patch does not do.
 *
 * Run: node --test testing/standalone/a-call-site-scan-sees-a-call-wherever-it-is-written.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as graph from './_call-graph.mjs';

const { callSitesIn, memberCallSitesIn } = graph;
const names = sites => [...new Set(sites.map(s => s.name ?? `${s.obj}.${s.prop}`))].sort();

describe('the positioned scans exist and see a call written as an argument', () => {
  it('the helper exports both scans', () => {
    assert.equal(typeof callSitesIn, 'function', '_call-graph.mjs does not export callSitesIn');
    assert.equal(typeof memberCallSitesIn, 'function', '_call-graph.mjs does not export memberCallSitesIn');
  });

  it('a call nested as the first argument of another: f(g(x))', () => {
    assert.deepEqual(names(callSitesIn('{ f(g(x)); }')), ['f', 'g']);
  });

  it('a call inside a constructor argument: new Set(accessibleSpaces(req, \'write\'))', () => {
    assert.ok(names(callSitesIn('{ const s = new Set(accessibleSpaces(req, \'write\')); }')).includes('accessibleSpaces'));
  });

  it('a call nested four deep: a(b(c(d())))', () => {
    assert.deepEqual(names(callSitesIn('{ a(b(c(d()))); }')), ['a', 'b', 'c', 'd']);
  });

  it('a member call nested in a member call: a.b(c.d(e.f(1)))', () => {
    assert.deepEqual(names(memberCallSitesIn('{ a.b(c.d(e.f(1))); }')), ['a.b', 'c.d', 'e.f']);
  });

  it('a declaration is not a call, and a dotted call is not a bare one', () => {
    const found = callSitesIn('{ async function main(x) { run(x); } function* gen() {} x.f(1); x?.g(2); }', { closures: true });
    assert.deepEqual(names(found), ['run']);
  });
});

describe('a positioned scan points at the name it found', () => {
  const body = '{\n  const a = await f(g(1));\n  items.map(x => h(x));\n  async function inner() { k(); }\n}';

  for (const closures of [false, true]) {
    it(`every site's offset is its name and its bracket is a bracket, closures ${closures ? 'followed' : 'cut'}`, () => {
      const sites = callSitesIn(body, { closures });
      assert.ok(sites.length > 0, 'no call sites found');
      for (const s of sites) {
        assert.equal(body.slice(s.at, s.at + s.name.length), s.name, `site ${JSON.stringify(s)} does not point at its name`);
        assert.equal(body[s.paren], '(', `site ${JSON.stringify(s)} does not point at its bracket`);
      }
    });
  }

  it('cutting a closure keeps every offset and every line where it was', () => {
    // The concise arrow `x => h(x)` stays by `withoutNestedClosures`' own rule; the declared function's block goes.
    const cut = callSitesIn(body, { closures: false });
    assert.deepEqual(names(cut), ['f', 'g', 'h']);
    const line = at => body.slice(0, at).split('\n').length;
    assert.deepEqual(cut.map(s => line(s.at)), [2, 2, 3]);
  });

  it('a call AFTER a cut closure is still found at its true offset', () => {
    const src = '{ run(() => { hidden(); }); after(1); }';
    const sites = callSitesIn(src);
    const after = sites.find(s => s.name === 'after');
    assert.ok(after, `after() not found among ${names(sites)}`);
    assert.equal(src.slice(after.at, after.at + 5), 'after', 'the offset does not point at the real body');
    assert.ok(!names(sites).includes('hidden'), 'a cut closure\'s call must not be seen when closures are cut');
  });
});
