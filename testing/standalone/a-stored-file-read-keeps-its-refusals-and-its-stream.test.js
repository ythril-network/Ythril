/**
 * CHARACTERIZATION (bundle-89): what `readStored` and `openStoredRead` do beside "return the bytes" — the refusals a caller branches
 * on, the stream's agreement with the buffer, and the stat. Written against the unmodified base 429e6d25 and green there.
 *
 * ## What is already pinned, and what this adds
 *
 * `a-stored-file-is-read-into-one-buffer-of-its-size` (tests-first, bundle-89) holds the EXACT BYTES `readStored` returns at every
 * chunk boundary, encrypted and plaintext, and its refusal of tampered files. This file holds the rest of what bundle-89 can break
 * while it re-shapes the read path (plan rev 3 E5 items 1 and 6: a plaintext path or scratch copy built on `openStoredRead`, and
 * `readStored` sized from `statStored`):
 *
 *  - **A missing file is a missing PATH, not an unreadable one.** The media worker decides "the source was deleted after the job
 *    was queued: reconcile, never retry" from `isMissingPath(err)`. A read re-written to size a buffer first (`statStored`) must keep
 *    throwing the error that predicate recognises.
 *  - **A keyless instance, and a foreign key, are `StoredFileUnreadable` — from BOTH functions, and from `openStoredRead` BEFORE the
 *    first byte.** The plan has the scratch-file builder reuse `openStoredRead`'s refusal "rather than re-deciding the format, or a
 *    keyless instance hands ciphertext to ffmpeg and to the provider". That sentence is only true while the refusal is where it is.
 *  - **The stream is the buffer.** Whatever the new path streams into a scratch file must equal what `readStored` returns today.
 *  - **The stat's plaintext size and on-disk size**, the two numbers a pre-sized buffer is built from.
 *
 * No database. Run: node --test testing/standalone/a-stored-file-read-keeps-its-refusals-and-its-stream.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89c-read-'));
process.env['DATA_ROOT'] = root;
const dir = path.join(root, 'files', 'general');
fs.mkdirSync(dir, { recursive: true });
const file = (name) => path.join(dir, name);

let box, stored;
before(async () => {
  box = await import('../../server/dist/config/secretbox.js');
  stored = await import('../../server/dist/files/stored-bytes.js');
});
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Put exactly this secret in force (or none), forgetting every derived key. */
function withSecret(env) {
  for (const k of ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE']) delete process.env[k];
  Object.assign(process.env, env);
  stored.resetStoredKeyCacheForTests();
}
const keyEnv = () => ({ YTHRIL_MASTER_KEY: crypto.randomBytes(32).toString('base64') });

async function drain(readable) {
  const parts = [];
  for await (const c of readable) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

/** Write an encrypted file under a fresh key, leave THAT key in force, and return its path and plaintext. */
async function encryptedFile(name, size) {
  withSecret(keyEnv());
  const plain = crypto.randomBytes(size);
  const abs = file(name);
  await stored.writeStored(abs, plain);
  assert.equal(await stored.isStoredEncrypted(abs), true, 'fixture: the file is not in the encrypted format');
  return { abs, plain };
}

describe('readStored and openStoredRead beside the bytes', () => {
  it('a path with no file: both reject with an error `isMissingPath` recognises (the worker reconciles instead of retrying)', async () => {
    withSecret({});
    const abs = file('absent.bin');
    await assert.rejects(stored.readStored(abs), (e) => stored.isMissingPath(e) && !(e instanceof stored.StoredFileUnreadable));
    await assert.rejects(stored.openStoredRead(abs), (e) => stored.isMissingPath(e) && !(e instanceof stored.StoredFileUnreadable));
    await assert.rejects(stored.statStored(abs), (e) => stored.isMissingPath(e));
  });

  it('a directory is not a stored file: readStored rejects and the error is not a missing path', async () => {
    withSecret({});
    const d = file('a-directory');
    fs.mkdirSync(d, { recursive: true });
    await assert.rejects(stored.readStored(d), (e) => !stored.isMissingPath(e) && !(e instanceof stored.StoredFileUnreadable));
  });

  for (const [label, arrange] of [
    ['an instance with no secret', async (abs) => { void abs; withSecret({}); }],
    ['a different key', async (abs) => { void abs; withSecret(keyEnv()); }],
  ]) {
    it(`an encrypted file read by ${label}: BOTH functions refuse with StoredFileUnreadable, and openStoredRead refuses before any stream exists`, async () => {
      const { abs } = await encryptedFile(`locked-${label.replace(/\W+/g, '-')}.bin`, box.CHUNK_PLAINTEXT_BYTES + 10);
      await arrange(abs);

      await assert.rejects(stored.readStored(abs), (e) => {
        assert.ok(e instanceof stored.StoredFileUnreadable, `readStored threw ${e?.name}: ${e?.message}`);
        assert.equal(e.name, 'StoredFileUnreadable');
        assert.equal(e.filePath, abs);
        assert.equal(typeof e.code, 'string');
        assert.ok(e.message.includes(path.basename(abs)), e.message);
        return true;
      });
      let stream;
      await assert.rejects(async () => { stream = await stored.openStoredRead(abs); }, (e) => e instanceof stored.StoredFileUnreadable,
        'openStoredRead must refuse at the OPEN: a caller that commits to a response or a scratch file first has already begun');
      assert.equal(stream, undefined);
    });
  }

  it('the two refusals carry the same code for the same cause, so a caller may branch on it from either', async () => {
    const { abs } = await encryptedFile('code.bin', 100);
    withSecret({});
    const fromRead = await stored.readStored(abs).catch(e => e);
    const fromOpen = await stored.openStoredRead(abs).catch(e => e);
    assert.ok(fromRead instanceof stored.StoredFileUnreadable && fromOpen instanceof stored.StoredFileUnreadable);
    assert.equal(fromRead.code, fromOpen.code);
  });

  describe('the stream is the buffer', () => {
    const sizes = () => { const C = box.CHUNK_PLAINTEXT_BYTES; return [0, 1, C - 1, C, C + 1, 3 * C + 17]; };

    it('encrypted: for every size at a chunk boundary, openStoredRead yields exactly the bytes readStored returns', async () => {
      for (const n of sizes()) {
        const { abs, plain } = await encryptedFile(`stream-enc-${n}.bin`, n);
        const viaStream = await drain(await stored.openStoredRead(abs));
        const viaBuffer = await stored.readStored(abs);
        assert.equal(viaStream.length, n, `${n} bytes: the stream came back with ${viaStream.length}`);
        assert.ok(plain.equals(viaStream), `${n} bytes: the stream differs from the plaintext`);
        assert.ok(viaBuffer.equals(viaStream), `${n} bytes: the stream and the buffer disagree`);
      }
    });

    it('plaintext, with and without a secret in force: the stream is the file as written (a legacy file in a keyed tree reads as itself)', async () => {
      for (const env of [{}, keyEnv()]) {
        withSecret(env);
        const plain = crypto.randomBytes(box.CHUNK_PLAINTEXT_BYTES + 5);
        const abs = file(`stream-plain-${Object.keys(env).length}.bin`);
        fs.writeFileSync(abs, plain);
        assert.ok(plain.equals(await drain(await stored.openStoredRead(abs))));
        assert.ok(plain.equals(await stored.readStored(abs)));
        assert.equal(await stored.isStoredEncrypted(abs), false);
      }
    });

    it('an empty file streams as empty', async () => {
      withSecret(keyEnv());
      const abs = file('stream-empty.bin');
      fs.writeFileSync(abs, '');
      assert.equal((await drain(await stored.openStoredRead(abs))).length, 0);
    });
  });

  describe('statStored', () => {
    it('an encrypted file: `size` is the PLAINTEXT size, `onDiskSize` the ciphertext\'s (larger), `encrypted` true, and the file\'s own mtime and inode', async () => {
      const { abs } = await encryptedFile('stat-enc.bin', box.CHUNK_PLAINTEXT_BYTES * 2 + 33);
      const st = await stored.statStored(abs);
      const real = fs.statSync(abs);
      assert.equal(st.size, box.CHUNK_PLAINTEXT_BYTES * 2 + 33);
      assert.equal(st.onDiskSize, real.size);
      assert.ok(st.onDiskSize > st.size, 'the envelope has a cost');
      assert.equal(st.encrypted, true);
      assert.equal(st.mtimeMs, real.mtimeMs);
      assert.equal(st.mtime.getTime(), real.mtime.getTime());
      assert.equal(st.ino, real.ino);
    });

    it('a plaintext file: size and onDiskSize are the same number and `encrypted` is false', async () => {
      withSecret({});
      const abs = file('stat-plain.bin');
      fs.writeFileSync(abs, crypto.randomBytes(777));
      const st = await stored.statStored(abs);
      assert.deepEqual([st.size, st.onDiskSize, st.encrypted], [777, 777, false]);
    });

    it('a keyless instance can still STAT an encrypted file (it only refuses to read it)', async () => {
      const { abs } = await encryptedFile('stat-keyless.bin', 500);
      withSecret({});
      const st = await stored.statStored(abs);
      assert.equal(st.size, 500);
      assert.equal(st.encrypted, true);
      assert.equal(await stored.isStoredEncrypted(abs), true);
    });
  });
});
