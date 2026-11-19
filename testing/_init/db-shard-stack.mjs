/**
 * Start and remove the harness Mongos of a `-db` run: one fresh `ythril-mongo-a` per shard of a sharded run (Q-623), and one
 * of its own for a session that runs a single database file (Q-932), each in a compose project of its own, gone when the
 * run ends.
 *
 * ## What it answers
 *
 * Two questions, both about a Mongo that belongs to one run and to nobody else:
 *
 *  - *give me N healthy harness Mongos, and take them away again* (`startDbShards`, `stopDbShards`; `up`, `down`);
 *  - *give me ONE harness Mongo of my own, tell me its name and where it listens, and take exactly it away*
 *    (`startOwnDb`, `stopOwnDb`, `listOwnDbs`; `own-up`, `own-down`, `own-list`).
 *
 * Which file runs where is `_shared/db-shard-plan.mjs`'s; how the files are run is the runner's.
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
 *  - **A single file that holds the stack's database.** A session running one `-db` file against the stack's Mongo (port
 *    27117) kept everyone else from starting or taking down the stack, and two sessions on it dropped each other's data.
 *    An own database is a compose project of its own, named by the START (the caller's label and eight random hex
 *    characters), so two starts never share a project whatever label they pass; nothing is claimed and nothing is refused
 *    for a label already in use. Docker picks its port, so no port can be taken by another run.
 *  - **A Docker call that never ends.** Every call here has a time limit and is stopped past it (`callDocker`, which takes
 *    no call without one), the shards' calls too.
 *  - **A listing that fails read as "nothing there".** The own databases are listed by `listOwnDbs`, which reads Docker's
 *    JSON lines with the take-down's reader and throws on what it cannot read; a start whose listing failed starts nothing,
 *    and a take-down whose listing failed removes nothing.
 *  - **A failed or interrupted start that leaves its Mongo behind.** It prints why the container stopped (`reportContainerState`),
 *    then removes only the project it made, and a removal that fails too is named with the command that removes it by hand.
 *  - **A compose call without the port variable.** `docker-compose.db-shard.yml` refuses to run without
 *    `YTHRIL_TEST_DB_SHARD_PORT`, take-down included; the project and its port travel together in one target, so a caller
 *    cannot name a project and forget the port.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../../scripts/_shared/script-cli.mjs';
import { dbShardPort, defaultDbShardCount, DB_SHARDS_MAX } from '../_shared/db-shard-plan.mjs';
import { reportContainerState, within } from './container-state.mjs';
import { parseContainers } from './stack-down.mjs';

const TESTING = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE_FILES = ['docker-compose.test.yml', 'docker-compose.db-shard.yml'].map(f => join(TESTING, f));
const SERVICE = 'ythril-mongo-a';
/** The port the Mongo listens on inside its container. */
const CONTAINER_PORT = 27017;
/** The variable `docker-compose.db-shard.yml` publishes the Mongo's loopback port from; the file refuses to run without it. */
const PORT_VARIABLE = 'YTHRIL_TEST_DB_SHARD_PORT';
/** The label compose puts on a container with its project and its service. */
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const SELF = 'node testing/_init/db-shard-stack.mjs';

/** Seconds `up --wait` gives a shard to become healthy: the base file's own healthcheck window, with room for several booting at once. */
const WAIT_TIMEOUT_SECONDS = 420;
/** Seconds `down` gives a Mongo to stop before it is killed: nothing in it is worth waiting for. */
const STOP_GRACE_SECONDS = 5;
/**
 * Milliseconds `up` has on top of its own wait window. The wait window starts when the container does; the image is pulled
 * BEFORE that (the first sharded run after an image bump pulls it), and a pull of the Mongo image over a slow link takes minutes.
 */
const UP_MARGIN_MS = 600_000;

/**
 * Milliseconds each kind of Docker call has before it is stopped. `up` has the wait window and a margin; the rest are
 * answers Docker gives at once or not at all.
 */
