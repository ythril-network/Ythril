/**
 * Every call of `tryMfaCode` reads its answer's `.ok` or `.reason` (Q-694, bundle-233).
 *
 * ## The defect it prevents
 *
 * `tryMfaCode` returns an OBJECT: `{ ok: true }`, `{ ok: false, reason: 'invalid' }` or `{ ok: false, reason: 'locked', ... }`. The old
 * verifier returned a boolean, and a site edited in haste keeps its shape: `if (!tryMfaCode(code, o)) { ...refuse }` is never true, because
 * an object is truthy - and the site then ACCEPTS EVERY CODE, a wrong one included, and no behaviour test of a different site notices. The
 * source is held, since the slip is one character and reads as a correct line.
 *
 * ## What it holds
 *
 * `api/mfa.ts` and `api/mfa-code-door.ts` each call `tryMfaCode(`, and the two doors that demand a code (`enforceMfa` in
 * `auth/middleware.ts`, the exemption grant in `api/tokens.ts`) each ask `mfaCodeHolds(` (the one sequence), so the three doors that verify a
 * code are all held. In any file
 * that calls it, outside `auth/code-attempts.ts`, every call (read as a syntax tree, so a comment is never a call) is either the object
 * of a `.ok`, `.reason` or `.key` access, or the initialiser of a `const`/`let` whose name is read through one of them somewhere in the
 * enclosing function. A bare `!tryMfaCode(...)`, `if (tryMfaCode(...))`, `tryMfaCode(...) &&` or an answer passed on unread is an
 * offender.
 *
 * ## Seen red
 *
 * On the base no site calls `tryMfaCode` (it does not exist). The scanner is also run over planted sources: `!tryMfaCode(` and the
 * others above are each offenders; the two correct shapes pass.
 *
 * Run: node --test testing/standalone/every-code-verify-site-reads-the-attempt-answer.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parseSource } from '../_shared/syntax-tree.mjs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

// `api/mfa-code-door.ts` is the one sequence that `enforceMfa` (`auth/middleware.ts`) and the exemption grant (`api/tokens.ts`) both stand at.
const SITES = ['server/src/api/mfa.ts', 'server/src/api/mfa-code-door.ts'];
const COUNTER = 'server/src/auth/code-attempts.ts';
/** A call, a member call on a namespace included: only for the "each door calls it" and "the scan holds something" counts. */
const CALL = /(?<![\w$])tryMfaCode\s*\(/g;
/** The members of the answer that say what it means. */
const READ = new Set(['ok', 'reason', 'key']);

/** Whether `call` is `tryMfaCode(...)` or `<namespace>.tryMfaCode(...)`. */
function isAttemptCall(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'tryMfaCode';
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 'tryMfaCode';
}

/**
 * `node` with the wrappers that do not change what an expression IS peeled off upwards (the list `unwrapExpression` in
 * `_shared/syntax-tree.mjs` peels downwards): the expression its parent sees.
 */
function outermost(node) {
  let n = node;
  const wraps = (p) => ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p)
    || ts.isSatisfiesExpression(p) || ts.isAwaitExpression(p);
  while (n.parent && wraps(n.parent)) n = n.parent;
  return n;
}

/** Whether `name` is read through `.ok`, `.reason` or `.key` anywhere inside `scope`. */
function readsMember(scope, name) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && READ.has(n.name.text) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** The nearest function body (or the file) around `node`: the scope a bound answer must be read in. */
function enclosingScope(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && n.body) return n.body;
    if (ts.isSourceFile(n)) return n;
  }
  return node.getSourceFile();
}

/** Descriptions of the calls in `source` whose answer is not read as an object. */
function unreadCalls(source) {
  const sf = parseSource('scan.ts', source);
  const bad = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && isAttemptCall(n)) {
      const used = outermost(n);
      const parent = used.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === used && READ.has(parent.name.text)) {
        // read at once
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === used && ts.isIdentifier(parent.name)) {
        if (!readsMember(enclosingScope(parent), parent.name.text)) {
          bad.push(`${parent.name.text} = tryMfaCode(...) is never read through .ok, .reason or .key`);
        }
      } else {
        bad.push(n.getText(sf).replace(/\s+/g, ' ').slice(0, 120));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

describe('every tryMfaCode call reads the object it answers', () => {
  it('the sites that verify a code each call tryMfaCode', () => {
    for (const site of SITES) {
      assert.ok(stripComments(readFileSync(site, 'utf8')).match(CALL), `${site} does not call tryMfaCode`);
    }
  });

  it('the two doors that demand a code stand at the one sequence, and neither calls the counter on its own', () => {
    for (const door of ['server/src/auth/middleware.ts', 'server/src/api/tokens.ts']) {
      const text = stripComments(readFileSync(door, 'utf8'));
      assert.match(text, /(?<![\w$])mfaCodeHolds\s*\(/, `${door} does not ask mfaCodeHolds`);
      assert.doesNotMatch(text, new RegExp(CALL.source), `${door} calls tryMfaCode itself: the lock, code and counter sequence is written twice again`);
    }
  });

  it('no call anywhere reads its answer as a boolean', () => {
    const files = trackedSources(['server/src'], { floor: 200, untracked: true }).filter(f => f !== COUNTER);
    const found = {};
    let calls = 0;
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      calls += (stripComments(text).match(CALL) ?? []).length;
      const bad = unreadCalls(text);
      if (bad.length) found[f] = bad;
    }
    assert.ok(calls >= SITES.length, `found ${calls} calls of tryMfaCode in the server: the scan holds nothing`);
    assert.deepEqual(found, {}, 'an object is truthy: `!tryMfaCode(...)` is never true and the site accepts every code. Read `.ok`.');
  });

  describe('the scanner sees the slip (planted copies)', () => {
    const wrong = {
      'a negated boolean read': 'if (!tryMfaCode(code, { tokenId, req })) { res.status(403).end(); return false; }',
      'a bare truthiness test': 'if (tryMfaCode(code, { tokenId, req })) { return true; }',
      'a conjunction': 'return code && tryMfaCode(code, { tokenId, req });',
      'an answer bound and never read': 'const answer = tryMfaCode(code, { tokenId, req });\nres.json(answer);',
      'a call inside a boolean helper': 'const valid = (c) => Boolean(tryMfaCode(c, { tokenId, req }));',
    };
    for (const [what, text] of Object.entries(wrong)) {
      it(`flags ${what}`, () => assert.equal(unreadCalls(text).length, 1, text));
    }
    const right = {
      'an immediate .ok': 'if (!tryMfaCode(code, { tokenId, req }).ok) { fail(); }',
      'an immediate .reason': "const locked = tryMfaCode(code, { tokenId, req }).reason === 'locked';",
      'a bound answer read through .ok': 'const attempt = tryMfaCode(code, { tokenId, req });\nif (!attempt.ok) { res.status(attempt.reason === \'locked\' ? 429 : 403).end(); }',
      'a typed bound answer': 'const attempt: Answer = tryMfaCode(code, { tokenId, req });\nif (attempt.ok) { next(); }',
    };
    for (const [what, text] of Object.entries(right)) {
      it(`passes ${what}`, () => assert.deepEqual(unreadCalls(text), [], text));
    }
    it('skips the import line and a comment that only names it', () => {
      assert.deepEqual(unreadCalls("import { tryMfaCode } from './code-attempts.js';\n// !tryMfaCode(x) was the old shape"), []);
    });
  });
});
