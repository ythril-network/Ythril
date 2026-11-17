/**
 * The measured costs the preflight plans by, as untracked snapshots it reads and the host writes (Q-865 stage costs, Q-869 file times).
 *
 * ## What it prevents
 *
 * The preflight orders its stages by what finding a failure in each costs (`planStages`, `scripts/_shared/preflight-stages.mjs`) and starts
 * its slowest pure test files first (`slowFirstUnits`, `scripts/_shared/slow-first-units.mjs`), and the measurements live in records on the
 * Ythril instance (`Preflight-Run`, `Test-Run`). The preflight must never fetch them (a down instance would delay the fast failure it exists
 * for) and runs in a container with no instance address, so the numbers reach it through files in the results folder,
 * `test-results/stage-costs.json` and `test-results/file-times.json`, which `node scripts/test-times.mjs --preflight-costs` writes and
 * `--drain-unrecorded` refreshes. A file a script reads before every push is input from outside the run; the ways it goes wrong are closed
 * in {@link readSnapshot}, the ONE reading both snapshots go through, none left to a caller:
 *
 * - **A throw that stops the preflight.** The readers never throw: a missing, empty, truncated or garbage file is `{ <snapshot>: null, why }`,
 *   and the preflight runs in the list's order and says why.
 * - **A plan from numbers nobody measured.** Another tool's JSON, a list, a row that is not finite non-negative numbers, a date that is no
 *   date: each is refused, whole, rather than read for what it happens to hold (the shape is the caller's `validate`).
 * - **A polluted prototype.** A `__proto__` key at the top or one level down (among a map's keys) refuses the file, and the reader hands back
 *   what `JSON.parse` made (own keys only; callers read them with `Object.hasOwn`).
 * - **A stale order.** A snapshot older than {@link MAX_AGE_DAYS} days is refused (`stale, N days`): the times of a speed-up long gone would
 *   misorder every run. A stale order only costs time, so this is never a gate.
 * - **A date from the future.** A `generatedAt` more than a minute ahead of the clock (a typo, a forged file) would never age out and would
 *   keep the snapshot "fresh" for ever, so it is refused (`from the future`); half a minute is clock skew and is read.
 * - **A half-written file.** {@link writeSnapshot} writes a temporary file in the same folder and renames it into place, so a reader sees
 *   the old snapshot or the new one.
 *
 * The file names do not start with `preflight-`, so `clearTimingResults('preflight')` (which the preflight runs at the start of its
 * standalone batches) leaves them alone.
 *
 * Built-ins only.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The stage-costs snapshot's name in the results folder. */
export const STAGE_COSTS_FILE = 'stage-costs.json';

/** The file-times snapshot's name in the results folder. */
export const FILE_TIMES_FILE = 'file-times.json';

/** A snapshot older than this many days is not trusted. */
export const MAX_AGE_DAYS = 14;

/** How far ahead of the clock a `generatedAt` may be (clock skew between the host and the container) before it is refused. */
export const MAX_AHEAD_MS = 60_000;

const DAY_MS = 86_400_000;
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const count = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The snapshot called `name` in `dir`, if it is whole, of the shape `validate` accepts, not poisoned, not from the future and fresh.
 * Never throws.
 *
 * @param {string} dir the results folder
 * @param {string} name the file's name in it
 * @param {{ validate: (snapshot: object) => boolean, now?: () => number }} options `validate` is the caller's shape (a boolean; the
 *   `generatedAt` date is checked here); `now` is the clock, in milliseconds
 * @returns {{ snapshot: object | null, why: string }} `why` is empty on success
 */
