/**
 * With a master secret set, a file Ythril stores is ciphertext on disk and plaintext to every reader (`F-43`).
 *
 * ## What this pins
 *
 * - **The format** (`config/secretbox.ts`, the one at-rest module): chunked AES-256-GCM under a per-file key, so a
 *   file of any size streams; a tampered, truncated, reordered or foreign-key file REFUSES rather than decoding to
 *   something plausible, and a foreign key is told apart from tampering by the header's key check.
 * - **The file door** (`files/stored-bytes.ts`): a raw read of what it stored shows no plaintext; its readers give
 *   the plaintext back; a legacy plaintext file still reads (a tree mid-migration); the size it reports is the
 *   plaintext size; its temporary files never land inside the files tree, where sync would publish them.
 * - **No secret, no change**: without a master secret the bytes on disk are exactly what was written, and nothing
 *   sniffs file contents, so a user's file that happens to be in our format is served as it is.
 *
 * Run: node --test testing/standalone/stored-files-are-encrypted-at-rest.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-f43-'));
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

/** Switch the process's master secret, and drop every key the file door cached for the previous one. */
const withSecret = (env) => {
  for (const k of ['YTHRIL_MASTER_KEY', 'YTHRIL_MASTER_PASSPHRASE']) delete process.env[k];
  Object.assign(process.env, env);
  stored.resetStoredKeyCacheForTests();
};
const KEYED = { YTHRIL_MASTER_KEY: crypto.randomBytes(32).toString('base64') };
const PASSPHRASED = { YTHRIL_MASTER_PASSPHRASE: 'a passphrase for the tests' };
const otherKey = () => ({ YTHRIL_MASTER_KEY: crypto.randomBytes(32).toString('base64') });
const MARKER = 'PLAINTEXT-MARKER-7f3a';
const secret = () => box.resolveMasterSecret();

describe('the chunked format', () => {
  for (const [label, env] of [['raw key', KEYED], ['passphrase', PASSPHRASED]]) {
    it(`${label}: round-trips empty, one byte, exactly one chunk, and many chunks`, () => {
      withSecret(env);
      const dk = box.deriveKey(secret());
      for (const n of [0, 1, box.CHUNK_PLAINTEXT_BYTES, box.CHUNK_PLAINTEXT_BYTES * 3 + 17]) {
        const plain = crypto.randomBytes(n);
        const enc = box.encryptChunked(plain, dk);
        assert.ok(box.isChunkedEnvelope(enc), `${n} bytes: not recognised as the format`);
        assert.equal(box.chunkedPlaintextSize(enc), n, `${n} bytes: the size read from the ciphertext is wrong`);
        assert.deepEqual(box.decryptChunked(enc, secret()), plain, `${n} bytes did not round-trip`);
      }
    });
  }

  it('streams: uneven writes through the Transforms match the Buffer helpers', async () => {
    withSecret(KEYED);
    const plain = crypto.randomBytes(box.CHUNK_PLAINTEXT_BYTES * 5 + 1234);
    const pieces = function* () { for (let i = 0; i < plain.length; i += 7777) yield plain.subarray(i, i + 7777); };
    const enc = [];
    for await (const c of Readable.from(pieces()).pipe(box.createChunkedEncryptor(box.deriveKey(secret())))) enc.push(c);
    const out = [];
    for await (const c of Readable.from([Buffer.concat(enc)]).pipe(box.createChunkedDecryptor(secret()))) out.push(c);
    assert.deepEqual(Buffer.concat(out), plain);
  });

  it('refuses a flipped bit, a dropped chunk, swapped chunks, an edited header and a truncated tail', () => {
    withSecret(KEYED);
    const enc = box.encryptChunked(crypto.randomBytes(box.CHUNK_PLAINTEXT_BYTES * 3), box.deriveKey(secret()));
    const h = box.chunkedHeaderLength(enc);
    const C = box.CHUNK_PLAINTEXT_BYTES + 16;
    const flipped = Buffer.from(enc); flipped[h + 10] ^= 1;
    const dropped = Buffer.concat([enc.subarray(0, h + C), enc.subarray(h + 2 * C)]);
    const swapped = Buffer.concat([enc.subarray(0, h), enc.subarray(h + C, h + 2 * C), enc.subarray(h, h + C), enc.subarray(h + 2 * C)]);
    const header = Buffer.from(enc); header[h - 1] ^= 1;
    const truncated = enc.subarray(0, enc.length - C);
    for (const [name, bad] of [['flipped', flipped], ['dropped', dropped], ['swapped', swapped], ['header', header], ['truncated', truncated]]) {
      assert.throws(() => box.decryptChunked(bad, secret()), (e) => e instanceof box.ChunkedEnvelopeError, `${name} decoded instead of refusing`);
    }
  });

  it('tells a foreign key apart from tampering', () => {
    withSecret(KEYED);
    const enc = box.encryptChunked(Buffer.from('hello'), box.deriveKey(secret()));
    withSecret(otherKey());
    assert.throws(() => box.decryptChunked(enc, secret()), (e) => e instanceof box.ChunkedEnvelopeError && e.code === 'wrong-key');
  });

  it('two files under one key never share a file key (per-file salt)', () => {
    withSecret(KEYED);
    const dk = box.deriveKey(secret());
    const a = box.encryptChunked(Buffer.alloc(100), dk);
    const b = box.encryptChunked(Buffer.alloc(100), dk);
    assert.notDeepEqual(a.subarray(box.chunkedHeaderLength(a)), b.subarray(box.chunkedHeaderLength(b)),
      'identical plaintext produced identical ciphertext, so a file key or nonce repeated');
  });
});

