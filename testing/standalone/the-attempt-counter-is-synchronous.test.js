/**
 * `auth/code-attempts.ts` holds no `await` and no `async` (Q-694, bundle-233).
 *
 * ## The defect it prevents
 *
 * The counter's lock check, the verifier and the record of a wrong code are three steps that must not be pulled apart. Node runs one
 * synchronous stretch to its end, so as long as nothing between them yields, two requests carrying wrong codes cannot both pass the
 * check at 4 failures and both be recorded as the 5th: the sixth guess a lock was meant to stop. One `await` between the steps (a lock
 * kept in a store, an audit write awaited before the record, a promise returned) opens that gap, and no behaviour test finds it: the race
 * needs two requests in the same tick.
 *
 * ## What it holds
 *
 * In the comment- and string-stripped source of `server/src/auth/code-attempts.ts`: no `await`, no `async`, no `.then(`, no
 * `new Promise`, no `import(`. The audit write of a lock start is called without being awaited (`logAuditEntry` is fire-and-forget).
 *
 * ## Seen red
 *
 * On the base the file does not exist. The scanner is also run over planted copies (an async function, an await, a `.then`, a promise,
 * a dynamic import): each is flagged, and a comment that says "await" is not.
 *
 * Run: node --test testing/standalone/the-attempt-counter-is-synchronous.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const FILE = 'server/src/auth/code-attempts.ts';
const YIELD = /\b(?:await|async)\b|\.then\s*\(|\bnew\s+Promise\b|\bimport\s*\(/g;

/** What in `source` could yield between the lock check and the record, strings and comments set aside. */
function yields(source) {
  const code = stripComments(source)
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
  return [...code.matchAll(YIELD)].map(m => m[0].trim());
}

describe('the attempt counter yields nowhere', () => {
  it('server/src/auth/code-attempts.ts exists', () => {
    assert.ok(existsSync(FILE), `${FILE} does not exist`);
  });

  it('holds no await, async, .then, new Promise or dynamic import', () => {
    assert.deepEqual(yields(readFileSync(FILE, 'utf8')), [],
      'a yield between the check, the verify and the record lets two requests both pass the check at 4 failures');
  });

  describe('the scanner sees a yield (planted copies)', () => {
    const planted = {
      'an async function': 'export async function tryMfaCode() { return { ok: true }; }',
      'an await': 'const row = await store.get(key);',
      'a then': 'return audit().then(() => result);',
      'a promise': 'return new Promise(resolve => resolve(result));',
      'a dynamic import': "const m = await import('./x.js');",
    };
    for (const [what, text] of Object.entries(planted)) {
      it(`flags ${what}`, () => assert.ok(yields(text).length >= 1, text));
    }
    it('ignores a comment and a string that say await', () => {
      assert.deepEqual(yields("// no await here\n/* async */ const m = 'await the lock'; log.warn(`async ${m}`);"), []);
    });
  });
});
