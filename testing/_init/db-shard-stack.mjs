/**
 * Start and remove the shard Mongos of a sharded `-db` run (Q-623): one fresh `ythril-mongo-a` per shard, in a compose
 * project of its own, gone when the run ends.
 *
 * ## What it answers
 *
 * One question: *give me N healthy harness Mongos, and take them away again.* Which file runs where is
 * `_shared/db-shard-plan.mjs`'s; how the files are run is the runner's.
 *
 * ## What it prevents
 *
 *  - **A shard that outlives its run.** `stopDbShards` removes the containers WITH their volumes, and the runner calls it
 *    from a `finally` and from the signal handlers: a Mongo left behind holds a port and 3 GiB of the Docker VM, and the
 *    next run's `up` fails on the port. Every start begins by removing what an earlier, killed run left under the same
 *    project name, so a leftover costs seconds and not a failed run.
 *  - **A run that starts on half its Mongos.** The shards come up together and `up --wait` returns only once each is
 *    healthy, which is the compose healthcheck's whole-boot-over probe (`x-mongo-healthcheck`: a test that begins while
 *    the image's last restart is still to come loses its connection mid-command). If any shard fails to start, the others
 *    are removed and the error carries the failing one's output; a run on fewer Mongos than planned would put a shard's
 *    files on a port nothing listens on, and every one of them would skip itself for want of a database.
 *  - **A second definition of the Mongo.** The container is `ythril-mongo-a` from `docker-compose.test.yml` with the
 *    two settings of `docker-compose.db-shard.yml` changed (its name and its published port); the image pin, the
 *    healthcheck, the credentials and the memory and CPU ceilings stay the base file's.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbShardPort, defaultDbShardCount, DB_SHARDS_MAX } from '../_shared/db-shard-plan.mjs';

const TESTING = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILES = ['docker-compose.test.yml', 'docker-compose.db-shard.yml'].map(f => join(TESTING, f));
const SERVICE = 'ythril-mongo-a';

/** Seconds `up --wait` gives a shard to become healthy: the base file's own healthcheck window, with room for several booting at once. */
const WAIT_TIMEOUT_SECONDS = 420;

/**
 * How many shards, and how many files at a time on each. `YTHRIL_TEST_DB_SHARDS` (1 to the plan's maximum; 1 is the one
 * Mongo at `YTHRIL_TEST_MONGO_PORT`, as before) and `YTHRIL_TEST_DB_SHARD_WIDTH` override; a value that is not a whole
 * number in range is an error, never a quiet default.
 */
export async function resolveDbShardConfig({
  defaultWidth, shards = process.env['YTHRIL_TEST_DB_SHARDS'], width = process.env['YTHRIL_TEST_DB_SHARD_WIDTH'],
}) {
  const whole = (name, raw, max) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name}=${raw} is not a whole number from 1 to ${max}`);
    return n;
  };
  const set = (raw) => raw !== undefined && raw !== '';
  return {
    count: set(shards) ? whole('YTHRIL_TEST_DB_SHARDS', shards, DB_SHARDS_MAX) : defaultDbShardCount(await dockerVm()),
    width: set(width) ? whole('YTHRIL_TEST_DB_SHARD_WIDTH', width, 16) : defaultWidth,
  };
}

/** The Docker VM's CPUs and memory; `{ ncpu: 0, memBytes: 0 }` (one Mongo, the old path) when `docker info` does not answer. */
function dockerVm() {
  return new Promise((resolve) => {
    const none = { ncpu: 0, memBytes: 0 };
    const child = spawn('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => resolve(none));
    child.on('close', (code) => {
      const [ncpu, memBytes] = out.trim().split(/\s+/).map(Number);
      resolve(code === 0 && ncpu > 0 && memBytes > 0 ? { ncpu, memBytes } : none);
    });
  });
}

/** The compose project of shard `index`: one per shard, so each has its own volumes and network and `down -v` removes exactly its own. */
export const dbShardProject = (index) => `ythril-db-shard-${index}`;

/** Run `docker compose` for one shard; resolves with its output, rejects with it when it exits non-zero. */
function compose(index, args) {
  const env = { ...process.env, YTHRIL_TEST_DB_SHARD_PORT: String(dbShardPort(index)) };
  const argv = ['compose', '-p', dbShardProject(index), ...COMPOSE_FILES.flatMap(f => ['-f', f]), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out)
      : reject(new Error(`docker ${argv.slice(0, 4).join(' ')} … ${args.join(' ')} exited ${code}\n${out.trim()}`))));
  });
}

/** Remove shard `index`'s container and volumes. Never throws: there may be nothing to remove, and cleanup must not hide a run's own failure. */
async function removeShard(index) {
  try { await compose(index, ['down', '--volumes', '--remove-orphans', '--timeout', '5']); } catch { /* nothing there, or already gone */ }
}

/**
 * Start `count` shard Mongos together and wait until every one is healthy.
 * @returns {Promise<Array<{ index: number, port: number }>>}
 */
export async function startDbShards(count) {
  const indexes = Array.from({ length: count }, (_, i) => i);
  await Promise.all(indexes.map(removeShard));
  const started = await Promise.allSettled(indexes.map(i =>
    compose(i, ['up', '--detach', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS), '--no-build', SERVICE])));
  const failed = started.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'rejected');
  if (failed.length > 0) {
    await stopDbShards(indexes.map(index => ({ index })));
    throw new Error(`db shard(s) ${failed.map(f => f.i).join(', ')} did not start:\n${failed.map(f => f.r.reason.message).join('\n')}`);
  }
  return indexes.map(index => ({ index, port: dbShardPort(index) }));
}

/** Remove every shard in `shards` (containers and volumes). Safe to call twice, and with shards that never started. */
export async function stopDbShards(shards) {
  await Promise.all(shards.map(s => removeShard(s.index)));
}
