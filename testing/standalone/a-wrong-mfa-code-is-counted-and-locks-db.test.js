/**
 * A wrong second-factor code is counted at every door that verifies one, and the sixth attempt is locked out (Q-694, bundle-233; closes Q-600).
 *
 * ## The defect
 *
 * An admin PAT could try six-digit codes against `requireAdminMfa`, `POST /api/mfa/verify` and the exemption grant with no limit but a
 * 10-a-minute throttle on ONE of the three doors: nothing remembered a wrong code. `auth/code-attempts.ts` now does, and each of the three
 * sites asks it instead of the verifier. This file drives the real application over a socket and holds what a caller sees:
 *
 * - **The token key, on a `requireAdminMfa` route.** 5 wrong codes answer `403 MFA_INVALID` as today; the 6th attempt, a CORRECT code
 *   included, answers `429 { error: 'MFA_LOCKED', code: 'MFA_LOCKED', key: 'token', retryAfterSeconds, retryable: false, message }` with
 *   `Retry-After` equal to `retryAfterSeconds`; the code it carried is not spent.
 * - **One counter for the three doors.** 4 wrong codes on `/api/mfa/verify` (`200 { valid: false }`), the 5th wrong on an admin route
 *   (still `403 MFA_INVALID`), and the 6th attempt on the admin route is `429`; `/verify` is then locked too.
 * - **The exemption door** (`POST /api/tokens` with `mfa: 'exempt'`, which asks a live code of an admin that is itself exempt): the same
 *   count and the same `429`, and nothing is minted.
 * - **The lock is asked before the code is demanded:** a locked token that sends NO code gets `429`, not `403 MFA_REQUIRED` (a prompt for
 *   a code that cannot succeed). A request with no code is never a guess: it is not counted.
 * - **Only a guess is counted.** A replay and a stale (cached) code answer exactly as a wrong code does at each door, and a dozen of them
 *   lock nothing.
 * - **A throw is a 500 and counts nothing:** when the store cannot save the burned step, the request fails and the failure is no wrong code.
 * - **A POST over the quota ceiling spends and counts no code:** the ceiling is asked before the code, so a refused body can neither
 *   burn a live code nor add a wrong one to the count.
 * - **A lock start is observable:** `ythril_mfa_lockouts_total{key="token"}` +1 and one `mfa.locked` audit row with the token id.
 * - **The address key, where the address is trustworthy.** Behind a configured proxy (`TRUST_PROXY=1`) five wrong codes from one
 *   `X-Forwarded-For` lock that ADDRESS (`key: 'address'`) for every token, not other addresses, on `/verify` too; the token key still
 *   goes first; without a proxy the header is ignored and loopback never counts as an address.
 *
 * Every case uses its own token(s) and, on the proxy server, its own address, so no case inherits another's count.
 *
 * ## Seen red
 *
 * On the base nothing counts: the sixth attempt answers `403 MFA_INVALID` (or `200 { valid: false }`) instead of 429, a quota-refused POST
 * answers `MFA_REQUIRED`, and `judgeMfaCode` is not exported.
 *
 * Run: `npm run test:up` first, then node --test testing/standalone/a-wrong-mfa-code-is-counted-and-locks-db.test.js
 * (requires a prior `npm run build -w server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { tempInstance, boot } from './_round-open-fixtures.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { codeAtStep, wrongCode, staleCode } from './_totp-codes.mjs';
import { keepEnv } from '../_shared/env-kept.mjs';

const dir = tempInstance('ythril-q694-lock-');
const skip = await mongoSkipReason();
const CEILING_ENV = 'YTHRIL_RATE_LIMIT_PER_MINUTE';
const ENV = { SKIP_AUTH_RATE_LIMIT: 'true', SKIP_GLOBAL_RATE_LIMIT: 'true' };
const restoreEnv = keepEnv(['SKIP_AUTH_RATE_LIMIT', 'SKIP_GLOBAL_RATE_LIMIT', 'YTHRIL_RATE_LIMIT_PER_MINUTE', 'TRUST_PROXY']);
const AUDIT = '/api/admin/audit-log/export'; // GET, requireAdminMfa, changes nothing

describe('a wrong second-factor code is counted and locks (real app, MFA on)', { skip }, () => {
  let mongo; let plain; let proxied; let totp; let tokens; let loader; let register; let serial = 0; let addr = 0;
  before(async () => {
    Object.assign(process.env, ENV);
    mongo = await openTestMongo('q694lock');
    await boot(dir, { networks: [] });
    loader = await import('../../server/dist/config/loader.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    totp = await import('../../server/dist/auth/totp.js');
    ({ register } = await import('../../server/dist/metrics/registry.js'));
    delete process.env.TRUST_PROXY;
    plain = await listenApp();
    process.env.TRUST_PROXY = '1';
    proxied = await listenApp();
    delete process.env.TRUST_PROXY;
  });
  after(async () => {
    restoreEnv();
    await plain?.close();
    await proxied?.close();
    await closeTestMongo();
    removeInstanceDir(dir);
  });

  /** A fresh instance with `n` admin tokens (exempt or not), MFA on, and the codes the authenticator shows, in the order the server accepts them. */
  async function setup({ n = 1, exempt = false } = {}) {
    await boot(dir, { networks: [] });
    const made = [];
    for (let i = 0; i < n; i++) made.push(await tokens.createToken({ name: `lock-${++serial}`, admin: true, ...(exempt ? { mfa: 'exempt' } : {}) }));
    const { secret } = totp.enableMfa('Ythril', 'q694');
    let step = -2;
    return {
      keys: made.map(m => m.plaintext), ids: made.map(m => m.record.id), secret,
      wrong: wrongCode(secret),
      next: () => { assert.ok(step < 1, 'a case needs more than three correct codes'); return codeAtStep(secret, ++step); },
    };
  }
  /** One request; `from` puts an X-Forwarded-For on it. */
  async function call(srv, key, { method = 'GET', route = AUDIT, code, body, from } = {}) {
    const r = await fetch(`${srv.url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json',
        ...(code ? { 'x-totp-code': code } : {}), ...(from ? { 'x-forwarded-for': from } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 100) }; }
    return { status: r.status, retryAfter: r.headers.get('retry-after'), body: json };
  }
  const verify = (srv, key, code, opts = {}) => call(srv, key, { method: 'POST', route: '/api/mfa/verify', body: { code }, ...opts });
  const mint = (srv, key, code, extra = {}) => call(srv, key, { method: 'POST', route: '/api/tokens', code, body: { name: `minted-${++serial}`, mfa: 'exempt', ...extra } });

  function assertLocked(res, keyKind, what) {
    assert.equal(res.status, 429, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, 'MFA_LOCKED', what);
    assert.equal(res.body.code, 'MFA_LOCKED', what);
    assert.equal(res.body.key, keyKind, what);
    assert.equal(res.body.retryable, false, what);
    assert.ok(Number.isInteger(res.body.retryAfterSeconds) && res.body.retryAfterSeconds >= 1 && res.body.retryAfterSeconds <= 900, `${what}: ${res.body.retryAfterSeconds}`);
    assert.equal(res.retryAfter, String(res.body.retryAfterSeconds), `${what}: Retry-After is not retryAfterSeconds`);
    assert.equal(typeof res.body.message, 'string', what);
    assert.ok(res.body.message.length > 10, what);
  }
  const lockouts = async (kind) => {
    for (const line of (await register.metrics()).split('\n')) if (line.startsWith(`ythril_mfa_lockouts_total{key="${kind}"}`)) return Number(line.split(' ').pop());
    return 0;
  };
  const storedTokens = () => loader.getConfig().tokens.length;

  it('the token key: 5 wrong codes are 403 MFA_INVALID, the 6th attempt with a CORRECT code is 429 MFA_LOCKED and the code is not spent', async () => {
    const s = await setup();
    const startsBefore = await lockouts('token');
    for (let i = 1; i <= 5; i++) {
      const r = await call(plain, s.keys[0], { code: s.wrong });
      assert.deepEqual([r.status, r.body.error], [403, 'MFA_INVALID'], `wrong code ${i}: ${JSON.stringify(r.body)}`);
    }
    const good = s.next();
    assertLocked(await call(plain, s.keys[0], { code: good }), 'token', 'the 6th attempt, a correct code');
    assert.equal(totp.judgeMfaCode(good), 'ok', 'the locked attempt spent the code');
    // The lock start: one metric increment and one audit row, however many locked attempts follow.
    for (let i = 0; i < 3; i++) await call(plain, s.keys[0], { code: s.wrong });
    assert.equal(await lockouts('token'), startsBefore + 1, 'the lock start is not counted once');
    const rows = await auditRowsOf(mongo, { operation: 'mfa.locked', tokenId: s.ids[0] });
    assert.equal(rows.length, 1, `expected one mfa.locked row for the token, found ${rows.length}`);
    assert.match(String(rows[0].ip), /127\.0\.0\.1/, 'the audit row does not carry the address');
  });

  it('the three doors share one counter: 4 wrong on /verify, the 5th wrong and the 6th attempt on an admin route, then /verify is locked too', async () => {
    const s = await setup();
    for (let i = 1; i <= 4; i++) {
      const r = await verify(plain, s.keys[0], s.wrong);
      assert.deepEqual([r.status, r.body], [200, { valid: false }], `verify wrong ${i}`);
    }
    const fifth = await call(plain, s.keys[0], { code: s.wrong });
    assert.deepEqual([fifth.status, fifth.body.error], [403, 'MFA_INVALID'], 'the 5th wrong code is still answered as today');
    assertLocked(await call(plain, s.keys[0], { code: s.next() }), 'token', 'the 6th attempt on the admin route');
    assertLocked(await verify(plain, s.keys[0], s.next()), 'token', 'the verify door after the lock');
  });

  it('the exemption door counts and locks too, and a locked grant mints nothing', async () => {
    const s = await setup({ exempt: true });
    const minted = await mint(plain, s.keys[0], s.next());
    assert.equal(minted.status, 201, `control: a live code grants the exemption: ${JSON.stringify(minted.body)}`);
    const before = storedTokens();
    for (let i = 1; i <= 5; i++) {
      const r = await mint(plain, s.keys[0], s.wrong);
      assert.deepEqual([r.status, r.body.error], [403, 'MFA_REQUIRED'], `wrong code ${i}: ${JSON.stringify(r.body)}`);
    }
    assertLocked(await mint(plain, s.keys[0], s.next()), 'token', 'the 6th attempt at the exemption door');
    assert.equal(storedTokens(), before, 'a locked grant minted a token');
  });

  it('the lock is asked before the code is demanded: a locked token with NO code gets 429, and no code is never counted', async () => {
    const s = await setup();
    for (let i = 0; i < 10; i++) {
      const r = await call(plain, s.keys[0]);
      assert.deepEqual([r.status, r.body.error], [403, 'MFA_REQUIRED'], `no code ${i}`);
    }
    for (let i = 1; i <= 5; i++) {
      const r = await call(plain, s.keys[0], { code: s.wrong });
      assert.deepEqual([r.status, r.body.error], [403, 'MFA_INVALID'], `wrong code ${i}: a missing code was counted`);
    }
    assertLocked(await call(plain, s.keys[0]), 'token', 'no code from a locked token');
  });

  it('a replay and a stale code answer as a wrong code does at each door, and a dozen of them lock nothing', async () => {
    const s = await setup({ n: 2 });
    const [admin, viaVerify] = s.keys;
    // enforceMfa door
    const used = s.next();
    assert.equal((await call(plain, admin, { code: used })).status, 200, 'control: the correct code is accepted once');
    const wrong = await call(plain, admin, { code: s.wrong });
    assert.deepEqual([wrong.status, wrong.body], [403, { error: 'MFA_INVALID' }]);
    for (let i = 0; i < 6; i++) {
      for (const [what, code] of [['replay', used], ['stale', staleCode(s.secret)]]) {
        const r = await call(plain, admin, { code });
        assert.deepEqual([r.status, r.body], [wrong.status, wrong.body], `${what} ${i} is told apart from a wrong code at the admin door`);
      }
    }
    // /verify door
    const vWrong = await verify(plain, viaVerify, s.wrong);
    assert.deepEqual([vWrong.status, vWrong.body], [200, { valid: false }]);
    for (let i = 0; i < 6; i++) {
      for (const [what, code] of [['replay', used], ['stale', staleCode(s.secret)]]) {
        const r = await verify(plain, viaVerify, code);
        assert.deepEqual([r.status, r.body], [vWrong.status, vWrong.body], `${what} ${i} is told apart at /verify`);
      }
    }
    // exemption door (an exempt admin: the token is made here so no code is asked at the door)
    const exempt = await tokens.createToken({ name: `lock-${++serial}`, admin: true, mfa: 'exempt' });
    const mWrong = await mint(plain, exempt.plaintext, s.wrong);
    assert.equal(mWrong.status, 403);
    for (let i = 0; i < 6; i++) {
      for (const [what, code] of [['replay', used], ['stale', staleCode(s.secret)]]) {
        const r = await mint(plain, exempt.plaintext, code);
        assert.deepEqual([r.status, r.body.error, r.body.message], [mWrong.status, mWrong.body.error, mWrong.body.message], `${what} ${i} is told apart at the exemption door`);
      }
    }
    // None of the 12 refusals per token counted: five more wrong codes are still answered, and only the sixth attempt locks.
    for (const key of [admin, viaVerify]) {
      let last;
      for (let i = 1; i <= 4; i++) last = await call(plain, key, { code: s.wrong });
      assert.equal(last.status, 403, 'a replay or a stale code was counted: the token locked early');
      assertLocked(await call(plain, key, { code: s.wrong }), 'token', 'the wrong codes themselves still count');
    }
  });

  it('a throw while burning the step is a 500, and counts nothing', async () => {
    const s = await setup();
    const blocker = path.join(path.dirname(process.env.CONFIG_PATH), 'secrets.json.tmp');
    fs.mkdirSync(blocker, { recursive: true });
    let thrown;
    try {
      thrown = await call(plain, s.keys[0], { code: s.next() });
    } finally {
      fs.rmSync(blocker, { recursive: true, force: true });
    }
    assert.equal(thrown.status, 500, `a store failure while verifying a code answered ${thrown.status} ${JSON.stringify(thrown.body)}`);
    assert.ok(!['MFA_INVALID', 'MFA_REQUIRED', 'MFA_LOCKED'].includes(thrown.body.error), 'the failure was answered as a code verdict');
    for (let i = 1; i <= 5; i++) {
      const r = await call(plain, s.keys[0], { code: s.wrong });
      assert.deepEqual([r.status, r.body.error], [403, 'MFA_INVALID'], `wrong code ${i}: the throw was counted as a guess`);
    }
    assertLocked(await call(plain, s.keys[0], { code: s.wrong }), 'token', 'only the five wrong codes counted');
  });

  it('a POST over the quota ceiling spends and counts no code', async () => {
    const s = await setup({ exempt: true });
    process.env[CEILING_ENV] = '50';
    const over = { rateLimitPerMinute: 500 };
    for (let i = 1; i <= 6; i++) {
      const r = await mint(plain, s.keys[0], s.wrong, over);
      assert.equal(r.status, 403, `wrong code ${i}: ${JSON.stringify(r.body)}`);
      assert.match(String(r.body.error), /instance ceiling of 50/, `wrong code ${i}: the code was asked before the quota: ${JSON.stringify(r.body)}`);
    }
    const live = s.next();
    const refused = await mint(plain, s.keys[0], live, over);
    assert.match(String(refused.body.error), /instance ceiling of 50/, 'a live code with an over-ceiling quota must be refused for the ceiling');
    const accepted = await mint(plain, s.keys[0], live, { rateLimitPerMinute: 50 });
    assert.equal(accepted.status, 201, `the refused POST spent or counted the code: ${JSON.stringify(accepted.body)}`);
  });

  describe('the address key, behind a configured proxy', () => {
    const fresh = () => `198.51.100.${++addr}`;

    it('five wrong codes from one address lock that address for every token on every door, and not another address', async () => {
      const s = await setup({ n: 4 });
      const a = fresh(); const b = fresh();
      for (let i = 1; i <= 3; i++) assert.equal((await call(proxied, s.keys[0], { code: s.wrong, from: a })).body.error, 'MFA_INVALID', `t0 wrong ${i}`);
      for (let i = 1; i <= 2; i++) assert.equal((await call(proxied, s.keys[1], { code: s.wrong, from: a })).body.error, 'MFA_INVALID', `t1 wrong ${i}`);
      assertLocked(await call(proxied, s.keys[2], { code: s.next(), from: a }), 'address', 'a fresh token from the locked address');
      assertLocked(await verify(proxied, s.keys[2], s.next(), { from: a }), 'address', '/verify from the locked address');
      const elsewhere = await call(proxied, s.keys[3], { code: s.next(), from: b });
      assert.equal(elsewhere.status, 200, `another address was locked: ${JSON.stringify(elsewhere.body)}`);
      const t0 = await call(proxied, s.keys[0], { code: s.wrong, from: b });
      assert.deepEqual([t0.status, t0.body.error], [403, 'MFA_INVALID'], 'three wrong codes locked a token');
    });

    it('failures spread over two addresses do not add up on either', async () => {
      const s = await setup({ n: 3 });
      const a = fresh(); const b = fresh();
      for (let i = 0; i < 4; i++) await call(proxied, s.keys[0], { code: s.wrong, from: a });
      for (let i = 0; i < 4; i++) await call(proxied, s.keys[1], { code: s.wrong, from: b });
      const ok = await call(proxied, s.keys[2], { code: s.next(), from: a });
      assert.equal(ok.status, 200, `4 failures from an address locked it: ${JSON.stringify(ok.body)}`);
    });

    it('with both keys at 5 the token key is named; the address key still locks the others', async () => {
      const s = await setup({ n: 2 });
      const a = fresh();
      for (let i = 0; i < 5; i++) await call(proxied, s.keys[0], { code: s.wrong, from: a });
      assertLocked(await call(proxied, s.keys[0], { code: s.next(), from: a }), 'token', 'the token that guessed');
      assertLocked(await call(proxied, s.keys[1], { code: s.next(), from: a }), 'address', 'another token from that address');
      const moved = await call(proxied, s.keys[1], { code: s.next(), from: fresh() });
      assert.equal(moved.status, 200, 'the second token is locked from another address');
    });

    it('the lock start of an address key is its own count', async () => {
      const s = await setup({ n: 5 });
      const before = { address: await lockouts('address'), token: await lockouts('token') };
      const a = fresh();
      for (let i = 0; i < 5; i++) await call(proxied, s.keys[i], { code: s.wrong, from: a });
      assert.equal(await lockouts('address'), before.address + 1, 'the address lock start is not counted once');
      assert.equal(await lockouts('token'), before.token, 'a token was counted as locked that never reached 5');
    });
  });

  describe('the address key, with no proxy configured', () => {
    it('X-Forwarded-For is ignored and loopback never counts as an address: six tokens, five wrong codes between them, the next is let in', async () => {
      const s = await setup({ n: 7 });
      for (let i = 0; i < 6; i++) {
        const r = await call(plain, s.keys[i], { code: s.wrong, from: `198.51.100.${200 + i}` });
        assert.deepEqual([r.status, r.body.error], [403, 'MFA_INVALID'], `token ${i}`);
      }
      const ok = await call(plain, s.keys[6], { code: s.next() });
      assert.equal(ok.status, 200, `the shared loopback address counted: ${JSON.stringify(ok.body)}`);
    });
  });
});
