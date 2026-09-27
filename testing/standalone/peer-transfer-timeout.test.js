/**
 * A whole-file transfer does not get a control-plane timeout.
 *
 * ## The bug, and why it is worse than a missing timeout
 *
 * Every peer call in the sync engine already had a timeout — 10 s for control-plane calls, 60 s for
 * batches. Both are right for what they were written for: members, votes, manifests, record pages, all
 * bounded payloads where "still running" means "stuck".
 *
 * Two calls are not that. Pulling a file and pushing a file stream the whole file, and
 * `AbortSignal.timeout` covers the entire operation including reading the body. So the pull inherited a
 * **10-second** budget for an arbitrarily large file and the push a 60-second one. Any file slower than
 * that — a video, a scanned PDF, anything at all over a modest link — was aborted, logged as a warning,
 * and skipped. Sync then reported success for the cycle.
 *
 * A missing timeout hangs, which is visible. A timeout that is too short for the work **silently drops
 * data and calls it done**, which is not. The asymmetry (10 s pull vs 60 s push) also meant a file could
 * push to a peer and never come back, which looks like the peer lost it.
 *
 * Run: node --test testing/standalone/peer-transfer-timeout.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let PEER_TIMEOUT_MS, PEER_TRANSFER_TIMEOUT_MS;

before(async () => {
  ({ PEER_TIMEOUT_MS, PEER_TRANSFER_TIMEOUT_MS } = await import('../../server/dist/sync/peer-fetch.js'));
});

// File sync moved out of the engine into its own module (Q-68); the whole-file calls live there.
const engineSrc = () => readFileSync('server/src/sync/file-sync.ts', 'utf8');
const cycleSrc = () => readFileSync('server/src/sync/engine.ts', 'utf8'); // the cycle's own control-plane options

describe('peer transfer budgets', () => {
  it('the transfer budget is much larger than the control-plane one', () => {
    assert.ok(PEER_TIMEOUT_MS > 0 && PEER_TRANSFER_TIMEOUT_MS > 0);
    assert.ok(PEER_TRANSFER_TIMEOUT_MS >= 10 * PEER_TIMEOUT_MS,
      'a file transfer needs an order of magnitude more room than a members/votes call');
  });

  it('both whole-file calls use the transfer budget, not a control-plane one', () => {
    // Located by their endpoint — /api/files/ is the only whole-body peer route — so this keeps holding
    // if the surrounding code moves.
    const src = engineSrc();
    const fileCalls = [...src.matchAll(/peerSafeFetch\(\s*\n?\s*`\$\{member\.url\}\/api\/files\//g)];
    assert.equal(fileCalls.length, 2, 'expected exactly the pull and the push');

    for (const m of fileCalls) {
      // Read forward to the end of that call's argument list.
      let depth = 0, end = m.index;
      for (let i = src.indexOf('(', m.index); i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      const block = src.slice(m.index, end);
      assert.ok(block.includes('PEER_TRANSFER_TIMEOUT_MS'),
        `a whole-file peer call is using a control-plane timeout — a large file would be aborted and ` +
        `skipped with only a warning:\n${block.slice(0, 220)}`);
    }
  });

  it('control-plane calls are NOT given the transfer budget', () => {
    // The opposite mistake: a stuck members/votes call should fail in seconds, not sit for ten minutes
    // holding up the cycle. The shared options factories must stay on the short budgets.
    const src = cycleSrc();
    const factories = src.slice(src.indexOf('const fetchOpts'), src.indexOf('// ── Presync warm-up'));
    assert.ok(factories.includes('FETCH_TIMEOUT_MS'), 'the control-plane factory lost its timeout');
    assert.ok(!factories.includes('PEER_TRANSFER_TIMEOUT_MS'),
      'the transfer budget leaked into the control-plane options factory');
  });
});

describe('peerSafeFetch applies a default when the caller supplies none', () => {
  it('every call inherits a timeout even if the call site forgets one', async () => {
    // Belt and braces. Today every call site does pass one — verified by reading all 21 — but `fetch`
    // has no default, and the next caller should not have to know that.
    const { peerSafeFetch } = await import('../../server/dist/sync/peer-fetch.js');
    assert.equal(typeof peerSafeFetch, 'function');
    const src = readFileSync('server/src/sync/peer-fetch.ts', 'utf8');
    assert.match(src, /init\.signal \?\? AbortSignal\.timeout/,
      'the default must not clobber a caller-supplied signal');
  });
});
