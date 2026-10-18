/**
 * The answers a space delete or wipe really gets, as `{ status, body }` pairs — copied from the server source at ff52779f, never
 * invented. Shared by the parser spec (`core/space-act-outcome.spec.ts`) and the danger tab spec, because a spec that flushes
 * `{ pending: true }` tests a shape the server never sent (`Q-535`): the two specs must agree on what the wire carries.
 *
 * Where each shape comes from:
 * - delete: `spaces/space-deletion.ts` `deletionAnswer` (204 / 200 deleted+removedHere / 202 vote_pending / 202 queued), the DELETE
 *   route's 404 (`api/spaces.ts`) and its `sendCaughtFailure` fallback (`{ error: 'The deletion did not complete; see the log.' }`);
 * - wipe: the admin wipe route in `app.ts` (`status: 'wiped'`, `deleted?`, `rounds?`, `repeated?`, `refills?`) and its fallback;
 * - queued: `spaces/space-act-failure.ts` `queuedActBody` (voted: `status: 'passed'` + rounds; local: neither);
 * - failed: `spaceActFailureAnswer` (500 `code: 'space_act_failed'`, voted or local sentence; 503 the store's body + voted fields), and
 *   `spaceActClosedAnswer` in `spaces/space-act-runner.ts` (503 `{ error: 'shutting down' }`);
 * - rounds: `networks/vote-acts.ts` `RoundAnswer` (`networkId`, `networkLabel`, `roundId`, `round`, `outcome?`, `repeated?`);
 * - act entries: `actEntryView` in `spaces/space-act-runner.ts`, and `networkAnswer`'s `owedSpaceActs` in `networks/network-acts.ts`.
 *
 * A fixture is allowed to be literal (project rule): these are the expected values, not derived from the code under test.
 */

const SPACE_ACT_FAILED_SENTENCE = 'The vote passed and this instance\'s own change did not complete; it is retried automatically — '
  + 'see GET /api/networks/:id (owedSpaceActs).';
const LOCAL_SPACE_ACT_FAILED_SENTENCE = 'The change did not complete; it is retried automatically — '
  + 'see the space\'s actPending on GET /api/spaces.';
const STORE_TIMEOUT_MESSAGE = 'The database did not complete this operation in time. '
  + 'It did not complete as far as this server can confirm; retry the request (store-side failure; retryable).';

/** A future and a past instant, fixed so a spec can reason about "ahead" and "overdue" against `vi.setSystemTime(NOW)`. */
export const NOW = Date.parse('2026-10-18T12:00:00.000Z');
export const RETRY_AHEAD = '2026-10-18T12:05:00.000Z';
export const RETRY_PAST = '2026-10-18T11:55:00.000Z';

/** One `RoundAnswer` as a door answers it. */
export function roundAnswer(outcome: 'passed' | 'vote_pending', extra: { repeated?: true } = {}) {
  return {
    networkId: 'n1', networkLabel: 'Team', roundId: 'r1',
    round: {
      roundId: 'r1', type: 'space_deletion', subjectInstanceId: 'i-self', subjectLabel: 'self', deadline: '2026-10-25T12:00:00.000Z',
      openedAt: '2026-10-18T11:59:00.000Z', votes: [{ instanceId: 'i-self', vote: 'yes', castAt: '2026-10-18T11:59:00.000Z' }],
      spaceId: 'proj', networkSpaceId: 'proj', localSpaceId: 'proj', summary: 'Delete space proj',
    },
    outcome, ...extra,
  };
}

export interface WireAnswer { status: number; body: Record<string, unknown> | null }

/** Every answer of `DELETE /api/spaces/:id` that reaches the outcome parser (400/403/409/429 go to refusalText, not here). */
export const DELETE_ANSWERS = {
  localDone: { status: 204, body: null },
  votedDone: { status: 200, body: { status: 'deleted', rounds: [roundAnswer('passed')], removedHere: true } },
  votedDoneKeptHere: { status: 200, body: { status: 'deleted', rounds: [roundAnswer('passed')], removedHere: false } },
  repeatedDone: { status: 200, body: { status: 'deleted', rounds: [roundAnswer('passed', { repeated: true })], removedHere: true, repeated: true } },
  localRepeatedDone: { status: 200, body: { status: 'deleted', rounds: [], removedHere: true, repeated: true } },
  votePending: { status: 202, body: { status: 'vote_pending', rounds: [roundAnswer('vote_pending')] } },
  votePendingRepeated: { status: 202, body: { status: 'vote_pending', rounds: [roundAnswer('vote_pending', { repeated: true })], repeated: true } },
  votedQueued: { status: 202, body: { status: 'passed', rounds: [roundAnswer('passed')], queued: true, retryAt: RETRY_AHEAD } },
  votedQueuedRunning: { status: 202, body: { status: 'passed', rounds: [roundAnswer('passed')], queued: true } },
  localQueued: { status: 202, body: { queued: true, retryAt: RETRY_AHEAD } },
  localQueuedOverdue: { status: 202, body: { queued: true, retryAt: RETRY_PAST, repeated: true } },
  localQueuedRunning: { status: 202, body: { queued: true } },
  votedFailed: { status: 500, body: { error: SPACE_ACT_FAILED_SENTENCE, code: 'space_act_failed', status: 'passed', rounds: [roundAnswer('passed')] } },
  localFailed: { status: 500, body: { error: LOCAL_SPACE_ACT_FAILED_SENTENCE, code: 'space_act_failed' } },
  caughtFailure: { status: 500, body: { error: 'The deletion did not complete; see the log.' } },
  votedStoreDown: { status: 503, body: { error: STORE_TIMEOUT_MESSAGE, retryable: true, status: 'passed', rounds: [roundAnswer('passed')] } },
  localStoreDown: { status: 503, body: { error: STORE_TIMEOUT_MESSAGE, retryable: true } },
  shuttingDown: { status: 503, body: { error: 'shutting down' } },
  alreadyGone: { status: 404, body: { error: 'Space \'proj\' not found' } },
} satisfies Record<string, WireAnswer>;

