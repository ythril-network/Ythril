/**
 * What a failure inside a walk over the spaces MEANS, and how it is said (`Q-274`, bundle-53 G8).
 *
 * Two halves that are asked together and must not be asked apart: {@link walkVerdict} says what a failure was, and
 * {@link reportSpaceFailure} says it, once per window, in the words the docs quote.
 *
 * ## The verdict: one answer to "what did this failure mean to a walk"
 *
 * A background walk has three possible answers to a failure and, before this, four places gave them and disagreed:
 * `isWriteTimeout` (a bound of ours ended the operation), `isStoreUnreachable` (the store cannot answer), the boot retry's own
 * list, and every loop's own `catch`. A hung space read as a dead store stopped the walk for every space; a dead store read as one
 * space's fault cost one bound per space. So there is ONE function, and the walk runners (`eachSpace`, `eachUnit`, the claim walk,
 * the retention loop) are the only callers — `reportSpaceFailure` below is handed the verdict, never derives it, because it is
 * synchronous and runs in places that cannot await a ping.
 *
 * | the failure | the verdict |
 * |---|---|
 * | a CLASS or a server CODE of the store's condition (`db/store-condition.ts`) | `store-down`, at once, no ping |
 * | only a LABEL says "the driver would try again" | `store-down` when the store does not answer a ping, else the space's own |
 * | a bound of ours ended it (`isWriteTimeout`: `StoreTimeout`, `MongoOperationTimeoutError`, code 50) | `store-down` when the store does not answer a ping, else `space-timeout` |
 * | code 112 `WriteConflict`: one hot document | `space-failure` while the store answers |
 * | anything else | `space-failure` |
 *
 * **The ping is asked of a store that timed out an operation, because a timeout is not a store condition** (the two deadline
 * codes are kept out of `STORE_ERROR_CODES` on purpose): a hung space and a dead store both time out. The ping tells them apart,
 * and the walk's own breaker (K timeouts in a row, `util/housekeeping-walk.ts`) covers the store that answers a ping and still
 * stalls every operation.
 *
 * **A verdict never throws.** It runs in a `catch`; an error that cannot be read (a hostile getter) is a `space-failure`, and a
 * ping that throws is a store that does not answer.
 *
 * ## The report: one line per condition per window
 *
 * The three lines are the docs' (`docs/userguide/05-storage-data-and-audit.md`), and a test holds them word for word:
 *
 *  - `<step> failed for space '<id>'[ (<unit>)]: <reason> — retried <when>`
 *  - `<step> stopped: the store is not answering (<reason>) — retried next cycle`
 *  - `<step> stopped: <K> spaces timed out in a row; the store looks stalled — retried next cycle`
 *
 * A quarantined space says `retried after quarantine (<n>s)`; a timeout's reason names the bound that fired and the setting that
 * moves it. The line is said ONCE per (step, space, unit) per {@link SPACE_FAILURE_WINDOW_MS}, said again after the step
 * succeeded for that space (a recover-then-fail is news: {@link SpaceFailureReporter.recovered}), said again when a quarantine
 * begins or doubles, and bounded in memory ({@link SPACE_FAILURE_MAX_KEYS}: the keys are space ids and unit names). Every call
 * is COUNTED (`util/housekeeping-signals.ts`) whether its line is said or not, so a failure that repeats is a rate, not a line.
 *
 * **It never throws and never awaits.** A log sink that throws, a listener of the counter signal that throws, an id that is not
 * a string: none replaces the failure being reported, and a caller outside any walk (`sweepAfterMetaWrite`) has nothing above it
 * to catch one.
 */
import { errorChain } from '../db/error-chain.js';
import { storeConditionKind, storeIsNotAnswering } from '../db/store-condition.js';
import { writeErrorCode } from '../db/write-errors.js';
import { isWriteTimeout } from '../db/write-timeout.js';
import { LruMap } from './lru-map.js';
import { signalHousekeeping, type SpaceFailureKind } from './housekeeping-signals.js';
import { log, peerText } from './log.js';
import { warnOnce } from './warn-once.js';

/** The longest one condition is said once for, ms. A constant the docs cite, never typed in prose. */
export const SPACE_FAILURE_WINDOW_MS = 10 * 60_000;
/** The most conditions remembered at once: the keys are space ids and unit names, which a peer influences. */
export const SPACE_FAILURE_MAX_KEYS = 20_000;

/** The server's `WriteConflict`: two writers on one document — a hot record, not a sick space. */
const WRITE_CONFLICT = 112;

export type WalkVerdict = 'store-down' | 'space-timeout' | 'space-failure';

/** `storeAnswers`, injected: the real one is `db/store-answers.ts`; a test says what it likes. */
export interface VerdictDeps { storeAnswers: () => Promise<boolean> }

/** The store's answer to a ping, with a ping that throws taken as a store that does not answer. */
async function storeDoesAnswer(storeAnswers: () => Promise<boolean>): Promise<boolean> {
  try { return (await storeAnswers()) === true; } catch { return false; }
}

