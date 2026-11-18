#!/usr/bin/env node
/**
 * Take the Docker test stack down, leaving what another session holds, and refuse a start while anything of the stack is held.
 *
 * `node testing/_init/stack-down.mjs [--for-start] [--ignore-holds]` is what `npm run test:down`, `test:down:clean`, `test:down:all` and the
 * first step of `test:up` and `test:up:rebuild` run. It is the one place that takes the stack down: no package script, shell script or workflow
 * spells a compose `down` of the stack's file (`a-script-that-starts-the-test-stack-first-downs-both-projects` refuses one).
 *
 * ## What it prevents
 *
 * - **A session's database removed under it (Q-922).** The stack's database `ythril-mongo-a` has a fixed name, is the one the container runner's
 *   other modes need, and is kept running by whoever booked it. `docker compose down -v` removed it, with its data, for whichever session ran
 *   `test:down` or `test:up` next. A hold (a JSON file in the directory `YTHRIL_TEST_STACK_HOLDS_DIR` names, see {@link liveHolds}) keeps the containers
 *   it names and the volumes they mount; everything else of the stack goes.
 * - **A start beside a held stack.** Two sessions on one database server, sized for one load, change each other's server-wide settings.
 *   With `--for-start` a held container of the stack ends the run with exit 1, the holder's label and how to end the hold; nothing is removed.
 * - **A holder that cannot take its own stack down.** `--ignore-holds` reads no holds (`npm run test:down:all`).
 * - **Half a take-down read as a whole one.** Every Docker call has an argument array (no shell) and a timeout. A listing that fails, times out or
 *   prints something that is not JSON lines ends the run with exit 1 and the reason BEFORE anything is removed: it is never read as an empty
 *   stack. A removal that fails is collected, named, and the run exits 1 after the others were tried; the configs are then left as they are.
 * - **A hold that cannot be read taken as no hold.** A variable that is set but names a missing or unreadable directory exits 1 naming it; a file that
 *   cannot be read is tried once more, then refused naming the file; a file with neither `containers` nor `project`, or with an `expiresAt`
 *   that is not null, absent or a finite number, counts as a hold on everything and is printed. Only an UNSET or empty variable means no holds
 *   (CI and every machine without a booking tool, where the take-down is exactly `down -v --remove-orphans` of both projects).
 * - **The default project named by the environment.** The default project is named with `-p testing`, so a `COMPOSE_PROJECT_NAME` can never aim the
 *   take-down at another instance. Its volumes go too.
 *
 * ## The two questions it keeps apart
 *
 * `liveHolds` (which holds count, from files and the running containers), `parseContainers`/`parseVolumes` (Docker's JSON lines as plain objects),
 * `stackDownPlan` (pure: what goes, what stays, which instance configs are wiped, whether a start is refused) and `stackDown` (the act). The projects
 * are parameters of `stackDown`; the real names are this command line's defaults only, which is how the Docker test runs the act on a scratch project.
 *
 * Exit codes: 0 done (a kept container, a kept network and an ignored hold are no failure); 1 refused, or Docker or the holds failed; 2 a bad
 * command line.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../../scripts/_shared/script-cli.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The two compose projects a stack of the test file can have been started under: `ythril-test`, and the default project (named for the directory) written out. */
export const DEFAULT_PROJECTS = Object.freeze(['ythril-test', 'testing']);
/** The test stack's compose file, relative to the repository root. */
export const DEFAULT_COMPOSE_FILE = 'testing/docker-compose.test.yml';
/** The variable that names the directory of hold files. Unset or empty: no holds. */
export const HOLDS_DIR_VARIABLE = 'YTHRIL_TEST_STACK_HOLDS_DIR';
/** The instances whose bind-mounted config is wiped when their container goes: the id and the container that mounts `testing/sync/configs/<id>`. */
export const DEFAULT_INSTANCES = Object.freeze(['a', 'b', 'c', 'd'].map((id) => Object.freeze({ id, container: `ythril-${id}` })));

const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const LIST_TIMEOUT_MS = 30_000;
const REMOVE_TIMEOUT_MS = 120_000;
const DOWN_TIMEOUT_MS = 300_000;
const RUNNING_STATES = new Set(['running', 'restarting', 'paused']);

