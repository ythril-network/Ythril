/**
 * A push the peer answered by keeping its own copy is not a delivery (bundle-47, Q-410, review finding F1).
 *
 * ## What was true before
 *
 * The receiver decides a push over a live file as the pull decides it: other bytes over a file that is not the agreed version land beside it
 * as a conflict copy (`200 { conflict: { path } }`), and the agreed version sent again after the receiver moved on stores nothing
 * (`200 { skipped: 'older' }`). The sender read every 2xx without `tombstoned` as `delivered`, so it recorded the receiver as holding
 * its bytes. Its next pull then found the receiver's own version, took its own copy for the agreed one and replaced it: the sender's
 * edit was overwritten on the sender, kept only as the receiver's instance-local conflict copy.
 *
 * ## What holds now
 *
 * Both answers are `kept` (the peer kept its own copy): no agreed hash is recorded for them, and the caller does not send the same bytes
 * again while they are unchanged. A completed upload (`201 { path, sha256 }`) is still `delivered`, on the single body and the chunked door.
 *
 * Run: node --test testing/standalone/a-peer-that-kept-its-own-copy-is-no-delivery.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b47-kept-'));
process.env['DATA_ROOT'] = root;

let push;
before(async () => { push = await import('../../server/dist/sync/file-push.js'); });
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
beforeEach(() => { push.forgetPeerBodyLimits(); });

const fileOf = (name, bytes) => {
  const abs = path.join(root, name);
  fs.writeFileSync(abs, bytes);
  return { abs, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
/** A peer that answers every range `202` and the last one `last`. */
const peerAnswering = (last) => async (req) => {
  const range = req.headers['Content-Range'];
  if (!range) return last;
  const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(range);
  return Number(end) + 1 >= Number(total) ? last : { status: 202, json: { received: Number(end) + 1 } };
};

describe('a push the peer answered by keeping its own copy is not a delivery', () => {
  for (const [what, json] of [['a conflict copy', { path: 'a.txt', sha256: 'x', conflict: { path: 'a_2026_peer.txt' } }], ['an older version', { path: 'a.txt', sha256: 'x', skipped: 'older' }]]) {
    it(`single body: ${what} is kept, not delivered`, async () => {
      const f = fileOf(`single-${what.length}.bin`, Buffer.from(`bytes for ${what}`));
      const out = await push.pushStoredFile({ peerId: 'p1', ...f, send: peerAnswering({ status: 200, json }) });
      assert.equal(out.kind, 'kept', `read as ${out.kind}: the sender records an agreement the receiver never made, and its next pull overwrites its own edit`);
    });

    it(`chunked: ${what} on the completing range is kept, not delivered`, async () => {
      const f = fileOf(`chunked-${what.length}.bin`, Buffer.alloc(push.PROBE_BYTES * 3, 5));
      const out = await push.pushStoredFile({ peerId: 'p2', ...f, send: peerAnswering({ status: 200, json }) });
      assert.equal(out.kind, 'kept', `read as ${out.kind}`);
    });
  }

  it('a completed upload is still delivered, single and chunked (control)', async () => {
    const small = fileOf('small.bin', Buffer.from('small'));
    const big = fileOf('big.bin', Buffer.alloc(push.PROBE_BYTES * 3, 9));
    const one = await push.pushStoredFile({ peerId: 'p3', ...small, send: peerAnswering({ status: 201, json: { path: 'small.bin', sha256: small.sha256 } }) });
    const many = await push.pushStoredFile({ peerId: 'p3', ...big, send: peerAnswering({ status: 201, json: { path: 'big.bin', sha256: big.sha256 } }) });
    assert.deepEqual([one.kind, many.kind], ['delivered', 'delivered']);
  });

  it('the file push records an agreed hash only for a delivery (source gate)', () => {
    const src = stripComments(readFileSync('server/src/sync/file-sync.ts', 'utf8'));
    const block = src.slice(src.indexOf('await pushStoredFile('), src.indexOf('await pushStoredFile(') + 2500);
    assert.match(block, /outcome\.kind === 'kept'/, 'the push loop has no branch for a peer that kept its own copy');
    const keptBranch = block.slice(block.indexOf("outcome.kind === 'kept'"), block.indexOf('} else', block.indexOf("outcome.kind === 'kept'")));
    assert.doesNotMatch(keptBranch, /recordSyncBase\(/, 'the kept branch records an agreed hash');
  });
});
