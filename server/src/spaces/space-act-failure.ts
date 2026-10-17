/**
 * What a door answers when a deletion or wipe was decided and this instance's own act of it did not complete (bundle-106, design v5 §2.2
 * (3), VR8, W20) — and what it answers when the act is still running past the door's budget, whose body has the same two shapes.
 *
 * ## What it prevents
 *
 * Two routes put the driver's `err.message` on the wire (`api/spaces.ts`, `app.ts`), and a store outage was answered by the store's own
 * body, which dropped `status: 'passed'` — so a client's "the vote passed" branch never fired on a `503`, and a caller read a failure as
 * "nothing happened" and voted again. A failed act after a passed vote is a FAILURE (not a refusal: the vote is carried and the act is
 * retried by this instance), answered once, here, for every door: OUR sentence (the cause goes to the log), `code: 'space_act_failed'`,
 * `status: 'passed'` and the rounds; a store-side cause keeps the store's status and `Retry-After` and gains the same two fields.
 *
 * **An act no vote decided is not a vote that passed.** An unnetworked delete or wipe (and a subscriber's own copy) has no round: its door
 * answered `status: 'passed'` with an empty `rounds` list and "the vote passed" for a change nobody voted on. The same two functions take
 * the case as an argument, so the sentence and the body are written once per case and a door cannot say the vote's words about a local act
 * (owner ruling, lens finding F4): the local answer names the change, says it is retried, and points at the space's `actPending`.
 */
import { storeFailureAnswer, type StoreFailureAnswer } from '../brain/store-failure.js';
import { reportServerFailure } from '../util/report-failure.js';

/** The rounds an act was decided by, or `'local'` for an act no vote decided: the case every answer below is written for. */
export type ActRounds = unknown[] | 'local';

/** The sentence every door answers a failed, VOTED act with — written once. Its pointer is real: the network answer lists owed acts. */
export const SPACE_ACT_FAILED_SENTENCE = 'The vote passed and this instance\'s own change did not complete; it is retried automatically — '
  + 'see GET /api/networks/:id (owedSpaceActs).';

/** The sentence every door answers a failed LOCAL act with — written once. Its pointer is real: a space's `actPending` shows what is owed on it. */
export const LOCAL_SPACE_ACT_FAILED_SENTENCE = 'The change did not complete; it is retried automatically — '
  + 'see the space\'s actPending on GET /api/spaces.';

/**
 * The fields a VOTED act's answer adds to the body (`status: 'passed'` and its rounds), and none for a local one. One function, so a body
 * that names the vote is a body the case asked for.
 */
export function votedActFields(rounds: ActRounds): { status: 'passed'; rounds: unknown[] } | Record<string, never> {
  return rounds === 'local' ? {} : { status: 'passed', rounds };
}

/** The answer for a failed act: a store outage (`store`, with its status and `Retry-After`) or our `500`. */
export interface SpaceActFailureAnswer {
  status: number;
  body: { error: string; code?: 'space_act_failed' | number; codeName?: string; status?: 'passed'; rounds?: unknown[]; retryable?: boolean };
  /** Present for a store outage: what `sendStoreFailure` puts on the wire. */
  store?: StoreFailureAnswer;
}

/**
 * The answer for an act that failed with `cause`. `rounds` are the rounds that decided it, or `'local'` when no vote did (said at every call,
 * so the case is never a default). `where` names the door, for the log line. A store that is not answering keeps its `503` and
 * `Retry-After`; any other cause is reported (with its text, in the log) and answered `500` in our words.
 */
export function spaceActFailureAnswer(cause: unknown, rounds: ActRounds, where: string): SpaceActFailureAnswer {
  const store = storeFailureAnswer(cause, where);
  if (store && store.status === 503) {
    return { status: store.status, store, body: { ...store.body, ...votedActFields(rounds) } };
  }
  reportServerFailure(where, cause);
  return {
    status: 500,
    body: { error: rounds === 'local' ? LOCAL_SPACE_ACT_FAILED_SENTENCE : SPACE_ACT_FAILED_SENTENCE, code: 'space_act_failed', ...votedActFields(rounds) },
  };
}

/**
 * The body of a QUEUED answer — the act is still running past the door's budget, or owed with its retry ahead: `queued: true` and the retry
 * time when there is one, `repeated` when the door joined an act already standing, and the vote's `status` and rounds only for a voted act.
 */
export function queuedActBody(
  end: { retryAt?: string; repeated?: boolean }, rounds: ActRounds,
): { queued: true; retryAt?: string; repeated?: true; status?: 'passed'; rounds?: unknown[] } {
  return {
    ...votedActFields(rounds),
    queued: true,
    ...(end.retryAt ? { retryAt: end.retryAt } : {}),
    ...(end.repeated ? { repeated: true as const } : {}),
  };
}
