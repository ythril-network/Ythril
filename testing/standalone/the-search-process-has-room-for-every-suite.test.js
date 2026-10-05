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
 *  - ci.yml's failure dump prints those files for every atlas-local service, so a mongot death names itself.
 *
 * Run: node --test testing/standalone/the-search-process-has-room-for-every-suite.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const COMPOSE = readFileSync('testing/docker-compose.test.yml', 'utf8').replace(/\r\n/g, '\n');
const CI = readFileSync('.github/workflows/ci.yml', 'utf8').replace(/\r\n/g, '\n');
const HARNESS = readFileSync('testing/standalone/_mongo-harness.mjs', 'utf8');

/** The heap the full CI order (integration, sync, redteam, then standalone on one Mongo) was measured to need. */
const MEASURED_HEAP_MIB = 1280;

/** Each service block under `services:`, by name (the same reading the-test-stack-leaves-the-machine-room uses). */
function services() {
  const lines = COMPOSE.split('\n');
  const start = lines.indexOf('services:');
  const out = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const header = line.match(/^  ([a-z0-9-]+):\s*$/);
    if (header) { name = header[1]; out[name] = '\n'; continue; }
    if (name) out[name] += `${line}\n`;
  }
  return out;
}

/** A size like `1280m`, `3g` or `${VAR:-3072m}` in MiB. */
function mib(raw) {
  const v = String(raw).trim().replace(/^["']|["']$/g, '');
  const d = v.match(/\$\{[A-Z0-9_]+:-([^}]+)\}/);
  const s = d ? d[1] : v;
  const m = s.match(/^([\d.]+)\s*([gmk])b?$/i);
  assert.ok(m, `unreadable size: ${raw}`);
  return Number(m[1]) * ({ g: 1024, m: 1, k: 1 / 1024 })[m[2].toLowerCase()];
}

const all = services();
const atlas = Object.entries(all).filter(([, b]) => /image:\s*mongodb\/mongodb-atlas-local/.test(b));
const harnessPort = (HARNESS.match(/127\.0\.0\.1:(\d{4,5})/) || [])[1];
const harness = Object.entries(all).find(([, b]) => harnessPort && new RegExp(`127\\.0\\.0\\.1:${harnessPort}:27017`).test(b));

describe('the search process has room for every suite, and says when it dies', () => {
  it('finds the atlas-local services and the harness Mongo', () => {
    assert.ok(atlas.length >= 4, `found ${atlas.map(([n]) => n).join(', ') || 'no'} atlas-local services`);
    assert.ok(harnessPort, '_mongo-harness.mjs names no loopback port');
    assert.ok(harness, `no service publishes 127.0.0.1:${harnessPort}:27017`);
  });

  it('the harness Mongo sets mongot\'s heap: at least the measured need, at most half its container', () => {
    const [name, block] = harness;
    const opts = block.match(/JAVA_TOOL_OPTIONS:\s*(.+)/);
    assert.ok(opts, `${name} sets no JAVA_TOOL_OPTIONS, so mongot's heap is a quarter of the container by default`);
    const xmx = opts[1].match(/-Xmx(\$\{[A-Z0-9_]+:-[^}]+\}|[\d.]+[gmk])/i);
    assert.ok(xmx, `${name}'s JAVA_TOOL_OPTIONS sets no -Xmx: ${opts[1]}`);
    const heap = mib(xmx[1]);
    const limit = mib((block.match(/mem_limit:\s*(.+)/) || [])[1] ?? '');
    assert.ok(heap >= MEASURED_HEAP_MIB, `${name}'s mongot heap is ${heap} MiB; the full CI order needs ${MEASURED_HEAP_MIB}`);
    assert.ok(heap <= limit / 2, `${name}'s mongot heap ${heap} MiB leaves mongod less than half of ${limit} MiB`);
  });

  it('every atlas-local service writes mongot\'s and the runner\'s logs to a file', () => {
    const blind = atlas.filter(([, b]) => !/MONGOT_LOG_FILE:\s*\S/.test(b) || !/RUNNER_LOG_FILE:\s*\S/.test(b)).map(([n]) => n);
    assert.deepEqual(blind, [], 'a mongot death in these is invisible: its log goes to /dev/null');
  });

  it('ci.yml\'s failure dump prints those logs for every atlas-local service', () => {
    const dump = CI.split(/\n(?=      - name:)/).find(s => /- name: Dump container logs on failure/.test(s));
    assert.ok(dump, 'ci.yml has no "Dump container logs on failure" step');
    const files = new Set(atlas.flatMap(([, b]) => [...b.matchAll(/(?:MONGOT|RUNNER)_LOG_FILE:\s*(\S+)/g)].map(m => m[1])));
    assert.ok(files.size >= 2, 'no log file paths found in the compose file');
    const missing = [...files].filter(f => !dump.includes(f));
    assert.deepEqual(missing, [], 'the dump does not print these files');
    assert.match(dump, /docker cp/, 'the dump must read the files with docker cp, which works on a stopped container');
  });
});
