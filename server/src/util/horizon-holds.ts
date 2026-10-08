/**
 * Hold a horizon BELOW the writes still in flight — the one primitive, `heldWhile`, and everything a hold needs around it.
 *
 * ## The question it answers
 *
 * A reader that pages by a position (a seq, an instant) and moves its cursor to the last row it saw loses any row that lands
 * BELOW the cursor afterwards. So a position that a write has taken and not yet committed must stop every reader below it
 * until the write ends. That is the seq horizon (`util/seq.ts`, `Q-196`) and it is the file-tombstone position
 * (`files/tombstones.ts`, `Q-346`): instances of one hold, each with its own kind of floor (a number, an ISO instant).
 *
 * ## Why a module, and what a copy drops
 *
 * It was the seq module's own machinery until the second site needed it, and a copy of it is the one that fails quietly:
 *
 * - **The release is in a `finally`.** A write that throws releases too, or the horizon sticks and every reader of the space
 *   stalls below it for ever (`Q-196`).
 * - **The write is bounded by the hold.** `heldWhile` runs it inside `withinWriteBound` (`Q-213`), so a write that never
 *   settles ends within the bound and the hold ends with it. A hold with no bound is a stalled replication with every cycle
 *   reporting success.
 * - **A hold names its holder** (`requireHolder`, `Q-200`). The release line and the watchdog name it, and a stall nobody can
 *   name is the defect that rule fixed.
 * - **A hold that stalls is VISIBLE.** The release line says every hold held past `holdWarnMs()` however it ended, and one
 *   watchdog (`startHorizonHoldWatchdog`) names a hold that has not ended yet, once, for EVERY registered instance.
 *
 * The floor is the instance's: this module compares floors with `<` (numbers, and ISO instants of one fixed width) and
 * decides nothing about how a floor is chosen or what a reader does below it.
 *
 * ## Each instance writes its own lines
 *
 * An instance gives its noun, its floor's name and its readers (`HoldWording`), so a line reads in the words an operator
 * greps for: `seq horizon held 31.0s space=s seq=4 holder=fact.update ended=timeout`, and for the position
 * `file tombstone position held 31.0s space=s at=2026-… holder=… ended=ok`. The words are the instance's, the rule is one.
 */

import { withinWriteBound, holdWarnMs } from '../db/write-bound.js';
import { isWriteTimeout } from '../db/write-timeout.js';
import { log, peerText } from './log.js';
import { warnOnce } from './warn-once.js';
import { intervalJob } from './interval-job.js';

/** The words an instance's lines and errors are written in. */
export interface HoldWording {
  /** What the lines start with: `seq horizon`, `file tombstone position`. */
  readonly noun: string;
  /** The key the floor is printed under: `seq`, `at`. */
  readonly floorKey: string;
  /** What the floor is called in a sentence: `seq`, `position`. */
  readonly floorName: string;
  /** Who is held below it, as the subject of a sentence: `every seq-paged reader of the space`. */
  readonly readers: string;
}

/**
 * One hold on a space's horizon: the floor it registered (an instance may raise it once the write's own position is known),
 * when it was registered, and WHO holds it (`Q-200`).
 */
export interface Hold<F extends number | string> {
  floor: F;
  readonly since: number;
  readonly holder: string;
}

/** How a hold ended, for its release line: its write succeeded, a bound ended it, or it failed otherwise. */
export type HoldEnd = 'ok' | 'timeout' | 'error';
const endOf = (err: unknown): HoldEnd => (isWriteTimeout(err) ? 'timeout' : 'error');

/** Open holds are warned about once each, whichever instance holds them. */
const holdWarnings = warnOnce<object>();

/** Every instance created in this process, for the one watchdog. */
const instances = new Set<HorizonHolds<number | string>>();

/**
 * The open holds of one KIND, per space: an instance of the hold. Created once, at module level, by the module that owns the
 * floor (`seqHolds` in `util/seq.ts`, `positionHolds` in `files/tombstones.ts`).
 */
export class HorizonHolds<F extends number | string> {
  private readonly bySpace = new Map<string, Set<Hold<F>>>();

  constructor(readonly wording: HoldWording) {
    instances.add(this as unknown as HorizonHolds<number | string>);
  }

  /** A hold must say who holds it: the release line and the watchdog name it, and an unnamed stall is the defect. */
  requireHolder(holder: unknown): asserts holder is string {
    if (typeof holder !== 'string' || !/^\S+$/.test(holder)) {
      throw new Error(`a ${this.wording.floorName} hold must name its holder (one word, no spaces), got ${JSON.stringify(holder)}`);
    }
  }

  /** Register a hold at `floor`. Synchronous, so the caller that took its floor a moment ago is held from that moment. */
  enter(spaceId: string, floor: F, holder: string): Hold<F> {
    this.requireHolder(holder);
    const h: Hold<F> = { floor, since: Date.now(), holder };
    let holds = this.bySpace.get(spaceId);
    if (!holds) { holds = new Set(); this.bySpace.set(spaceId, holds); }
    holds.add(h);
    return h;
  }

