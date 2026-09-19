/**
 * What the LongMemEval loader does with a release that is not shaped the way it expects.
 *
 * ## Why a loader refuses instead of coping
 *
 * Everything downstream of it is deterministic, so a value that arrives wrong here arrives wrong in a
 * committed extraction, in a space, and in a number somebody quotes. A loader that copes produces a run
 * nobody can trace back to the file that was pinned — which is the one thing a pinned corpus exists for.
 *
 * The exception is the twelve empty turns, and it is an exception with a measurement behind it: 12 of
 * 246,930 turns in the pinned release carry no content, across seven histories, and none of them is
 * evidence. Refusing would make seven histories unreadable over twelve blank strings. So they are dropped
 * and REPORTED — the shape LoCoMo's loader already uses for its nine malformed evidence references, for
 * the same reason.
 *
 * ## The id is the part with a trap in it
 *
 * `sourceTurns` in a committed extraction names turns by id, so an id has to mean the same thing before and
 * after a drop. Numbering the SURVIVING turns would renumber everything after a dropped one, and a
 * committed extraction would then point at the wrong remark with nothing anywhere to reveal it. The ids are
 * minted from the published position, so a dropped turn leaves a gap.
 *
 * These fixtures are literal. A fixture derived from the loader would assert that the code equals itself;
 * what keeps them honest against the real release is the blindness gate, which runs over the fetched file.
 *
 * Run: node --test testing/standalone/the-longmemeval-loader-refuses-what-it-cannot-vouch-for.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadHistories, historyRepairs } from '../../benchmarks/longmemeval/loader.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lme-'));
let n = 0;
/** Write a release to a scratch file and read it back through the real loader. */
const load = (instances) => {
  const path = join(dir, `release-${++n}.json`);
  writeFileSync(path, JSON.stringify(instances));
  return loadHistories(path);
};

const turn = (role, content) => ({ role, content });
const instance = (over = {}) => ({
  question_id: 'q1',
  question: 'where does Ada work?',
  answer: 'Beta',
  question_type: 'knowledge-update',
  answer_session_ids: ['s1'],
  haystack_session_ids: ['s1'],
  haystack_dates: ['2023/05/20 (Sat) 02:21'],
  haystack_sessions: [[turn('user', 'I joined Acme.'), turn('assistant', 'Congratulations!')]],
  ...over,
});

describe('a well-formed release', () => {
  test('comes back as histories with ids, dates, speakers and text', () => {
    const [h] = load([instance()]);
    assert.equal(h.id, 'q1');
    assert.equal(h.sessions.length, 1);
    assert.equal(h.sessions[0].startsAt, '2023-05-20T02:21:00Z');
    assert.equal(h.sessions[0].id, 's1');
    assert.deepEqual(h.sessions[0].turns.map(t => t.id), ['D1:1', 'D1:2']);
    assert.deepEqual(h.sessions[0].turns.map(t => t.speaker), ['user', 'assistant']);
  });

  test('and carries none of the answer key, however the instance spelled it', () => {
    // The whole-tree version of this runs against the real file in the blindness gate. Here it is asserted
    // on the ONE object, because a fixture can be given every leak at once and the release cannot.
    const [h] = load([instance()]);
    for (const k of ['question', 'answer', 'question_type', 'answer_session_ids', 'has_answer']) {
      assert.equal(k in h, false, `the history carries ${k}`);
    }
  });

  test('a session date with no zone is read as UTC by declaration', () => {
    // Not a preference: reading it as local time makes the same run in Berlin and in CI write chrono
    // records hours apart, and the diff reads as a retrieval change rather than as a timezone.
    const [h] = load([instance({ haystack_dates: ['2023/12/31 (Sun) 23:59'] })]);
    assert.equal(h.sessions[0].startsAt, '2023-12-31T23:59:00Z');
  });
});

describe('an empty turn is dropped and reported, never silently', () => {
  const withGap = () => [instance({
    haystack_sessions: [[turn('user', 'first'), turn('user', '   '), turn('user', 'third')]],
  })];

  test('the blank turn does not reach the extractor', () => {
    const [h] = load(withGap());
    assert.deepEqual(h.sessions[0].turns.map(t => t.text), ['first', 'third']);
  });

  test('the surviving turns KEEP their published ids, so the gap is visible', () => {
    // The trap. Renumbering would make `D1:2` name the third turn, and a committed extraction's
    // `sourceTurns` would point at the wrong remark with nothing anywhere to reveal it.
    const [h] = load(withGap());
    assert.deepEqual(h.sessions[0].turns.map(t => t.id), ['D1:1', 'D1:3']);
  });

  test('and the drop is in the report', () => {
    const histories = load(withGap());
    assert.equal(histories.repairs.length, 1);
    assert.match(histories.repairs[0].turn, /D1:2/);
    assert.match(histories.repairs[0].what, /no content/);
  });

  test('a clean release reports nothing', () => {
    // A report that is never empty is a report nobody reads.
    assert.deepEqual(load([instance()]).repairs, []);
  });

  test('the repairs door returns the same report without the histories', () => {
    const path = join(dir, 'repairs.json');
    writeFileSync(path, JSON.stringify(withGap()));
    assert.equal(historyRepairs(path).length, 1);
  });
});

describe('what it refuses', () => {
  const refuses = (over, pattern) => assert.throws(() => load([instance(over)]), pattern);

  test('a turn carrying a key the loader has never seen', () => {
    // The one that matters most: a new field on a turn is invisible to everything downstream, and the
    // corpus has already shipped one that is answer-key data. Stopping is the only safe default.
    refuses({ haystack_sessions: [[{ role: 'user', content: 'x', confidence: 0.9 }]] }, /unknown key 'confidence'/);
  });

  test('a role that is neither user nor assistant', () => {
    refuses({ haystack_sessions: [[turn('system', 'x')]] }, /neither user nor assistant/);
  });

  test('a session date it cannot parse', () => {
    refuses({ haystack_dates: ['20 May 2023'] }, /not `YYYY\/MM\/DD \(Day\) HH:MM`/);
  });

  test('fewer dates than sessions — the quiet one', () => {
    // A short array gives the last sessions an undefined date, which becomes a chrono record nothing can
    // order. No error, no warning, and the ordering is simply wrong.
    refuses({
      haystack_sessions: [[turn('user', 'a')], [turn('user', 'b')]],
      haystack_session_ids: ['s1', 's2'],
    }, /2 sessions and 1 dates/);
  });

  test('fewer session ids than sessions', () => {
    refuses({
      haystack_sessions: [[turn('user', 'a')], [turn('user', 'b')]],
      haystack_dates: ['2023/05/20 (Sat) 02:21', '2023/05/21 (Sun) 02:21'],
    }, /2 sessions and 1 session ids/);
  });

  test('an instance with no id to join a result back by', () => {
    refuses({ question_id: undefined }, /no question_id/);
  });

  test('a release that parsed to nothing', () => {
    assert.throws(() => load([]), /no instances at all/);
  });
});