const WIPED = { facts: 3, entities: 2, edges: 1, chrono: 0, files: 0, links: 4 };

/** Every answer of `POST /api/admin/spaces/:id/wipe` that reaches the outcome parser. */
export const WIPE_ANSWERS = {
  localDone: { status: 200, body: { status: 'wiped', deleted: WIPED } },
  votedDone: { status: 200, body: { status: 'wiped', deleted: WIPED, rounds: [roundAnswer('passed')] } },
  repeatedDone: { status: 200, body: { status: 'wiped', rounds: [roundAnswer('passed', { repeated: true })], repeated: true } },
  subscriberRefills: { status: 200, body: { status: 'wiped', deleted: WIPED, refills: true } },
  votePending: { status: 202, body: { status: 'vote_pending', rounds: [roundAnswer('vote_pending')] } },
  votedQueued: { status: 202, body: { status: 'passed', rounds: [roundAnswer('passed')], queued: true, retryAt: RETRY_AHEAD } },
  localQueued: { status: 202, body: { queued: true, retryAt: RETRY_AHEAD } },
  votedFailed: { status: 500, body: { error: SPACE_ACT_FAILED_SENTENCE, code: 'space_act_failed', status: 'passed', rounds: [roundAnswer('passed')] } },
  localFailed: { status: 500, body: { error: LOCAL_SPACE_ACT_FAILED_SENTENCE, code: 'space_act_failed' } },
  caughtFailure: { status: 500, body: { error: 'The wipe did not complete; see the log.' } },
  votedStoreDown: { status: 503, body: { error: STORE_TIMEOUT_MESSAGE, retryable: true, status: 'passed', rounds: [roundAnswer('passed')] } },
  shuttingDown: { status: 503, body: { error: 'shutting down' } },
} satisfies Record<string, WireAnswer>;

/** A space's `actPending` (admins only) — `actEntryView`'s shape. */
export function actPending(over: Partial<{ kind: string; since: string; attempts: number; nextRetryAt: string; state: string }> = {}) {
  return { kind: 'delete', since: '2026-10-18T11:50:00.000Z', attempts: 2, nextRetryAt: RETRY_AHEAD, state: 'owed', ...over };
}

/** One entry of a network's `owedSpaceActs` (admins only) — `networkAnswer`'s shape. */
export function owedSpaceAct(over: Record<string, unknown> = {}) {
  return {
    entryId: '6f1c2a40-0000-4000-8000-000000000001', localSpaceId: 'proj', networkSpaceId: 'proj', rounds: [{ roundId: 'r1' }],
    ...actPending(), ...over,
  };
}

/**
 * The words the client shows for a space act (Q-535 design 2-9), one key each. Named here once because three specs ask about them: the
 * danger tab and the Networks page render them, and the contract spec holds each to en/de/pl. `{{name}}` placeholders, no spaces.
 */
export const ACT_TEXT_KEYS = {
  votePending: 'spaces.dangerZone.act.votePending',
  /** `{{when}}`: a relative time ahead, or the words of `retryingNow` / `runsShortly`. */
  queued: 'spaces.dangerZone.act.queued',
  retryingNow: 'spaces.dangerZone.act.retryingNow',
  runsShortly: 'spaces.dangerZone.act.runsShortly',
  repeated: 'spaces.dangerZone.act.repeated',
  keptHere: 'spaces.dangerZone.act.keptHere',
  refills: 'spaces.dangerZone.act.refills',
  wiped: 'spaces.dangerZone.act.wiped',
  /** The standing act (admins): what it is, its state pill, attempts, next retry. */
  standing: 'spaces.dangerZone.act.standing',
  attempts: 'spaces.dangerZone.act.attempts',
  repeatHint: 'spaces.dangerZone.act.repeatHint',
  renameHint: 'spaces.dangerZone.act.renameHint',
  /** Announced (LiveAnnouncement) when a polled act ends. */
  ended: 'spaces.dangerZone.act.ended',
  failedVoted: 'spaces.error.space_act_failed.voted',
  failedLocal: 'spaces.error.space_act_failed.local',
  networkFailed: 'networks.refusal.space_act_failed',
  forecastActsNow: 'spaces.dangerZone.forecast.actsNow',
  forecastOpensVote: 'spaces.dangerZone.forecast.opensVote',
  forecastLocalOnly: 'spaces.dangerZone.forecast.localOnly',
  /** Networks page (admins): the header pill and the list's real heading. */
  owedPill: 'networks.header.owedActs',
  owedTitle: 'networks.owedActs.title',
  /** The body line from `ownYesCarries` (every reader): this instance's yes alone carries a deletion or wipe here, or opens a vote. */
  ownYesCarriesYes: 'networks.network.ownYesCarries.yes',
  ownYesCarriesNo: 'networks.network.ownYesCarries.no',
  /** Spaces list (admins): the pill on a space with a standing act. */
  listPill: 'spaces.table.actPending',
} as const;

/** The server's English, which the client must never show (a11y lens 1): a spec asserts its absence. */
export const SERVER_SENTENCES = [SPACE_ACT_FAILED_SENTENCE, LOCAL_SPACE_ACT_FAILED_SENTENCE];
