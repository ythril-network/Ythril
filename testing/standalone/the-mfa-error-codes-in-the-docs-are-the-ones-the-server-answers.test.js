/**
 * The MFA error codes the server can answer are the ones the integration guide names (Q-694, bundle-233).
 *
 * ## The defect it prevents
 *
 * A client written from the guide branches on `error`: `MFA_REQUIRED` (no code sent: ask for one), `MFA_INVALID` (a code was sent and
 * refused: ask again) and, since the lockout, `MFA_LOCKED` (429, five wrong codes in 15 minutes: STOP, do not prompt, wait
 * `retryAfterSeconds`). Pages 07 (tokens), 08 (networks) and 14 (webhooks) each tell the reader what a missing code answers, and each said
 * only `MFA_REQUIRED`. A client that prompts again on a 429 it does not know keeps a locked token locked, and one that reads
 * `MFA_REQUIRED` as the only code never learns that a refused code is a different answer. The list of codes is one fact the server
 * holds; the three pages are held to it.
 *
 * ## What it holds
 *
 * The codes are DERIVED: every quoted `MFA_*` code in the comment-stripped `server/src` that a response can carry
 * (`error:` or `code:`), not named here. They must include the three above (the scan holds something). Then each of
 * `docs/integration-guide/07-tokens-api.md`, `08-networks-api.md` and `14-duplicates-and-webhooks.md` names every derived code
 * somewhere in its text, and none names an `MFA_*` code the server does not answer.
 *
 * ## Seen red
 *
 * On the base the derived set is MFA_REQUIRED and MFA_INVALID: `MFA_LOCKED` is missing from it (the scan's floor), and pages 07, 08 and 14
 * name only MFA_REQUIRED.
 *
 * Run: node --test testing/standalone/the-mfa-error-codes-in-the-docs-are-the-ones-the-server-answers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const PAGES = [
  'docs/integration-guide/07-tokens-api.md',
  'docs/integration-guide/08-networks-api.md',
  'docs/integration-guide/14-duplicates-and-webhooks.md',
];

/** Every MFA_* code a response in the server can carry, as the set of its spellings. */
function answeredCodes(files) {
  const codes = new Set();
  for (const f of files) {
    for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(/\b(?:error|code)\s*:\s*['"](MFA_[A-Z_]+)['"]/g)) codes.add(m[1]);
  }
  return codes;
}
const namedIn = (text) => new Set(text.match(/\bMFA_[A-Z_]+\b/g) ?? []);

describe('the MFA error codes the guide names', () => {
  const codes = answeredCodes(trackedSources(['server/src'], { floor: 200, untracked: true }));

  it('the server answers MFA_REQUIRED, MFA_INVALID and MFA_LOCKED (the scan holds something)', () => {
    for (const expected of ['MFA_REQUIRED', 'MFA_INVALID', 'MFA_LOCKED']) {
      assert.ok(codes.has(expected), `no response in server/src carries ${expected}; found ${[...codes].join(', ') || 'none'}`);
    }
  });

  for (const page of PAGES) {
    it(`${page.split('/').pop()} names every code and no other`, () => {
      const named = namedIn(readFileSync(page, 'utf8'));
      assert.deepEqual([...codes].filter(c => !named.has(c)).sort(), [], `${page} does not name these codes the server answers`);
      assert.deepEqual([...named].filter(c => !codes.has(c)).sort(), [], `${page} names codes the server does not answer`);
    });
  }
});
