/**
 * Hand out the next position of a space's stream, held until its write ends, and never at or below one handed out before.
 *
 * ## The question it answers
 *
 * "What is the next position of this space's stream, and who is held below it until the write that carries it is over?"
 * Extracted from the file tombstones' clock (`files/tombstones.ts`, Q-346) when the brain records needed the same thing: a
 * reader that pages by a position and moves its cursor to the last row it saw loses any row that lands BELOW the cursor
 * afterwards, so a position a write has taken and not yet committed must stop every reader below it until the write ends. A
 * second implementation of that rule is the one that fails quietly, and bundle-81 would otherwise have written it a third time
 * (the records stream, the file-tombstone stream, and the transaction's floor).
 *
 * ## What a stream is
 *
 * A {@link PositionStream} is a clock, a registry of open holds and a policy, built by {@link createPositionStream} and declared
 * by the module that owns what its positions mean: `sync/record-position-stream.ts` (every record family and the brain
 * tombstones, microseconds, a number) and `files/tombstones.ts` (file tombstones, milliseconds, an ISO instant). The clock imports
 * nothing from `config/` or `sync/`; a stream brings its own seed. The differences are parameters of the stream, never of a call:
 *
 *  - **the unit and so the encoding**: microseconds are a safe integer, milliseconds an ISO instant of fixed width;
 *  - **what a failed seed does**: the records stream REFUSES the write (`positions_seed_unavailable`), because the stored maximum
 *    can be above the wall clock after a restore and a stamp below a position already handed out is the one thing the clock
 *    promises never to do; the file stream stamps from the wall clock alone and says so (its own docblock gives its reason);
 *  - **how many positions a stamp takes**: a block of `count` consecutive microseconds for the records (`withPositionHeld`'s
 *    `count`), one shared instant for a file slice.
 *
 * ## What it does that a copy would drop
 *
 *  - **A stamp and its hold are taken in one tick**, so no reader can be handed a position above the stamp between the two.
 *  - **The release is in a `finally`, inside the write bound** (`heldWhile`, `util/horizon-holds.ts`, the one primitive): a write
 *    that throws or never settles still ends the hold.
 *  - **A seed that fails is not remembered**: the next caller reads it again.
 *  - **A concurrent allocation never moves the bound back**: `last` only grows.
 *  - **Every reader is capped by {@link settledPositionCap}**, which is computed and never stored (a read must not move the clock).
 *  - **A transaction holds a floor, not a stamp** ({@link withPositionFloorHeld}): a write inside a session has not committed when
 *    it returns, so the stamp's own hold would be released a commit too early. The hold is taken before the session starts and
 *    released in a `finally` after it ends, commit or abort; the caller cannot take the one without the other.
 *  - **The clock band is refused below its bound**: a microsecond stream's positions must sit above the legacy band (every carried
 *    5.6 seq, at most `MAX_SYNC_SEQ`), so a wall clock reading before 2005-09-05T05:58:26.843Z refuses to stamp
 *    (`positions_clock_unusable`) instead of handing out a position a peer's carried mark already covers.
 *
 * `last` is per space and per process. Tests set the wall clock through {@link setPositionClockSourceForTest}.
 */
import { HorizonHolds, heldWhile, type Hold, type HoldWording } from './horizon-holds.js';
import { MAX_SYNC_SEQ } from './seq.js';
import { PositionClockUnusable, PositionsSeedUnavailable } from './errors.js';

/** The unit a stream counts in: microseconds are a number (the records), milliseconds an ISO instant (the file tombstones). */
export type PositionUnit = 'microseconds' | 'milliseconds';

/** What a stream does with a seed it could not read: refuse the write, or stamp from the wall clock alone after saying so. */
export type SeedFailurePolicy =
  | { readonly policy: 'refuse' }
  | { readonly policy: 'wall-clock'; readonly report: (err: unknown, spaceId: string) => void };

