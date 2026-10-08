/**
 * `readStored` holds an encrypted file ONCE, sized from the file's own plaintext size, and never returns a short or padded buffer
 * (bundle-89, Q-425 part 5, plan E5 item 6).
 *
 * ## The defect
 *
 * `readStored` read the whole ciphertext (`fs.readFile`: N), decrypted it into an array of chunks (N), and concatenated them
 * (`Buffer.concat`: N). An encrypted file of N bytes therefore peaked at three times N, for a function whose result is one N-byte
 * buffer. The plan decrypts as a stream straight into ONE buffer allocated from `statStored(...).size`.
 *
 * ## The rules
 *
 *  1. **The peak is about one N, not three.** Measured in a child process (a peak only rises), over an encrypted file written as a
 *     stream. `READ_PEAK_MULTIPLE` is a chosen bound between 3 (unchanged) and 1 (after).
 *  2. **A buffer sized from a stat can never be returned short, or padded.** The buffer is sized before the bytes arrive, so the
 *     one way to get this wrong is to return it without checking that what was decrypted is what was promised: stale heap bytes
 *     (`allocUnsafe`) or zeros (`alloc`) past a short read. Asserted by its EFFECT, over every size that has a boundary in the
 *     format: `0`, `1`, a chunk less one, exactly a chunk, a chunk plus one, two chunks, and an odd number of chunks plus a few
 *     bytes; encrypted, and plaintext (a legacy file in a mixed tree, and an empty file, both of which must keep READING, exactly
 *     their bytes, as `stored-files-are-encrypted-at-rest.test.js` has always held). The returned buffer's length is the
 *     file's size and its bytes are the file's bytes.
 *  3. **A file that does not decode is refused, never returned partly**: a truncated tail, a flipped bit, a size that disagrees with
 *     the envelope (garbage appended), each a `StoredFileUnreadable`.
 *
 * ## Seen red
 *
 * Rule 1 is red on the unchanged code (measured: 2.40 x for 96 MiB, against a bound of 1.8 x; RSS counts touched pages, so the
 * peak reads a little under the 3 x of allocated bytes). Rules 2 and 3 are GUARD rows: the unchanged `readStored` concatenates exactly
 * what it decrypted and refuses what does not decode, so they hold there; they are what the streamed, pre-sized version must not
 * break, and are the half of this change a mistake would hide in (a short read into a buffer that was never zeroed).
 *
 * The `alloc` versus `allocUnsafe` choice is deliberately NOT asserted by reading source: the defect it prevents is a stale or
 * padded byte, and rule 2 fails on that whatever the allocation call looks like.
 *
 * Run: node --test testing/standalone/a-stored-file-is-read-into-one-buffer-of-its-size.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testChildEnv } from '../_shared/test-child-env.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const MIB = 1024 * 1024;
/** Chosen, not derived: peak growth in file sizes. The unchanged code costs 3; a pre-sized streamed read costs 1. */
const READ_PEAK_MULTIPLE = 1.8;
const N = 96 * MIB;
const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '_read-stored-peak-child.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89-read-'));
process.env['DATA_ROOT'] = root;
const filesDir = path.join(root, 'files', 'general');
fs.mkdirSync(filesDir, { recursive: true });
const file = (name) => path.join(filesDir, name);

let box, stored;
before(async () => {
  box = await import('../../server/dist/config/secretbox.js');
  stored = await import('../../server/dist/files/stored-bytes.js');
});
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

