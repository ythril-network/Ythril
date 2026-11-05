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
 * `api/mfa.ts`, `api/tokens.ts` and `auth/middleware.ts` each call `tryMfaCode(` (the three doors that verify a code), and in any file
 * that calls it, outside `auth/code-attempts.ts`, every call (comments stripped, the call's own parentheses matched) is either followed
 * at once by `.ok`, `.reason` or `.key`, or is the initialiser of a `const`/`let` whose name is then read with one of them within the
 * next 1200 characters. A bare `!tryMfaCode(...)`, `if (tryMfaCode(...))`, `tryMfaCode(...) &&` or an answer passed on unread is an
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
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const SITES = ['server/src/api/mfa.ts', 'server/src/api/tokens.ts', 'server/src/auth/middleware.ts'];
const COUNTER = 'server/src/auth/code-attempts.ts';
/** A call, a member call on a namespace included. */
const CALL = /(?<![\w$])tryMfaCode\s*\(/g;

/** The index just past the `)` that closes the one opened at `open`, or -1. */
function closeOf(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Descriptions of the calls in `source` whose answer is not read as an object. */
function unreadCalls(source) {
  const code = stripComments(source);
  const bad = [];
  for (const m of code.matchAll(CALL)) {
    const before = code.slice(Math.max(0, m.index - 80), m.index);
    if (/function\s*$/.test(before)) continue; // a declaration, not a call
    const end = closeOf(code, m.index + m[0].length - 1);
    if (end < 0) { bad.push(`unbalanced call at ${m.index}`); continue; }
    const after = code.slice(end, end + 200);
    if (/^\s*\??\.(?:ok|reason|key)\b/.test(after)) continue;
    const bound = /(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*$/.exec(before.replace(/\s+/g, ' '));
    if (bound) {
      const name = bound[1];
      const rest = code.slice(end, end + 1200);
      if (new RegExp(`\\b${name}\\s*\\??\\.(?:ok|reason|key)\\b`).test(rest)) continue;
      bad.push(`${name} = tryMfaCode(...) is never read through .ok, .reason or .key`);
      continue;
    }
    bad.push(`${code.slice(Math.max(0, m.index - 12), end + 12).replace(/\s+/g, ' ')}`);
  }
  return bad;
}

describe('every tryMfaCode call reads the object it answers', () => {
  it('the three doors that verify a code each call tryMfaCode', () => {
    for (const site of SITES) {
      assert.ok(stripComments(readFileSync(site, 'utf8')).match(CALL), `${site} does not call tryMfaCode`);
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
    assert.ok(calls >= 3, `found ${calls} calls of tryMfaCode in the server: the scan holds nothing`);
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
