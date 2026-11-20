/**
 * The cases of "a trickling reader cannot hold an export slot" are each in exactly one of the three files that hold the rule (bundle-356, Q-937).
 *
 * ## What this prevents
 *
 * `a-trickling-reader-cannot-hold-an-export-slot-db.test.js` was one file of 139 s on CI; it is three now (the rate rows, the gzip rows, the
 * idle and log rows) so they run side by side. A rule cut across files is held only while every case stays in one of them: a case dropped in
 * the move is a rule nobody checks, and the same case in two is a slow reader run twice. Each file is green with a case missing.
 *
 * ## The rule
 *
 * Each title below is declared by exactly one `it(...)` across the three files, in the file the table names, and no file declares a case the
 * table does not list; a file of the three that is not tracked fails it. The reading is the shared one
 * (`testing/_shared/split-cases-held-once.mjs`), proven on planted files in `a-split-test-holds-each-case-in-exactly-one-file.test.js`.
 *
 * Run: node --test testing/standalone/a-trickling-reader-cases-are-held-once-across-their-files.test.js
 */
import { describe, it } from 'node:test';
import { assertSplitCasesHeldOnce } from '../_shared/split-cases-held-once.mjs';

const RATE = 'testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-at-any-rate-db.test.js';
const GZIP = 'testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-through-gzip-db.test.js';
const IDLE = 'testing/standalone/a-trickling-reader-cannot-hold-an-export-slot-while-idle-db.test.js';

/** Every case of the unsplit file, by the file that holds it now. */
const SPLIT = {
  [RATE]: [
    'a reader at a tenth of the bound is judged too slow, frees its slot at once, and receives the incomplete ending as its last line',
    'a reader just under the bound is judged too slow, frees its slot at once, and receives the incomplete ending as its last line',
    'a reader just over the bound gets the whole export, however long it runs',
    'a reader at twice the bound gets the whole export, however long it runs',
  ],
  [GZIP]: [
    'a reader that accepts gzip at a tenth of the bound is answered the text itself and judged by the bound as any other',
    'a reader that accepts gzip at twice the bound is answered the text itself and judged by the bound as any other',
  ],
  [IDLE]: [
    'a reader that takes nothing for the first window is judged by what it took, not by what the buffers took, and is told',
    'a reader judged too slow leaves one log line naming the space and the rule, and no record',
    'a refusal for want of a slot leaves one log line, whichever door was refused, and no record',
    'a reader that takes nothing at all frees its slot, and its connection is cut once the ending had its time',
  ],
};

describe('the cases of a trickling reader are each held by exactly one of its three files', () => {
  it('every case is declared once, in the file the table names, and nothing else is declared', () => {
    assertSplitCasesHeldOnce(SPLIT);
  });
});
