/**
 * ONE runner for "do per-space work with a failure or a hang contained" (`Q-274`, bundle-53 G8).
 *
 * ## The question it answers, and the only one
 *
 * Every loop over the spaces outside a request — the TTL sweep, the legacy spill sweep, the claim walks, the scanners, the
 * reindex tick — had its own answer to "what if one space fails?" (a `catch { continue; }`, no catch at all, a per-unit catch that
 * logged on every pass) and none to "what if one operation HANGS?". A space whose operation never returned held the walk, and
 * with it the next tick, for as long as the driver waited. This is that answer, once:
 *
 *  - **isolation.** A space's failure is reported and the walk goes on. Returned, not swallowed: the caller whose correctness
 *    depends on WHICH spaces failed has them (`failed`, with the reason, which `links-convert-on-boot` summarises).
 *  - **the bound.** Each callback runs inside `withinHousekeepingBound` (`db/write-bound.ts`), so every database operation it
 *    issues — the deleters' internal ones included, by `AsyncLocalStorage` inheritance — ends at a figure of its own. A caller
 *    cannot forget it: it is inside the runner. `opMs` is a claim's shorter figure.
 *  - **one verdict.** A failure is asked `walkVerdict` (`util/space-failure.ts`) and nothing else. This file never asks whether a
 *    failure is a timeout or the store's condition itself; a test holds that, because two askers is how a hung space was once read
 *    as a dead store.
 *  - **the store is down.** The walk stops, reports ONE line for the step, and returns `storeDown: true`: a walk that carried on
 *    would pay one bound per space.
 *  - **the store only looks up.** K = 3 consecutive timeouts on distinct spaces, counted per TICK, end the walk (`stalled: true`)
 *    for the store that answers a ping and still stalls every operation. The count is a {@link WalkBudget} that every walk a tick
 *    starts shares through {@link withWalkBudget} (an `AsyncLocalStorage`, so no caller can forget to pass it); a walk outside a tick
 *    makes its own. Five walks of two timeouts must not each look healthy.
 *  - **quarantine.** A space that timed out is not asked again for a while — 60 s doubling to 300 s, reset by its first success,
 *    built on `util/endpoint-cooldown.ts` — by ANY walk, a full scan included: without it, every claim of every space waits one bound
 *    for the one hung space. It begins on the FIRST timeout, before the walk's next slot enters. A write to the space
 *    (`markSpaceMayHaveWork`) lifts it for ONE probe ({@link liftQuarantine}), and the probe is single-flight per space. A
 *    quarantined space is neither a success nor a timeout to the tick, and a claim walk neither notes it empty nor claimed.
 *
 * ## `eachUnit`: the units inside a space
 *
 * A sub-unit (a collection, an index, a half-step) is isolated INSIDE a space's callback by {@link eachUnit}: an ordinary unit
 * failure is reported and the loop goes on; a `store-down` or `space-timeout` verdict is RETHROWN to the enclosing walk, because
 * the next unit would only pay another bound against the same hung space. A unit failure makes the space `failed` (the caller is told) but
 * not a success (the throttle on its line is kept).
 *
 * ## The claim walk
 *
 * `claimAcross` (`util/work-signal.ts`) is {@link walkSpaces} with `stopAfterFirst` and `opMs: CLAIM_OP_MS`: the outcome of each
 * space is `ok` (with the callback's value: a job, or nothing), `failed` or `skipped`, which is exactly what its `noteEmpty` /
 * `noteClaimed` decision needs. A claim that the bound ended cannot land (a plain write is ended by the SERVER first); what remains
 * is a reply lost on the network, which burns an attempt that the stall reset returns.
 *
 * ## What it does not do
 *
 * It does not choose the spaces: the caller passes `concreteSpaces()` or `concreteSpaceIds()`. It does not bound what is not a
 * database operation (a model call, a directory walk). Request routes, the sync engine and boot (`initAllSpaces`) are not walks of
 * this kind: a boot that cannot initialise a space must fail.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { housekeepingOpMs, withinHousekeepingBound } from '../db/write-bound.js';
import { storeAnswers as defaultStoreAnswers } from '../db/store-answers.js';
import { endpointCooldown, type EndpointCooldown } from './endpoint-cooldown.js';
import { signalHousekeeping } from './housekeeping-signals.js';
import { peerText } from './log.js';
import { mapLimit } from './map-limit.js';
import {
  defaultSpaceFailureReporter, failureReason, walkVerdict, type BoundNote, type SpaceFailureReporter,
} from './space-failure.js';

/** How many spaces in a row, on distinct spaces, may time out before the store is taken to be stalled. Per tick. */
export const STALLED_AFTER_TIMEOUTS = 3;
/** The first quarantine of a space that timed out, ms. */
export const QUARANTINE_BASE_MS = 60_000;
/** The longest a quarantine grows to, ms. */
export const QUARANTINE_MAX_MS = 300_000;

