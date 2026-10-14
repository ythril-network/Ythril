/**
 * Drive the repair of rows left behind by a file this instance deleted, and read what it did — the question "what did the
 * leaked-rows repair remove, keep and count", answered once for every test that asks it (bundle-113, Q-465).
 *
 * ## Why a module
 *
 * Three suites ask about the repair (its derived-row half, its link half, and the restore/import that restart it) and each needs
 * the same four things: the pass itself, the seam that lands a re-upload inside it, the counters it moves, and the space's own
 * config entry (where its cursor lives). The second suite that needed them was about to copy them, and the copy that drifts is the
 * one whose case passes for the wrong reason.
 *
 * ## The part a hand-written copy drops
 *
 * **The pass is run through `sweepExpired(now)` and nothing else.** The repair is a step of the TTL sweep (as the strip of rows
 * flagged before the strip is, `a-row-flagged-before-the-strip-is-stripped-once-db`), so a test that called the repair's own entry
 * point would pass for a step the sweep never runs. `runPass(now)` is that one entry; a repair that is run from somewhere else
 * changes this one function.
 *
 * **`now` is a parameter, and it is the clock the daily wrap reads.** "Wrapping no sooner than daily" is a statement about the
 * sweep's own `now` (every other step of the sweep reads it), so a test moves time by passing a later `now`, never by waiting.
 *
 * **The counters are read as DELTAS of the scrape**, never as absolute values: other cases of the same file have moved them.
 *
 * ## The contract this module assumes of the implementation (the plan names these, the tests need them spelled)
 *
 *  - metrics `ythril_leaked_rows_removed_total{kind=derived|link}`, `ythril_leaked_rows_kept_total{reason=depth|recent|live}`,
 *    gauge `ythril_leaked_rows_repair_pending_spaces`;
 *  - `setRepairStepsForTest(steps | null)`, exported by the module that runs the repair, with
 *    `steps.beforeRemove({ spaceId, ids })` (runs after a page's leaked set was decided and before the delete is issued: the
 *    interval a re-upload can land in) and `steps.pageSize` (rows read per page, so a test makes "more than one page" small);
 *  - the cursor and the time of the last completed scan live on the space's CONFIG entry (`SpaceConfig`, like
 *    `deliveredByBackfilled`), in whichever keys the implementation chooses: tests find them by what a pass ADDS to the entry.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { REPO_ROOT } from './_sources.mjs';

/** The instant the first pass runs at: later than every `OLD` row and earlier than every `FUTURE` one. */
export const NOW = new Date('2026-10-01T00:00:00.000Z');
/** A row's `createdAt` that is older than any scan stamp. */
export const OLD = '2026-06-01T00:00:00.000Z';
/** A row's `createdAt` that is newer than any scan stamp the pass can take (its own `now`, or the wall clock). */
export const FUTURE = '2099-01-01T00:00:00.000Z';
/** `NOW` moved by `n` hours. */
export const hoursAfter = (n) => new Date(NOW.getTime() + n * 3_600_000);

export const METRICS = Object.freeze({
  removed: 'ythril_leaked_rows_removed_total',
  kept: 'ythril_leaked_rows_kept_total',
  pending: 'ythril_leaked_rows_repair_pending_spaces',
  movesWithoutSidecar: 'ythril_file_moves_finished_without_sidecar_total',
});

/** A file row as the conversion writes one: `parentFileId` makes it DERIVED from that file. */
export function fileRow(space, id, extra = {}) {
  return { _id: id, spaceId: space, path: id, tags: [], sizeBytes: 12, createdAt: OLD, updatedAt: OLD, ...extra };
}
/** A row derived from `parent` (a chunk, a converted or extracted copy, a caption or face row). */
export const derivedRow = (space, id, parent, extra = {}) => fileRow(space, id, { parentFileId: parent, ...extra });

/** Run one TTL sweep at `now`: the one entry the repair is reached by. */
export async function runPass(now = NOW) {
  const ttl = await import('../../server/dist/brain/ttl-sweep.js');
  return ttl.sweepExpired(now);
}

