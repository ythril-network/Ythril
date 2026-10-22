/**
 * The drain figures integration guide 14 states for the webhook retry queue are the figures the dispatcher runs with (bundle-169, Q-483; design rev 3.2, N9).
 *
 * ## What it prevents
 *
 * Doc 14 tells an integrator how fast queued retries drain: how many due rows a tick takes, how often a tick runs, how many deliveries run at once and how many of
 * those one subscription may hold. Those are four constants in `webhooks/dispatcher.ts`, and a sentence that copies a constant is a second copy of a fact the code already
 * holds: change the batch from 50 to 100 and the page keeps promising the old drain rate, to the one reader who plans around it. This gate reads the four figures out of
 * the BUILT module, never from a list in the test, and finds each in the doc's drain sentence.
 *
 * ## The rule, and how the sentence is found
 *
 * The drain sentence is the one bullet of the doc whose bold lead names both retries and the drain (`- **Queued retries drain at a stated rate.** ...`): found by that
 * lead and not by a line number, with a floor of exactly one (zero would let every check below pass on nothing, two would make "the" sentence ambiguous). The figures
 * are `RETRY_BATCH`, the retry interval (`RETRY_POLL_INTERVAL_MS`, in seconds), `RETRY_CONCURRENCY`, the per-subscription cap (`RETRY_PER_KEY`) and the tick's budget
 * (`RETRY_TICK_BUDGET_MS`, in seconds), each an export of `dist/webhooks/dispatcher.js`. A figure is present only as its number directly before its own words
 * (`UNIT_OF`: "50 due retries", "30 seconds after it began"), so another number of the sentence that happens to equal it cannot stand in for it.
 *
 * ## Seen red, in memory
 *
 * The rule is a pure function (`missingFigures`) and its red is shown on a COPY of the doc's bullet held in memory, with one figure changed at a time: never the repo file,
 * and never by editing a constant. For each of the four figures the changed copy must be reported as missing exactly that figure.
 *
 * ## Red at base, and which assertion proves the rule
 *
 * At base the doc has no drain sentence (`exactly one bullet of the doc is the drain sentence` fails: red by the rule where the doc exists) and the constants are not all exported
 * (`RETRY_BATCH`, `RETRY_POLL_INTERVAL_MS` and `RETRY_PER_KEY` are not, so `the dispatcher exports the four figures` fails by the missing exports). Once both exist the assertion
 * that proves the rule is `every figure the dispatcher runs with is in the drain sentence`, and the mutation cases prove it can fail.
 *
 * The export names are this test's reading of the design ("exported for it"); a build that names them otherwise is a rename of this file's four constants, not a reason to loosen it.
 *
 * Run: node --test testing/standalone/the-webhook-drain-figures-in-the-docs-match-the-code.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = 'docs/integration-guide/14-duplicates-and-webhooks.md';
const doc = readFileSync(join(process.cwd(), DOC), 'utf8').replace(/\r\n/g, '\n');

/** The bullets of the doc: a line starting `- ` with its continuation lines (indented, or not blank and not another bullet or a rule). */
function bullets(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) { if (current) out.push(current); current = line; continue; }
    if (current && line.trim() !== '' && !/^(#|---|```)/.test(line)) { current += `\n${line}`; continue; }
    if (current) { out.push(current); current = null; }
  }
  if (current) out.push(current);
  return out;
}
const leadOf = (bullet) => /^- \*\*([^*]+)\*\*/.exec(bullet)?.[1] ?? '';
/** The drain sentence: a bullet whose bold lead names retries and the drain. */
const drainBullets = (text) => bullets(text).filter(b => /retr/i.test(leadOf(b)) && /drain/i.test(leadOf(b)));

/** The numbers of a text, in order. */
const numbersOf = (text) => [...text.matchAll(/\b\d+\b/g)].map(m => Number(m[0]));
/**
 * The words each figure is written with in the drain sentence: a figure counts only as the number directly before its own words, so another number of
 * the sentence that happens to equal it (a concurrency of 30 against "30 seconds") cannot stand in for it.
 */
const UNIT_OF = {
  RETRY_BATCH: 'due retries',
  RETRY_POLL_INTERVAL_S: 'seconds the server',
  RETRY_CONCURRENCY: 'at a time',
  RETRY_PER_KEY: 'for any one subscription',
  RETRY_TICK_BUDGET_S: 'seconds after it began',
};
/**
 * The figures that `text` does not carry: each figure must appear as its number followed by its own words (`UNIT_OF`). THE rule; the doc is only its input.
 * @param {string} text  the drain sentence
 * @param {Record<string, number>} figures  name to value
 */