export interface PositionStreamConfig<U extends PositionUnit> {
  /** Names the stream in its errors (`record position`, `file tombstone position`). */
  readonly name: string;
  readonly unit: U;
  /**
   * The highest position the stream has handed out for `spaceId` that is STORED or recorded, in the stream's unit (microseconds, or
   * epoch milliseconds), or `0` when none. Read once per space per process; a rejection is not remembered.
   */
  readonly seed: (spaceId: string) => Promise<number>;
  /** The wall clock in epoch milliseconds. Defaults to `Date.now`; a test replaces it through {@link setPositionClockSourceForTest}. */
  readonly now?: () => number;
  /** How the hold's release lines and watchdog say it; defaults to words built from `name`. */
  readonly wording?: HoldWording;
  /** Defaults to refusing. */
  readonly onSeedFailure?: SeedFailurePolicy;
}

/** This instance's clock for one space: the last position it handed out, in the stream's unit. */
interface Clock { last: number }

/** Microseconds below this are inside the legacy band: a stream counting them must refuse (see the module docblock). */
const MICROSECOND_BAND_FLOOR = MAX_SYNC_SEQ;
/** The first millisecond whose microsecond count is above the legacy band: what the refusal names. */
const FIRST_USABLE_MS = Math.floor(MICROSECOND_BAND_FLOOR / 1000) + 1;

/**
 * Whether the last stamp of a microsecond stream was refused because the wall clock read before the first usable instant: what the gauge
 * `ythril_position_clock_unusable` says. One value for the process, not one per stream: the records stream is the only microsecond stream, a
 * refusal is the wall clock's and not a stream's, and the next stamp of any clock that finds the time right clears it.
 */
let lastStampRefused = false;

/** Is local writing being refused because the wall clock reads before the first usable instant? For the gauge. */
export function positionClockUnusable(): boolean {
  return lastStampRefused;
}

/**
 * A stream of positions: see the module docblock. Built by {@link createPositionStream}, never by `new` elsewhere; its fields are
 * the clock's own, and the functions below are its only readers and writers.
 */
export class PositionStream<P extends number | string = number | string> {
  /** @internal The open holds of this stream, per space. */
  readonly holds: HorizonHolds<P>;
  /** @internal One clock per space, seeded once from the store. */
  readonly clocks = new Map<string, Promise<Clock>>();
  /** @internal The wall clock (epoch ms), replaceable for a test. */
  now: () => number;

  constructor(
    readonly name: string,
    readonly unit: PositionUnit,
    readonly seed: (spaceId: string) => Promise<number>,
    now: () => number,
    holds: HorizonHolds<P>,
    readonly onSeedFailure: SeedFailurePolicy,
  ) {
    this.holds = holds;
    this.now = now;
  }

  /** @internal The wall clock in the stream's unit. */
  wall(): number {
    const ms = this.now();
    return this.unit === 'microseconds' ? ms * 1000 : ms;
  }

  /** @internal A position in the stream's unit as the stream spells it. */
  encode(units: number): P {
    return (this.unit === 'microseconds' ? units : new Date(units).toISOString()) as P;
  }

  /** @internal The one formula of "what comes next": the wall clock, or one past the last handed out when the wall clock has not moved. */
  next(clock: Clock): number {
    return Math.max(this.wall(), clock.last + 1);
  }
}

/** Default words for a stream that gives none: `<name> held …`, the floor named `position`. */
function defaultWording(name: string): HoldWording {
  return { noun: name, floorKey: 'pos', floorName: 'position', readers: `every reader of ${name}s` };
}

/** Build a stream. See {@link PositionStreamConfig}. */
export function createPositionStream(cfg: PositionStreamConfig<'microseconds'>): PositionStream<number>;
export function createPositionStream(cfg: PositionStreamConfig<'milliseconds'>): PositionStream<string>;
export function createPositionStream(cfg: PositionStreamConfig<PositionUnit>): PositionStream {
  // The one construction of a hold registry in the server: every instance of the hold is built here
  // (`a-horizon-hold-has-one-primitive-and-every-instance-calls-it`).
  const holds: HorizonHolds<number | string> = new HorizonHolds<number | string>(cfg.wording ?? defaultWording(cfg.name));
  return new PositionStream(cfg.name, cfg.unit, cfg.seed, cfg.now ?? Date.now, holds, cfg.onSeedFailure ?? { policy: 'refuse' });
}