/**
 * The sample of one metric series, or a plain failure that the metric does not exist — so a build without it fails the case with the
 * reason and not with a TypeError. `labels` selects the series; a gauge or an unlabelled counter takes none.
 */
export async function metricValue(name, labels = {}) {
  const { register } = await import('../../server/dist/metrics/registry.js');
  const metric = register.getSingleMetric(name);
  assert.ok(metric, `metrics/registry.ts declares no \`${name}\``);
  const { values } = await metric.get();
  const hit = values.filter(v => Object.entries(labels).every(([k, want]) => v.labels?.[k] === want));
  assert.ok(hit.length > 0, `\`${name}\` has no series for ${JSON.stringify(labels)}: it is not declared at zero (${JSON.stringify(values.map(v => v.labels))})`);
  return hit.reduce((n, v) => n + v.value, 0);
}
/** The state of every counter the repair moves, to diff against after a pass. */
export async function repairCounters() {
  const reading = {};
  for (const kind of ['derived', 'link']) reading[`removed.${kind}`] = await metricValue(METRICS.removed, { kind });
  for (const reason of ['depth', 'recent', 'live']) reading[`kept.${reason}`] = await metricValue(METRICS.kept, { reason });
  return reading;
}
/**
 * {@link repairCounters} for the reading taken BEFORE a pass: a series that is not declared reads 0, so a build without the counters fails the case on
 * what the pass did (or did not do) and not on the missing series. The reading AFTER the pass stays strict.
 */
export async function repairCountersOrZero() {
  const reading = {};
  const read = (name, labels) => metricValue(name, labels).catch(() => 0);
  for (const kind of ['derived', 'link']) reading[`removed.${kind}`] = await read(METRICS.removed, { kind });
  for (const reason of ['depth', 'recent', 'live']) reading[`kept.${reason}`] = await read(METRICS.kept, { reason });
  return reading;
}
/** What moved between two {@link repairCounters} readings, series by series, zeroes left out. */
export function counterDelta(before, after) {
  return Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k]]).filter(([, d]) => d !== 0));
}

/** Where `setRepairStepsForTest` is exported, found in the built server: a test may not know which module the repair lives in. */
export function repairSeamFile() {
  const root = path.join(REPO_ROOT, 'server', 'dist');
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /export\s+(?:async\s+)?function\s+setRepairStepsForTest\b/.test(fs.readFileSync(full, 'utf8'))) found.push(full);
    }
  };
  walk(root);
  return found;
}
/** The seam of the repair, or the plain failure that it has none. */
export async function repairSteps() {
  const files = repairSeamFile();
  assert.equal(files.length, 1, `exactly one module of server/dist must export setRepairStepsForTest (the step seam of the leaked-rows repair: beforeRemove, pageSize); found ${files.length}`);
  const mod = await import(`file://${files[0].split(path.sep).join('/')}`);
  return mod.setRepairStepsForTest;
}

/** The space's entry in the live config, as the sweep and a restore see it. */
export async function spaceEntry(space) {
  const { getConfig } = await import('../../server/dist/config/loader.js');
  const entry = getConfig().spaces.find(s => s.id === space);
  assert.ok(entry, `space '${space}' is not in the config`);
  return entry;
}
/** The keys of a space's config entry that are not in `known`: what a pass wrote there. */
export const addedKeys = (entry, known) => Object.keys(entry).filter(k => !known.includes(k)).sort();

/**
 * How many levels up `parentFileId` a derived row looks for its owner — read from the build, wherever the constant lives, so a
 * chain built "one level deeper than the walk reads" stays one level deeper if the constant changes.
 */
export async function maxAncestry() {
  for (const mod of ['brain/suppress-embeddings.js', 'files/derived-rows.js', 'files/ancestry.js']) {
    const m = await import(`../../server/dist/${mod}`).catch(() => null);
    if (typeof m?.MAX_ANCESTRY === 'number') return m.MAX_ANCESTRY;
  }
  throw new Error('MAX_ANCESTRY is exported by none of the modules this helper knows — re-anchor _leaked-rows-repair.mjs');
}
