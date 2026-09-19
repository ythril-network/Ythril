/**
 * Which standalone tests need a running instance, and which do not — the ONE place that decides.
 *
 * ## Why it is a module
 *
 * Two runners ask this question: `scripts/preflight.mjs`, which runs the offline half before a push, and
 * `testing/_init/run-standalone.mjs`, which runs both halves for `npm run test:standalone`. A second copy
 * of the split is a second place for preflight and the suite to disagree about which gates exist, and a
 * green preflight that runs a different set from CI is worth nothing.
 *
 * The reasoning below came from preflight, where it was written; it moved here whole rather than being
 * summarised, because every paragraph of it is a measurement.
 *
 * ## The split is DECLARED, not inferred
 *
 * A test that drives a live server says `@needs-instance` in its header; everything else is offline.
 *
 * It used to be inferred, by content match on `fetch(|127.0.0.1|localhost:|INSTANCES|BASE_URL`. That
 * guarded the loud direction — a test that really hits the network without a marker fails with
 * ECONNREFUSED — and completely missed the quiet one: a PURE test that merely MENTIONS one of those
 * strings was silently excluded and never ran locally at all.
 *
 * Measured before replacing it, by running every standalone file alone with nothing listening: **22 of
 * 158 were pure and being skipped**, among them `ssrf-hardening`, `ssrf-ip-pinning`, `peer-ssrf-policy`,
 * `oidc-issuer-ssrf`, `log-redaction`, `secrets-permissions` and `config-permissions`. "Preflight PASSED"
 * was not running the SSRF suites. It cost two red CI runs (#559 and #562), each on an assertion inside a
 * file the heuristic had excluded for containing the word `fetch(` in its own failure messages.
 *
 * Zero files were wrong in the other direction, which is why a declared marker is safe: the failure mode
 * it introduces (a new server-driving test that forgets the marker) is the loud one that was already
 * handled.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Anchored to a HEADER line, never a bare substring.
 *
 * A bare match self-excluded the very gate that polices this split, because that file necessarily
 * mentions the marker in its assertions — the same "matched test data, not behaviour" mistake the
 * heuristic made, one level up.
 */
export const NEEDS_INSTANCE = /^\s*\*\s*@needs-instance/m;

/**
 * The two halves, as bare filenames, sorted.
 *
 * TRACKED files, not whatever is on disk. `readdirSync` picks up untracked ones too, so a scratch
 * `*.test.js` left in this folder would run locally and NOT in CI — the one divergence that makes a green
 * local run worthless.
 */
export function splitStandalone() {
  const all = execFileSync('git', ['ls-files', 'testing/standalone'], { encoding: 'utf8' })
    .split('\n').map(f => f.split('/').pop()).filter(f => f && f.endsWith('.test.js')).sort();
  const offline = all.filter(f => !NEEDS_INSTANCE.test(readFileSync(`testing/standalone/${f}`, 'utf8')));
  const needsInstance = all.filter(f => !offline.includes(f));
  /*
   * A FLOOR, because an empty list runs nothing and reports success about it. That is the same defect
   * one level up from what these tests check, and it is the line a hand-written copy drops.
   */
  if (all.length < 100) {
    throw new Error(`only ${all.length} standalone test file(s) found — the listing is broken, not the `
      + 'tests. An empty or short scan runs nothing and passes.');
  }
  return { all, offline, needsInstance };
}

/**
 * Split a path list into command lines under the Windows limit.
 *
 * The failure that taught this: `The command line is too long.` — printed by cmd, not by node, so the
 * gate went RED with no test output and nothing named. One more test file was all it took.
 *
 * Batched by measured LENGTH rather than a file count: the paths differ in length, so a fixed count would
 * drift back over the limit as names grow. 8 000 characters is a quarter of the ceiling, which leaves
 * room for the interpreter prefix and any flags.
 */
export function batched(paths, budget = 8_000) {
  const out = [[]];
  let len = 0;
  for (const p of paths) {
    if (len + p.length + 1 > budget && out[out.length - 1].length > 0) { out.push([]); len = 0; }
    out[out.length - 1].push(p);
    len += p.length + 1;
  }
  return out;
}
