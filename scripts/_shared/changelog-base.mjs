import { execFileSync } from 'node:child_process';

/**
 * The ref the changelog gate compares a branch against: the release line a branch tracks, else `origin/main`.
 *
 * ## What it prevents
 *
 * The preflight compared every branch with `origin/main`. A branch on a release line (`release/6.5.x`) holds that line's
 * changelog, not main's, so the gate failed on every patch branch, the untouched release tag included (6.5.7, 2026-11-26),
 * and the preflight could never record a pass for a patch. An explicit `PREFLIGHT_CHANGELOG_BASE` wins, for a branch whose
 * upstream is not set.
 *
 * Two more faults it closes (Q-970). A ref name may hold `;`, `$(`, `&`, `|` and backticks, so an upstream is taken only when every
 * character is one of `[A-Za-z0-9._-]`; anything else is `origin/main`. The override is the caller's own text: it is refused when it
 * starts with `-` (an option to the check) or holds a character outside `[A-Za-z0-9._/-]`, and refused when git cannot resolve it,
 * because a mistyped base made the check skip ("cannot diff ... skipping (not CI)") and the preflight pass having compared nothing.
 */

const UPSTREAM = /^origin\/release\/[A-Za-z0-9._-]+$/;
const OVERRIDE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** Whether git resolves `ref` to a commit in the repository at `cwd` (default the working directory). The ref is an argument, never a shell string. */
export function gitResolves(ref, { cwd } = {}) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * @param {{ upstream?: string, override?: string, resolves?: (ref: string) => boolean }} [opts] `resolves` answers whether the override names a commit
 * @returns {string} the ref to compare with
 * @throws {Error} when the override is malformed or does not resolve
 */
export function changelogBase({ upstream = '', override = '', resolves = gitResolves } = {}) {
  const chosen = override.trim();
  if (chosen) {
    if (!OVERRIDE.test(chosen)) {
      throw new Error(`PREFLIGHT_CHANGELOG_BASE=${JSON.stringify(chosen)} is not a ref name this check takes: it must not start with "-" and may hold only letters, digits, ".", "_", "/" and "-"`);
    }
    if (!resolves(chosen)) {
      throw new Error(`PREFLIGHT_CHANGELOG_BASE=${JSON.stringify(chosen)} does not resolve to a commit: fix the name or fetch the ref, the changelog check compares nothing against it`);
    }
    return chosen;
  }
  if (UPSTREAM.test(upstream.trim())) return upstream.trim();
  return 'origin/main';
}