  /** The lowest floor held (or being taken) and not yet released, or undefined when the space holds nothing. */
  lowest(spaceId: string): F | undefined {
    const holds = this.bySpace.get(spaceId);
    if (!holds || holds.size === 0) return undefined;
    let lowest: F | undefined;
    for (const h of holds) if (lowest === undefined || h.floor < lowest) lowest = h.floor;
    return lowest;
  }

  /** How long the oldest hold on `spaceId` has been held, in seconds — 0 when it holds nothing. For the gauge. */
  oldestAgeSeconds(spaceId: string): number {
    const holds = this.bySpace.get(spaceId);
    if (!holds || holds.size === 0) return 0;
    let oldest = Infinity;
    for (const h of holds) if (h.since < oldest) oldest = h.since;
    return Math.max(0, (Date.now() - oldest) / 1000);
  }

  /**
   * Release a hold, and say so when it was held past `holdWarnMs()` — EVERY such hold, whichever way it ended, so a slow write
   * that eventually succeeded is as visible as one the bound ended. One line per hold, never per write.
   */
  release(spaceId: string, h: Hold<F>, ended: HoldEnd): void {
    const holds = this.bySpace.get(spaceId);
    holds?.delete(h);
    if (holds && holds.size === 0) this.bySpace.delete(spaceId);
    holdWarnings.forget(h);
    const age = Date.now() - h.since;
    if (age >= holdWarnMs()) {
      const w = this.wording;
      log.warn(`${w.noun} held ${peerText((age / 1000).toFixed(1))}s space=${peerText(spaceId)} ${w.floorKey}=${peerText(String(h.floor))} holder=${peerText(h.holder)} ended=${ended}`
        + ` — ${w.readers} was held below this ${w.floorName} for that long`);
    }
  }

  /** Warn once for each open hold older than `holdWarnMs()`. */
  warnStalled(now: number): void {
    const w = this.wording;
    for (const [spaceId, holds] of this.bySpace) {
      for (const h of holds) {
        const age = now - h.since;
        if (age < holdWarnMs()) continue;
        // The space id and the holder through `peerText`, as the release line names them (bundle-30 I6, C8).
        holdWarnings(h, () => log.warn(`${w.noun} held ${(age / 1000).toFixed(1)}s and still open: space=${peerText(spaceId)} `
          + `${w.floorKey}=${peerText(String(h.floor))} holder=${peerText(h.holder)} — ${w.readers} is held below it until it ends`));
      }
    }
  }
}

/**
 * Run `fn` holding `h` of `holds`, inside a write-bound scope so every operation it issues ends within the bound (`Q-213`),
 * and release the hold when it ENDS — whichever way. THE one primitive of every hold: no instance releases by hand. The scope
 * opens at the hold's registration (`B1`), so an allocation's own `$inc` is bounded too: it runs with the floor already
 * registered.
 */
export async function heldWhile<F extends number | string, T>(
  holds: HorizonHolds<F>, spaceId: string, h: Hold<F>, fn: () => Promise<T>,
): Promise<T> {
  let ended: HoldEnd = 'error';
  try {
    const out = await withinWriteBound(fn);
    ended = 'ok';
    return out;
  } catch (err) {
    ended = endOf(err);
    throw err;
  } finally {
    holds.release(spaceId, h, ended);
  }
}

/*
 * ── The watchdog (`Q-200`) ────────────────────────────────────────────────────────────────────────────────────
 *
 * The release line speaks when a hold ENDS. A hold that has not ended yet — the one stopping replication right now — is named
 * by the watchdog, once per hold, as soon as it is older than `holdWarnMs()`. One for every instance (the seq horizon and the
 * file-tombstone position are scanned by the same tick), started with the background services, unref'd so it never keeps the
 * process alive, and stopped on shutdown.
 */

/**
 * The watchdog is an interval job (`Q-317`) whose interval is a FUNCTION: a quarter of the hold warning, at least 250 ms, read when
 * the job starts (`intervalJob` reads it once per start). `startHorizonHoldWatchdog` is a restart (`stop(); start()`), so a hold figure
 * changed since the last start is the one in force for the next. The tick is synchronous and touches no database, so it never
 * overlaps and the bound it runs inside has nothing to end. Its label is the one the operator's documentation names, and it
 * names the hold, not one kind of it, because the tick scans every instance.
 */
const watchdog = intervalJob('Horizon hold watchdog', () => Math.max(250, Math.floor(holdWarnMs() / 4)), () => {
  const now = Date.now();
  for (const holds of instances) holds.warnStalled(now);
});

export function startHorizonHoldWatchdog(): void {
  watchdog.stop();
  watchdog.start();
}

export function stopHorizonHoldWatchdog(): void {
  watchdog.stop();
}
