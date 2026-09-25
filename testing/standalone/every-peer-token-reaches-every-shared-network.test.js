/**
 * Every peer token is scoped by `peerTokenSpaces`: the union of all networks the pair shares (`Q-47`).
 *
 * An instance keeps one outbound token per peer, so whichever handshake ran last supplies the token for every
 * network the two share. A mint site that scopes to the joining network alone reproduces Q-47 — a second network
 * with the same peer silently cuts off the first — and the integration test only drives the inviter's side. So this
 * reads every `createToken({...})` in the server that binds a `peerInstanceId`, and requires the scope to come from
 * the shared module. The set is derived from the source, never listed.
 *
 * Run: node --test testing/standalone/every-peer-token-reaches-every-shared-network.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** Each `createToken({ ... })` call's argument text, braces balanced. */
function createTokenCalls(src) {
  const out = [];
  let at = src.indexOf('createToken({');
  while (at !== -1) {
    let depth = 0;
    let i = src.indexOf('{', at);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push(src.slice(start, i + 1));
    at = src.indexOf('createToken({', i);
  }
  return out;
}

describe('peer token scope', () => {
  const mints = readTrackedSources('server/src', { untracked: true })
    .flatMap(({ file, text }) => createTokenCalls(stripComments(text))
      .filter(call => /\bpeerInstanceId\s*:/.test(call))
      .map(call => ({ file, call })));

  it('finds the mint sites it is meant to govern', () => {
    // Both halves of the handshake mint one: the inviter at apply, the joiner at join-remote.
    assert.ok(mints.length >= 2, `found ${mints.length} peer-token mint site(s); the scan is broken, not the code`);
  });

  it('scopes every one of them with peerTokenSpaces', () => {
    const wrong = mints.filter(m => !/\bspaces\s*:\s*peerTokenSpaces\(/.test(m.call));
    assert.deepEqual(wrong.map(m => m.file), [],
      'a peer token scoped to one network cuts off every other network the pair shares; use peerTokenSpaces');
  });
});