describe('the file door', () => {
  it('with a secret: the disk holds no plaintext, and readers get the plaintext back', async () => {
    withSecret(KEYED);
    const abs = file('a.txt');
    const body = `${MARKER} some content`;
    await stored.writeStored(abs, Buffer.from(body));
    assert.ok(!fs.readFileSync(abs).includes(Buffer.from(MARKER)), 'the stored file contains the plaintext');
    assert.equal((await stored.readStored(abs)).toString(), body);
    assert.equal((await stored.statStored(abs)).size, body.length, 'the reported size is not the plaintext size');
  });

  it('with a secret: a legacy plaintext file still reads, so a tree mid-migration works', async () => {
    withSecret(KEYED);
    const abs = file('legacy.txt');
    fs.writeFileSync(abs, 'written before encryption');
    assert.equal((await stored.readStored(abs)).toString(), 'written before encryption');
    assert.equal((await stored.statStored(abs)).size, 'written before encryption'.length);
  });

  it('with a secret: a file under a foreign key is a typed refusal, not garbage', async () => {
    withSecret(KEYED);
    const abs = file('foreign.txt');
    await stored.writeStored(abs, Buffer.from('mine'));
    withSecret(otherKey());
    await assert.rejects(stored.readStored(abs), (e) => e instanceof stored.StoredFileUnreadable);
    // The streamed reader refuses when it is OPENED, not on its first chunk: a download has committed to a 200 by
    // the time a chunk fails, so a refusal that late reaches the client as an aborted transfer instead of a reason.
    await assert.rejects(stored.openStoredRead(abs), (e) => e instanceof stored.StoredFileUnreadable && e.code === 'wrong-key');
  });

  it('streams a large write in and a read out', async () => {
    withSecret(KEYED);
    const abs = file('big.bin');
    const plain = crypto.randomBytes(box.CHUNK_PLAINTEXT_BYTES * 4 + 99);
    await stored.pipeToStored(abs, Readable.from([plain.subarray(0, 5000), plain.subarray(5000)]));
    const out = [];
    for await (const c of await stored.openStoredRead(abs)) out.push(c);
    assert.deepEqual(Buffer.concat(out), plain);
  });

  it('keeps its temporary files outside the files tree, where sync would publish them', async () => {
    withSecret(KEYED);
    const before = new Set(fs.readdirSync(filesDir));
    await stored.writeStored(file('t.txt'), Buffer.from('x'));
    const rel = path.relative(path.join(root, 'files'), stored.storedTmpDir());
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `the temporary directory is inside the files tree: ${rel}`);
    assert.deepEqual(fs.readdirSync(filesDir).filter(n => !before.has(n)), ['t.txt'], 'a write left something else in the tree');
  });

  it('without a secret: what is written is what is on disk', async () => {
    withSecret({});
    const abs = file('plain.txt');
    await stored.writeStored(abs, Buffer.from('plain as written'));
    assert.equal(fs.readFileSync(abs, 'utf8'), 'plain as written');
    assert.equal((await stored.readStored(abs)).toString(), 'plain as written');
  });

  it('without a secret: an encrypted file is refused, never served as ciphertext', async () => {
    // A secret removed, a keyed tree restored onto a keyless host, a rollback: serving the bytes raw would hand the
    // user ciphertext and publish it to every peer as the file's new version.
    withSecret(KEYED);
    const abs = file('keyed-then-keyless.bin');
    await stored.writeStored(abs, Buffer.from('written with a key'));
    withSecret({});
    await assert.rejects(stored.readStored(abs), (e) => e instanceof stored.StoredFileUnreadable && e.code === 'no-secret');
    await assert.rejects(async () => { for await (const _ of await stored.openStoredRead(abs)) { /* drain */ } },
      (e) => e instanceof stored.StoredFileUnreadable);
  });

  it('deletes and moves take the path lock, so a rewrite in flight cannot resurrect the file', async () => {
    withSecret(KEYED);
    const abs = file('locked.txt');
    await stored.writeStored(abs, Buffer.from('v1'));
    let release;
    const held = stored.withPathLock(abs, () => new Promise(r => { release = r; }));
    const deleted = stored.deleteStored(abs);
    await new Promise(r => setTimeout(r, 30));
    assert.ok(fs.existsSync(abs), 'the delete ran while another holder had the path');
    release();
    await held; await deleted;
    assert.ok(!fs.existsSync(abs));
  });

  it('writes take the path lock themselves, so none can land between the migration re-check and its rename', async () => {
    withSecret(KEYED);
    const abs = file('write-locked.txt');
    let release;
    const held = stored.withPathLock(abs, () => new Promise(r => { release = r; }));
    const written = stored.writeStored(abs, Buffer.from('late'));
    await new Promise(r => setTimeout(r, 30));
    assert.ok(!fs.existsSync(abs), 'the write ran while another holder had the path');
    release();
    await held; await written;
    assert.equal((await stored.readStored(abs)).toString(), 'late');
  });

  it('two moves crossing each other both finish, rather than each holding one lock for ever', async () => {
    withSecret(KEYED);
    const a = file('cross-a.txt'), b = file('cross-b.txt');
    await stored.writeStored(a, Buffer.from('a'));
    await stored.writeStored(b, Buffer.from('b'));
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('the crossing moves deadlocked')), 2000));
    // a -> b and b -> a together: locked source-first, one holds a and waits on b while the other holds b and waits on a.
    await Promise.race([Promise.allSettled([stored.moveStored(a, b), stored.moveStored(b, a)]), timeout]);
  });

  it('removes temporary files a crash left behind', async () => {
    fs.mkdirSync(stored.storedTmpDir(), { recursive: true });
    fs.writeFileSync(path.join(stored.storedTmpDir(), 'orphan.bin.abcdef.tmp'), 'x');
    assert.ok(await stored.sweepStoredTmp() >= 1);
    assert.deepEqual(fs.readdirSync(stored.storedTmpDir()).filter(n => n.endsWith('.tmp')), []);
  });
});

