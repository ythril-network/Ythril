/**
 * The embed queue's vocabulary (its lanes, its job statuses, the lane a priority is claimed in, and the shapes built from them) stands in one leaf
 * named for what it answers, and every other file imports it (Q-182, bundle-41, round-1 finding F10).
 *
 * ## The defect
 *
 * `a-closed-name-list-is-written-once` made each list stand in one file, and the file it chose was `metrics/embed-claim-age.ts`, named for how long
 * a claim waited. The queue and the jobs page imported the queue's own vocabulary from a metrics file. Around the lists, the same set was still
 * spelled by hand: `EMBED_PRIORITY` (`write: 0, background: 1, rebuild: 2`) beside the lane names, `{ pending: 0, processing: 0, failed: 0 }` four
 * times and `{ pending: number; processing: number; failed: number }` twice, an alias of the status list in the metric's file, a second `LaneCounts`
 * type, and the leaked-rows repair's `kept` shape written beside the reasons the registry seeds.
 *
 * ## What it holds
 *
 * 1. `brain/embed-job-names.ts` declares `EMBED_LANE_NAMES`, `EMBED_JOB_STATUSES`, `embedLaneOf`, the count types and the one zero builder, and
 *    imports nothing (a leaf: no cycle can run through it). No other server source declares either list.
 * 2. The queue, the jobs page and the metric's slice import them from the leaf, and `metrics/embed-claim-age.ts` is only the claim-age sink.
 * 3. `EMBED_PRIORITY[EMBED_LANE_NAMES[i]] === i` for every lane, and the two have the same length: the two hand-written lists of one set agree.
 * 4. The status counts' shape is `Record<EmbedJobStatus, number>` and its zero is built from the list: the literals are gone; the metric keeps no
 *    alias of the list and no second lane-count type; the leaked-rows repair's `kept` shape comes from `LEAKED_ROW_KEPT_REASONS`.
 * 5. The audio embedder's clock reader takes `RegExpMatchArray` (`RegExpExecArray` extends it, so the union said nothing).
 *
 * Seen red on f3cd49548: the leaf does not exist, the lists stand in `metrics/embed-claim-age.ts`, and the literals are written four times.
 *
 * Run: node --test testing/standalone/the-embed-queues-names-are-written-in-the-leaf-that-answers-for-them.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, readTrackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const LEAF = 'server/src/brain/embed-job-names.ts';
const src = (file) => stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
const SOURCES = readTrackedSources(SERVER_CODE_ROOTS).map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), text: stripComments(text) }));
const declaring = (re) => SOURCES.filter(s => re.test(s.text)).map(s => s.file);

describe('the embed queue\'s names stand in the leaf that answers for them', () => {
  it('the leaf declares the lists, the lane reader, the count types and the zero builder, and imports nothing', () => {
    const text = src(LEAF);
    for (const decl of [/export const EMBED_LANE_NAMES\b/, /export const EMBED_JOB_STATUSES\b/, /export function embedLaneOf\b/,
      /export type EmbedJobCounts = Record<EmbedJobStatus, number>/, /export function zeroEmbedJobCounts\b/]) {
      assert.match(text, decl, `${LEAF} does not declare ${decl}`);
    }
    assert.doesNotMatch(text, /^\s*import\b/m, `${LEAF} imports a module: a leaf has no imports, so no import cycle can run through it`);
  });

  it('no other server source declares either list, and the queue, the jobs page and the metric import them from the leaf', () => {
    assert.deepEqual(declaring(/export const EMBED_LANE_NAMES\b/), [LEAF]);
    assert.deepEqual(declaring(/export const EMBED_JOB_STATUSES\b/), [LEAF]);
    for (const file of ['server/src/brain/embed-queue.ts', 'server/src/brain/embed-jobs-page.ts', 'server/src/metrics/embed-job-metrics.ts', 'server/src/metrics/embed-claim-age.ts']) {
      const text = src(file);
      assert.match(text, /from '(?:\.\.\/brain|\.)\/embed-job-names\.js'/, `${file} does not import the queue's names from brain/embed-job-names.ts`);
    }
    const strays = SOURCES.filter(s => /\b(?:EMBED_LANE_NAMES|EMBED_JOB_STATUSES|embedLaneOf)\b[^;]*from '[^']*embed-claim-age\.js'|import \{[^}]*\b(?:EMBED_LANE_NAMES|EMBED_JOB_STATUSES|embedLaneOf)\b[^}]*\} from '[^']*embed-claim-age\.js'/.test(s.text)).map(s => s.file);
    assert.deepEqual(strays, [], 'a file reads the queue\'s vocabulary from the claim-age sink instead of the leaf');
  });

  it('EMBED_PRIORITY[EMBED_LANE_NAMES[i]] === i for every lane, and both have the same length', async () => {
    const { EMBED_LANE_NAMES } = await import('../../server/dist/brain/embed-job-names.js');
    const { EMBED_PRIORITY } = await import('../../server/dist/brain/embed-queue.js');
    assert.equal(Object.keys(EMBED_PRIORITY).length, EMBED_LANE_NAMES.length, 'the priorities and the lane names are lists of different length');
    EMBED_LANE_NAMES.forEach((name, i) => assert.equal(EMBED_PRIORITY[name], i, `lane ${name} is claimed at priority ${EMBED_PRIORITY[name]}, but the lane list puts it at ${i}`));
  });

  it('the zero builder answers one zero per status, and a lane\'s read of a stored priority is a lane name', async () => {
    const { EMBED_JOB_STATUSES, zeroEmbedJobCounts, embedLaneOf } = await import('../../server/dist/brain/embed-job-names.js');
    assert.deepEqual(zeroEmbedJobCounts(), Object.fromEntries(EMBED_JOB_STATUSES.map(s => [s, 0])));
    assert.notEqual(zeroEmbedJobCounts(), zeroEmbedJobCounts(), 'the builder hands out one shared object: a caller adding to it adds for every other');
    assert.equal(embedLaneOf(1), 'background');
    assert.equal(embedLaneOf(undefined), 'write');
    assert.equal(embedLaneOf(9), 'write');
  });

  it('the status counts and the kept reasons are not spelled by hand', () => {
    const queue = src('server/src/brain/embed-queue.ts');
    const page = src('server/src/brain/embed-jobs-page.ts');
    const metrics = src('server/src/metrics/embed-job-metrics.ts');
    const repair = src('server/src/files/leaked-rows-repair.ts');
    const handWritten = /pending:\s*0,\s*processing:\s*0,\s*failed:\s*0|pending:\s*number;\s*processing:\s*number;\s*failed:\s*number/;
    assert.deepEqual(SOURCES.filter(s => s.file !== LEAF && handWritten.test(s.text)).map(s => s.file), [], 'the statuses are spelled by hand outside the leaf');
    assert.doesNotMatch(queue, /export type EmbedJobCounts\b/, 'embed-queue.ts declares its own EmbedJobCounts');
    assert.doesNotMatch(page, /counts:\s*\{/, 'the jobs page states the counts\' shape by hand');
    assert.doesNotMatch(metrics, /\bconst STATUSES\b/, 'embed-job-metrics.ts keeps an alias of the status list');
    assert.doesNotMatch(metrics, /\btype LaneCounts\b/, 'embed-job-metrics.ts declares its own lane-count type');
    assert.doesNotMatch(repair, /depth:\s*(?:number|0)\s*[,;]\s*recent|recent:\s*(?:number|0)\s*[,;]\s*live/, 'the leaked-rows repair spells its kept reasons by hand');
    assert.ok((repair.match(/LEAKED_ROW_KEPT_REASONS/g) ?? []).length >= 3, 'the kept shape and its zero are not derived from LEAKED_ROW_KEPT_REASONS');
  });

  it('the audio embedder\'s clock reader takes RegExpMatchArray alone', () => {
    assert.doesNotMatch(src('server/src/files/media/audio-embedder.ts'), /clockSeconds\s*=\s*\([^)]*RegExpExecArray/, 'RegExpExecArray extends RegExpMatchArray: the union names nothing the second does not');
  });
});
