/**
 * PR-S3 — startup security-posture check (`config/security-posture.ts`).
 *
 * With no config loaded (standalone), the checks resolve from env + defaults — exactly the override
 * paths. Covers each PASS/WARN/FAIL transition the boot log and `security.strict` gate depend on.
 *
 * Run: node --test testing/standalone/security-posture.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { computeSecurityPosture, securityStrict, exposureCount } from '../../server/dist/config/security-posture.js';

const ENV_KEYS = [
  'REQUIRE_ENCRYPTED_TRANSPORT', 'SYNC_ALLOW_INSECURE_PEERS', 'TRUST_PROXY',
  'YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE', 'YTHRIL_REQUIRE_ENCRYPTED_AT_REST',
  'YTHRIL_SECURITY_STRICT', 'MONGO_USERNAME', 'MONGO_URI', 'PUBLIC_BASE_URL',
];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }
const find = (posture, id) => posture.checks.find(c => c.id === id);

describe('computeSecurityPosture', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('default posture: transport/at-rest/mongo all WARN, peers PASS, worst=warn', () => {
    const p = computeSecurityPosture();
    assert.equal(find(p, 'transport.tls').level, 'warn');
    assert.equal(find(p, 'transport.peers').level, 'pass');
    assert.equal(find(p, 'atRest.encryption').level, 'warn');
    assert.equal(find(p, 'mongo.auth').level, 'warn');
    assert.equal(p.worst, 'warn');
  });

  it('requireEncryptedTransport without trustProxy → FAIL', () => {
    process.env.REQUIRE_ENCRYPTED_TRANSPORT = 'true';
    const p = computeSecurityPosture();
    assert.equal(find(p, 'transport.tls').level, 'pass');
    assert.equal(find(p, 'transport.trustProxy').level, 'fail');
    assert.equal(p.worst, 'fail');
  });

  it('requireEncryptedTransport WITH trustProxy → no trustProxy failure', () => {
    process.env.REQUIRE_ENCRYPTED_TRANSPORT = 'true';
    process.env.TRUST_PROXY = '1';
    const p = computeSecurityPosture();
    assert.equal(find(p, 'transport.tls').level, 'pass');
    assert.equal(find(p, 'transport.trustProxy'), undefined);
  });

  it('TRUST_PROXY=false is not trustProxy (the app turns it into false, so the posture reads it as unset)', () => {
    process.env.REQUIRE_ENCRYPTED_TRANSPORT = 'true';
    for (const off of ['false', ' false ', '0']) {
      process.env.TRUST_PROXY = off;
      const p = computeSecurityPosture();
      assert.equal(find(p, 'transport.trustProxy')?.level, 'fail', `TRUST_PROXY=${JSON.stringify(off)} was counted as a configured proxy`);
    }
    process.env.TRUST_PROXY = 'loopback';
    assert.equal(find(computeSecurityPosture(), 'transport.trustProxy'), undefined, 'a named proxy range is a configured proxy');
  });

  it('allowInsecurePeers env → peers WARN', () => {
    process.env.SYNC_ALLOW_INSECURE_PEERS = 'true';
    assert.equal(find(computeSecurityPosture(), 'transport.peers').level, 'warn');
  });

  it('master key present → at-rest PASS', () => {
    process.env.YTHRIL_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    assert.equal(find(computeSecurityPosture(), 'atRest.encryption').level, 'pass');
  });

  it('requireEncryptedAtRest without a key → at-rest strict FAIL', () => {
    process.env.YTHRIL_REQUIRE_ENCRYPTED_AT_REST = 'true';
    const p = computeSecurityPosture();
    assert.equal(find(p, 'atRest.strict').level, 'fail');
    assert.equal(p.worst, 'fail');
  });

  it('Mongo credentials (env user) → mongo auth PASS', () => {
    process.env.MONGO_USERNAME = 'u';
    assert.equal(find(computeSecurityPosture(), 'mongo.auth').level, 'pass');
  });

  it('Mongo URI with userinfo → mongo auth PASS', () => {
    process.env.MONGO_URI = 'mongodb://user:pass@host:27017/db';
    assert.equal(find(computeSecurityPosture(), 'mongo.auth').level, 'pass');
  });

  // ── mcp.publicUrl ────────────────────────────────────────────────────────────
  // MCP OAuth falls back to a loopback base URL when nothing is configured. The endpoint answers and the
  // metadata is well-formed, so there is no failure to notice — the operator learns about it from a
  // connector that will not authorize. Hence a posture line rather than a runtime error.

  it('no publicUrl → mcp.publicUrl WARN', () => {
    const p = computeSecurityPosture();
    assert.equal(find(p, 'mcp.publicUrl').level, 'warn');
    assert.match(find(p, 'mcp.publicUrl').message, /loopback base URL/);
  });

  it('PUBLIC_BASE_URL set → the check disappears entirely', () => {
    // Absent, not `pass`: an instance with no MCP connectors is a legitimate configuration, and a green
    // line asserting something about a feature nobody uses is noise in a block read for exceptions.
    process.env.PUBLIC_BASE_URL = 'https://ythril.example.com';
    assert.equal(find(computeSecurityPosture(), 'mcp.publicUrl'), undefined);
  });

  it('a whitespace-only PUBLIC_BASE_URL still counts as unset', () => {
    // getPublicBaseUrl() trims before falling back, so a blank env var yields the loopback URL. If the
    // posture used mere presence it would call this configured and stay silent on a broken instance.
    process.env.PUBLIC_BASE_URL = '   ';
    assert.equal(find(computeSecurityPosture(), 'mcp.publicUrl').level, 'warn');
  });

  it('a fully-hardened env passes every check', () => {
    process.env.REQUIRE_ENCRYPTED_TRANSPORT = 'true';
    process.env.TRUST_PROXY = '1';
    process.env.YTHRIL_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    process.env.MONGO_USERNAME = 'u';
    // A hardened instance has an externally-reachable URL — without one, MCP OAuth cannot work at all.
    process.env.PUBLIC_BASE_URL = 'https://ythril.example.com';
    const p = computeSecurityPosture();
    assert.equal(p.worst, 'pass', JSON.stringify(p.checks.filter(c => c.level !== 'pass')));
  });

  // ── exposureCount ────────────────────────────────────────────────────────────
  // The reported bug: `0 of 2 external endpoint(s) resolve to private addresses` on a cluster whose two
  // endpoints were both private ClusterIPs behind DNS names. The count was not merely imprecise — it
  // stated the opposite of the truth, in a block where the neighbouring "nothing is using the
  // permission" phrasing genuinely means "unset this flag".

  it('never says "resolve to" for endpoints it did not resolve', () => {
    const msg = exposureCount(0, 2, 2);
    assert.doesNotMatch(msg, /\bresolve to private\b/);
    assert.doesNotMatch(msg, /^0 of 2/, 'a leading 0-of-N reads as "none are private"');
    assert.match(msg, /None of the 2 are IP literals/);
    assert.match(msg, /has not established where any of them point/);
  });

  it('spells out that unresolved is not the same as safe', () => {
    assert.match(exposureCount(0, 2, 2), /"Not resolved here" is not "not private"/);
  });

  it('still counts plainly when every endpoint is an IP literal', () => {
    // Nothing was lost for the case the original phrasing was written for.
    assert.equal(exposureCount(1, 0, 3), '1 of 3 are private addresses.');
  });

  it('separates the known from the unknown in a mixed list', () => {
    const msg = exposureCount(1, 2, 3);
    assert.match(msg, /1 of 3 are private IP literals/);
    assert.match(msg, /the other 2/);
    assert.match(msg, /where they point/);
  });

  it('securityStrict reads the env flag', () => {
    assert.equal(securityStrict(), false);
    process.env.YTHRIL_SECURITY_STRICT = 'true';
    assert.equal(securityStrict(), true);
  });
});
