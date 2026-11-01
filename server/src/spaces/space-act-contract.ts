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
import { SPACE_ACT_COMPLETED_OPERATION } from '../networks/round-audit.js';

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
  /** An import's spooled body, by id: its key, so two imports are never one act. */
  spoolId?: string;
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
  /** The search indexes of ONE collection of a deleted space: listing them and dropping each (mongot's call, which no store bound ends). */
  SPACE_ACT_SEARCH_INDEX_MS: number;
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
  SPACE_ACT_SEARCH_INDEX_MS: () => 15_000,
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
  /**
   * The act's input is gone (an import whose spooled body is missing on resume): nothing was done and nothing can be, so the entry is removed
   * like a completion's and the completion row says it FAILED (`status`), not that it completed. Our sentence, shown to the operator.
   */
  failedFinally?: { message: string; status: number };
  /** Run once after the completion write removed the entry (an import removes its spool), never before; a throw is said and changes nothing. */
  afterCompletion?: () => void | Promise<void>;
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

/** What an operator reads of one act entry: what it is, since when, how often it has failed, when it is retried, and where it stands. */
export interface ActEntryView {
  kind: string; since: string; attempts: number; nextRetryAt?: string; state: string;
  /** Our sentence for the last failure (never a driver's text), so an operator can see why an act is owed. */
  lastError?: string;
  /** Another attempt meets the same input: only an abandon ends it. */
  needsAbandon?: true;
  /** A restore's backup. */
  backupId?: string;
}

/**
 * An act entry as the operator's surfaces show it — the space's `actPending` and the network's `owedSpaceActs` both start from this, and add
 * what only they know (the network's list adds the entry id, the space and its rounds). The one place that renames the entry's own fields
 * (`registeredAt` is `since`, `retryAt` is `nextRetryAt`, and an absent retry is an absent key), so the two answers cannot describe one
 * debt in two vocabularies.
 */
export function actEntryView(e: SpaceActEntry): ActEntryView {
  return {
    kind: e.kind, since: e.registeredAt, attempts: e.attempts,
    ...(e.retryAt ? { nextRetryAt: e.retryAt } : {}), state: e.state,
    ...(e.lastError ? { lastError: e.lastError } : {}),
    ...(e.needsAbandon ? { needsAbandon: true as const } : {}),
    ...(e.backupId ? { backupId: e.backupId } : {}),
  };
}

/**
 * The audit row of an act with no round that nobody is told of: the kind is in the path, so a restore's rows read apart from a wipe's.
 * The body's counts ride as changes (an import's totals), since this row is the only place a queued act's result is told.
 */
export function spaceActCompletionRow(entry: SpaceActEntry, id: string, counts?: Record<string, number>) {
  return {
    method: 'DELETE', path: `internal:space-act:${entry.kind}:${entry.localId}:${id}`, operation: SPACE_ACT_COMPLETED_OPERATION, spaceId: entry.localId,
    ...(counts ? { changes: Object.entries(counts).map(([field, to]) => ({ field, to })) } : {}),
  };
}