function missingFigures(text, figures) {
  const flat = text.replace(/\s+/g, ' ');
  const missing = [];
  for (const [name, value] of Object.entries(figures)) {
    const words = UNIT_OF[name].split(' ').join('\\s+');
    if (!new RegExp(`\\b${value}\\s+${words}\\b`).test(flat)) missing.push(name);
  }
  return missing;
}
/** `text` with every standalone `from` replaced by `to`, so one figure is changed wherever the sentence writes it. */
const withFigureChanged = (text, from, to) => text.replace(new RegExp(`\\b${from}\\b`, 'g'), String(to));

describe('the doc has one drain sentence', () => {
  it('exactly one bullet of the doc is the drain sentence, and it carries numbers', () => {
    const found = drainBullets(doc);
    assert.equal(found.length, 1, `${found.length} bullets of ${DOC} lead with retries and the drain (expected exactly one: the drain rate, the per-subscription cap and the bound)`);
    assert.ok(numbersOf(found[0]).length >= 4, 'the drain sentence states fewer than four figures');
  });

  it('the finder is not vacuous: it reads a bullet\'s lead and its continuation lines, and ignores other bullets', () => {
    const sample = '- **Other.** says 50\n- **Queued retries drain at a stated rate.** 50 rows every 10 s,\n  4 at a time, 2 per subscription.\n\n- **Next.** 7\n';
    const found = drainBullets(sample);
    assert.equal(found.length, 1);
    assert.deepEqual(numbersOf(found[0]), [50, 10, 4, 2]);
  });
});

describe('the drain sentence states the figures the dispatcher runs with', () => {
  let figures;
  before(async () => {
    const m = await import('../../server/dist/webhooks/dispatcher.js');
    figures = {
      RETRY_BATCH: m.RETRY_BATCH,
      RETRY_POLL_INTERVAL_S: m.RETRY_POLL_INTERVAL_MS / 1000,
      RETRY_CONCURRENCY: m.RETRY_CONCURRENCY,
      RETRY_PER_KEY: m.RETRY_PER_KEY,
      RETRY_TICK_BUDGET_S: m.RETRY_TICK_BUDGET_MS / 1000,
    };
  });

  it('the dispatcher exports the drain figures, as positive whole numbers', () => {
    assert.deepEqual(Object.keys(figures).sort(), Object.keys(UNIT_OF).sort(), 'a figure is read without its words in the sentence, or words are kept for a figure that is not read');
    for (const [name, value] of Object.entries(figures)) {
      assert.ok(Number.isInteger(value) && value > 0, `${name} is ${String(value)}: the dispatcher does not export it as a positive whole number (the interval and the budget are read in whole seconds)`);
    }
    assert.ok(figures.RETRY_PER_KEY <= figures.RETRY_CONCURRENCY, 'the per-subscription cap is above the pool: it would cap nothing');
  });

  it('every figure the dispatcher runs with is in the drain sentence', () => {
    const [sentence] = drainBullets(doc);
    assert.ok(sentence, 'the doc has no drain sentence');
    const missing = missingFigures(sentence, figures);
    assert.deepEqual(missing, [], `the drain sentence of ${DOC} does not state ${missing.join(', ')} as the code runs with it (${JSON.stringify(figures)})`);
  });

  it('seen red: a figure written beside the wrong words is reported missing, though the number is in the sentence', () => {
    const [sentence] = drainBullets(doc);
    assert.ok(sentence, 'the doc has no drain sentence');
    const swapped = { ...figures, RETRY_CONCURRENCY: figures.RETRY_TICK_BUDGET_S };
    assert.ok(numbersOf(sentence).includes(swapped.RETRY_CONCURRENCY), 'fixture: the budget figure is not in the sentence');
    assert.deepEqual(missingFigures(sentence, swapped), ['RETRY_CONCURRENCY'], 'a figure matched a number written for another figure');
  });

  for (const name of Object.keys(UNIT_OF)) {
    it(`seen red: ${name} changed in a COPY of the sentence is reported missing, and only it`, () => {
      const [sentence] = drainBullets(doc);
      assert.ok(sentence, 'the doc has no drain sentence to copy');
      assert.deepEqual(missingFigures(sentence, figures), [], 'the unchanged copy must pass first, or "red" proves nothing');
      const changed = withFigureChanged(sentence, figures[name], figures[name] + 1);
      assert.notEqual(changed, sentence, `${name} (${figures[name]}) does not appear in the sentence, so there was nothing to change`);
      assert.deepEqual(missingFigures(changed, figures), [name], `changing ${name} in the sentence was not reported as exactly ${name} missing`);
    });
  }
});
