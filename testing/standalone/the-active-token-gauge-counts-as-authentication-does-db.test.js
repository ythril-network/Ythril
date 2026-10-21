/**
 * `ythril_tokens_active` counts a token as live exactly when authentication does: through `tokenIsLive` (Q-531, bundle-100 row 6).
 *
 * ## The rule
 *
 * A token is live up to and AT its expiry instant (`auth/token-liveness.ts`), and authentication, the view sweep, the revoke cascade and
 * the upgrade read it that way. The gauge wrote its own comparison (`new Date(t.expiresAt) > new Date()`) - a second spelling with its
 * own boundary and its own clock, so the number an operator reads for "active tokens" could disagree with what the instance lets in.
 *
 * The case holds the clock (`Date.now`) at a token's expiry instant, an hour before real time: `tokenIsLive` says live, and the gauge must
 * count it. Seen red at 743562a5: the gauge read the wall clock through `new Date()` and counted one fewer.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), npm run build:server, then
 *      node --test testing/standalone/the-active-token-gauge-counts-as-authentication-does-db.test.js
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openViewDoors } from './_view-doors.mjs';

const skip = await mongoSkipReason();
let d, tokensActive, tokenIsLive;

describe('the active-token gauge counts as authentication does (Q-531)', { skip }, () => {
  before(async () => {
    d = await openViewDoors({ suite: 'b100-token-gauge', spaces: ['tg-space'] });
    ({ tokensActive } = await import('../../server/dist/metrics/registry.js'));
    ({ tokenIsLive } = await import('../../server/dist/auth/token-liveness.js'));
  });
  after(async () => { mock.restoreAll(); await d?.close(); });

  it('a token is counted at its expiry instant', async () => {
    const at = Date.now() - 60 * 60 * 1000;
    const boundary = await d.mint('tg-boundary', {}, { admin: true });
    d.loader.mutateConfig(cfg => { cfg.tokens.find(t => t.id === boundary.id).expiresAt = new Date(at).toISOString(); });
    mock.method(Date, 'now', () => at);
    try {
      const tokens = d.loader.getConfig().tokens;
      assert.ok(tokenIsLive(tokens.find(t => t.id === boundary.id), at), 'the predicate itself says the token is live at its instant');
      const expected = tokens.filter(t => tokenIsLive(t, at)).length;
      const counted = (await tokensActive.get()).values[0]?.value;
      assert.equal(counted, expected, 'ythril_tokens_active disagrees with tokenIsLive about who is live');
    } finally {
      mock.restoreAll();
    }
  });
});
