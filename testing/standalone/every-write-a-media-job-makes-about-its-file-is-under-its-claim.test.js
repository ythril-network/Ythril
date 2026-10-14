/**
 * Every write a media job makes about its file is made under the job's claim (bundle-44 D-29, Q-436, ruling 24).
 *
 * ## The rule
 *
 * The fence is not only for the rows a run derives. A run's other writes about its file — its processing state, its excerpt and
 * description, the end of its own job — take the file's PATH and the job's ID, and a path is reused: delete a file and upload another
 * at it, and a run that lost its claim to the delete writes into the new file. So the worker and the embedders reach the store about
 * their file only through writers that take the run's claim, and a writer that does not (the operator-side processing mark, the
 * embed queue's whole-row writer) is not called from them at all.
 *
 * ## What is derived, never listed
 *
 *  - **The job files**: `files/media/worker.ts` and every `files/media/*-embedder.ts`, found by name in the tracked tree.
 *  - **The subject calls**: every call, in a job file, of an exported function of `derived-fields.ts`, `job-queue.ts`, an embedder
 *    or the conversion pipeline whose reach (by calls, to exhaustion) writes a space's `files` or `media_jobs` collection. By what
 *    the callee DOES, not by what it takes: a gate derived from "takes a claim" would see no subject at the unchanged code.
 *  - **The operator-side writers**: the exported writers of `derived-fields.ts` that take no claim. A job file never calls one.
 *
 * ## What is asserted
 *
 *  1. every subject call hands the run's claim over (its argument text names `claim`, or spreads the caller's own `opts` bag, which
 *     `MediaRunOpts` requires to carry it), except the calls a reasoned entry below
 *     excuses (the heartbeat, the release, the claim itself, the move's hold, the clean-up the text job does of its own sidecars);
 *  2. no job file calls an operator-side writer — `setFileProcessingState` above all, which was the worker's own write of its
 *     file's state until the claim covered it.
 *
 * ## Seen red
 *
 * On e82caa5e the worker marks its file `processing` with `setFileProcessingState`, writes the excerpt and the description by path, and
 * ends its job by id; the embedders upsert by row. Mutation (put back by hand): call `setFileProcessingState` in the worker again.
 *
 * Run: node --test testing/standalone/every-write-a-media-job-makes-about-its-file-is-under-its-claim.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sourceTree, writesTo, reaches, DERIVED_FIELDS } from './_file-row-writers.mjs';
import { callSitesIn } from './_call-graph.mjs';
import { argumentsOf } from './_structural-window.mjs';

const WORKER = 'server/src/files/media/worker.ts';
const JOB_QUEUE = 'server/src/files/media/job-queue.ts';
const PIPELINE = 'server/src/files/converters/pipeline.ts';

/**
 * Calls a job file makes of a function that writes the store, and that are NOT the run's writes about its file, with the reason.
 * Keyed by the function's name; a stale row fails below.
 */
const NOT_ABOUT_ITS_FILE = {
  touchJobProgress: 'the heartbeat: it matches the run\'s token in its own filter and is best-effort, so it needs no fence of its own',
  releaseClaimedJob: 'hands the run\'s claim back at shutdown, guarded on the token in its own filter',
  claimNextJob: 'takes a claim for a job that has none yet: there is no run, and so no claim, to hand over',
  resetStalledJobs: 'stall recovery over every job of a space: it is what takes a claim away, not a run\'s write about its file',
  holdJobsForMove: 'the worker\'s reconcile hands a job back HELD for a move that owes its records; it is asked only by a run that still holds its claim (`holdsClaim`), and it is a revoker',
  deleteConversionArtifacts: 'the text job clears the sidecars of its own previous run before it re-chunks; the rows it removes are the file\'s own derived rows, and it spares the file\'s own job (`cancelJobsOwnedBy`)',
};

const { INDEX } = sourceTree();
const jobFiles = INDEX.files.filter(f => f === WORKER || /^server\/src\/files\/media\/[\w-]+-embedder\.ts$/.test(f));

/** Every exported function of the modules a job file may reach the store through, name -> key. */
function exportedWriters() {
  const modules = [DERIVED_FIELDS, JOB_QUEUE, PIPELINE, ...INDEX.files.filter(f => /^server\/src\/files\/media\/[\w-]+-embedder\.ts$/.test(f))];
  const byName = new Map();
  for (const file of modules) {
    for (const m of INDEX.sources.get(file).matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) {
      const key = `${file}:${m[1]}`;
      if (INDEX.bodies.has(key)) byName.set(m[1], key);
    }
  }
  return byName;
}
const EXPORTED = exportedWriters();
const WRITE_KEYS = new Set([...writesTo('files', { floor: 20, includeComputed: true }), ...writesTo('media_jobs', { floor: 10 })].map(s => s.key));
const SUBJECTS = new Map([...EXPORTED].filter(([, key]) => [...reaches(key)].some(k => WRITE_KEYS.has(k))));

