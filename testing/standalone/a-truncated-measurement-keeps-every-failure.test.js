/**
 * A record's `measurements` past the size ceiling is cut down, and the cut keeps every failed test and every file name.
 *
 * ## What this prevents
 *
 * The cut-down form kept per-file figures only, so a run with a thousand failures, the worst runs, recorded none of their names:
 * the failure rate of a test read from the records had a hole exactly where most tests fail. The cut now drops only what it must
 * (the slowest list, the skips, the length of a message), keeps every failed test's file, name and the start of its message and
 * every file name, and says in the record that it was cut. When even that does not fit, the failures are kept before the figures
 * of files that passed, and the record says how many it left out, in `dropped`; the recorder says so on its output.
 *
 * Run: node --test testing/standalone/a-truncated-measurement-keeps-every-failure.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MODULE = pathToFileURL(resolve(import.meta.dirname, '..', '..', 'scripts', '_shared', 'measurements.mjs')).href;
const load = () => import(MODULE);

/** `fileCount` files, `failures` failing tests spread evenly over the first `failingFiles` of them. */
function suite({ fileCount, failures, failingFiles = fileCount, name = 60, message = 300 }) {
  const files = Array.from({ length: fileCount }, (_, i) => ({ file: `testing/standalone/file-${String(i).padStart(5, '0')}.test.js`, ms: 1000 + i, tests: 5, skips: [], failures: [] }));
  for (let k = 0; k < failures; k++) files[k % failingFiles].failures.push({ test: `${String(k).padStart(5, '0')} ${'n'.repeat(name)}`, message: `${String(k).padStart(5, '0')} ${'m'.repeat(message)}` });
  const timed = files.map(f => ({ file: f.file, test: 'slow', ms: f.ms }));
  return { files, timed };
}
const namesIn = (text) => JSON.parse(text).files.flatMap(f => (f.failures ?? []).map(k => k.test));
const namesOf = (files) => files.flatMap(f => f.failures.map(k => k.test));

describe('measurementsText past the ceiling', () => {
  it('keeps every failed test\'s file, name and message start and every file name, and says it was cut (1,500 files, 1,000 failures)', async () => {
    const { measurementsText, MAX_MEASUREMENTS_CHARS } = await load();
    const { files, timed } = suite({ fileCount: 1500, failures: 1000 });
    assert.ok(JSON.stringify({ files }).length > MAX_MEASUREMENTS_CHARS, 'the fixture does not pass the ceiling');
    const text = measurementsText(files, timed);
    assert.ok(text.length <= MAX_MEASUREMENTS_CHARS, `${text.length} chars`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.truncated, true, 'the record does not say it was cut');
    assert.equal(parsed.dropped, undefined, 'something was dropped that fitted');
    assert.deepEqual(parsed.files.map(f => f.file), files.map(f => f.file), 'a file name was dropped');
    assert.deepEqual(namesIn(text), namesOf(files), 'a failed test\'s name was dropped');
    const first = parsed.files[0].failures[0];
    assert.ok(first.message.startsWith('00000 m') && first.message.length > 20, 'the message start was not kept');
    assert.equal(parsed.slowest, undefined);
  });

  it('a record under the ceiling is unchanged: the slowest list, skips and whole messages stay', async () => {
    const { measurementsText } = await load();
    const { files, timed } = suite({ fileCount: 3, failures: 2, message: 200 });
    files[0].skips.push({ test: 's', reason: 'r' });
    const parsed = JSON.parse(measurementsText(files, timed));
    assert.equal(parsed.truncated, undefined);
    assert.equal(parsed.files[0].failures[0].message.length, 206);
    assert.equal(parsed.files[0].skips.length, 1);
    assert.equal(parsed.slowest.length, 3);
  });

  it('when the failures leave no room for the other files, the failures come first and the record counts what it left out', async () => {
    const { measurementsText, measurementsCutNote, MAX_MEASUREMENTS_CHARS } = await load();
    // 1,000 failures (names of 150 chars) in 100 files, 2,400 files that passed with long paths.
    const { files, timed } = suite({ fileCount: 2500, failures: 1000, failingFiles: 100, name: 150 });
    files.forEach((f, i) => { if (i >= 100) f.file = `${f.file}/${'d'.repeat(200)}`; });
    const text = measurementsText(files, timed);
    assert.ok(text.length <= MAX_MEASUREMENTS_CHARS, `${text.length} chars`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.truncated, true);
    assert.deepEqual(namesIn(text), namesOf(files), 'a failure was dropped before a passing file\'s figures');
    assert.ok(parsed.dropped.files > 0 && parsed.dropped.failures === 0, JSON.stringify(parsed.dropped));
    assert.equal(parsed.files.length + parsed.dropped.files, files.length, 'the count of dropped files is not the number left out');
    assert.match(measurementsCutNote(text), new RegExp(`${parsed.dropped.files} file`));
  });

  it('with failures past what the ceiling holds, it keeps as many as fit, counts the rest, and says so', async () => {
    const { measurementsText, measurementsCutNote, MAX_MEASUREMENTS_CHARS } = await load();
    const { files, timed } = suite({ fileCount: 50, failures: 1500, name: 290 });
    const text = measurementsText(files, timed);
    assert.ok(text.length <= MAX_MEASUREMENTS_CHARS, `${text.length} chars`);
    const parsed = JSON.parse(text);
    assert.ok(parsed.dropped.failures > 0);
    assert.equal(namesIn(text).length + parsed.dropped.failures, 1500);
    assert.match(measurementsCutNote(text), /failure/);
  });

  it('a cut that dropped nothing needs no note', async () => {
    const { measurementsText, measurementsCutNote } = await load();
    const { files, timed } = suite({ fileCount: 1500, failures: 1000 });
    assert.equal(measurementsCutNote(measurementsText(files, timed)), null);
    assert.equal(measurementsCutNote('none'), null);
  });
});
