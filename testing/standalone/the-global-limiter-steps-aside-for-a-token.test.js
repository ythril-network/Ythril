/**
 * A per-token rate limit above 300/min can actually take effect.
 *
 * ## The defect
 *
 * `rateLimitPerMinute` is a real per-token field: validated once for both doors by `rateLimitRefusalResponse`, with
 * `YTHRIL_RATE_LIMIT_PER_MINUTE` as an instance ceiling, and enforced by `tokenRateLimit` — which IS mounted,
 * inside `requireAuth`, where the token record finally exists to read the number off.
 *
 * `globalRateLimit` was never moved. It stayed a literal `max: 300` on 171 routes, and
 * `clientRateLimitKey` keys it on a **hash of the presented credential** — so a token got its own 300 bucket
 * there, and the effective limit was `min(300, whatever was set)`. Granting 1 000 changed nothing, while
 * `GET /api/tokens` reported `rateLimitEffective: 1000`.
 *
 * Three numbers for one quota: what an admin set, what the API echoed, and what was enforced.
 *
 * ## The decision, and why it does not weaken anything
 *
 * Owner, 2026-08-30: the global limiter **steps aside once a credential is presented**, leaving the per-token
 * quota as the only limit on authenticated traffic — which is what that quota was built to be.
 *
 * It cannot literally wait for the token to RESOLVE: it runs pre-auth by mount order, and `attachToken`'s own
 * docblock says the limit *"cannot be applied any earlier than this"* because until the record is resolved
 * there is nothing to read it from. So the test is the credential, and the two outcomes are both covered:
 *
 *  - it resolves → `tokenRateLimit` governs, with the number the operator actually set;
 *  - it does not → `requireAuth` answers 401, and a FLOOD of invented credentials is exactly what
 *    `ipFloodBackstop` exists for. Its own docblock: *"every distinct bearer string mints a fresh bucket, so
 *    a flood of random credentials would never hit a limit. This limiter closes that."*
 *
 * That last point is what makes this safe rather than a trade: `globalRateLimit` never bounded a rotating
 * attacker either, because it is keyed per credential too. It only ever bounded the honest caller.
 *
 * ## What 4.0 had to fix about it
 *
 * The skip made the definition of "a credential" load-bearing, and that definition used to include a raw
 * `?token=` query parameter — needed while the MCP SSE transport authenticated that way. Nothing checked
 * that parameter, so `?token=anything` was enough to switch the limiter off and drop an anonymous caller
 * onto the flood backstop instead. Removing the SSE transport removed the fallback, and the case below
 * pins the two together: a rate-limit skip must never be reachable by something that fails authentication.
 *
 * Run: node --test testing/standalone/the-global-limiter-steps-aside-for-a-token.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));
const MW = () => src('server/src/rate-limit/middleware.ts');

describe('the global limiter steps aside for a credential', () => {
  it('it skips when one is presented', () => {
    const body = bodyOf(MW(), 'globalRateLimit');
    assert.match(body, /skip:/, 'globalRateLimit has no skip, so it still caps every authenticated caller');
    assert.match(body, /hasCredential\(/,
      'the skip must test for a presented credential, which is the only thing knowable this early');
  });

  it('the credential test is the one the KEY already uses, not a second reading of the request', () => {
    /*
     * `clientRateLimitKey` already decides what counts as a credential. A second copy of that rule here
     * would be the defect this repo produces most — and because the skip is what lets a caller off the 300
     * cap, the copy that is wrong decides who is limited.
     */
    const mw = MW();
    assert.match(mw, /export function hasCredential\(/,
      'the rule must be named and shared, not inlined into the skip');
    const key = bodyOf(mw, 'clientRateLimitKey');
    assert.match(key, /hasCredential\(|credential/,
      'the key builder and the skip must agree on what a credential is');
    // The rule itself lives in `presentedCredential`; `hasCredential` is its boolean form and must DELEGATE
    // rather than re-read the request, or the two answers can differ.
    assert.match(bodyOf(mw, 'hasCredential'), /presentedCredential\(/,
      'hasCredential reads the request itself, so it can disagree with the key builder');
  });

  it('a credential is a HEADER — a ?token= must not turn the skip on', () => {
    /*
     * This case asserted the OPPOSITE until 4.0. `presentedCredential` had to read the `token` query
     * parameter, because the MCP SSE transport authenticated that way and omitting it would have capped
     * every MCP client at 300.
     *
     * Put that together with the skip above and it was a hole rather than a design: a request presenting a
     * credential is not limited by `globalRateLimit`, and the credential test accepted an UNAUTHENTICATED
     * query string. So `?token=anything` on any request moved an anonymous caller off the 300/min limit and
     * onto the 3000/min flood backstop — a tenfold amplification, bounded but free.
     *
     * 4.0 removed the SSE transport and the URL-credential fallback with it (see
     * `no-credential-travels-in-a-url.test.js`), so this is the assertion that keeps the two decisions
     * consistent: nothing that fails authentication may switch off a rate limit.
     */
    assert.doesNotMatch(bodyOf(MW(), 'presentedCredential'), /query/,
      'the skip would be reachable with an unauthenticated query parameter — no route accepts one since 4.0');
  });

  it('and an ANONYMOUS request is still capped', () => {
    // The other direction. Login, setup and an anonymous probe have no identity but their IP, and the global
    // limiter is what bounds them. Skipping unconditionally would remove the only limit they have.
    const body = bodyOf(MW(), 'globalRateLimit');
    assert.doesNotMatch(body, /skip:\s*\(\)\s*=>\s*true/, 'the limiter must still apply without a credential');
    assert.match(body, /max: 300/, 'the anonymous cap is unchanged');
  });

  it('the flood backstop is untouched — it is what makes this safe', () => {
    /*
     * `globalRateLimit` never bounded a rotating attacker: it is keyed per credential, so every invented
     * bearer string already minted a fresh bucket. The backstop is keyed purely on the IP and exists for
     * exactly that. If it ever gains a credential skip, this change becomes a real hole.
     */
    const body = bodyOf(MW(), 'ipFloodBackstop');
    assert.doesNotMatch(body, /hasCredential/,
      'the backstop must NOT step aside for a credential — it is the bound on inventing them');
    assert.match(body, /max: 3000/, 'the backstop is unchanged');
  });
});

