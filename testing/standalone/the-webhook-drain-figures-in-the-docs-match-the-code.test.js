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
 * lead and not by a line number, with a floor of exactly one (zero would let every check below pass on nothing, two would make "the" sentence ambiguous). The four figures
 * are `RETRY_BATCH`, the retry interval (`RETRY_POLL_INTERVAL_MS`, in seconds), `RETRY_CONCURRENCY` and the per-subscription cap (`RETRY_PER_KEY`), each an export of
 * `dist/webhooks/dispatcher.js`. A figure is present when its number appears in the bullet; the four are checked as a multiset of the bullet's numbers, so a figure that two
 * of them share must appear twice.
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
 * The figures that `text` does not carry: each figure must be one of the text's numbers, a figure that two share (same value) twice. THE rule; the doc is only its input.
 * @param {string} text  the drain sentence
 * @param {Record<string, number>} figures  name to value
 */
function missingFigures(text, figures) {
  const pool = numbersOf(text);
  const missing = [];
  for (const [name, value] of Object.entries(figures)) {
    const at = pool.indexOf(value);
    if (at < 0) missing.push(name); else pool.splice(at, 1);
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
    };
  });

  it('the dispatcher exports the four figures, as positive whole numbers', () => {
    for (const [name, value] of Object.entries(figures)) {
      assert.ok(Number.isInteger(value) && value > 0, `${name} is ${String(value)}: the dispatcher does not export it as a positive whole number (the interval is read in whole seconds)`);
    }
    assert.ok(figures.RETRY_PER_KEY <= figures.RETRY_CONCURRENCY, 'the per-subscription cap is above the pool: it would cap nothing');
  });

  it('every figure the dispatcher runs with is in the drain sentence', () => {
    const [sentence] = drainBullets(doc);
    assert.ok(sentence, 'the doc has no drain sentence');
    const missing = missingFigures(sentence, figures);
    assert.deepEqual(missing, [], `the drain sentence of ${DOC} does not state ${missing.join(', ')} as the code runs with it (${JSON.stringify(figures)})`);
  });

  for (const name of ['RETRY_BATCH', 'RETRY_POLL_INTERVAL_S', 'RETRY_CONCURRENCY', 'RETRY_PER_KEY']) {
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
