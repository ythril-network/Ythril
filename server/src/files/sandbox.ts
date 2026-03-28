import path from 'path';
import { getDataRoot } from '../config/loader.js';

/**
 * Resolve a user-supplied path within a space's data directory.
 *
 * Security hardening:
 * 1. URL-decode to prevent %2F / %00 traversal
 * 2. Unicode NFC normalization to prevent homoglyph traversal
 * 3. Null-byte rejection
 * 4. Strip leading slashes (browser filenames often start with /)
 * 5. path.resolve against the space data root
 * 6. Strict prefix check — must remain under the space root
 *
 * @returns The absolute safe path
 * @throws RangeError if the path attempts to escape the space root
 */
export function resolveSafePath(spaceId: string, userPath: string): string {
  const dataRoot = getDataRoot();
  const spaceRoot = path.resolve(dataRoot, 'files', spaceId);

  // 1. URL-decode (may throw URIError on malformed input — propagate as 400)
  const decoded = decodeURIComponent(userPath);

  // 2. Unicode NFC normalization
  const normalized = decoded.normalize('NFC');

  // 3. Strip any null bytes
  if (normalized.includes('\x00')) {
    throw new RangeError('Path contains null bytes');
  }

  // 4. Strip leading slashes so browser-supplied filenames like
  //    '/Screenshot 2024.png' are treated as relative.  An absolute path
  //    passed directly to path.resolve() would silently discard spaceRoot,
  //    causing the prefix check below to fire as a false-positive traversal.
  const relative = normalized.replace(/^\/+/, '');

  // 5. Resolve to absolute
  const resolved = path.resolve(spaceRoot, relative);

  // 6. Prefix check — must start with spaceRoot + separator
  const boundary = spaceRoot.endsWith(path.sep) ? spaceRoot : spaceRoot + path.sep;
  if (!resolved.startsWith(boundary) && resolved !== spaceRoot) {
    throw new RangeError(`Path traversal attempt: '${userPath}'`);
  }

  return resolved;
}

/** Return the absolute data root for a space's files */
export function spaceRoot(spaceId: string): string {
  const dataRoot = getDataRoot();
  return path.resolve(dataRoot, 'files', spaceId);
}
