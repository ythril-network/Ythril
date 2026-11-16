/**
 * The record of one run of `scripts/preflight.mjs`, its recording, and the report over the records (Q-864).
 *
 * ## What it prevents
 *
 * CI runs were recorded per suite and a local preflight recorded nothing, so the preflight's order (flow convention
 * `convention-preflight-cheapest-first-and-parallel`) was set from guesses: which stage takes how long on this machine, how that
 * moves, where a run stops. Three ways a recorder like this goes wrong are closed here, none of them left to the caller:
 *
 * - **A recorder that breaks or slows the run it measures.** {@link recordPreflightRun} never throws and is bounded in time: it
 *   spools the payload to `test-results/unrecorded/` FIRST (a local write), then drains it through
 *   `node scripts/test-times.mjs --drain-unrecorded` as a child killed at {@link RECORD_TIMEOUT_MS}. An unset instance, a refused
 *   token, a hung instance, a lock held by another recorder, a folder that cannot be written: each is ONE line the preflight
 *   prints, and the payload stays on disk for the next recorder that can reach the instance. The verdict and exit status of the
 *   preflight are decided before this is called and are not read from it.
 * - **A second recorder.** The write, the one-writer lock, the destination (`YTHRIL_TEST_RUNS_URL` / `YTHRIL_TEST_RUNS_TOKEN`)
 *   and the spool are `test-times.mjs`'s and `record-lock.mjs`'s, shared with the `Test-Run` records; this module builds a payload
 *   and asks that script to send it.
 * - **A record that says two things.** The stage list is the runner's own timings (`createStageRunner().timings()`), never parsed
 *   from output; {@link buildPreflightRunPayload} refuses a stage without a name, an unknown kind or outcome, and a mode that is
 *   neither `full` nor `static`, and checks the properties against `PREFLIGHT_RUN_SPEC` before anything is written.
 *
 * ## The report
 *
 * {@link preflightTrendLines} prints, for the records it is given (the newest N, from `test-times.mjs --preflight-trend`), each
 * run, then each stage's time in every run (oldest run first; `failed` for a stage that failed, `-` for one the run never reached)
 * and its median over the runs where it passed: the figure a plan is computed from (Q-865). A record whose stages cannot be read
 * is counted and skipped, never printed as a zero.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PREFLIGHT_RUN_SPEC, PREFLIGHT_RUN_FORMAT_VERSION, checkTelemetryProperties } from './telemetry-record.mjs';
import { spoolPayload } from './unrecorded-spool.mjs';
import { STAGE_KINDS } from './preflight-stages.mjs';
import { timingResultsDir } from '../../testing/_shared/timing-reporter.mjs';
import { LOCK_WAIT_ENV } from './record-lock.mjs';

/** The longest the preflight waits for the recording, in milliseconds: the child is killed at it and the payload stays spooled. */
export const RECORD_TIMEOUT_MS = 20_000;

/** How long the recorder child waits for the record lock when another recorder holds it (the recorder's own default is two minutes). */
const RECORD_LOCK_WAIT_MS = '5000';

const TEST_TIMES = resolve(fileURLToPath(new URL('../test-times.mjs', import.meta.url)));

const OUTCOMES = ['passed', 'failed', 'not-run'];
const MODES = ['full', 'static'];

const firstLine = (err) => String(err?.message ?? err).split('\n')[0];

/**
 * The `save_chrono` payload of one preflight run.
 *
 * @param {object} run
 * @param {Array<{ name: string, kind: string, ms: number, outcome: string }>} run.stages the runner's `timings()`
 * @param {'full'|'static'} run.mode
 * @param {string} run.startedAt ISO time the run began
 * @param {string} run.endedAt ISO time its verdict was reached
 * @param {string} run.commit
 * @param {string} run.branch
 * @param {boolean} run.dirty
 * @param {string} run.host
 */
