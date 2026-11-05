/**
 * The ONE reading of a release tag: which version it names, whether it is the highest release, and which tag a run is on (Q-683).
 *
 * ## The questions it answers
 *
 *  - {@link tagMatchesVersion}: is the tag exactly `v` + the manifests' version? (`release-gate.mjs`)
 *  - {@link isHighestReleaseTag}: is the tag the highest NON-PRERELEASE `v*` tag of a list, by numeric semver order?
 *    (`release-latest.mjs`, which the Release step's `--latest` reads, and `publish-schema.mjs`, whose npm dist-tag follows it)
 *  - {@link releaseTagOf}: which tag is this run on? `GITHUB_REF` when it is a tag ref, else git's exact tag of HEAD, else none.
 *    (`release-gate.mjs`)
 *  - {@link semverOf}: the numbers of a version, for the callers that need its major, minor or a prerelease mark.
 *
 * ## What it prevents
 *
 *  1. `release-gate.mjs` never compared the tag with the manifests' version: a tag `v6.5.1` cut on a tree that says 6.5.0
 *     published an image, a Release and an npm version under the wrong number, and none of the three can be taken back (npm
 *     never accepts the same version twice).
 *  2. The Release step's `--latest` came from `git tag --list 'v*' --sort=-v:refname | head -n1`, which ranks `v7.0.0-rc.1`
 *     ABOVE `v6.9.0`, so a release candidate was announced as Latest, and npm's `latest` dist-tag would have followed it: every
 *     `npm install` without a tag would then fetch a candidate. "Highest" is spelled here once, so the GitHub Release and the npm
 *     dist-tag cannot disagree about it.
 *
 * ## What it does not do
 *
 * It is pure: no git, no file system, no network, no environment. The callers gather `ref`, `refName`, the tag list and the
 * `describe` function and hand them in, so every branch is a table row (`testing/standalone/release-tags.test.js`).
 */

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * The numbers of a version, or `null` when the text is not one (no build metadata, no leading zeros, three parts).
 *
 * @param {unknown} text a version without the `v`, such as `6.5.0` or `6.6.0-rc.1`
 * @returns {{ major: number, minor: number, patch: number, prerelease: string | null } | null}
 */
export function semverOf(text) {
  const m = typeof text === 'string' ? SEMVER.exec(text) : null;
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null } : null;
}

/** The release (non-prerelease) version a `v*` tag names, or `null` for a non-v tag, a malformed one or a prerelease. */
function releaseOf(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const parsed = semverOf(tag.slice(1));
  return parsed && parsed.prerelease === null ? parsed : null;
}

/** Numeric semver order of two parsed releases: negative when `a` is lower. */
const compareReleases = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * Is the tag exactly `v` + the version? Nothing is not a match: no tag, no version or a version that is not one answers `false`.
 *
 * @param {unknown} tag
 * @param {unknown} version
 */
export function tagMatchesVersion(tag, version) {
  return typeof tag === 'string' && semverOf(version) !== null && tag === `v${version}`;
}

/**
 * Is `tag` the highest release of `tags`? It is "the tag IS the highest of the list": a tag the list does not contain, an empty
 * list, a prerelease and a non-`v` tag all answer `false`, so a checkout that fetched no tags never claims Latest. Prereleases and
 * non-`v` tags in the list are ignored: a release candidate never takes a release off the top. The list is not changed.
 *
 * @param {unknown} tag
 * @param {readonly unknown[]} tags
 */
export function isHighestReleaseTag(tag, tags) {
  const mine = releaseOf(tag);
  if (!mine) return false;
  const releases = (tags ?? []).map(releaseOf).filter(Boolean);
  return releases.some((r) => compareReleases(r, mine) === 0) && releases.every((r) => compareReleases(r, mine) <= 0);
}

/**
 * The tag a run is on: the pushed tag when `ref` is a tag ref (git is never asked, so the answer cannot be another tag on the
 * same commit), else what `describe` prints, trimmed, else `null` (a branch, no tag, or `describe` throwing, as git exits non-zero
 * when HEAD is no tag).
 *
 * @param {{ ref?: string, refName?: string, describe: () => string | null | undefined }} run
 * @returns {string | null}
 */
export function releaseTagOf({ ref, refName, describe }) {
  if (typeof ref === 'string' && ref.startsWith('refs/tags/') && refName) return refName;
  let out;
  try {
    out = describe();
  } catch {
    return null;
  }
  const tag = typeof out === 'string' ? out.trim() : '';
  return tag || null;
}
