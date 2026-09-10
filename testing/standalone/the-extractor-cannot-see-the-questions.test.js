/**
 * What the extraction step is handed carries no questions, no answers and no categories.
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
 * `loadConversations` is the only door the extractor uses, and its own docblock says it returns objects
 * carrying no question data. This checks the objects rather than the sentence — the sentence has been true
 * and the shape is what a caller actually receives.
 *
 * ## Why it looks at the whole tree
 *
 * A question could arrive nested inside a session or a turn, not only at the top of a conversation. Checking
 * the top-level keys would pass a loader that stopped stripping one level down, which is exactly the kind of
 * change nobody notices: the extra field is simply present, nothing errors, and the extraction quietly gets
 * better at this corpus.
 *
 * Skipped when the pinned dataset is absent. It is fetched by URL and not vendored, so a clean checkout has
 * no copy — and a gate that FAILS on a missing optional input teaches people to ignore it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadConversations } from '../../benchmarks/dataset/locomo.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pin = JSON.parse(readFileSync(join(repoRoot, 'benchmarks', 'dataset', 'pin.json'), 'utf8'));
const dataPath = join(repoRoot, pin.datasets.locomo.cachePath);

/** Everything the answer key is spelled with, in the release and in anything derived from it. */
const QUESTION_KEYS = ['qa', 'question', 'questions', 'answer', 'adversarial_answer', 'adversarialAnswer', 'evidence', 'category'];

/** Every key appearing anywhere in a value, however deeply nested. */
function keysAnywhere(value, found = new Set()) {
  if (Array.isArray(value)) { for (const v of value) keysAnywhere(v, found); return found; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { found.add(k); keysAnywhere(v, found); }
  }
  return found;
}

const conversations = existsSync(dataPath) ? await loadConversations(dataPath) : [];

describe('the conversations handed to extraction', { skip: existsSync(dataPath) ? false : 'pinned dataset not fetched' }, () => {

  test('there are conversations to check', () => {
    // The floor. Every assertion below is a loop, and a loop over nothing proves nothing.
    assert.ok(conversations.length > 0, 'the loader returned no conversations');
    const turns = conversations.flatMap(c => (c.sessions ?? []).flatMap(s => s.turns ?? []));
    assert.ok(turns.length > 0, 'the conversations contain no turns — the loader shape changed');
  });

  test('no question, answer, evidence or category reaches the extractor, at any depth', () => {
    const present = [...keysAnywhere(conversations)].filter(k => QUESTION_KEYS.includes(k));
    assert.deepEqual(present, [],
      `the loader is handing the extraction step ${present.join(', ')} — a graph built while looking at the `
      + 'answer key describes this corpus and nothing else');
  });

  test('a turn carries what extraction needs and nothing more', () => {
    // Stated positively as well, because "none of these keys" also passes on an empty object.
    const turn = conversations[0].sessions[0].turns[0];
    assert.ok(typeof turn.speaker === 'string' && turn.speaker.length > 0, 'a turn has no speaker');
    assert.ok(typeof turn.text === 'string' && turn.text.length > 0, 'a turn has no text');
  });

  test('a session carries its date, because every relative expression is resolved against it', () => {
    const session = conversations[0].sessions[0];
    assert.match(String(session.startsAt ?? ''), /^\d{4}-\d{2}-\d{2}/, 'a session has no usable date');
  });
});

describe('the dataset is the one that was pinned', { skip: existsSync(dataPath) ? false : 'pinned dataset not fetched' }, () => {
  test('the bytes on disk match the recorded sha256', async () => {
    // The pin is what makes "may not be touched" checkable rather than a promise: an edited local copy stops
    // matching, and a result produced from it is not a result about the published corpus.
    const { createHash } = await import('node:crypto');
    const actual = createHash('sha256').update(readFileSync(dataPath)).digest('hex');
    assert.equal(actual, pin.datasets.locomo.sha256, 'the cached dataset is not the pinned one');
  });
});
