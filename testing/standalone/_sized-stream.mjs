/**
 * A file of a given size as a STREAM of 1 MiB pieces, so a fixture never holds the file whole (bundle-89, Q-425).
 *
 * ## What it prevents
 *
 * A large fixture built as one `Buffer` raises the process's peak memory before the code under test has run, and a peak only
 * rises: a test that then measures the peak reads the fixture. `MARKER` leads the stream so a scan of a disk can tell a copy of
 * the file from anything else the job wrote.
 */

/** Bytes at the head of a file, so a scan of a disk can tell a decrypted copy of it from anything else. */
export const MARKER = 'DECRYPTED-PLAINTEXT-MARKER-b89e5-7f3a91';

const MIB = 1024 * 1024;

/** `size` bytes in pieces of at most 1 MiB, led by `MARKER` unless `marker` is false. */
export function* streamOfSize(size, { marker = true } = {}) {
  let left = size;
  let first = true;
  while (left > 0) {
    const n = Math.min(MIB, left);
    const piece = Buffer.alloc(n, 0x41);
    if (first && marker) Buffer.from(MARKER).copy(piece, 0, 0, Math.min(MARKER.length, n));
    first = false;
    yield piece;
    left -= n;
  }
}
