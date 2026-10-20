/**
 * A file-system failure is reported once per operation and class per window, however often a caller repeats it (Q-458, pre-ship lens).
 *
 * ## The defect
 *
 * `answer-for-caught.ts` promises that every fault is reported once per operation and class per window, and the classes it reports
 * itself are. The `file_system` class is not reported there: it hands the failure to `answerFileActFailure`, which called
 * `reportServerFailure` on EVERY failure. A bulk resolution of 2 000 conflicts on a disk that answers `EIO` wrote 2 000 identical
 * lines with a stack each, and so did any door a client retried in a loop: the log's ring buffer (what `GET /api/about/logs` shows) held
 * nothing else, which is the "log drowned by one cause" an operator reads as many failures.
 *
 * ## What it asserts
 *
 * Through both entrances to the one reporter (a raw file-system error through `answerForCaught`, as the bulk resolution's
 * per-id failure reaches it; and a typed `FileSystemFault` through `answerFileActFailure`, as the tool and REST doors reach it):
 * one line per operation per window for a thousand repeats, the answer given EVERY time, the answer still counted every time
 * (`ythril_file_act_answers_total` is a tally of answers given, not of lines), and a different operation reported on its own.
 *
 * Run: node --test testing/standalone/a-repeated-file-system-failure-is-reported-once-per-window.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { logLinesDuring } from './_log-lines.mjs';

const REPEATS = 1000;
const fsErr = (code) => Object.assign(new Error(`${code}: injected, open '/srv/poison-fs-once/data/files/x/notes/y.txt'`),
  { code, errno: -5, syscall: 'open', path: '/srv/poison-fs-once/data/files/x/notes/y.txt' });

let answerForCaught, answerFileActFailure, FileSystemFault, fileActAnswerCounts;

describe('a repeated file-system failure is reported once per operation and class per window', () => {
  before(async () => {
    ({ answerForCaught } = await import('../../server/dist/util/answer-for-caught.js'));
    ({ answerFileActFailure } = await import('../../server/dist/files/act-failure-answer.js'));
    ({ FileSystemFault } = await import('../../server/dist/files/act-answers.js'));
    ({ fileActAnswerCounts } = await import('../../server/dist/files/act-answers.js'));
  });

  const reportsFor = (lines, where) => lines.filter(l => l.includes(where) && l.includes('failed'));

  it(`a raw file-system error through answerForCaught: ${REPEATS} repeats are one line, and ${REPEATS} answers`, async () => {
    const where = 'bulk resolve poison-fs-once-a';
    const before = fileActAnswerCounts().file_system_fault;
    const { lines, result } = await logLinesDuring(() => Array.from({ length: REPEATS }, () => answerForCaught(fsErr('EIO'), where, { refusals: false })));
    assert.equal(result.length, REPEATS);
    assert.ok(result.every(a => a.status === 500 && a.kind === 'file_system' && a.body.code === 'file_system_fault'), 'every repeat is answered as the fault it is');
    assert.equal(reportsFor(lines, where).length, 1, `${REPEATS} identical failures must be one report line in the window, not one each`);
    assert.equal(fileActAnswerCounts().file_system_fault - before, REPEATS, 'the answers are still counted every time');
  });

  it(`a typed FileSystemFault through answerFileActFailure: ${REPEATS} repeats are one line, and ${REPEATS} answers`, async () => {
    const where = 'tool poison-fs-once-b';
    const { lines, result } = await logLinesDuring(() => Array.from({ length: REPEATS }, () => answerFileActFailure(new FileSystemFault(fsErr('EACCES')), where)));
    assert.ok(result.every(a => a?.status === 500 && a.body.code === 'file_system_fault'), 'every repeat is answered');
    assert.equal(reportsFor(lines, where).length, 1, `${REPEATS} identical failures must be one report line in the window, not one each`);
  });

  it('another operation is reported on its own, and a failure that is not a file act reports nothing here', async () => {
    const a = 'tool poison-fs-once-c';
    const b = 'tool poison-fs-once-d';
    const { lines } = await logLinesDuring(() => {
      for (let i = 0; i < 5; i += 1) {
        answerFileActFailure(new FileSystemFault(fsErr('EIO')), a);
        answerFileActFailure(new FileSystemFault(fsErr('EIO')), b);
      }
      assert.equal(answerFileActFailure(new Error('not a file act'), a), undefined);
    });
    assert.equal(reportsFor(lines, a).length, 1);
    assert.equal(reportsFor(lines, b).length, 1);
  });
});