export const DOCKER_LIMITS = Object.freeze({
  list: 30_000,
  ask: 10_000,
  port: 30_000,
  down: 120_000,
  up: WAIT_TIMEOUT_SECONDS * 1000 + UP_MARGIN_MS,
});

/** Milliseconds `docker info` has to tell the Docker VM's size. */
const INFO_LIMIT_MS = 30_000;

/**
 * How many shards, and how many files at a time on each. `YTHRIL_TEST_DB_SHARDS` (1 to the plan's maximum; 1 is the one
 * Mongo at `YTHRIL_TEST_MONGO_PORT`, as before) and `YTHRIL_TEST_DB_SHARD_WIDTH` override; a value that is not a whole
 * number in range is an error, never a quiet default.
 *
 * With no count given the Docker VM decides it, and a VM that does not answer is refused, not read as room for one: inside
 * a container with no `docker` command the count quietly became 1 and the whole third ran on one Mongo for 40 minutes and
 * more, with nothing in the log saying so (Q-731). `YTHRIL_TEST_DB_SHARDS_STARTED=1` says the shards were started outside
 * this process (`node testing/_init/db-shard-stack.mjs up`, by a container runner's host); it needs a count of two or more.
 * `started` in the answer tells the runner to attach to them (`attachDbShards`) and to leave their removal to their starter.
 */
