/**
 * The integration guide says what the per-address flood backstop counts, in both places it describes it (Q-693, bundle-233).
 *
 * ## The defect
 *
 * `docs/integration-guide/03-auth-and-limits.md` described the backstop twice, and both were the old rule: the limits table said it
 * counts *"Everything except /health, /ready, /metrics"*, and the paragraph under the table said it *"does not step aside for
 * anything"*. Since bundle-233 it steps aside for exactly one thing: a request a valid token's own limiter metered
 * (`res.locals.meteredByToken === true`). A guide that still says "everything" sends an operator whose three busy tokens sit behind one
 * gateway to the wrong number, and one that says "anything" contradicts the per-token row two lines above it.
 *
 * ## What it holds
 *
 *  - the table row names the number the code has (read from `ipFloodBackstop`, never typed here) and says a request a token's own limit
 *    meters is not counted, and no longer says "Everything except";
 *  - the paragraph beneath it no longer says it steps aside for nothing, and says the same rule;
 *  - the sentence that tells a caller what to do about a proxy (`TRUST_PROXY`) is still there, since the count is per address.
 *
 * The anchors are the table row's own first cell and the paragraph's own bold lead, so a re-ordered guide is found, not skipped.
 *
 * Run: node --test testing/standalone/the-integration-guide-says-what-the-flood-backstop-counts.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const GUIDE = 'docs/integration-guide/03-auth-and-limits.md';
const guide = () => readFileSync(GUIDE, 'utf8');

/** The number the code enforces, read from the build's source. */
const max = Number(/max:\s*(\d+)/.exec(bodyOf(stripComments(readFileSync('server/src/rate-limit/middleware.ts', 'utf8')), 'ipFloodBackstop'))?.[1]);

/** The row of the limits table whose first cell is `Flood backstop`. */
function tableRow() {
  const row = guide().split(/\r?\n/).find(l => /^\|\s*Flood backstop\s*\|/.test(l));
  assert.ok(row, `${GUIDE} has no limits-table row whose first cell is "Flood backstop": re-anchor this gate`);
  return row.replace(/\s+/g, ' ');
}

/** The paragraph that opens with the bold "flood backstop" lead, to the next blank line. */
function paragraph() {
  const text = guide().replace(/\r\n/g, '\n');
  const at = text.search(/The \*\*flood backstop\*\*/);
  assert.ok(at > -1, `${GUIDE} has no paragraph opening "The **flood backstop**": re-anchor this gate`);
  const end = text.indexOf('\n\n', at);
  return text.slice(at, end === -1 ? undefined : end).replace(/\s+/g, ' ');
}

/** What each sentence must say: the number, then the one request that is not counted. */
const NUMBER = new RegExp(`\\b${String(max).replace(/(\d)(?=(\d{3})$)/, '$1[ ,\\u202f\\u00a0]?')}\\b`);
const NOT_COUNTED = /(?:not counted|never counted|does not count|doesn.t count|steps? aside|left out|not included)[^|]*\b(?:token|metered|own limit|own quota)/i;
const METERED_FIRST = /\b(?:token|metered)\b[^|]*(?:not counted|never counted|does not count|steps? aside|left out|not included)/i;

describe('the guide states the flood backstop\'s rule', () => {
  it('the number is the code\'s', () => {
    assert.equal(max, 3000, 'the backstop number was not read from the source');
    assert.match(tableRow(), NUMBER, 'the limits-table row states a number other than the one the backstop enforces');
  });

  it('the limits-table row says a request a token\'s own limit meters is not counted, not "everything"', () => {
    const row = tableRow();
    assert.doesNotMatch(row, /Everything except/i,
      'the row still says the backstop counts everything except the probes: it does not count a request a valid token\'s own limiter metered');
    assert.ok(NOT_COUNTED.test(row) || METERED_FIRST.test(row),
      `the row does not say that a request a token's own limit meters is not counted: ${row}`);
  });

  it('the paragraph does not say it steps aside for nothing, and says the same rule', () => {
    const p = paragraph();
    assert.doesNotMatch(p, /does not step aside for anything/i, 'the paragraph still says the backstop never steps aside');
    assert.doesNotMatch(guide().replace(/\s+/g, ' '), /does not step aside for anything/i,
      'a second place in the guide still says the backstop steps aside for nothing');
    assert.ok(NOT_COUNTED.test(p) || METERED_FIRST.test(p),
      `the paragraph does not say that a request a token's own limit meters is not counted: ${p}`);
    assert.match(p, /address|\bIP\b/i, 'the paragraph does not say the count is per address');
  });

  it('the proxy sentence under it is still there: the count is per address, so a proxy needs TRUST_PROXY', () => {
    // The note is one blockquote: its own `>` lines, bounded by the first line that is not one.
    const lines = guide().split(/\r?\n/);
    const start = lines.findIndex(l => l.includes('Behind a reverse proxy, set `TRUST_PROXY`'));
    assert.ok(start >= 0, 'the TRUST_PROXY note is gone');
    let end = start;
    while (end + 1 < lines.length && /^>/.test(lines[end + 1])) end++;
    const note = lines.slice(start, end + 1).join(' ').replace(/>\s?/g, ' ').replace(/\s+/g, ' ');
    assert.match(note, /flood backstop/, 'the TRUST_PROXY note no longer names the flood backstop');
  });
});
