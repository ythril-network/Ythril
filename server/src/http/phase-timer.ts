/**
 * The time a request spends in each of its phases, answered as a `Server-Timing` header on REST and as `_meta` on an MCP tool result
 * (bundle-378, Q-976, S1): the one per-request timer every door adds its phases to.
 *
 * ## The question it answers
 *
 * "Where did this request's time go?", asked by an operator reading one answer and by the door-floor benchmark reading many
 * (`benchmarks/rdf/door-floor.mjs`). The timer is set up once, above every route (`phaseTimingMiddleware`, mounted in
 * `app.ts` above the body parsers, so an answer a parser refuses carries the header too, and entered again below them by `rejoinPhaseTimer`), so no door
 * can forget it; a door only names its phases, through {@link timePhase} or {@link beginPhase}.
 *
 * ## What it prevents
 *
 * - **A door that is not measured.** The header is written by the middleware just before the response's headers go out, whatever line of
 *   whatever route answered (a refusal of a guard included), so every door answers `total` and whatever phases ran.
 * - **A phase named by hand twice.** Phase names are a closed list ({@link PHASES}); `Server-Timing` metric names are tokens, so a name is
 *   never built from request data.
 * - **A count hidden in a sum.** A phase that ran more than once in one request (a resolution repeated) says so (`desc="n=<count>"`), so a
 *   regression to a double computation shows on the wire.
 * - **Time from outside the request.** Phases are recorded only inside the request's async context; work started by the request that
 *   outlives its answer adds to a timer nobody reads again, never to another request's.
 *
 * ## The phases
 *
 * `total` is arrival to the headers. `auth` is the bearer's resolution (`resolveAuthOrFail`), `rate` every rate limiter the request met, and
 * `scope` the resolution of the spaces a request reads (a view's members, the readable spaces of a list). `door` is `total` less `auth` and
 * `rate`: the route's own work, the phases below included. A door's own phases (SPARQL's `parse`, `members`, `verdict`, `plan`, `run`,
 * `render`, and `schema` when the RDF schema checks were computed rather than read from their cache) lie inside `door` and may overlap
 * (an index verdict runs while the engine plans). Recall's (bundle-378, Q-976 S2): `embed` the query's vector (a kept one costs nothing),
 * `search` the vector searches, `fresh` the scan of records the vector index has not taken yet, `hydrate` the reads that fill results in
 * (inside `fresh`, and the file chunks' parents), `lexical` the text channel's fusion, `rerank` the cross-encoder; a recall over several
 * spaces runs each space's phases at once, so a phase may count more than once (`n=`). `text` (S3) the text index queries, sent when the
 * recall begins and run beside `embed`, `search` and `fresh`, so `lexical` holds only what is left of them; `introduce`, inside `lexical`,
 * the read that measures the similarity of a record only the text channel found.
 *
 * A record save's (S3), in the shared write path every record door and kind passes: `links` the door's check and write of the relationships
 * a body names, `read` the planner's read set, `decide` the planner, `version` the versions the write takes, `write` the write itself under
 * its landing hold, `index` the triple index's follower that runs after the hold settles, and `after` the work after the write lands (the
 * link rows, the embedding enqueue, the duplicate rules), which runs beside `index`.
 *
 * ## Where MCP cannot carry it
 *
 * An MCP call's HTTP answer is a stream whose headers go out before the tool runs, so its header names only what ran before (auth, rate).
 * The tool's figures ride in the tool result's `_meta` (`ythril/server-timing`), which the protocol allows on every result. A JSON-RPC
 * error (a malformed call the SDK refuses before any tool runs) has no `_meta`: its figures are the header's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Every phase a request may name, in the order a header lists them. */
export const PHASES = Object.freeze(['total', 'auth', 'rate', 'scope', 'door', 'parse', 'members', 'schema', 'verdict', 'plan', 'run', 'render',
  'embed', 'search', 'fresh', 'lexical', 'text', 'introduce', 'rerank', 'hydrate',
  'links', 'read', 'decide', 'version', 'write', 'index', 'after'] as const);
export type Phase = typeof PHASES[number];
/** The phases a door records itself (`total` and `door` are derived). */
export type RecordedPhase = Exclude<Phase, 'total' | 'door'>;

/** The `_meta` key an MCP tool result carries the figures under. */
export const MCP_TIMING_META = 'ythril/server-timing';

/** The header name. */
export const SERVER_TIMING = 'Server-Timing';

/** Decimal places a duration is written with: hundredths of a millisecond. */
const DUR_PLACES = 2;

/** One phase's figures: milliseconds summed over its runs, and how many runs. */
export interface PhaseFigure { dur: number; count: number }

/** The timer of one request. */
export class PhaseTimer {
  private readonly start = performance.now();
  private readonly figures = new Map<RecordedPhase, PhaseFigure>();
  /** Phases begun and not yet ended, each with its start: a header written meanwhile counts them up to now. */
  private readonly open = new Map<number, { phase: RecordedPhase; at: number }>();
  private nextOpen = 0;

  /** Add one run of `phase` that took `ms`. */
  add(phase: RecordedPhase, ms: number): void {
    const held = this.figures.get(phase);
    if (held) { held.dur += ms; held.count += 1; } else this.figures.set(phase, { dur: ms, count: 1 });
  }

  /** Begin a run of `phase`; the function answered ends it (a second call does nothing). */
  begin(phase: RecordedPhase): () => void {
    const id = this.nextOpen++;
    this.open.set(id, { phase, at: performance.now() });
    return () => {
      const held = this.open.get(id);
      if (!held) return;
      this.open.delete(id);
      this.add(phase, performance.now() - held.at);
    };
  }

