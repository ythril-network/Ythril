/**
 * The own database of a single `-db` file, on real containers: it starts under a name the start makes, Docker picks and reports
 * its port, the port accepts a connection, a second start of the same label is a second database that leaves the first alone,
 * `own-list` shows both, and each `own-down` removes exactly its own.
 *
 * ## What it proves that the offline file cannot
 *
 * `a-single-database-file-gets-a-database-of-its-own.test.js` holds the module's rules over a fake `docker`. This file holds
 * what the fake cannot say: that Docker picks and reports the port when the variable is 0, that `down` works with the
 * placeholder port, that the label filter finds the containers, and that two projects of the same compose files side by side
 * do not touch each other.
 *
 * ## Why it cannot reach the real stack or a shard
 *
 * The labels it uses carry a scratch word and the process id, and the names the start makes begin with `ythril-db-own-`, which
 * is neither the stack's project nor a shard's; the always-registered part holds that. It removes what it started in every
 * case, by the names the starts printed.
 *
 * ## Opt-in, never skipped
 *
 * It starts two Mongos, so it is registered only when `YTHRIL_TEST_OWN_DB_DOCKER=1`. Absent, not skipped: a skipped test is
 * refused by the CI aggregator. The always-registered part is the guard that its names stay away from the real projects.
 *
 * Run: YTHRIL_TEST_OWN_DB_DOCKER=1 node --test testing/standalone/an-own-database-starts-and-goes-docker.test.js
 * (books Docker memory on a machine with a booking tool: about 6 GB, several minutes).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { DEFAULT_PROJECTS } from '../_init/stack-down.mjs';
import { TEST_STACK_PROJECT } from '../_init/container-state.mjs';
import { dbOwnProject, dbShardProject, listOwnDbs, ownDbName, startOwnDb, stopOwnDb } from '../_init/db-shard-stack.mjs';
import { DB_SHARDS_MAX } from '../_shared/db-shard-plan.mjs';

export const OPT_IN = 'YTHRIL_TEST_OWN_DB_DOCKER';

/** The label of this file's scratch databases: unique to this process, so a leftover of another run is never taken for ours. */
export const scratchLabel = (stamp = `${process.pid}`) => `scratch-owndb-${stamp}`;

/** The projects a stack of this repository can run under: the stack's own and every shard's. */
const realProjects = () => [...DEFAULT_PROJECTS, TEST_STACK_PROJECT, ...Array.from({ length: DB_SHARDS_MAX }, (_, i) => dbShardProject(i))];

describe('the Docker test of the own database stays away from the real projects', () => {
  it('its scratch names are the start\'s own shape and are not a project of the stack or of a shard', () => {
    const project = dbOwnProject(ownDbName(scratchLabel()));
    assert.ok(!realProjects().includes(project), `${project} is a real project`);
    assert.match(project, /^ythril-db-own-scratch-owndb-\d+-[0-9a-f]{8}$/);
  });

  it('two scratch labels of different processes are different', () => {
    assert.notEqual(scratchLabel('1'), scratchLabel('2'));
  });
});

/** `docker <args>`, an argument array and no shell, a timeout; `{ status, stdout, stderr }`. */
function docker(args, timeout = 120_000) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout, windowsHide: true });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

/** The containers of one compose project, in any state. */
const containersOf = (project) => docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).stdout.split('\n').filter(Boolean);

/** The networks of one compose project: `down` removes them with the containers, and a project left with one is a leftover. */
const networksOf = (project) => docker(['network', 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']).stdout.split('\n').filter(Boolean);

/** Does `port` on loopback accept a connection within `timeoutMs`? */
const accepts = (port, timeoutMs = 10_000) => new Promise((resolve) => {
  const socket = net.connect(port, '127.0.0.1');
  const done = (ok) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
  const timer = setTimeout(() => done(false), timeoutMs);
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

if (process.env[OPT_IN] === '1') {
  describe('live: two own databases of one label, side by side', () => {
    const started = [];
    const label = scratchLabel();
    after(async () => {
      for (const s of started) {
        try { await stopOwnDb(s.name); } catch { /* already removed by the test */ }
      }
    });

    it('a start prints a name and a port, and the port accepts a connection', { timeout: 600_000 }, async () => {
      assert.equal(docker(['info', '--format', '{{.ServerVersion}}']).status, 0, 'the Docker engine does not answer');
      const first = await startOwnDb({ label });
      started.push(first);
      assert.match(first.name, new RegExp(`^${label}-[0-9a-f]{8}$`));
      assert.ok(Number.isInteger(first.port) && first.port > 0 && first.port < 65536, `port ${first.port}`);
      assert.ok(!realProjects().includes(first.project));
      assert.ok(await accepts(first.port), `port ${first.port} accepts no connection`);
    });

    it('a second start of the same label is a second database on another port, and the first is untouched', { timeout: 600_000 }, async () => {
      const [first] = started;
      assert.ok(first, 'the first start did not run');
      const second = await startOwnDb({ label });
      started.push(second);
      assert.notEqual(second.name, first.name);
      assert.notEqual(second.project, first.project);
      assert.notEqual(second.port, first.port);
      assert.ok(await accepts(first.port), 'the first database stopped answering');
      assert.ok(await accepts(second.port), 'the second database does not answer');
    });

    it('`own-list` shows both, with the ports they were started on', { timeout: 120_000 }, async () => {
      const listed = await listOwnDbs();
      for (const s of started) {
        const row = listed.find(d => d.name === s.name);
        assert.ok(row, `${s.name} is not listed: ${listed.map(d => d.name).join(', ')}`);
        assert.equal(row.port, s.port);
        assert.equal(row.state, 'running');
      }
    });

    it('each `own-down` removes exactly its own, and nothing of the two is left', { timeout: 300_000 }, async () => {
      const [first, second] = started;
      // Asked BEFORE the first take-down: a lookup that finds no network of a running database would make "its network is gone" below pass about nothing.
      assert.ok(networksOf(first.project).length > 0 && networksOf(second.project).length > 0, 'a started database has no network of its project');
      await stopOwnDb(first.name);
      assert.deepEqual(containersOf(first.project), [], 'the first database is still there');
      assert.deepEqual(networksOf(first.project), [], 'the first database left its network');
      assert.ok(networksOf(second.project).length > 0, 'removing the first removed the second\'s network');
      assert.ok(containersOf(second.project).length > 0, 'removing the first removed the second');
      assert.ok(await accepts(second.port), 'the second database stopped answering');
      await stopOwnDb(second.name);
      for (const s of started) {
        assert.deepEqual(containersOf(s.project), [], `${s.name} is still there`);
        assert.deepEqual(networksOf(s.project), [], `${s.name} left its network`);
      }
      const left = (await listOwnDbs()).filter(d => started.some(s => s.name === d.name));
      assert.deepEqual(left, []);
    });
  });
}
