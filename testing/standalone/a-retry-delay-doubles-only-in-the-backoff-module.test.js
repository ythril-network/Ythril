/**
 * A delay that doubles per attempt is computed in `util/backoff.ts` and nowhere else in the server source.
 *
 * ## The defect it prevents
 *
 * `util/backoff.ts` is the one backoff: `backoffDelayMs` doubles a base per attempt up to a cap AND scatters the result, so
 * failures that happen together do not retry together, and `nominalBackoffMs` is the same schedule before the scatter for a
 * caller that must be repeatable. A second doubling written beside it (`1_000 * 2 ** attempt` handed to `sleep`, in
 * `util/model-chat.ts`) has the cap, the clamp and the scatter of whoever wrote it: this one had none of the scatter, so every
 * caller that failed in the same second retried in the same second. `retry-jitter.test.js` reads two named files; this reads
 * every one.
 *
 * ## What it holds
 *
 * Every tracked, non-test `.ts` file under `server/src` (comments blanked, line numbers kept) is read for a DOUBLING: a power of
 * two (`2 ** n`, `Math.pow(2, n)`, `1 << n`) or a delay that is multiplied by two and assigned back to itself (`x *= 2`,
 * `x = min(x * 2, cap)`). A doubling counts only when it is a delay: its statement names one (an identifier ending in
 * `Ms`, `Delay`, `Backoff`, `Interval`, `Timeout` or `Wait`, a `*_MS` constant, or the arguments of `sleep(` / `setTimeout(` /
 * `waitForWork(`), or, for a self-doubling, the variable that doubles does. A bit shift in an address, a byte count times two, a
 * budget doubled once for a fallback and `2 ** 40` as a ceiling are not delays and are not read as one.
 *
 * The rule over that set: a delay doubling outside `util/backoff.ts` is either one of the reasoned exemptions below or a
 * failure naming `file:line`. Three things keep the gate honest, because a rule that reads nothing passes:
 *
 *  - POSITIVE CONTROL: the doubling inside `util/backoff.ts` is FOUND. A scan that cannot see the home cannot see a copy.
 *  - FLOOR: the scan read at least `FILES_FLOOR` files.
 *  - Every exemption is FOUND, so one cannot outlive the code it excuses.
 *
 * The detector is also exercised on synthetic source, so a weakening of any pattern fails here.
 *
 * Run: node --test testing/standalone/a-retry-delay-doubles-only-in-the-backoff-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';
import { statementAround } from './_structural-window.mjs';

const HOME = 'server/src/util/backoff.ts';
/** `server/src` holds several hundred files; a listing under this means the scan broke. */
const FILES_FLOOR = 300;

/**
 * Doublings that are not a retry's backoff, each found by file and variable so it cannot outlive its code.
 * `variable` is the delay that doubles.
 */
const EXEMPT = [
  {
    file: 'server/src/files/media/slot-pool.ts',
    variable: 'currentPollMs',
    why: 'an IDLE POLL interval, not a retry: it stretches while the queue is empty, is woken early by `waitForWork`, and snaps back '
      + 'to the fast interval the moment work arrives. Nothing failed, so there is no group of failures to scatter.',
  },
];

