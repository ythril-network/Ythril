/**
 * A peer's `409` carrying `code: 'path_unreadable'` is a REFUSAL to the sender, any other `409` is still a failure to retry
 * (bundle-70, Q-350 b, slice S2; vet reliability R7).
 *
 * ## The defect
 *
 * `pushStoredFile` sorts a peer's answer into delivered, tombstoned, refused (about the bytes: 400, 422) and failed (about the moment).
 * The upload door now answers a peer's push at a path it cannot look at `409 path_unreadable`: a statement about THE PATH, which asking again
 * with the same bytes answers the same way for as long as the path stays unreadable. Read as `failed`, the sender sends the whole file
 * again every cycle; read as `refused`, the caller remembers it (`noteRefusedUpload`) and sends nothing until something changes. A
 * `409` that is not about the path (a destination a regular file blocks, `path_blocked`) is the opposite: another try may meet the
 * moment it has passed, so it stays `failed`.
 *
 * ## The rule
 *
 *  - single body: `409` + `code: 'path_unreadable'` is `{ kind: 'refused', status: 409 }`
 *  - chunked (a file above the probe size): the same answer to a range ends the push as `refused`
 *  - `409` with another code, or none, is `failed`
 *
 * The engine-level half (the file is not sent again next cycle, said once) is `file-sync-leaves-a-path-nobody-could-look-at-alone-db`.
 *
 * ## Seen red
 *
 * The two refusals fail on the base: the outcome is `failed`. The two controls are green on the base and hold what must not widen.
 *
 * Run: node --test testing/standalone/a-409-path-unreadable-is-a-refusal-to-the-sender.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b70-s2-push-'));
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
const sendOf = (status, json) => { const seen = []; return { seen, send: async (req) => { seen.push(req); return { status, json }; } }; };

describe('how the sender reads a peer\'s 409', () => {
  it('a single-body push answered 409 path_unreadable is refused', async () => {
    const f = fileOf('small.bin', Buffer.from('a small file'));
    const { send, seen } = sendOf(409, { error: 'The path cannot be looked at', code: 'path_unreadable' });
    const out = await push.pushStoredFile({ peerId: 'p1', ...f, send });
    assert.equal(seen.length, 1, 'fixture: the push did not reach the peer exactly once');
    assert.equal(out.kind, 'refused', `read as ${out.kind}: the same bytes are sent again every cycle for as long as the path is unreadable`);
    assert.equal(out.status, 409);
  });

  it('a chunked push whose first range is answered 409 path_unreadable ends as refused, after that one range', async () => {
    const f = fileOf('big.bin', Buffer.alloc(push.PROBE_BYTES * 3, 7));
    const { send, seen } = sendOf(409, { error: 'The path cannot be looked at', code: 'path_unreadable' });
    const out = await push.pushStoredFile({ peerId: 'p2', ...f, send });
    assert.ok(seen.length >= 1 && seen[0].headers['Content-Range'], 'fixture: the push did not go through the chunked door');
    assert.equal(seen.length, 1, 'the sender went on sending ranges to a peer that refused the path');
    assert.equal(out.kind, 'refused', `read as ${out.kind}`);
  });

  for (const [what, json] of [['another code', { error: 'blocked by a file', code: 'path_blocked' }], ['no code', { error: 'conflict' }]]) {
    it(`a 409 with ${what} is still a failure, tried again next cycle (control)`, async () => {
      const f = fileOf(`other-${what.replace(/\W/g, '')}.bin`, Buffer.from('some bytes'));
      const out = await push.pushStoredFile({ peerId: 'p3', ...f, send: sendOf(409, json).send });
      assert.equal(out.kind, 'failed', `a 409 that is not about an unreadable path was read as ${out.kind}`);
    });
  }
});
