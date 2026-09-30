/**
 * A request past a capability's cap is refused, not served smaller without a word (`Q-109`).
 *
 * Two acts both doors call quietly adjusted what they were sent: `network_sync_history` clamped a `limit` of 500 to
 * 100 and let a negative through to the read, and a bulk write SLICED every array past 500 — the items after it were
 * dropped and the answer was the same 207 as a clean batch, naming no error for them.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-cap-is-refused-not-applied-quietly.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const { syncHistoryAct } = await import('../../server/dist/networks/vote-acts.js');
const { bulkSizeRefusal, BULK_MAX_PER_TYPE } = await import('../../server/dist/brain/bulk.js');

describe('network_sync_history', () => {
  for (const limit of [500, 0, -3, 1.5, 'abc', '101']) {
    it(`refuses limit ${JSON.stringify(limit)}`, async () => {
      const r = await syncHistoryAct('any', limit);
      assert.equal(r.status, 400, JSON.stringify(r));
      assert.match(r.error, /limit/);
    });
  }
});

describe('a bulk write', () => {
  it('refuses an array past the cap, naming it, instead of dropping the rest', () => {
    const facts = Array.from({ length: BULK_MAX_PER_TYPE + 1 }, (_, i) => ({ fact: `f${i}` }));
    const why = bulkSizeRefusal({ facts });
    assert.ok(why, `${BULK_MAX_PER_TYPE + 1} facts were accepted`);
    assert.match(why, /facts/);
    assert.equal(bulkSizeRefusal({ facts: facts.slice(1) }), null, 'exactly the cap is a batch');
  });

  it('the shared writer refuses too, so no door can reach the old cut', () => {
    const src = stripComments(readFileSync('server/src/brain/bulk.ts', 'utf8'));
    assert.match(bodyOf(src, 'bulkWrite'), /bulkSizeRefusal\(/, 'bulkWrite no longer checks the size itself');
    assert.doesNotMatch(src, /\.slice\(0, BULK_MAX_PER_TYPE\)/, 'the silent slice is back');
  });
});
