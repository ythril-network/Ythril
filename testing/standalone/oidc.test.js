/**
 * Standalone tests: OIDC JWT validation logic
 *
 * Tests the OIDC module in isolation — no live IdP or running Ythril instance
 * required.  Uses the `jose` library to generate a self-signed RSA key pair
 * and sign test JWTs, then validates them via the same JWKS-based path the
 * production code uses.
 *
 * Covers:
 *  - Claim resolution: dot-notation traversal
 *  - Claim evaluation: scalar, array, boolean variants
 *  - JWT sign / verify roundtrip (correct token, expired, wrong audience)
 *  - getOidcConfig() enabled / disabled states
 *  - validateOidcJwt() with a mock IdP (full end-to-end)
 *  - validateOidcJwt() returns null for invalid / disabled OIDC
 *  - claimMapping.requireMatch: true rejects tokens matching no rule
 *
 * WHERE THE MOCK IdP LIVES (changed with the SSRF part-2b issuer guard): the mock binds to the host's
 * **private LAN address**, not `127.0.0.1`, and the suite enables `YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER`.
 * Loopback is a crown-jewel address that stays blocked even with that opt-in on, so a mock on
 * 127.0.0.1 is refused before a socket opens and every end-to-end case below would assert on a `null`
 * that never reached the IdP. Binding to a private address is the supported "internal IdP" shape, so
 * these tests now also prove the opt-in actually works.
 *
 * The suite previously carried `skip: process.platform === 'win32'` for an "ESM drive-letter path
 * limitation". That was stale — verified by running it unskipped on Windows — and it was actively
 * harmful: it hid this entire end-to-end suite from every local run on Windows, which is how a
 * breaking change to it reached CI green-locally. Skipping now depends only on the host having a
 * non-loopback IPv4.
 *
 * Run: node --test testing/standalone/oidc.test.js
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SignJWT,
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  jwtVerify,
} from 'jose';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { privateHostAddress, privateAddressSkipReason } from './_private-address.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_AUTH   = path.resolve(__dirname, '../../server/dist/auth');
const DIST_CONFIG = path.resolve(__dirname, '../../server/dist/config');

/** Where the mock IdP binds — see the note above on why this is not loopback. */
const MOCK_IDP_HOST = privateHostAddress() ?? '127.0.0.1';
// An internal IdP on a private address is exactly what this opt-in exists for.
process.env['YTHRIL_OIDC_ALLOW_PRIVATE_ISSUER'] = 'true';

// ── Key material ──────────────────────────────────────────────────────────

let privateKey, publicJwk, jwkSet;

async function signJwt(claims, options = {}) {
  const {
    issuer = 'https://issuer.example.com',
    audience = 'ythril',
    expiresInSec = 3600,
  } = options;
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSec)
    .setSubject(claims.sub ?? 'user-123')
    .sign(privateKey);
}

// ── Temporary config bootstrap ─────────────────────────────────────────────

const TMP_DIR    = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-oidc-test-'));
const TMP_CONFIG = path.join(TMP_DIR, 'config.json');

function makeOidcConfig(overrides = {}) {
  return {
    enabled: true,
    issuerUrl: 'https://issuer.example.com',
    clientId: 'ythril',
    audience: 'ythril',
    scopes: ['openid', 'profile', 'email'],
    claimMapping: {
      admin:    { claim: 'realm_access.roles', value: 'ythril-admin' },
      readOnly: { claim: 'realm_access.roles', value: 'ythril-readonly' },
      spaces:   { claim: 'ythril_spaces' },
    },
    ...overrides,
  };
}

