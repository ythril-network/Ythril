/**
 * What the extraction step is handed carries no questions, no answers and no categories — for EVERY corpus.
 *
 * ## Why this is enforced rather than promised
 *
 * Extraction is the one step that needs a model, and a graph built while looking at the questions scores well
 * on those questions and describes nothing else. That is worse than a low score: it is a misleading one, and
 * nothing in a results table can reveal it afterwards.
 *
 * Owner, 2026-09-09, on finding that a session had read some of the answer key: *"delete the conversation and
 * reload the fresh dataset - it may not be touched afterwards"*. The dataset was re-fetched from its pinned
 * URL and came back byte-identical, so the corpus is unchanged; what this gate adds is that the rule cannot
 * be broken by accident from here.
 *
 * ## Its title said "the extraction step" and its body read ONE corpus
 *
 * That is the shape this repository keeps producing: a title claiming a set, a body naming a member, and
 * nothing ever contradicting it because a gate that passes is evidence of nothing in particular. LongMemEval
 * arrived and was covered by none of this — and it is the corpus that needed covering most.
 *
 * **LoCoMo keeps its questions in a block BESIDE the conversation. LongMemEval puts them in the same object**
 * — and, measured across the release, **896 individual turns inside the haystack carry `has_answer: true`.**
 * The top-level fields are ones a reader notices; that one is a third key on a turn otherwise holding `role`
 * and `content`, on exactly the turns a score is computed from. A loader passing sessions through verbatim
 * would hand the extraction model a flag reading *this turn is the evidence*, and nothing downstream could
 * see that it had.
 *
 * So `CORPORA` is a list of doors, and a third corpus is a row rather than an edit to the assertions.
 *
 * ## Why it looks at the whole tree
 *
 * A question could arrive nested inside a session or a turn, not only at the top of a record. Checking the
 * top-level keys would pass a loader that stopped stripping one level down, which is exactly the kind of
 * change nobody notices: the extra field is simply present, nothing errors, and the extraction quietly gets
 * better at this corpus.
 *
 * Skipped per corpus when its pinned dataset is absent. They are fetched by URL and not vendored, so a clean
 * checkout has no copy — and a gate that FAILS on a missing optional input teaches people to ignore it. What
 * that leaves is a file that can skip entirely and stay green, so the last block refuses that in CI.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConversations } from '../../benchmarks/locomo/loader.mjs';
import { loadHistories } from '../../benchmarks/longmemeval/loader.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every corpus the extraction step can be pointed at, with the one door it is read through. */
const CORPORA = [
  { name: 'locomo', pin: join(repoRoot, 'benchmarks', 'locomo', 'pin.json'), dataset: 'locomo', load: loadConversations },
  { name: 'longmemeval', pin: join(repoRoot, 'benchmarks', 'longmemeval', 'pin.json'), dataset: 'longmemeval_s', load: loadHistories },
];

/**
 * Everything an answer key is spelled with, in either release or in anything derived from one.
 *
 * `has_answer` is the important addition and it is not like the others — see the header for why a key on a
 * turn is the dangerous kind.
 */
const QUESTION_KEYS = ['qa', 'question', 'questions', 'question_type', 'questionType', 'answer',
  'adversarial_answer', 'adversarialAnswer', 'evidence', 'category',
  'has_answer', 'hasAnswer', 'answer_session_ids', 'answerSessionIds'];

/** Every key appearing anywhere in a value, however deeply nested. */
function keysAnywhere(value, found = new Set()) {
  if (Array.isArray(value)) { for (const v of value) keysAnywhere(v, found); return found; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { found.add(k); keysAnywhere(v, found); }
  }
  return found;
}

/** At least one corpus must actually be on disk, or this whole file skips and asserts nothing. */
let anyFetched = false;

for (const corpus of CORPORA) {
  const pin = JSON.parse(readFileSync(corpus.pin, 'utf8'));
  const dataPath = join(repoRoot, pin.datasets[corpus.dataset].cachePath);
  const fetched = existsSync(dataPath);
  anyFetched ||= fetched;
  const skip = fetched ? false : `${corpus.name} is not fetched`;
  const histories = fetched ? await corpus.load(dataPath) : [];

  describe(`${corpus.name}: what extraction is handed`, { skip }, () => {
    test('there is something to check', () => {
      // The floor. Every assertion below is a loop, and a loop over nothing proves nothing.
      assert.ok(histories.length > 0, 'the loader returned nothing');
      const turns = histories.flatMap(c => (c.sessions ?? []).flatMap(s => s.turns ?? []));
      assert.ok(turns.length > 0, 'there are no turns at all — the loader shape changed');
    });

    test('no question, answer, evidence or category reaches the extractor, at any depth', () => {
      const present = [...keysAnywhere(histories)].filter(k => QUESTION_KEYS.includes(k));
      assert.deepEqual(present, [],
        `the ${corpus.name} loader is handing the extraction step ${present.join(', ')} — a graph built `
        + 'while looking at the answer key describes this corpus and nothing else');
    });

    test('a turn carries what extraction needs and nothing more', () => {
      // Stated positively as well, because "none of these keys" also passes on an empty object.
      const turn = histories[0].sessions[0].turns[0];
      assert.ok(typeof turn.speaker === 'string' && turn.speaker.length > 0, 'a turn has no speaker');
      assert.ok(typeof turn.text === 'string' && turn.text.length > 0, 'a turn has no text');
      assert.ok(typeof turn.id === 'string' && turn.id.length > 0,
        'a turn has no id, so no claim could ever name it in sourceTurns');
    });

    test('a session carries its date, because every relative expression is resolved against it', () => {
      const session = histories[0].sessions[0];
      assert.match(String(session.startsAt ?? ''), /^\d{4}-\d{2}-\d{2}/, 'a session has no usable date');
    });

    test('the bytes on disk match the recorded sha256', async () => {
      // The pin is what makes "may not be touched" checkable rather than a promise: an edited local copy
      // stops matching, and a result produced from it is not a result about the published corpus.
      //
      // Through the shared refusal rather than a comparison written here. A hand-rolled `assert.equal`
      // against the pin field is the second copy of a rule whose whole difficulty is the case it does not
      // cover — a pin with no hash at all. See `benchmarks/dataset-pin.mjs`.
      const { assertPinned } = await import('../../benchmarks/dataset-pin.mjs');
      assert.equal(assertPinned(pin.datasets[corpus.dataset], readFileSync(dataPath), corpus.name), true);
    });
  });
}

describe('the gate itself', () => {
  test('at least one corpus was actually read, in CI', () => {
    // Every block above skips when its corpus is absent, so all of them skipping is a green file that
    // checked nothing. On a developer machine with no dataset that is correct; in CI, where they are
    // fetched, a silent all-skip is how this gate would stop meaning anything without ever failing.
    assert.ok(anyFetched || process.env.CI !== 'true',
      'no pinned corpus is on disk in CI, so every blindness check skipped and this file asserted nothing');
  });

  test('the detector sees the key it exists for', () => {
    // `has_answer` is the one that hides. Checked against the detector rather than trusted: a typo in the
    // list fails OPEN, and this gate's whole value is that it cannot.
    assert.ok(QUESTION_KEYS.includes('has_answer'));
    const leaky = [{ sessions: [{ turns: [{ role: 'user', content: 'x', has_answer: true }] }] }];
    assert.deepEqual([...keysAnywhere(leaky)].filter(k => QUESTION_KEYS.includes(k)), ['has_answer']);
  });
});