/**
 * What did this failure mean to a walk — see the module docblock for the table. Async because the ping is; every caller awaits
 * it (a Promise is truthy, so an unawaited verdict is a `store-down` that never was), and `housekeeping-walk.test.js` holds that.
 */
export async function walkVerdict(err: unknown, { storeAnswers }: VerdictDeps): Promise<WalkVerdict> {
  try {
    const chain = errorChain(err);
    const kinds = chain.map(storeConditionKind);
    if (kinds.some(k => k === 'class' || k === 'code')) return 'store-down';
    const labelOnly = kinds.includes('label');
    const timedOut = isWriteTimeout(err);
    if (!labelOnly && !timedOut) return 'space-failure';
    if (!(await storeDoesAnswer(storeAnswers))) return 'store-down';
    if (chain.some(e => writeErrorCode(e) === WRITE_CONFLICT)) return 'space-failure';
    return timedOut ? 'space-timeout' : 'space-failure';
  } catch {
    return 'space-failure';
  }
}

/** The bound a timeout ran into: its figure, and the setting that moves it when there is one (a claim's is fixed). */
export interface BoundNote { ms: number; env?: string }

/**
 * Why, in words for a log line: the error's own text, rendered for a log — or for a timeout the bound that fired and the setting
 * that moves it, because the driver's text for a timeout says nothing an operator can act on.
 */
export function failureReason(verdict: WalkVerdict, err: unknown, bound?: BoundNote): string {
  if (verdict !== 'space-timeout') return peerText(err);
  if (!bound) return 'a database operation ran past its time bound';
  return `a database operation ran past its time bound of ${bound.ms} ms${bound.env ? ` (${bound.env})` : ''}`;
}

export interface ReportOptions {
  /** A sub-unit of the step (a collection, an index, a half-step): its own condition, named in the line. */
  unit?: string;
  /** When the space is tried again: `next cycle`, `next tick`, ... Said in the line. */
  when?: string;
  /** How many records (or units) failed, when the line speaks for several: said in the line. */
  count?: number;
  /** The verdict this failure was given by the walk. A store-down is the step's stop line, not a space's. Default `space-failure`. */
  kind?: WalkVerdict;
  /** The quarantine this failure began, in seconds: the line says the space is retried after it, and a longer one is news. */
  quarantineSec?: number;
  /** The bound a `space-timeout` ran into. */
  bound?: BoundNote;
}

export interface SpaceFailureReporter {
  /** Say a space's failure of a step, once per window. Synchronous, never throws. */
  spaceFailure(step: string, spaceId: string, err: unknown, opts?: ReportOptions): void;
  /** Say that a step stopped because the store is not answering, once per window. */
  storeDown(step: string, err: unknown): void;
  /** Say that a step stopped because `k` spaces timed out in a row, once per window. */
  storeStalled(step: string, k: number): void;
  /**
   * The step succeeded for the space: the next failure of it is news. With `unit` — the same `unit` a failure was reported
   * under — only THAT unit's line is forgotten: a step that works through many units of a space (a pull's files, each its own
   * path) must not forget a still-failing sibling's line, or it is said again every cycle, and must not keep a memory of its
   * own to know which unit failed. Without `unit`, every unit of the (step, space) is forgotten.
   */
  recovered(step: string, spaceId: string, unit?: string): void;
  /** How many conditions are remembered. */
  readonly size: number;
}

export interface ReporterOptions {
  now?: () => number;
  max?: number;
  window?: number;
  /** Where a line goes. Default `log.warn`. */
  warn?: (line: string) => void;
}

const kindOf = (verdict: WalkVerdict | undefined): SpaceFailureKind =>
  verdict === 'space-timeout' ? 'timeout' : verdict === 'store-down' ? 'store_down' : 'failure';

/**
 * A reporter with its own memory and clock: the module's default is one instance, so every caller shares one throttle, and a test
 * makes its own.
 */
