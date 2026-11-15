/**
 * CI's database shard job gives its one database at least twice the test stack's default memory ceiling, and reports the peak it reached on every run.
 *
 * ## What it prevents
 *
 * The test stack's ceiling for `ythril-mongo-a` is sized so four databases and four instances fit one machine. A database
 * shard job of CI starts ONE database on a runner of its own and inherited that ceiling. In shard 2 of Full run 43772201689
 * (2026-11-15) the kernel killed mongod inside the container's memory group (`Memory cgroup out of memory: Killed process
 * (mongod)`, 1.96 GB held beside the search process's heap, ceiling 3072m), and every later file of the shard was refused
 * with "needs the test MongoDB". Nothing had said how near the ceiling the shards run: a green shard printed no figure.
 *
 *  - **The job starts the database at the stack's default**: the ceiling that was reached.
 *  - **The peak is not reported, or only when the job failed, or before the tests ran**: the next shard that nears its
 *    ceiling is green and silent until the kernel kills it.
 *
 * ## How it is written
 *
 * `roomProblems(workflow, compose)` reads the PARSED workflow and compose file. The job is the one whose steps run
 * `test:standalone:db`; the knob's name and the default are what the compose file's `mem_limit` says, never a literal here.
 * The same function runs over a conforming miniature and single breakages of it, so each rule is seen to fire.
 *
 * ## Seen red
 *
 * On 4d5e7c23 (before the change): `the database shard job starts ythril-mongo-a at the test stack's default ceiling
 * (3072 MiB): YTHRIL_TEST_MONGO_A_MEM is not set where the database is started` and `no step after the tests reports the
 * database's peak memory on every run`.
 *
 * Run: node --test testing/standalone/ci-gives-the-db-shard-database-the-runner-s-room.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadCi, parseWorkflow, stepsOf, shellOf, expressionOf, DB_SHARD_SCRIPT as DB_SCRIPT, jobRunning, stepEnv } from '../_shared/ci-workflow.mjs';
import { loadCompose, memoryMiB } from '../_shared/compose-file.mjs';
import { upCommands } from '../_shared/compose-start-sets.mjs';

const DB_SERVICE = 'ythril-mongo-a';
const COMPOSE_FILE = 'testing/docker-compose.test.yml';
/** How many times the stack's default the job's one database gets: the job has the runner to itself. */
const ROOM_FACTOR = 2;

/** The knob and the default the compose file gives the database's ceiling: `${NAME:-default}`. Throws when it is written another way. */
function ceilingOf(compose) {
  const raw = String(compose.services?.[DB_SERVICE]?.mem_limit ?? '');
  const m = /^\$\{([A-Z0-9_]+):-([^}]+)\}$/.exec(raw.trim());
  if (!m) throw new Error(`${DB_SERVICE}'s mem_limit (${raw || 'absent'}) is not one \${NAME:-default}: this rule cannot read the knob`);
  return { knob: m[1], defaultMiB: memoryMiB(m[2]) };
}

/** Every way the workflow fails the rule, as sentences; none means it holds. */
function roomProblems(workflow, compose) {
  const { knob, defaultMiB } = ceilingOf(compose);
  const { job } = jobRunning(workflow, DB_SCRIPT);
  const steps = stepsOf(job);
  const problems = [];

  const starts = steps.filter(s => upCommands(shellOf(s)).some(up => up.services.includes(DB_SERVICE)));
  if (starts.length !== 1) return [`${starts.length} step(s) of the database shard job start ${DB_SERVICE}: exactly one is the subject of this rule`];
  const value = stepEnv(job, starts[0], knob);
  if (value === undefined) {
    problems.push(`the database shard job starts ${DB_SERVICE} at the test stack's default ceiling (${defaultMiB} MiB): ${knob} is not set where the database is started`);
  } else if (memoryMiB(value) < ROOM_FACTOR * defaultMiB) {
    problems.push(`the database shard job gives ${DB_SERVICE} ${memoryMiB(value)} MiB: under ${ROOM_FACTOR} times the test stack's default (${defaultMiB} MiB)`);
  }

  const testAt = steps.findIndex(s => shellOf(s).includes(DB_SCRIPT));
  const reports = steps.filter((s, i) => i > testAt
    && expressionOf(s.if) === 'always()'
    && /docker exec\s+ythril-mongo-a\s+cat\s+\S*memory\.peak/.test(shellOf(s))
    && /docker exec\s+ythril-mongo-a\s+cat\s+\S*memory\.max/.test(shellOf(s))
    && shellOf(s).includes('::warning::'));
  if (reports.length === 0) problems.push('no step after the tests reports the database\'s peak memory on every run (if: always(), reading memory.peak and memory.max of the container, with a warning line)');
  return problems;
}

