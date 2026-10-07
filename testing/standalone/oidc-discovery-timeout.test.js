/**
 * Standalone tests: the OIDC discovery fetch is bounded by a timeout.
 *
 * Why this matters more than a normal missing-timeout: `getDiscoveryDoc()` runs on the
 * AUTHENTICATION path, and its result is cached with a TTL — so an IdP that accepts the TCP
 * connection and then never answers does not stall one request, it stalls a request every time the
 * cache expires, each one held until the OS socket timeout (minutes). Every other outbound call in
 * the server already carries an `AbortSignal.timeout`; this one did not.
 *
 * The test drives a real HTTP server that deliberately never responds, so it proves the behaviour
 * end to end rather than asserting that a constant exists.
 *
 * WHY THE BLACK HOLE IS NOT ON LOOPBACK (changed with the SSRF part-2b guard): discovery now goes
 * through `ssrfSafeFetch`, and loopback is a crown-jewel address that stays blocked even with
 * `oidc.allowPrivateIssuer` on. A `127.0.0.1` issuer would therefore be refused before any socket
 * opened and this test would prove nothing about timeouts.
 *
 * That is not a limitation worth working around — an issuer on the *server's* loopback cannot work as
 * OIDC anyway: the browser is sent to the same `authorization_endpoint`, and the browser's 127.0.0.1
 * is not the server's. So the test binds to the host's own private LAN address and opts in, which
 * incidentally makes it an end-to-end proof that `allowPrivateIssuer` really does let an internal IdP
 * through — the half of the change that, if broken, is an upgrade outage.
 *
 * Run: node --test testing/standalone/oidc-discovery-timeout.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { privateHostAddress, privateAddressSkipReason } from './_private-address.mjs';

let getDiscoveryDoc;
let clearOidcCache;
let OIDC_HTTP_TIMEOUT_MS;

/** A server that accepts the connection and then holds it open, answering nothing. */
let blackHole;
let blackHoleHost;
let blackHolePort;
const heldSockets = [];

/** False when this host has a private address to bind; a reason on a laptop without one; a throw on CI. */
const noPrivateAddress = privateAddressSkipReason();

const ENV_KEY = 'YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER';
let savedEnv;

describe('OIDC discovery — timeout', () => {
  before(async () => {
    ({ getDiscoveryDoc, clearOidcCache, OIDC_HTTP_TIMEOUT_MS } = await import(
      '../../server/dist/auth/oidc.js'
    ));

    savedEnv = process.env[ENV_KEY];
    process.env[ENV_KEY] = 'true'; // an internal IdP on a private address — the supported deployment

    blackHoleHost = privateHostAddress();
    if (!blackHoleHost) return; // no LAN address on this host; the tests below skip
    blackHole = http.createServer((req) => {
      // Never write a response, never end it: the classic "hung IdP".
      heldSockets.push(req.socket);
    });
    // own-listener: binds the private LAN address, because the issuer guard blocks loopback
    await new Promise((resolve) => blackHole.listen(0, blackHoleHost, resolve));
    blackHolePort = blackHole.address().port;
  });

  after(async () => {
    for (const s of heldSockets) s.destroy();
    if (blackHole) await new Promise((resolve) => blackHole.close(resolve));
    clearOidcCache?.();
    if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
  });

  it('exposes an explicit, sane HTTP budget', () => {
    assert.equal(typeof OIDC_HTTP_TIMEOUT_MS, 'number');
    assert.ok(
      OIDC_HTTP_TIMEOUT_MS > 0 && OIDC_HTTP_TIMEOUT_MS <= 30_000,
      `expected a bounded budget, got ${OIDC_HTTP_TIMEOUT_MS}ms`,
    );
  });

  it('rejects instead of hanging when the IdP never responds', { skip: noPrivateAddress }, async () => {
    clearOidcCache();
    const started = Date.now();
    await assert.rejects(
      () => getDiscoveryDoc(`http://${blackHoleHost}:${blackHolePort}`),
      (err) => {
        assert.match(err.message, /OIDC discovery failed/);
        // The operator has to be able to tell "it hung" from "it refused" or "it 500'd".
        assert.match(err.message, /no response within \d+ms/);
        return true;
      },
      'a hung IdP must surface as a discovery failure, not an unbounded await',
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < OIDC_HTTP_TIMEOUT_MS * 3,
      `expected the call to give up near ${OIDC_HTTP_TIMEOUT_MS}ms, took ${elapsed}ms`,
    );
  });

  it('reports an unreachable IdP as a discovery failure too', { skip: noPrivateAddress }, async () => {
    clearOidcCache();
    // Port 1: connection refused immediately — the other half of the same failure mode.
    await assert.rejects(
      () => getDiscoveryDoc(`http://${blackHoleHost}:1`),
      /OIDC discovery failed/,
    );
  });

  it('a blocked issuer is reported as blocked, not as "the IdP is down"', async () => {
    clearOidcCache();
    // Still opted in (the env flag is on for this suite) — loopback is refused anyway, and the
    // operator must be able to tell a policy refusal from an unreachable IdP.
    await assert.rejects(
      () => getDiscoveryDoc('http://127.0.0.1:8080/realms/main'),
      (err) => {
        assert.match(err.message, /always-blocked address/);
        assert.doesNotMatch(err.message, /OIDC discovery failed/);
        return true;
      },
    );
  });
});