/**
 * Replace the wall clock of `stream` (or restore `Date.now` with `undefined`). For tests of a clock that went backwards across a
 * restore, a start before 2005 and a seed that fails behind a stored maximum; nothing in the server calls it.
 */
export function setPositionClockSourceForTest(stream: PositionStream, fn: (() => number) | undefined): void {
  stream.now = fn ?? Date.now;
}

/**
 * The space's clock, seeded ONCE from `stream.seed` — so a restart with the wall clock behind what an earlier run handed out cannot
 * stamp below a position a peer holds a mark for. A seed that fails is not remembered: the next caller reads again.
 */
function clockOf(stream: PositionStream, spaceId: string): Promise<Clock> {
  let clock = stream.clocks.get(spaceId);
  if (!clock) {
    clock = stream.seed(spaceId).then((top) => ({ last: Math.max(0, top) }));
    stream.clocks.set(spaceId, clock);
    clock.catch(() => { if (stream.clocks.get(spaceId) === clock) stream.clocks.delete(spaceId); });
  }
  return clock;
}

/**
 * The clock for a WRITE, by the stream's policy on a seed it could not read. The records stream refuses the write
 * (`positions_seed_unavailable`, whose cause the doors classify: a store that is down is the store's 503); a stream that stamps
 * from the wall clock says so through its own reporter and starts from nothing, and does not remember the seed.
 */
async function clockForWrite(stream: PositionStream, spaceId: string): Promise<Clock> {
  try {
    return await clockOf(stream, spaceId);
  } catch (err) {
    if (stream.onSeedFailure.policy === 'refuse') throw new PositionsSeedUnavailable(stream.name, spaceId, err);
    stream.onSeedFailure.report(err, spaceId);
    return { last: 0 };
  }
}

/**
 * Refuse a microsecond stream whose wall clock reads inside the legacy band, and say so in the gauge: set while refusing, cleared by
 * the next stamp that finds the clock right. Nothing is remembered and nothing is handed out. A millisecond stream has no band.
 */
function assertUsable(stream: PositionStream): void {
  if (stream.unit !== 'microseconds') return;
  if (stream.wall() <= MICROSECOND_BAND_FLOOR) {
    lastStampRefused = true;
    throw new PositionClockUnusable(stream.name, new Date(FIRST_USABLE_MS).toISOString());
  }
  lastStampRefused = false;
}

/**
 * Take `count` positions from the space's clock and run `write` holding the first — registered in the same tick that takes it, so no
 * reader can be handed a position above it between the two — and release when the write ENDS, whichever way, inside the write bound
 * ({@link heldWhile}). `write` receives the first position; a block is `first … first + count - 1` (microseconds: consecutive, so
 * positions are distinct with no tie inside the clock band; milliseconds: one stamp shared by the slice, `count` is 1).
 *
 * `write` should be the position-writing operation and nothing else: everything awaited inside it holds every reader of the space
 * below the stamp. `holder` names who holds (one word), for the release line, the watchdog and the gauge — REQUIRED, because a stalled
 * hold nobody can name is the defect `Q-200` fixed.
 */
