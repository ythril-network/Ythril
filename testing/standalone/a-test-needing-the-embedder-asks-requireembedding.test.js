/**
 * A test that needs the embedder asks `requireEmbedding` — never `if (!embeddingAvailable) return t.skip(...)`.
 *
 * ## The failure this prevents
 *
 * `requireEmbedding(t, available, why)` (`testing/_shared/embedding-required.mjs`) skips on a laptop and FAILS on
 * CI. The idiom it replaced, `if (!embeddingAvailable) return t.skip('embedding unavailable')`, skips on both: a
 * broken embedder on the one machine that gates merges turns every test behind a vector search into a skip, and
 * a skip is a pass in everything that reads the exit code. The module's own docblock says so and the spill tests
 * adopted it (`Q-92`); the rest of the stack suites (`recall-filter`, `mcp-tools`, `dupe-scanner`, `embed-properties`,
 * `find-similar-parity`, `recall-fresh-writes`, `dupe-detection` — some ninety sites) kept the copy, written
 * once per test, each of which can forget the CI half. This is a rule about the SET of them rather than the
 * ones noticed, so it derives them: every `if` in a test file whose branch skips and which speaks of the
 * embedder, in its condition or in the reason it gives.
 *
 * ## What counts, and what does not
 *
 * Counts: a branch that calls a skip (`t.skip`, `ctx.skip`) when the CONDITION names the embedder
 * (`embeddingAvailable`, `embedderReady`, …) or the REASON does ("embedding unavailable", "Embedding not
 * available", "Embedding server not configured") — the variable names differ between files, and the message is
 * what the author was thinking of. Does not: a skip that is not about the embedder (a missing MCP session is a
 * different rule), and the guard itself, `requireEmbedding`, which lives in the one file this scan leaves out.
 *
 * Run: node --test testing/standalone/a-test-needing-the-embedder-asks-requireembedding.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { testAndHelperFiles, calleeName, staticText } from './_test-bodies.mjs';
import { parseSource, lineOf, walkOwnCode } from '../_shared/syntax-tree.mjs';

const MODULE = 'testing/_shared/embedding-required.mjs';

/** Every `if` in `text` whose branch skips and which is about the embedder, and does not ask `requireEmbedding`. */
export function rawEmbeddingSkips(file, text) {
  const sf = parseSource(file, text);
  const found = [];
  const visit = (n) => {
    if (ts.isIfStatement(n)) {
      const asksTheGuard = walkOwnCode(n.expression, (x) => ts.isCallExpression(x) && calleeName(x) === 'requireEmbedding');
      const skips = [];
      for (const branch of [n.thenStatement, n.elseStatement]) {
        if (!branch) continue;
        walkOwnCode(branch, (x) => {
          if (ts.isCallExpression(x) && calleeName(x) === 'skip') skips.push(x);
          return false;
        });
      }
      if (!asksTheGuard && skips.length > 0) {
        const aboutTheEmbedder = /embed/i.test(n.expression.getText())
          || skips.some(c => /embed/i.test(c.arguments[0] ? (staticText(c.arguments[0]) ?? c.arguments[0].getText()) : ''));
        if (aboutTheEmbedder) found.push({ line: lineOf(sf, n), cond: n.expression.getText().slice(0, 60) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('what the detector reads as the raw idiom', () => {
  const RAW = [
    ["the one-liner", "it('x', async (t) => { if (!embeddingAvailable) return t.skip('embedding unavailable'); assert.ok(1); });"],
    ["with more in the condition", "it('x', async (t) => { if (!embeddingAvailable || !sourceId) return t.skip('embedding unavailable'); });"],
    ["a different variable, the reason names the embedder", "it('x', async (t) => { if (!ready) return t.skip('embedding unavailable'); });"],
    ["a block with the skip and a return", "it('x', async (t) => { if (!embeddingAvailable) { t.skip('Embedding not available'); return; } });"],
    ["the stack's own wording", "it('x', async (t) => { if (!seeded) return t.skip('Embedding server not configured in test stack — skipping'); });"],
    ["inside a helper the tests call", "function ready(t) { if (!embeddingAvailable) { t.skip('no embedder'); return false; } return true; }"],
  ];
  for (const [name, code] of RAW) {
    it(`finds it — ${name}`, () => {
      assert.equal(rawEmbeddingSkips('x.test.js', code).length, 1, `not found in: ${code}`);
    });
  }

  it('leaves the guard and unrelated skips alone', () => {
    const fine = [
      "it('x', async (t) => { if (!requireEmbedding(t, embeddingAvailable, 'embedding unavailable')) return; assert.ok(1); });",
      "it('x', async (t) => { if (!session) return t.skip('MCP session unavailable'); });",
      "it('x', async (t) => { if (!lanIp) { t.skip('no non-loopback IPv4'); return; } });",
      "it('x', async (t) => { if (embeddingAvailable) { assert.ok(1); } });",
    ];
    for (const code of fine) assert.deepEqual(rawEmbeddingSkips('x.test.js', code), [], `wrongly found in: ${code}`);
  });
});

describe('every test that needs the embedder asks the one guard', () => {
  const files = testAndHelperFiles().filter(f => f.file !== MODULE);

  it('the scan sees the tests and the guard has callers (floors)', () => {
    assert.ok(files.length >= 800, `only ${files.length} files scanned — the listing is broken`);
    const users = files.filter(f => /\brequireEmbedding\s*\(/.test(f.text));
    assert.ok(users.length >= 3, `only ${users.length} file(s) call requireEmbedding — the guard is no longer the way`);
  });

  it('no file carries the raw skip', () => {
    const found = [];
    for (const f of files) {
      for (const h of rawEmbeddingSkips(f.file, f.text)) found.push(`${f.file}:${h.line}  if (${h.cond}) … skip`);
    }
    assert.deepEqual(found, [],
      `${found.length} raw embedder skip(s). On CI each turns a broken embedder into a green run. Use `
      + '`if (!requireEmbedding(t, available, why)) return;` — it skips locally and fails on CI:\n  ' + found.join('\n  '));
  });
});