/** A string with its control characters (escape, newline, NUL) removed: what a label may contribute to a line this prints. */
const printable = (text) => String(text).replace(/\p{Cc}/gu, '');

/**
 * The holds that are live: those that keep a container of the stack.
 *
 * A hold file is `*.json` in `dir` with `label`, `expiresAt` (epoch milliseconds, or null or absent for open-ended), and `containers` (names)
 * and/or `project`. It is live when it has not expired and one of its keys is the name OR the compose project of a running container, every key
 * matched both ways, as the booking tool matches them. A hold written a moment before its container runs does not count yet.
 *
 * What a hold file can say that is not understood keeps everything, because an unreadable hold must never read as no hold: it is returned with
 * `all: true` and a `note` to print. A file that cannot be read twice, or a directory that cannot be listed, throws naming it.
 *
 * @param {object}   args
 * @param {string}   [args.dir]      the holds directory; unset or empty gives no holds
 * @param {{name: string, project: string, state: string}[]} args.running  the containers of the stack, with their state
 * @param {number}   [args.now]      epoch milliseconds
 * @param {Function} [args.readFile] `(path, encoding) => text`, `readFileSync` by default
 * @returns {{file: string, label: string, keys: string[], all: boolean, note?: string}[]}
 * @throws when the directory or a file in it cannot be read
 */
export function liveHolds({ dir, running, now = Date.now(), readFile = readFileSync }) {
  if (!dir) return [];
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    throw new Error(`the holds directory ${dir} (${HOLDS_DIR_VARIABLE}) cannot be read: ${e.message}`);
  }
  const alive = running.filter((c) => RUNNING_STATES.has(c.state));
  const known = new Set(alive.flatMap((c) => [c.name, c.project]).filter(Boolean));
  const live = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = join(dir, name);
    const hold = interpretHold(readHoldFile(file, readFile), file, now);
    if (hold !== null && (hold.all || hold.keys.some((k) => known.has(k)))) live.push(hold);
  }
  return live;
}

/** One hold file's parsed JSON; a read or parse that fails is tried once more (a file written while read), then throws naming the file. */
function readHoldFile(file, readFile) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(readFile(file, 'utf8'));
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`the hold file ${file} cannot be read: ${last.message}`);
}

/** A parsed hold as `{ file, label, keys, all }`, or null when it has expired. What it cannot make sense of is a hold on everything. */
function interpretHold(value, file, now) {
  const everything = (why) => ({ file, label: labelOf(value, file), keys: [], all: true, note: `the hold file ${file} ${why}: it counts as a hold on everything` });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return everything('is not a JSON object');
  const expiresAt = value.expiresAt;
  if (expiresAt !== null && expiresAt !== undefined) {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return everything('has an expiresAt that is not null, absent or a finite number');
    if (expiresAt <= now) return null;
  }
  const keys = [];
  const { containers, project } = value;
  if (containers !== null && containers !== undefined) {
    if (!Array.isArray(containers) || containers.some((c) => typeof c !== 'string' || c === '')) return everything('has a containers entry that is not a list of names');
    keys.push(...containers);
  }
  if (project !== null && project !== undefined) {
    if (typeof project !== 'string' || project === '') return everything('has a project that is not a name');
    keys.push(project);
  }
  if (keys.length === 0) return everything('names neither containers nor a project');
  return { file, label: labelOf(value, file), keys, all: false };
}

const labelOf = (value, file) => printable(typeof value?.label === 'string' && value.label.trim() !== '' ? value.label.trim() : basename(file));