export async function withPositionHeld<P extends number | string, T>(
  stream: PositionStream<P>, spaceId: string, write: (first: P) => Promise<T>, holder: string, opts: { count?: number } = {},
): Promise<T> {
  const count = opts.count ?? 1;
  if (!Number.isInteger(count) || count < 1) throw new Error(`withPositionHeld: count must be a positive integer, got ${count}`);
  if (stream.unit === 'milliseconds' && count !== 1) throw new Error('withPositionHeld: a millisecond stream hands out one shared stamp per call');
  stream.holds.requireHolder(holder);
  const clock = await clockForWrite(stream as PositionStream, spaceId);
  assertUsable(stream as PositionStream);
  // Synchronous from here to the hold's registration: nothing is awaited between the stamp and the hold.
  const first = stream.next(clock);
  clock.last = first + count - 1;
  const holds = stream.holds;
  const hold = holds.enter(spaceId, stream.encode(first), holder);
  return heldWhile(holds, spaceId, hold, () => write(stream.encode(first)));
}

/**
 * Hold a FLOOR for the whole of `fn`: no stamp, a floor. Every position stamped while it runs is at or above it, so
 * {@link settledPositionCap} stays below the floor until `fn` settles. For a TRANSACTION: inside a session a write that returns has not
 * committed — the commit is the session's — so a stamp's own hold, released when its write returns, would hand a reader a position whose
 * record is not yet visible, and the reader would step past it (Q-346's shape). Reached through `brain/held-transaction.ts`, which
 * gives the transaction's session the hold's deadline.
 *
 * The floor is also registered as handed out, so a wall clock that is set back while the transaction runs cannot take a stamp below it.
 */
export async function withPositionFloorHeld<P extends number | string, T>(
  stream: PositionStream<P>, spaceId: string, fn: () => Promise<T>, holder: string,
): Promise<T> {
  stream.holds.requireHolder(holder);
  const clock = await clockForWrite(stream as PositionStream, spaceId);
  assertUsable(stream as PositionStream);
  const floor = stream.next(clock);
  clock.last = Math.max(clock.last, floor - 1);
  const holds = stream.holds;
  return heldWhile(holds, spaceId, holds.enter(spaceId, stream.encode(floor), holder), fn);
}

/**
 * The next position of the space's clock, taken WITHOUT a hold: for a stamp that orders this instance's own writes against positions and that
 * no reader pages by (a pending file tombstone's `writtenAt`, which the one-per-path rule compares with positions). It is handed out like any
 * other — never equal to or below one handed out before — so a stamp taken here and a position taken later always order.
 *
 * Not for a position a reader can be handed: that needs its write held until it settles ({@link withPositionHeld}), or a reader pages past it.
 */
export async function nextUnheldPosition<P extends number | string>(stream: PositionStream<P>, spaceId: string): Promise<P> {
  const clock = await clockForWrite(stream as PositionStream, spaceId);
  assertUsable(stream as PositionStream);
  const first = stream.next(clock);
  clock.last = first;
  return stream.encode(first);
}

/**
 * The position strictly below which a reader of the stream may read: the lowest stamp (or floor) whose write has not settled, or — with
 * none open — the next position the clock would hand out, COMPUTED and never stored (a read must not move the clock, and any stamp taken
 * later is at or above this). THE one way a reader of a position is capped: a reader that bounds itself by a clock read of its own reads
 * straight through an open hold. Async because the clock is seeded from the store once, so a restart cannot cap below a position already
 * handed out.
 */
export async function settledPositionCap<P extends number | string>(stream: PositionStream<P>, spaceId: string): Promise<P> {
  const clock = await clockOf(stream as PositionStream, spaceId);
  // Read after the await, in one tick with the hold registry: a hold entered while the seed was out is below this answer or equal to it.
  return stream.holds.lowest(spaceId) ?? stream.encode(stream.next(clock));
}

/** The lowest open hold of `spaceId` on `stream`, or undefined when none is open: what a page is capped below. For tests. */
export function lowestOpenPosition<P extends number | string>(stream: PositionStream<P>, spaceId: string): P | undefined {
  return stream.holds.lowest(spaceId);
}

/** How long the oldest open hold of `spaceId` on `stream` has been held, in seconds — 0 when none. For the gauge. */
export function oldestPositionHoldSeconds(stream: PositionStream, spaceId: string): number {
  return stream.holds.oldestAgeSeconds(spaceId);
}

export type { Hold };