export async function resolveDbShardConfig({
  defaultWidth, shards = process.env['YTHRIL_TEST_DB_SHARDS'], width = process.env['YTHRIL_TEST_DB_SHARD_WIDTH'],
  started = process.env['YTHRIL_TEST_DB_SHARDS_STARTED'], askVm = dockerVm,
}) {
  const whole = (name, raw, max) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name}=${raw} is not a whole number from 1 to ${max}`);
    return n;
  };
  const set = (raw) => raw !== undefined && raw !== '';
  if (set(started) && started !== '1') throw new Error(`YTHRIL_TEST_DB_SHARDS_STARTED=${started}: set it to 1, or leave it unset`);
  const isStarted = set(started);
  const given = set(shards) ? whole('YTHRIL_TEST_DB_SHARDS', shards, DB_SHARDS_MAX) : undefined;
  if (isStarted && !(given >= 2)) {
    throw new Error('YTHRIL_TEST_DB_SHARDS_STARTED=1 needs YTHRIL_TEST_DB_SHARDS set to the count started, two or more');
  }
  let count = given;
  if (count === undefined) {
    const vm = await askVm();
    if (!(vm.ncpu > 0 && vm.memBytes > 0)) {
      throw new Error('docker does not answer here, so this run cannot start its shard MongoDBs. Set YTHRIL_TEST_DB_SHARDS=1 to run '
        + 'on the one MongoDB at YTHRIL_TEST_MONGO_PORT, or start the shards outside (node testing/_init/db-shard-stack.mjs up) '
        + 'and set YTHRIL_TEST_DB_SHARDS to their count with YTHRIL_TEST_DB_SHARDS_STARTED=1');
    }
    count = defaultDbShardCount(vm);
  }
  return {
    count,
    width: set(width) ? whole('YTHRIL_TEST_DB_SHARD_WIDTH', width, 16) : defaultWidth,
    started: isStarted,
  };
}

/** How long a started shard's port has to accept a connection before the run is refused. */
const ATTACH_TIMEOUT_MS = 10_000;

/**
 * Attach to `count` shard Mongos started outside this process: each port must accept a connection, or the run is refused
 * before any file runs, naming every port that did not. Without this a shard nobody can reach makes each of its files skip
 * itself for want of a database, and the run reads green about nothing.
 * @returns {Promise<Array<{ index: number, port: number }>>}
 */
export async function attachDbShards(count, { portOf = dbShardPort, host = '127.0.0.1', timeoutMs = ATTACH_TIMEOUT_MS } = {}) {
  const shards = Array.from({ length: count }, (_, index) => ({ index, port: portOf(index) }));
  const answers = await Promise.all(shards.map(s => new Promise((resolve) => {
    const socket = net.connect(s.port, host);
    const done = (ok, why) => { clearTimeout(timer); socket.destroy(); resolve({ ...s, ok, why }); };
    const timer = setTimeout(() => done(false, `no answer in ${timeoutMs} ms`), timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', (e) => done(false, e.code ?? e.message));
  })));
  const dead = answers.filter(a => !a.ok);
  if (dead.length > 0) {
    throw new Error(`started db shard(s) not reachable: ${dead.map(d => `shard ${d.index} at ${host}:${d.port} (${d.why})`).join(', ')}`);
  }
  return shards;
}

/** The Docker VM's CPUs and memory; `{ ncpu: 0, memBytes: 0 }` when `docker info` does not answer (refused by `resolveDbShardConfig`). */
function dockerVm() {
  return new Promise((resolve) => {
    const none = { ncpu: 0, memBytes: 0 };
    const child = spawn('docker', ['info', '--format', '{{.NCPU}} {{.MemTotal}}'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: INFO_LIMIT_MS, killSignal: 'SIGKILL', windowsHide: true,
    });
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

/**
 * The most own databases there can be at once: as many Mongos as a full sharded run, which is what the Docker VM was sized for.
 * Checked when a start begins, by one listing: two starts begun at the same moment can both pass it.
 */
export const DB_OWN_MAX = DB_SHARDS_MAX;
/** The compose project of an own database begins with this, which is neither a shard's (`ythril-db-shard-`) nor the stack's. */
const OWN_PROJECT_PREFIX = 'ythril-db-own-';
/** The most characters a label has. */
const OWN_LABEL_MAX = 40;
/** The port variable of an own database: 0 makes Docker pick the loopback port, which `compose port` then reports. */
const OWN_PLACEHOLDER_PORT = 0;

const OWN_LABEL = new RegExp(`^[a-z0-9](?:[a-z0-9-]{0,${OWN_LABEL_MAX - 2}}[a-z0-9])?$`);
const RANDOM_PART = /^[0-9a-f]{8}$/;
/** Eight random hex characters: the part of a name that no two starts share. */
const randomPart = () => randomBytes(4).toString('hex');
const OWN_NAME = new RegExp(`^([a-z0-9](?:[a-z0-9-]{0,${OWN_LABEL_MAX - 2}}[a-z0-9])?)-[0-9a-f]{8}$`);

/**
 * The name of an own database: `<label>-<8 hex>`. The label is lower-case letters, digits and hyphens, 1 to 40
 * characters, starting and ending with a letter or digit; anything else throws. The random part is made here, so no caller
 * can reuse one.
 */
export function ownDbName(label, random = randomPart()) {
  if (typeof label !== 'string' || !OWN_LABEL.test(label)) {
    throw new Error(`the label ${JSON.stringify(label)} is not usable: lower-case letters, digits and hyphens, 1 to ${OWN_LABEL_MAX} characters, beginning and ending with a letter or digit`);
  }
  if (!RANDOM_PART.test(random)) throw new Error(`the random part ${JSON.stringify(random)} is not eight hex characters`);
  return `${label}-${random}`;
}

/** The compose project of the own database `name`; throws on a name that is not one's shape, so a project of the stack is never named from here. */
export function dbOwnProject(name) {
  if (typeof name !== 'string' || !OWN_NAME.test(name)) {
    throw new Error(`${JSON.stringify(name)} is not an own database's name (<label>-<8 hex>); \`${SELF} own-list\` shows them`);
  }
  return `${OWN_PROJECT_PREFIX}${name}`;
}

