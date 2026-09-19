/**
 * The text that instructs the ingester must not justify a rule with a benchmark corpus.
 *
 * ## The rule, and why it needs a gate rather than care
 *
 * Owner, 2026-09-19: *"i want great benchmark numbers but more important is that it works in real live and
 * is not just tuned for benchmarks"*. `ingestion-plan.md` is what makes that a live risk rather than a
 * slogan: **one ingester, and the benchmark is one of its callers.** Every sentence in the extraction
 * prompt, the space purpose and the usage notes is read when a customer ingests a support history.
 *
 * **Tuning does not arrive as a decision, it arrives as a justification.** The rule is usually right; what
 * leaks is the REASON printed beside it. A prompt that says *"do X — measured on longmemeval_s"* teaches
 * the next reader that X exists for a benchmark, and the day the corpus changes somebody deletes it. It
 * also reads absurdly to the customer, who is being told about a dataset they will never run.
 *
 * Caught for real: the assistant-turn rules shipped citing *"54 of the 896 evidence turns"* and *"842 of
 * the 896"*, in the prompt, hours after being written. The rules were right on product grounds and said so
 * nowhere.
 *
 * ## The set is DERIVED from the pins, never listed
 *
 * A hand-written list of corpus names is missing whichever one was added last — and a corpus is added by
 * dropping a `pin.json` in, which is exactly the moment nobody edits a gate. So the names come from the
 * pin files and the directories that hold them, and the floor asserts that some were found.
 *
 * ## What it does NOT cover, and why that is right
 *
 * `benchmarks/plan/` is harness plumbing: an extraction file's path and what `sourceTurns` is for are
 * genuinely about the benchmark, and saying so there is accurate. The line is whether a CUSTOMER reads it.
 *
 * ## Seen red
 *
 * By mutation: putting the measurement back into the assistant-turn section.
 *
 * Run: node --test testing/standalone/a-product-rule-is-not-justified-by-a-corpus.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';

/**
 * The text a caller of the ONE ingester is instructed by.
 *
 * The prompt is what the extractor reads; the purpose and usage notes are written INTO the space and are
 * what an operator or an agent reads afterwards. All three ship to anybody who ingests anything.
 */
const PRODUCT_FACING = [
  'benchmarks/prompt/extraction.md',
  'benchmarks/space/purpose.md',
  'benchmarks/space/usage-notes.md',
];

/** Every corpus this repository pins, read out of the pins themselves. */
function corpusNames() {
  const names = new Set();
  for (const f of trackedSources('benchmarks', { ext: ['pin.json'], floor: 2 })) {
    names.add(basename(dirname(f)));
    const doc = JSON.parse(readFileSync(join(REPO_ROOT, f), 'utf8'));
    for (const key of Object.keys(doc?.datasets ?? {})) names.add(key);
  }
  assert.ok(names.size >= 2,
    `only ${names.size} corpus name(s) derived from the pin files — the derivation is broken, and an empty `
    + 'set makes every assertion below pass about nothing');
  return [...names];
}

const NAMES = corpusNames();

describe('the sweep reads both sides', () => {
  it('derives the corpus names from the pins', () => {
    assert.ok(NAMES.some(n => /locomo/i.test(n)), `expected the pinned corpora, got ${NAMES.join(', ')}`);
    assert.ok(NAMES.some(n => /longmemeval/i.test(n)), `expected the pinned corpora, got ${NAMES.join(', ')}`);
  });

  it('and the files it polices are really there', () => {
    for (const f of PRODUCT_FACING) {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      assert.ok(text.length > 200, `${f} is too short to be the instruction it is supposed to be`);
    }
  });
});

describe('no product-facing instruction names a benchmark corpus', () => {
  it('not in the prompt, not in the purpose, not in the usage notes', () => {
    const offenders = [];
    for (const f of PRODUCT_FACING) {
      const lines = readFileSync(join(REPO_ROOT, f), 'utf8').split(/\r?\n/);
      for (const name of NAMES) {
        const hit = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        lines.forEach((line, i) => {
          if (hit.test(line)) offenders.push(`${f}:${i + 1} names the corpus '${name}'`);
        });
      }
    }
    assert.deepEqual(offenders, [],
      'a rule read by everybody who ingests anything is justified by a benchmark corpus:\n  '
      + offenders.join('\n  ')
      + '\n\nThe rule is probably right — the REASON is what leaks. State why it is true of a support '
      + 'history or an agent transcript, and leave the measurement in the changelog and the tracker, where '
      + 'a number about a corpus belongs.');
  });
});
