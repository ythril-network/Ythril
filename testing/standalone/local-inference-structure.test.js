/**
 * The shape of the code that keeps local inference in its own process — asserted as RULES, over sets DERIVED from
 * the repository.
 *
 * ## Why these are gates and not just tests of behaviour
 *
 * The behaviour of the host is pinned by running it (`supervised-worker-host.test.js`, the real-process tests).
 * What running cannot see is a structural decay that leaves every run green: a second file that imports the model
 * library (and loads a second copy in the server process), a child-side module that imports the server's logger
 * (and writes to a console nobody redacts), an environment passed to the child that became `process.env`, a
 * shutdown that closes the database before it has stopped the thing writing to it. Each is written once by
 * somebody who meant well, and none of them changes a single test result.
 *
 * ## How they are written (CLAUDE.md, "a gate concludes about MORE than it checks")
 *
 *  - **The set is derived, never listed.** Every `server/src` source through `git ls-files` (with the not-yet-
 *    committed ones, so the gate refuses BEFORE the push and not after), comments stripped so a sentence that
 *    names a thing is not mistaken for a use of it, and a floor on what was found.
 *  - **The rule, not the site.** "Every file that forks" and "everything the child imports, transitively", not a
 *    hand-written pair of names; a third file written next year is held to the same rule.
 *  - **Seen red.** Each was run against a mutation of the thing it guards; the list is in the commit.
 *
 * Run: node --test testing/standalone/local-inference-structure.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom, bodyOf, between, argumentsOf } from './_structural-window.mjs';
import { importClosure, relativeImports, bareImports } from './_import-closure.mjs';

const SRC = trackedSources('server/src', { floor: 100, untracked: true });
const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');
const code = (f) => stripComments(read(f));

const CHILD_ENTRY = 'server/src/brain/embed-process.ts';
const LOADER = 'server/src/brain/local-pipeline.ts';

describe('only one module loads the model library', () => {
  it('imports @huggingface/transformers in exactly one server source: brain/local-pipeline.ts', () => {
    const importers = SRC.filter(f => /['"]@huggingface\/transformers['"]/.test(code(f)));
    assert.deepEqual(importers, [LOADER],
      'a second importer is a second copy of the model in whichever process it runs in — and if it is the server, '
      + 'inference is back on the main thread');
  });

  it('embedding.ts keeps no pipeline, no loader state and no model-library switch', () => {
    const src = code('server/src/brain/embedding.ts');
    for (const gone of ['getLocalPipeline', '_pipelineInit', '_pipelineModelId', 'allowRemoteModels', 'env.cacheDir', 'isCached(', 'modelsOffline(']) {
      assert.ok(!src.includes(gone), `embedding.ts still contains \`${gone}\`: the local model is loaded in the child, by local-pipeline.ts`);
    }
    assert.ok(!/\bpipe\s*\(/.test(src), 'embedding.ts still calls a pipeline itself');
  });

  it('the local branch of embed() goes through the host with the PREPARED input', () => {
    const src = code('server/src/brain/embedding.ts');
    const at = src.indexOf('runLocalInference(');
    assert.ok(at > 0, 'embed() does not call runLocalInference');
    const args = balancedFrom(src, at, 'the runLocalInference arguments');
    assert.match(args, /\binput\b/, 'the host must be handed `input` (prefixed), never the raw `text`');
    assert.ok(!/\btext\b/.test(args), 'the raw text reached the host');
    assert.ok(src.includes('warmLocalInference('), 'warmEmbeddingModel does not warm through the host');
  });
});

describe('what runs inside the child', () => {
  const closure = () => importClosure(CHILD_ENTRY);

  it('found the child and its loader (the closure walk works)', () => {
    const files = closure();
    assert.ok(files.includes(CHILD_ENTRY));
    assert.ok(files.includes(LOADER), 'the child does not reach the loader through its imports');
    assert.ok(files.length >= 2, 'a closure of one file means the import regex matched nothing');
  });

  it('imports nothing of the server: only its own small modules, node built-ins and the model library', () => {
    const offenders = [];
    for (const f of closure()) {
      for (const dep of relativeImports(f)) {
        if (!dep.startsWith('server/src/brain/')) offenders.push(`${f} imports ${dep}`);
      }
      for (const pkg of bareImports(f)) {
        if (!(pkg.startsWith('node:') || pkg === '@huggingface/transformers')) offenders.push(`${f} imports the package ${pkg}`);
      }
    }
    assert.deepEqual(offenders, [],
      'the child has no loaded config, no database, no logger: anything it imports from the server either fails there '
      + 'or drags the server\'s state into a process that must stay small');
  });

  it('never imports the logger, the config loader, Mongo or the metrics registry, by name', () => {
    const forbidden = ['util/log', 'config/loader', 'db/mongo', 'metrics/registry'];
    for (const f of closure()) {
      for (const dep of relativeImports(f)) {
        for (const bad of forbidden) assert.ok(!dep.includes(bad), `${f} imports ${dep}`);
      }
    }
  });

  it('writes no console line: what it has to say goes over IPC to the redacting logger', () => {
    for (const f of closure()) {
      assert.ok(!/\bconsole\s*\./.test(code(f)),
        `${f} writes to the console; a line from the child would reach the container log without redaction`);
    }
  });

  it('the loader takes its inputs as arguments and never re-reads the environment', () => {
    assert.ok(!/\bprocess\.env\b/.test(code(LOADER)), 'local-pipeline.ts reads process.env; it gets { modelId, cacheDir, offline, threads } instead');
    assert.match(code(LOADER), /allowRemoteModels\s*=\s*false/);
    assert.match(code(LOADER), /\.cacheDir\s*=/);
  });

  it('keeps the truncation and pooling options with the inference, where a long input is bounded', () => {
    const child = closure().map(code).join('\n');
    assert.match(child, /pooling:\s*'mean'/);
    assert.match(child, /normalize:\s*true/);
    assert.match(child, /truncation:\s*true/,
      'without truncation one long input is gigabytes of attention memory and a wrong vector (chunk-size-bounded)');
  });

  it('does not apply a task prefix: the string it is given is the string it embeds', () => {
    for (const f of closure()) {
      assert.ok(!/search_query|search_document|prepareInput|Instruct:/.test(code(f)),
        `${f} prefixes text; the prefix is applied once, on the main side`);
    }
  });
});

describe('every file that is a fork or worker entry is held to the same rule', () => {
  const entries = () => SRC.filter(f => /\bprocess\.send\s*\(|\bprocess\.on\s*\(\s*['"]message['"]/.test(code(f)));

  it('found at least the inference child', () => {
    assert.ok(entries().includes(CHILD_ENTRY), `found ${JSON.stringify(entries())}`);
  });

  it('none of them writes to the console or imports the server logger', () => {
    assert.ok(entries().length >= 1, 'no entry found: a loop over nothing passes');
    for (const f of entries()) {
      assert.ok(!/\bconsole\s*\./.test(code(f)), `${f} is a child entry and writes to the console`);
      assert.ok(!relativeImports(f).some(d => d.includes('util/log')), `${f} is a child entry and imports the server logger`);
    }
  });
});

describe('the child\'s pipeline module is an argument, never found', () => {
  it('no server source reads a pipeline module from the environment or from configuration', () => {
    for (const f of SRC) {
      const src = code(f);
      assert.ok(!/process\.env\s*(?:\[\s*['"`][A-Z_]*PIPELINE[A-Z_]*['"`]\s*\]|\.[A-Z_]*PIPELINE)/.test(src),
        `${f} reads a pipeline module from the environment: that is a switch for replacing the embedder of a running instance`);
    }
    for (const f of SRC.filter(f => f.startsWith('server/src/config/'))) {
      assert.ok(!/pipelineModule/i.test(code(f)), `${f} makes the pipeline module a configuration key`);
    }
  });

  it('the host accepts it as `pipelineModule` and hands it to the child as `--pipeline=`, which the child reads from argv', () => {
    const host = code('server/src/brain/local-inference.ts');
    assert.match(host, /\bpipelineModule\b/);
    assert.ok(host.includes('--pipeline='));
    const child = code(CHILD_ENTRY);
    assert.ok(child.includes('--pipeline='));
    assert.match(child, /process\.argv/);
  });
});

describe('the inference thread count is the host\'s CPU budget, handed to the child as an argument', () => {
  // onnxruntime sizes its intra-op pool from the HOST's cores and ignores a container's CPU quota: on a one-CPU
  // container on 16 cores that was 640 ms per text against 54 ms with one thread. The count is decided once, by the
  // host, from `util/cpu-budget.ts`, and the child is told it; a child that computed it would be a second answer.

  it('every call of the model library\'s `pipeline(` in the loader passes the thread count it was given', () => {
    const src = code(LOADER);
    const calls = [...src.matchAll(/\bpipeline\s*\(/g)].map(m => m.index);
    assert.ok(calls.length >= 1, 'the loader calls no pipeline: re-anchor this gate');
    for (const at of calls) {
      const args = argumentsOf(src, at, 'the loader\'s pipeline call');
      const options = args[2] ?? '';
      assert.match(options, /session_options\s*:\s*\{[^}]*intraOpNumThreads\s*:\s*threads\b/,
        `pipeline(${args.join(', ')}) does not size onnxruntime's intra-op pool from the \`threads\` argument`);
      assert.match(options, /interOpNumThreads\s*:\s*1\b/, 'a single-model, one-request-at-a-time child needs no inter-op pool');
    }
    assert.match(src, /\{\s*modelId\s*,\s*cacheDir\s*,\s*offline\s*,\s*threads\s*\}\s*:\s*LocalPipelineSpec/,
      'loadLocalPipeline does not take `threads` as an argument');
  });

  it('the host reads the budget through util/cpu-budget and appends it as `--threads=`', () => {
    const host = code('server/src/brain/local-inference.ts');
    assert.ok(relativeImports('server/src/brain/local-inference.ts').includes('server/src/util/cpu-budget.ts'),
      'the inference host does not use the one module that answers "how many CPUs may this process use"');
    assert.ok(host.includes('--threads='));
    assert.match(host, /\bavailableCpus\b/);
  });

  it('the child reads it from argv, passes it to the loader, and never computes a CPU count itself', () => {
    const child = code(CHILD_ENTRY);
    assert.ok(child.includes('--threads='));
    assert.match(child, /loader\s*\(\s*\{[^}]*\bthreads\b[^}]*\}/, 'the child does not pass `threads` to the loader');
    for (const f of importClosure(CHILD_ENTRY)) {
      const src = code(f);
      assert.ok(!/availableParallelism|\bcpus\s*\(\s*\)|cpu\.max|cfs_quota/.test(src),
        `${f} runs in the inference child and sizes its own threads: the host decides, the child is told`);
    }
  });

  it('one module reads the cgroup quota: util/cpu-budget.ts', () => {
    const readers = SRC.filter(f => /cpu\.max|cfs_quota_us/.test(code(f)));
    assert.deepEqual(readers, ['server/src/util/cpu-budget.ts']);
  });
});

describe('one way to find a launchable entry', () => {
  it('the tsx command-line path is written in exactly one source: util/entry-path.ts', () => {
    const holding = SRC.filter(f => /cli\.mjs/.test(code(f)));
    assert.deepEqual(holding, ['server/src/util/entry-path.ts'],
      'two copies of "how to run a .ts entry in dev" drift: one gets the hoisting wrong and only dev notices');
  });

  it('every file that imports it calls resolveEntry, and both launchers are among them', () => {
    const users = SRC.filter(f => relativeImports(f).some(d => d === 'server/src/util/entry-path.ts'));
    assert.ok(users.length >= 2, `only ${JSON.stringify(users)} use util/entry-path`);
    for (const f of users) assert.match(code(f), /\bresolveEntry\s*\(/, `${f} imports entry-path and never calls it`);
    assert.ok(users.includes('server/src/api/local-agent.ts'), 'the local-agent launcher does not use the shared resolver');
    assert.ok(users.includes('server/src/brain/local-inference.ts'), 'the inference host does not use the shared resolver');
  });

  it('the local-agent launcher no longer resolves entries or finds tsx by hand', () => {
    const src = code('server/src/api/local-agent.ts');
    assert.ok(!src.includes('tsxCli'), 'api/local-agent.ts still locates tsx itself');
    assert.ok(!/existsSync\(\s*(?:js|ts)Entry/.test(src), 'api/local-agent.ts still picks between a compiled and a source entry itself');
  });
});

describe('what a fork passes the child', () => {
  const forkers = () => SRC.filter(f => /\bfork\s*\(/.test(code(f)));

  it('found the host that forks', () => {
    assert.ok(forkers().includes('server/src/util/supervised-worker.ts'), `found ${JSON.stringify(forkers())}`);
  });

  it('is an explicit environment, never the server\'s own', () => {
    assert.ok(forkers().length >= 1, 'no file forks: a loop over nothing passes');
    for (const f of forkers()) {
      const src = code(f);
      for (const m of src.matchAll(/\bfork\s*\(/g)) {
        const args = balancedFrom(src, m.index, `${f}: the fork arguments`);
        assert.match(args, /\benv\s*:/, `${f} forks without naming an environment, so the child inherits the server's`);
        assert.ok(!/\bprocess\.env\b/.test(args), `${f} passes process.env (or a spread of it) to a child: Mongo credentials, master key and API tokens would go with it`);
        assert.match(args, /\bexecArgv\s*:/, `${f} does not set execArgv, so inspector and heap flags are inherited`);
      }
    }
  });

  it('is built from an allowlist: the host has one, and the embedding layer names its additions', () => {
    const host = code('server/src/util/supervised-worker.ts');
    assert.match(host, /\bPLATFORM_ENV\b/);
    assert.match(code('server/src/brain/local-inference.ts'), /\bLOCAL_INFERENCE_ENV_NAMES\b/);
  });
});

describe('shutdown stops the inference process before the database goes', () => {
  const body = () => between(read('server/src/index.ts'), 'const shutdown =', "process.on('SIGTERM'", 'the shutdown handler');

  it('awaits stopLocalInference with a budget, after the brain worker stops and before closeMongo', () => {
    const src = stripComments(body());
    const brain = src.indexOf('stopBrainEmbeddingWorker(');
    const stop = src.indexOf('stopLocalInference(');
    const mongo = src.indexOf('closeMongo(');
    assert.ok(brain > 0 && stop > 0 && mongo > 0, `anchors: brain ${brain}, stop ${stop}, mongo ${mongo}`);
    assert.ok(brain < stop, 'the brain worker must stop claiming first, or it embeds into a host that is going away');
    assert.ok(stop < mongo, 'the inference process must be stopped before the database connection is closed');
    assert.match(src, /await\s+stopLocalInference\s*\(/, 'the stop must be awaited: an unawaited stop is a kill at process.exit');
    assert.match(balancedFrom(src, stop, 'the stopLocalInference arguments'), /budgetMs/, 'the drain must be bounded');
  });
});

describe('the queue and the worker use the claim', () => {
  it('the job document carries the crash counter', () => {
    assert.match(code('server/src/config/types-jobs.ts'), /\blostChildFailures\b/);
  });

  it('the queue takes the claim token on complete and fail, and offers a heartbeat', () => {
    const q = code('server/src/brain/embed-queue.ts');
    assert.match(q, /export async function heartbeatEmbedJob\b/);
    assert.match(bodyOf(q, 'completeEmbedJob'), /claimToken/, 'completeEmbedJob ignores the claim: a late finish deletes a newer claim');
    assert.match(bodyOf(q, 'failEmbedJob'), /claimToken/, 'failEmbedJob ignores the claim');
    assert.match(q, /MAX_LOST_CHILD_FAILURES/);
  });

  it('runOneEmbedJob waits out the host\'s backoff BEFORE claiming, heartbeats while embedding, and stops in a finally', () => {
    const w = code('server/src/brain/embed-worker.ts');
    const body = bodyOf(w, 'runOneEmbedJob');
    const wait = body.indexOf('waitOutLocalInferenceBackoff(');
    const claim = body.indexOf('claimNextEmbedJob(');
    assert.ok(wait > 0 && claim > 0, `anchors: wait ${wait}, claim ${claim}`);
    assert.ok(wait < claim, 'the worker claims before waiting out the backoff, so the claim is spent on a refused embed');
    assert.match(body, /heartbeatEmbedJob\(/);
    assert.match(body, /finally\s*\{[^}]*clearInterval/, 'the heartbeat is not cleared in a finally: a throw leaves a timer writing to a finished job');
    assert.match(body, /job\.claimToken/, 'the worker does not pass its claim to complete and fail');
  });
});
