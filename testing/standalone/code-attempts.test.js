/**
 * Five wrong second-factor codes lock a token for 15 minutes, a correct code included (Q-694, bundle-233) - the counter, alone.
 *
 * ## The defect
 *
 * `verifyMfaCode` answered true or false and remembered nothing. A holder of an admin token could try six-digit codes without a limit but
 * the one throttle in front of the endpoint (10 requests a minute per address): about 14,000 guesses a day at 3 in 1,000,000 each. The fix
 * is one module, `auth/code-attempts.ts`, whose `tryMfaCode(code, { tokenId, req })` asks the verifier and keeps a sliding window of wrong
 * codes per token and per source address. This file holds that module's own rules with an injected clock and no server:
 *
 * - **The threshold.** `MFA_FAILURES_MAX` (5) wrong codes inside `MFA_LOCKOUT_WINDOW_MS` (15 minutes) answer `{ ok: false, reason: 'invalid' }`;
 *   from the next attempt the answer is `{ ok: false, reason: 'locked', key, retryAfterSeconds }` - a correct code included, and the correct
 *   code is NOT verified, so no step is burned (the same code is accepted when the window has passed).
 * - **The window slides.** The oldest failure leaves 15 minutes after IT was made; a lock does not lift for all failures at once, and
 *   `retryAfterSeconds` is the ceiling of the seconds until the oldest failure leaves, never less than 1.
 * - **Only a wrong code counts.** A correct code clears nothing and counts nothing; a replay, a stale code (right once, minutes ago: the
 *   client's cached code) and a code with no secret set are refused and never counted, and answer exactly as a wrong one does.
 * - **A key is made by a recorded failure only**, and the table is capped at `MFA_KEYS_MAX`: the oldest key whose lock is not running is
 *   dropped first (by last failure), a locked key is never evicted, and with every key locked the new failure is not recorded and
 *   `ythril_mfa_lockout_evictions_total` counts it.
 * - **A lock start is counted once**, at the failure that brings a key to 5, in `ythril_mfa_lockouts_total{key}`.
 * - **The address key counts only where the address is trustworthy**: when trust proxy is configured, or the socket's address is not
 *   private, loopback or link-local. Behind the default Docker gateway one token's guesses lock that token only.
 * - **The token key is asked first**: with both keys at 5 the answer names `token`.
 * - **It is synchronous**: nothing between the lock check, the verifier and the record can interleave two requests.
 *
 * ## The contract this file fixes beyond the design's text
 *
 * `setMfaClock(fn | null)` injects `() => milliseconds` (null restores `Date.now`); `resetMfaAttempts()` empties the table. The request is read
 * through `req.ip`, `req.socket.remoteAddress` and `req.app.get('trust proxy')` (`'trust proxy fn'` is also answered).
 *
 * ## Seen red
 *
 * On the base `server/dist/auth/code-attempts.js` does not exist: every case fails on the import.
 *
 * Run: node --test testing/standalone/code-attempts.test.js
 * (requires a prior `npm run build -w server`)
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempInstance, boot } from './_round-open-fixtures.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { codeAtStep, wrongCode, staleCode } from './_totp-codes.mjs';

const dir = tempInstance('ythril-q694-attempts-');

/** A request as the module reads it. `trust` is the app's trust proxy setting; `remote` the socket's address. */
const fakeReq = ({ ip = '127.0.0.1', remote = ip, trust = false } = {}) => ({
  ip,
  headers: {},
  socket: { remoteAddress: remote },
  app: {
    get: (k) => (k === 'trust proxy' ? trust : k === 'trust proxy fn' ? () => Boolean(trust) : undefined),
    settings: { 'trust proxy': trust },
  },
});
const LOOPBACK = fakeReq();
after(() => removeInstanceDir(dir));

let attempts; let totp; let register; let secret;
const MIN = 60_000;

/** The value of one sample of a counter, 0 when it has none yet. */
async function sample(name, labels = '') {
  for (const line of (await register.metrics()).split('\n')) {
    if (line.startsWith('#')) continue;
    if (line.startsWith(`${name}${labels}`) && (labels !== '' || line.startsWith(`${name} `))) return Number(line.split(' ').pop());
  }
  return 0;
}

