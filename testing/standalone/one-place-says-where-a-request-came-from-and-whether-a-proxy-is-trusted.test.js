/**
 * The request's address and the trust-proxy question each have one place that answers them (bundle-233).
 *
 * ## The defect it prevents
 *
 * Both rules were written twice and drifted. The posture check read `TRUST_PROXY` as "set" for any non-empty value while the app turned
 * `'false'` into `false`, so an instance with `TRUST_PROXY=false` passed the transport check it should fail. And the address a request is
 * recorded under (`req.ip`, else the socket's, else `'unknown'`) was typed at four sites, one of them with a `?.` the others lacked.
 *
 * ## What it holds
 *
 * - `resolveTrustProxy` and `trustProxyConfigured` (`config/trust-proxy.ts`) answer the way the app resolves the setting: `'false'`, `'0'`,
 *   an empty value and nothing are off; a hop count, `'true'` and a named range are on. A running app's own setting is read by the argument.
 * - `requestAddress` (`audit/request-address.ts`) answers `req.ip`, else the socket's address, else `'unknown'`, for a request with no socket too.
 * - No other file in `server/src` reads the `TRUST_PROXY` variable or spells the address fallback.
 *
 * Run: node --test testing/standalone/one-place-says-where-a-request-came-from-and-whether-a-proxy-is-trusted.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { keepEnv } from '../_shared/env-kept.mjs';

const TRUST = 'server/src/config/trust-proxy.ts';
const ADDRESS = 'server/src/audit/request-address.ts';

describe('trust proxy: one reading of the setting', () => {
  const restore = keepEnv(['TRUST_PROXY']);
  let mod;
  before(async () => {
    mod = await import('../../server/dist/config/trust-proxy.js');
  });
  after(() => restore());

  const rows = [
    ['unset', undefined, false],
    ['an empty value', '', false],
    ['false', 'false', false],
    ['false with spaces', ' false ', false],
    ['zero hops', '0', false],
    ['true', 'true', true],
    ['one hop', '1', true],
    ['loopback', 'loopback', true],
    ['a CIDR list', '10.0.0.0/8, 192.168.0.0/16', true],
  ];
  for (const [what, env, on] of rows) {
    it(`${what}: ${on ? 'trusted' : 'not trusted'}`, () => {
      if (env === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = env;
      assert.equal(mod.trustProxyConfigured(), on);
      assert.equal(mod.trustProxyConfigured(mod.resolveTrustProxy()), on);
    });
  }

  it('reads the setting an app holds when it is passed one', () => {
    for (const [setting, on] of [[false, false], [0, false], [undefined, false], ['', false], [1, true], [true, true], ['loopback', true]]) {
      assert.equal(mod.trustProxyConfigured(setting), on, `setting ${JSON.stringify(setting)}`);
    }
  });
});

describe('requestAddress', () => {
  let requestAddress;
  before(async () => {
    ({ requestAddress } = await import('../../server/dist/audit/request-address.js'));
  });

  it('is the address the proxy reports, else the socket\'s, else unknown', () => {
    assert.equal(requestAddress({ ip: '8.8.8.8', socket: { remoteAddress: '10.0.0.1' } }), '8.8.8.8');
    assert.equal(requestAddress({ socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
    assert.equal(requestAddress({ socket: {} }), 'unknown');
  });

  it('answers a request with no socket at all', () => {
    assert.equal(requestAddress({}), 'unknown');
  });
});

describe('nothing else in the server says either again', () => {
  const files = trackedSources(['server/src'], { floor: 200, untracked: true });
  const sources = new Map(files.map(f => [f, stripComments(readFileSync(f, 'utf8'))]));

  it('reads a tree worth reading, and both places exist', () => {
    assert.ok(sources.size >= 200);
    assert.ok(sources.has(TRUST), `${TRUST} does not exist`);
    assert.ok(sources.has(ADDRESS), `${ADDRESS} does not exist`);
  });

  it('only config/trust-proxy.ts reads the TRUST_PROXY variable or the config key', () => {
    const offenders = [...sources].filter(([f, text]) => f !== TRUST && /process\.env\[?\.?['"]?TRUST_PROXY|getConfig\(\)\??\.trustProxy\b/.test(text)).map(([f]) => f);
    assert.deepEqual(offenders, [], 'a second reading of the trust-proxy setting: ask trustProxyConfigured or resolveTrustProxy');
  });

  it('only audit/request-address.ts spells the address fallback', () => {
    const offenders = [...sources].filter(([f, text]) => f !== ADDRESS && /remoteAddress\s*\?\?\s*['"]unknown['"]/.test(text)).map(([f]) => f);
    assert.deepEqual(offenders, [], 'a second spelling of "req.ip, else the socket, else unknown": ask requestAddress');
  });

  it('sees both slips on planted sources', () => {
    assert.match("const t = process.env['TRUST_PROXY'];", /process\.env\[?\.?['"]?TRUST_PROXY/);
    assert.match('const t = getConfig().trustProxy;', /getConfig\(\)\??\.trustProxy\b/);
    assert.match("ip: req.ip ?? req.socket?.remoteAddress ?? 'unknown',", /remoteAddress\s*\?\?\s*['"]unknown['"]/);
  });
});
