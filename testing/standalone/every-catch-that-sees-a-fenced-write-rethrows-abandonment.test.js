/**
 * Every catch in a media job file whose guarded code can reach a write about the run's file rethrows (or handles) an abandonment
 * (bundle-44, D-29, Q-436; rulings 4, 14, 45).
 *
 * ## The rule
 *
 * The loss of a run's claim, or of its space's writability, is not an error of the work: a catch that absorbs it lets the run go on
 * producing, and paying for, output that is not its file's any more. Every fenced write (`upsertDerivedFileRow`, `markFileProcessing`,
 * `completeJob`, the embedders that reach them) can throw it, so every catch around one has to let it through: `isAbandonment(err)` is asked
 * in the catch, and the run's terminal handler (the worker's) is the one place that may end the run on it instead of rethrowing.
 *
 * ## What is derived, never listed
 *
 *  - **The job files**: `files/media/worker.ts` and every `files/media/*-embedder.ts`, found by name in the tracked tree.
 *  - **The writes**: every function whose reach (by calls, to exhaustion) writes a space's `files` or `media_jobs` collection
 *    (`_file-row-writers.mjs`, the derivation the three claim-fence gates share), by what a function DOES and not by whether it takes a claim.
 *  - **The subjects**: every `try { … } catch` and every `….catch(…)` in a job file whose guarded code (the try block, or the statement the
 *    `.catch` is chained to) calls one of those functions, directly or through the file's own helpers.
 *
 * ## What is asserted
 *
 * Each subject's catch asks `isAbandonment(`. A floor on the subjects found stops an empty derivation passing for a clean tree.
 *
 * ## Seen red
 *
 * Mutation (put back by hand): remove the `if (isAbandonment(err)) throw err;` line from the re-embed catch of `video-embedder.ts`, from the
 * auto-label catch of `face-embedder.ts`, or from the chunk catch of `audio-embedder.ts`.
 *
 * Run: node --test testing/standalone/every-catch-that-sees-a-fenced-write-rethrows-abandonment.test.js   (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceTree, writesTo, reaches } from './_file-row-writers.mjs';
import { callSitesIn } from './_call-graph.mjs';
import { balancedFrom, argumentsOf, statementUpTo } from './_structural-window.mjs';

const WORKER = 'server/src/files/media/worker.ts';
const { INDEX } = sourceTree();
const jobFiles = INDEX.files.filter(f => f === WORKER || /^server\/src\/files\/media\/[\w-]+-embedder\.ts$/.test(f));

/**
 * Callees that write the store and are NOT a run's write about its file, with the reason: a catch that guards only these has no claim to
 * lose. Keyed by the function's name; a row no catch needs any more fails below.
 */
const NOT_A_RUNS_WRITE = {
  resetStalledJobs: 'stall recovery over every job of a space at the worker\'s start: it is what TAKES a claim away from a run, and no run exists yet whose claim it could lose',
};

const WRITE_KEYS = new Set([...writesTo('files', { floor: 20, includeComputed: true }), ...writesTo('media_jobs', { floor: 10 })].map(s => s.key));
const reachesAWrite = new Map();
/** Whether the function `key` (or anything it calls) writes the space's files or jobs. */
function writes(key) {
  if (!reachesAWrite.has(key)) reachesAWrite.set(key, [...reaches(key)].some(k => WRITE_KEYS.has(k)));
  return reachesAWrite.get(key);
}

/** The calls in `text` that land on a function of the tree which writes. */
function writersCalledIn(file, text) {
  return callSitesIn(text, { closures: true }).map(c => ({ name: c.name, key: INDEX.resolve(file, c.name) }))
    .filter(c => c.key && writes(c.key) && !(c.name in NOT_A_RUNS_WRITE));
}

/** Every catch of a job file with the code it guards: `{ key, form, guarded, handler }`. */
function catchesOfTheJobFiles() {
  const out = [];
  for (const [key, entry] of INDEX.bodies) {
    if (entry.alias || !jobFiles.includes(entry.file)) continue;
    const { body } = entry;
    for (const m of body.matchAll(/\btry\s*\{/g)) {
      const block = balancedFrom(body, m.index + m[0].length - 1, `${key} try`);
      const after = body.slice(m.index + m[0].length - 1 + block.length);
      const c = /^\s*catch\s*(?:\(\s*\w+\s*(?::\s*\w+)?\s*\))?\s*\{/.exec(after);
      if (!c) continue;
      out.push({ key, file: entry.file, form: 'try/catch', guarded: block, handler: balancedFrom(after, c[0].length - 1, `${key} catch`) });
    }
    for (const m of body.matchAll(/\.catch\s*\(/g)) {
      out.push({
        key, file: entry.file, form: '.catch(…)', guarded: statementUpTo(body, m.index, `${key} .catch`),
        handler: argumentsOf(body, m.index + m[0].length - 1, `${key} .catch`).join(', '),
      });
    }
  }
  return out;
}

const CATCHES = catchesOfTheJobFiles();
const SUBJECTS = CATCHES.map(c => ({ ...c, writers: writersCalledIn(c.file, c.guarded) })).filter(c => c.writers.length > 0);

describe('the catches around a fenced write are found', () => {
  it('the job files and their catches are found, and some of them guard a write', () => {
    assert.ok(jobFiles.includes(WORKER) && jobFiles.length >= 5, `the job files are ${jobFiles}: the derivation is broken`);
    assert.ok(CATCHES.length >= 20, `only ${CATCHES.length} catch(es) found in the job files: the scan is broken, not the code`);
    assert.ok(SUBJECTS.length >= 8, `only ${SUBJECTS.length} catch(es) found around a write: the derivation is broken, not the code`);
  });

  it('the subjects are in more than one file, so a single file\'s shape is not what is being read', () => {
    const files = new Set(SUBJECTS.map(s => s.file));
    assert.ok(files.size >= 4, `the subjects are all in ${[...files]}: the derivation reads one corner of the media path`);
    for (const f of ['video-embedder.ts', 'audio-embedder.ts', 'face-embedder.ts']) {
      assert.ok([...files].some(x => x.endsWith(f)), `no catch around a write was found in ${f}: the derivation lost a file it must read`);
    }
  });
});

describe('the exemptions are live', () => {
  it('every callee excused as not a run\'s write is still guarded by a catch of a job file, and owes its reason', () => {
    const guardedByACatch = new Set(CATCHES.flatMap(c => callSitesIn(c.guarded, { closures: true }).map(x => x.name)));
    assert.deepEqual(Object.keys(NOT_A_RUNS_WRITE).filter(n => !guardedByACatch.has(n)), [], 'exemptions for calls no catch of a job file guards: delete them');
    for (const [name, why] of Object.entries(NOT_A_RUNS_WRITE)) assert.ok(why.length > 40, `${name}: an exemption owes its reason`);
  });
});

describe('every catch around a write lets an abandonment through', () => {
  it('asks isAbandonment, in every job file', () => {
    const silent = SUBJECTS.filter(s => !/\bisAbandonment\s*\(/.test(s.handler)).map(s => `${s.key} (${s.form}, around ${[...new Set(s.writers.map(w => w.name))].join(', ')})`);
    assert.deepEqual(silent, [],
      'these catches can see a write that throws the loss of the run\'s claim and do not ask isAbandonment: a run that lost its claim absorbs the loss and goes on for a file that is not its');
  });
});