/** The JSON objects of Docker's `--format '{{json .}}'` output, one per line; blank lines are skipped. Throws on a line that is not a JSON object, naming it. */
function jsonLines(text, what) {
  return String(text).split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${what} printed a line that is not JSON: ${printable(line).slice(0, 160)}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} printed a line that is not a JSON object: ${printable(line).slice(0, 160)}`);
    return value;
  });
}

/** One label's value out of the comma-joined `Labels` field (the values may hold commas; a label name always starts after one). */
const labelValue = (labels, name) => new RegExp(`(?:^|,)${name.replace(/\./g, '\\.')}=([^,]*)`).exec(labels)?.[1] ?? '';

/**
 * Containers from `docker ps -a --no-trunc --format '{{json .}}'`.
 * @returns {{id: string, name: string, state: string, project: string, service: string, mounts: string[]}[]}
 * @throws on output that is not JSON lines, or a line with no name or id
 */
export function parseContainers(text) {
  return jsonLines(text, 'docker ps').map((o) => {
    const name = typeof o.Names === 'string' ? o.Names.split(',')[0].replace(/^\//, '') : '';
    if (name === '') throw new Error(`a docker ps line has no Names: ${printable(JSON.stringify(o)).slice(0, 160)}`);
    if (typeof o.ID !== 'string' || o.ID === '') throw new Error(`a docker ps line has no ID: ${name}`);
    const labels = typeof o.Labels === 'string' ? o.Labels : '';
    const mounts = typeof o.Mounts === 'string' ? o.Mounts.split(',').filter(Boolean) : [];
    return { id: o.ID, name, state: String(o.State ?? ''), project: labelValue(labels, PROJECT_LABEL), service: labelValue(labels, SERVICE_LABEL), mounts };
  });
}

/**
 * Volumes from `docker volume ls --format '{{json .}}'`.
 * @returns {{name: string, project: string}[]}
 * @throws on output that is not JSON lines, or a line with no Name
 */
export function parseVolumes(text) {
  return jsonLines(text, 'docker volume ls').map((o) => {
    if (typeof o.Name !== 'string' || o.Name === '') throw new Error(`a docker volume ls line has no Name: ${printable(JSON.stringify(o)).slice(0, 160)}`);
    return { name: o.Name, project: labelValue(typeof o.Labels === 'string' ? o.Labels : '', PROJECT_LABEL) };
  });
}

/**
 * What a take-down does, from what Docker listed and what is held. Pure.
 *
 * `mode` is `down-all` when nothing is kept (the projects' own `down -v --remove-orphans`), `selective` when something is (remove each container not
 * held by name, then each volume no kept container mounts), `refused` when a start meets a held container (nothing is removed or wiped).
 *
 * @param {object} args
 * @param {{name: string, project: string, mounts: string[]}[]} args.containers  every container of the stack's projects
 * @param {{name: string}[]} args.volumes   every volume of the stack's projects
 * @param {{label: string, keys: string[], all: boolean}[]} args.holds  the live holds
 * @param {boolean} [args.forStart]     the run precedes a start: a held container refuses it
 * @param {boolean} [args.ignoreHolds]  read the holds as none
 * @param {{id: string, container: string}[]} [args.instances]  the instances whose config is wiped when their container goes
 * @returns {{mode: string, kept: {name: string, project: string, holders: string[]}[], removeContainers: string[], keptVolumes: string[], removeVolumes: string[], wipeInstances: string[], refusal: string|null}}
 */
export function stackDownPlan({ containers, volumes, holds, forStart = false, ignoreHolds = false, instances = DEFAULT_INSTANCES }) {
  const effective = ignoreHolds ? [] : holds;
  const holdersOf = (c) => [...new Set(effective.filter((h) => h.all || h.keys.some((k) => k === c.name || k === c.project)).map((h) => h.label))];
  const kept = containers.map((c) => ({ name: c.name, project: c.project, holders: holdersOf(c) })).filter((k) => k.holders.length > 0);
  if (kept.length === 0) {
    return { mode: 'down-all', kept, removeContainers: containers.map((c) => c.name), keptVolumes: [], removeVolumes: volumes.map((v) => v.name), wipeInstances: instances.map((i) => i.id), refusal: null };
  }
  if (forStart) {
    const labels = [...new Set(kept.flatMap((k) => k.holders))].join(', ');
    const refusal = `refused: the test stack is held by ${labels} (${kept.map((k) => k.name).join(', ')}), and a start beside it would put two sessions on one database. `
      + `End the hold first: the holder finishes, or stops its container, or its hold file in ${HOLDS_DIR_VARIABLE} expires or is deleted. The holder itself takes the stack down with \`npm run test:down:all\`.`;
    return { mode: 'refused', kept, removeContainers: [], keptVolumes: [], removeVolumes: [], wipeInstances: [], refusal };
  }
  const keptNames = new Set(kept.map((k) => k.name));
  const keptMounts = new Set(containers.filter((c) => keptNames.has(c.name)).flatMap((c) => c.mounts));
  return {
    mode: 'selective',
    kept,
    removeContainers: containers.filter((c) => !keptNames.has(c.name)).map((c) => c.name),
    keptVolumes: volumes.filter((v) => keptMounts.has(v.name)).map((v) => v.name),
    removeVolumes: volumes.filter((v) => !keptMounts.has(v.name)).map((v) => v.name),
    wipeInstances: instances.filter((i) => !keptNames.has(i.container)).map((i) => i.id),
    refusal: null,
  };
}