  /** The figures now, by phase, in {@link PHASES} order: `total`, the recorded phases (an open one up to now), and `door`. */
  snapshot(): Map<Phase, PhaseFigure> {
    const now = performance.now();
    const recorded = new Map<RecordedPhase, PhaseFigure>([...this.figures].map(([p, f]) => [p, { ...f }]));
    for (const { phase, at } of this.open.values()) {
      const held = recorded.get(phase);
      if (held) { held.dur += now - at; held.count += 1; } else recorded.set(phase, { dur: now - at, count: 1 });
    }
    const total = now - this.start;
    const before = (recorded.get('auth')?.dur ?? 0) + (recorded.get('rate')?.dur ?? 0);
    const out = new Map<Phase, PhaseFigure>();
    for (const phase of PHASES) {
      if (phase === 'total') out.set(phase, { dur: total, count: 1 });
      else if (phase === 'door') out.set(phase, { dur: Math.max(0, total - before), count: 1 });
      else {
        const f = recorded.get(phase);
        if (f) out.set(phase, f);
      }
    }
    return out;
  }
}

const timers = new AsyncLocalStorage<PhaseTimer>();

/** The timer of the request whose async context this is, or `undefined` outside any request (a background job, a test). */
export const currentPhaseTimer = (): PhaseTimer | undefined => timers.getStore();

/** Run `fn` with `timer` as the request's timer: what the middleware does for each request, and a test for an act it drives in-process. */
export function runWithPhaseTimer<T>(timer: PhaseTimer, fn: () => T): T {
  return timers.run(timer, fn);
}

/** Begin a run of `phase` on the current request's timer; the function answered ends it. Outside a request it records nothing. */
export function beginPhase(phase: RecordedPhase): () => void {
  return timers.getStore()?.begin(phase) ?? NOTHING;
}
const NOTHING = (): void => undefined;

/**
 * Run `fn` as one run of `phase` on the current request's timer: a value is timed until it is returned, a promise until it settles, and a
 * throw ends the phase too. Outside a request `fn` simply runs.
 */
export function timePhase<T>(phase: RecordedPhase, fn: () => T): T {
  const end = beginPhase(phase);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    end();
    throw err;
  }
  if (result instanceof Promise) {
    result.then(end, end);
    return result;
  }
  end();
  return result;
}

/** The timer each response was given by {@link phaseTimingMiddleware}, for {@link rejoinPhaseTimer}. */
const TIMER_OF = new WeakMap<Response, PhaseTimer>();

/**
 * Put the request's timer back into the async context, for the middleware that runs after a step that loses it. The body parsers read the
 * request off the socket and call `next` from the socket's events, which run in the socket's context and not the request's, so the timer
 * (mounted above them, so their refusals carry the header) is entered again below them (`app.ts`).
 */
export function rejoinPhaseTimer(_req: Request, res: Response, next: NextFunction): void {
  const timer = TIMER_OF.get(res);
  if (timer) runWithPhaseTimer(timer, next); else next();
}

/** A middleware timed as one run of `phase`: from its call until it hands on (`next`) or the response's headers go out. */
export function timedMiddleware(phase: RecordedPhase, mw: RequestHandler): RequestHandler {
  return function timed(req: Request, res: Response, next: NextFunction): void {
    const end = beginPhase(phase);
    const onward: NextFunction = (err?: unknown) => { end(); next(err as Parameters<NextFunction>[0]); };
    try {
      const out: unknown = mw(req, res, onward);
      if (out instanceof Promise) out.then(end, end);
    } catch (err) {
      end();
      throw err;
    }
  };
}

/** The `Server-Timing` value of a snapshot: `name;dur=<ms>`, and `;desc="n=<count>"` for a phase that ran more than once. */
export function serverTimingValue(figures: ReadonlyMap<Phase, PhaseFigure>): string {
  return [...figures].map(([p, f]) => `${p};dur=${f.dur.toFixed(DUR_PLACES)}${f.count > 1 ? `;desc="n=${f.count}"` : ''}`).join(', ');
}

/** The `_meta` an MCP tool result carries: the current request's figures by phase, or nothing outside a request. */
export function mcpTimingMeta(): Record<string, Record<string, PhaseFigure>> {
  const timer = timers.getStore();
  if (!timer) return {};
  const figures: Record<string, PhaseFigure> = {};
  for (const [p, f] of timer.snapshot()) figures[p] = { dur: Number(f.dur.toFixed(DUR_PLACES)), count: f.count };
  return { [MCP_TIMING_META]: figures };
}

/**
 * The middleware that gives each request its timer and writes the header just before the response's headers go out. Wraps `res.writeHead`,
 * the one call every answer passes (Express's `send`, a stream's first write, a `HEAD`), so no route can answer without it; a header a
 * route set itself is replaced, never doubled.
 */
export function phaseTimingMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const timer = new PhaseTimer();
  TIMER_OF.set(res, timer);
  const writeHead = res.writeHead;
  res.writeHead = function withTiming(this: Response, ...args: Parameters<Response['writeHead']>): Response {
    if (!res.headersSent) res.setHeader(SERVER_TIMING, serverTimingValue(timer.snapshot()));
    return writeHead.apply(this, args) as Response;
  } as Response['writeHead'];
  runWithPhaseTimer(timer, next);
}