describe('what a token is granted is what it gets', () => {
  it('the per-token limiter still reads the record', () => {
    // Unchanged, and asserted so a future edit cannot quietly make the skip above the whole mechanism.
    assert.match(bodyOf(MW(), 'tokenRateLimit'), /resolveLimitFor\(/,
      'the per-token limit must still come from the resolved record');
  });

  it('a token that was granted NOTHING sees the same number as before', async () => {
    /*
     * The guarantee that makes this invisible to every existing deployment, and it is not a coincidence:
     * `DEFAULT_PER_MINUTE` was deliberately kept equal to `globalRateLimit`'s max, so a token with no
     * `rateLimitPerMinute` and an instance with no `YTHRIL_RATE_LIMIT_PER_MINUTE` resolves to exactly the
     * number the global limiter used to impose.
     *
     * So the cap only LIFTS where somebody explicitly granted more — which is the whole defect — and the
     * Docker gate that bursts 300 requests with a bearer token still gets its 429, from the other limiter.
     */
    const { DEFAULT_PER_MINUTE, resolveLimitFor } = await import('../../server/dist/rate-limit/per-token.js');
    const mw = MW();
    const globalMax = /max: (\d+)/.exec(bodyOf(mw, 'globalRateLimit'))?.[1];
    assert.equal(Number(globalMax), DEFAULT_PER_MINUTE,
      'the two numbers have drifted, so this change silently moves the limit for every ungranted token');
    assert.equal(resolveLimitFor(undefined), DEFAULT_PER_MINUTE);
    assert.equal(resolveLimitFor({}), DEFAULT_PER_MINUTE);
  });

  it('and the docs no longer describe two limiters on one request', () => {
    /*
     * `03-auth-and-limits.md` said *"In practice you may see a 429 from either"*, and stated the resolution
     * order as token → instance → 300 with no hint that 300 also capped the first two. Both are now false.
     */
    const doc = readFileSync('docs/integration-guide/03-auth-and-limits.md', 'utf8').replace(/\s+/g, ' ');
    assert.doesNotMatch(doc, /In practice you may see a 429 from either/,
      'the guide still tells a caller both limiters apply to their authenticated request');
    assert.match(doc, /steps aside|stands aside|no longer applies/i,
      'the guide must say what the global limiter does once a credential is presented');
  });
});