export function readSnapshot(dir, name, { validate, now = Date.now }) {
  const refuse = (why) => ({ snapshot: null, why });
  let text;
  try { text = readFileSync(join(dir, name), 'utf8'); } catch (err) {
    return refuse(err?.code === 'ENOENT' ? `no ${name} yet` : `${name} cannot be read: ${firstLine(err)}`);
  }
  let snap;
  try { snap = JSON.parse(text); } catch { return refuse(`${name} is not whole JSON`); }
  if (!isObject(snap)) return refuse(`${name} is not a snapshot`);
  if (Object.hasOwn(snap, '__proto__')) return refuse(`${name} has a __proto__ key`);
  for (const [key, value] of Object.entries(snap)) {
    if (isObject(value) && Object.hasOwn(value, '__proto__')) return refuse(`${name} has a __proto__ key under ${JSON.stringify(key)}`);
  }
  let shaped = false;
  try { shaped = validate(snap) === true; } catch { shaped = false; }
  if (!shaped) return refuse(`${name} is not the snapshot it should be (the wrong shape)`);
  if (typeof snap.generatedAt !== 'string' || !Number.isFinite(Date.parse(snap.generatedAt))) return refuse(`${name} has no valid generatedAt`);
  const age = now() - Date.parse(snap.generatedAt);
  if (age < -MAX_AHEAD_MS) return refuse(`${name} is from the future: its generatedAt is ${Math.ceil(-age / 60_000)} minute(s) ahead of the clock`);
  if (age > MAX_AGE_DAYS * DAY_MS) return refuse(`stale, ${Math.floor(age / DAY_MS)} days old (the limit is ${MAX_AGE_DAYS})`);
  return { snapshot: snap, why: '' };
}

/**
 * Write a snapshot whole: a temporary file in `dir`, renamed over the snapshot called `name`. A failed write leaves the old snapshot and
 * no temporary file, and throws.
 *
 * @param {string} dir the results folder (made when it does not exist)
 * @param {string} name the file's name in it
 * @param {object} snapshot
 */
export function writeSnapshot(dir, name, snapshot) {
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.${name}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(snapshot));
    renameSync(temporary, join(dir, name));
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}

const validStageCosts = (snap) => isObject(snap.stages) && count(snap.runs)
  && Object.values(snap.stages).every(row => isObject(row) && count(row.ran) && count(row.failed) && count(row.medianMs));

const validFileTimes = (snap) => isObject(snap.files) && count(snap.runs)
  && (snap.newestSourceAt === undefined || typeof snap.newestSourceAt === 'string')
  && Object.values(snap.files).every(count);

/**
 * The stage-costs snapshot in `dir`, if it is whole, of the right shape and fresh. Never throws.
 *
 * @param {string} dir the results folder
 * @param {{ now?: () => number }} [options] the clock, in milliseconds
 * @returns {{ costs: { generatedAt: string, window?: number, runner?: string, runs: number, stages: Record<string, { ran: number, failed: number, medianMs: number }> } | null, why: string }}
 */
export function readStageCosts(dir, { now = Date.now } = {}) {
  const { snapshot, why } = readSnapshot(dir, STAGE_COSTS_FILE, { validate: validStageCosts, now });
  return { costs: snapshot, why };
}

/**
 * The file-times snapshot in `dir` (the recorded time of each pure test file, in milliseconds, by repo-relative path), if it is whole, of
 * the right shape and fresh. Never throws; read `times.files` with `Object.hasOwn`.
 *
 * @param {string} dir the results folder
 * @param {{ now?: () => number }} [options] the clock, in milliseconds
 * @returns {{ times: { generatedAt: string, newestSourceAt?: string, runs: number, files: Record<string, number> } | null, why: string }}
 */
export function readFileTimes(dir, { now = Date.now } = {}) {
  const { snapshot, why } = readSnapshot(dir, FILE_TIMES_FILE, { validate: validFileTimes, now });
  return { times: snapshot, why };
}

/**
 * Write the stage-costs snapshot whole.
 *
 * @param {string} dir the results folder
 * @param {object} snapshot `{ generatedAt, window, runner, runs, stages }`
 */
export const writeStageCosts = (dir, snapshot) => writeSnapshot(dir, STAGE_COSTS_FILE, snapshot);

/**
 * Write the file-times snapshot whole.
 *
 * @param {string} dir the results folder
 * @param {object} snapshot `{ generatedAt, newestSourceAt, runs, files }`
 */
export const writeFileTimes = (dir, snapshot) => writeSnapshot(dir, FILE_TIMES_FILE, snapshot);