function writeFullConfig(oidcOverride) {
  const cfg = {
    instanceId: 'test',
    instanceLabel: 'test',
    tokens: [],
    spaces: [],
    networks: [],
  };
  if (oidcOverride !== undefined) cfg.oidc = oidcOverride;
  fs.writeFileSync(TMP_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// ── Claim resolution unit tests (pure JS) ─────────────────────────────────

describe('Claim resolution logic (pure)', () => {
  function resolveClaim(payload, claimPath) {
    const parts = claimPath.split('.');
    let cur = payload;
    for (const part of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }

  function evaluateClaimRule(payload, rule) {
    const val = resolveClaim(payload, rule.claim);
    if (val === undefined || val === null) return false;
    if (rule.value !== undefined) {
      if (Array.isArray(val)) return val.includes(rule.value);
      return val === rule.value;
    }
    if (Array.isArray(val)) return val.length > 0;
    return Boolean(val);
  }

  it('resolves a top-level claim', () => {
    assert.equal(resolveClaim({ sub: 'alice' }, 'sub'), 'alice');
  });

  it('resolves a nested dot-notation claim', () => {
    const payload = { realm_access: { roles: ['admin', 'user'] } };
    assert.deepEqual(resolveClaim(payload, 'realm_access.roles'), ['admin', 'user']);
  });

  it('returns undefined for a missing nested path', () => {
    assert.equal(resolveClaim({ realm_access: {} }, 'realm_access.roles'), undefined);
  });

  it('returns undefined when an intermediate key is missing', () => {
    assert.equal(resolveClaim({}, 'a.b.c'), undefined);
  });

  it('evaluateClaimRule: array includes value → true', () => {
    assert.ok(evaluateClaimRule({ roles: ['admin', 'user'] }, { claim: 'roles', value: 'admin' }));
  });

  it('evaluateClaimRule: array does not include value → false', () => {
    assert.ok(!evaluateClaimRule({ roles: ['user'] }, { claim: 'roles', value: 'admin' }));
  });

  it('evaluateClaimRule: scalar equals value → true', () => {
    assert.ok(evaluateClaimRule({ role: 'admin' }, { claim: 'role', value: 'admin' }));
  });

  it('evaluateClaimRule: scalar does not equal value → false', () => {
    assert.ok(!evaluateClaimRule({ role: 'user' }, { claim: 'role', value: 'admin' }));
  });

  it('evaluateClaimRule: truthy claim without value constraint → true', () => {
    assert.ok(evaluateClaimRule({ active: true }, { claim: 'active' }));
  });

  it('evaluateClaimRule: falsy claim without value constraint → false', () => {
    assert.ok(!evaluateClaimRule({ active: false }, { claim: 'active' }));
  });

  it('evaluateClaimRule: non-empty array without value constraint → true', () => {
    assert.ok(evaluateClaimRule({ spaces: ['space-a'] }, { claim: 'spaces' }));
  });

  it('evaluateClaimRule: empty array without value constraint → false', () => {
    assert.ok(!evaluateClaimRule({ spaces: [] }, { claim: 'spaces' }));
  });

  it('evaluateClaimRule: nested claim with value match', () => {
    const payload = { realm_access: { roles: ['ythril-admin'] } };
    assert.ok(evaluateClaimRule(payload, { claim: 'realm_access.roles', value: 'ythril-admin' }));
  });
});

// ── JOSE JWT sign / verify roundtrip ─────────────────────────────────────

describe('JWT sign / verify roundtrip', () => {
  before(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey   = keys.privateKey;
    const rawJwk = await exportJWK(keys.publicKey);
    rawJwk.kid   = 'test-key-1';
    rawJwk.use   = 'sig';
    publicJwk    = rawJwk;
    jwkSet       = createLocalJWKSet({ keys: [publicJwk] });
  });

  it('produces a verifiable JWT', async () => {
    const token   = await signJwt({ sub: 'alice' });
    const { payload } = await jwtVerify(token, jwkSet, {
      issuer:   'https://issuer.example.com',
      audience: 'ythril',
    });
    assert.equal(payload.sub, 'alice');
  });

  it('admin role claim is preserved through sign / verify', async () => {
    const token = await signJwt({ sub: 'bob', realm_access: { roles: ['ythril-admin'] } });
    const { payload } = await jwtVerify(token, jwkSet, {
      issuer: 'https://issuer.example.com', audience: 'ythril',
    });
    assert.ok(payload['realm_access']['roles'].includes('ythril-admin'));
  });

  it('spaces claim survives sign / verify', async () => {
    const token = await signJwt({ sub: 'dana', ythril_spaces: ['space-a', 'space-b'] });
    const { payload } = await jwtVerify(token, jwkSet, {
      issuer: 'https://issuer.example.com', audience: 'ythril',
    });
    assert.deepEqual(payload['ythril_spaces'], ['space-a', 'space-b']);
  });

  it('rejects an expired JWT', async () => {
    const token = await signJwt({ sub: 'expired' }, { expiresInSec: -60 });
    await assert.rejects(
      () => jwtVerify(token, jwkSet, { issuer: 'https://issuer.example.com', audience: 'ythril' }),
      /expired/i,
    );
  });

  it('rejects a JWT with wrong audience', async () => {
    const token = await signJwt({ sub: 'wrong-aud' }, { audience: 'other-service' });
    await assert.rejects(
      () => jwtVerify(token, jwkSet, { issuer: 'https://issuer.example.com', audience: 'ythril' }),
      /unexpected.*"aud"|"aud".*unexpected/i,
    );
  });
});

// ── Server module integration tests (compiled dist/) ─────────────────────
// Node.js on Windows sometimes fails to resolve ESM imports from
// drive-letter paths (o:, c:, etc.) during the test runner's module loading
// phase — even when pathToFileURL is used.  Skip on Windows; the real CI
// runs inside a Linux Docker container.

describe('OIDC server module (compiled)', { skip: privateAddressSkipReason() }, () => {
  let oidcMod, loaderMod;

  before(async () => {
    process.env['CONFIG_PATH'] = TMP_CONFIG;
    writeFullConfig(makeOidcConfig());

    loaderMod = await import(pathToFileURL(path.join(DIST_CONFIG, 'loader.js')).href);
    loaderMod.loadConfig();

    oidcMod = await import(pathToFileURL(path.join(DIST_AUTH, 'oidc.js')).href);

    if (!privateKey) {
      const keys   = await generateKeyPair('RS256');
      privateKey   = keys.privateKey;
      const rawJwk = await exportJWK(keys.publicKey);
      rawJwk.kid   = 'test-key-1';
      rawJwk.use   = 'sig';
      publicJwk    = rawJwk;
      jwkSet       = createLocalJWKSet({ keys: [publicJwk] });
    }
  });

  afterEach(() => {
    oidcMod.clearOidcCache();
  });

  it('clearOidcCache() does not throw', () => {
    assert.doesNotThrow(() => oidcMod.clearOidcCache());
  });

  it('getOidcConfig() returns config when oidc is enabled', () => {
    const cfg = oidcMod.getOidcConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.issuerUrl, 'https://issuer.example.com');
  });

  it('getOidcConfig() returns null when oidc.enabled is false', () => {
    writeFullConfig({ ...makeOidcConfig(), enabled: false });
    loaderMod.loadConfig();
    assert.equal(oidcMod.getOidcConfig(), null);
    writeFullConfig(makeOidcConfig());
    loaderMod.loadConfig();
  });

  it('getOidcConfig() returns null when oidc block is absent', () => {
    writeFullConfig(undefined);
    loaderMod.loadConfig();
    assert.equal(oidcMod.getOidcConfig(), null);
    writeFullConfig(makeOidcConfig());
    loaderMod.loadConfig();
  });

  it('validateOidcJwt() returns null for a garbage token', async () => {
    assert.equal(await oidcMod.validateOidcJwt('not.a.valid.jwt'), null);
  });

  it('validateOidcJwt() returns null when OIDC is disabled', async () => {
    writeFullConfig({ ...makeOidcConfig(), enabled: false });
    loaderMod.loadConfig();
    assert.equal(await oidcMod.validateOidcJwt('any.token'), null);
    writeFullConfig(makeOidcConfig());
    loaderMod.loadConfig();
  });

  it('validateOidcJwt() validates a signed JWT and maps claims end-to-end', async () => {
    const { createServer } = await import('node:http');

    const jwksPayload = JSON.stringify({ keys: [publicJwk] });
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
        }));
      } else if (req.url === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(jwksPayload);
      } else {
        res.writeHead(404); res.end();
      }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;

      writeFullConfig({ ...makeOidcConfig(), issuerUrl, audience: 'ythril' });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      const token = await new SignJWT({
        sub:               'alice',
        preferred_username: 'alice@example.com',
        realm_access:      { roles: ['ythril-admin'] },
        ythril_spaces:     ['space-a', 'space-b'],
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(issuerUrl)
        .setAudience('ythril')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setSubject('alice')
        .sign(privateKey);

      const record = await oidcMod.validateOidcJwt(token);

      assert.ok(record !== null, 'should return a record for a valid JWT');
      assert.equal(record.source,              'oidc');
      assert.equal(record.id,                  'oidc:alice');
      assert.equal(record.name,                'alice@example.com');
      assert.equal(record.admin,               true);
      assert.equal(record.readOnly,            undefined);
      assert.deepEqual(record.spaces,          ['space-a', 'space-b']);
      assert.ok(record.expiresAt !== null,     'expiresAt should be set');
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
    }
  });

  it('validateOidcJwt() maps readOnly claim correctly', async () => {
    const { createServer } = await import('node:http');
    const jwksPayload = JSON.stringify({ keys: [publicJwk] });
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
        }));
      } else if (req.url === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(jwksPayload);
      } else { res.writeHead(404); res.end(); }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;
      writeFullConfig({ ...makeOidcConfig(), issuerUrl, audience: 'ythril' });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      const token = await new SignJWT({
        sub:          'readonly-user',
        realm_access: { roles: ['ythril-readonly'] },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(issuerUrl)
        .setAudience('ythril')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setSubject('readonly-user')
        .sign(privateKey);

      const record = await oidcMod.validateOidcJwt(token);
      assert.ok(record !== null);
      assert.equal(record.admin,    false);
      assert.equal(record.readOnly, true);
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
    }
  });

  // ── enforceForBrowser + postLogoutRedirectUri config field tests ───────────

  it('getOidcConfig() includes enforceForBrowser when set to true', () => {
    writeFullConfig({ ...makeOidcConfig(), enforceForBrowser: true });
    loaderMod.loadConfig();
    const cfg = oidcMod.getOidcConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg.enforceForBrowser, true);
    writeFullConfig(makeOidcConfig());
    loaderMod.loadConfig();
  });

  it('getOidcConfig() enforceForBrowser is undefined when not set', () => {
    writeFullConfig(makeOidcConfig());
    loaderMod.loadConfig();
    const cfg = oidcMod.getOidcConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg.enforceForBrowser, undefined);
  });

  it('getOidcConfig() includes postLogoutRedirectUri when set', () => {
    writeFullConfig({ ...makeOidcConfig(), postLogoutRedirectUri: 'https://example.com/goodbye' });
    loaderMod.loadConfig();
    const cfg = oidcMod.getOidcConfig();
    assert.ok(cfg !== null);
    assert.equal(cfg.postLogoutRedirectUri, 'https://example.com/goodbye');
    writeFullConfig(makeOidcConfig());
    loaderMod.loadConfig();
  });

  it('getDiscoveryDoc() surfaces end_session_endpoint when present in discovery document', async () => {
    const { createServer } = await import('node:http');
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
          end_session_endpoint:    `http://${MOCK_IDP_HOST}:${serverPort}/logout`,
        }));
      } else {
        res.writeHead(404); res.end();
      }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;
      writeFullConfig({ ...makeOidcConfig(), issuerUrl });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      const doc = await oidcMod.getDiscoveryDoc(issuerUrl);
      assert.equal(doc.end_session_endpoint, `http://${MOCK_IDP_HOST}:${serverPort}/logout`,
        'end_session_endpoint must be preserved from the discovery document');
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();
    }
  });

  // ── requireMatch tests ─────────────────────────────────────────────────────

  it('validateOidcJwt() returns null when requireMatch:true and no rule matches', async () => {
    const { createServer } = await import('node:http');
    const jwksPayload = JSON.stringify({ keys: [publicJwk] });
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
        }));
      } else if (req.url === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(jwksPayload);
      } else { res.writeHead(404); res.end(); }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;
      writeFullConfig({
        ...makeOidcConfig(),
        issuerUrl,
        audience: 'ythril',
        claimMapping: {
          admin:    { claim: 'realm_access.roles', value: 'ythril-admin' },
          readOnly: { claim: 'realm_access.roles', value: 'ythril-readonly' },
          requireMatch: true,
        },
      });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      // Token with no matching role — should be rejected
      const token = await new SignJWT({
        sub:          'no-role-user',
        realm_access: { roles: ['some-other-role'] },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(issuerUrl)
        .setAudience('ythril')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setSubject('no-role-user')
        .sign(privateKey);

      const record = await oidcMod.validateOidcJwt(token);
      assert.equal(record, null, 'should return null when requireMatch:true and no rule matches');
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
    }
  });

  it('validateOidcJwt() allows admin match when requireMatch:true', async () => {
    const { createServer } = await import('node:http');
    const jwksPayload = JSON.stringify({ keys: [publicJwk] });
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
        }));
      } else if (req.url === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(jwksPayload);
      } else { res.writeHead(404); res.end(); }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;
      writeFullConfig({
        ...makeOidcConfig(),
        issuerUrl,
        audience: 'ythril',
        claimMapping: {
          admin:    { claim: 'realm_access.roles', value: 'ythril-admin' },
          readOnly: { claim: 'realm_access.roles', value: 'ythril-readonly' },
          requireMatch: true,
        },
      });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      const token = await new SignJWT({
        sub:          'admin-user',
        realm_access: { roles: ['ythril-admin'] },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(issuerUrl)
        .setAudience('ythril')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setSubject('admin-user')
        .sign(privateKey);

      const record = await oidcMod.validateOidcJwt(token);
      assert.ok(record !== null, 'admin match should be accepted with requireMatch:true');
      assert.equal(record.admin, true);
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
    }
  });

  it('validateOidcJwt() allows readOnly match when requireMatch:true', async () => {
    const { createServer } = await import('node:http');
    const jwksPayload = JSON.stringify({ keys: [publicJwk] });
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
        }));
      } else if (req.url === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(jwksPayload);
      } else { res.writeHead(404); res.end(); }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;
      writeFullConfig({
        ...makeOidcConfig(),
        issuerUrl,
        audience: 'ythril',
        claimMapping: {
          admin:    { claim: 'realm_access.roles', value: 'ythril-admin' },
          readOnly: { claim: 'realm_access.roles', value: 'ythril-readonly' },
          requireMatch: true,
        },
      });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      const token = await new SignJWT({
        sub:          'readonly-user',
        realm_access: { roles: ['ythril-readonly'] },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(issuerUrl)
        .setAudience('ythril')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setSubject('readonly-user')
        .sign(privateKey);

      const record = await oidcMod.validateOidcJwt(token);
      assert.ok(record !== null, 'readOnly match should be accepted with requireMatch:true');
      assert.equal(record.readOnly, true);
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
    }
  });

  it('validateOidcJwt() allows unmatched token when requireMatch is absent', async () => {
    const { createServer } = await import('node:http');
    const jwksPayload = JSON.stringify({ keys: [publicJwk] });
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
        }));
      } else if (req.url === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(jwksPayload);
      } else { res.writeHead(404); res.end(); }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;
      // requireMatch absent — unmatched tokens are accepted but fail closed
      writeFullConfig({ ...makeOidcConfig(), issuerUrl, audience: 'ythril' });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      const token = await new SignJWT({
        sub:          'no-role-user',
        realm_access: { roles: ['some-other-role'] },
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
        .setIssuer(issuerUrl)
        .setAudience('ythril')
        .setIssuedAt()
        .setExpirationTime('1h')
        .setSubject('no-role-user')
        .sign(privateKey);

      const record = await oidcMod.validateOidcJwt(token);
      // Fail-closed: an unmatched token is accepted (requireMatch is absent) but
      // granted read-only access to NO spaces — not the old read-write, all-spaces default.
      assert.ok(record !== null, 'unmatched token should be accepted when requireMatch is absent');
      assert.equal(record.admin, false);
      assert.equal(record.readOnly, true, 'unmatched token must be read-only (fail closed)');
      assert.deepEqual(record.spaces, [], 'unmatched token must have no space access (fail closed)');
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
    }
  });

  it('getDiscoveryDoc() works when end_session_endpoint is absent (optional field)', async () => {
    const { createServer } = await import('node:http');
    let serverPort;

    const server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Deliberately omit end_session_endpoint
        res.end(JSON.stringify({
          issuer:                  `http://${MOCK_IDP_HOST}:${serverPort}`,
          authorization_endpoint:  `http://${MOCK_IDP_HOST}:${serverPort}/authorize`,
          token_endpoint:          `http://${MOCK_IDP_HOST}:${serverPort}/token`,
          jwks_uri:                `http://${MOCK_IDP_HOST}:${serverPort}/jwks`,
        }));
      } else {
        res.writeHead(404); res.end();
      }
    });

    // own-listener: binds the private LAN address in MOCK_IDP_HOST, because the issuer guard blocks loopback
    await new Promise(resolve => server.listen(0, MOCK_IDP_HOST, () => {
      serverPort = server.address().port;
      resolve();
    }));

    try {
      const issuerUrl = `http://${MOCK_IDP_HOST}:${serverPort}`;
      writeFullConfig({ ...makeOidcConfig(), issuerUrl });
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();

      const doc = await oidcMod.getDiscoveryDoc(issuerUrl);
      assert.equal(doc.end_session_endpoint, undefined,
        'end_session_endpoint should be undefined when absent');
    } finally {
      await new Promise(resolve => server.close(resolve));
      writeFullConfig(makeOidcConfig());
      loaderMod.loadConfig();
      oidcMod.clearOidcCache();
    }
  });
});
