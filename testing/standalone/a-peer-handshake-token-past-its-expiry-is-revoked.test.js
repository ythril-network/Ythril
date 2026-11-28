/**
 * A peer token whose handshake expired unfinished is revoked, at boot and when the peer's next handshake lands (bundle-47, Q-354).
 *
 * ## What was true before
 *
 * A handshake mints the peer's token with an expiry, and lifts it when the handshake completes (`adoptPeerToken`). Both clean-ups
 * skipped every peer token that still carried an expiry as "a handshake in flight", without asking whether that expiry had passed:
 * the boot sweep (`supersededPeerTokenIds`) and the adoption, which revokes only tokens already made live. A handshake that never
 * finished left its token listed for ever, unusable but shown beside the live one. The 5.6.1 note said these leftovers were dropped at
 * start; they were not.
 *
 * ## What holds now
 *
 * `expiredHandshakeTokenIds(config, now)` names every peer-bound token whose expiry has passed. A token with a future expiry (a
 * handshake still in flight), a token with no expiry (a live peer token) and a token bound to no peer are left alone. The boot sweep
 * revokes what it names, and `adoptPeerToken` revokes the same peer's expired ones beside the live tokens it replaces.
 *
 * Run: node --test testing/standalone/a-peer-handshake-token-past-its-expiry-is-revoked.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as tokens from '../../server/dist/auth/tokens.js';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const NOW = Date.parse('2026-11-28T08:00:00Z');
const tok = (id, over = {}) => ({ id, name: `peer:${id}`, peerInstanceId: 'p', createdAt: '2026-11-01T00:00:00Z', lastUsed: null, expiresAt: null, ...over });

describe('a peer handshake token past its expiry is revoked', () => {
  it('names a peer token whose expiry has passed, and only that one', () => {
    const fn = tokens.expiredHandshakeTokenIds;
    assert.equal(typeof fn, 'function', 'auth/tokens.js exports no expiredHandshakeTokenIds');
    const config = {
      tokens: [
        tok('expired', { expiresAt: '2026-09-28T00:00:00Z' }),
        tok('in-flight', { expiresAt: '2026-11-28T08:10:00Z' }),
        tok('live'),
        { id: 'operator-expired', name: 'mine', createdAt: '2026-01-01T00:00:00Z', lastUsed: null, expiresAt: '2026-02-01T00:00:00Z' },
        tok('expiry-unreadable', { expiresAt: 'not a date' }),
      ],
    };
    assert.deepEqual(fn(config, NOW), ['expired']);
  });

  it('an expiry exactly now has passed (expiry is when use stops)', () => {
    assert.deepEqual(tokens.expiredHandshakeTokenIds({ tokens: [tok('edge', { expiresAt: new Date(NOW).toISOString() })] }, NOW), ['edge']);
  });

  it('the boot sweep and adoptPeerToken both revoke what it names', () => {
    const boot = stripComments(readFileSync('server/src/bootstrap.ts', 'utf8'));
    // What the sweep revokes is driven in the -db twin (revokeExpiredHandshakeTokens); here only that the boot runs it.
    assert.match(boot, /\brevokeExpiredHandshakeTokens\(\)/, 'the boot does not run the expired handshake sweep');
    const adopt = bodyOf(stripComments(readFileSync('server/src/auth/tokens.ts', 'utf8')), 'adoptPeerToken');
    assert.match(adopt, /\bexpiredHandshakeTokenIds\(/, 'adoptPeerToken does not revoke the peer\'s expired handshake tokens');
  });
});
