/**
 * The `-db` third is spread over several Mongos, and a harness database stays on ONE of them (Q-623).
 *
 * ## What sharding could break, and what holds it
 *
 * The 430 database-backed files were run against one `ythril-mongo-a`; they now run against up to
 * `DB_SHARDS_MAX` fresh Mongos at once (`testing/_shared/db-shard-plan.mjs`, started by `testing/_init/db-shard-stack.mjs`). Four
 * things would go wrong without anyone noticing, and each is asserted here against the REAL file list, never a list kept
 * for the test:
 *
 *  - **A file that runs on no shard, or on two.** The shards must be a partition of the database-backed files for every
 *    count the plan allows: a file in none is a test that never ran, in two it opens its harness database on two Mongos.
 *  - **A shard that moves when the file list changes.** The shard is a function of the file's name and the count alone, so
 *    adding or removing a file changes nothing for any other.
 *  - **Two files on one database, hidden by the split.** `openTestMongo` drops its database on entry and exit, so two files
 *    that claim one name wipe each other when they share a Mongo: the single-Mongo run (CI's database job, preflight) and
 *    two files that happen to hash together. Sharding hides the clash on a run that separates them and shows it on the next
 *    that does not, which is the failure an intermittent one is made of. The claims are the harness's own spellings
 *    (`_harness-names.mjs`: `openTestMongo`, the wrappers' `suite:`) AND every `ythril_harness_<name>` a file spells out to
 *    reach its database through the driver.
 *  - **A slow-file table that names a file that is gone**, or a unit plan that drops a file while ordering the rest.
 *
 * Also held: every shard port is distinct and is not the stack's own (27117); the compose override changes nothing but the
 * container's name, port and storage, so the shard Mongo stays `ythril-mongo-a`'s definition; and the runner pins each shard's
 * children to its Mongo through the one variable the harness reads.
 *
 * Run: node --test testing/standalone/a-db-shards-keep-a-harness-database-on-one-mongo.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitStandalone } from '../_shared/standalone-split.mjs';
import {
  DB_SHARD_BASE_PORT, DB_SHARDS_MAX, FAST_UNIT_FILES, dbShardOf, dbShardPort, defaultDbShardCount,
  heaviestFirst, loadDbFileWeights, planDbShards, unitsOf,
} from '../_shared/db-shard-plan.mjs';
import { harnessDatabaseClaims } from './_harness-names.mjs';
import { stripComments } from './_strip-comments.mjs';

const { offlineDb } = splitStandalone();
const counts = Array.from({ length: DB_SHARDS_MAX }, (_, i) => i + 1);

/** Names claimed by more than one file in `claims`, as `name: fileA, fileB`. */
function clashes(claims) {
  const byName = new Map();
  for (const { file, name } of claims) byName.set(name, new Set([...(byName.get(name) ?? []), file]));
  return [...byName].filter(([, files]) => files.size > 1).map(([name, files]) => `${name}: ${[...files].join(', ')}`);
}

