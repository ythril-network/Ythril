/**
 * A peer holds one token here, and a new handshake revokes the one it replaces (`Q-163`).
 *
 * Owner, 2026-09-29, with a screenshot of Settings > Tokens: eight `peer:ythril-dev` tokens, all but one last used
 * minutes after they were made. Every network join mints an inbound token for the peer, and the peer keeps ONE
 * outbound token per instance, overwriting it on each handshake — so every earlier token was dead but still valid.
 * The only cleanup revoked a peer's tokens once it shared no network with us, which never happens while the two
 * share any network at all.
 *
 * Now the step that makes a peer's token the live one is `adoptPeerToken`, and it revokes the rest; boot sweeps the
 * leftovers from before, choosing only tokens the peer has provably stopped presenting.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-peer-holds-one-token-here.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { supersededPeerTokenIds } from '../../server/dist/auth/tokens.js';
import { trackedSources, REPO_ROOT } from './_sources.mjs';

const tok = (id, peer, createdAt, lastUsed = null) => ({ id, name: `peer:${peer}`, peerInstanceId: peer, createdAt, lastUsed, expiresAt: null });

describe('a peer holds one token here', () => {
  it('the tokens a newer handshake replaced, and not used since it was made, are superseded', () => {
    const tokens = [
      tok('old-1', 'p', '2026-09-25T10:00:00Z', '2026-09-25T10:05:00Z'),
      tok('old-2', 'p', '2026-09-27T10:37:00Z', '2026-09-27T10:38:00Z'),
      tok('live', 'p', '2026-09-27T10:39:32Z', '2026-09-29T19:00:00Z'),
      tok('other-peer', 'q', '2026-09-20T00:00:00Z', '2026-09-21T00:00:00Z'),
      { id: 'operator', name: 'mine', createdAt: '2026-01-01T00:00:00Z', lastUsed: null, expiresAt: null },
    ];
    assert.deepEqual(supersededPeerTokenIds({ tokens }).sort(), ['old-1', 'old-2']);
  });

  it('an older token the peer presented AFTER the newest was made is left alone', () => {
    // It is still in use, so the newest is the one that never took — revoking the old one would cut the peer off.
    const tokens = [
      tok('older-but-used', 'p', '2026-09-25T10:00:00Z', '2026-09-29T12:00:00Z'),
      tok('newest', 'p', '2026-09-27T10:00:00Z', null),
    ];
    assert.deepEqual(supersededPeerTokenIds({ tokens }), []);
  });

  it('a token still in a handshake is never superseded, and never counts as the newest', () => {
    // Two joins with one peer can overlap; the one in flight carries an expiry and ends by itself if it never lands.
    const tokens = [
      tok('live', 'p', '2026-09-27T10:00:00Z', '2026-09-27T10:01:00Z'),
      { ...tok('in-flight', 'p', '2026-09-29T10:00:00Z'), expiresAt: '2026-09-29T10:10:00Z' },
    ];
    assert.deepEqual(supersededPeerTokenIds({ tokens }), []);
  });

  it('nothing makes a peer token live except the function that revokes the ones it replaces', () => {
    // Lifting a pairing token's expiry IS making it live; a second site doing that by hand is where the leak returns.
    const owner = 'server/src/auth/tokens.ts';
    const offenders = trackedSources(['server/src'], { untracked: true, exclude: [owner] })
      .filter(f => /setTokenExpiry\([^)]*,\s*null\s*\)/.test(readFileSync(`${REPO_ROOT}/${f}`, 'utf8')));
    assert.deepEqual(offenders, [], `these make a peer token live without revoking the one it replaces: ${offenders.join(', ')}`);
    const join = readFileSync(`${REPO_ROOT}/server/src/networks/join-remote-act.ts`, 'utf8');
    assert.match(join, /adoptPeerToken\(/, 'a remote join mints a token for the network\'s host, and must adopt it');
  });
});