describe('tryMfaCode: the counter and its window', () => {
  let now; let serial;
  const id = () => `tok-${++serial}`;
  before(async () => {
    await boot(dir, { networks: [] });
    totp = await import('../../server/dist/auth/totp.js');
    attempts = await import('../../server/dist/auth/code-attempts.js');
    ({ register } = await import('../../server/dist/metrics/registry.js'));
  });
  beforeEach(async () => {
    await boot(dir, { networks: [] });
    secret = totp.enableMfa('Ythril', 'test').secret;
    attempts.resetMfaAttempts();
    now = 1_700_000_000_000;
    serial = 0;
    attempts.setMfaClock(() => now);
  });
  after(() => { attempts?.setMfaClock(null); });

  /** `n` wrong codes for `tokenId`, all at the clock's present, each answer returned. */
  const wrongs = (n, tokenId, req = LOOPBACK) => Array.from({ length: n }, () => attempts.tryMfaCode(wrongCode(secret), { tokenId, req }));

  it('exports the numbers the docs state: 5 wrong codes, 15 minutes, 10000 keys', () => {
    assert.equal(attempts.MFA_FAILURES_MAX, 5);
    assert.equal(attempts.MFA_LOCKOUT_WINDOW_MS, 15 * MIN);
    assert.equal(attempts.MFA_KEYS_MAX, 10_000);
  });

  it('the 1st to 5th wrong codes answer invalid; from the 6th attempt a CORRECT code is locked, names the key and the wait', () => {
    const t = id();
    for (const r of wrongs(5, t)) assert.deepEqual(r, { ok: false, reason: 'invalid' });
    const locked = attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: t, req: LOOPBACK });
    assert.deepEqual(locked, { ok: false, reason: 'locked', key: 'token', retryAfterSeconds: 900 });
    assert.deepEqual(attempts.tryMfaCode(wrongCode(secret), { tokenId: t, req: LOOPBACK }), locked, 'a wrong code while locked answers the lock too');
  });

  it('a locked attempt does not verify: the correct code it carried is still good when the lock has run out', () => {
    const t = id();
    wrongs(5, t);
    const code = codeAtStep(secret, 0);
    assert.equal(attempts.tryMfaCode(code, { tokenId: t, req: LOOPBACK }).reason, 'locked');
    now += 15 * MIN + 1000;
    assert.deepEqual(attempts.tryMfaCode(code, { tokenId: t, req: LOOPBACK }), { ok: true }, 'the locked attempt burned the step');
  });

  it('the window slides: each failure leaves 15 minutes after it was made, and a fixed window would answer otherwise', () => {
    const t = id();
    for (let i = 0; i < 5; i++) { wrongs(1, t); if (i < 4) now += MIN; } // failures at 0,1,2,3,4 minutes; now = 4 min
    const at = (ms) => { now = 1_700_000_000_000 + ms; return attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: t, req: LOOPBACK }); };
    assert.deepEqual(at(4 * MIN), { ok: false, reason: 'locked', key: 'token', retryAfterSeconds: 660 }, 'the wait is until the OLDEST failure leaves (0 + 15 min)');
    assert.equal(at(14 * MIN + 59_000).reason, 'locked');
    // 15 min 1 s: the failure at 0 is gone, four remain (1,2,3,4 min), so a wrong code is the fifth again, not the first of a new window.
    now = 1_700_000_000_000 + 15 * MIN + 1000;
    assert.deepEqual(attempts.tryMfaCode(wrongCode(secret), { tokenId: t, req: LOOPBACK }), { ok: false, reason: 'invalid' });
    assert.equal(attempts.tryMfaCode(wrongCode(secret), { tokenId: t, req: LOOPBACK }).reason, 'locked', 'the window reset instead of sliding');
  });

  it('retryAfterSeconds is the ceiling of the remaining wait and never below 1', () => {
    const t = id();
    wrongs(5, t);
    now += 15 * MIN - 1; // 1 ms to go
    assert.equal(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: t, req: LOOPBACK }).retryAfterSeconds, 1);
    assert.equal(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: id(), req: LOOPBACK }).ok, true, 'a token that never failed is not locked');
  });

  it('a correct code clears nothing and counts nothing', () => {
    const t = id();
    wrongs(4, t);
    assert.deepEqual(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: t, req: LOOPBACK }), { ok: true });
    assert.deepEqual(wrongs(1, t)[0], { ok: false, reason: 'invalid' }, 'the 5th wrong code');
    assert.equal(attempts.tryMfaCode(codeAtStep(secret, 1), { tokenId: t, req: LOOPBACK }).reason, 'locked', 'a correct code reset the count');
  });

  it('a replay, a stale code and no secret are refused as a wrong code is, and never counted', () => {
    const t = id();
    const first = codeAtStep(secret, 0);
    assert.deepEqual(attempts.tryMfaCode(first, { tokenId: t, req: LOOPBACK }), { ok: true });
    const wrong = attempts.tryMfaCode(wrongCode(secret), { tokenId: id(), req: LOOPBACK });
    for (let i = 0; i < 12; i++) {
      assert.deepEqual(attempts.tryMfaCode(first, { tokenId: t, req: LOOPBACK }), wrong, `replay ${i} answers differently from a wrong code`);
      assert.deepEqual(attempts.tryMfaCode(staleCode(secret), { tokenId: t, req: LOOPBACK }), wrong, `stale ${i} answers differently from a wrong code`);
    }
    assert.deepEqual(wrongs(5, t).map(r => r.reason), Array(5).fill('invalid'), 'replays or stale codes were counted: the token locked early');
    assert.equal(attempts.tryMfaCode(wrongCode(secret), { tokenId: t, req: LOOPBACK }).reason, 'locked');

    totp.disableMfa();
    const u = id();
    for (let i = 0; i < 12; i++) assert.deepEqual(attempts.tryMfaCode('123456', { tokenId: u, req: LOOPBACK }), wrong, 'no secret answers differently from a wrong code');
    secret = totp.enableMfa('Ythril', 'test').secret;
    assert.deepEqual(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: u, req: LOOPBACK }), { ok: true }, 'codes tried while MFA was off were counted');
  });

  it('the result is a value, never a promise: nothing can interleave between the check, the verify and the record', () => {
    const r = attempts.tryMfaCode(wrongCode(secret), { tokenId: id(), req: LOOPBACK });
    assert.equal(typeof r.then, 'undefined');
    assert.ok(!(r instanceof Promise));
  });

  it('a lock start is counted once, per key, at the failure that brings the key to 5', async () => {
    const t = id();
    const before = await sample('ythril_mfa_lockouts_total', '{key="token"}');
    wrongs(4, t);
    assert.equal(await sample('ythril_mfa_lockouts_total', '{key="token"}'), before, 'counted before the 5th failure');
    wrongs(1, t);
    assert.equal(await sample('ythril_mfa_lockouts_total', '{key="token"}'), before + 1, 'the 5th failure is the lock start');
    for (let i = 0; i < 4; i++) attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: t, req: LOOPBACK });
    assert.equal(await sample('ythril_mfa_lockouts_total', '{key="token"}'), before + 1, 'a locked attempt counted a second lock');
    assert.equal(await sample('ythril_mfa_lockouts_total', '{key="address"}'), 0, 'the address key counted on loopback with no trust proxy');
  });

  it('the oldest key whose lock is not running is dropped at the cap; the one that failed again stays', () => {
    const cap = attempts.MFA_KEYS_MAX;
    for (let i = 1; i <= cap; i++) wrongs(1, `fill-${i}`);          // cap keys, one failure each
    wrongs(3, 'fill-1');                                             // fill-1 now has 4 failures and is the youngest
    wrongs(1, 'fill-extra');                                         // one over the cap: fill-2 (oldest) goes, not fill-1
    assert.deepEqual(wrongs(1, 'fill-1')[0], { ok: false, reason: 'invalid' }, 'the 5th failure of fill-1');
    assert.equal(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: 'fill-1', req: LOOPBACK }).reason, 'locked', 'fill-1 was evicted though it had failed last');
    // fill-2 lost its one failure: four more wrong codes are its 1st to 4th again, so its 5th attempt is still answered, not locked.
    for (const r of wrongs(5, 'fill-2')) assert.deepEqual(r, { ok: false, reason: 'invalid' }, 'fill-2 kept a failure it should have lost');
  });

  it('a key is made by a recorded failure only; a locked key is never evicted; with every key locked the new failure is dropped and counted', async () => {
    const cap = attempts.MFA_KEYS_MAX;
    const first = codeAtStep(secret, 0);
    attempts.tryMfaCode(first, { tokenId: 'spender', req: LOOPBACK }); // spends the step: every later try of `first` is a replay
    const evictedBefore = await sample('ythril_mfa_lockout_evictions_total');
    // More replays than the cap, none of which may take a slot.
    for (let i = 0; i < cap + 50; i++) attempts.tryMfaCode(first, { tokenId: `replay-${i}`, req: LOOPBACK });
    for (let i = 1; i <= cap; i++) wrongs(5, `lock-${i}`);
    assert.equal(await sample('ythril_mfa_lockout_evictions_total'), evictedBefore, 'a replay made a key, or the table dropped a failure below the cap');
    for (const probe of ['lock-1', `lock-${cap}`]) {
      assert.equal(attempts.tryMfaCode(wrongCode(secret), { tokenId: probe, req: LOOPBACK }).reason, 'locked', `${probe} is not locked at the cap`);
    }
    // The table is full of running locks: a new token's failures are not recorded, so it never locks, and each drop is counted.
    for (const r of wrongs(8, 'newcomer')) assert.deepEqual(r, { ok: false, reason: 'invalid' }, 'a failure was recorded past the cap');
    assert.equal(await sample('ythril_mfa_lockout_evictions_total'), evictedBefore + 8, 'each dropped failure is counted');
    assert.equal(attempts.tryMfaCode(wrongCode(secret), { tokenId: 'lock-1', req: LOOPBACK }).reason, 'locked', 'a running lock was evicted for a newcomer');
  });
});