describe('the -db shards keep a harness database on one Mongo', () => {
  it('has database-backed files to plan, so an empty list cannot pass', () => {
    assert.ok(offlineDb.length >= 30, `only ${offlineDb.length} database-backed file(s) found — the split is broken, not the plan`);
  });

  it('the shards are a partition of the database-backed files for every count, with no empty shard', () => {
    for (const count of counts) {
      const shards = planDbShards(offlineDb, count);
      assert.equal(shards.length, count);
      assert.deepEqual(shards.flat().sort(), [...offlineDb].sort(), `${count} shards do not hold every file exactly once`);
      assert.ok(shards.every(s => s.length > 0), `${count} shards leave one with no file`);
    }
  });

  it('a file stays on its shard when any other file is added or removed', () => {
    for (const count of [2, 3, 4]) {
      const before = new Map(offlineDb.map(f => [f, dbShardOf(f, count)]));
      for (const gone of [offlineDb[0], offlineDb[Math.floor(offlineDb.length / 2)], offlineDb.at(-1)]) {
        const rest = planDbShards(offlineDb.filter(f => f !== gone), count);
        rest.forEach((files, shard) => files.forEach(f => assert.equal(shard, before.get(f), `${f} moved when ${gone} left`)));
      }
    }
  });

  it('refuses a plan that is not a partition, and a count it cannot serve', () => {
    assert.throws(() => planDbShards(['a.test.js', 'a.test.js'], 1), /not a partition/);
    assert.throws(() => planDbShards(['only-one.test.js'], 2), /hold no file/);
    assert.throws(() => dbShardOf('x.test.js', 0), /shards is not a count/);
    assert.throws(() => dbShardOf('x.test.js', DB_SHARDS_MAX + 1), /shards is not a count/);
  });

  it('no two database-backed files claim one harness database, so no shard split can hide a clash', () => {
    const dbFiles = new Set(offlineDb.map(f => `testing/standalone/${f}`));
    const claims = harnessDatabaseClaims().filter(c => dbFiles.has(c.file));
    assert.ok(claims.length >= 30, `only ${claims.length} claim(s) found among the database-backed files — the sweep is broken`);
    assert.deepEqual(clashes(claims), [],
      'these database-backed files claim one harness database. On one Mongo each drops the other\'s data mid-assertion; across '
      + 'shards it only fails when the two land together. Give each file its own name.');
  });

  it('the clash check fires on a clash, and not on one file spelling its own name twice', () => {
    assert.deepEqual(clashes([{ file: 'a', name: 'x' }, { file: 'b', name: 'x' }]), ['x: a, b']);
    assert.deepEqual(clashes([{ file: 'a', name: 'x' }, { file: 'a', name: 'x' }, { file: 'b', name: 'y' }]), []);
  });

  it('every file in the slow-file table exists among the database-backed files', () => {
    const seconds = loadDbFileWeights();
    assert.ok(Object.keys(seconds).length >= 5, 'the slow-file table is empty or missing — regenerate it with testing/_init/record-db-file-weights.mjs');
    const known = new Set(offlineDb);
    assert.deepEqual(Object.keys(seconds).filter(f => !known.has(f)), [],
      'these files are in db-file-weights.json and are not database-backed files any more: regenerate the table');
  });

  it('the units are a partition that starts the slowest files first and alone', () => {
    const seconds = loadDbFileWeights();
    const files = planDbShards(offlineDb, 3)[0];
    const units = unitsOf(files, seconds);
    assert.deepEqual(units.flat().sort(), [...files].sort(), 'the units drop or repeat a file');
    const slow = files.filter(f => (seconds[f] ?? 0) > 0);
    assert.deepEqual(units.slice(0, slow.length).flat(), heaviestFirst(slow, seconds), 'the slow files do not come first, one to a unit, slowest first');
    assert.ok(units.slice(slow.length).every(u => u.length <= FAST_UNIT_FILES), 'a unit of fast files is longer than FAST_UNIT_FILES');
    assert.deepEqual(unitsOf(['a.test.js', 'b.test.js'], { 'b.test.js': 30 }), [['b.test.js'], ['a.test.js']]);
  });

  it('every shard has its own port, none of them the stack\'s', () => {
    const ports = counts.map((_, i) => dbShardPort(i));
    assert.equal(new Set(ports).size, ports.length, 'two shards share a port');
    assert.ok(ports.every(p => p >= DB_SHARD_BASE_PORT && p <= 65535 && p !== 27117), 'a shard port is out of range or is ythril-mongo-a\'s');
    assert.throws(() => dbShardPort(DB_SHARDS_MAX), /not between/);
  });

  it('the default count follows the Docker VM: one on a CI-shaped host, four on a roomy one, never above the default maximum', () => {
    const GiB = 2 ** 30;
    assert.equal(defaultDbShardCount({ ncpu: 4, memBytes: 15.6 * GiB }), 1);
    assert.equal(defaultDbShardCount({ ncpu: 16, memBytes: 15.6 * GiB }), 4);
    assert.equal(defaultDbShardCount({ ncpu: 16, memBytes: 8 * GiB }), 2);
    assert.equal(defaultDbShardCount({ ncpu: 64, memBytes: 256 * GiB }), 4);
    assert.equal(defaultDbShardCount({ ncpu: 0, memBytes: 0 }), 1, 'a Docker that does not answer is the one-Mongo path');
  });

  it('the compose override changes the container\'s name, port and storage and nothing else', () => {
    const text = stripComments(readFileSync('testing/docker-compose.db-shard.yml', 'utf8'));
    const lines = text.split('\n').filter(l => l.trim() !== '' && !l.trim().startsWith('#'));
    const services = lines.filter(l => /^ {2}[\w-]+:/.test(l)).map(l => l.trim().replace(/:.*/, ''));
    assert.deepEqual(services, ['ythril-mongo-a'], 'the override defines a service other than the harness Mongo');
    const keys = lines.filter(l => /^ {4}[\w-]+:/.test(l)).map(l => l.trim().replace(/:.*/, ''));
    assert.deepEqual(keys.sort(), ['container_name', 'ports', 'tmpfs', 'volumes'],
      'the override sets something besides the name, the port and the storage: that is a second definition of the harness Mongo');
  });

  it('the runner pins each shard\'s children to that shard\'s Mongo through the variable the harness reads', () => {
    const src = stripComments(readFileSync('testing/_init/run-standalone.mjs', 'utf8'));
    // A shard child gets the port it is handed, and the sharded run hands each shard its own. A one-shard CI job hands none and
    // keeps the Mongo the environment already names.
    assert.match(src, /YTHRIL_TEST_MONGO_PORT:\s*String\(port\)/, 'a shard child is not given the port its shard was handed');
    assert.match(src, /runShardUnits\(files,\s*i,\s*width,\s*dbShardPort\(i\)/, 'a shard is not handed its own shard\'s port');
    const addr = readFileSync('testing/_shared/test-mongo-address.mjs', 'utf8');
    assert.match(addr, /YTHRIL_TEST_MONGO_PORT/, 'the harness no longer reads the variable the runner sets');
  });
});
