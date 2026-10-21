/**
 * `spaceActOutcome(httpStatus, body)` — the ONE reading of what a space delete or wipe answered (Q-535).
 *
 * ## What it prevents
 *
 * The client read a delete or wipe answer as `{ pending: status === 202 }`. That folded four different 202s into one (a vote is open; the
 * vote passed and the act still runs; the act is owed with a retry time; a local act queued), dropped every 200 body (a networked delete
 * that left the space HERE because another network holds it was read as "gone" and the space vanished from the list; a subscriber's wipe
 * that refills from the publisher was read as "empty for good"), and threw every 500/503 body away, so a failed act the server retries
 * read the same as one nothing will retry.
 *
 * The order is part of the contract: HTTP status first; within a 202, `queued` before `status` (a voted queued answer carries
 * `status: 'passed'` too); a 404 is "already gone", which is done (only a delete is ever read at 404: a wipe's 404 is a refusal and goes
 * to `refusalText`, as do 400, 403, 409 and 429, so none of those reach here).
 *
 * `testing/space-act-contract.spec.ts` holds the types below to the server's answer bodies.
 */
import type { WipeResult } from './api.types';

/** One decided round as a door answers it (`RoundAnswer`): enough to say which network carried the vote. */
export interface SpaceActRound {
  networkId: string;
  networkLabel: string;
  roundId: string;
}

/** Every key a delete or wipe answer body carries that this client reads. The ones it does not are named in the contract spec. */
export interface SpaceActBody {
  error?: string;
  code?: string | number;
  status?: string;
  rounds?: SpaceActRound[];
  queued?: boolean;
  retryAt?: string;
  repeated?: boolean;
  removedHere?: boolean;
  deleted?: WipeResult;
  refills?: boolean;
}

/** A standing act as the server describes it: a space's `actPending` (admins only), and the start of a network's `owedSpaceActs` entry. */
export interface ActEntryView {
  kind: string;
  since: string;
  attempts: number;
  nextRetryAt?: string;
  state: string;
  /** Our sentence for the last failure (never a driver's text), so an operator can see why an act is owed. */
  lastError?: string;
  /** Another attempt meets the same input: only an abandon ends it (a restore's, on Settings -> Data). */
  needsAbandon?: true;
  /** A restore's backup. */
  backupId?: string;
}

/** One entry of a network's `owedSpaceActs` (admins only): a standing act and the space and rounds it belongs to. */
export interface OwedSpaceAct extends ActEntryView {
  entryId: string;
  localSpaceId: string;
  networkSpaceId?: string;
  rounds: { roundId: string }[];
}

/** What a delete or wipe came to, as a caller may act on it. */
export type SpaceActOutcome =
  /** The act completed. `removedHere: false` — a delete that left the space here, another network holds it. `refills` — a wipe a publisher refills. */
  | { kind: 'done'; removedHere?: boolean; deleted?: WipeResult; refills?: boolean; repeated?: boolean }
  /** A vote is open; nothing has happened yet. */
  | { kind: 'vote-pending'; rounds: SpaceActRound[] }
  /** The act is owed and the server runs it itself, at `retryAt` when it has one. `voted`: a vote passed first. */
  | { kind: 'queued'; retryAt?: string; voted: boolean }
  /** The act did not complete. `retried`: the server runs it again by itself (a 500 with the act-failed code, or a 503). */
  | { kind: 'failed'; retried: boolean; voted: boolean; message: string };

const isVoted = (b: SpaceActBody): boolean => b.status === 'passed' || Array.isArray(b.rounds);

export function spaceActOutcome(httpStatus: number, body: SpaceActBody | Record<string, unknown> | null | undefined): SpaceActOutcome {
  const b: SpaceActBody = body && typeof body === 'object' ? (body as SpaceActBody) : {};
  if (httpStatus === 404) return { kind: 'done' };
  if (httpStatus === 202) {
    if (b.queued) return { kind: 'queued', ...(b.retryAt ? { retryAt: b.retryAt } : {}), voted: isVoted(b) };
    if (b.status === 'vote_pending') return { kind: 'vote-pending', rounds: Array.isArray(b.rounds) ? b.rounds : [] };
    // A 202 that says neither: the act stands and nothing says a vote is open, so it is owed and runs by itself.
    return { kind: 'queued', voted: isVoted(b) };
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      kind: 'done',
      ...(typeof b.removedHere === 'boolean' ? { removedHere: b.removedHere } : {}),
      ...(b.deleted ? { deleted: b.deleted } : {}),
      ...(b.refills ? { refills: true } : {}),
      ...(b.repeated ? { repeated: true } : {}),
    };
  }
  return {
    kind: 'failed',
    retried: b.code === 'space_act_failed' || httpStatus === 503,
    voted: isVoted(b),
    message: typeof b.error === 'string' && b.error ? b.error : `HTTP ${httpStatus}`,
  };
}