const HOUSEKEEPING_ENV = 'YTHRIL_HOUSEKEEPING_OP_TIMEOUT_MS';

/** A space as a walk is handed it: its id, or the config record (`concreteSpaces()`). */
export type SpaceRef = string | { readonly id: string };
const idOf = (space: SpaceRef): string => (typeof space === 'string' ? space : space.id);

/** What a callback is handed beside the space. `step` may be set to a sub-step, which is what a failure is then reported under. */
export interface WalkContext {
  readonly spaceId: string;
  step: string;
}

class Context implements WalkContext {
  /** Every value `step` has held: a success forgets what a failure under each of them said. */
  readonly visited = new Set<string>();
  private current: string;
  constructor(readonly spaceId: string, step: string) { this.current = step; this.visited.add(step); }
  get step(): string { return this.current; }
  set step(value: string) { this.current = value; this.visited.add(value); }
}

/** One failure, with the step and unit it happened in, and the reason a summary can quote. */
export interface FailedUnit { spaceId: string; step: string; reason: string; unit?: string }
export type WalkStatus = 'ok' | 'failed' | 'skipped';
export interface WalkOutcome<R> { spaceId: string; status: WalkStatus; value?: R }

export interface WalkResult<R> {
  /** Every failure: a space's own, and each unit that failed inside one. */
  failed: FailedUnit[];
  /** One entry per space the walk reached, in the order given: `skipped` for a quarantined one. A space after a stop has none. */
  outcomes: WalkOutcome<R>[];
  /** The ids of the quarantined spaces that were passed over. */
  skipped: string[];
  /** The walk stopped because the store is not answering. */
  storeDown?: true;
  /** The walk stopped because K spaces timed out in a row. */
  stalled?: true;
}

export interface WalkOptions<R> {
  /** How many spaces run at once. Default 1. */
  limit?: number;
  /** When a failed space is tried again, in the words of the line: `next cycle` (default), `next tick`. */
  when?: string;
  /** The per-operation bound of each callback. Default `housekeepingOpMs()`; a claim passes `CLAIM_OP_MS`. */
  opMs?: number;
  /** Stop after the first space whose value this accepts: a claim walk stops at the first job. Not asked of a failed space. */
  stopAfterFirst?: (value: R, spaceId: string) => boolean;
  /** The tick's budget. Default the ambient one ({@link withWalkBudget}), else a budget of this walk's own. */
  budget?: WalkBudget;
}

/**
 * What the walks of ONE tick share: the run of consecutive timeouts on distinct spaces, and whether the store is already known
 * to be down. A space timing out three times is one space; a success (or an ordinary failure: the store answered) clears the run.
 */
export class WalkBudget {
  private readonly timedOut = new Set<string>();
  private trip = false;
  private down: { err: unknown } | undefined;
  constructor(readonly max: number = STALLED_AFTER_TIMEOUTS) {}

