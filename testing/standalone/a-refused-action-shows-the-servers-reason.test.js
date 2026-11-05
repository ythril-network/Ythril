/**
 * A client error handler that shows a failure toast passes the error it was given to refusalText, never a fixed "failed" text.
 *
 * ## The defect it prevents
 *
 * `error: () => this.toast.error(this.transloco.translate('tokens.error.revokeFailed'))` throws the server's answer away. Bundle-233's
 * pre-ship sweep found the token page's rotate, revoke and rename doing this: an admin whose second factor was locked (429 MFA_LOCKED) and
 * who was trying to revoke a stolen token read only "failed to revoke", with no word that the code entry was locked or for how long. The
 * same shape hid every other refusal those routes give (a rights refusal, a quota, a missing space).
 *
 * ## What it holds
 *
 * No tracked client source (specs aside) has an `error:` handler that takes no parameter and calls `toast.error(` - a handler that never
 * names the error cannot pass it on. Proven on planted sources: the parameterless form is named; a handler that passes its error to
 * refusalText, and one whose parameter is named but unused by a different call, are read as the scan says.
 *
 * Run: node --test testing/standalone/a-refused-action-shows-the-servers-reason.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** An `error:` handler with an empty parameter list whose body starts with a toast error. */
const DROPPED = /\berror\s*:\s*\(\s*\)\s*=>\s*(?:this\.)?toast\.error\(/g;

/** The handlers in `source` that show a failure toast without the error they were handed. */
export function droppedErrors(source) {
  return [...stripComments(source).matchAll(DROPPED)].map(m => m[0]);
}

describe('a refused action shows the server\'s reason', () => {
  it('the scanner names a handler that drops its error (planted)', () => {
    assert.equal(droppedErrors("x.subscribe({ error: () => this.toast.error(this.transloco.translate('k')) });").length, 1);
    assert.equal(droppedErrors("x.subscribe({ error: () => toast.error('k') });").length, 1);
    assert.equal(droppedErrors("x.subscribe({ error: (err) => this.toast.error(refusalText(this.transloco, err, 'k')) });").length, 0);
    assert.equal(droppedErrors("// error: () => this.toast.error('k') in a comment\n").length, 0);
  });

  it('no client source drops the error a failure toast should show', () => {
    const files = trackedSources(['client/src/app'], { ext: ['.ts'], floor: 100, specs: false, untracked: true });
    const found = {};
    for (const f of files) {
      const hits = droppedErrors(readFileSync(f, 'utf8'));
      if (hits.length) found[f] = hits.length;
    }
    assert.deepEqual(found, {}, 'pass the error to refusalText(this.transloco, err, <fallback key>): a fixed "failed" text hides why the server refused (a locked second factor, a rights refusal, a quota)');
  });
});
