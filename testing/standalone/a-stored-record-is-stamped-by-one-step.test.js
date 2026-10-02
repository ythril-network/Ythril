/**
 * A record that is already stored and has no retention stamp is stamped by ONE step, `retentionStamps`
 * (`brain/ttl.ts`) — from its own `createdAt`, through its type field, into `_expireAt` / `_contentExpireAt`.
 *
 * ## The rule
 *
 * The arrival writer (D-9: an arrival with no receiver stamp) and the schema backfill (`backfillTypedExpiry`) each
 * spelled that step: parse `createdAt`, find the type by `TYPE_FIELD`, call `recordExpiry` and
 * `recordContentExpiry`, keep the defined ones. Two copies of "from the record's own creation time" is how one of
 * them comes to use `now`. Each caller keeps its own POLICY — the `space` it passes and the records it hands over —
 * and shares the step. The create path (`expiryForCreate`) dates from now on purpose and is a different question.
 *
 * So `recordExpiry` and `recordContentExpiry` are called from their own module and `brain/ttl.ts` only, derived
 * over every source with a floor.
 *
 * Seen red by mutation, restored by hand: `recordExpiry` called inline again in the arrival writer.
 *
 * Run: node --test testing/standalone/a-stored-record-is-stamped-by-one-step.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const HOME = new Set(['server/src/brain/chrono-retention.ts', 'server/src/brain/ttl.ts']);
const SOURCES = readTrackedSources('server/src', { ext: ['.ts'], floor: 200, specs: false, untracked: true })
  .map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), code: stripComments(text) }));
const of = (f) => SOURCES.find(s => s.file === f)?.code ?? '';

describe('a stored record is stamped by one step', () => {
  it('the step exists, and both callers use it (floor)', () => {
    assert.match(of('server/src/brain/ttl.ts'), /export function retentionStamps\(/, 'retentionStamps is gone');
    assert.match(of('server/src/sync/arrivals.ts'), /retentionStamps\(space, recordType, doc\)/,
      'the arrival writer no longer stamps through the shared step');
    assert.match(of('server/src/brain/chrono-redaction.ts'), /retentionStamps\(space, collection, r\)/,
      'the schema backfill no longer stamps through the shared step');
  });

  it('nobody else computes a stamp from the retention resolvers', () => {
    const elsewhere = SOURCES.filter(s => !HOME.has(s.file) && /\brecord(?:Content)?Expiry\s*\(/.test(s.code)).map(s => s.file);
    assert.deepEqual(elsewhere, [], 'a second copy of the stamping step: call retentionStamps with your own policy');
  });
});