describe('tryMfaCode: the address key counts only where the address is trustworthy', () => {
  let now; let n;
  before(async () => {
    attempts ??= await import('../../server/dist/auth/code-attempts.js');
    totp ??= await import('../../server/dist/auth/totp.js');
  });
  beforeEach(async () => {
    await boot(dir, { networks: [] });
    secret = totp.enableMfa('Ythril', 'test').secret;
    attempts.resetMfaAttempts();
    now = 1_700_000_000_000;
    n = 0;
    attempts.setMfaClock(() => now);
  });
  after(() => attempts?.setMfaClock(null));

  /** Five wrong codes from `req`, one per fresh token (so no token key reaches 5), then a fresh token with a correct code from `req`. */
  const spread = (req) => {
    for (let i = 0; i < 5; i++) attempts.tryMfaCode(wrongCode(secret), { tokenId: `s-${++n}`, req });
    return attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: `s-${++n}`, req });
  };

  const TABLE = [
    // [what, request, whether the address key counts]
    ['loopback, no trust proxy', fakeReq({ ip: '127.0.0.1' }), false],
    ['IPv6 loopback, no trust proxy', fakeReq({ ip: '::1' }), false],
    ['the Docker gateway (172.17.0.1), no trust proxy', fakeReq({ ip: '172.17.0.1' }), false],
    ['a private 10.x address, no trust proxy', fakeReq({ ip: '10.1.2.3' }), false],
    ['a link-local address, no trust proxy', fakeReq({ ip: '169.254.7.7' }), false],
    ['a public address on the socket, no trust proxy', fakeReq({ ip: '93.184.216.34' }), true],
    ['a public IPv6 address on the socket, no trust proxy', fakeReq({ ip: '2606:4700:10:1::1' }), true],
    ['loopback socket, trust proxy configured, a public client address', fakeReq({ ip: '8.8.8.8', remote: '127.0.0.1', trust: 1 }), true],
    ['a private socket, trust proxy configured, a public client address', fakeReq({ ip: '8.8.4.4', remote: '172.17.0.1', trust: true }), true],
  ];
  for (const [what, req, counts] of TABLE) {
    it(`${counts ? 'counts' : 'does not count'}: ${what}`, () => {
      const r = spread(req);
      if (counts) assert.deepEqual([r.ok, r.reason, r.key], [false, 'locked', 'address'], `the address key did not lock after 5 wrong codes: ${JSON.stringify(r)}`);
      else assert.deepEqual(r, { ok: true }, `the address key counted where the address cannot be trusted: ${JSON.stringify(r)}`);
    });
  }

  it('the address key is per address: five wrong codes from one do not lock another', () => {
    const a = fakeReq({ ip: '8.8.8.8' }); const b = fakeReq({ ip: '8.8.4.4' });
    for (let i = 0; i < 5; i++) attempts.tryMfaCode(wrongCode(secret), { tokenId: `s-${++n}`, req: a });
    assert.deepEqual(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: `s-${++n}`, req: b }), { ok: true });
  });

  it('two IPv6 addresses of one /64 share an address key', () => {
    const a = fakeReq({ ip: '2606:4700:10:1::1' }); const b = fakeReq({ ip: '2606:4700:10:1:aaaa::2' });
    for (let i = 0; i < 5; i++) attempts.tryMfaCode(wrongCode(secret), { tokenId: `s-${++n}`, req: i < 3 ? a : b });
    const r = attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: `s-${++n}`, req: fakeReq({ ip: '2606:4700:10:1:bbbb::3' }) });
    assert.deepEqual([r.reason, r.key], ['locked', 'address']);
  });

  it('one token tried from many addresses locks on the token key', () => {
    for (let i = 0; i < 5; i++) attempts.tryMfaCode(wrongCode(secret), { tokenId: 'roamer', req: fakeReq({ ip: `8.8.8.${i + 1}` }) });
    const r = attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: 'roamer', req: fakeReq({ ip: '8.8.8.99' }) });
    assert.deepEqual([r.reason, r.key], ['locked', 'token']);
  });

  it('with both keys at 5 the token key is the one named; the address key still locks the others', () => {
    const req = fakeReq({ ip: '93.184.216.34' });
    for (let i = 0; i < 5; i++) attempts.tryMfaCode(wrongCode(secret), { tokenId: 'both', req });
    assert.deepEqual(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: 'both', req }), { ok: false, reason: 'locked', key: 'token', retryAfterSeconds: 900 });
    assert.deepEqual(attempts.tryMfaCode(codeAtStep(secret, 0), { tokenId: 'other', req }), { ok: false, reason: 'locked', key: 'address', retryAfterSeconds: 900 });
  });
});
