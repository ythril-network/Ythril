/**
 * The source text of every module that declares a metric — the one reader for a test that asks "what does the registry's SOURCE say" (a name, a help text, a
 * label set, a pre-declared series, a collector's shape), beside `_metric-series.mjs`, which asks the running registry what it holds.
 *
 * ## Why a module
 *
 * `metrics/registry.ts` is being split into one module per slice (`sync-tombstone-metrics.ts` was the first). About ten tests read its text, each with its own
 * `readFileSync` of the one path, so each slice meant a hand edit in each of them; the one that was forgotten stayed green and read the registry only, so a metric
 * that had moved was neither required in the docs nor checked for its labels. Here the set of modules is found by reading the files, never listed.
 *
 * ## What it decides, so no caller can drop it
 *
 * A module under `server/src/metrics` DECLARES a metric when its code (comments out, so the sentence explaining a fix cannot count) constructs a prom-client
 * `Counter`, `Gauge`, `Histogram` or `Summary`. `registry.ts` is always read and a checkout without it throws, so an empty or moved registry is never read as "no
 * metrics". Files are listed through git (`trackedSources`, with the files git has not committed yet), never by walking the directory, so a gitignored file is
 * not read and a new module is read before its first commit. The text is returned raw: a caller strips comments itself, as it did before.
 *
 * A test that reads the SOURCE of a metric declaration, and not the running registry, reads it from here; `the-metric-scanners-see-every-module-that-declares-a-metric.test.js`
 * fails on a test that names `registry.ts` on its own.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const METRICS_DIR = 'server/src/metrics';
const REGISTRY = `${METRICS_DIR}/registry.ts`;
/** A module constructs a prom-client metric. */
const DECLARES = /\bnew\s+(?:[\w$]+\.)?(?:Counter|Gauge|Histogram|Summary)\b/;

/**
 * `registry.ts` first, then every other module under `server/src/metrics` that declares a metric, as `[{ file, text }]` (`file` repo-relative, forward slashes).
 * `root` is the checkout to read, default this repository (a scratch copy of the tracked layout is read the same way).
 */
export function metricSources({ root = REPO_ROOT } = {}) {
  const files = trackedSources([METRICS_DIR], { root, floor: 5, specs: false, untracked: true });
  if (!files.includes(REGISTRY)) throw new Error(`${REGISTRY} is not in ${root}: the metric scanners would read an empty registry`);
  const read = (file) => ({ file, text: readFileSync(join(root, file), 'utf8') });
  const sources = files.map(read).filter(s => s.file === REGISTRY || DECLARES.test(stripComments(s.text)));
  return [...sources.filter(s => s.file === REGISTRY), ...sources.filter(s => s.file !== REGISTRY).sort((a, b) => a.file.localeCompare(b.file))];
}

/** Every metric source joined with a newline: for a scan that asks of the whole text, not of one file. */
export function metricSourceText(opts = {}) {
  return metricSources(opts).map(s => s.text).join('\n');
}

/** The names the sources declare as `name: 'ythril_...'`, in source order, comments out. */
export function declaredMetricNames(opts = {}) {
  return metricSources(opts).flatMap(s => [...stripComments(s.text).matchAll(/name:\s*'(ythril_[a-z0-9_]+)'/g)].map(m => m[1]));
}
