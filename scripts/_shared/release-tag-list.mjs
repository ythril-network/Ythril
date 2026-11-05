/**
 * Every `v*` tag of a checkout, read from git (Q-683, the bundle-225 diff pass).
 *
 * ## The question it answers
 *
 * "Which release tags does this checkout hold?" The Release step's `--latest` answer (`release-latest.mjs`) and the npm dist-tag
 * of the schema publish (`publish-schema.mjs`) both rank the tag they run on against this list, through `release-tags.mjs`'s
 * `isHighestReleaseTag`. The ranking is that module's, and it stays pure; reading git is this module's.
 *
 * ## What it prevents
 *
 * The two callers each spelled `git tag --list 'v*'` and its split; a copy that matched another pattern, or that swallowed a failed
 * git as an empty list, would make a release look like the highest one (nothing ranks above it) and move `latest` onto a backfilled
 * or a wrong tag, which neither the Release nor npm can take back. A failed git THROWS here, so no caller can read "git failed" as
 * "there are no other tags". The caller's checkout must carry its tags (`fetch-depth: 0`).
 */
import { spawnSync } from 'node:child_process';

/**
 * @param {{ cwd?: string }} [options] the checkout to read, default the current directory
 * @returns {string[]} the trimmed, non-empty lines of `git tag --list 'v*'`
 */
export function listReleaseTags({ cwd } = {}) {
  const result = spawnSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8', timeout: 30_000, ...(cwd ? { cwd } : {}) });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0) {
    throw new Error(`git tag --list failed (${result.signal ? `signal ${result.signal}` : `status ${result.status}`})${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}
