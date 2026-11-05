/**
 * The docs state the lockout's numbers, and they are the module's constants (Q-694, bundle-233).
 *
 * ## The defect it prevents
 *
 * "5 wrong codes, then locked for up to 15 minutes" is a promise an operator plans around (how long a locked admin waits, how many
 * guesses an attacker with a stolen token gets: about 0.14% a day). Written into three pages by hand, the numbers go stale the day
 * `MFA_FAILURES_MAX` or `MFA_LOCKOUT_WINDOW_MS` changes. They are read from the built module, never copied here.
 *
 * ## What it holds
 *
 * Each of `docs/integration-guide/03-auth-and-limits.md`, `10-mfa-and-conflicts.md` and `docs/userguide/04-settings.md` has a paragraph
 * about the lockout (one that says lock/locked/lockout or `MFA_LOCKED` and speaks of a code, MFA or the second factor) that
 * states the count (the failure maximum, as a digit or a word, beside "wrong" or "failed" or "incorrect") and the window (the window in
 * minutes, as a digit or a word, with "minute"). No lockout paragraph states a different count of wrong codes. The user guide no longer
 * says the code is "cached for 15 minutes so you are not asked again on every click": each step is accepted once.
 *
 * ## Seen red
 *
 * On the base `auth/code-attempts.js` does not exist (the constants cannot be read) and none of the pages has a lockout paragraph.
 *
 * Run: node --test testing/standalone/the-mfa-lockout-numbers-in-the-docs-are-the-constants.test.js
 * (requires a prior `npm run build -w server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PAGES = [
  'docs/integration-guide/03-auth-and-limits.md',
  'docs/integration-guide/10-mfa-and-conflicts.md',
  'docs/userguide/04-settings.md',
];
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty'];
const number = '(\\d+|' + WORDS.join('|') + ')';
const valueOf = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS.indexOf(s.toLowerCase()));

/** The paragraphs (blank-line separated) of `text` that are about the lockout. */
function lockoutParagraphs(text) {
  return text.split(/\r?\n\s*\r?\n/).filter(p => /\block(?:ed|out|s)?\b|MFA_LOCKED/i.test(p) && /\b(?:code|MFA|second factor|TOTP)\b/i.test(p));
}
const countsStated = (p) => [...p.matchAll(new RegExp(`\\b${number}\\s+(?:wrong|failed|incorrect|bad)\\s+(?:code|attempt|guess)`, 'gi'))].map(m => valueOf(m[1]));
const windowsStated = (p) => [...p.matchAll(new RegExp(`\\b${number}[ -]minutes?\\b`, 'gi'))].map(m => valueOf(m[1]));

describe('the lockout numbers in the docs are the constants', () => {
  let MAX; let MINUTES;
  before(async () => {
    const m = await import('../../server/dist/auth/code-attempts.js');
    MAX = m.MFA_FAILURES_MAX;
    MINUTES = m.MFA_LOCKOUT_WINDOW_MS / 60_000;
    assert.ok(Number.isInteger(MAX) && Number.isInteger(MINUTES), `the constants are ${MAX} and ${MINUTES} minutes`);
  });

  for (const page of PAGES) {
    it(`${page.replace('docs/', '')} states ${'the count and the window'} of the lockout`, () => {
      const paragraphs = lockoutParagraphs(readFileSync(page, 'utf8'));
      assert.ok(paragraphs.length > 0, `${page} has no paragraph about the MFA lockout`);
      assert.ok(paragraphs.some(p => countsStated(p).includes(MAX)), `${page} never says "${MAX} wrong codes"`);
      assert.ok(paragraphs.some(p => windowsStated(p).includes(MINUTES)), `${page} never says "${MINUTES} minutes"`);
      for (const p of paragraphs) {
        assert.deepEqual(countsStated(p).filter(n => n !== MAX), [], `${page}: a lockout paragraph states another count than ${MAX}:\n${p.slice(0, 300)}`);
      }
    });
  }

  it('the user guide no longer says the entered code is cached so you are not asked again', () => {
    assert.doesNotMatch(readFileSync('docs/userguide/04-settings.md', 'utf8'), /cached for 15 minutes so you are not asked again/i);
  });
});
