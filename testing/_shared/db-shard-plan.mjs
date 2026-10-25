/**
 * Which harness Mongo a database-backed standalone file runs against, when the `-db` third is spread over several (Q-623).
 *
 * ## Why the third is sharded
 *
 * The 430 `-db` files shared ONE `ythril-mongo-a`, held to one CPU. Run alone on a fresh container the third took
 * 1 180 s on the owner's machine (24 cores, a Docker VM of 16 CPUs and 15.6 GiB), five `node --test` batches one after the
 * other, each with its own tail where one slow file kept the batch open: the width of four was chosen for that one
 * Mongo (`DB_TEST_CONCURRENCY`, with its measurements), and the Mongo, not the machine, was the limit. A long run also
 * ends on a Mongo carrying everything the run wrote (mongot at its heap limit, stale `$listSearchIndexes` operations),
 * which is how a failure repeated until the container was restarted. Several fresh Mongos, each carrying a part of the
 * files, remove both.
 *
 * ## What this module answers, and only that
 *
 * One question: *which shard is this file on, where does that shard listen, and in what order does it start its files.*
 * It starts nothing (`_init/db-shard-stack.mjs` does) and lists no files (the runner hands it the names); the one file it
 * reads is the table of slow files' seconds, which only orders.
 *
 * ## What it prevents
 *
 *  - **A file that moves shard when another is added.** The shard is a pure function of the file's NAME and the count,
 *    never of its position in a list, so adding a file changes nothing for the others (a run's results stay comparable
 *    to the last) and the same file lands on the same Mongo on every machine that has the same count.
 *  - **A shard that holds no file, or a file in two shards.** `planDbShards` returns a partition and says so by
 *    throwing when it is not one: a file in no shard would be a test that never ran, and a file in two would open its
 *    harness database twice, concurrently, on two Mongos, each dropping what it thinks is its own.
 *  - **Two shards that listen on one port.** The ports are `DB_SHARD_BASE_PORT + index`, and the base is chosen clear of
 *    the stack's own (27117 for `ythril-mongo-a`; the other instances publish none).
 *
 * `a-db-shards-keep-a-harness-database-on-one-mongo.test.js` holds all three against the real file list.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** First port of the shard Mongos: `DB_SHARD_BASE_PORT + index`. Clear of 27117 (`ythril-mongo-a`) on purpose. */
export const DB_SHARD_BASE_PORT = 27400;

/** The most shards the plan will make: ports are not unbounded, and past this the Docker VM has no room for another Mongo. */
export const DB_SHARDS_MAX = 8;

/** The most shards chosen when nobody says: the count the measurement below stopped at, not the most the plan allows. */
export const DB_SHARDS_DEFAULT_MAX = 4;

/** What one shard Mongo is held to (`YTHRIL_TEST_MONGO_A_MEM`'s default, 3 GiB) and what the rest of the Docker VM keeps (the app, its own Mongo, the sidecars). */
const SHARD_MEM_GIB = 3;
const VM_RESERVE_GIB = 2;
/** One CPU per shard (`YTHRIL_TEST_MONGO_CPUS`'s default) and as many again for the test processes that talk to it. */
const SHARD_CPUS = 4;

/**
 * How many shards a Docker VM has room for, when `YTHRIL_TEST_DB_SHARDS` is not set: the smaller of what its CPUs and its
 * memory carry, between 1 and `DB_SHARDS_DEFAULT_MAX`. Below two Mongos' worth it is 1, which is the one `ythril-mongo-a` at
 * `YTHRIL_TEST_MONGO_PORT` that CI's database job starts and that every run used before the third was sharded.
 *
 * Measured on this machine (24 cores; a Docker VM of 16 CPUs and 15.6 GiB), the whole `-db` third, same files, same verdicts:
 * one Mongo 1 179 s (a fresh container, width 4); then 4 shards 419 s, and with the 60 s restore-family waits ended
 * (`closeTestMongo`) and the slowest files started first 340 s; 3 shards 401 s. A shard peaks at 1.6 to 2.5 GiB and 1.0 CPU
 * at its busiest, which is where the 3 GiB and 4 CPUs per shard above come from.
 */
export function defaultDbShardCount({ ncpu, memBytes }) {
  const byCpu = Math.floor(ncpu / SHARD_CPUS);
  const byMem = Math.floor((memBytes / 2 ** 30 - VM_RESERVE_GIB) / SHARD_MEM_GIB);
  return Math.max(1, Math.min(byCpu, byMem, DB_SHARDS_DEFAULT_MAX));
}

/** The shard (0-based) a file runs on: a pure function of its name and the count. */
export function dbShardOf(file, count) {
  if (!Number.isInteger(count) || count < 1 || count > DB_SHARDS_MAX) {
    throw new Error(`dbShardOf: ${count} shards is not a count between 1 and ${DB_SHARDS_MAX}`);
  }
  return createHash('sha1').update(file).digest().readUInt32BE(0) % count;
}

