/**
 * Build a ZIP archive in memory — for the tests of code that READS an archive it did not write (a CI artifact).
 *
 * ## What it prevents
 *
 * An artifact reader is a parser of attacker-influenced bytes: a name with `..` in it, a header that declares
 * ten bytes over a stream that inflates to twenty megabytes, a total that no single entry reaches. The only way
 * to see a reader refuse those is to hand it an archive that really has them, and no zip tool will write one on
 * request — they normalise names and tell the truth about sizes. So this writes the bytes directly, and every
 * lie is an explicit option, never a default:
 *
 * - `name` is stored verbatim (no normalisation of `..`, absolute paths or backslashes);
 * - `declaredSize` states a different uncompressed size from the true one;
 * - `method: 'store'` keeps the bytes raw; the default `'deflate'` is what a real artifact uses, and what lets a
 *   large entry of zeros be a few kilobytes of archive.
 *
 * One question per module: "give me these entries as a zip". It does not read zips; the code under test does.
 */
import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {Array<{name: string, data: Buffer | string, method?: 'store' | 'deflate', declaredSize?: number}>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const cache = new Map(); // identical large payloads are compressed and summed once
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.method ?? 'deflate';
    let packed = cache.get(data);
    if (!packed) {
      packed = { crc: crc32(data), body: method === 'store' ? data : deflateRawSync(data) };
      cache.set(data, packed);
    }
    const name = Buffer.from(e.name, 'utf8');
    const size = e.declaredSize ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method === 'store' ? 0 : 8, 8);
    local.writeUInt32LE(0, 10); // time + date
    local.writeUInt32LE(packed.crc, 14);
    local.writeUInt32LE(packed.body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, packed.body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method === 'store' ? 0 : 8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(packed.crc, 16);
    central.writeUInt32LE(packed.body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
