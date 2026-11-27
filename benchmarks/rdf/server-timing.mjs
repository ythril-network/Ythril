/**
 * What Ythril says about its own time per request, read by the harness (Q-976): the `Server-Timing` header on REST, the result's `_meta`
 * (`ythril/server-timing`) on an MCP tool call. `door-floor.mjs` (every door family) and `run.mjs` (the BSBM queries) read it here, and so do
 * the server's specs (`testing/standalone/_server-timing.mjs` re-exports {@link serverTimingOf}, {@link mcpTimingOf} and {@link mcpCallResult}), so every reader
 * parses one header alike. The phase names are the server's (`server/src/http/phase-timer.ts`).
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

/**
 * The entries of a `Server-Timing` header value, by name: `{ dur, count }`, `count` read from `desc="n=<count>"` (1 when the entry has none).
 * THE parser of the header: the harness and the specs (`testing/standalone/_server-timing.mjs` re-exports it) read one header one way. An entry is
 * split off by name, so a phase name inside another entry's description is never read as a phase.
 * @param {string | string[] | undefined | null} value the header as `node:http` hands it (a string, or a list when sent twice) or as `fetch` does
 * @returns {Map<string, { dur: number, count: number }> | null} `null` when there is no header, never an empty map: a spec cannot read "no phases" as "no header"
 */
export function serverTimingOf(value) {
  if (value === undefined || value === null) return null;
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  const out = new Map();
  for (const raw of text.split(',')) {
    const parts = raw.trim().split(';').map(p => p.trim());
    const name = parts[0];
    if (!name) continue;
    let dur = NaN;
    let count = 1;
    for (const p of parts.slice(1)) {
      const eq = p.indexOf('=');
      if (eq < 0) continue;
      const key = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
      if (key === 'dur') dur = Number(v);
      if (key === 'desc') {
        const m = /^n=(\d+)$/.exec(v);
        if (m) count = Number(m[1]);
      }
    }
    out.set(name, { dur, count });
  }
  return out;
}

/** The phases an MCP tool result carries in its `_meta`, as {@link serverTimingOf} answers a header; `null` when absent. */
export function mcpTimingOf(result) {
  const held = result?._meta?.[MCP_TIMING_META];
  if (!held || typeof held !== 'object') return null;
  return new Map(Object.entries(held).map(([name, v]) => [name, { dur: Number(v?.dur), count: Number(v?.count ?? 1) }]));
}

/** `{ name: dur }` of a timing map; entries with no duration are left out, and no timing is `{}`. */
const durationsOf = (timing) => Object.fromEntries([...(timing ?? [])].filter(([, v]) => !Number.isNaN(v.dur)).map(([name, v]) => [name, v.dur]));

/** The entries of a `Server-Timing` value: `{ name: dur }` (an entry with no `dur` is left out; `{}` for no header). */
export function phasesOf(header) {
  return durationsOf(serverTimingOf(header));
}

/** The entries of an MCP tool result's `_meta` figures, as {@link phasesOf} answers a header (`{}` when the result carries none). */
export function mcpPhasesOf(result) {
  return durationsOf(mcpTimingOf(result));
}

/**
 * One tool call on `POST /mcp` answered as its whole JSON-RPC result (its `_meta` included); `{ error }` for a JSON-RPC error, `null` when the answer
 * carries no message for the call. The event-stream reading lives here and nowhere else: a server that answers `text/event-stream` and one that answers JSON are read alike.
 */
export async function mcpCallResult(url, key, tool, args) {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const raw = await r.text();
  const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)) : [raw];
  for (const d of data) {
    let msg = null; try { msg = JSON.parse(d); } catch { /* not JSON */ }
    if (msg?.id === 1) return msg.result ?? { error: msg.error };
  }
  return null;
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