/** The port shard `index` listens on, on the loopback interface. */
export function dbShardPort(index) {
  if (!Number.isInteger(index) || index < 0 || index >= DB_SHARDS_MAX) {
    throw new Error(`dbShardPort: shard ${index} is not between 0 and ${DB_SHARDS_MAX - 1}`);
  }
  return DB_SHARD_BASE_PORT + index;
}

/** `db-file-weights.json`: the seconds each SLOW `-db` file took in a measured run (`_init/record-db-file-weights.mjs` writes it). */
export const DB_FILE_WEIGHTS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'db-file-weights.json');

/** A file is "slow" for the table from this many seconds: the ones whose late start leaves a shard with one busy slot. */
export const SLOW_SECONDS = 15;

/** The recorded seconds by file name; `{}` when the table is not there (a plan without weights is still a plan, only slower). */
export function loadDbFileWeights(path = DB_FILE_WEIGHTS_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')).seconds ?? {}; } catch { return {}; }
}

/**
 * The files in the order a shard should START them: the recorded slowest first, the rest in the order given.
 *
 * Why: a runner starts files in order at a fixed width, so a 230 s file that sorts late starts late and ends the run alone,
 * every other slot idle. The order changes nothing a file asserts (files share nothing; that is what the unique harness
 * names are for), only when it starts. A file with no recorded weight is not slow as far as anyone knows and keeps its place.
 */
export function heaviestFirst(files, seconds = loadDbFileWeights()) {
  const weight = (f) => seconds[f] ?? 0;
  return files.map((f, i) => ({ f, i })).sort((a, b) => weight(b.f) - weight(a.f) || a.i - b.i).map(x => x.f);
}

/** How many fast files share one `node --test` unit: few enough that no unit is a long serial tail, many enough that the unit count (and the results files, one per unit) stays small. */
export const FAST_UNIT_FILES = 10;

/**
 * A shard's files cut into the units its workers pull, in start order: each recorded-slow file ALONE, heaviest first, then
 * the rest in chunks of `FAST_UNIT_FILES`.
 *
 * Why units and not one `node --test` over the shard: `node --test` SORTS the files it is given before it starts them
 * (probed on Node 24: `d b c a` run as `a b c d`), so no argument order can start a slow file first, and a 230 s file that
 * sorts late ended the run alone with every other slot idle. A worker that pulls the next unit when it finishes
 * one starts the slow files at once and keeps every slot busy to the end. A unit is the whole of its files: it is a
 * partition of the input (`unitsOf` throws when it is not), so cutting changes when a file starts, never whether it runs.
 */
export function unitsOf(files, seconds = loadDbFileWeights()) {
  const ordered = heaviestFirst(files, seconds);
  const slow = ordered.filter(f => (seconds[f] ?? 0) > 0);
  const fast = ordered.filter(f => !((seconds[f] ?? 0) > 0));
  const units = slow.map(f => [f]);
  for (let i = 0; i < fast.length; i += FAST_UNIT_FILES) units.push(fast.slice(i, i + FAST_UNIT_FILES));
  if (units.flat().length !== files.length || new Set(units.flat()).size !== files.length) {
    throw new Error('unitsOf: the units are not a partition of the files');
  }
  return units;
}

/**
 * The files of each shard, by file name as `splitStandalone` lists them.
 *
 * It THROWS when the result is not a partition of the input (a file missing, repeated or in a shard that does not
 * exist), and when a shard is left with no file: an empty shard is a Mongo started to run nothing, and says the count was
 * larger than the work.
 *
 * @param {string[]} files
 * @param {number} count
 * @param {Record<string, number>} [seconds] recorded seconds of the slow files (`loadDbFileWeights`)
 * @returns {string[][]} `count` lists, each in the order its shard should start them (`heaviestFirst`)
 */
export function planDbShards(files, count, seconds = loadDbFileWeights()) {
  const shards = Array.from({ length: count }, () => []);
  for (const f of files) shards[dbShardOf(f, count)].push(f);
  shards.forEach((s, i) => { shards[i] = heaviestFirst(s, seconds); });
  const placed = shards.flat();
  if (placed.length !== files.length || new Set(placed).size !== new Set(files).size || new Set(files).size !== files.length) {
    throw new Error('planDbShards: the shards are not a partition of the files (a file is missing or listed twice)');
  }
  const empty = shards.map((s, i) => (s.length === 0 ? i : -1)).filter(i => i >= 0);
  if (empty.length > 0) {
    throw new Error(`planDbShards: shard(s) ${empty.join(', ')} hold no file out of ${files.length} — the count is larger than the work`);
  }
  return shards;
}
