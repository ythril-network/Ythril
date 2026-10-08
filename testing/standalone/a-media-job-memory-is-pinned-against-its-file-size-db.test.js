/**
 * A media job's memory is PINNED against the size of its file, not measured once and forgotten (bundle-89, Q-425 part 1, plan E5 item 9).
 *
 * ## The defect
 *
 * A stored file was read whole (`readStored`: the file, then the decrypted chunks, then their concatenation, three times its
 * size for an encrypted file), base64'd (1.33x), `JSON.stringify`'d (1.33x) and encoded by `fetch` (1.33x) before the vision
 * provider saw a byte. A 40 MB photo cost several hundred MB of a worker that runs two jobs at once, and the first bounded
 * container to see a large file killed the instance. The ticket's measurement said about 7x the file before the change and
 * about 1x after; rev 2 of the plan measured it once and left nothing to hold it.
 *
 * ## The rule, and exactly which configuration it is about
 *
 * **A job's peak memory above what the worker already uses is bounded by a small multiple of its file size, whatever the file
 * size, over the CONVERSION AND WIRE path** (the file door, the worker, the provider body): face recognition OFF. It is asserted
 * with a child process per case, because a process's peak only rises (`_media-job-child.mjs`), over a generated large file, with
 * the file written as a stream so the fixture does not raise the peak itself.
 *
 * The bound is a multiple of N, `WIRE_PEAK_MULTIPLE` below: about 7N separates the unchanged code from about 1N after the change
 * with room either side.
 *
 * ## What it does NOT claim, and the second case is that
 *
 * With face recognition ON (the default) `embedFaces` decodes the WHOLE image to raw RGBA (`face-embedder.ts`,
 * `sharp(...).ensureAlpha().raw().toBuffer()`: width x height x 4, up to sharp's ~268 Mpx limit). So "memory grows sublinearly
 * with its file" is NOT true of the face path and this file does not pretend it is. The face case holds that path to its own
 * stated bound instead: the encoded bytes it still buffers plus two decoded copies of the pixels, `FACE_PIXEL_COPIES`. A change
 * that makes faces take the bounded path may only tighten it; a change that makes the face path hold more than that is a
 * regression this case sees.
 *
 * ## Seen red
 *
 * All three are red on the unchanged code. Measured there (64 MiB image): encrypted 7.66 x, plaintext 6.65 x. The face case is red
 * too, and for the SAME reason, not because the face path is over its bound: with faces on the caption still goes through the
 * whole-file wire path first (842 MiB against a 446 MiB bound for a 103 MiB / 137 MiB-decoded image). It cannot show the face
 * path alone until the wire path is fixed; after that it holds the face path to the bound stated above.
 *
 * Run: node --test testing/standalone/a-media-job-memory-is-pinned-against-its-file-size-db.test.js
 * (requires a prior `npm run build:server` and the test MongoDB; YTHRIL_TEST_MONGO_PORT names a non-default one)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import sharp from 'sharp';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { startMediaJobChild } from './_media-job-child-run.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = await mongoSkipReason();

const MIB = 1024 * 1024;
/** The file the wire cases store. Large enough that its multiples dwarf the process's own jitter, small enough for CI. */
const N = 64 * MIB;
/**
 * A chosen bound, not a derived one: peak growth over the wire path, in file sizes. The unchanged code costs about 5-7; a
 * streamed body costs about 1 or less. 2.5 sits between them with room for the allocator and the garbage collector's timing.
 */
const WIRE_PEAK_MULTIPLE = 2.5;
/** A chosen bound, not a derived one: decoded copies of the pixels the face path may hold at once (the buffer and sharp's own). */
const FACE_PIXEL_COPIES = 2.5;

let vision, scratch;

before(async () => {
  vision = await listenOnLoopback(http.createServer((req, res) => {
    req.resume();   // read and drop: the parent must not hold the body the child is being measured on
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: 'a flat grey picture' } })); });
  }));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89-mem-'));
});
after(async () => {
  await vision?.close();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** Run one scenario to its end and return what it measured. */
async function measure(scenario) {
  const child = startMediaJobChild({ scenario: 'memory', visionUrl: vision.url, ...scenario });
  try {
    const done = await child.waitForMessage('done', 240_000);
    await child.exited;
    return done.peakKb;
  } finally {
    child.cleanup();
  }
}

describe('a media job\'s memory against the size of its file (a child process per case, real worker, real Mongo)', { skip }, () => {
  for (const [label, secret] of [['an ENCRYPTED file (master secret set)', true], ['a PLAINTEXT file (no secret)', false]]) {
    it(`wire path, ${label}: the peak above the warmed-up worker is at most ${WIRE_PEAK_MULTIPLE} x the file (face recognition OFF)`, async () => {
      const peak = await measure({ suite: `b89e5mem${secret ? 'enc' : 'plain'}`, secret, faces: false, mime: 'image/png', ext: 'png', size: N });
      const grewBytes = (peak.afterLarge - peak.afterSmall) * 1024;
      assert.ok(grewBytes <= WIRE_PEAK_MULTIPLE * N,
        `a ${N / MIB} MiB image grew the worker's peak by ${(grewBytes / MIB).toFixed(0)} MiB = ${(grewBytes / N).toFixed(2)} x its size `
        + `(bound ${WIRE_PEAK_MULTIPLE} x). The file is being held whole, again and again, on the way to the provider.`);
    });
  }

  it(`face path (face recognition ON, the default): the peak stays within the encoded bytes plus ${FACE_PIXEL_COPIES} decoded copies of the pixels (the stated limit of the sublinear claim: the face path is NOT sublinear)`, async () => {
    const width = 6000, height = 6000;
    const big = path.join(scratch, 'big.png');
    const tiny = path.join(scratch, 'tiny.png');
    // Uncompressed on purpose: the file is about as large as its pixels, so the encoded bytes AND the decode are both big.
    await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 130, b: 140 } } }).png({ compressionLevel: 0 }).toFile(big);
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(tiny);
    const encoded = fs.statSync(big).size;
    const rgba = width * height * 4;
    const peak = await measure({ suite: 'b89e5memface', secret: false, faces: true, mime: 'image/png', ext: 'png', sourceFile: big, smallFile: tiny });
    const grewBytes = (peak.afterLarge - peak.afterSmall) * 1024;
    const bound = encoded + FACE_PIXEL_COPIES * rgba;
    assert.ok(grewBytes <= bound,
      `a ${width}x${height} image (${(encoded / MIB).toFixed(0)} MiB encoded, ${(rgba / MIB).toFixed(0)} MiB decoded) grew the peak by `
      + `${(grewBytes / MIB).toFixed(0)} MiB; the face path's stated bound is ${(bound / MIB).toFixed(0)} MiB.`);
  });
});
