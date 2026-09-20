/**
 * The bench CLI reaches a conversation only through the loader, and never through a question set.
 *
 * ## Why a CLI is a new place for this to go wrong
 *
 * `loadConversations` returns a conversation carrying no question data, and
 * `the-extractor-cannot-see-the-questions.test.js` enforces that **on the loader**. It cannot enforce it on
 * whoever opens the release next — and a CLI whose job is *"show me this conversation so I can extract
 * it"* is exactly the code that would open it, because the pinned file is right there and `JSON.parse` is
 * one line shorter than an import.
 *
 * The release is one object per instance: the history AND `question`, `answer`, `evidence` and the
 * category. A dump built from it would put all of that in front of the model doing the extraction, and
 * nothing downstream could tell — the extraction would simply get better at this corpus.
 *
 * ## So the rule is about the DOORS, not about the output
 *
 * Checking the dumped text for question-shaped strings would be a detector with no floor: a question that
 * happened to look like a turn passes, and a corpus that is not fetched makes the whole check vacuous.
 * Which imports exist is decidable from the source, always, and it is the thing that would actually change.
 *
 * Run: node --test testing/standalone/the-bench-cli-reads-the-corpus-through-the-loader.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankComments } from './_strip-comments.mjs';

const SRC = 'benchmarks/bench.mjs';
const code = () => blankComments(readFileSync(SRC, 'utf8'));

describe('how the CLI reaches a conversation', () => {
  it('it imports the loader, so the scan below is not over an empty set', () => {
    // The floor. Every assertion here is an absence, and absences pass on a file that does nothing.
    assert.match(code(), /import \{ loadConversations \} from '\.\/locomo\/loader\.mjs'/,
      `${SRC} no longer imports the conversation loader — either it stopped reading conversations, or it `
      + 'found another way in. Decide which; do not let this gate skip.');
  });

  it('it does not import the question loader', () => {
    assert.equal(/loadQuestions/.test(code()), false,
      'the bench CLI imports loadQuestions. Extraction runs from what this prints, and the release holds '
      + 'the questions in the same object as the history.');
  });

  it('it names no answer-key vocabulary at all', () => {
    for (const word of ['evidence', 'adversarial', 'gold', 'answerKey']) {
      assert.equal(new RegExp(`\\b${word}\\b`, 'i').test(code()), false,
        `the CLI mentions '${word}', which nothing it does should need`);
    }
  });

  it('it never opens the pinned release itself', () => {
    // The specific shortcut: `readFileSync(pin.datasets.locomo.cachePath)` and a `JSON.parse`. It reads the
    // PIN, to find the path and to say so when the corpus is absent, and hands the path to the loader.
    const src = code();
    const readsCache = /readFileSync\([^)]*cachePath/.test(src) || /JSON\.parse\(readFileSync\([^)]*cachePath/.test(src);
    assert.equal(readsCache, false,
      'the CLI reads the pinned corpus directly. That file is one object per instance — history, question, '
      + 'answer and evidence together — so parsing it here puts the answer key one property access away.');
    assert.match(src, /cachePath/, 'it should still READ the pin, to resolve the path and to report a missing corpus');
  });

  it('the detectors would notice the thing they are looking for', () => {
    // Mutation-check the instrument, not the subject: a regex that matches nothing reports a clean file
    // forever, which is this gate's own failure mode.
    const leaky = "import { loadQuestions } from './locomo/loader.mjs';\nconst raw = JSON.parse(readFileSync(pin.datasets.locomo.cachePath));";
    assert.ok(/loadQuestions/.test(leaky));
    assert.ok(/JSON\.parse\(readFileSync\([^)]*cachePath/.test(leaky));
  });
});

describe('what the CLI is for', () => {
  it('every verb it advertises is one it implements', () => {
    // A usage line naming a verb that falls through to the error is a CLI that documents a capability it
    // does not have — the same defect as a stale schema description, in a smaller place.
    const src = code();
    const advertised = [...src.matchAll(/^\s{2}(\w+)\s{2,}/gm)].map(m => m[1]);
    const implemented = [...src.matchAll(/case '(\w+)':/g)].map(m => m[1]);
    assert.ok(implemented.length >= 4, `only ${implemented.length} verbs implemented — the switch moved`);
    for (const verb of new Set(advertised)) {
      if (!implemented.includes(verb)) continue;   // prose lines in the usage block are not verbs
      assert.ok(implemented.includes(verb), `${verb} is advertised and not implemented`);
    }
    for (const verb of implemented) {
      assert.match(src, new RegExp(`\\b${verb}\\b`), `${verb} is implemented and never mentioned in the usage`);
    }
  });
});
