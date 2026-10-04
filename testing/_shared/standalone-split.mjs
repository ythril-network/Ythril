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

/** The module every database-backed standalone file opens the test MongoDB through. */
const DB_HARNESS = '_mongo-harness.mjs';

/**
 * How many database-backed files run at once — against ONE MongoDB that every one of them shares.
 *
 * ## Why there is a cap, measured
 *
 * The offline half ran at node's default, one worker per core, and the `-db` files sat in it wherever the
 * alphabet put them. Bundle-30 added enough of them that one 8 000-character batch held 38, up to 23 at a time,
 * and on a fresh `ythril-mongo-a` (2.5 GiB cap, 768 MB WiredTiger cache) that batch peaked at 1.70 GiB alone and
 * 2.07 GiB after the batch before it. Started on a Mongo already carrying the other suites' data it crossed the cap
 * and the container was OOM-killed mid-run; every later `-db` file then SKIPPED itself and its batch read as
 * passing.
 *
 * Measured (bundle-30 I9): the 141 database-backed files alone, on a fresh `ythril-mongo-a` each time, sampled
 * with `docker stats` and `/proc` inside the container:
 *
 * | width | wall | failed | peak container | mongod RSS | mongot RSS |
 * |---|---|---|---|---|---|
 * | 23 (node's default here) | 449 s | 5 | 2.18 GiB | 1.45 GB | 0.59 GB |
 * | 8 | 219 s | 0 | 2.14 GiB | not sampled | not sampled |
 * | 4 | 186 s | 0 | 2.11 GiB | 1.33 GB | 0.65 GB |
 *
 * Four has the lowest peak and the shortest wall time. At full width five tests failed for want of the store —
 * the engine-score agreement on three metrics, a 150 s wait for a space's search, a write a control expected to
 * land — against a Mongo held to one CPU, and the run took more than twice as long. What the cap does NOT bound is stated so nobody reads it as more: most of the peak is
 * memory mongod and mongot keep as the run goes — WiredTiger's cache (768 MB) and the allocator's retained pages,
 * mongot's heap — and it grows with what the whole run writes, at any width. Raising the test Mongo's memory limit
 * would hide that rather than bound it.
 */
export const DB_TEST_CONCURRENCY = 4;

/** Modules a source imports, by file name: static `import … from '…'` and dynamic `import('…')`. */
function importedNames(src) {
  return [...src.matchAll(/^\s*import\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)]
    .map(m => (m[1] ?? m[2]).split('/').pop());
}

/**
 * The halves, as bare filenames, sorted.
 *
 * TRACKED files, not whatever is on disk. `readdirSync` picks up untracked ones too, so a scratch
 * `*.test.js` left in this folder would run locally and NOT in CI — the one divergence that makes a green
 * local run worthless.
 *
 * `offline` is split once more, into `offlineDb` — the files that open the test database — and `offlinePure`.
 * A file is database-backed when it imports `DB_HARNESS`, or a test helper that does (`_push-door.mjs`):
 * derived from the imports rather than from a `-db` suffix, because a suffix is a convention four such files do
 * not follow, and a db file missed here runs uncapped, which is the failure the split exists for.
 */
export function splitStandalone() {
  const tracked = execFileSync('git', ['ls-files', 'testing/standalone'], { encoding: 'utf8' })
    .split('\n').map(f => f.split('/').pop()).filter(Boolean);
  const all = tracked.filter(f => f.endsWith('.test.js')).sort();
  const read = (f) => readFileSync(`testing/standalone/${f}`, 'utf8');
  const offline = all.filter(f => !NEEDS_INSTANCE.test(read(f)));
  const needsInstance = all.filter(f => !offline.includes(f));
  // The helpers that open it for their caller: any tracked `.mjs` beside the tests or in `testing/_shared`.
  const helpers = execFileSync('git', ['ls-files', 'testing/standalone', 'testing/_shared'], { encoding: 'utf8' })
    .split('\n').filter(f => f.endsWith('.mjs'));
  const dbModules = new Set([DB_HARNESS, ...helpers
    .filter(f => importedNames(readFileSync(f, 'utf8')).includes(DB_HARNESS)).map(f => f.split('/').pop())]);
  const offlineDb = offline.filter(f => importedNames(read(f)).some(m => dbModules.has(m)));
  const offlinePure = offline.filter(f => !offlineDb.includes(f));
  /*
   * A FLOOR, because an empty list runs nothing and reports success about it. That is the same defect
   * one level up from what these tests check, and it is the line a hand-written copy drops.
   */
  if (all.length < 100) {
    throw new Error(`only ${all.length} standalone test file(s) found — the listing is broken, not the `
      + 'tests. An empty or short scan runs nothing and passes.');
  }
  /*
   * And one for the database half: an import scan that stopped matching would put every db file back among the
   * pure ones, at full width against one Mongo, and the run would still start.
   */
  if (offlineDb.length < 30) {
    throw new Error(`only ${offlineDb.length} database-backed standalone file(s) found — the import scan for `
      + `${DB_HARNESS} is broken, and the db files would run uncapped against one MongoDB.`);
  }
  return { all, offline, needsInstance, offlineDb, offlinePure };
}

/**
 * The command lines that run the offline half: what `test:standalone` and preflight both execute.
 *
 * Pure files first, at node's default width; then the database-backed files at `DB_TEST_CONCURRENCY`. Each is
 * `batched` under the Windows command-line limit. One plan, so the two runners cannot disagree about which files
 * run capped — preflight against a developer's local test stack meets the same Mongo the suite does.
 *
 * @returns {Array<{ kind: 'pure' | 'db', args: string[], files: string[] }>} `args` go after `--test`
 */
export function offlineRuns(split = splitStandalone()) {
  const path = (f) => `testing/standalone/${f}`;
  return [
    ...batched(split.offlinePure.map(path)).map(files => ({ kind: 'pure', args: [], files })),
    ...batched(split.offlineDb.map(path))
      .map(files => ({ kind: 'db', args: [`--test-concurrency=${DB_TEST_CONCURRENCY}`], files })),
  ];
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