export function spaceFailureReporter(
  { now = Date.now, max = SPACE_FAILURE_MAX_KEYS, window = SPACE_FAILURE_WINDOW_MS, warn = (line: string) => { log.warn(line); } }: ReporterOptions = {},
): SpaceFailureReporter {
  const once = warnOnce<string>({ max, every: window, now });
  // Which full keys a (step, space) has said, so one recovery forgets every unit of it. Bounded like the keys it indexes.
  const saidFor = new LruMap<string, Set<string>>(max);

  const say = (key: string, version: unknown, line: string, indexAs?: string): void => {
    try {
      once(key, () => { try { warn(line); } catch { /* the sink's failure is not the reporter's */ } }, version);
      if (indexAs !== undefined) {
        const keys = saidFor.peek(indexAs) ?? new Set<string>();
        keys.add(key);
        saidFor.set(indexAs, keys);
      }
    } catch { /* the reporter never throws */ }
  };
  const count = (step: string, kind: SpaceFailureKind): void => signalHousekeeping({ type: 'space-failure', step, kind });
  const stepKeys = (step: string) => ({ down: `store-down\0${step}`, stalled: `stalled\0${step}` });
  const indexOf = (step: string, spaceId: string): string => `${step}\0${spaceId}`;
  /** The one key of a (step, space, unit) condition: said by `spaceFailure`, forgotten by `recovered` — spelled once. */
  const unitKey = (step: string, spaceId: string, unit: string | undefined): string => `space\0${step}\0${peerText(spaceId)}\0${unit ?? ''}`;

  const reporter: SpaceFailureReporter = {
    spaceFailure(step, spaceId, err, opts) {
      try {
        const o = opts ?? {};
        if (o.kind === 'store-down') { reporter.storeDown(step, err); return; }
        const verdict: WalkVerdict = o.kind ?? 'space-failure';
        count(step, kindOf(verdict));
        const reason = failureReason(verdict, err, o.bound);
        const unit = o.unit === undefined ? '' : ` (${peerText(o.unit)})`;
        const failed = o.count === undefined ? '' : ` (count: ${o.count})`;
        const when = o.quarantineSec === undefined ? (o.when ?? 'next cycle') : `after quarantine (${o.quarantineSec}s)`;
        const key = unitKey(step, spaceId, o.unit);
        say(key, o.quarantineSec ?? 0, `${step} failed for space '${peerText(spaceId)}'${unit}: ${reason}${failed} — retried ${when}`, indexOf(step, peerText(spaceId)));
      } catch { /* the reporter never throws */ }
    },
    storeDown(step, err) {
      try {
        count(step, 'store_down');
        say(stepKeys(step).down, 0, `${step} stopped: the store is not answering (${failureReason('store-down', err)}) — retried next cycle`);
      } catch { /* the reporter never throws */ }
    },
    storeStalled(step, k) {
      try {
        count(step, 'stalled');
        say(stepKeys(step).stalled, 0, `${step} stopped: ${k} spaces timed out in a row; the store looks stalled — retried next cycle`);
      } catch { /* the reporter never throws */ }
    },
    recovered(step, spaceId, unit) {
      try {
        const index = indexOf(step, peerText(spaceId));
        if (unit === undefined) {
          for (const key of saidFor.peek(index) ?? []) once.forget(key);
          saidFor.delete(index);
        } else {
          const key = unitKey(step, spaceId, unit);
          once.forget(key);
          const said = saidFor.peek(index);
          if (said?.delete(key) && said.size === 0) saidFor.delete(index);
        }
        // A space that finished is the store answering: a stop it said for this step is over.
        const keys = stepKeys(step);
        once.forget(keys.down);
        once.forget(keys.stalled);
      } catch { /* the reporter never throws */ }
    },
    get size() { return once.size; },
  };
  return reporter;
}

/** The process-wide reporter: every housekeeping caller shares one throttle. */
export const defaultSpaceFailureReporter: SpaceFailureReporter = spaceFailureReporter();

/**
 * Say that `step` failed for `spaceId`, once per window. **Synchronous and never throws** — for every caller, a walk or not
 * (`sweepAfterMetaWrite` reports a failure with no walk above it). A walk hands it the verdict (`opts.kind`) it ran
 * {@link walkVerdict} for; it does not derive one. A caller with no walk above it passes no kind, and a failure that says the
 * store is not answering (`storeIsNotAnswering`, the one question for code outside a walk) is then reported as `store-down` —
 * the stop line, not a space's failure — so no caller spells that decision itself.
 */
export function reportSpaceFailure(step: string, spaceId: string, err: unknown, opts?: ReportOptions): void {
  defaultSpaceFailureReporter.spaceFailure(step, spaceId, err, opts?.kind === undefined && storeNotAnswering(err) ? { ...opts, kind: 'store-down' } : opts);
}

/**
 * {@link storeIsNotAnswering} that never throws, for a report that runs in a `catch`: an error that cannot be read (a hostile
 * getter) is not a store that is not answering, and it must not replace the failure being reported.
 */
function storeNotAnswering(err: unknown): boolean {
  try { return storeIsNotAnswering(err); } catch { return false; }
}

/** {@link SpaceFailureReporter.storeDown} on the process-wide reporter. */
export function reportStoreDown(step: string, err: unknown): void {
  defaultSpaceFailureReporter.storeDown(step, err);
}

/** {@link SpaceFailureReporter.storeStalled} on the process-wide reporter. */
export function reportStoreStalled(step: string, k: number): void {
  defaultSpaceFailureReporter.storeStalled(step, k);
}

/** {@link SpaceFailureReporter.recovered} on the process-wide reporter. */
export function reportSpaceRecovered(step: string, spaceId: string, unit?: string): void {
  defaultSpaceFailureReporter.recovered(step, spaceId, unit);
}
