/**
 * What Ythril says about its own time per request, read by the harness (Q-976): the `Server-Timing` header on REST, the result's `_meta`
 * (`ythril/server-timing`) on an MCP tool call. `door-floor.mjs` (every door family) and `run.mjs` (the BSBM queries) read it here, so the
 * two tools parse one header alike. The phase names are the server's (`server/src/http/phase-timer.ts`).
 *
 * ## What it prevents
 *
 * - **Door overhead in an engine's figure.** A BSBM comparison with Oxigraph is like for like only on the engine's own time. `total` is the
 *   door's whole time (arrival to the headers: auth, rate limits, rights, verdict, rendering included); the engine's own time is `plan`
 *   (the engine's plan) plus `run` (the engine running to the answer collected), which lie inside it.
 * - **A missing figure read as a fast one.** An answer with no header, or with no `total`, `plan` or `run`, is refused by
 *   {@link timingOfAnswer}, naming what is missing; no caller can turn it into zero.
 */
import { median, percentile, summarize } from './stats.mjs';

/** The `_meta` key an MCP tool result carries its figures under. */
export const MCP_TIMING_META = 'ythril/server-timing';
/** The phase that is the door's whole time. */
export const DOOR_PHASE = 'total';
/** The phases that are the SPARQL engine's own work, summed (`sparql-answer.ts`: `plan`, then `run`). */
export const ENGINE_PHASES = ['plan', 'run'];

/** The entries of a `Server-Timing` value: `{ name: dur }` (durations of a phase that ran more than once are its sum). */
export function phasesOf(header) {
  const out = {};
  if (!header) return out;
  for (const raw of String(header).split(',')) {
    const [name, ...params] = raw.trim().split(';').map(s => s.trim());
    const dur = params.find(p => p.startsWith('dur='));
    if (name && dur) out[name] = Number(dur.slice(4));
  }
  return out;
}

/** The entries of an MCP tool result's `_meta` figures, as {@link phasesOf} answers a header (`{}` when the result carries none). */
export function mcpPhasesOf(result) {
  const held = result?._meta?.[MCP_TIMING_META];
  if (!held || typeof held !== 'object') return {};
  return Object.fromEntries(Object.entries(held).map(([phase, figure]) => [phase, Number(figure?.dur)]));
}

/**
 * The door's total and the engine's own time of one answer, in milliseconds. Throws, naming what is missing, when the answer carried no
 * figures or lacks `total`, `plan` or `run`: a figure that is not there is never zero.
 * @param {Record<string, number>} phases as {@link phasesOf} or {@link mcpPhasesOf} answer
 * @returns {{ doorMs: number, engineMs: number }}
 */
export function timingOfAnswer(phases) {
  if (Object.keys(phases).length === 0) throw new Error('the answer carried no Server-Timing figures');
  const missing = [DOOR_PHASE, ...ENGINE_PHASES].filter(p => !Number.isFinite(phases[p]));
  if (missing.length > 0) throw new Error(`the answer's Server-Timing lacks ${missing.join(', ')}`);
  return { doorMs: phases[DOOR_PHASE], engineMs: ENGINE_PHASES.reduce((sum, p) => sum + phases[p], 0) };
}

/**
 * What a result record keeps per Ythril query: the client's wall time summarised as `stats.mjs` does (`n`, `median`, `p95`, `min`, `max`),
 * the door's total and the engine's time as `{ median, p95 }`, and every measured run (`perRun`).
 * @param {{ wall: number, doorMs: number, engineMs: number }[]} runs the measured runs
 */
export function summarizeTimed(runs) {
  for (const key of ['doorMs', 'engineMs']) {
    if (runs.some(r => !Number.isFinite(r[key]))) throw new Error(`a measured run has no ${key}: a run without its server time is that query's error, not a time`);
  }
  const door = runs.map(r => r.doorMs);
  const engine = runs.map(r => r.engineMs);
  return {
    ...summarize(runs.map(r => r.wall)),
    door: { median: median(door), p95: percentile(door, 95) },
    engine: { median: median(engine), p95: percentile(engine, 95) },
    perRun: runs.map(r => ({ wallMs: r.wall, doorMs: r.doorMs, engineMs: r.engineMs })),
  };
}
