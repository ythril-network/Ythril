/**
 * Extracting the BSBM Tools zip with Node alone: the harness takes no dependency and no host tool.
 *
 * ## What this prevents
 *
 * **A path that leaves the target folder.** An archive entry named `../x` or `/etc/x` would be written outside
 * the folder it is extracted into. The archive is pinned by hash, so this is a second lock rather than the
 * first: an entry whose resolved path is not inside the target is refused before anything is written.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export function unzip(zipPath, targetDir) {
  const buf = readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${zipPath} is not a zip file (no end-of-directory record)`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const root = resolve(targetDir);
  const written = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    const dest = resolve(root, name);
    if (dest !== root && !dest.startsWith(root + sep)) throw new Error(`zip entry ${JSON.stringify(name)} leaves the target folder`);
    if (name.endsWith('/')) { mkdirSync(dest, { recursive: true }); continue; }

    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip entry ${name} uses compression method ${method}, which is not supported`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data);
    written.push(join(name));
  }
  return written;
}
