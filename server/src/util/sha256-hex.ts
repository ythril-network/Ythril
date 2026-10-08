/**
 * The content hash a file is known by: the lowercase hex SHA-256 of its bytes.
 *
 * ## What it prevents
 *
 * A file's hash is compared across instances (the manifest, a tombstone's `contentHash`, a pulled body against the manifest's
 * word for it), so every site that makes one has to make the SAME one. Written inline, a copy is one `'utf8'` argument or one
 * `'base64'` digest away from a hash that equals nothing a peer holds, and it fails as "the file differs" or "the bytes do not
 * match", not as a bug. A string is hashed as UTF-8.
 *
 * Not for a hash of a stream: that is `sha256Tap` / `sha256OfStream` (`util/sha256-tap.ts`), which also holds the guards a stream
 * needs (decided in `flush`, capped at the declared size). Not for a keyed or namespaced digest (`brain/merkle.ts`, derived ids):
 * those ask a different question and keep their own.
 */
import { createHash } from 'node:crypto';

/** The lowercase hex SHA-256 of `data`, a string hashed as UTF-8. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