describe('the background pass over files stored before the secret', () => {
  let mig;
  before(async () => { mig = await import('../../server/dist/files/at-rest-migration.js'); });

  it('encrypts every plaintext file, keeps its mtime and its content, and a second pass has nothing to do', async () => {
    withSecret(KEYED);
    const nested = path.join(filesDir, 'mig', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    const abs = path.join(nested, 'old.txt');
    fs.writeFileSync(abs, `${MARKER} stored before the secret`);
    const when = new Date('2024-01-02T03:04:05Z');
    fs.utimesSync(abs, when, when);

    mig.resetAtRestMigrationForTests();
    const first = await mig.runAtRestMigration();
    assert.equal(first.phase, 'finished');
    assert.ok(first.encrypted >= 1, 'the pass encrypted nothing');
    assert.equal(first.plaintextLeft, 0);
    assert.ok(!fs.readFileSync(abs).includes(Buffer.from(MARKER)), 'the migrated file still holds plaintext');
    assert.equal(fs.statSync(abs).mtimeMs, when.getTime(), 'the pass changed the mtime, which every peer reads as an edit');
    assert.equal((await stored.readStored(abs)).toString(), `${MARKER} stored before the secret`);

    const second = await mig.runAtRestMigration();
    assert.equal(second.encrypted, 0, 'a second pass rewrote files that were already encrypted');
  });

  it('without a secret: rewrites nothing and counts the encrypted files it cannot read', async () => {
    withSecret(KEYED);
    await stored.writeStored(file('keyed-only.txt'), Buffer.from('needs the key'));
    withSecret({});
    fs.writeFileSync(file('plain-keyless.txt'), 'plain');
    const r = await mig.runAtRestMigration();
    assert.ok(r.encryptedWithoutSecret >= 1, 'an encrypted file on a keyless instance went uncounted');
    assert.equal(fs.readFileSync(file('plain-keyless.txt'), 'utf8'), 'plain', 'a keyless pass rewrote a file');
  });
});

describe('upload staging', () => {
  let chunks;
  before(async () => { chunks = await import('../../server/dist/files/chunks.js'); });

  it('stages ciphertext, counts plaintext, and a resent chunk of a different length replaces the first', async () => {
    withSecret(KEYED);
    const body = Buffer.from(`${MARKER}-0123456789`);
    const total = body.length;
    const target = file('assembled.txt');
    await chunks.storeChunk('general', 'assembled.txt', Buffer.from('WRONG-LENGTH'), 0, total);
    const r1 = await chunks.storeChunk('general', 'assembled.txt', body.subarray(0, 10), 0, total);
    assert.equal(r1.received, 10, 'the resend sat beside the first chunk instead of replacing it');
    const r2 = await chunks.storeChunk('general', 'assembled.txt', body.subarray(10), 10, total);
    assert.equal(r2.received, total);
    assert.ok(r2.complete);
    assert.equal(await chunks.getUploadReceived('general', 'assembled.txt', total), total);
    const staged = path.join(root, '.chunks');
    const leaks = [];
    const seen = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { seen.push(p); if (fs.readFileSync(p).includes(Buffer.from(MARKER.slice(0, 10)))) leaks.push(p); } } };
    walk(staged);
    // A walk that found nothing would report no leaks about nothing: both chunks are still staged here.
    assert.ok(seen.length >= 2, `the leak check walked ${seen.length} staged chunk(s), not the two just stored`);
    assert.deepEqual(leaks, [], 'a staged chunk holds plaintext');
    const sha = await chunks.assembleChunks('general', 'assembled.txt', total, target);
    assert.equal(sha, crypto.createHash('sha256').update(body).digest('hex'));
    assert.deepEqual(await stored.readStored(target), body);
  });
});