  /** A space timed out. True exactly once: when this one is the K-th distinct space in the run. */
  noteTimeout(spaceId: string): boolean {
    if (this.trip) return false;
    this.timedOut.add(spaceId);
    if (this.timedOut.size < this.max) return false;
    this.trip = true;
    return true;
  }

  /** A space answered: the run is broken. */
  noteSuccess(): void { if (!this.trip) this.timedOut.clear(); }

  /** The store was found not to answer: later walks in the tick stop at once instead of paying a bound to learn it again. */
  noteStoreDown(err: unknown): void { this.down ??= { err }; }

  get tripped(): boolean { return this.trip; }
  get storeDown(): { err: unknown } | undefined { return this.down; }
}

const budgets = new AsyncLocalStorage<WalkBudget>();

/**
 * Run `fn` — one tick of a repeating job — with a {@link WalkBudget} that every walk it starts shares. Ambient, so a walk three
 * calls down is counted without anyone passing it.
 */
export function withWalkBudget<T>(fn: () => Promise<T>, budget: WalkBudget = new WalkBudget()): Promise<T> {
  return budgets.run(budget, fn);
}

/** What `eachUnit` needs to know about the walk it is inside. */
interface Frame {
  readonly ctx: Context;
  readonly spaceId: string;
  readonly when: string;
  readonly storeAnswers: () => Promise<boolean>;
  readonly reporter: SpaceFailureReporter;
  readonly unitFailures: FailedUnit[];
}
const frames = new AsyncLocalStorage<Frame>();

type UnitLabel<U> = (unit: U, index: number) => string;
const unitLabel = <U>(unit: U, index: number): string => {
  if (typeof unit === 'string') return unit;
  const named = unit as { name?: unknown; id?: unknown } | null;
  if (typeof named?.name === 'string') return named.name;
  if (typeof named?.id === 'string') return named.id;
  return `unit ${index}`;
};

/**
 * Run `fn` over the sub-units of the space being walked (collections, indexes, half-steps), isolating an ordinary failure per
 * unit: it is reported under the walk's step with the unit named, and the loop goes on. A `store-down` or `space-timeout`
 * verdict is RETHROWN, unreported, to the enclosing walk, which reports it once for the space and ends the callback (the next unit
 * would pay another bound against the same hung space).
 *
 * THROWS when called outside a walk's callback: it reports against the space being walked, and with no space there is nothing to
 * report against.
 */
export async function eachUnit<U>(
  units: readonly U[], fn: (unit: U, index: number) => Promise<unknown>, label: UnitLabel<U> = unitLabel,
): Promise<{ failed: { unit: string; reason: string }[] }> {
  const frame = frames.getStore();
  if (!frame) throw new Error('eachUnit must be called inside an eachSpace / walkSpaces callback: it reports against the space being walked');
  const failed: { unit: string; reason: string }[] = [];
  for (const [index, unit] of units.entries()) {
    try {
      await fn(unit, index);
    } catch (err) {
      const verdict = await walkVerdict(err, { storeAnswers: frame.storeAnswers });
      if (verdict !== 'space-failure') throw err;
      const name = label(unit, index);
      frame.reporter.spaceFailure(frame.ctx.step, frame.spaceId, err, { unit: name, when: frame.when });
      const reason = failureReason('space-failure', err);
      failed.push({ unit: name, reason });
      frame.unitFailures.push({ spaceId: frame.spaceId, step: frame.ctx.step, unit: name, reason });
    }
  }
  return { failed };
}

export interface WalkDeps {
  /** The clock, for a test. */
  now?: () => number;
  /** "Does the store answer?": the real ping by default; a test says what it likes. */
  storeAnswers?: () => Promise<boolean>;
  /** Where lines and counters go. Default the process-wide reporter. */
  reporter?: SpaceFailureReporter;
}

interface Quarantine { cooldown: EndpointCooldown; lifted: boolean; probing: boolean }

