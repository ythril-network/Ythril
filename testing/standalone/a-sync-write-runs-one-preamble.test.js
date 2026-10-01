/**
 * Every sync WRITE route runs one preamble, `pushAllowed` (`api/sync/_shared.ts`) — a space named, the caller's
 * reach into it, a peer (or admin) token, the network direction (`Q-107` part 1, duplicated-rule pass).
 *
 * ## The rule
 *
 * The four checks were written out at each write route: the document routes, the record-tombstone route and the
 * file-tombstone route. A route that drops one of four lines is a door with less in front of it, and the copies
 * read identically in a diff, so the weaker one is the one nobody sees. So the two checks only a write needs —
 * `isNonPeerSyncWrite` and `isDirectionalWriteBlocked` — are called from `pushAllowed` and nowhere else, and every
 * POST registered on a sync router that takes a document calls `pushAllowed`.
 *
 * Seen red by mutation, restored by hand: the file-tombstone route's inline `isNonPeerSyncWrite` put back.
 *
 * Run: node --test testing/standalone/a-sync-write-runs-one-preamble.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { statementFrom } from './_structural-window.mjs';

const SOURCES = readTrackedSources('server/src', { ext: ['.ts'], floor: 200, specs: false, untracked: true })
  .map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), code: stripComments(text) }));
const SHARED = 'server/src/api/sync/_shared.ts';

describe('a sync write runs one preamble', () => {
  it('the write-only checks are called by pushAllowed alone', () => {
    const calls = SOURCES.flatMap(s => [...s.code.matchAll(/\b(isNonPeerSyncWrite|isDirectionalWriteBlocked)\(/g)]
      .filter(m => !/function\s+$/.test(s.code.slice(Math.max(0, s.code.lastIndexOf('\n', m.index)), m.index)))
      .map(m => `${s.file}: ${m[1]}`));
    assert.ok(calls.length >= 2, `the write checks were not found at all (${calls}) — re-anchor this gate`);
    const outside = calls.filter(c => !c.startsWith(`${SHARED}:`));
    assert.deepEqual(outside, [], 'a route writes the sync-write preamble out itself again — call pushAllowed');
  });

  it('every document-taking POST on the sync routers calls pushAllowed', () => {
    const missing = [];
    let routes = 0;
    for (const s of SOURCES.filter(f => f.file.startsWith('server/src/api/sync/') && /(?:docs|tombstones)\.ts$/.test(f.file))) {
      for (const m of s.code.matchAll(/(\w+Router)\.post\(\s*'([^']+)'/g)) {
        routes++;
        if (!/\bpushAllowed\(req, res/.test(statementFrom(s.code, m.index, `${s.file} POST ${m[2]}`))) missing.push(`${s.file} POST ${m[2]}`);
      }
    }
    assert.ok(routes >= 7, `only ${routes} write route(s) found — re-anchor this gate`);
    assert.deepEqual(missing, [], 'a sync write route skips the shared preamble');
  });
});