/** A compose project with the port its Mongo is published on: the two travel together, so no call names one without the other. */
const shardTarget = (index) => ({ project: dbShardProject(index), port: dbShardPort(index) });
const ownTarget = (name) => ({ project: dbOwnProject(name), port: OWN_PLACEHOLDER_PORT });

/** `argv` as a line to read: the compose files and a format string are left out. */
const commandText = (argv) => argv.filter((a, i) => a !== '-f' && argv[i - 1] !== '-f').join(' ');

/**
 * Run `docker <argv>` for real; resolves with its output, rejects with it when it exits non-zero, and is killed when `signal`
 * aborts. Only `docker` itself is killed: a compose plugin it started can outlive it and hold the output pipes open, which
 * would keep this process alive, so on abort the pipes are destroyed as well. `spawnChild` is injectable.
 */
export function dockerRun(argv, { env, signal } = {}, spawnChild = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnChild('docker', argv, { env, signal, killSignal: 'SIGKILL', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`exited ${code}\n${out.trim()}`))));
    const release = () => { child.stdout.destroy(); child.stderr.destroy(); };
    if (signal?.aborted) release();
    else signal?.addEventListener('abort', release, { once: true });
  });
}

/**
 * `docker <argv>` with a time limit, which no call can leave out: a call that does not answer in `timeoutMs` is stopped
 * (`run` is handed a signal that aborts) and rejects. A failure carries the command and Docker's own output.
 *
 * `signal` is the caller's own way to stop the call (an interrupt): when it aborts, `run`'s signal aborts, and the call
 * settles when `run` does, never before, so a caller that waits for it knows the `docker` client is gone. It does NOT know the
 * compose plugin `docker` started is: that can outlive the client and go on creating the project, which is why a stopped start
 * names the command that removes it by hand. A call given an aborted signal is not made. The error of a call that was
 * stopped, by the limit or by `signal`, has `stopped: true`: what it was starting may still have happened.
 *
 * @param {string[]} argv
 * @param {object} o
 * @param {(argv: string[], o: { env: object, signal: AbortSignal }) => Promise<string>} [o.run] docker, injectable
 * @param {object} [o.env]
 * @param {number} o.timeoutMs
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<string>} the output
 */
export async function callDocker(argv, { run = dockerRun, env = process.env, timeoutMs, signal } = {}) {
  if (!(timeoutMs > 0)) throw new Error(`docker ${commandText(argv)}: no time limit was given, so the call was not made`);
  if (signal?.aborted) throw Object.assign(new Error(`docker ${commandText(argv)}: not made, the run was interrupted`), { stopped: true });
  const controller = new AbortController();
  const forward = () => controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  let ranToTheEnd = false;
  try {
    const answer = Promise.resolve().then(() => run(argv, { env, signal: controller.signal })).finally(() => { ranToTheEnd = true; });
    return await within(answer, timeoutMs);
  } catch (e) {
    controller.abort();
    throw Object.assign(new Error(`docker ${commandText(argv)}: ${e.message}`, { cause: e }), { stopped: !ranToTheEnd || signal?.aborted === true });
  } finally {
    signal?.removeEventListener('abort', forward);
  }
}

/** `docker compose` for one target (its project and port); resolves with its output, rejects with it when it fails or is not answered in time. */
function compose({ project, port }, args, { run, timeoutMs, signal }) {
  const argv = ['compose', '-p', project, ...COMPOSE_FILES.flatMap(f => ['-f', f]), ...args];
  return callDocker(argv, { run, env: { ...process.env, [PORT_VARIABLE]: String(port) }, timeoutMs, signal });
}

/** The `up` of the one service, as the shards and an own database both start it: detached, waiting for healthy, building nothing. */
const UP_ARGS = ['up', '--detach', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_SECONDS), '--no-build', SERVICE];
const DOWN_ARGS = ['down', '--volumes', '--remove-orphans', '--timeout', String(STOP_GRACE_SECONDS)];

