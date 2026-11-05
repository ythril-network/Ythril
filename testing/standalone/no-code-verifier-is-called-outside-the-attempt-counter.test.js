/**
 * Nothing in `server/src` asks the code verifier except the attempt counter that wraps it (Q-694, bundle-233).
 *
 * ## The defect it prevents
 *
 * The lockout lives in `auth/code-attempts.ts`: `tryMfaCode` checks the lock, asks the verifier, records a wrong code. A fourth verify
 * site that calls `verifyMfaCode` (or `judgeMfaCode`) directly is a door with no count - the unlimited guessing the lockout exists to end -
 * and it passes every behaviour test of the three sites that DO count. One wrapper plus this gate is what cannot be bypassed by forgetting.
 *
 * ## What it holds
 *
 * Outside `auth/code-attempts.ts` and `auth/totp.ts` (comments stripped), no source names `judgeMfaCode` or `verifyMfaCode` in any way:
 * not a call, not an import, an aliased import (`verifyMfaCode as v`), a member call (`totp.verifyMfaCode(`), a destructure, a re-export,
 * a quoted property or a dynamic import of it; and no namespace import of `totp.js`, which would reach the verifier without its name.
 * `code-attempts.ts` does call `judgeMfaCode`, and `totp.ts` exports it: the one path exists, so the rule is not holding over nothing.
 *
 * ## Seen red
 *
 * On the base `api/mfa.ts`, `api/tokens.ts` and `auth/middleware.ts` call `verifyMfaCode`, and `judgeMfaCode` does not exist. The scanner
 * is also run over planted sources (an alias, a member call, a namespace import, a dynamic import, a re-export): each is an offender.
 *
 * Run: node --test testing/standalone/no-code-verifier-is-called-outside-the-attempt-counter.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const ALLOWED = new Set(['server/src/auth/code-attempts.ts', 'server/src/auth/totp.ts']);
const VERIFIER = /\b(?:judgeMfaCode|verifyMfaCode)\b/;
const NAMESPACE = /import\s*\*\s*as\s+\w+\s+from\s*['"][^'"]*\/totp(?:\.js)?['"]/;

/** The paths among `{ path: text }` that reach the verifier, other than the two that may. */
function offenders(sources) {
  return Object.entries(sources)
    .filter(([path]) => !ALLOWED.has(path))
    .filter(([, text]) => { const code = stripComments(text); return VERIFIER.test(code) || NAMESPACE.test(code); })
    .map(([path]) => path)
    .sort();
}

describe('only the attempt counter asks the code verifier', () => {
  const files = trackedSources(['server/src'], { floor: 200, untracked: true });
  const sources = Object.fromEntries(files.map(f => [f, readFileSync(f, 'utf8')]));

  it('the scan reads the server and the one allowed path exists', () => {
    assert.ok(files.length >= 200, `found ${files.length} server sources`);
    assert.ok(files.includes('server/src/auth/code-attempts.ts'), 'server/src/auth/code-attempts.ts does not exist');
    assert.match(stripComments(sources['server/src/auth/code-attempts.ts'] ?? ''), /\bjudgeMfaCode\(/, 'the counter does not call judgeMfaCode');
    assert.match(stripComments(sources['server/src/auth/totp.ts']), /export function judgeMfaCode\(/, 'totp.ts does not export judgeMfaCode');
  });

  it('no other source names judgeMfaCode or verifyMfaCode, or imports totp as a namespace', () => {
    assert.deepEqual(offenders(sources), [],
      'these reach the code verifier without the attempt counter: call tryMfaCode (auth/code-attempts.ts) and read its `.ok`');
  });

  describe('the scanner sees what a careless site would write (planted copies)', () => {
    const planted = {
      'an aliased import': "import { verifyMfaCode as check } from '../auth/totp.js';\nif (!check(code)) fail();",
      'a member call on a namespace': "import * as totp from '../auth/totp.js';\ntotp.verifyMfaCode(code);",
      'a namespace import alone': "import * as t from './totp.js';\nconst f = t['ver' + 'ify'];",
      'a dynamic import': "const { judgeMfaCode } = await import('../auth/totp.js');",
      'a quoted property': "const verify = mod['verifyMfaCode'];",
      'a re-export': "export { verifyMfaCode } from './totp.js';",
      'a plain call': "if (!verifyMfaCode(code)) { res.status(403).end(); }",
    };
    for (const [what, text] of Object.entries(planted)) {
      it(`flags ${what}`, () => assert.deepEqual(offenders({ 'server/src/api/planted.ts': text }), ['server/src/api/planted.ts']));
    }
    it('passes the counter, the verifier and a comment that only names it', () => {
      assert.deepEqual(offenders({
        'server/src/auth/code-attempts.ts': 'judgeMfaCode(code)',
        'server/src/auth/totp.ts': 'export function judgeMfaCode() {}',
        'server/src/api/ok.ts': "// verifyMfaCode is wrapped by tryMfaCode\n/* judgeMfaCode too */ tryMfaCode(code, o).ok;",
      }), []);
    });
  });
});