export function buildPreflightRunPayload({ stages, mode, startedAt, endedAt, commit, branch, dirty, host }) {
  if (!MODES.includes(mode)) throw new Error(`preflight run record: mode must be ${MODES.join(' or ')}, not ${JSON.stringify(mode)}`);
  if (!Array.isArray(stages)) throw new Error('preflight run record: stages must be a list');
  const kept = stages.map((s, i) => {
    if (typeof s?.name !== 'string' || s.name === '') throw new Error(`preflight run record: stage ${i + 1} has no name`);
    if (!STAGE_KINDS.includes(s.kind)) throw new Error(`preflight run record: stage ${s.name} has kind ${JSON.stringify(s.kind)}, not one of ${STAGE_KINDS.join(', ')}`);
    if (!OUTCOMES.includes(s.outcome)) throw new Error(`preflight run record: stage ${s.name} has outcome ${JSON.stringify(s.outcome)}, not one of ${OUTCOMES.join(', ')}`);
    if (!Number.isFinite(s.ms) || s.ms < 0) throw new Error(`preflight run record: stage ${s.name} has a time that is not a count of milliseconds`);
    return { name: s.name, kind: s.kind, ms: Math.round(s.ms), outcome: s.outcome };
  });
  const wallMs = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(wallMs) || wallMs < 0) throw new Error('preflight run record: the run must end after it started, both as ISO times');
  const firstFailing = kept.find(s => s.outcome === 'failed');
  const properties = checkTelemetryProperties(PREFLIGHT_RUN_SPEC, {
    recordKey: `local:${host}:${startedAt}:preflight`,
    formatVersion: PREFLIGHT_RUN_FORMAT_VERSION, source: 'local', commit, branch, dirty, host, mode,
    outcome: firstFailing ? 'failed' : 'passed',
    ...(firstFailing ? { firstFailingStage: firstFailing.name } : {}),
    wallMs, stageCount: kept.length, stages: JSON.stringify(kept),
  });
  return {
    space: PREFLIGHT_RUN_SPEC.space, type: PREFLIGHT_RUN_SPEC.type,
    title: `preflight (${mode}) ${commit.slice(0, 7)} ${properties.outcome}`,
    status: 'completed', startsAt: startedAt, endsAt: endedAt, properties,
  };
}

/** What git says about the working tree, or `unknown` where it cannot say (not a checkout, no git): a record is still worth keeping. */
export function preflightRunIdentity(cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
  const ask = (...args) => { try { return git(...args) || 'unknown'; } catch { return 'unknown'; } };
  let dirty = false;
  try { dirty = git('status', '--porcelain').length > 0; } catch { /* not a checkout: nothing to be dirty */ }
  return { commit: ask('rev-parse', 'HEAD'), branch: ask('rev-parse', '--abbrev-ref', 'HEAD'), dirty, host: hostname() };
}

const shown = (cwd, p) => { const r = relative(cwd, p).split(sep).join('/'); return r.startsWith('..') || isAbsolute(r) ? p : r; };

/**
 * Keep `payload` on disk and send it, within a bound, and say what happened in ONE line. Never throws and never waits longer than
 * `timeoutMs`; the payload is spooled before anything else, so every failure leaves it kept.
 *
 * @param {object} payload from {@link buildPreflightRunPayload}
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, script?: string }} [options] `script` is the recorder, for a test
 * @returns {string}
 */
export function recordPreflightRun(payload, { cwd = process.cwd(), env = process.env, timeoutMs = RECORD_TIMEOUT_MS, script = TEST_TIMES } = {}) {
  let file;
  try {
    file = spoolPayload(join(timingResultsDir(cwd, env), 'unrecorded'), payload);
  } catch (err) {
    return `preflight: stage times not recorded: ${firstLine(err)}`;
  }
  try {
    const r = spawnSync(process.execPath, [script, '--drain-unrecorded'], {
      cwd, env: { ...env, [LOCK_WAIT_ENV]: env[LOCK_WAIT_ENV] ?? RECORD_LOCK_WAIT_MS },
      encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true,
    });
    if (!existsSync(file)) return `preflight: stage times recorded (${payload.properties.recordKey})`;
    const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('test-times:'));
    const why = r.error?.code === 'ETIMEDOUT' ? `the recorder did not finish within ${Math.round(timeoutMs / 1000)} s`
      : r.error ? firstLine(r.error)
        : (said ?? 'the recorder left it').replace(/^test-times: (not recorded: )?/, '').replace(/; kept .*$/, '');
    return `preflight: stage times not recorded: ${why}; kept ${shown(cwd, file)}`;
  } catch (err) {
    return `preflight: stage times not recorded: ${firstLine(err)}; kept ${shown(cwd, file)}`;
  }
}