/** Remove shard `index`'s container and volumes. Never throws: there may be nothing to remove, and cleanup must not hide a run's own failure. */
async function removeShard(index, { run, limits }) {
  try { await compose(shardTarget(index), DOWN_ARGS, { run, timeoutMs: limits.down }); } catch { /* nothing there, or already gone */ }
}

/**
 * Start `count` shard Mongos together and wait until every one is healthy.
 * @returns {Promise<Array<{ index: number, port: number }>>}
 */
export async function startDbShards(count, { run = dockerRun, limits = DOCKER_LIMITS } = {}) {
  const indexes = Array.from({ length: count }, (_, i) => i);
  await Promise.all(indexes.map(i => removeShard(i, { run, limits })));
  const started = await Promise.allSettled(indexes.map(i => compose(shardTarget(i), UP_ARGS, { run, timeoutMs: limits.up })));
  const failed = started.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'rejected');
  if (failed.length > 0) {
    await stopDbShards(indexes.map(index => ({ index })), { run, limits });
    throw new Error(`db shard(s) ${failed.map(f => f.i).join(', ')} did not start:\n${failed.map(f => f.r.reason.message).join('\n')}`);
  }
  return indexes.map(index => ({ index, port: dbShardPort(index) }));
}

/** Remove every shard in `shards` (containers and volumes). Safe to call twice, and with shards that never started. */
export async function stopDbShards(shards, { run = dockerRun, limits = DOCKER_LIMITS } = {}) {
  await Promise.all(shards.map(s => removeShard(s.index, { run, limits })));
}

/**
 * The own databases there are: name, compose project, state, Docker's own status text ("Up 3 minutes"; no age is computed
 * here, so no two clocks are compared) and the published loopback port (`null` when the container has none).
 * ONE `docker ps -a` by the service's label, read with the take-down's reader of Docker's JSON lines, which throws on what it
 * cannot read: a listing that fails, times out or prints something else is a refusal, never "none".
 * A project counts only when what follows the prefix has an own database's whole shape (`<label>-<8 hex>`): `own-down` would
 * refuse any other, so it is neither listed nor counted. A project with two containers is one line, the running one.
 * @returns {Promise<Array<{ name: string, project: string, state: string, status: string, port: number|null }>>}
 */
