/**
 * The counters of the leaked-rows repair and of a move that finished without its sidecar exist before their first event
 * (bundle-113, Q-465 and Q-467; vet: observability S1, S2, S3).
 *
 * ## The series
 *
 *   ythril_leaked_rows_removed_total{kind}      kind: derived, link
 *   ythril_leaked_rows_kept_total{reason}       reason: depth, recent, live
 *   ythril_leaked_rows_repair_pending_spaces    a gauge: the spaces whose scan has not reached its end
 *   ythril_file_moves_finished_without_sidecar_total
 *
 * A counter that does not exist until its first event cannot be told from a counter that is not wired: `rate()` over a series
 * that appears at the first removal shows nothing for the whole healthy period, and an alert on "the repair keeps removing rows"
 * never evaluates until after the second removal. So each series is in a fresh process's scrape at 0, for EVERY label value the
 * repair can move — `housekeeping-metrics-are-declared-at-zero` is the precedent, and `metric-docs-coverage` already holds that each
 * name has its docs row once it is declared (it reads the literal `name: 'ythril_...'` in `metrics/registry.ts`, so each is that).
 *
 * What it does NOT hold: the values the repair writes (`a-row-hanging-off-a-file-this-instance-deleted-is-repaired-db` does,
 * against a real pass), nor the labels beyond the two named (a third would be the repair's own to add).
 *
 * Run: node --test testing/standalone/the-repair-and-sidecar-move-counters-are-declared-at-zero.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';

const registry = await import('../../server/dist/metrics/registry.js');
const REGISTRY_SOURCE = readFileSync(join(REPO_ROOT, 'server', 'src', 'metrics', 'registry.ts'), 'utf8');

/** What each series is: its name, its type, and the label values the scrape must carry at 0 (none: one unlabelled sample). */
const SERIES = Object.freeze([
  { name: 'ythril_leaked_rows_removed_total', type: 'counter', label: 'kind', values: ['derived', 'link'] },
  { name: 'ythril_leaked_rows_kept_total', type: 'counter', label: 'reason', values: ['depth', 'recent', 'live'] },
  { name: 'ythril_leaked_rows_repair_pending_spaces', type: 'gauge' },
  { name: 'ythril_file_moves_finished_without_sidecar_total', type: 'counter' },
]);

const jsonOf = async (name) => (await registry.register.getMetricsAsJSON()).find(m => m.name === name);

describe('the repair and the sidecar-move counters are declared at zero', () => {
  for (const s of SERIES) {
    it(`${s.name} is a ${s.type} with a help text, named by a literal in metrics/registry.ts`, async () => {
      const metric = await jsonOf(s.name);
      assert.ok(metric, `the registry exposes no \`${s.name}\``);
      assert.equal(metric.type, s.type);
      assert.ok(typeof metric.help === 'string' && metric.help.length >= 20, `\`${s.name}\` has no help text worth the name`);
      assert.ok(REGISTRY_SOURCE.includes(`name: '${s.name}'`), `\`${s.name}\` is not a literal \`name:\` in metrics/registry.ts, so the docs-coverage gate cannot see it`);
    });

    it(`${s.name} is in a fresh process's scrape at 0${s.values ? `, for each ${s.label} (${s.values.join(', ')})` : ''}`, async () => {
      const metric = await jsonOf(s.name);
      assert.ok(metric, `the registry exposes no \`${s.name}\``);
      if (s.values === undefined) {
        assert.ok(metric.values.length >= 1 && metric.values.every(v => v.value === 0), `\`${s.name}\` has no sample at 0: ${JSON.stringify(metric.values)}`);
        return;
      }
      for (const value of s.values) {
        const sample = metric.values.find(v => v.labels?.[s.label] === value);
        assert.ok(sample, `\`${s.name}\` has no series for ${s.label}="${value}" before its first event`);
        assert.equal(sample.value, 0);
      }
    });
  }
});
