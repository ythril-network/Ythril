/**
 * Standalone tests: rate-limit buckets are keyed per CLIENT, not per source IP.
 *
 * Why this is a real bug and not a tuning preference: with no reverse proxy in front
 * (`trustProxy=false`, the default Docker deployment) every request arrives from the Docker gateway
 * address, so an IP-keyed limiter puts EVERY client of the instance into one 300/min bucket. One busy
 * client — or one buggy one, which is exactly what the brain request storm was — then 429s everybody,
 * including the app's own UI.
 *
 * `clientRateLimitKey` derives the bucket from the presented credential instead. It runs BEFORE the auth
 * middleware (that is where the limiters sit in the chain), so it works off the raw bearer rather than
 * `req.authToken`, and it must never leak that credential into a store key or a log line.
 *
 * **Header only, since 4.0.** It also read `?token=` while the MCP SSE transport authenticated that way. With
 * the transport gone, a query-string token is not a credential at all — and a bucket selected by an
 * unauthenticated string is a bucket an anonymous caller can change at will.
 *
 * Run: node --test testing/standalone/rate-limit-client-key.test.js
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let clientRateLimitKey;

/** Minimal Express-request stand-in: only the fields the key generator reads. */
function req({ bearer, token, ip = '::ffff:172.21.0.5' } = {}) {
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
  return {
    ip,
    query: token ? { token } : {},
    get(name) { return headers[name.toLowerCase()]; },
  };
}

describe('clientRateLimitKey', () => {
  before(async () => {
    ({ clientRateLimitKey } = await import('../../server/dist/rate-limit/middleware.js'));
  });

  it('gives two different tokens two different buckets, from the same IP', () => {
    const a = clientRateLimitKey(req({ bearer: 'ythril_aaaaaaaaaaaaaaaa' }));
    const b = clientRateLimitKey(req({ bearer: 'ythril_bbbbbbbbbbbbbbbb' }));
    assert.notEqual(a, b, 'one noisy client must not consume another client’s budget');
  });

  it('gives the same token the same bucket across requests', () => {
    const a = clientRateLimitKey(req({ bearer: 'ythril_stable' }));
    const b = clientRateLimitKey(req({ bearer: 'ythril_stable', ip: '10.9.9.9' }));
    assert.equal(a, b, 'the bucket follows the client, not the source address');
  });

  it('IGNORES a ?token= query parameter, and cannot be escaped by varying one', () => {
    /*
     * This case asserted the opposite until 4.0: the MCP SSE transport authenticated from `?token=`, so the
     * key had to read it or every MCP client would have shared one IP bucket.
     *
     * SSE is removed and no route accepts a URL credential any more, which INVERTS the reasoning. A request
     * carrying `?token=` is unauthenticated, so bucketing by it would let an anonymous caller mint a fresh
     * bucket per request by varying a string nobody checks — and because `globalRateLimit` skips entirely
     * for a request that presents a credential, a bare `?token=anything` moved that caller off the 300/min
     * global limit and onto the per-address flood backstop (which counts it: no token's limit metered it). Bounded
     * by the backstop, so a tenfold step up from the anonymous cap rather than an open door, but free to anyone
     * with a query string.
     */
    const anon = clientRateLimitKey(req());
    assert.equal(clientRateLimitKey(req({ token: 'ythril_mcp' })), anon,
      'a query-string token must not select a bucket — it is not a credential');
    assert.equal(clientRateLimitKey(req({ token: 'ythril_other' })), anon,
      'and varying it must not produce a second bucket, or the IP limit is escapable');
  });

  it('falls back to the IP when no credential is presented', () => {
    const anon = clientRateLimitKey(req());
    assert.match(anon, /^ip:/, 'an anonymous request has no identity but its address');
    assert.notEqual(anon, clientRateLimitKey(req({ ip: '10.1.2.3' })));
  });

  it('never puts the raw credential in the key', () => {
    const secret = 'ythril_super_secret_value_1234567890';
    const key = clientRateLimitKey(req({ bearer: secret }));
    assert.ok(!key.includes(secret), 'the key ends up in store keys and debug output');
    assert.ok(!key.includes('super_secret'), 'not even a fragment of it');
    assert.match(key, /^c:[A-Za-z0-9_-]{22}$/, 'expected a truncated hash, got ' + key);
  });

  it('normalises IPv6 so a client cannot rotate through its own /64', () => {
    const a = clientRateLimitKey(req({ ip: '2001:db8:1:2::1' }));
    const b = clientRateLimitKey(req({ ip: '2001:db8:1:2::beef' }));
    assert.equal(a, b, 'addresses in one /64 belong to one client');
  });
});

describe('callerKeyOf', () => {
  let callerKeyOf;
  before(async () => {
    ({ callerKeyOf, clientRateLimitKey } = await import('../../server/dist/rate-limit/middleware.js'));
  });

  it('is the id of the token attached to the request', () => {
    assert.equal(callerKeyOf({ ...req({ bearer: 'ythril_a' }), authToken: { id: 'tok-1' } }), 'tok-1');
  });

  it('is the id of the record a guard passes when the token is not attached yet, and that record wins', () => {
    assert.equal(callerKeyOf(req({ bearer: 'ythril_a' }), { id: 'tok-2' }), 'tok-2');
    assert.equal(callerKeyOf({ ...req(), authToken: { id: 'attached' } }, { id: 'passed' }), 'passed');
  });

  it('falls back to the client key for a caller with no stored id (an OIDC identity, no token, an empty id)', () => {
    const r = req({ bearer: 'ythril_oidc_like' });
    assert.equal(callerKeyOf({ ...r, authToken: {} }), clientRateLimitKey(r));
    assert.equal(callerKeyOf(r), clientRateLimitKey(r));
    assert.equal(callerKeyOf({ ...r, authToken: { id: '' } }), clientRateLimitKey(r));
  });
});
