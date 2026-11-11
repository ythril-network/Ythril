/**
 * Make a LOOK at one path under a space's files root fail with an errno, through the file-system seam every other fault test uses
 * (the shared `fs/promises` default object, patched and restored), and count that the fault fired.
 *
 * ## Why a module
 *
 * `chmod` cannot make a path unreadable on Windows or as root in Docker, so the manifest, the pull, the push and the upload door tests
 * of bundle-70 (Q-350 b) all inject the failure. Written by hand, each copy decides alone which calls fail and for which paths; the copy
 * that drifts is the one whose case passes because nothing it injected was ever reached.
 *
 * ## What it prevents
 *
 * A fault that never fired. `restore()` returns the number of calls the fault answered; a case asserts it is above zero, or it tested
 * a code path that does not reach the injected call. A fault is matched by the path RELATIVE to the root, in the spelling the disk keeps,
 * so one case can fail `a.txt` and leave `peer-<space>/a.txt` (the in-process fake peer's side) alone: only a path under `root` is looked at.
 *
 * ## What it does not do
 *
 * It builds no error of its own beyond the errno: the code under test sees `{ code, syscall }` as a refused look carries them. It never
 * touches `createReadStream` (callback API): a hash failure is injected at the `open` of `peek`, which every stored read makes first.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string} root  the space's files root: only a path under it is judged
 * @param {Array<{ fn: 'stat'|'lstat'|'readdir'|'open'|'realpath'|'access', match: (rel: string) => boolean, code?: string }>} rules
 *   `match` gets the path relative to `root`, with `/` separators and the disk's own spelling (`''` is the root itself)
 * @returns {{ fired: () => number, firedFor: (fn: string) => number, restore: () => number }}
 */
export function injectLookFaults(root, rules) {
  const base = path.resolve(root);
  const real = new Map();
  const counts = new Map();
  for (const fn of new Set(rules.map(r => r.fn))) {
    real.set(fn, fsp[fn]);
    counts.set(fn, 0);
    fsp[fn] = async function lookRefused(...args) {
      const target = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
      if (target === base || target.startsWith(base + path.sep)) {
        const rel = path.relative(base, target).replace(/\\/g, '/');
        const rule = rules.find(r => r.fn === fn && r.match(rel));
        if (rule) {
          counts.set(fn, counts.get(fn) + 1);
          const code = rule.code ?? 'EACCES';
          throw Object.assign(new Error(`${code}: injected, ${fn} '${args[0]}'`), { code, errno: code === 'EIO' ? -5 : -13, syscall: fn, path: args[0] });
        }
      }
      return real.get(fn).apply(this, args);
    };
  }
  let restored = false;
  return {
    fired: () => [...counts.values()].reduce((a, b) => a + b, 0),
    firedFor: (fn) => counts.get(fn) ?? 0,
    restore() {
      if (!restored) for (const [fn, f] of real) fsp[fn] = f;
      restored = true;
      return [...counts.values()].reduce((a, b) => a + b, 0);
    },
  };
}

/**
 * Run `fn` with the faults in place and hand back what it returned AND how many look calls the faults answered, for a case whose
 * subject is the code's ANSWER to the fault: it asserts the answer first (so a door that never looks fails on what it answered, not on this
 * module's words) and then that `fired` is above zero, which says the answer was reached through the fault and not around it.
 */
export async function lookFaultsAround(root, rules, fn) {
  const faults = injectLookFaults(root, rules);
  try {
    const result = await fn(faults);
    return { result, fired: faults.fired() };
  } finally {
    faults.restore();
  }
}

/** Run `fn` with the faults in place; they are lifted on every exit, and the case fails when none fired. */
export async function underLookFaults(root, rules, fn) {
  const faults = injectLookFaults(root, rules);
  let result;
  try {
    result = await fn(faults);
  } catch (err) {
    faults.restore();   // a failing case keeps its own failure, not this module's
    throw err;
  }
  if (faults.restore() === 0) throw new Error('the injected look fault never fired: the code under test does not reach the call, so the case tested nothing');
  return result;
}