/** `docker <args>` with an argument array (no shell) and a timeout. `{ status, stdout, stderr, timedOut }`; a docker that did not start has a null status and the reason in `stderr`. */
export function dockerExec(args, timeoutMs) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || (r.error && !timedOut ? r.error.message : ''), timedOut };
}

/** A Docker call's stdout; throws `<what> timed out ...` or `<what> failed (exit n): <first line>` instead of returning what a failed call printed. */
function ask(exec, args, timeoutMs, what) {
  const r = exec(args, timeoutMs);
  if (r.timedOut) throw new Error(`${what} timed out after ${timeoutMs / 1000} s`);
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${printable((r.stderr || r.stdout || '').trim().split(/\r?\n/)[0] ?? '')}`);
  return r.stdout;
}

/** Remove the files in each named instance's config directory; a directory that does not exist is fine. Returns `{ removed, problems }`. */
function wipeConfigs(configsDir, ids) {
  let removed = 0;
  const problems = [];
  for (const id of ids) {
    const dir = join(configsDir, id);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') problems.push(`could not list ${dir}: ${e.message}`);
      continue;
    }
    for (const f of entries) {
      try {
        unlinkSync(join(dir, f));
        removed++;
      } catch (e) {
        problems.push(`could not remove ${join(dir, f)}: ${e.message}`);
      }
    }
  }
  return { removed, problems };
}

/**
 * Take the stack down, or refuse a start. Returns the exit code (0, or 1); prints one line per decision through `log` and `error`.
 *
 * @param {object} args
 * @param {string[]} [args.projects]    the compose projects of the stack (the real two by default; the Docker test passes a scratch one)
 * @param {string}   [args.composeFile] the compose file the projects were started from
 * @param {string}   [args.holdsDir]    the holds directory; unset or empty means no holds
 * @param {boolean}  [args.forStart]    refuse while anything of the stack is held
 * @param {boolean}  [args.ignoreHolds] read no holds
 * @param {Function} [args.exec]        `(dockerArgs, timeoutMs) => { status, stdout, stderr, timedOut }`
 * @param {{id: string, container: string}[]} [args.instances]  the instances whose config is wiped when their container goes
 * @param {string}   [args.configsDir]  the folder with one config folder per instance
 * @param {number}   [args.now]         epoch milliseconds
 * @param {Function} [args.log]
 * @param {Function} [args.error]
 * @returns {number}
 */
export function stackDown({
  projects = DEFAULT_PROJECTS, composeFile = join(REPO_ROOT, DEFAULT_COMPOSE_FILE), holdsDir, forStart = false, ignoreHolds = false, exec = dockerExec,
  instances = DEFAULT_INSTANCES, configsDir = join(REPO_ROOT, 'testing', 'sync', 'configs'), now = Date.now(), log = console.log, error = console.error,
} = {}) {
  if (!Array.isArray(projects) || projects.length === 0) throw new Error('stackDown needs at least one compose project');
  const say = (line) => log(`stack-down: ${line}`);
  const fail = (line) => error(`stack-down: ${line}`);

  // Everything is read before anything is removed: the stack's containers and volumes by compose project label, then the holds.
  const containers = [];
  const volumes = [];
  try {
    for (const project of projects) {
      const filter = `label=${PROJECT_LABEL}=${project}`;
      containers.push(...parseContainers(ask(exec, ['ps', '-a', '--no-trunc', '--filter', filter, '--format', '{{json .}}'], LIST_TIMEOUT_MS, `docker ps of project ${project}`))
        .map((c) => ({ ...c, project: c.project || project })));
      volumes.push(...parseVolumes(ask(exec, ['volume', 'ls', '--filter', filter, '--format', '{{json .}}'], LIST_TIMEOUT_MS, `docker volume ls of project ${project}`))
        .map((v) => ({ ...v, project: v.project || project })));
    }
  } catch (e) {
    fail(`${e.message}; nothing was removed.`);
    return 1;
  }

  let holds = [];
  if (ignoreHolds) {
    say('holds are ignored (--ignore-holds): every container of the stack goes.');
  } else if (!holdsDir) {
    say(`no holds directory is set (${HOLDS_DIR_VARIABLE}): nothing is kept, every container of the stack goes.`);
  } else {
    try {
      holds = liveHolds({ dir: holdsDir, running: containers, now });
    } catch (e) {
      fail(`${e.message}; nothing was removed. Fix it, or end the run's reading of holds with \`npm run test:down:all\`.`);
      return 1;
    }
    for (const h of holds) if (h.note) say(h.note);
  }

  const plan = stackDownPlan({ containers, volumes, holds, forStart, ignoreHolds, instances });
  if (plan.refusal !== null) {
    fail(plan.refusal);
    return 1;
  }

  const failures = [];
  const attempt = (what, args, timeoutMs) => {
    try {
      ask(exec, args, timeoutMs, what);
      return true;
    } catch (e) {
      failures.push(e.message);
      return false;
    }
  };
  if (plan.mode === 'down-all') {
    for (const project of projects) {
      if (attempt(`docker compose down of project ${project}`, ['compose', '-p', project, '-f', composeFile, 'down', '-v', '--remove-orphans'], DOWN_TIMEOUT_MS)) say(`took down project ${project} (volumes and orphans included)`);
    }
  } else {
    for (const k of plan.kept) say(`kept ${k.name} (held by ${k.holders.join(', ')})`);
    for (const name of plan.removeContainers) attempt(`removing container ${name}`, ['rm', '-f', '-v', name], REMOVE_TIMEOUT_MS);
    for (const name of plan.removeVolumes) attempt(`removing volume ${name}`, ['volume', 'rm', name], REMOVE_TIMEOUT_MS);
    say(`removed ${plan.removeContainers.length} container(s) and ${plan.removeVolumes.length} volume(s) not held; kept ${plan.kept.length} container(s) and ${plan.keptVolumes.length} volume(s); a network a kept container is attached to stays`);
  }
  if (failures.length > 0) {
    for (const f of failures) fail(f);
    fail(`${failures.length} step(s) failed; instance configs were left as they are.`);
    return 1;
  }

  const wiped = wipeConfigs(configsDir, plan.wipeInstances);
  if (wiped.problems.length > 0) {
    for (const p of wiped.problems) fail(p);
    return 1;
  }
  say(`instance configs wiped (${wiped.removed} file(s)); instances boot first-run${plan.kept.length > 0 ? ', except the kept ones' : ''}.`);
  return 0;
}

/** The command line's flags. Throws on anything else, so a misspelt flag is never read as "no flag" and takes a held stack down. */
export function parseArgs(argv) {
  const flags = { forStart: false, ignoreHolds: false };
  for (const arg of argv) {
    if (arg === '--for-start') flags.forStart = true;
    else if (arg === '--ignore-holds') flags.ignoreHolds = true;
    else throw new Error(`unknown argument ${printable(arg)}; usage: node testing/_init/stack-down.mjs [--for-start] [--ignore-holds]`);
  }
  return flags;
}

if (isEntryPoint(import.meta.url)) {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`stack-down: ${e.message}`);
    process.exit(2);
  }
  process.exitCode = stackDown({ ...flags, holdsDir: process.env[HOLDS_DIR_VARIABLE] });
}
