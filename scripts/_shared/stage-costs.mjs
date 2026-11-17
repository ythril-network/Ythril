/**
 * The measured cost of each preflight stage, as one untracked snapshot the preflight reads and the host writes (Q-865).
 *
 * ## What it prevents
 *
 * The preflight orders its stages by what finding a failure in each costs (`planStages`, `scripts/_shared/preflight-stages.mjs`),
 * and the measurements live in the `Preflight-Run` records on the Ythril instance. The preflight must never fetch them (a down
 * instance would delay the fast failure it exists for) and runs in a container with no instance address, so the numbers reach it
 * through a file in the results folder, `test-results/stage-costs.json`, which `node scripts/test-times.mjs --preflight-costs` writes and
 * `--drain-unrecorded` refreshes after every drain. A file a script reads before every push is input from outside the run; five
 * ways it goes wrong are closed here, none left to the caller:
 *
 * - **A throw that stops the preflight.** {@link readStageCosts} never throws: a missing, empty, truncated or garbage file is
 *   `{ costs: null, why }`, and the preflight runs in the list's order and says why.
 * - **A plan from numbers nobody measured.** Another tool's JSON, a list, a row that is not three finite non-negative numbers, a date
 *   that is no date: each is refused, whole, rather than read for what it happens to hold.
 * - **A polluted prototype.** A `__proto__` key among the stages refuses the file, and the reader hands back what `JSON.parse`
 *   made (own keys only; `planStages` reads them with `Object.hasOwn`).
 * - **A stale order.** A snapshot older than {@link MAX_AGE_DAYS} days is refused (`stale, N days`): the times of a speed-up
 *   long gone would misorder every run. A stale order only costs time, so this is never a gate.
 * - **A half-written file.** {@link writeStageCosts} writes a temporary file in the same folder and renames it into place, so a
 *   reader sees the old snapshot or the new one.
 *
 * The file name does not start with `preflight-`, so `clearTimingResults('preflight')` (which the preflight runs at the start of its
 * standalone batches) leaves it alone.
 *
 * Built-ins only.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The snapshot's name in the results folder. */
export const STAGE_COSTS_FILE = 'stage-costs.json';

/** A snapshot older than this many days is not trusted. */
export const MAX_AGE_DAYS = 14;

const DAY_MS = 86_400_000;
const firstLine = (err) => String(err?.message ?? err).split('\n')[0];
const count = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The snapshot in `dir`, if it is whole, of the right shape and fresh. Never throws.
 *
 * @param {string} dir the results folder
 * @param {{ now?: () => number }} [options] the clock, in milliseconds
 * @returns {{ costs: { generatedAt: string, window?: number, runner?: string, runs: number, stages: Record<string, { ran: number, failed: number, medianMs: number }> } | null, why: string }}
 */
export function readStageCosts(dir, { now = Date.now } = {}) {
  const refuse = (why) => ({ costs: null, why });
  let text;
  try { text = readFileSync(join(dir, STAGE_COSTS_FILE), 'utf8'); } catch (err) {
    return refuse(err?.code === 'ENOENT' ? `no ${STAGE_COSTS_FILE} yet` : `${STAGE_COSTS_FILE} cannot be read: ${firstLine(err)}`);
  }
  let snap;
  try { snap = JSON.parse(text); } catch { return refuse(`${STAGE_COSTS_FILE} is not whole JSON`); }
  if (!isObject(snap) || !isObject(snap.stages) || !count(snap.runs)) return refuse(`${STAGE_COSTS_FILE} is not a stage-costs snapshot`);
  if (typeof snap.generatedAt !== 'string' || !Number.isFinite(Date.parse(snap.generatedAt))) return refuse(`${STAGE_COSTS_FILE} has no valid generatedAt`);
  for (const name of Object.keys(snap.stages)) {
    if (name === '__proto__') return refuse(`${STAGE_COSTS_FILE} has a __proto__ stage`);
    const row = snap.stages[name];
    if (!isObject(row) || !count(row.ran) || !count(row.failed) || !count(row.medianMs)) return refuse(`${STAGE_COSTS_FILE} has no valid cost row for stage ${JSON.stringify(name)}`);
  }
  const age = now() - Date.parse(snap.generatedAt);
  if (age > MAX_AGE_DAYS * DAY_MS) return refuse(`stale, ${Math.floor(age / DAY_MS)} days old (the limit is ${MAX_AGE_DAYS})`);
  return { costs: snap, why: '' };
}

/**
 * Write the snapshot whole: a temporary file in `dir`, renamed over the snapshot. A failed write leaves the old snapshot and no
 * temporary file, and throws.
 *
 * @param {string} dir the results folder (made when it does not exist)
 * @param {object} snapshot `{ generatedAt, window, runner, runs, stages }`
 */
export function writeStageCosts(dir, snapshot) {
  mkdirSync(dir, { recursive: true });
  const temporary = join(dir, `.${STAGE_COSTS_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(snapshot));
    renameSync(temporary, join(dir, STAGE_COSTS_FILE));
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
}
