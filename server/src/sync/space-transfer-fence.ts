/**
 * May a transfer of this space go on, and how many of its units are in flight (bundle-106, design v5 §3.3a).
 *
 * ## Why it exists
 *
 * A deletion or wipe of a space is registered, then waits for the transfers of that space ADMITTED before the registration to end,
 * then deletes. Without a count of what is in flight the act cannot know what to wait for, and a write unit that started a moment
 * before the registration lands AFTER the delete — refilling the space the act just emptied. So every unit that writes a space, or
 * moves its data to or from a peer, is counted here for its length: a local write unit (`enterSpaceWrite`, one `commitPlans` stage,
 * one `writeArrivals` chunk, one file write) and an exchange with a peer (`openSpaceTransfer`, which the sync doors and the outbound
 * turn enter through their own admission).
 *
 * ## What a hand-written count drops
 *
 * The release on the failure path. A count released only when the unit succeeds leaks one per failure, and a leaked count makes
 * every later act on that space wait for a transfer that no longer exists — `draining`, for ever, with nothing wrong to report.
 * So a release here is IDEMPOTENT (a `finally` and a `close` listener may both call it) and the caller's only job is to call it.
 *
 * ## What it does not decide
 *
 * Whether a transfer may BEGIN: that is the hold, asked through the one standing predicate (`spaceActStands`, the runner). This module
 * counts and cancels; it refuses nobody.
 */

/** One counted exchange with a peer: its unit in flight takes `signal`; it asks `mayContinue()` between units; `release()` ends it. */
export interface SpaceTransfer {
  readonly signal: AbortSignal;
  mayContinue(): boolean;
  /** Idempotent: a second call does nothing. */
  release(): void;
}

interface SpaceUnits {
  count: number;
  /** One per open exchange, so an act's registration can cut the unit in flight. */
  controllers: Set<AbortController>;
  /** Woken whenever the count drops, so a drain re-reads it. */
  wakers: Set<() => void>;
}

const bySpace = new Map<string, SpaceUnits>();

function unitsOf(localSpaceId: string): SpaceUnits {
  let u = bySpace.get(localSpaceId);
  if (!u) { u = { count: 0, controllers: new Set(), wakers: new Set() }; bySpace.set(localSpaceId, u); }
  return u;
}

/** Count one unit of `localSpaceId` and return its idempotent release. */
function enter(localSpaceId: string, controller?: AbortController): () => void {
  const u = unitsOf(localSpaceId);
  u.count++;
  if (controller) u.controllers.add(controller);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    u.count = Math.max(0, u.count - 1);
    if (controller) u.controllers.delete(controller);
    for (const wake of [...u.wakers]) wake();
    if (u.count === 0 && u.controllers.size === 0 && u.wakers.size === 0 && bySpace.get(localSpaceId) === u) bySpace.delete(localSpaceId);
  };
}

/** One local write unit of `localSpaceId` (§2.6b), counted for the drain; call the returned release when the unit ends, however it ends. */
export function enterSpaceWrite(localSpaceId: string): () => void {
  return enter(localSpaceId);
}

/**
 * One exchange of `localSpaceId` with a peer, counted and cancellable — ADMISSION is the caller's (the hold). `signal` fires, and
 * `mayContinue()` turns false, when an act on the space registers.
 */
export function openSpaceTransfer(localSpaceId: string): SpaceTransfer {
  const controller = new AbortController();
  const release = enter(localSpaceId, controller);
  return { signal: controller.signal, mayContinue: () => !controller.signal.aborted, release };
}

/** An inbound stream a transfer is carried on: a response, as far as the fence needs one. */
export interface TransferStream {
  once(event: 'close', listener: () => void): unknown;
  destroy(): unknown;
}

/**
 * Keep an INBOUND transfer counted for exactly as long as the stream carrying it is open: released when the stream closes
 * (an answer sent, an error, a client that walked away — every road ends in `close`), destroyed by the server past `boundMs`
 * (one inbound transfer is bounded on the server, not only by the sender), and, with `cutOnAct`, destroyed the moment an act on
 * the space registers, so the act does not wait out a sender's stream.
 *
 * Returns `false` for a stream that cannot report its close: the caller releases at once, since a count nothing will ever
 * release would block every later act's drain.
 */
export function holdTransferWhileOpen(stream: unknown, transfer: SpaceTransfer, boundMs: number, cutOnAct: boolean): boolean {
  const s = stream as Partial<TransferStream> | null;
  if (!s || typeof s.once !== 'function' || typeof s.destroy !== 'function') return false;
  const cut = (): void => { s.destroy!(); };
  const timer = setTimeout(cut, boundMs);
  timer.unref?.();
  if (cutOnAct) transfer.signal.addEventListener('abort', cut, { once: true });
  s.once('close', () => {
    clearTimeout(timer);
    transfer.signal.removeEventListener('abort', cut);
    transfer.release();
  });
  return true;
}

/** An act on `localSpaceId` registered: every open exchange of it stops at its next unit, and the unit in flight is cut. */
export function abortTransfersOf(localSpaceId: string): void {
  const u = bySpace.get(localSpaceId);
  if (!u) return;
  for (const c of u.controllers) c.abort(new Error(`an act on space '${localSpaceId}' was registered`));
}

/** How many units of `localSpaceId` are in flight. */
export function spaceTransfersRunning(localSpaceId: string): number {
  return bySpace.get(localSpaceId)?.count ?? 0;
}

/** How many units are in flight across every space (the `ythril_space_transfers_running` gauge). */
export function allSpaceTransfersRunning(): number {
  let n = 0;
  for (const u of bySpace.values()) n += u.count;
  return n;
}

/**
 * Wait until no unit of `localSpaceId` is in flight: `'drained'`, or `'waiting'` when `withinMs` passed first. Waiting is not a
 * failure — the caller waits again (design X5).
 */
export function awaitSpaceTransfersDrained(localSpaceId: string, withinMs: number): Promise<'drained' | 'waiting'> {
  if (spaceTransfersRunning(localSpaceId) === 0) return Promise.resolve('drained');
  const u = unitsOf(localSpaceId);
  return new Promise(resolve => {
    const done = (answer: 'drained' | 'waiting'): void => { clearTimeout(timer); u.wakers.delete(wake); resolve(answer); };
    const wake = (): void => { if (u.count === 0) done('drained'); };
    const timer = setTimeout(() => done('waiting'), withinMs);
    timer.unref?.();
    u.wakers.add(wake);
  });
}

/** Forget every count: an in-process boot keeps module state, and a test that boots again starts from none. */
export function resetSpaceTransfersForTest(): void {
  bySpace.clear();
}
