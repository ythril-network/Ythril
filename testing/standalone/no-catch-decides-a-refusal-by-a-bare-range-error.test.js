/**
 * No catch decides "the caller's refusal" by a bare `instanceof RangeError` (Q-458, rev 3.1).
 *
 * ## The defect
 *
 * Our refusals are the typed class `RequestRefusal` (`util/errors.ts`). The runtime throws `RangeError` too (an invalid `Buffer`
 * length, an out-of-range offset, a stack overflow), so a catch that reads ANY `RangeError` as "the caller's path leaves the space"
 * turns a fault of the server into a document refused as the peer's fault: a pulled page refuses the row (the sender is told, or logs,
 * a shape violation that is ours), a tombstone is refused instead of the page failing and being retried. The two sites that did it
 * were `sync/arrivals.ts` (`fileKeyRefusal`) and `files/peer-tombstone-apply.ts` (`admit`); `no-answer-carries-a-caught-message` holds
 * the same convention for what an ANSWER says, and this holds it for what a catch DECIDES.
 *
 * ## The rule
 *
 * Every `x instanceof RangeError` in `server/src` guards a RETHROW (`if (x instanceof RangeError) throw x`, which passes a refusal
 * on unchanged and says nothing about its class). Any other use asks the older question, which the runtime answers "yes" too.
 * The set is derived from the tracked sources, and a floor holds that the rethrow shape was found, so an empty sweep is not a pass.
 *
 * Run: node --test testing/standalone/no-catch-decides-a-refusal-by-a-bare-range-error.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ts, parseSource, lineOf, unwrapExpression, walkEveryNode } from '../_shared/syntax-tree.mjs';
import { readTrackedSources } from './_sources.mjs';

/** Every `x instanceof RangeError` in `text` as `{ line, rethrows }`: whether the `if` it guards only passes the caught value on. */
export function rangeErrorChecksIn(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.InstanceOfKeyword) return;
    if (!ts.isIdentifier(n.right) || n.right.text !== 'RangeError') return;
    const subject = unwrapExpression(n.left);
    // The `if` this check is the condition of, if any (a check in an `||` chain is still a decision about the class).
    let ifs = null;
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isIfStatement(p) && p.expression.pos <= n.pos && n.end <= p.expression.end) { ifs = p; break; }
      if (ts.isStatement(p)) break;
    }
    let rethrows = false;
    if (ifs) {
      const stmts = ts.isBlock(ifs.thenStatement) ? ifs.thenStatement.statements : [ifs.thenStatement];
      rethrows = stmts.length === 1 && ts.isThrowStatement(stmts[0]) && !!stmts[0].expression
        && ts.isIdentifier(stmts[0].expression) && ts.isIdentifier(subject) && stmts[0].expression.text === subject.text;
    }
    out.push({ file, line: lineOf(sf, n), rethrows });
  });
  return out;
}

const SOURCES = readTrackedSources('server/src', { specs: false, floor: 200 });
const ALL = SOURCES.flatMap(({ file, text }) => rangeErrorChecksIn(file, text));

describe('no catch decides a refusal by a bare `instanceof RangeError`', () => {
  it('the sweep found the rethrow shape, so it is about something', () => {
    assert.ok(ALL.some(c => c.rethrows), 'no `if (x instanceof RangeError) throw x` was found — the sweep never matched its own allowed shape');
  });

  it('every `instanceof RangeError` in server/src only rethrows', () => {
    assert.deepEqual(ALL.filter(c => !c.rethrows).map(c => `${c.file}:${c.line}`), [],
      'the runtime throws RangeError too: ask for RequestRefusal (util/errors.ts), and treat any other RangeError as the fault it is');
  });

  describe('the rule, not its spelling', () => {
    const judge = (body) => rangeErrorChecksIn('fixture.ts', `function f() { try { w(); } catch (err) { ${body} } }`);
    it('a rethrow is allowed; a decision, a ternary and an || chain are not', () => {
      assert.deepEqual(judge('if (err instanceof RangeError) throw err;').map(c => c.rethrows), [true]);
      assert.deepEqual(judge('if (err instanceof RangeError) { throw err; }').map(c => c.rethrows), [true]);
      assert.deepEqual(judge("if (err instanceof RangeError) return 'path leaves the space'; throw err;").map(c => c.rethrows), [false]);
      assert.deepEqual(judge("const why = err instanceof RangeError ? 'refused' : 'fault';").map(c => c.rethrows), [false]);
      assert.deepEqual(judge('if (err instanceof PathBlocked || err instanceof RangeError) { throw err; }').map(c => c.rethrows), [true]);
      assert.deepEqual(judge('if (err instanceof RequestRefusal) return 1;'), []);
    });
  });
});