const withSecret = (env) => {
  for (const k of ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE']) delete process.env[k];
  Object.assign(process.env, env);
  stored.resetStoredKeyCacheForTests();
};
const KEYED = () => ({ YTHRIL_MASTER_KEY: crypto.randomBytes(32).toString('base64') });

describe('readStored: one buffer of the file\'s size', () => {
  it(`an encrypted file's peak growth is at most ${READ_PEAK_MULTIPLE} x its size (a chosen bound between 3 x and 1 x)`, async () => {
    const messages = [];
    const child = fork(CHILD, [], {
      env: testChildEnv({ B89_CHILD: JSON.stringify({ size: N, secret: true }) }),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (m) => messages.push(m));
    await waitFor(() => messages.length > 0, 120_000, 100, () => 'the child never reported');
    const m = messages[0];
    assert.equal(m.type, 'done', `the child failed: ${m.message}`);
    assert.equal(m.length, N, 'fixture: the child read back a different number of bytes than it wrote');
    const grew = (m.peakKb.afterLarge - m.peakKb.afterSmall) * 1024;
    assert.ok(grew <= READ_PEAK_MULTIPLE * N,
      `reading a ${N / MIB} MiB encrypted file grew the peak by ${(grew / MIB).toFixed(0)} MiB = ${(grew / N).toFixed(2)} x its size `
      + `(bound ${READ_PEAK_MULTIPLE} x): the ciphertext, the decrypted chunks and their concatenation are all held at once`);
  });

  describe('GUARD: what is returned is exactly the file', () => {
    const sizesOf = () => {
      const C = box.CHUNK_PLAINTEXT_BYTES;
      return [0, 1, C - 1, C, C + 1, 2 * C, 3 * C + 17];
    };
    for (const [label, env] of [['encrypted', KEYED], ['plaintext (no secret)', () => ({})]]) {
      it(`${label}: every size at a chunk boundary reads back its exact bytes, never short, padded or stale`, async () => {
        withSecret(env());
        for (const n of sizesOf()) {
          const plain = crypto.randomBytes(n);
          const abs = file(`${label.split(' ')[0]}-${n}.bin`);
          await stored.writeStored(abs, plain);
          const got = await stored.readStored(abs);
          assert.equal(got.length, n, `${label}, ${n} bytes: ${got.length} came back`);
          assert.ok(plain.equals(got), `${label}, ${n} bytes: the bytes differ (padded or stale)`);
          assert.equal((await stored.statStored(abs)).size, n, `${label}, ${n} bytes: the stat disagrees with the read`);
        }
      });
    }

    it('a legacy plaintext file in a keyed tree, and an empty file, keep reading as exactly their bytes', async () => {
      withSecret(KEYED());
      const legacy = file('legacy.bin');
      const bytes = crypto.randomBytes(box.CHUNK_PLAINTEXT_BYTES + 5);
      fs.writeFileSync(legacy, bytes);
      assert.ok(bytes.equals(await stored.readStored(legacy)), 'a legacy plaintext file was altered by the read');
      const empty = file('empty.bin');
      fs.writeFileSync(empty, '');
      const got = await stored.readStored(empty);
      assert.equal(got.length, 0, 'an empty file came back with bytes');
    });
  });

  describe('GUARD: a file that does not decode is refused, never returned partly', () => {
    const tamper = async (name, edit) => {
      withSecret(KEYED());
      const abs = file(name);
      await stored.writeStored(abs, crypto.randomBytes(box.CHUNK_PLAINTEXT_BYTES * 3 + 100));
      const raw = fs.readFileSync(abs);
      fs.writeFileSync(abs, edit(Buffer.from(raw), box.chunkedHeaderLength(raw)));
      return abs;
    };
    const cases = {
      'a truncated tail': (b) => b.subarray(0, b.length - 1000),
      'a flipped bit in the body': (b, h) => { b[h + 10] ^= 1; return b; },
      'a size that disagrees with the envelope (bytes appended)': (b) => Buffer.concat([b, Buffer.from('trailing garbage')]),
      'a dropped final chunk': (b) => b.subarray(0, b.length - (box.CHUNK_PLAINTEXT_BYTES + 16)),
    };
    for (const [label, edit] of Object.entries(cases)) {
      it(`${label} is a StoredFileUnreadable`, async () => {
        const abs = await tamper(`tampered-${label.replace(/\W+/g, '-')}.bin`, edit);
        await assert.rejects(stored.readStored(abs), (e) => e instanceof stored.StoredFileUnreadable, `${label}: readStored returned instead of refusing`);
      });
    }
  });
});