const DELAY_NAME = /\b(?:ms|delay|backoff|interval|timeout|wait)\b|\b[A-Za-z_]\w*(?:Ms|Delay|Backoff|Interval|Timeout|Wait)\b|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:MS|DELAY|BACKOFF|INTERVAL|TIMEOUT)\b|\b(?:sleep|setTimeout|waitForWork|delay)\s*\(/;
const delayNamed = (s) => new RegExp(DELAY_NAME.source).test(s);

/** A power of two, in the three spellings the language has. */
const powerOfTwo = () => /(?<![\w.])2\s*\*\*|\bMath\.pow\(\s*2\s*,|(?<![\w.])1\s*<<\s*[\w(]/g;
/** `x *= 2`, `x = ... x * 2 ...` and `x = ... 2 * x ...`, with the variable captured. */
const selfDoubling = () => /\b(\w+)\s*\*=\s*2\b(?![\w.])|\b(\w+)\s*(?<![=!<>])=(?!=)[^;=]*?\b(?:\2\s*\*\s*2\b(?![\w.])|2\s*\*\s*\2\b)/g;

/** Every delay doubling in one source: `{ line, text, variable? }`, lines of the ORIGINAL (comments are blanked, not removed). */
function delayDoublings(source) {
  const src = blankComments(source);
  const lineOf = (at) => src.slice(0, at).split('\n').length;
  const hits = [];
  for (const m of src.matchAll(powerOfTwo())) {
    const text = statementAround(src, m.index, 'a power of two').replace(/\s+/g, ' ').trim();
    if (delayNamed(text)) hits.push({ line: lineOf(m.index), text });
  }
  for (const m of src.matchAll(selfDoubling())) {
    const variable = m[1] ?? m[2];
    if (!delayNamed(variable)) continue;
    hits.push({ line: lineOf(m.index), text: statementAround(src, m.index, 'a self-doubling').replace(/\s+/g, ' ').trim(), variable });
  }
  return hits;
}

describe('a retry delay doubles only in the backoff module', () => {
  it('finds a power of two and a self-doubling that are delays, and nothing that is not', () => {
    assert.equal(delayDoublings('async function f(n) {\n  await transport.sleep(1_000 * 2 ** n);\n}\n')[0]?.line, 2);
    assert.equal(delayDoublings('const retryDelayMs = Math.pow(2, attempt) * 100;\n').length, 1);
    assert.equal(delayDoublings('const waitMs = (1 << attempt) * 50;\n').length, 1);
    const stretch = delayDoublings('function g() {\n  currentPollMs = Math.min(currentPollMs * 2, maxPollMs);\n}\n');
    assert.deepEqual(stretch.map(h => [h.line, h.variable]), [[2, 'currentPollMs']]);
    assert.equal(delayDoublings('let backoff = 1;\nbackoff *= 2;\n').length, 1);
    // not delays
    assert.deepEqual(delayDoublings('const SEQ_CEILING_RESERVE = 2 ** 40;\nconst a = (h[6]! << 16) | h[7]!;\nconst n = samples * 2;\n'), []);
    assert.deepEqual(delayDoublings('const budgetMs = hasFallback ? legMs * 2 : legMs;\nreturn legMs === undefined ? undefined : legMs * 2;\n'), []);
    assert.deepEqual(delayDoublings('holdMarginMs: 2 * 60_000,\n'), []);
    // a comment is not a doubling
    assert.deepEqual(delayDoublings('// await sleep(1_000 * 2 ** attempt)\n/* delayMs *= 2 */\nconst x = 1;\n'), []);
  });

  const sources = readTrackedSources(['server/src'], { floor: FILES_FLOOR, specs: false });
  const found = sources.flatMap(({ file, text }) => delayDoublings(text).map(h => ({ file, ...h })));

  it('reads the server source and sees the doubling inside the home module (positive control)', () => {
    assert.ok(sources.length >= FILES_FLOOR, `only ${sources.length} files read`);
    assert.ok(found.some(h => h.file === HOME && /baseMs\s*\*\s*2\s*\*\*/.test(h.text)),
      `the doubling in ${HOME} was not found: the scan cannot see a copy either`);
  });

  it('every reasoned exemption is still found, in its file and on its variable', () => {
    for (const e of EXEMPT) {
      assert.ok(found.some(h => h.file === e.file && h.variable === e.variable),
        `${e.file} no longer doubles \`${e.variable}\`: delete the exemption, or the file was renamed and the exemption is excusing nothing`);
      assert.ok(e.why.length > 40, `${e.file}: an exemption states its reason`);
    }
  });

  it('no delay doubles outside util/backoff.ts except the reasoned exemptions', () => {
    const stray = found.filter(h => h.file !== HOME && !EXEMPT.some(e => e.file === h.file && e.variable === h.variable));
    assert.deepEqual(stray, [], `a delay is doubled outside ${HOME}; use backoffDelayMs (or nominalBackoffMs where the figure must repeat):\n`
      + stray.map(h => `  ${h.file}:${h.line}  ${h.text.slice(0, 140)}`).join('\n'));
  });
});
