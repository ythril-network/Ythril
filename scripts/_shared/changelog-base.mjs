/**
 * The ref the changelog gate compares a branch against: the release line a branch tracks, else `origin/main`.
 *
 * ## What it prevents
 *
 * The preflight compared every branch with `origin/main`. A branch on a release line (`release/6.5.x`) holds that line's
 * changelog, not main's, so the gate failed on every patch branch, the untouched release tag included (6.5.7, 2026-11-26),
 * and the preflight could never record a pass for a patch. An explicit `PREFLIGHT_CHANGELOG_BASE` wins, for a branch whose
 * upstream is not set.
 */
export function changelogBase({ upstream = '', override = '' } = {}) {
  if (override.trim()) return override.trim();
  if (/^origin\/release\/[^/]+$/.test(upstream.trim())) return upstream.trim();
  return 'origin/main';
}
