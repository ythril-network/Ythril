/**
 * What a body, a door and a test are handed by the act runner, and none of the runner's state: the request an act is registered by, the
 * context a body works through, what it answers, the figures an act is bounded by, and the refusal a closed runner makes.
 *
 * It exists so the runner (`space-act-runner.ts`) holds only what runs and stands - the queues, the standing predicate, the lanes and the
 * completion - and these shapes can be read without it. The runner re-exports every name here, so a caller imports from one place.
 */
import type { Config, SpaceActEntry, SpaceActKind, SpaceActRound, SpaceActSet, SpaceActState, SpaceConfig } from '../config/types.js';
import type { BrainCollection } from '../config/types-knowledge.js';
import { housekeepingOpMs } from '../db/write-bound.js';
import { PEER_TRANSFER_TIMEOUT_MS } from '../sync/peer-fetch.js';

/** What a caller asks the runner to do. */
export interface SpaceActRequest {
  kind: SpaceActKind;
  localId: string;
  /** A wipe's covered collections; absent = all of them. */
  types?: readonly BrainCollection[];
  /** A deletion's network, whose round it carries out; absent = this instance's own deletion. */
  networkId?: string;
  /** A rename's new id. */
  newId?: string;
  /** The round the act carries out, appended to the entry's rounds. */
  round?: SpaceActRound;
  /** The act set the entry is a member of (`registerSpaceActSet`); never part of its key. */
  setId?: string;
  /** A restore's backup id; never part of its key (a second restore while one stands is refused by its door). */
  backupId?: string;
}

/**
 * A body found that its INPUT cannot be acted on - a backup that is not whole, records a unique index refuses - so another attempt meets
 * the same input. The runner records it as owed and `needsAbandon`, retries it never, and keeps the space held until an operator abandons
 * the act (`abandonSpaceActSet`). The message is ours and is shown to the operator; a cause carrying a driver's text stays in the log.
 */
export class SpaceActInputFailure extends Error {
  override readonly name = 'SpaceActInputFailure';
}

/** What one run of an act came to. Never thrown: a run answers. */
export interface SpaceRoundSettled {
  entryId: string;
  kind?: SpaceActKind;
  localId?: string;
  ok: boolean;
  /** The rounds the act covered; `roundId` is the first of them. */
  rounds: SpaceActRound[];
  roundId?: string;
  /** Our sentence when it did not complete — never a driver's text. */
  error?: string;
  /** What failed, for the caller that answers it (a store failure is answered as the store's); never written anywhere. */
  cause?: unknown;
  /** When the runner will try a failed act again. */
  retryAt?: string;
  /** The act was refused before it changed anything (a rename that met a standing deletion or wipe); its entry is gone. */
  refused?: boolean;
  /** Shutdown ended it; the entry is unchanged and resumes after the next start. */
  interrupted?: boolean;
  counts?: Record<string, number>;
  removedHere?: boolean;
  renamed?: SpaceConfig;
}

/** Does an act stand for a space, and which. */
export interface SpaceActStanding {
  entryId: string;
  kind: SpaceActKind;
  types: readonly BrainCollection[] | 'all';
  state: SpaceActState;
  /** A rename's new id. */
  newId?: string;
}

/** The figures an act is bounded by. Each has a setter for tests (`setSpaceActKnobsForTest`, in the runner). */
export interface SpaceActKnobs {
  /** How long one drain waits before the entry reads `draining` and waits again. */
  EXCHANGE_DRAIN_MS: number;
  /** How long a door waits for its act before answering `queued`. */
  SPACE_ACT_ANSWER_MS: number;
  /** One store operation of a body, its batch hooks included. */
  SPACE_ACT_OP_MS: number;
  /** Rows one wipe batch deletes. */
  SPACE_ACT_BATCH: number;
  /** One file-system step of a body. */
  SPACE_ACT_FS_MS: number;
  /** The wait for a space's media claims to be revoked. */
  SPACE_ACT_CLAIM_MS: number;
  /** An act running longer than this is reported (never cut). */
  SLOW_SPACE_ACT_MS: number;
  /** The longest one inbound transfer may stay open. */
  INBOUND_TRANSFER_MS: number;
}

