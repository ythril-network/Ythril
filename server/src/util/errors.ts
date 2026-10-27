/** Typed error classes for structured error handling across the codebase. */

/** Thrown when a requested resource does not exist. */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * A record that EXISTS but cannot be compared yet because it has no vector: a `NotFoundError` that says where the record is. A search that
 * probes several spaces (a personal view's members) keeps this one over the "not found" of the members that do not hold the record.
 */
export class NotEmbeddedYetError extends NotFoundError {}

/**
 * Thrown by a tool handler that a shared module has refused with a status of its own: a `429` from the heavy-call rail, a
 * `409` from a single flight. `callTool` answers it with that status on the REST door; a refusal the handler merely
 * returns is a `422` ("well-formed and refused"), which tells a caller nothing about whether to wait or to change the call.
 * The message is the whole answer, the same sentence the dedicated REST route sends.
 *
 * `body` is the structure the REST door answers beside that sentence — a failed parse's `{ error, issues }` — carried as the tool
 * result's `structuredContent`, so a caller that reads the structure gets it on both doors and not on one.
 */
export class ToolRefusal extends Error {
  override readonly name = 'ToolRefusal';
  constructor(readonly status: 400 | 403 | 404 | 409 | 410 | 429, message: string, readonly body?: Readonly<Record<string, unknown>>) {
    super(message);
  }
}

/** Thrown when a request is invalid (bad params, missing fields, etc.). */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * A refusal of what the CALLER sent, made by our own code: a path that leaves the space, a chunk range that does not tile the file, an
 * encoding that is not one of the two. The REST doors answer it `400` in its own sentence.
 *
 * ## Why it is not a bare `RangeError`
 *
 * Our refusals used to be `RangeError`s, and a door chose its `400` by `instanceof RangeError`. The runtime throws `RangeError` too (an
 * invalid `Buffer` length, an out-of-range offset, a stack overflow), so a fault of the server was answered `400` in the runtime's
 * words, and a sync sender reads `400` as "refused about the bytes" and never offers them again. A door that means "our refusal" asks for
 * this class, and any other `RangeError` is the fault it is. It extends `RangeError` so a caller that still asks the older question keeps
 * its answer; the tool doors, which answer every `Error` as a refusal, are unchanged.
 */
export class RequestRefusal extends RangeError {
  override name = 'RequestRefusal';
}

/** The code a door puts on the 503 for {@link PositionClockUnusable}. A constant, never a literal at a site. */
export const POSITIONS_CLOCK_UNUSABLE = 'positions_clock_unusable';
/** The code a door puts on the 503 for {@link PositionsSeedUnavailable}. */
export const POSITIONS_SEED_UNAVAILABLE = 'positions_seed_unavailable';

/**
 * A local write was refused because the wall clock reads before the first instant a record position can be taken at
 * (2005-09-05T05:58:26.843Z: the first millisecond whose microsecond count is above the legacy band, `MAX_SYNC_SEQ`). Every local write
 * answers it `503` until the clock is right; reads and sync are not affected (`util/position-clock.ts`).
 */
export class PositionClockUnusable extends Error {
  override readonly name = 'PositionClockUnusable';
  readonly code = POSITIONS_CLOCK_UNUSABLE;
  constructor(stream: string, readonly firstUsable: string) {
    super(`The system clock reads before ${firstUsable}, the earliest time a ${stream} can be taken at, so this instance cannot write until the clock is corrected.`);
  }
}

/**
 * A local write was refused because the stream's position seed could not be read from the store. The stored maximum can be above the
 * wall clock after a restore, and a stamp below a position already handed out is the one thing the clock promises never to do, so the
 * write is refused instead of stamped from the wall clock alone. `cause` is what failed to read: a store that is down is the store's
 * answer on every door (`503`, retryable), classified through the error chain.
 */
export class PositionsSeedUnavailable extends Error {
  override readonly name = 'PositionsSeedUnavailable';
  readonly code = POSITIONS_SEED_UNAVAILABLE;
  constructor(stream: string, readonly spaceId: string, cause: unknown) {
    super(`The ${stream} of this space could not be read from the store, so the write was not made. Retry it.`, { cause });
  }
}

/** The code a sync door puts on the 503 for a space that owes its positions, which a sender reads as HELD. A constant, never a literal at a site. */
export const POSITIONS_BUILDING = 'positions_building';

/**
 * A sync read or write met a space whose positions are not built yet (its first carry, or a repair, is owed: `sync/positions-owed.ts`). The doors
 * answer it `503` with `code: 'positions_building'`; the sender reads that code as HELD, not as a failed member, and tries again next cycle. A
 * housekeeping walk reads it as "not ready: skipped this tick" (`walkVerdict`), never as the space's failure.
 */
export class PositionsBuilding extends Error {
  override readonly name = 'PositionsBuilding';
  readonly code = POSITIONS_BUILDING;
  constructor(readonly spaceId: string) {
    super('This space is building its positions, so it cannot be exchanged yet. Try again shortly.');
  }
}

/** The code a sync door puts on the 503 for a space whose edge identity index is being rebuilt, which a sender reads as ONE FAMILY held. A constant, never a literal at a site. */
export const EDGE_IDENTITY_BUILDING = 'edge_identity_building';

/**
 * A page of the edges family carried, or would have planned, a fork edge in a space whose edge identity index still counts fork rows (the full five-field unique
 * index stands, or the partial one is not confirmed: `spaces/edge-identity-index.ts`). A fork edge shares its subject's five identity fields, so storing it would be
 * a duplicate-key error nobody can explain; it waits until the swap lands. The doors answer `503` with `code: 'edge_identity_building'`; a sender reads that code as
 * the EDGES FAMILY held (never the space, never a failed member) and offers the page again from the held position.
 */
export class EdgeIdentityBuilding extends Error {
  override readonly name = 'EdgeIdentityBuilding';
  readonly code = EDGE_IDENTITY_BUILDING;
  constructor(readonly spaceId: string) {
    super('This space is rebuilding its edge identity index, so its relationship versions cannot be stored yet. The sender keeps them and offers them again.');
  }
}

/** The codes the two fork refusals below answer with, in this order: the one list a door, a tool text and its gate read them from. */
export const FORK_REFUSAL_CODES = Object.freeze(['fork_row_read_only', 'fork_cap'] as const);

/**
 * An ordinary edit (an update, a relabel, a save by id, a merge) named a FORK row: an unchosen version of another record (Q-624, design rev 4 §8). A fork
 * changes only by resolve, delete, arrival or re-mint, so every other write is refused BEFORE it writes, with `409 fork_row_read_only`. Thrown by the one
 * refusal, `refuseForkEdit` (`brain/forks.ts`, which re-exports this class); declared here so the doors' shared mappers can name it without importing the
 * fork module. What it prevents: a relabelled fork edge re-keyed onto its subject's derived id, colliding in the identity slot for ever.
 */
export class ForkRowReadOnly extends Error {
  override readonly name = 'ForkRowReadOnly';
  readonly code = FORK_REFUSAL_CODES[0];
  readonly status = 409 as const;
  constructor(readonly kindWord: string, readonly id: string, readonly forkOf: string) {
    super(`${kindWord} '${id}' is an unresolved version of '${forkOf}'. Resolve it in Review (resolve_fork) or delete it; it cannot be edited (fork_row_read_only).`);
  }
}

/**
 * A re-key or merge would leave one record holding more unresolved versions than `MAX_FORKS_PER_RECORD` (Q-624, design rev 4 §7). A peer would refuse the
 * forks past the cap and that would lose them there, so the act is refused before anything is written (`409 fork_cap`), and the caller resolves some first.
 */
export class ForkCapRefusal extends Error {
  override readonly name = 'ForkCapRefusal';
  readonly code = FORK_REFUSAL_CODES[1];
  readonly status = 409 as const;
  constructor(readonly count: number, readonly cap: number) {
    super(`the two records hold ${count} unresolved versions together, more than ${cap}; resolve some in Review first`);
  }
}

/**
 * A peer answered a sync request in the 5.x shape: a page with no `through`, `head` or `positions`, or a push answer without `positions: 1`. 6.0 pages
 * by position and a 5.x peer cannot be synced with by these rules, so the client THROWS this from both parsers (`sync/wire-answer.ts`); the engine ends
 * that member's turn on it, counts no failure and shows the member as too old.
 */
export class PeerPagesBySeq extends Error {
  override readonly name = 'PeerPagesBySeq';
  constructor() {
    super('peer does not page by position (pre-6.0)');
  }
}
