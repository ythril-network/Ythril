/**
 * What a door answers when a deletion or wipe passed and this instance's own act of it did not complete (bundle-106, design v5 §2.2
 * (3), VR8, W20).
 *
 * ## What it prevents
 *
 * Two routes put the driver's `err.message` on the wire (`api/spaces.ts`, `app.ts`), and a store outage was answered by the store's own
 * body, which dropped `status: 'passed'` — so a client's "the vote passed" branch never fired on a `503`, and a caller read a failure as
 * "nothing happened" and voted again. A failed act after a passed vote is a FAILURE (not a refusal: the vote is carried and the act is
 * retried by this instance), answered once, here, for every door: OUR sentence (the cause goes to the log), `code: 'space_act_failed'`,
 * `status: 'passed'` and the rounds; a store-side cause keeps the store's status and `Retry-After` and gains the same two fields.
 */
import { storeFailureAnswer, type StoreFailureAnswer } from '../brain/store-failure.js';
import { reportServerFailure } from '../util/report-failure.js';

/** The sentence every door answers a failed act with — written once. Its pointer is real: the network answer lists owed acts. */
export const SPACE_ACT_FAILED_SENTENCE = 'The vote passed and this instance\'s own change did not complete; it is retried automatically — '
  + 'see GET /api/networks/:id (owedSpaceActs).';

/** The answer for a failed act: a store outage (`store`, with its status and `Retry-After`) or our `500`. */
export interface SpaceActFailureAnswer {
  status: number;
  body: { error: string; code?: 'space_act_failed' | number; codeName?: string; status: 'passed'; rounds: unknown[]; retryable?: boolean };
  /** Present for a store outage: what `sendStoreFailure` puts on the wire. */
  store?: StoreFailureAnswer;
}

/**
 * The answer for an act that failed with `cause` after its round(s) passed. `where` names the door, for the log line. A store that is
 * not answering keeps its `503` and `Retry-After`; any other cause is reported (with its text, in the log) and answered `500` in our
 * words.
 */
export function spaceActFailureAnswer(cause: unknown, rounds: unknown[], where: string): SpaceActFailureAnswer {
  const store = storeFailureAnswer(cause, where);
  if (store && store.status === 503) {
    return { status: store.status, store, body: { ...store.body, status: 'passed', rounds } };
  }
  reportServerFailure(where, cause);
  return { status: 500, body: { error: SPACE_ACT_FAILED_SENTENCE, code: 'space_act_failed', status: 'passed', rounds } };
}