export async function listOwnDbs({ run = dockerRun, limits = DOCKER_LIMITS } = {}) {
  const text = await callDocker(['ps', '-a', '--no-trunc', '--filter', `label=${SERVICE_LABEL}=${SERVICE}`, '--format', '{{json .}}'],
    { run, timeoutMs: limits.list });
  const containers = parseContainers(text);
  // `parseContainers` has read every line, so these cannot throw; it keeps neither the status text nor the ports.
  const raw = new Map(text.split(/\r?\n/).filter(l => l.trim() !== '').map(l => JSON.parse(l)).map(o => [o.ID, o]));
  const published = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::\\]):(\\d+)->${CONTAINER_PORT}/tcp`);
  const byProject = new Map();
  for (const c of containers) {
    const name = c.project.startsWith(OWN_PROJECT_PREFIX) ? c.project.slice(OWN_PROJECT_PREFIX.length) : '';
    if (c.service !== SERVICE || !OWN_NAME.test(name)) continue;
    const o = raw.get(c.id);
    const port = published.exec(String(o?.Ports ?? ''))?.[1];
    const row = { name, project: c.project, state: c.state, status: String(o?.Status ?? ''), port: port === undefined ? null : Number(port) };
    const seen = byProject.get(c.project);
    if (seen === undefined || (seen.state !== 'running' && row.state === 'running')) byProject.set(c.project, row);
  }
  return [...byProject.values()];
}

/** Does `project` have a network? (A project whose container is gone can still have one, and `down` removes it.) Throws on a listing that fails or cannot be read. */
async function hasNetwork(project, { run, limits }) {
  const text = await callDocker(['network', 'ls', '--filter', `label=${PROJECT_LABEL}=${project}`, '--format', '{{json .}}'], { run, timeoutMs: limits.list });
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  for (const line of lines) {
    let value;
    try { value = JSON.parse(line); } catch { throw new Error(`docker network ls printed a line that is not JSON: ${line.slice(0, 160)}`); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`docker network ls printed a line that is not a JSON object: ${line.slice(0, 160)}`);
  }
  return lines.length > 0;
}

/** The loopback port `docker compose port` printed: exactly one `address:port` line, or a throw. */
function publishedPort(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error(`docker compose port printed ${lines.length} lines, expected one address: ${JSON.stringify(String(text).trim()).slice(0, 160)}`);
  const match = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(lines[0]);
  const port = match ? Number(match[1]) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new Error(`docker compose port printed ${JSON.stringify(lines[0])}, which is not an address with a port`);
  return port;
}

/**
 * Print the state of the target's container (why it stopped, when it has), then remove its project with its volumes. Throws
 * when Docker fails to remove. `report: false` skips the print: an interrupted start has only the few seconds a closing
 * console leaves, and the removal must not spend them on a report.
 */
async function removeOwn(target, { run, limits, printError }, { report = true } = {}) {
  if (report) {
    await reportContainerState({
      projects: [target.project], print: printError, timeoutMs: limits.ask,
      ask: (argv, timeoutMs) => callDocker(argv, { run, timeoutMs }),
    });
  }
  await compose(target, DOWN_ARGS, { run, timeoutMs: limits.down });
}

/** The signals an interrupted start removes what it made on; the process then ends with 128 plus the signal's number, as a shell reports it. */
const INTERRUPTS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Register `handler` for the interrupts, for as long as a start is in flight (the caller unregisters when it ends). The hook
 * does NOT end the process: it records the signal's exit code in `proc.exitCode` and the entry point (`main`) ends the process
 * with it AFTER the start has printed its own final error line, so the line and the code never depend on timing. A signal with
 * no start in flight has no listener here and ends the process at once, as it always did. The listeners stay registered while
 * the handler runs, and a signal that arrives meanwhile does nothing: a second Ctrl+C would otherwise kill the removal halfway.
 * Returns the function that unregisters. `proc` is injectable (anything with `on`, `removeListener`, `exitCode`).
 */
export function onProcessSignal(handler, proc = process) {
  let handling = false;
  const registered = INTERRUPTS.map((signal) => {
    const listener = () => {
      if (handling) return;
      handling = true;
      proc.exitCode = 128 + osConstants.signals[signal];
      Promise.resolve().then(() => handler(signal)).catch(() => {});
    };
    proc.on(signal, listener);
    return { signal, listener };
  });
  return () => { for (const { signal, listener } of registered) proc.removeListener(signal, listener); };
}

/**
 * Start ONE harness Mongo of the caller's own and wait until it is healthy. The START makes the project name (the label and
 * eight random hex characters), so two starts never name one project and nothing has to be claimed or refused for a label in
 * use; Docker picks the port. The limit of `DB_OWN_MAX` is checked here, when the start begins.
 *
 * A start that fails after the name is made prints the container's state and removes the project it made, and names a
 * removal that failed too with the command that does it by hand. An interrupt (`onSignal`) first stops the call in flight
 * and waits until it has settled, so the project is removed after the `up` is gone and not while it is still bringing the
 * database up; it skips the state print. When a call was stopped, by its limit or by an interrupt, the removal is tried and
 * the error ALWAYS names the hand command and says the database may still come up (a compose plugin outlives the docker it
 * was started by).
 *
 * @param {{ label: string }} o
 * @param {object} [deps] `run` docker, `limits` the time limits, `printError` where the container's state and the interrupt notice go, `onSignal` the interrupt hook, `random` the random part
 * @returns {Promise<{ name: string, project: string, port: number }>}
 */
export async function startOwnDb({ label }, { run = dockerRun, limits = DOCKER_LIMITS, printError = (l) => console.error(l), onSignal = onProcessSignal, random = randomPart } = {}) {
  const name = ownDbName(label, random());
  const existing = await listOwnDbs({ run, limits });
  if (existing.length >= DB_OWN_MAX) {
    throw new Error(`${existing.length} own databases exist and ${DB_OWN_MAX} is the most when a start begins: \`${SELF} own-list\` shows them, \`${SELF} own-down <name>\` removes one`);
  }
  const target = ownTarget(name);
  const handCommand = `${SELF} own-down ${name}`;
  const interrupt = new AbortController();
  let interrupted = false;
  let inFlight = Promise.resolve();
  /** One of this start's compose calls, stoppable by an interrupt; remembers when it has settled. */
  const step = (args, timeoutMs) => {
    const call = compose(target, args, { run, timeoutMs, signal: interrupt.signal });
    inFlight = call.then(() => {}, () => {});
    return call;
  };
  let removal;
  const remove = () => (removal ??= removeOwn(target, { run, limits, printError }, { report: !interrupted }));
  const dispose = onSignal(async (signal) => {
    interrupted = true;
    printError(`db-shard-stack: ${signal} during the start of ${name}: stopping it and removing it. If this is cut short, remove it by hand: ${handCommand}`);
    interrupt.abort();
    await inFlight;
    try { await remove(); } catch (e) { printError(`db-shard-stack: removing ${name} failed: ${e.message}`); }
  });
  try {
    await step(UP_ARGS, limits.up);
    const port = publishedPort(await step(['port', SERVICE, String(CONTAINER_PORT)], limits.port));
    if (interrupted) throw new Error('interrupted just as the database came up');
    return { name, project: target.project, port };
  } catch (failure) {
    const unsure = failure.stopped === true || interrupted;
    const maybe = unsure ? `\nThe database may still come up: remove it by hand with ${handCommand}` : '';
    try {
      await remove();
    } catch (cleanup) {
      throw new Error(`${failure.message}\nand removing ${target.project} failed too: ${cleanup.message}${unsure ? maybe : `\nRemove it by hand: ${handCommand}`}`, { cause: failure });
    }
    if (!unsure) throw failure;
    throw new Error(`${failure.message}${maybe}`, { cause: failure });
  } finally {
    dispose();
  }
}