/** The exported writers of the derived-fields module that take no claim: the operator-side ones. */
const OPERATOR_SIDE = new Set([...SUBJECTS].filter(([, key]) => key.startsWith(`${DERIVED_FIELDS}:`)
  && !new RegExp(`function\\s+${key.split(':').pop()}\\s*(?:<[^>]*>)?\\(\\s*spaceId\\s*:\\s*string\\s*,\\s*claim\\s*:\\s*JobClaim\\b`).test(INDEX.sources.get(DERIVED_FIELDS)))
  .map(([name]) => name));

/** The positioned calls in the job files of the functions in `names`, with their argument text. */
function callsInJobFiles(names) {
  const out = [];
  for (const [key, entry] of INDEX.bodies) {
    if (entry.alias || !jobFiles.includes(entry.file)) continue;
    for (const c of callSitesIn(entry.body, { closures: true })) {
      if (!names.has(c.name)) continue;
      out.push({ key, name: c.name, args: argumentsOf(entry.body, c.paren, `${key} -> ${c.name}`).join(', ') });
    }
  }
  return out;
}

describe('the job files, and the writers they reach the store through, are found', () => {
  it('the job files are the worker and every embedder', () => {
    assert.ok(jobFiles.includes(WORKER), 'the worker is not among the job files');
    assert.ok(jobFiles.length >= 5, `only ${jobFiles.length} job file(s) found (${jobFiles}) — the derivation is broken`);
  });
  it('the writers are found by what they do: the derived-row writers, the end of a job, the embedders', () => {
    for (const name of ['upsertDerivedFileRow', 'setDerivedExcerpt', 'completeJob', 'failJob', 'embedImage', 'embedAudio', 'embedFaces']) {
      assert.ok(SUBJECTS.has(name), `${name} is not found to write the store — the derivation is broken`);
    }
    assert.ok(SUBJECTS.size >= 12, `only ${SUBJECTS.size} writer(s) found`);
  });
  it('every exemption still names a function a job file calls', () => {
    const called = new Set(callsInJobFiles(new Set(Object.keys(NOT_ABOUT_ITS_FILE))).map(c => c.name));
    assert.deepEqual(Object.keys(NOT_ABOUT_ITS_FILE).filter(n => !called.has(n)), [], 'exemptions for calls no job file makes — delete them');
    for (const [k, why] of Object.entries(NOT_ABOUT_ITS_FILE)) assert.ok(why.length > 40, `${k}: an exemption owes its reason`);
  });
});

/**
 * What hands the claim over: the claim named, or the caller's own `opts` bag spread (`{ ...opts, steps }`), which `MediaRunOpts` requires to carry
 * it — so the compiler holds that half: a bag without a claim does not type-check.
 */
const HANDS_THE_CLAIM = /\bclaim\b|\.\.\.opts\b/;

describe('every write a media job makes about its file is under its claim', () => {
  it('every call of a writer from a job file hands the run\'s claim over', () => {
    const calls = callsInJobFiles(new Set(SUBJECTS.keys())).filter(c => !(c.name in NOT_ABOUT_ITS_FILE));
    assert.ok(calls.length >= 12, `only ${calls.length} call(s) found — the call scan is broken, not the code`);
    const without = calls.filter(c => !/\bclaim\b/.test(c.args)).map(c => `${c.key} calls ${c.name}(${c.args.slice(0, 80)})`);
    assert.deepEqual(without, [],
      'these write about the run\'s file without handing the writer its claim: a run that lost it (a delete and a re-upload of the path) writes into the file that replaced its own');
  });

  it('no job file calls an operator-side writer of the derived-fields module', () => {
    assert.ok(OPERATOR_SIDE.has('setFileProcessingState'), 'setFileProcessingState is not found to be an operator-side writer — the derivation is broken');
    const calls = callsInJobFiles(OPERATOR_SIDE).map(c => `${c.key} calls ${c.name}`);
    assert.deepEqual(calls, [], 'a job file writes its file through a writer that takes no claim: the job-side writer of the same state is markFileProcessing');
  });
});