const COMPOSE = { services: { [DB_SERVICE]: { mem_limit: '${YTHRIL_TEST_MONGO_A_MEM:-3072m}' } } };
const START = 'docker compose -p ythril-test -f testing/docker-compose.test.yml up -d --wait ythril-mongo-a';
const REPORT = 'peak=$(docker exec ythril-mongo-a cat /sys/fs/cgroup/memory.peak)\nmax=$(docker exec ythril-mongo-a cat /sys/fs/cgroup/memory.max)\necho "::warning::near the ceiling"';
/** A conforming miniature of the job, built from parts so a breakage changes exactly one of them. */
function miniature({ mem = '6144m', reportIf = 'always()', report = REPORT, reportFirst = false } = {}) {
  const start = { name: 'Start the database', run: START, ...(mem === null ? {} : { env: { YTHRIL_TEST_MONGO_A_MEM: mem } }) };
  const tests = { name: 'Tests', run: `npm run ${DB_SCRIPT}` };
  const reportStep = { name: 'Report', ...(reportIf === null ? {} : { if: reportIf }), run: report };
  const steps = reportFirst ? [start, reportStep, tests] : [start, tests, reportStep];
  return parseWorkflow(JSON.stringify({ on: { push: {} }, jobs: { 'standalone-db': { 'runs-on': 'ubuntu-latest', steps } } }), 'miniature');
}

describe('the database shard job gives its database the runner\'s room', () => {
  it('holds of the real ci.yml and the real test compose file', () => {
    assert.deepEqual(roomProblems(loadCi(), loadCompose(COMPOSE_FILE)), []);
  });

  it('the real compose file\'s ceiling is one knob with a default this rule can read', () => {
    const { knob, defaultMiB } = ceilingOf(loadCompose(COMPOSE_FILE));
    assert.match(knob, /^YTHRIL_TEST_/);
    assert.ok(defaultMiB >= 1024, `the default ceiling reads as ${defaultMiB} MiB`);
  });

  it('the conforming miniature passes', () => {
    assert.deepEqual(roomProblems(miniature(), COMPOSE), []);
  });

  for (const [what, opts, expected] of [
    ['the database is started without the knob', { mem: null }, /default ceiling \(3072 MiB\)/],
    ['the knob is set to the default', { mem: '3072m' }, /gives ythril-mongo-a 3072 MiB/],
    ['the knob is set under twice the default, in another unit', { mem: '5g' }, /gives ythril-mongo-a 5120 MiB/],
    ['the report runs only on success', { reportIf: null }, /no step after the tests reports/],
    ['the report runs only on failure', { reportIf: 'failure()' }, /no step after the tests reports/],
    ['the report runs before the tests', { reportFirst: true }, /no step after the tests reports/],
    ['the report reads no ceiling', { report: REPORT.replace('memory.max', 'memory.high') }, /no step after the tests reports/],
    ['the report warns nobody', { report: REPORT.replace('::warning::', '') }, /no step after the tests reports/],
  ]) {
    it(`red: ${what}`, () => {
      const problems = roomProblems(miniature(opts), COMPOSE);
      assert.equal(problems.length, 1, problems.join('; '));
      assert.match(problems[0], expected);
    });
  }

  it('twice the default exactly is enough, in either unit', () => {
    assert.deepEqual(roomProblems(miniature({ mem: '6g' }), COMPOSE), []);
    assert.deepEqual(roomProblems(miniature({ mem: '6144m' }), COMPOSE), []);
  });
});
