/**
 * Shared plumbing of the BSBM harness: where things live, how arguments are read, and how a container is
 * started.
 *
 * ## What this prevents
 *
 * - **An unbooked container.** Docker is shared by every project's agents on a machine; a start that does not
 *   claim memory first can take the engine down for everyone. Every container this harness starts goes through
 *   `docker()`, which wraps it in the booking script when one exists (`DOCKER_BOOKING`, else
 *   `~/.claude/hooks/docker-booking.js`) and runs it plainly when none does, on a machine without bookings.
 * - **A container that is not the pinned one.** `pinnedImage` returns the digest reference from `pin.json`
 *   and nothing else; no caller spells an image tag.
 * - **Datasets and results inside the repository.** The work folder defaults to outside it, and `workDir`
 *   refuses a path under the checkout.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const PIN_PATH = join(HERE, 'pin.json');
export const PIN = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
export const TOOLS_SUBDIR = 'tools/bsbmtools-0.2';
export const DEFAULT_WORK = 'E:/TMP/Ythril/data/b271-bench';
/** The prefix of the container, volume and network names of a run in the default work folder. */
export const DEFAULT_NAME_PREFIX = 'b271';
/** A name prefix Docker takes for a container, a volume and a network alike. */
const NAME_PREFIX = /^[a-z0-9][a-z0-9-]{0,30}$/;

/**
 * The prefix of a run's container names: `--name-prefix`, else the work folder's name without a trailing `-bench` (`b273-bench` is `b273`),
 * lower-cased with every other character a `-`. Two runs in two work folders, or with two prefixes, never share a container, so one
 * run's start (which removes its own names first) never removes another's. A prefix Docker would refuse throws.
 */
export function namePrefixOf(flags, work) {
  const given = flags['name-prefix'];
  const prefix = given !== undefined
    ? String(given)
    : basename(String(work).replace(/[\\/]+$/, '')).toLowerCase().replace(/-bench$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!NAME_PREFIX.test(prefix)) throw new Error(`the name prefix '${prefix}' is not one Docker takes: lower-case letters, digits and '-', at most 31`);
  return prefix;
}

/**
 * A `-down` command removes containers, volumes and a network by the run's name prefix, and without `--work` or `--name-prefix` that prefix
 * is the default run's (`DEFAULT_NAME_PREFIX`): a `ythril-down` meant for another run's folder took down the default run's instance, with no
 * word. It throws, naming both flags, before anything is touched; any other command keeps the default folder.
 */
export function downNeedsItsRun(cmd, flags) {
  if (!String(cmd).endsWith('-down') || flags.work !== undefined || flags['name-prefix'] !== undefined) return;
  throw new Error(`${cmd} refuses to run without --work <the run's folder> or --name-prefix <its prefix>: without one it would remove the default run's containers (prefix ${DEFAULT_NAME_PREFIX})`);
}

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { flags, positional };
}

export function workDir(flags) {
  const dir = resolve(String(flags.work ?? DEFAULT_WORK));
  const rel = relative(REPO_ROOT, dir);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(`the work folder ${dir} is inside the repository; datasets and results never are`);
  }
  return dir.replace(/\\/g, '/');
}

/**
 * The dataset variant both engines load for `size` products: its file, name, sha256 and triple count, read from
 * the manifest `generate.mjs` wrote. The raw generator output (`dataset.nt`) is never loaded; refusing to answer
 * without a variant is what keeps one engine from loading different triples than the other.
 */
export function variantOf(work, size) {
  const dir = join(work, 'data', String(size));
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`no dataset for ${size}: run generate.mjs --sizes ${size}`);
  const v = JSON.parse(readFileSync(manifestPath, 'utf8')).variant;
  if (!v?.sha256 || !v.name) throw new Error(`the manifest of ${size} names no variant: regenerate with generate.mjs`);
  const file = join(dir, 'variant.nt');
  if (!existsSync(file)) throw new Error(`${file} is missing: regenerate with generate.mjs`);
  return { file, dir, name: v.name, sha256: v.sha256, triples: v.triples };
}

export function pinnedImage(name) {
  const ref = PIN.images?.[name]?.ref;
  if (!ref || !/@sha256:[0-9a-f]{64}$/.test(ref)) throw new Error(`no digest-pinned image "${name}" in pin.json`);
  return ref;
}

function bookingScript() {
  const path = process.env.DOCKER_BOOKING ?? join(homedir(), '.claude', 'hooks', 'docker-booking.js');
  return existsSync(path) ? path : null;
}

const LABEL = process.env.DOCKER_BOOKING_LABEL ?? 'b271-bench';

/**
 * Runs `docker <args>` booked for `mem` GB and returns { status, stdout, stderr }. `hold` names the containers
 * of a detached start, which keeps the booking while they run.
 */
function command(args, mem, hold) {
  const booking = bookingScript();
  if (!booking) return { cmd: 'docker', argv: args };
  const mode = hold ? ['hold', '--mem', String(mem), '--label', LABEL, '--containers', hold.join(',')]
    : ['run', '--mem', String(mem), '--label', LABEL];
  return { cmd: process.execPath, argv: [booking, ...mode, '--', 'docker', ...args] };
}

/** The same start as `docker()`, as a promise, for a caller whose own event loop must keep serving. */
export function dockerAsync(args, { mem = 1 } = {}) {
  const { cmd, argv } = command(args, mem, null);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (status) => resolvePromise({ status, stdout: out, stderr: err }));
  });
}

export function docker(args, { mem = 1, hold = null, input, inherit = false } = {}) {
  const { cmd, argv } = command(args, mem, hold);
  const r = spawnSync(cmd, argv, {
    encoding: 'utf8', input, maxBuffer: 1 << 28, stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `docker()` that throws on a non-zero exit. */
export function dockerOk(args, opts) {
  const r = docker(args, opts);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r;
}

/** Plain docker, for reads that start no container (inspect, ps, port, rm, volume). */
export function dockerPlain(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export { spawn };