/**
 * Remove the own database `name` (the full name the start printed): its container's state is printed before the removal, then
 * exactly its project goes, with its volumes. A project whose container is gone but whose network remains is taken down too.
 * Throws on a name that is not an own database's, on a project with neither container nor network, on a listing that fails or
 * cannot be read, and when Docker fails to remove it.
 */
export async function stopOwnDb(name, { run = dockerRun, limits = DOCKER_LIMITS, printError = (l) => console.error(l) } = {}) {
  const target = ownTarget(name);
  const there = await listOwnDbs({ run, limits });
  if (!there.some(d => d.name === name) && !(await hasNetwork(target.project, { run, limits }))) {
    throw new Error(`there is no own database ${name}: \`${SELF} own-list\` shows the ones there are`);
  }
  await removeOwn(target, { run, limits, printError });
}

const USAGE = `db-shard-stack: usage: up [n] | down n | own-up <label> | own-down <name> | own-list`;

/**
 * From the command line, for a runner whose test processes cannot reach Docker (a container): the host starts the Mongos,
 * the run attaches to them, the host removes them. Resolves with the exit code (0, or 1 for any failure, usage included);
 * what it prints goes through `print` (stdout) and `printError` (stderr).
 *
 *   node testing/_init/db-shard-stack.mjs up [n]        start n shards (default: what the Docker VM has room for); prints n alone on its last line
 *   node testing/_init/db-shard-stack.mjs down n        remove shards 0 to n-1 with their volumes
 *   node testing/_init/db-shard-stack.mjs own-up <label>  start one Mongo of your own; prints `<name> <port>` alone on its last line, and
 *                                                       removes what it made on SIGINT, SIGTERM or SIGHUP during the start
 *   node testing/_init/db-shard-stack.mjs own-down <name>  remove exactly that Mongo (the name `own-up` printed)
 *   node testing/_init/db-shard-stack.mjs own-list      one line per own Mongo, with the command that removes it; `none` for none
 */
