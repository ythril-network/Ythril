/**
 * Every refusal code the conversion doors answer is named on the page that documents them, and the start's rate limit is stated on both pages a
 * caller reads it from (`Q-746`, `Q-919`, bundle-284 fix round after the lens sweep: S7).
 *
 * ## What it prevents
 *
 * `POST /api/spaces/:id/schema-convert` and `space_schema_convert` refuse a start over the heavy-call allowance with `429 schema_convert_rate_limited`;
 * the tool's description said so, the refusal table of `docs/integration-guide/06e-converting-records.md` and the tool's row in
 * `docs/integration-guide/16-mcp.md` did not, so a caller reading the docs met a 429 nothing told it about. The codes are read from the acts'
 * closed lists (`SCHEMA_CONVERT_REFUSAL_CODES`, `UNCONVERTED_REFUSAL_CODES`), never listed here, so a code added to a door fails this until the
 * page names it.
 *
 * Run: node --test testing/standalone/every-conversion-refusal-code-is-in-the-converting-records-page.test.js  (requires a prior server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync('docs/integration-guide/06e-converting-records.md', 'utf8');
const mcp = readFileSync('docs/integration-guide/16-mcp.md', 'utf8');
const { SCHEMA_CONVERT_REFUSAL_CODES } = await import('../../server/dist/spaces/schema-convert-terms.js');
const { UNCONVERTED_REFUSAL_CODES } = await import('../../server/dist/spaces/unconverted-terms.js');

describe('every conversion refusal code is on the converting-records page', () => {
  it('the lists are read, not empty', () => {
    assert.ok(SCHEMA_CONVERT_REFUSAL_CODES.length >= 3 && UNCONVERTED_REFUSAL_CODES.length >= 1);
  });

  for (const code of [...new Set([...SCHEMA_CONVERT_REFUSAL_CODES, ...UNCONVERTED_REFUSAL_CODES])]) {
    it(`${code} is named on 06e-converting-records.md`, () => {
      assert.ok(page.includes(`\`${code}\``), `the converting-records page does not name the refusal \`${code}\``);
    });
  }

  it('the start\'s rate limit is stated with its status on 06e and on the tool\'s row in 16-mcp.md', () => {
    assert.match(page, /429[^\n]*schema_convert_rate_limited|schema_convert_rate_limited[^\n]*429/, '06e does not give the 429 of the start');
    const row = mcp.split('\n').find(l => l.startsWith('| `space_schema_convert` |'));
    assert.ok(row, 'the space_schema_convert row of 16-mcp.md was not found');
    assert.match(row, /schema_convert_rate_limited/, 'the tool\'s row in 16-mcp.md does not name the rate limit');
  });
});
