/**
 * The child `a-stored-file-is-read-into-one-buffer-of-its-size.test.js` measures `readStored` in: a process of its own, because a
 * process's peak memory only rises (`process.resourceUsage().maxRSS`) and a runner that has done other things first would be
 * measured instead of the read (bundle-89, Q-425).
 *
 * The file is written through the file door as a STREAM, so the fixture itself never holds the file whole. A small file is read
 * first so what the door loads lazily is loaded and its peak is behind it. Not a test: the runner picks up `*.test.js` only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { streamOfSize } from './_sized-stream.mjs';

const { size, secret } = JSON.parse(process.env['B89_CHILD'] ?? '{}');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-b89-peak-'));
process.env['DATA_ROOT'] = root;
if (secret) process.env['YTHRIL_MASTER_KEY'] = crypto.randomBytes(32).toString('base64');
else delete process.env['YTHRIL_MASTER_KEY'];

const stored = await import('../../server/dist/files/stored-bytes.js');
const peakKb = () => process.resourceUsage().maxRSS;
try {
  const small = path.join(root, 'small.bin');
  const large = path.join(root, 'large.bin');
  await stored.pipeToStored(small, [Buffer.alloc(64 * 1024, 1)]);
  await stored.pipeToStored(large, streamOfSize(size, { marker: false }));
  const before = peakKb();
  await stored.readStored(small);
  const afterSmall = peakKb();
  const bytes = await stored.readStored(large);
  const afterLarge = peakKb();
  process.send({ type: 'done', length: bytes.length, peakKb: { before, afterSmall, afterLarge } }, () => process.exit(0));
} catch (err) {
  process.send({ type: 'error', message: err instanceof Error ? err.stack : String(err) }, () => process.exit(1));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