export async function cli(argv, {
  print = (l) => console.log(l), printError = (l) => console.error(l), run = dockerRun, limits = DOCKER_LIMITS,
  onSignal = onProcessSignal, random, askVm = dockerVm,
} = {}) {
  const [command, arg] = argv;
  const count = (raw) => {
    const c = Number(raw);
    if (!Number.isInteger(c) || c < 1 || c > DB_SHARDS_MAX) throw new Error(`db-shard-stack: ${raw} is not a shard count from 1 to ${DB_SHARDS_MAX}`);
    return c;
  };
  const needs = (value, what) => {
    if (value === undefined || value === '') throw new Error(`db-shard-stack: ${command} needs ${what}\n${USAGE}`);
    return value;
  };
  try {
    if (command === 'up') {
      const want = arg === undefined ? (await resolveDbShardConfig({ defaultWidth: 1, shards: '', width: '', started: '', askVm })).count : count(arg);
      await startDbShards(want, { run, limits });
      print(want);
    } else if (command === 'down') {
      await stopDbShards(Array.from({ length: count(arg) }, (_, index) => ({ index })), { run, limits });
    } else if (command === 'own-up') {
      const started = await startOwnDb({ label: needs(arg, 'a label') }, { run, limits, printError, onSignal, random });
      print(`${started.name} ${started.port}`);
    } else if (command === 'own-down') {
      await stopOwnDb(needs(arg, 'the name `own-up` printed'), { run, limits, printError });
    } else if (command === 'own-list') {
      const dbs = await listOwnDbs({ run, limits });
      if (dbs.length === 0) print('none');
      for (const d of dbs) print(`${d.name} ${d.state} (${d.status}) port ${d.port ?? 'none'}: ${SELF} own-down ${d.name}`);
    } else {
      throw new Error(USAGE);
    }
    return 0;
  } catch (e) {
    printError(e.message);
    return 1;
  }
}

/** Milliseconds the end of the process waits for each output stream to take what was written: a closed pipe (`| head`) never answers. */
const FLUSH_LIMIT_MS = 2_000;

/**
 * Write nothing to `stream` and wait until everything before it is written, for at most `limitMs`. Never throws and never
 * waits for good: a stream that is destroyed, whose pipe is closed (EPIPE) or whose write never calls back is given up on.
 * A no-op `error` listener stays, so a later EPIPE is not an uncaught error.
 */
function flushed(stream, limitMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, limitMs);
    timer.unref();
    const done = () => { clearTimeout(timer); resolve(); };
    try {
      stream.on('error', done);
      stream.write('', done);
    } catch {
      done();
    }
  });
}

/**
 * The command line as a process: run `cli`, then end the process with its exit code, or with the code an interrupt recorded
 * (`onProcessSignal`) when there is one, AFTER the output is written, so the start's final error line is always printed
 * first. The code is set before the flush, so a process that ends by itself ends with it too. The flush is bounded.
 * `proc` and the rest are injectable for the test.
 */
export async function main(argv, { proc = process, flushMs = FLUSH_LIMIT_MS, ...deps } = {}) {
  const code = await cli(argv, { onSignal: (handler) => onProcessSignal(handler, proc), ...deps });
  proc.exitCode = proc.exitCode || code;
  await Promise.all([flushed(proc.stdout, flushMs), flushed(proc.stderr, flushMs)]);
  proc.exit(proc.exitCode);
}

if (isEntryPoint(import.meta.url)) {
  await main(process.argv.slice(2));
}
