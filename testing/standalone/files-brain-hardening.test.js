/**
 * Unit tests: files/brain hardening (M1, M11, L3, L4, L5)
 *
 * M1  — assertNoSymlinkEscape follows symlinks and refuses a path whose real
 *       location escapes the space root (the lexical check cannot see this).
 * M11 — assembleChunks verifies the chunks tile [0, total) exactly (no gap,
 *       no overlap) and its sha256 matches the assembled bytes.
 * L3  — resolveSafePath no longer URL-decodes: a filename with a literal '%'
 *       resolves without throwing and stays byte-identical to the DB _id.
 * L4  — applyResolutions rejects prototype-polluting property keys.
 * L5  — mergeEmbeddingExclusion merges the embedding exclusion with the caller's
 *       projection instead of discarding it, and never lets the vector through.
 *
 * Pure in-process logic. sandbox/chunks read DATA_ROOT from the env, which this
 * test points at a temp dir. Run:
 *   node --test testing/standalone/files-brain-hardening.test.js
 * (build the server first: npm run build:server)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// DATA_ROOT must be set before importing modules that read it at call time.
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), 'ythril-fb-'));
process.env.DATA_ROOT = TMP;

const { resolveSafePath, assertNoSymlinkEscape, spaceRoot } =
  await import('../../server/dist/files/sandbox.js');
const { assembleChunks, uploadId, storeChunk } =
  await import('../../server/dist/files/chunks.js');
const { applyResolutions } = await import('../../server/dist/brain/merge.js');
const { mergeEmbeddingExclusion } = await import('../../server/dist/brain/query.js');

const SPACE = 'fbtest';

// ── L3 — no URL-decode in resolveSafePath ────────────────────────────────────

describe('L3 — resolveSafePath does not URL-decode', () => {
  it('a filename with a literal % resolves without throwing', () => {
    // decodeURIComponent('50%.png') throws URIError → the old code 500'd.
    const abs = resolveSafePath(SPACE, '50%.png');
    assert.ok(abs.endsWith(`${path.sep}50%.png`), abs);
  });

  it('the resolved basename is byte-identical to the input (matches the DB _id)', () => {
    const abs = resolveSafePath(SPACE, 'a%2Fb.png'); // %2F stays literal, not decoded to '/'
    assert.equal(path.basename(abs), 'a%2Fb.png');
  });

  it('still blocks lexical traversal', () => {
    assert.throws(() => resolveSafePath(SPACE, '../../etc/passwd'), /traversal/i);
  });

  it('still rejects null bytes', () => {
    assert.throws(() => resolveSafePath(SPACE, 'a\x00b'), /null/i);
  });
});

// ── M1 — symlink escape detection ────────────────────────────────────────────

describe('M1 — assertNoSymlinkEscape follows symlinks', () => {
  const root = spaceRoot(SPACE);
  let outsideDir;

  before(async () => {
    await fs.mkdir(root, { recursive: true });
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ythril-outside-'));
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'top secret');
  });

  after(async () => {
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });

  it('accepts a normal path inside the root', async () => {
    const abs = resolveSafePath(SPACE, 'docs/note.txt');
    await assert.doesNotReject(() => assertNoSymlinkEscape(SPACE, abs));
  });

  it('refuses a path that reaches outside via a symlinked directory', async () => {
    // root/evil -> <outsideDir>. Lexically root/evil/secret.txt is "inside".
    const link = path.join(root, 'evil');
    await fs.rm(link, { recursive: true, force: true }).catch(() => {});
    try {
      await fs.symlink(outsideDir, link, 'dir');
    } catch (err) {
      // Windows without symlink privilege — skip rather than fail.
      if (err.code === 'EPERM' || err.code === 'ENOSYS') return;
      throw err;
    }
    const abs = resolveSafePath(SPACE, 'evil/secret.txt');
    await assert.rejects(() => assertNoSymlinkEscape(SPACE, abs), /symlink/i);
  });

  it('refuses a symlinked FILE that points outside the root', async () => {
    const link = path.join(root, 'link-to-secret.txt');
    await fs.rm(link, { force: true }).catch(() => {});
    try {
      await fs.symlink(path.join(outsideDir, 'secret.txt'), link, 'file');
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'ENOSYS') return;
      throw err;
    }
    const abs = resolveSafePath(SPACE, 'link-to-secret.txt');
    await assert.rejects(() => assertNoSymlinkEscape(SPACE, abs), /symlink/i);
  });
});

// ── M11 — chunk assembly coverage + hash ─────────────────────────────────────

describe('M11 — assembleChunks verifies coverage and hashes correctly', () => {
  const filePath = 'big.bin';

  async function seedChunks(space, parts) {
    // parts: array of { start, buf }
    for (const p of parts) {
      await storeChunk(space, filePath, p.buf, p.start, TOTAL);
    }
  }
  const A = Buffer.alloc(1000, 0x41);
  const B = Buffer.alloc(1000, 0x42);
  const C = Buffer.alloc(500, 0x43);
  const TOTAL = A.length + B.length + C.length; // 2500

  it('assembles contiguous chunks and the sha256 matches the bytes', async () => {
    const space = 'm11-ok';
    await fs.mkdir(spaceRoot(space), { recursive: true });
    await seedChunks(space, [
      { start: 0, buf: A },
      { start: 1000, buf: B },
      { start: 2000, buf: C },
    ]);
    const target = path.join(spaceRoot(space), filePath);
    const sha = await assembleChunks(space, filePath, TOTAL, target);

    const written = await fs.readFile(target);
    assert.equal(written.length, TOTAL);
    assert.equal(sha, createHash('sha256').update(Buffer.concat([A, B, C])).digest('hex'));
  });

  it('refuses assembly when a chunk is missing (gap)', async () => {
    const space = 'm11-gap';
    await fs.mkdir(spaceRoot(space), { recursive: true });
    // 0..999 and 2000..2499 present; 1000..1999 missing.
    await seedChunks(space, [
      { start: 0, buf: A },
      { start: 2000, buf: C },
    ]);
    const target = path.join(spaceRoot(space), filePath);
    await assert.rejects(() => assembleChunks(space, filePath, TOTAL, target), /coverage/i);
  });

  it('refuses assembly when chunks overlap', async () => {
    const space = 'm11-overlap';
    await fs.mkdir(spaceRoot(space), { recursive: true });
    // 0..999 and 500..1499 overlap.
    await seedChunks(space, [
      { start: 0, buf: A },
      { start: 500, buf: B },
    ]);
    const target = path.join(spaceRoot(space), filePath);
    await assert.rejects(() => assembleChunks(space, filePath, TOTAL, target), /coverage/i);
  });
});

// ── L4 — prototype-pollution reject in applyResolutions ──────────────────────

describe('L4 — applyResolutions rejects prototype-polluting keys', () => {
  it('does not pollute Object.prototype via a __proto__ absorbed-only key', () => {
    const result = applyResolutions(
      { safe: 'a' },
      {},
      [],
      [{ key: '__proto__', value: 'polluted' }],
    );
    assert.equal({}.polluted, undefined, 'Object.prototype must not be polluted');
    assert.equal(result.safe, 'a');
    assert.ok(!('__proto__' in result) || result.__proto__ !== 'polluted');
  });

  it('does not pollute via a constructor conflict key', () => {
    const result = applyResolutions(
      {},
      {},
      [{ key: 'constructor', type: 'string', survivorValue: 'x', absorbedValue: 'y', resolution: 'absorbed' }],
      [],
    );
    assert.equal(typeof {}.constructor, 'function', 'constructor must remain the Object constructor');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(result, 'constructor'),
      'the constructor key must be skipped, not written as an own property',
    );
  });

  it('still applies normal property resolutions', () => {
    const result = applyResolutions(
      { keep: 1 },
      {},
      [{ key: 'color', type: 'string', survivorValue: 'red', absorbedValue: 'blue', resolution: 'absorbed' }],
      [{ key: 'extra', value: 'added' }],
    );
    assert.equal(result.keep, 1);
    assert.equal(result.color, 'blue');
    assert.equal(result.extra, 'added');
  });
});

// ── L5 — projection merge ────────────────────────────────────────────────────

describe('L5 — mergeEmbeddingExclusion preserves the caller projection', () => {
  it('no projection → excludes embedding only', () => {
    assert.deepEqual(mergeEmbeddingExclusion(undefined), { embedding: 0 });
    assert.deepEqual(mergeEmbeddingExclusion({}), { embedding: 0 });
  });

  it('inclusion projection is preserved (embedding excluded by omission)', () => {
    const out = mergeEmbeddingExclusion({ fact: 1, tags: 1 });
    assert.deepEqual(out, { fact: 1, tags: 1 });
    assert.ok(!('embedding' in out) || out.embedding === 0);
  });

  it('exclusion projection keeps the caller fields AND adds embedding: 0', () => {
    const out = mergeEmbeddingExclusion({ createdAt: 0 });
    assert.deepEqual(out, { createdAt: 0, embedding: 0 });
  });

  it('an explicit embedding inclusion is stripped (vector can never leak)', () => {
    const out = mergeEmbeddingExclusion({ fact: 1, embedding: 1 });
    assert.equal(out.embedding, undefined, 'embedding must not be included even if requested');
    assert.equal(out.fact, 1);
  });

  it('_id exclusion alongside inclusion is respected', () => {
    const out = mergeEmbeddingExclusion({ _id: 0, fact: 1 });
    assert.equal(out.fact, 1);
    assert.equal(out._id, 0);
  });
});
