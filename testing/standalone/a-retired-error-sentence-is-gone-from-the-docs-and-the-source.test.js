/**
 * A sentence a door used to answer, and no longer does, is in no document and no source file (Q-978, finding L1.3).
 *
 * ## What it prevents
 *
 * A rename that the store refused used to answer `500 rename incomplete ... Errors: ...`, and the Spaces API page described it as "Partial
 * rename failure (collections may be in an inconsistent state)". The behaviour changed (a refused rename is moved back and the space stands
 * whole), the answer's words changed, and the row of the page kept the old ones for a whole bundle: a caller reading it was told of a state the
 * server no longer leaves. A docs row is prose, not a quotation of the error builder, so no rule can match every row against the builder's
 * sentence; what one rule can hold is the other direction: the words a door retired.
 *
 * ## What it holds
 *
 * Every phrase in `RETIRED` is found in no tracked file under `docs/` and none under the server's code roots. **A change that rewords a door's error adds
 * the old words here, in the same commit**: that is the whole rule, and it is what makes the docs row that still quotes them fail the commit
 * that retired them. The scan reads the files (a floor says it found them), and a phrase that is listed and never existed is a mistake of this
 * list, not of the tree, so the positive control checks that the scan reads a phrase that is there.
 *
 * ## Seen red
 *
 * At 89df72c5c `docs/integration-guide/06-spaces-api.md` still holds "Partial rename failure" and `server/src/spaces/rename.ts` still quotes
 * "rename incomplete" in a comment.
 *
 * Run: node --test testing/standalone/a-retired-error-sentence-is-gone-from-the-docs-and-the-source.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedTextSources, SERVER_CODE_ROOTS } from './_sources.mjs';

/** The words a door retired, with what replaced them. Compared without regard to case. */
const RETIRED = new Map([
  ['partial rename failure', 'a refused rename is moved back and the space stands whole (`RenameRefusedError`, Q-978)'],
  ['rename incomplete', 'the answer is "was not renamed" (`RenameRefusedError`, Q-978)'],
  ['collections may be in an inconsistent state', 'a refused rename leaves the space whole, or names what stays (Q-978)'],
]);

describe('a retired error sentence', () => {
  const files = readTrackedTextSources(['docs', ...SERVER_CODE_ROOTS], { floor: 50 });

  it('is in no document and no source file', () => {
    const found = [];
    for (const { file, text } of files) {
      const lower = text.toLowerCase();
      for (const [phrase, instead] of RETIRED) if (lower.includes(phrase)) found.push(`${file} holds "${phrase}"; now: ${instead}`);
    }
    assert.deepEqual(found, [], found.join('\n'));
  });

  it('the scan reads what it is told to read (a phrase that is there is found)', () => {
    assert.ok(files.some(f => f.file === 'docs/integration-guide/06-spaces-api.md' && f.text.includes('rename')), 'the Spaces API page was not read');
    assert.ok(files.some(f => f.file === 'server/src/spaces/rename.ts' && f.text.toLowerCase().includes('was not renamed')), 'rename.ts was not read');
  });
});
