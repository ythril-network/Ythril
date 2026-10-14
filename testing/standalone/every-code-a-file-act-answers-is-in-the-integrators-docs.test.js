/**
 * Every `code` a file act answers is named where an integrator reads status codes, and a retired one is named nowhere.
 *
 * ## The defect it prevents
 *
 * `files/act-answers.ts` is the one place a file act's refusal or failure becomes a status, a `code` and a sentence, on
 * every door. An integrator branches on `code` (a client that meets one it does not know acts on the status), so a code
 * the docs do not list is a capability nobody knows about, and a code the docs still list after the server stopped
 * answering it is a branch that never fires. Both were true at once while a move onto another file's records answered
 * `destination_taken_by_other` and the guide described the replacement it no longer made.
 *
 * ## What it holds
 *
 * The codes are DERIVED from the module's own `code: '<x>'` literals (the same read the client spec makes), never listed
 * here; the floor guards the derivation. Each must appear in the status-code table of `03-auth-and-limits.md` and in
 * `05-files-api.md`, the page whose refusals the table points to. The retired code is the one entry kept by hand,
 * because a gate cannot derive what no longer exists; it must appear in no page of the guide, the user guide or the
 * changelog.
 *
 * Run: node --test testing/standalone/every-code-a-file-act-answers-is-in-the-integrators-docs.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allDocsText } from './_docs.mjs';

const ANSWERS = 'server/src/files/act-answers.ts';
const PAGES = ['docs/integration-guide/03-auth-and-limits.md', 'docs/integration-guide/05-files-api.md'];

/** Codes a file act no longer answers. Folded into `destination_exists` when a move stopped replacing anything. */
const RETIRED = ['destination_taken_by_other'];

const codes = [...new Set([...readFileSync(ANSWERS, 'utf8').matchAll(/code: '([a-z_]+)'/g)].map(m => m[1]))];

describe('the codes a file act answers are in the integrator docs', () => {
  it('finds the codes (the scan itself still works)', () => {
    assert.ok(codes.length >= 8, `only found ${codes.length} codes in ${ANSWERS}`);
    assert.ok(codes.includes('destination_exists'), 'the move refusal is among them');
  });

  for (const page of PAGES) {
    it(`${page} names every code`, () => {
      const text = readFileSync(page, 'utf8');
      const missing = codes.filter(code => !text.includes(`\`${code}\``) && !text.includes(`"${code}"`));
      assert.deepEqual(missing, [], `${page} does not name: ${missing.join(', ')}`);
    });
  }

  it('no page of the docs or the changelog names a retired code', () => {
    const text = `${allDocsText()}\n${readFileSync('CHANGELOG.md', 'utf8')}`;
    const named = RETIRED.filter(code => text.includes(code));
    assert.deepEqual(named, [], `still documented: ${named.join(', ')}`);
  });
});
