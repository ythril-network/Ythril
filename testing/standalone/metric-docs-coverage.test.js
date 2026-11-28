/**
 * Every metric the instance exposes is in the docs, and every metric the docs name exists.
 *
 * ## The finding
 *
 * The whole media-pipeline family — `ythril_media_jobs_pending`, `_processing`, `_completed_total`,
 * `_failed_total`, `_retried_total`, `_failed` and `ythril_media_job_duration_seconds` — was exposed on
 * `/metrics` and absent from the documentation, while every other family (http, brain, sync, mcp, auth,
 * storage, degradation, posture) was listed. Seven metrics, none of them findable.
 *
 * That is not a documentation nicety. A fleet debugging a document that would not finish asked for a gauge
 * to show one long job — and `ythril_media_jobs_processing` had been shipping the whole time. The docs are
 * how an operator learns a metric exists, so an undocumented metric is, in practice, a metric that does not
 * exist; and being told to add one that is already there is the shape of the cost.
 *
 * ## Why enumerate the registry
 *
 * A hand-written list is how this happened: someone added the media family and did not add nine rows to a
 * table in another directory. This reads `metrics/registry.ts` and compares both directions, so the next
 * metric added without a row fails here instead of being discovered by a customer.
 *
 * Run: node --test testing/standalone/metric-docs-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allDocsText } from './_docs.mjs';
import { declaredMetricNames } from './_metric-sources.mjs';

/** Metric names as the registry declares them, in its own text and in every module under `server/src/metrics` that declares a metric (found by reading, not listed). */
const registryMetrics = () => declaredMetricNames();

/** Metric names the docs present as rows of the exposed-metrics table. */
function documentedMetrics(text) {
  return [...text.matchAll(/^\|\s*`(ythril_[a-z0-9_]+)`\s*\|/gm)].map(m => m[1]);
}

/**
 * The exposed names the docs never name WHOLE. A name counts only where no name character stands on either side of it: a substring match
 * read `ythril_embed_jobs` as documented inside `ythril_embed_jobs_failed_total` (bundle-41, Q-182 S5b), so a new metric whose name begins
 * another's passed this gate with no row of its own. The regex is built fresh per name.
 */
function undocumented(exposed, text) {
  return exposed.filter(n => !new RegExp(`(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])`).test(text));
}

describe('metrics — registry and docs agree', () => {
  const exposed = registryMetrics();
  const docsText = allDocsText();
  const documented = documentedMetrics(docsText);

  it('finds a meaningful number of metrics (the scan itself still works)', () => {
    // If a refactor changes how metrics are declared, this test must fail LOUDLY rather than quietly
    // comparing two empty lists and passing.
    // A floor, not a count: this asks "did the scan still parse anything", and must not need editing every
    // time a metric is added or the docs are reordered.
    assert.ok(exposed.length >= 20, `only found ${exposed.length} metrics in registry.ts`);
    assert.ok(documented.length >= 20, `only found ${documented.length} documented metrics`);
  });

  it('every metric the instance exposes is documented', () => {
    const missing = undocumented(exposed, docsText);
    assert.deepEqual(missing, [], `exposed on /metrics, absent from the docs:\n  ${missing.join('\n  ')}\n\n`
      + 'Add a row to the "Metrics exposed" table in docs/integration-guide/11-setup-api.md. An\n'
      + 'undocumented metric is one an operator cannot find, which is how a fleet came to ask for a gauge\n'
      + 'that already existed.');
  });

  it('a name that only begins a documented one is not documented (whole names, not substrings)', () => {
    // The plant is the repository's own row for the longer name, read from the docs, never typed here: the docs text it is matched against
    // holds `ythril_embed_jobs_failed_total` and nothing else, so `ythril_embed_jobs` must come back undocumented.
    const row = docsText.split(/\r?\n/).find(l => /^\|\s*`ythril_embed_jobs_failed_total`\s*\|/.test(l));
    assert.ok(row, 'fixture: the docs hold no row for ythril_embed_jobs_failed_total to plant');
    assert.deepEqual(undocumented(['ythril_embed_jobs', 'ythril_embed_jobs_failed_total'], row), ['ythril_embed_jobs'],
      'a metric named by a prefix of a documented one was read as documented: the gate matches substrings');
  });

  it('every metric the docs name actually exists', () => {
    const known = new Set(exposed);
    // Node's own process metrics are documented as a family, not per name, so anything not in the registry
    // and not prefixed `ythril_` is out of scope for this direction.
    const ghosts = documented.filter(n => !known.has(n));
    assert.deepEqual(ghosts, [], `documented but not exposed — an operator would alert on nothing:\n  `
      + `${ghosts.join('\n  ')}\n\nFix the doc, or restore the metric if it was renamed.`);
  });

  it('no metric is documented twice', () => {
    // Two rows for one metric is how a rename half-lands: the old row survives and reads as a second signal.
    const seen = new Set(), dupes = [];
    for (const n of documented) { if (seen.has(n)) dupes.push(n); seen.add(n); }
    assert.deepEqual(dupes, [], `duplicate rows: ${dupes.join(', ')}`);
  });
});
