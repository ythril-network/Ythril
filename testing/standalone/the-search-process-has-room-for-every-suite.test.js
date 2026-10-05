/**
 * The test stack's search process (mongot, inside every mongodb-atlas-local container) has a heap sized for the
 * whole CI run, and when it dies anyway the run says so.
 *
 * Found by PR #1484's CI, 2026-10-05: integration, sync and redteam were green; then standalone's db batches ran
 * against the same harness Mongo, mongot logged `Terminating due to java.lang.OutOfMemoryError: Java heap space`,
 * and the container's runner stopped mongod cleanly — `Exited (0)`, `OOMKilled false`, every later db test
 * `ECONNREFUSED`. Reproduced locally in the CI order (scratchpad p564/diag-mongot.md): mongot starts with
 * `-XX:+ExitOnOutOfMemoryError` and no `-Xmx`, so its heap is a quarter of the container limit — 640 MiB at
 * 2560m — and the live vector indexes, ~95 after the earlier suites and ~255-317 at standalone's concurrent burst
 * (about 5 MB each), exhaust it. The same death had voided a local redteam run that morning with no cause found,
 * because mongot's own log goes to /dev/null by default and the runner's SIGTERM was all anyone saw.
 *
 * So the rules, derived from the compose file and ci.yml rather than listed:
 *  - the harness Mongo (the service publishing the port `_mongo-harness.mjs` connects to) sets mongot's heap
 *    explicitly, at least the 1280 MiB the full CI order was measured to need, and at most half its container
 *    limit, so mongod keeps the other half;
 *  - every atlas-local service writes mongot's and the runner's logs to a file;
 *  - every job of ci.yml that starts the stack dumps those files for every atlas-local service when it fails, so a
 *    mongot death names itself. (The release line's ci.yml is one job; main's is several, each starting its own stack,
 *    so the rule is read off the parsed workflow's stack jobs rather than off one step.)
 *
 * Run: node --test testing/standalone/the-search-process-has-room-for-every-suite.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCi, stepsOf, shellOf, expressionOf } from '../_shared/ci-workflow.mjs';
import { loadCompose, resolveDefaults, resolvedValue, memoryMiB, environmentOf } from '../_shared/compose-file.mjs';
import { stackJobs } from '../_shared/compose-start-sets.mjs';

const CI = loadCi();
const HARNESS = readFileSync('testing/standalone/_mongo-harness.mjs', 'utf8');

/** The heap the full CI order (integration, sync, redteam, then standalone on one Mongo) was measured to need. */
const MEASURED_HEAP_MIB = 1280;

/** The two log files an atlas-local service is told to write, `[MONGOT_LOG_FILE, RUNNER_LOG_FILE]`, empty when unset. */
const logFilesOf = (svc) => ['MONGOT_LOG_FILE', 'RUNNER_LOG_FILE'].map((k) => String(environmentOf(svc)[k] ?? '').trim());

const all = loadCompose('testing/docker-compose.test.yml').services;
const atlas = Object.entries(all).filter(([, s]) => String(s.image ?? '').startsWith('mongodb/mongodb-atlas-local'));
const harnessPort = (HARNESS.match(/127\.0\.0\.1:(\d{4,5})/) || [])[1];
const harness = Object.entries(all).find(([, s]) => harnessPort && (s.ports ?? []).some((p) => resolveDefaults(p).includes(`127.0.0.1:${harnessPort}:27017`)));

describe('the search process has room for every suite, and says when it dies', () => {
  it('finds the atlas-local services and the harness Mongo', () => {
    assert.ok(atlas.length >= 4, `found ${atlas.map(([n]) => n).join(', ') || 'no'} atlas-local services`);
    assert.ok(harnessPort, '_mongo-harness.mjs names no loopback port');
    assert.ok(harness, `no service publishes 127.0.0.1:${harnessPort}:27017`);
  });

  it('the harness Mongo sets mongot\'s heap: at least the measured need, at most half its container', () => {
    const [name, svc] = harness;
    const opts = environmentOf(svc).JAVA_TOOL_OPTIONS;
    assert.ok(opts, `${name} sets no JAVA_TOOL_OPTIONS, so mongot's heap is a quarter of the container by default`);
    const xmx = resolveDefaults(opts).match(/-Xmx([\d.]+[gmk])/i);
    assert.ok(xmx, `${name}'s JAVA_TOOL_OPTIONS sets no -Xmx: ${opts}`);
    const heap = memoryMiB(xmx[1]);
    const limit = memoryMiB(resolvedValue(svc, 'mem_limit') ?? '');
    assert.ok(heap >= MEASURED_HEAP_MIB, `${name}'s mongot heap is ${heap} MiB; the full CI order needs ${MEASURED_HEAP_MIB}`);
    assert.ok(heap <= limit / 2, `${name}'s mongot heap ${heap} MiB leaves mongod less than half of ${limit} MiB`);
  });

  it('every atlas-local service writes mongot\'s and the runner\'s logs to a file', () => {
    const blind = atlas.filter(([, s]) => logFilesOf(s).some((f) => !f)).map(([n]) => n);
    assert.deepEqual(blind, [], 'a mongot death in these is invisible: its log goes to /dev/null');
  });

  it('every stack job of ci.yml dumps those logs, for every atlas-local service, when it fails', () => {
    const files = new Set(atlas.flatMap(([, s]) => logFilesOf(s)).filter(Boolean));
    assert.ok(files.size >= 2, 'no log file paths found in the compose file');
    const jobs = stackJobs(CI);
    assert.ok(jobs.length >= 1, 'ci.yml starts no compose stack: the derivation is broken');
    // `shellOf` follows a local composite action: the dump lives in one so the jobs do not each copy it.
    for (const { id, job } of jobs) {
      const dumps = stepsOf(job).filter(s => /\bfailure\(\)/.test(expressionOf(s.if)) && /docker\s+cp\b/.test(shellOf(s)));
      assert.ok(dumps.length >= 1, `ci.yml job ${id} starts the stack and has no failure-time step that reads the logs with docker cp (which works on a stopped container)`);
      const text = dumps.map(s => shellOf(s)).join('\n');
      const missing = [...files].filter(f => !text.includes(f));
      assert.deepEqual(missing, [], `job ${id}'s dump does not print these files`);
      for (const [name] of atlas) {
        assert.ok(text.includes(name), `job ${id}'s dump does not name ${name}`);
      }
    }
  });
});
