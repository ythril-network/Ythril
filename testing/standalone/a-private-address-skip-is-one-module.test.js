/**
 * "This host has no non-loopback address" is answered ONCE, and answered the way a missing database is:
 * it skips on a laptop and THROWS on CI.
 *
 * ## The failure this prevents
 *
 * Every test that stands up a mock IdP or a peer the SSRF guards will actually fetch has to bind a PRIVATE
 * address (loopback is a blocked crown-jewel range even under the opt-in). A runner with no such address makes
 * all of them unrunnable — and `privateAddressSkipReason()` turned that into a skip, so on CI the whole family
 * (the OIDC discovery timeout, the file-act doors, every db test that pulls from a peer) reported
 * green having proven nothing. `mongoSkipReason()` in `_mongo-harness.mjs` already knows the answer: a harness
 * that is not there on the machine that gates merges is a broken harness, not a reason to pass. This is that
 * answer for the other precondition.
 *
 * The second half is the copies. `oidc-discovery-timeout.test.js` asked the same question inline —
 * `skip: !privateHostAddress() && 'no non-loopback IPv4 on this host'` — twice, and `ssrf-nullbody` read
 * `os.networkInterfaces()` itself. Throwing in the module fixes nothing for a copy: each inline condition is a
 * skip the module cannot reach, so the rule is that no test asks the question any way but through it.
 *
 * Run: node --test testing/standalone/a-private-address-skip-is-one-module.test.js
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import ts from 'typescript';
import { privateAddressSkipReason, privateHostAddress } from './_private-address.mjs';
import { CI_ENV_NAMES } from '../_shared/running-under-ci.mjs';
import { testAndHelperFiles, parseSource, calleeName, inSkipPosition, lineOf } from './_test-bodies.mjs';

const MODULE = 'testing/standalone/_private-address.mjs';

describe('privateAddressSkipReason answers the way mongoSkipReason does', () => {
  const realInterfaces = os.networkInterfaces;
  // every variable the one reading looks at, so a real CI runner's own GITHUB_ACTIONS cannot turn an "off CI" case into CI
  const realCi = Object.fromEntries(CI_ENV_NAMES.map((n) => [n, process.env[n]]));
  const clearCi = () => { for (const n of CI_ENV_NAMES) delete process.env[n]; };
  const loopbackOnly = () => ({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] });
  const withLan = () => ({
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.10' }],
  });

  afterEach(() => {
    os.networkInterfaces = realInterfaces;
    for (const [n, v] of Object.entries(realCi)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; }
  });

  it('with an address it answers false, on CI too (nothing to skip)', () => {
    os.networkInterfaces = withLan;
    clearCi();
    process.env.CI = '1';
    assert.equal(privateHostAddress(), '192.168.1.10');
    assert.equal(privateAddressSkipReason(), false);
  });

  it('with none, off CI, it answers a reason the runner reports as a skip', () => {
    os.networkInterfaces = loopbackOnly;
    clearCi();
    const reason = privateAddressSkipReason();
    assert.equal(typeof reason, 'string', 'a laptop with no LAN address skips with an actionable reason');
    assert.match(reason, /non-loopback/);
  });

  it('with none, on CI, it THROWS — a skip there reads as a pass', () => {
    os.networkInterfaces = loopbackOnly;
    clearCi();
    process.env.CI = '1';
    assert.throws(() => privateAddressSkipReason(), (err) => {
      assert.match(err.message, /CI/, 'the refusal must say why it will not skip');
      assert.match(err.message, /non-loopback/, 'and what is missing');
      return true;
    }, 'no non-loopback address on CI is a broken runner and must fail loudly, not skip and report green');
  });

  it('an empty or false CI variable is not CI (the one reading, running-under-ci.mjs)', () => {
    os.networkInterfaces = loopbackOnly;
    clearCi();
    process.env.CI = '';
    assert.equal(typeof privateAddressSkipReason(), 'string');
    process.env.CI = 'false';
    assert.equal(typeof privateAddressSkipReason(), 'string');
  });
});

describe('no test asks the question without going through it', () => {
  const files = testAndHelperFiles().filter(f => f.file !== MODULE);

  /** Every place a file reads the host's addresses itself, or skips on the module's raw answer. */
  function inlineCopies({ file, text }) {
    const sf = parseSource(file, text);
    const found = [];
    const visit = (n) => {
      if (ts.isCallExpression(n) && calleeName(n) === 'networkInterfaces') {
        found.push(`${file}:${lineOf(sf, n)}  reads os.networkInterfaces() itself`);
      }
      if (ts.isIdentifier(n) && n.text === 'privateHostAddress' && inSkipPosition(n)) {
        found.push(`${file}:${lineOf(sf, n)}  skips on privateHostAddress() — the raw answer, which never throws`);
      }
      if (ts.isStringLiteralLike(n) && /non-loopback/i.test(n.text) && inSkipPosition(n)) {
        found.push(`${file}:${lineOf(sf, n)}  writes its own "no non-loopback" skip reason`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }

  it('the scan sees the callers (a floor) and the detector sees each inline shape', () => {
    const callers = files.filter(f => /privateAddressSkipReason\s*\(/.test(f.text));
    assert.ok(callers.length >= 10, `only ${callers.length} file(s) call privateAddressSkipReason() — the scan is broken`);
    const shapes = {
      rawSkip: "it('x', { skip: !privateHostAddress() && 'no non-loopback IPv4 on this host' }, () => {});",
      ownReason: "it('x', (t) => { if (!ip) { t.skip('no non-loopback IPv4 to bind'); return; } });",
      ownLookup: "const lanIp = Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4');",
    };
    for (const [name, code] of Object.entries(shapes)) {
      assert.ok(inlineCopies({ file: 'x.test.js', text: code }).length >= 1, `the ${name} shape is not seen`);
    }
    assert.deepEqual(inlineCopies({
      file: 'x.test.js',
      text: "const skip = (await databaseReason()) || privateAddressSkipReason(); describe('x', { skip }, () => { const h = privateHostAddress(); });",
    }), [], 'the sanctioned form, and a plain use of the address, must not be read as a copy');
  });

  it('every skip on a missing private address is privateAddressSkipReason()', () => {
    const found = files.flatMap(inlineCopies);
    assert.deepEqual(found, [],
      'these answer "no private address" themselves, so on CI they skip where the module would throw. Skip with '
      + '`privateAddressSkipReason()` (and take the address from `privateHostAddress()`):\n  ' + found.join('\n  '));
  });
});