const DEFAULT_KNOBS: { readonly [K in keyof SpaceActKnobs]: () => number } = {
  EXCHANGE_DRAIN_MS: () => 60_000,
  SPACE_ACT_ANSWER_MS: () => 20_000,
  SPACE_ACT_OP_MS: () => housekeepingOpMs(),
  SPACE_ACT_BATCH: () => 5_000,
  SPACE_ACT_FS_MS: () => 120_000,
  SPACE_ACT_CLAIM_MS: () => 120_000,
  SLOW_SPACE_ACT_MS: () => 10 * 60_000,
  INBOUND_TRANSFER_MS: () => PEER_TRANSFER_TIMEOUT_MS,
};

let knobs: Partial<SpaceActKnobs> = {};

/** The figure `name` stands at now. */
export function spaceActKnob(name: keyof SpaceActKnobs): number {
  return knobs[name] ?? DEFAULT_KNOBS[name]();
}

/** Replace the figures a test sets, or all of them with `null`; the runner's `setSpaceActKnobsForTest` is the one door onto it. */
export function setSpaceActKnobs(k: Partial<SpaceActKnobs> | null): void {
  knobs = k ? { ...knobs, ...k } : {};
}

/** What a body is handed: its entry as it stood when it started, and the bounded steps it does its work through. */
export interface SpaceActBodyContext {
  readonly entry: Readonly<SpaceActEntry>;
  /**
   * Delete the rows of `collection` matching `filter` in bounded batches; how many went. `remove` is the body's own delete of one
   * batch's ids, so the collection a body empties is spelled where the body is read.
   */
  deleteInBatches(collection: string, filter: Record<string, unknown>, remove: (ids: unknown[]) => Promise<{ deletedCount?: number }>): Promise<number>;
  /** One file-system step, raced against `SPACE_ACT_FS_MS`: past it the attempt fails and the lane is freed. */
  fileTree<T>(fn: () => Promise<T>): Promise<T>;
  /** The wait for the space's media claims, raced against `SPACE_ACT_CLAIM_MS`. */
  claimWait<T>(fn: () => Promise<T>): Promise<T>;
}

/** What a body did. */
export interface SpaceActBodyOutcome {
  /** The space was not here to act on. */
  absent?: boolean;
  /** This instance's own copy was removed (a deletion). */
  removedHere?: boolean;
  counts?: Record<string, number>;
  renamed?: SpaceConfig;
  /** The act was refused before it changed anything; the entry is removed and nothing is retried. */
  refusal?: Error;
  /** What a member of an act set reports about its space (a restore's index results); kept on the set's record for its report. */
  report?: Record<string, unknown>;
}

/** What a kind that runs as an act set does once, when the last member of a set ends: after the write that ends it, never inside it. */
export interface SpaceActSetHooks {
  onSetEnd(set: Readonly<SpaceActSet>): void;
  /**
   * What its COMPLETION changes in the same config write that ends the set (a migrate saves its target URI there, so the URI is saved
   * exactly when every hold lifts). A throw aborts the write: nothing is removed, and the member that completed is recorded as failed.
   * It changes the config and nothing else: the write can still fail after it, and what it did outside the config would outlive that
   * (`onSetEnd`, which runs only after the write succeeded, is where a process-wide effect belongs).
   */
  inCompletionWrite?(cfg: Config, set: Readonly<SpaceActSet>): void;
}

export type SpaceActBody = (ctx: SpaceActBodyContext) => Promise<SpaceActBodyOutcome>;

/** Shutdown has closed the runner: a new act is refused. Answered `503` by both doors (`spaceActClosedAnswer`). */
export class SpaceActsClosedError extends Error {
  override readonly name = 'SpaceActsClosedError';
  constructor() { super('shutting down'); }
}

/** The answer to a refusal the closed runner made, or null for anything else. */
export function spaceActClosedAnswer(err: unknown): { status: 503; body: { error: string } } | null {
  const closed = err instanceof SpaceActsClosedError || (err instanceof Error && err.name === 'SpaceActsClosedError');
  return closed ? { status: 503, body: { error: 'shutting down' } } : null;
}
