/**
 * Every span in the committed corpus is a duration somebody lived, not a window somebody guessed inside.
 *
 * ## The artefact this exists to catch, which cost two extra extraction rounds
 *
 * `endsAt` means how long something lasted. It does not mean how unsure you are about when it happened, and
 * the two are indistinguishable once written: `2023-07-03 → 2023-07-09` is a valid record whether it is a
 * week-long festival or a wedding somebody could only date to that week.
 *
 * On 2026-09-20 one extraction came back with 34 chrono entries where the previous prompt had given 7, and
 * **all 24 of its spans were calendar weeks or whole months over events that took a single day** — a
 * wedding, a 40-point game, an endorsement signing. It looked like the prompt fix had worked spectacularly.
 * A second extraction had done a milder version of the same thing. Between them they moved the corpus-wide
 * figure from 3.5x to 2.6x, and **the only thing that caught it was a human reading two prose reports** and
 * noticing the word "week-window".
 *
 * ## So the detector is the SHAPE of the range, not its length
 *
 * A long span is not suspicious — a nine-day trip is a nine-day trip. What gives the artefact away is that a
 * guessed window snaps to a calendar: Monday to Sunday, or the 1st to the last day of a month. Nobody's
 * holiday reliably starts on a Monday and ends on the following Sunday; a calendar week is what you write
 * when the conversation said "last week" and you wanted a timeline entry anyway.
 *
 * **It refuses rather than warns, and it names the record.** A warning about a data file is read once.
 *
 * Run: node --test testing/standalone/a-span-is-a-duration-not-a-date-window.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { calendarWindowSpans } from '../../benchmarks/writer/corpus-spread.mjs';

const EXTRACTIONS = 'benchmarks/locomo/extractions';
const one = (date, endsAt) => ({ conversationId: 'c', chrono: [{ key: 'k', title: 't', date, endsAt }] });

describe('what counts as a calendar window', () => {
  it('flags Monday to Sunday', () => {
    // 2023-07-03 is a Monday, 2023-07-09 the Sunday after it.
    assert.equal(calendarWindowSpans(one('2023-07-03', '2023-07-09')).length, 1);
  });

  it('flags the whole of a month, and a short month too', () => {
    assert.equal(calendarWindowSpans(one('2023-08-01', '2023-08-31')).length, 1);
    assert.equal(calendarWindowSpans(one('2023-02-01', '2023-02-28')).length, 1);
  });

  it('passes a weekend', () => {
    // Saturday to Sunday — the shape the prompt explicitly sanctions.
    assert.deepEqual(calendarWindowSpans(one('2023-07-15', '2023-07-16')), []);
  });

  it('passes a long trip that does not snap to a calendar', () => {
    // Nine days, Tuesday to Wednesday. Length is not the signal.
    assert.deepEqual(calendarWindowSpans(one('2022-07-11', '2022-07-20')), []);
  });

  it('passes a seven-day span that does not start on a Monday', () => {
    // The point of testing the SHAPE: a real week-long holiday rarely begins on a Monday, and a guessed
    // week always does. A length test alone would refuse this and let a Monday-Sunday guess through.
    assert.deepEqual(calendarWindowSpans(one('2023-07-05', '2023-07-11')), []);
  });

  it('passes a single-day chrono entry with no endsAt at all', () => {
    assert.deepEqual(calendarWindowSpans({ conversationId: 'c', chrono: [{ key: 'k', date: '2023-07-03' }] }), []);
  });

  it('names the record, because a count is not actionable', () => {
    const flagged = calendarWindowSpans(one('2023-07-03', '2023-07-09'));
    assert.equal(flagged[0].key, 'k');
    assert.match(flagged[0].why, /calendar week/i);
  });
});

describe('the committed corpus', () => {
  it('holds no span that snaps to a calendar week or month', () => {
    const files = existsSync(EXTRACTIONS) ? readdirSync(EXTRACTIONS).filter(f => f.endsWith('.json')) : [];
    assert.ok(files.length >= 2, `only ${files.length} extractions — the sweep would be vacuous`);

    /*
     * A FLOOR on spans as well as on files. Every assertion here is an absence, and a corpus where nothing
     * uses `endsAt` at all passes it while telling you nothing — which was literally true of this corpus
     * before #1353, and is the state a regression would return it to.
     */
    let spans = 0;
    const flagged = [];
    for (const file of files) {
      const x = JSON.parse(readFileSync(`${EXTRACTIONS}/${file}`, 'utf8'));
      spans += (x.chrono ?? []).filter(c => c.endsAt !== undefined).length;
      for (const f of calendarWindowSpans(x)) flagged.push(`${file}: ${f.key} — ${f.why} — ${f.title}`);
    }
    assert.ok(spans >= 1, 'no extraction uses `endsAt` at all, so this sweep asserts nothing. Either the '
      + 'field regressed out of the writer or the corpus predates it.');
    assert.deepEqual(flagged, [], `spans that snap to a calendar:\n  ${flagged.join('\n  ')}`);
  });
});
