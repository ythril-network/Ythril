/**
 * A path the process may not look at: every filesystem call that names it (or a path beneath it) fails with EACCES, and
 * `existsSync` answers `false` for it, exactly as the operating system does when a directory on the way has no search
 * permission.
 *
 * ## Why a module
 *
 * "An unreadable path is read as absent" is a question about what a synchronous existence check does when the OS refuses,
 * and the tests of it all need the same refusal. `chmod` cannot stage it portably: it does nothing on Windows and nothing to
 * root, which is who runs the Docker test runner. A directory placed at a file's path fails a READ portably (EISDIR) but
 * `existsSync` answers `true` for it, so it cannot stage the existence check. This stages the check itself, once, for every
 * test that holds a site that asks "is it here".
 *
 * ## What it does not do
 *
 * It does not fake a result: a blocked path never answers "present" and never answers "absent" to anything but `existsSync`
 * (which has no way to say anything else, which is the defect under test). A path that is not blocked goes to the real call.
 *
 * It patches the `fs` object (and `fs.promises`) the built server imports as `fs` / `fsp`, then calls
 * `syncBuiltinESMExports` so a named import sees the patch too. Call the function it returns to restore.
 */
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const SYNC_REFUSED = ['statSync', 'lstatSync', 'accessSync', 'openSync', 'readFileSync', 'readdirSync', 'opendirSync', 'realpathSync'];
const ASYNC_REFUSED = ['stat', 'lstat', 'access', 'open', 'readFile', 'readdir', 'opendir', 'realpath'];

/** The error the operating system gives a path it will not let the process look at. */
export function eacces(p, syscall = 'stat') {
  return Object.assign(new Error(`EACCES: permission denied, ${syscall} '${p}'`), { code: 'EACCES', syscall, path: String(p), errno: -13 });
}

/**
 * Block `targets` (absolute paths; the path itself and everything beneath it). Returns `{ restore, hits }`: `hits` counts the
 * calls that were refused, so a test can say the refusal was reached rather than assume it.
 */
export function blockPaths(...targets) {
  const blocked = targets.map(t => path.resolve(t));
  const hits = { count: 0 };
  const isBlocked = (p) => {
    if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
    let abs;
    try { abs = path.resolve(p instanceof URL ? p.pathname : String(p)); } catch { return false; }
    return blocked.some(b => abs === b || abs.startsWith(b + path.sep));
  };
  const saved = [];
  const patch = (obj, name, make) => {
    const real = obj[name];
    if (typeof real !== 'function') return;
    saved.push([obj, name, real]);
    obj[name] = make(real);
  };
  patch(fs, 'existsSync', real => function (p) { if (isBlocked(p)) { hits.count++; return false; } return real.call(this, p); });
  for (const name of SYNC_REFUSED) {
    patch(fs, name, real => {
      const wrapped = function (p, ...rest) { if (isBlocked(p)) { hits.count++; throw eacces(p, name.replace(/Sync$/, '')); } return real.call(this, p, ...rest); };
      // `realpathSync.native` and friends: keep the properties a caller may read.
      return Object.assign(wrapped, real);
    });
  }
  for (const name of ASYNC_REFUSED) {
    patch(fs.promises, name, real => async function (p, ...rest) { if (isBlocked(p)) { hits.count++; throw eacces(p, name); } return real.call(this, p, ...rest); });
  }
  syncBuiltinESMExports();
  return {
    hits,
    restore() {
      for (const [obj, name, real] of saved.reverse()) obj[name] = real;
      saved.length = 0;
      syncBuiltinESMExports();
    },
  };
}

/** Run `fn` with `targets` blocked, then restore, whatever `fn` did. */
export async function withBlockedPaths(targets, fn) {
  const seam = blockPaths(...targets);
  try { return await fn(seam.hits); } finally { seam.restore(); }
}