// ---- the report ----------------------------------------------------------------------------------------------------

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** The median of numbers: the middle one, the mean of the two middle ones for an even count; undefined for none. */
function medianOf(values) {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A record's stages as a list, or null when the record is not one this report reads. */
function stagesOf(row) {
  const p = row?.properties;
  if (!p || typeof p.stages !== 'string' || !MODES.includes(p.mode) || typeof row.startsAt !== 'string') return null;
  let list;
  try { list = JSON.parse(p.stages); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const ok = list.every(s => typeof s?.name === 'string' && s.name !== '' && Number.isFinite(s.ms) && OUTCOMES.includes(s.outcome));
  return ok ? list : null;
}

/**
 * The report over the given records, as lines.
 *
 * @param {Array<{ startsAt: string, properties: object }>} rows `Preflight-Run` records, in any order
 * @returns {string[]}
 */
export function preflightTrendLines(rows) {
  const runs = [];
  let skipped = 0;
  for (const row of rows) {
    const stages = stagesOf(row);
    if (!stages) { skipped++; continue; }
    runs.push({ row, stages, p: row.properties });
  }
  runs.sort((a, b) => a.row.startsAt.localeCompare(b.row.startsAt));
  const lines = [];
  if (!runs.length) {
    if (skipped) lines.push(`preflight: skipped ${skipped} record(s) whose stages could not be read`);
    lines.push('preflight: no recorded preflight runs');
    return lines;
  }

  lines.push(`preflight runs: ${runs.length} shown, oldest first${skipped ? `; skipped ${skipped} record(s) whose stages could not be read` : ''}`);
  for (const [i, r] of runs.entries()) {
    const wall = Number.isFinite(r.p.wallMs) ? seconds(r.p.wallMs) : '-';
    lines.push(`run ${i + 1}  ${r.row.startsAt.slice(0, 16).replace('T', ' ')}  ${String(r.p.commit ?? '').slice(0, 7)}  ${r.p.mode}  ${r.p.outcome}  wall ${wall}`);
  }

  // The stages, in the newest run's order, then any an older run had that it did not.
  const names = [];
  for (const r of [...runs].reverse()) for (const s of r.stages) if (!names.includes(s.name)) names.push(s.name);
  const kindOf = new Map();
  for (const r of runs) for (const s of r.stages) kindOf.set(s.name, s.kind);

  lines.push('');
  lines.push('stage times per run (oldest first; failed = the stage failed, - = the run never reached it); median over the runs where the stage passed');
  const width = Math.max(...names.map(n => n.length));
  for (const name of names) {
    const cells = runs.map(r => {
      const s = r.stages.find(x => x.name === name);
      return !s || s.outcome === 'not-run' ? '-' : s.outcome === 'failed' ? 'failed' : seconds(s.ms);
    });
    const passed = runs.map(r => r.stages.find(x => x.name === name)).filter(s => s?.outcome === 'passed').map(s => s.ms);
    const med = medianOf(passed);
    lines.push(`${name.padEnd(width)}  ${String(kindOf.get(name) ?? '').padEnd(6)}  median ${med === undefined ? '-' : seconds(med)}  |  ${cells.join('  ')}`);
  }

  lines.push('');
  for (const mode of MODES) {
    const walls = runs.filter(r => r.p.mode === mode && Number.isFinite(r.p.wallMs)).map(r => r.p.wallMs);
    if (walls.length) lines.push(`${mode} runs: median wall time ${seconds(medianOf(walls))} over ${walls.length} run(s)`);
  }
  return lines;
}
