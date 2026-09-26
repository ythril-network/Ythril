/**
 * A handshake opened by a published pub/sub key is cheap to look up, short-lived, capped per caller, and dies with the
 * key that opened it.
 *
 * `POST /api/invite/redeem` (F-41) made the handshake store reachable without a token. The 5.4.0 pre-release lens
 * found three things that were harmless while only an admin could open a session: every lookup bcrypt-compared the
 * presented id against EVERY open session (so a flood of redeems made each unauthenticated apply cost N compares),
 * a redeemed session lived the full hour, and regenerating a leaked key left the sessions it had already opened
 * usable. All three are enforced in `server/src/api/invite-sessions.ts`, so they are tested there.
 *
 * Run: node --test testing/standalone/a-redeemed-handshake-is-short-and-dies-with-its-key.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let S;
before(async () => { S = await import('../../server/dist/api/invite-sessions.js'); });

const fields = (networkId, redeemed) => ({ networkId, privateKeyPem: 'k', publicKeyPem: 'p', ...(redeemed ? { redeemed } : {}) });
const keyOf = (map) => (id) => map[id];

describe('the session store', () => {
  it('finds a session by its id and nothing by another', async () => {
    const id = randomUUID();
    await S.openSession(id, fields('n-find'));
    const hit = await S.findSession(id, keyOf({}));
    assert.ok(hit, 'the opened session is found');
    assert.equal(hit[1].networkId, 'n-find');
    assert.equal(await S.findSession(randomUUID(), keyOf({})), null);
  });

  it('a lookup costs one bcrypt compare however many sessions are open', async () => {
    // Twenty open sessions: a scan that bcrypt-compared each would take seconds; a digest-selected lookup does not.
    for (let i = 0; i < 20; i++) await S.openSession(randomUUID(), fields('n-many'));
    const t = Date.now();
    assert.equal(await S.findSession(randomUUID(), keyOf({})), null, 'an unknown id costs no compare at all');
    const id = randomUUID();
    await S.openSession(id, fields('n-many'));
    const t2 = Date.now();
    assert.ok(await S.findSession(id, keyOf({})));
    assert.ok(Date.now() - t2 < 2_000 && t2 - t < 2_000, 'a lookup must not scale with the number of open sessions');
  });

  it('a redeemed session lives ten minutes, an admin one an hour', async () => {
    const a = await S.openSession(randomUUID(), fields('n-ttl'));
    const r = await S.openSession(randomUUID(), fields('n-ttl', { under: 'h1', by: '1.2.3.4' }));
    assert.ok(Math.abs(a.expiresAt - Date.now() - S.HANDSHAKE_TTL_MS) < 5_000);
    assert.ok(Math.abs(r.expiresAt - Date.now() - S.REDEEMED_TTL_MS) < 5_000);
    assert.ok(S.REDEEMED_TTL_MS <= 10 * 60 * 1000);
  });

  it('a redeemed session is refused once the network holds a different invite key', async () => {
    const id = randomUUID();
    await S.openSession(id, fields('n-rekey', { under: 'old-hash', by: '1.2.3.4' }));
    assert.ok(await S.findSession(id, keyOf({ 'n-rekey': 'old-hash' })), 'valid while the key is unchanged');
    assert.equal(await S.findSession(id, keyOf({ 'n-rekey': 'new-hash' })), null, 'a regenerated key closes it');
    assert.equal(await S.findSession(id, keyOf({ 'n-rekey': 'old-hash' })), null, 'and it stays closed');
  });

  it('counts redeemed sessions per network and per caller', async () => {
    for (const by of ['9.9.9.1', '9.9.9.1', '9.9.9.2']) await S.openSession(randomUUID(), fields('n-count', { under: 'h', by }));
    await S.openSession(randomUUID(), fields('n-count'));
    assert.deepEqual(S.redeemedOpen('n-count', '9.9.9.1'), { network: 3, caller: 2 });
  });
});

describe('the redeem route uses the store\'s caps', () => {
  const src = stripComments(readFileSync('server/src/api/invite.ts', 'utf8'));
  it('no route keeps a session map of its own', () => {
    assert.doesNotMatch(src, /new Map<string, HandshakeSession>/, 'the store lives in invite-sessions.ts');
    assert.doesNotMatch(src, /bcrypt\.compare\(handshakeId/, 'a lookup goes through findSession');
  });
  it('redeem refuses per network AND per caller, and records the key it opened under', () => {
    const at = src.indexOf("inviteRouter.post('/redeem'");
    assert.ok(at > -1, 'the redeem route is gone — re-anchor this gate');
    const body = src.slice(at, src.indexOf('\n});', at));
    assert.match(body, /redeemedOpen\(/);
    assert.match(body, /MAX_REDEEMED_PER_CALLER/);
    assert.match(body, /under: net\.inviteKeyHash/);
  });
});