export interface HousekeepingWalk {
  walkSpaces<S extends SpaceRef, R>(
    step: string, spaces: readonly S[], fn: (space: S, ctx: WalkContext) => Promise<R>, opts?: WalkOptions<R>,
  ): Promise<WalkResult<R>>;
  eachSpace<S extends SpaceRef>(
    step: string, spaces: readonly S[], fn: (space: S, ctx: WalkContext) => Promise<unknown>, opts?: Omit<WalkOptions<void>, 'stopAfterFirst'>,
  ): Promise<WalkResult<void>>;
  eachUnit: typeof eachUnit;
  /** A write marked the space: let ONE probe through its quarantine now. A space not in quarantine is left alone. */
  liftQuarantine(spaceId: string): void;
  /** The spaces in quarantine right now. */
  quarantinedSpaces(): string[];
}

/**
 * A walk runner with a quarantine map, clock, store question and reporter of its own. The process has ONE (the module's exports),
 * so every walk shares its quarantine; a test makes its own so nothing is shared between cases.
 */
export function createHousekeepingWalk(
  { now = Date.now, storeAnswers = defaultStoreAnswers, reporter = defaultSpaceFailureReporter }: WalkDeps = {},
): HousekeepingWalk {
  const quarantine = new Map<string, Quarantine>();

  const quarantinedSpaces = (): string[] =>
    [...quarantine].filter(([, q]) => q.cooldown.coolingDown(now())).map(([id]) => id);
  const gauge = (): void => signalHousekeeping({ type: 'quarantined-spaces', count: quarantinedSpaces().length });

  /** May this space be run now? A quarantined one may not, except for the one probe once its window is over or a write lifted it. */
  const admit = (spaceId: string): boolean => {
    const q = quarantine.get(spaceId);
    if (!q) return true;
    if (q.probing) return false;
    if (q.cooldown.coolingDown(now()) && !q.lifted) return false;
    q.lifted = false;
    q.probing = true;
    return true;
  };

  /** The space timed out: begin (or double) its quarantine. Returns its length in seconds. */
  const startQuarantine = (spaceId: string): number => {
    let q = quarantine.get(spaceId);
    if (!q) {
      q = { cooldown: endpointCooldown(`Housekeeping quarantine (space '${peerText(spaceId)}')`, { baseMs: QUARANTINE_BASE_MS, maxMs: QUARANTINE_MAX_MS }), lifted: false, probing: false };
      quarantine.set(spaceId, q);
    }
    q.lifted = false;
    q.probing = false;
    const at = now();
    q.cooldown.failed(at);
    gauge();
    return Math.round(((q.cooldown.until() ?? at) - at) / 1000);
  };

  /** The space answered: it is not hung. */
  const endQuarantine = (spaceId: string): void => {
    const q = quarantine.get(spaceId);
    if (!q) return;
    q.cooldown.succeeded();
    quarantine.delete(spaceId);
    gauge();
  };

  async function walkSpaces<S extends SpaceRef, R>(
    step: string, spaces: readonly S[], fn: (space: S, ctx: WalkContext) => Promise<R>, opts: WalkOptions<R> = {},
  ): Promise<WalkResult<R>> {
    const { limit = 1, when = 'next cycle', opMs, stopAfterFirst } = opts;
    const budget = opts.budget ?? budgets.getStore() ?? new WalkBudget();
    const failed: FailedUnit[] = [];
    const slots: (WalkOutcome<R> | undefined)[] = new Array(spaces.length);
    const result: WalkResult<R> = { failed, outcomes: [], skipped: [] };

    const finish = (): WalkResult<R> => {
      result.outcomes = slots.filter((o): o is WalkOutcome<R> => o !== undefined);
      result.skipped = result.outcomes.filter(o => o.status === 'skipped').map(o => o.spaceId);
      return result;
    };

    // A tick that already knows must not spend a bound to learn it again.
    if (budget.storeDown) { reporter.storeDown(step, budget.storeDown.err); result.storeDown = true; return finish(); }
    if (budget.tripped) { reporter.storeStalled(step, budget.max); result.stalled = true; return finish(); }

    const bound: BoundNote = opMs === undefined ? { ms: housekeepingOpMs(), env: HOUSEKEEPING_ENV } : { ms: opMs };
    let stopped = false;

    await mapLimit(spaces, limit, async (space, index) => {
      if (stopped) return;
      const spaceId = idOf(space);
      if (!admit(spaceId)) { slots[index] = { spaceId, status: 'skipped' }; return; }

      const ctx = new Context(spaceId, step);
      const frame: Frame = { ctx, spaceId, when, storeAnswers, reporter, unitFailures: [] };
      let value: R | undefined;
      let thrown: { err: unknown } | undefined;
      try {
        value = await frames.run(frame, () => withinHousekeepingBound(() => fn(space, ctx), opMs === undefined ? undefined : { opMs }));
      } catch (err) {
        thrown = { err };
      }
      failed.push(...frame.unitFailures);

      if (!thrown) {
        // The space answered. A unit that failed inside it is the caller's to know, and keeps its throttle (not a recovery).
        endQuarantine(spaceId);
        budget.noteSuccess();
        if (frame.unitFailures.length > 0) { slots[index] = { spaceId, status: 'failed', value }; return; }
        for (const visited of ctx.visited) reporter.recovered(visited, spaceId);
        slots[index] = { spaceId, status: 'ok', value };
        if (stopAfterFirst?.(value as R, spaceId)) stopped = true;
        return;
      }

      const { err } = thrown;
      slots[index] = { spaceId, status: 'failed' };
      const verdict = await walkVerdict(err, { storeAnswers });
      if (verdict === 'store-down') {
        const held = quarantine.get(spaceId);
        if (held) held.probing = false;
        failed.push({ spaceId, step: ctx.step, reason: failureReason(verdict, err) });
        reporter.storeDown(step, err);
        budget.noteStoreDown(err);
        result.storeDown = true;
        stopped = true;
        return;
      }
      failed.push({ spaceId, step: ctx.step, reason: failureReason(verdict, err, bound) });
      if (verdict === 'space-timeout') {
        const quarantineSec = startQuarantine(spaceId);
        reporter.spaceFailure(ctx.step, spaceId, err, { kind: verdict, when, quarantineSec, bound });
        if (budget.noteTimeout(spaceId)) {
          reporter.storeStalled(step, budget.max);
          result.stalled = true;
          stopped = true;
        }
        return;
      }
      endQuarantine(spaceId);
      budget.noteSuccess();
      reporter.spaceFailure(ctx.step, spaceId, err, { kind: verdict, when });
    });

    return finish();
  }

  return {
    walkSpaces,
    eachSpace: (step, spaces, fn, opts) => walkSpaces(step, spaces, async (space, ctx) => { await fn(space, ctx); }, opts),
    eachUnit,
    liftQuarantine(spaceId) {
      const q = quarantine.get(spaceId);
      if (q) q.lifted = true;
    },
    quarantinedSpaces,
  };
}

const shared = createHousekeepingWalk();

/** {@link HousekeepingWalk.walkSpaces} on the process-wide runner. */
export const walkSpaces: HousekeepingWalk['walkSpaces'] = shared.walkSpaces;
/** {@link HousekeepingWalk.eachSpace} on the process-wide runner. */
export const eachSpace: HousekeepingWalk['eachSpace'] = shared.eachSpace;
/** {@link HousekeepingWalk.liftQuarantine} on the process-wide runner: `markSpaceMayHaveWork` calls it. */
export const liftQuarantine: HousekeepingWalk['liftQuarantine'] = shared.liftQuarantine;
/** {@link HousekeepingWalk.quarantinedSpaces} on the process-wide runner. */
export const quarantinedSpaces: HousekeepingWalk['quarantinedSpaces'] = shared.quarantinedSpaces;
