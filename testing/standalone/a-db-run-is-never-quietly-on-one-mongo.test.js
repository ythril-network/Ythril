/**
 * A run of the database third either gets the shard MongoDBs it was planned for, or says why it cannot (Q-731).
 *
 * ## What it prevents
 *
 * Inside the Docker runner the `docker` command does not exist, so the shard count's probe of the Docker VM got no
 * answer, and the count quietly became 1: every one of the ~600 database-backed files ran four at a time against the one
 * harness MongoDB. The run took 2 501 s on bundle-255 and passed the 55-minute bound twice on bundle-259, where the host's
 * sharded run had taken 332 s, and nothing in the log said it was not sharded. Held here:
 *
 *  - **No answer from Docker and no count given is refused**, naming `YTHRIL_TEST_DB_SHARDS=1` for whoever means one
 *    MongoDB. A count that is given is never second-guessed.
 *  - **Shards started outside the run** (`YTHRIL_TEST_DB_SHARDS_STARTED=1`, the runner container's host starts them with
 *    `node testing/_init/db-shard-stack.mjs up`) need a count of two or more, or the run would be on one MongoDB again.
 *  - **A started shard nobody can reach is refused before a file runs**, naming its port: otherwise every file of that
 *    shard skips itself for want of a database, and the run reads green about nothing.
 *  - **The runner uses it**: its sharded path attaches to started shards and leaves them for their starter to remove.
 *
 * Run: node --test testing/standalone/a-db-run-is-never-quietly-on-one-mongo.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as stack from '../_init/db-shard-stack.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { closedLoopbackPort } from '../_shared/closed-port.mjs';

const noDocker = async () => ({ ncpu: 0, memBytes: 0 });
const bigVm = async () => ({ ncpu: 16, memBytes: 16 * 2 ** 30 });

/** A loopback port something listens on, and a way to close it. */
const listening = () => listenOnLoopback(net.createServer(c => c.end()));
const deadPort = closedLoopbackPort;

describe('the shard count', () => {
  it('is refused, not quietly 1, when Docker does not answer and no count is given', async () => {
    await assert.rejects(
      stack.resolveDbShardConfig({ defaultWidth: 4, shards: '', width: '', started: '', askVm: noDocker }),
      /docker does not answer[\s\S]*YTHRIL_TEST_DB_SHARDS=1/);
  });

  it('is the count given, whatever Docker answers', async () => {
    const one = await stack.resolveDbShardConfig({ defaultWidth: 4, shards: '1', width: '', started: '', askVm: noDocker });
    assert.deepEqual([one.count, one.started], [1, false]);
    const four = await stack.resolveDbShardConfig({ defaultWidth: 4, shards: '4', width: '', started: '', askVm: noDocker });
    assert.deepEqual([four.count, four.started], [4, false]);
  });

  it('still follows the Docker VM when Docker answers', async () => {
    const c = await stack.resolveDbShardConfig({ defaultWidth: 4, shards: '', width: '', started: '', askVm: bigVm });
    assert.equal(c.count, 4);
  });
});

describe('shards started outside the run', () => {
  it('are taken when the count is two or more', async () => {
    const c = await stack.resolveDbShardConfig({ defaultWidth: 4, shards: '3', width: '', started: '1', askVm: noDocker });
    assert.deepEqual([c.count, c.started], [3, true]);
  });

  // '' is unset, as resolveDbShardConfig reads it. Never `undefined`: a default parameter would read the environment instead,
  // and inside `in-docker.sh --db` that holds YTHRIL_TEST_DB_SHARDS=4 and YTHRIL_TEST_DB_SHARDS_STARTED=1.
  for (const shards of ['', '1']) {
    it(`are refused with YTHRIL_TEST_DB_SHARDS=${JSON.stringify(shards)}`, async () => {
      await assert.rejects(
        stack.resolveDbShardConfig({ defaultWidth: 4, shards, width: '', started: '1', askVm: bigVm }),
        /YTHRIL_TEST_DB_SHARDS_STARTED[\s\S]*two or more/);
    });
  }

  it('refuses a value other than 1', async () => {
    await assert.rejects(
      stack.resolveDbShardConfig({ defaultWidth: 4, shards: '2', width: '', started: 'yes', askVm: bigVm }),
      /YTHRIL_TEST_DB_SHARDS_STARTED=yes/);
  });
});

describe('attaching to started shards', () => {
  it('names every port that does not answer, before any file runs', async () => {
    const live = await listening();
    const dead = await deadPort();
    try {
      const ports = [live.port, dead];
      await assert.rejects(stack.attachDbShards(2, { portOf: i => ports[i], timeoutMs: 2000 }),
        (e) => { assert.match(e.message, new RegExp(`\\b${dead}\\b`)); assert.doesNotMatch(e.message, new RegExp(`\\b${live.port}\\b`)); return true; });
    } finally { await live.close(); }
  });

  it('returns each shard with its port when all answer', async () => {
    const a = await listening();
    const b = await listening();
    try {
      const ports = [a.port, b.port];
      assert.deepEqual(await stack.attachDbShards(2, { portOf: i => ports[i], timeoutMs: 2000 }),
        [{ index: 0, port: a.port }, { index: 1, port: b.port }]);
    } finally { await a.close(); await b.close(); }
  });
});

describe('the standalone runner', () => {
  // LF whatever the checkout: the function's end is found by its closing line, which a CRLF checkout spells with \r.
  const runner = stripComments(readFileSync(join(REPO_ROOT, 'testing/_init/run-standalone.mjs'), 'utf8')).replace(/\r\n/g, '\n');

  it('attaches to started shards instead of starting its own, and does not remove them', () => {
    const body = runner.slice(runner.indexOf('async function runDbSharded'));
    const end = body.indexOf('\n}\n');
    assert.ok(body.length > 0 && end > 0, 'runDbSharded not found in run-standalone.mjs');
    const fn = body.slice(0, end + 2);
    assert.match(fn, /attachDbShards\(/, 'runDbSharded never calls attachDbShards');
    assert.match(fn, /started\s*\?\s*Promise\.resolve\(\)\s*:\s*stopDbShards\(/, 'runDbSharded removes shards it did not start');
    assert.match(fn, /started\s*\?\s*attachDbShards\(/, 'runDbSharded does not choose attachDbShards when the shards were started outside');
    assert.match(runner, /runDbSharded\([^)]*dbShards\.started/, 'the runner does not pass dbShards.started to runDbSharded');
  });
});
