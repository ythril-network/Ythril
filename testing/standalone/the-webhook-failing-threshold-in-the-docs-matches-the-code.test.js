/**
 * Every place the docs state how many failures in a row mark a webhook subscription failing states the number the store runs with,
 * `FAILING_AFTER` (bundle-119, Q-477, design rev 3 item 11; round 2 F1).
 *
 * ## What it prevents
 *
 * The threshold is one constant in `webhooks/store.ts`, and the integration guide and the userguide each repeat it in words ("six
 * exhausted retry schedules in a row", "six events in a row"). A sentence that copies a constant is a second copy of a fact the code
 * holds: change the constant and the pages keep promising the old count, to the operator deciding how long a sink may be down.
 *
 * ## How the places are found: by search, never from a list
 *
 * Every tracked Markdown file is read (changelogs left out: they describe what WAS true), each paragraph or bullet is flattened and cut
 * into sentences, and a THRESHOLD SENTENCE is one that says a webhook or subscription is marked failing and counts something "in a
 * row". The figure is the first number after "failing" (a digit or a number word). A floor of two found sentences keeps an empty search
 * from passing: the integration guide and the userguide each state it, and a doc rewrite that drops one should fail here and be looked at.
 *
 * ## Seen red
 *
 * In memory, on copies of each found sentence with the figure changed (`stateFigure` must report the changed figure); and, by hand,
 * by changing "six" in the userguide sentence and running this file, then putting the word back by hand.
 *
 * Run: node --test testing/standalone/the-webhook-failing-threshold-in-the-docs-matches-the-code.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen',
  'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const NUMBER = new RegExp(`\\b(\\d+|${WORDS.join('|')})\\b`, 'i');
const valueOf = (token) => (/^\d+$/.test(token) ? Number(token) : WORDS.indexOf(token.toLowerCase()));

/** The sentences of a Markdown text: blocks (paragraphs, bullets) flattened, emphasis and code marks removed, cut at a sentence end. */
export function sentencesOf(text) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n(?=\s*(?:[-*] |\d+\. |#|\||$))/);
  return blocks.flatMap(b => b.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z(])/)).filter(Boolean);
}

/** A threshold sentence: a webhook or subscription marked failing, after a count of something in a row. */
export const isThresholdSentence = (s) => /\b(webhook|subscription)/i.test(s) && /\bmarked\s+failing\b/i.test(s) && /\bin a row\b/i.test(s);

/** The figure a threshold sentence states: the first number after "failing", or null when it states none. */
export function stateFigure(sentence) {
  const after = sentence.slice(sentence.search(/\bfailing\b/i));
  const m = NUMBER.exec(after);
  return m ? valueOf(m[1]) : null;
}

/** Every threshold sentence of the tracked Markdown, as `{ path, sentence }`. */
function thresholdSentences() {
  const docs = trackedSources('.', { ext: ['.md'], floor: 50 })
    .filter(p => !/(^|\/)changelog\//i.test(p) && !/CHANGELOG[^/]*\.md$/i.test(p));
  return docs.flatMap(path => sentencesOf(readFileSync(join(REPO_ROOT, path), 'utf8'))
    .filter(isThresholdSentence).map(sentence => ({ path, sentence })));
}

describe('the docs state the failing threshold the store runs with', () => {
  let FAILING_AFTER;
  const found = thresholdSentences();
  before(async () => { ({ FAILING_AFTER } = await import('../../server/dist/webhooks/store.js')); });

  it('the search finds the threshold sentences (at least the integration guide\'s and the userguide\'s)', () => {
    assert.ok(found.length >= 2, `only ${found.length} threshold sentence(s) found: ${JSON.stringify(found)}`);
    assert.ok(found.some(f => f.path.startsWith('docs/integration-guide/')), 'the integration guide states no failing threshold');
    assert.ok(found.some(f => f.path.startsWith('docs/userguide/')), 'the userguide states no failing threshold');
  });

  it('every threshold sentence states FAILING_AFTER', () => {
    assert.equal(typeof FAILING_AFTER, 'number', 'webhooks/store.ts exports no FAILING_AFTER');
    const wrong = found.filter(f => stateFigure(f.sentence) !== FAILING_AFTER)
      .map(f => `${f.path}: states ${stateFigure(f.sentence)} — "${f.sentence}"`);
    assert.deepEqual(wrong, [], `the docs state a failing threshold the store does not run with (FAILING_AFTER = ${FAILING_AFTER})`);
  });

  it('seen red: each found sentence with its figure changed is reported as stating the changed figure', () => {
    assert.ok(found.length > 0, 'nothing found to change');
    for (const { path, sentence } of found) {
      const changed = sentence.replace(new RegExp(`\\b${WORDS[FAILING_AFTER]}\\b|\\b${FAILING_AFTER}\\b`, 'i'), WORDS[FAILING_AFTER + 1]);
      assert.notEqual(changed, sentence, `${path}: the figure ${FAILING_AFTER} is not written in "${sentence}"`);
      assert.equal(stateFigure(changed), FAILING_AFTER + 1, `${path}: a changed figure was not read`);
    }
  });

  it('the finder is not vacuous: it takes a threshold sentence and leaves the others', () => {
    const sample = '- **A subscription is marked `failing` after 4 exhausted schedules in a row**, each one event.\n'
      + 'One more exhausted schedule marks it `failing` again.\n\nA webhook marked failing takes nothing.\n';
    const hits = sentencesOf(sample).filter(isThresholdSentence);
    assert.equal(hits.length, 1, JSON.stringify(sentencesOf(sample)));
    assert.equal(stateFigure(hits[0]), 4);
  });
});
