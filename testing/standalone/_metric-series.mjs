/**
 * The series of one metric as the registry holds them — the one reader every `-db` test uses to ask "what does this counter or gauge say".
 *
 * ## Why a module
 *
 * Two files each read a metric their own way: `metricValue` (the leaked-rows repair's counters: fail when the metric or the labelled series is not declared) and
 * `scanHoldSeries` (the scan-hold counter: `null` when nothing is declared). They answer the same question and differ in one thing only, what an ABSENT series
 * means, and a copy that picks the wrong answer is quiet: a series that is not declared reads as zero when it is summed with `?? 0`, so a "was not counted" row
 * passes over a metric that does not exist.
 *
 * ## What it decides, so no caller can drop it
 *
 * **`absent`** is the option, not a second function: `'fails'` (the default) is a plain assertion that names the metric and the series that ARE declared, so a
 * build without it fails the case with the reason and not with a TypeError; `'null'` answers `null`, which a caller can refuse itself or treat as "not yet declared"
 * (the reading taken before a pass). Absent means no metric of that name, or no series carrying every one of `labels`.
 */
import assert from 'node:assert/strict';

/**
 * The series of `name` carrying every label in `labels`, as `[{ labels, value }]`, in the order the registry holds them.
 * `registry` is the imported `server/dist/metrics/registry.js` (default: imported here). `absent` is `'fails'` or `'null'` (see the module docblock).
 */
export async function metricSeries(name, { labels = {}, absent = 'fails', registry } = {}) {
  assert.ok(absent === 'fails' || absent === 'null', `metricSeries: absent is 'fails' or 'null', got ${JSON.stringify(absent)}`);
  const { register } = registry ?? await import('../../server/dist/metrics/registry.js');
  const metric = register.getSingleMetric(name);
  if (!metric) {
    assert.ok(absent === 'null', `metrics/registry.ts declares no \`${name}\``);
    return null;
  }
  const { values } = await metric.get();
  const hit = values.filter(v => Object.entries(labels).every(([k, want]) => v.labels?.[k] === want));
  if (hit.length === 0) {
    assert.ok(absent === 'null', `\`${name}\` has no series for ${JSON.stringify(labels)}: it is not declared at zero (${JSON.stringify(values.map(v => v.labels))})`);
    return null;
  }
  return hit.map(v => ({ labels: v.labels ?? {}, value: v.value }));
}

/**
 * The sum of the samples of one metric series, or a plain failure that the metric does not exist — so a build without it fails the case with the reason and not
 * with a TypeError. `labels` selects the series; a gauge or an unlabelled counter takes none.
 */
export async function metricValue(name, labels = {}) {
  return (await metricSeries(name, { labels })).reduce((n, s) => n + s.value, 0);
}
