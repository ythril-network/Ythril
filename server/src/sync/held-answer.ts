/**
 * What a peer's refusal of a space means for the transfer that met it, and the turn that keeps what it met
 * (bundle-106, design v5 section 3.3 (1), W9, X10, X18).
 *
 * ## Why it exists
 *
 * A peer that holds a space answers `423` with `code: 'space_held'` (a wipe or deletion is being applied on one side),
 * and a subscriber that left a space answers `423` with `code: 'space_declined'`. A sender that read every non-2xx as a
 * failed transfer turned a held space into a failed cycle for the WHOLE member - every space, `lastSyncAt` not written,
 * and `PEER UNREACHABLE` after `STALE_FAILURE_THRESHOLD` such cycles - for a space that was merely held. So every place a
 * transfer reads a peer's non-2xx for a space asks {@link transferRefusal}, and only `'failed'` is a failure.
 *
 * ## What a hand-written copy drops
 *
 * The body is read from a CLONE, so the caller can still cancel or read the response it holds: a classifier that consumed
 * the body would make every caller's own error path read an empty stream. And the verdict goes to the TURN
 * ({@link ExchangeTurn.refusedBy}), not only to the caller's return value, because the transfer modules each end their
 * own transfer on a non-2xx and only the turn can say "stop the rest of this space for this member, and it is not a
 * failure".
 */
/** `held` and `declined` end the space's exchange with this member for the cycle and move no failure counter. */
export type TransferVerdict = 'held' | 'declined' | 'failed';

/**
 * One space's exchange with one member, as the transfer modules see it: the unit in flight takes `signal`, the loops ask
 * `mayContinue()` between units, and a refusal the peer answered is handed to `refusedBy`.
 */
export interface ExchangeTurn {
  readonly signal: AbortSignal;
  mayContinue(): boolean;
  refusedBy(verdict: TransferVerdict): void;
}

/** The `423` body a peer gets for a space held while a deletion or wipe is applied on one side (design v5 section 3.3). */
export const SPACE_HELD_ANSWER = { error: 'This space is held for this member while a wipe is applied on one side', code: 'space_held' } as const;
/** The `423` body a peer gets for a network space this member left (pub/sub, design v5 section 2.9, X10). */
export const SPACE_DECLINED_ANSWER = { error: 'This member left the space', code: 'space_declined' } as const;

/** The codes a peer answers `423` with, and what each means to the sender. */
const VERDICT_OF_CODE: Readonly<Record<string, TransferVerdict>> = {
  space_held: 'held',
  space_declined: 'declined',
};

/**
 * `'held'` for a `423` whose body says `space_held`, `'declined'` for `space_declined`, otherwise `'failed'`. Never throws:
 * a body that cannot be read is a failed transfer, as any other non-2xx.
 */
export function transferRefusal(resp: Pick<Response, 'status' | 'clone'>): Promise<TransferVerdict> {
  if (resp.status !== 423) return Promise.resolve('failed');
  return readVerdict(resp);
}

async function readVerdict(resp: Pick<Response, 'clone'>): Promise<TransferVerdict> {
  try {
    const text = await resp.clone().text();
    const body = JSON.parse(text.slice(0, 4096)) as { code?: unknown };
    return typeof body?.code === 'string' ? VERDICT_OF_CODE[body.code] ?? 'failed' : 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * The signal a fetch of the turn takes: the request's own (its timeout) and the turn's (cut when an act on the space
 * registers), whichever fires first. Without a turn, the request's own alone.
 */
export function turnSignal(own: AbortSignal | null | undefined, turn: ExchangeTurn | undefined): AbortSignal | undefined {
  if (!turn) return own ?? undefined;
  return own ? AbortSignal.any([own, turn.signal]) : turn.signal;
}
