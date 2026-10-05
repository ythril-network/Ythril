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
    assert.ok(src.startsWith('after', after.at), 'the offset does not point at the real body');
    assert.ok(!names(sites).includes('hidden'), 'a cut closure\'s call must not be seen when closures are cut');
  });
});

describe('a member call is positioned like a bare one', () => {
  const body = '{\n  a.b(c.d(1));\n  x?.y(2);\n  q . r (3);\n  z.w.v(4);\n  run(() => { hidden.call(5); });\n  after.go(6);\n}';

  for (const closures of [false, true]) {
    it(`every site's offset is its receiver and its bracket is a bracket, closures ${closures ? 'followed' : 'cut'}`, () => {
      const sites = memberCallSitesIn(body, { closures });
      assert.ok(sites.length > 0, 'no member call sites found');
      for (const s of sites) {
        assert.equal(body.slice(s.at, s.at + s.obj.length), s.obj, `site ${JSON.stringify(s)} does not point at its receiver`);
        assert.equal(body[s.paren], '(', `site ${JSON.stringify(s)} does not point at its bracket`);
        assert.match(body.slice(s.at, s.paren), new RegExp(`^${s.obj}\\s*\\??\\.\\s*${s.prop}\\s*$`), `site ${JSON.stringify(s)} spans more than its own call`);
      }
    });
  }

  it('optional chaining and spaced dots count, a longer chain z.w.v() is not read as its tail w.v(), and a cut closure keeps the offsets after it', () => {
    const cut = memberCallSitesIn(body, { closures: false });
    assert.deepEqual(names(cut), ['a.b', 'after.go', 'c.d', 'q.r', 'x.y']);
    const line = at => body.slice(0, at).split('\n').length;
    assert.equal(line(cut.find(s => s.obj === 'after').at), 7, 'a call after a cut closure moved lines');
    assert.ok(names(memberCallSitesIn(body, { closures: true })).includes('hidden.call'), 'a followed closure\'s member call was not seen');
  });
});

describe('what is not a call is not a site', () => {
  // The words that sit before a bracket and are statements or operators. Written out because it is the FIXTURE: the
  // scan must answer "no call" for each of them, whichever way its own exclusion list is spelled.
  const KEYWORDS = ['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'yield', 'delete', 'void', 'throw', 'case', 'instanceof'];

  it('a keyword before a bracket is no call, and the real call beside it still is', () => {
    const body = `{ ${KEYWORDS.map(k => `${k} (x);`).join(' ')} real(1); }`;
    assert.deepEqual(names(callSitesIn(body)), ['real']);
  });

  it('a constructor call is a call to the constructor, and `new` itself is not one', () => {
    assert.deepEqual(names(callSitesIn('{ const s = new Set(items); }')), ['Set']);
  });

  it('a `foo(` written inside a string literal is not a call', () => {
    const body = '{ log(\'foo(1)\'); throw new Error("call bar(req) first"); }';
    assert.deepEqual(names(callSitesIn(body)), ['Error', 'log']);
    assert.deepEqual(names(memberCallSitesIn('{ log(\'a.b(1)\'); real.go(2); }')), ['real.go']);
  });

  it('a template literal\'s text is blanked and its interpolation is not: `text foo(1) ${baz(2)}`', () => {
    const body = '{ const s = `text foo(1) ${baz(2)} and ${ wrap({ k: `inner qux(3) ${deep(4)}` }) }`; }';
    assert.deepEqual(names(callSitesIn(body)), ['baz', 'deep', 'wrap']);
  });

  it('blanking a literal keeps every offset after it', () => {
    const body = '{ log(\'a long message with foo(1) inside it\'); after(2); }';
    const found = callSitesIn(body).find(s => s.name === 'after');
    assert.ok(found, 'after() was not found');
    assert.ok(body.startsWith('after', found.at), 'the offset does not point at the real body');
  });

  it('a lone quote (a regular expression\'s) does not hide the call after it on the same line', () => {
    assert.deepEqual(names(callSitesIn('{ const re = /\'/; real(1); }')), ['real']);
  });

  it('a call written in a comment is no site once the comment is stripped, which is how the index hands a body over', async () => {
    const { stripComments } = await import('./_strip-comments.mjs');
    const body = stripComments('{\n  // old(1)\n  /* older(2) */\n  real(3); // trailing(4)\n}');
    assert.deepEqual(names(callSitesIn(body)), ['real']);
  });
});

describe('callsIn and memberCallsIn keep the spelling the call-graph gates were written against', () => {
  // These pin what the release line's other gates read: re-pointing the pair at the lookbehind patterns would change
  // the edges of every one of them, so a change here is a decision and not a side effect.
  const { callsIn, memberCallsIn } = graph;

  it('callsIn: the consumed prefix hides a call written as the first argument of another, and the positioned scan does not', () => {
    const body = '{ f(g(x)); h(1); }';
    assert.deepEqual([...callsIn(body)].sort(), ['f', 'h']);
    assert.deepEqual(names(callSitesIn(body)), ['f', 'g', 'h']);
  });

  it('callsIn: a literal is read as text, a cut closure is not, a followed one is', () => {
    const body = '{ log(\'foo(1)\'); run(() => { hidden(); }); after(2); }';
    assert.deepEqual([...callsIn(body)].sort(), ['after', 'foo', 'log', 'run']);
    assert.deepEqual([...callsIn(body, { closures: true })].sort(), ['after', 'foo', 'hidden', 'log', 'run']);
  });

  it('memberCallsIn: the same consumed prefix, optional chaining, and a longer chain not read as its tail', () => {
    const body = '{ a.b(c.d(e.f(1))); x.y(1); x.y(2); z?.w(3); a.b.c(4); }';
    assert.deepEqual(memberCallsIn(body).map(([o, p]) => `${o}.${p}`).sort(), ['a.b', 'e.f', 'x.y', 'z.w']);
  });
});
