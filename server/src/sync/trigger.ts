/**
 * Starting a sync cycle from a request, once, for every door that offers it.
 *
 * ## Why this exists
 *
 * Three routes triggered a sync and they had drifted into three different answers to the same questions.
 * `POST /api/networks/:id/sync` could only fire and forget, and swallowed the cycle's failure with a bare
 * `void`. `POST /api/notify/trigger` grew `wait`, `timeoutMs` and `peerId`, and accepted ANY valid token
 * for as long as it did — the guard was wrong because the ROUTER was wrong, and the router was wrong
 * because a sync trigger had been put on the peer notification channel. That route is removed in 5.0; the
 * two that remain say what they sync, and both come through here.
 *
 * Owner, 2026-09-09: *"merge if the goal is the same. then use the strong sides of each."* The goal is the
 * same. The strong sides are the existence check and the global limiter from the networks route, and
 * `wait` / `timeoutMs` / a peer subject from the trigger. This module is where they meet, so a fourth door
 * cannot invent a fourth set of semantics.
 *
 * ## One outcome, two renderings (Q-468)
 *
 * The MCP tool `network_sync` ran the cycles itself: it always waited, had no bound, and so could not take the `wait` and
 * `timeoutMs` the route takes — a second implementation of the wait, and the weaker one. The act is now computed ONCE
 * ({@link networkSyncOutcome}, {@link peerSyncOutcome}) and each door renders what comes back: REST as a status and a body
 * ({@link sendSyncAnswer}), MCP as text and `structuredContent`. Neither door runs a cycle or a time bound of its own, which is
 * what `mcp-network-sync-waits-by-default-and-says-so` holds.
 *
 * ## The one default that differs between the doors, and why it is stated
 *
 * An agent calling `network_sync` wants what the cycle did, and a script or the UI's button wants the answer at once (owner,
 * 2026-10-28). So `wait` defaults to true on MCP ({@link MCP_SYNC_WAIT_DEFAULT}) and false on REST ({@link SYNC_WAIT_DEFAULT}) —
 * the third sanctioned divergence after `maxChars`, held to the same three conditions: deliberate, resolved in ONE place by the
 * door that took the call ({@link resolveSyncWait}), and disclosed — every answer says the `wait` it used, and the `timeoutMs`
 * where a bound applied.
 *
 * ## What it deliberately keeps different between the two subjects
 *
 * A NETWORK cycle races a timeout because it can span many peers and a stuck one would hang the request.
 * A PEER cycle does not: it is bounded by that peer's own request timeouts, and racing it would report a
 * timeout for something already bounded. That asymmetry is real and is preserved here rather than
 * flattened into one code path that pretends the two are the same shape.
 *
 * ## Why every answer carries `ok` as well as `status`, and what `ok` says (bundle-39 D2, Q-331)
 *
 * `ok` is the one-bit summary and `status` is the detail. It is not redundancy: the UI's "Sync now" button
 * reads `r.ok` to colour a banner, and `POST /api/networks/:id/sync` used to answer `{ ok: true }` and
 * nothing else. Dropping it while enriching the response would have made every SUCCESSFUL sync render as
 * "failed" — caught by reading the consumer, not by any test, because the client types the field it wants
 * and an absent one is merely `undefined`. Any integrator reading `ok` on either door is in the same
 * position.
 *
 * `ok` used to mean "the cycle ran", so a cycle in which EVERY member failed answered `200 { ok: true }`, MCP answered `isError` from an error
 * count each of its three branches wrote by hand, and the generic door answered 422. It is now read from the ONE verdict
 * (`syncVerdict`, `sync/cycle-outcome.ts`) that the history row and the metric also use: `ok` is true only when every member synced, the
 * answer carries `outcome` and each member's own outcome (`members[]`, our sentence as its reason), and the HTTP status follows the table — 200
 * (the cycle ran and the body says what it came to), 502 `sync_failed` (no member succeeded), 503 `sync_store_failed` (this instance's
 * database failed), 503 `shutting_down`. A trigger that was only accepted (`wait: false`) says `ok: true`, `status: 'triggered'`: it has no
 * outcome yet. Owner, 2026-11-01: "how can they differ? its different doors to the same house?? the answer should be truthful".
 *
 * ## The failure that has to survive refactoring
 *
 * The cycle OUTLIVES the response on the fire-and-forget path. A rejection therefore has nowhere to go
 * unless something catches it — and when `/api/networks/:id/sync` did not, a failed sync from the UI's
 * "Sync now" button produced no log line, no audit entry, an `ok: true` already sent, and an unhandled
 * rejection at the process level. Every path below attaches a `.catch`, which is the whole reason a
 * fire-and-forget helper is worth having rather than two lines at each call site.
 */
import type { Response } from 'express';
import { log, peerText } from '../util/log.js';
import { sendCaughtFailure } from '../api/send-failure.js';
import { withinTimeBound, isTimeBoundEnded } from '../util/time-bound.js';
import { isShuttingDown } from '../lifecycle.js';
import { MEMBER_OUTCOMES, syncVerdict, type MemberResult, type SyncVerdict } from './cycle-outcome.js';

/** What a synchronous trigger says when its cycle failed for a reason that is not the store's: the reason is in the server log, never in the body. */
const SYNC_FAILED_TEXT = 'The sync cycle failed; the reason is in the server log.';

/** The `?timeoutMs` bound: caller's value, clamped, defaulting to 30s. */
export function syncTimeoutMs(raw: unknown): number {
  return Math.min(Math.max(parseInt(String(raw ?? ''), 10) || 30_000, 1_000), 120_000);
}

/** REST's default for `wait`: answer at once that a cycle was started. A script and the UI's button want the acknowledgement. */
export const SYNC_WAIT_DEFAULT = false;
/**
 * MCP's default for `wait`: run the cycle and report what it did (owner, 2026-10-28). An agent calling `network_sync` wants the
 * outcome, not an acknowledgement it would have to poll behind. The only value that differs between the doors; named here and
 * read only by {@link resolveSyncWait}, never by a call site.
 */
export const MCP_SYNC_WAIT_DEFAULT = true;

/**
 * The `wait` a request asked for, resolved by the door that took it: a stated value reads the same on both doors (`true`, or
 * `'true'`/`'1'` from a query string; anything else stated is false), and what is left unsaid is that door's default.
 */
export function resolveSyncWait(raw: unknown, transport: 'mcp' | 'rest'): boolean {
  if (raw === undefined || raw === null || raw === '') return transport === 'mcp' ? MCP_SYNC_WAIT_DEFAULT : SYNC_WAIT_DEFAULT;
  return raw === true || raw === 'true' || raw === '1' || raw === 1;
}

/**
 * What a sync act came to, before any door renders it. `status`/`body` are the REST answer; `failure` is a throw the cycle ended
 * in (REST answers it through the one sender, MCP rethrows it to its own failure handling); `detail` is the cycle's own result for
 * a door that reports more than the body does (the peer cycle's `notFound`, each member's outcome, the verdict they came to).
 */
export interface SyncAnswer {
  status: number;
  body: Record<string, unknown> & { status: 'triggered' | 'completed' | 'timeout' | 'error' | 'shutting_down'; wait: boolean };
  failure?: { err: unknown; where: string };
  detail?: { notFound?: boolean; networksSynced?: number; errors: number; refused?: number; synced?: number; members: MemberResult[]; verdict: SyncVerdict };
}

/**
 * The fields every waited answer carries about the cycle, from the ONE verdict (`syncVerdict`, bundle-39 D2): `ok` is true only when every
 * member synced, `outcome` is the cycle's word, `code` the refusal code a 502 / 503 carries, `members` each member's own outcome with OUR
 * sentence as its reason (never the driver's or the peer's text). The dedicated REST doors, the generic one and MCP all spread this, so the
 * same cycle reads the same on each (owner, 2026-11-01: "how can they differ? its different doors to the same house??").
 */
export function verdictFields(verdict: SyncVerdict, members: MemberResult[]): { ok: boolean; outcome: SyncVerdict['outcome']; code?: string; members: MemberResult[] } {
  return { ok: verdict.ok, outcome: verdict.outcome, ...(verdict.code ? { code: verdict.code } : {}), members };
}

/**
 * Is a waited answer an error, on the door that renders it as one (MCP's `isError`)? The one rule: the answer says `ok: false` — a
 * timeout, a shutdown, or a cycle in which not every member synced. A trigger that was only accepted (`wait: false`) says `ok: true`.
 */
export function syncAnswerIsError(answer: Pick<SyncAnswer, 'body'>): boolean {
  return answer.body['ok'] === false;
}

/**
 * The status a code is answered with, read off the verdict table itself so the status of `sync_failed`, `sync_store_failed` and
 * `shutting_down` is written once, in `syncVerdict`.
 */
const CODE_STATUS: ReadonlyMap<string, number> = new Map(
  MEMBER_OUTCOMES.map(outcome => syncVerdict([{ outcome }])).flatMap(v => (v.code ? [[v.code, v.status] as [string, number]] : [])),
);

/** The `code` a waited sync answer carries when it came to nothing or was stopped, from the verdict table (`sync_failed`, `sync_store_failed`, `shutting_down`). */
export const SYNC_ANSWER_CODES: readonly string[] = [...CODE_STATUS.keys()];

/**
 * The HTTP status a sync tool result is answered with on a door that has only the result (the generic `POST /api/network_sync`), or undefined
 * when the result is not a sync answer: the same status the dedicated doors give the same cycle — 504 for a wait that ran out, the code's own
 * status when the verdict has one (502 / 503), and 200 for a cycle that ran and whose body says what it came to (partial, refused).
 * `isError` is set on every one of those but the last, so without this the generic door answered all of them 422.
 */
export function syncAnswerStatus(result: { structuredContent?: Record<string, unknown> }): number | undefined {
  const structured = result.structuredContent;
  if (!structured) return undefined;
  if (structured['status'] === 'timeout' && typeof structured['wait'] === 'boolean') return 504;
  if (typeof structured['outcome'] !== 'string' || !Array.isArray(structured['members'])) return undefined;
  const code = structured['code'];
  return (typeof code === 'string' ? CODE_STATUS.get(code) : undefined) ?? 200;
}

/** What a trigger says once shutdown began: no cycle is started, and it is no sync result, so no member is named. */
const SHUTTING_DOWN_TEXT = 'This instance is shutting down, so no sync cycle was started; retry after it restarts.';

/**
 * The answer of a trigger that arrives once shutdown began (503 `shutting_down`), or null to go on. Checked by `networkSyncOutcome` and
 * `peerSyncOutcome` before they start anything, so no door can start a cycle that would join the one being stopped or begin another under a
 * closing database; a door that does work BEFORE the cycle (queuing a change note) asks it first.
 */
export function syncShutdownRefusal(subject: Record<string, unknown>, wait: boolean): SyncAnswer | null {
  if (!isShuttingDown()) return null;
  const verdict = syncVerdict([{ outcome: 'interrupted' }]);
  return {
    status: verdict.status,
    body: { status: 'shutting_down', ...subject, wait, error: SHUTTING_DOWN_TEXT, ...verdictFields(verdict, []) },
  };
}

/**
 * Run a cycle for ONE NETWORK and say what came of it.
 *
 * `wait` false answers `triggered` immediately and logs any later failure. `wait` true races the cycle
 * against `timeoutMs` and answers `completed` (with the cycle's one verdict: 200, or 502 `sync_failed` / 503 `sync_store_failed` /
 * 503 `shutting_down` when nothing synced, this instance's store failed, or shutdown stopped it), `timeout` (504, still running) or `error` (500).
 * Every answer names the `wait` it used, and a waited one the `timeoutMs` that bounded it. Once shutdown began no cycle is started (503).
 */
export async function networkSyncOutcome(
  networkId: string, opts: { wait: boolean; timeoutMs: number; noteId?: string },
): Promise<SyncAnswer> {
  const { runSyncForNetwork } = await import('./engine.js');
  // F-42: every answer names the change note this sync carries, whatever became of the cycle — the note is queued
  // either way and travels with the next cycle that reaches each member.
  const note = opts.noteId ? { noteId: opts.noteId } : {};
  const closing = syncShutdownRefusal({ networkId, ...note }, opts.wait);
  if (closing) return closing;

  if (!opts.wait) {
    void runSyncForNetwork(networkId)
      .catch(err => log.error(`Triggered sync for network ${peerText(networkId)} failed: ${peerText(err)}`));
    return { status: 200, body: { ok: true, status: 'triggered', networkId, wait: false, ...note } };
  }

  try {
    const r = await withinTimeBound(runSyncForNetwork(networkId), opts.timeoutMs, `the sync cycle of network ${networkId}`);
    const verdict = syncVerdict(r.members);
    return {
      status: verdict.status,
      body: { status: 'completed', networkId, wait: true, timeoutMs: opts.timeoutMs, synced: r.synced, errors: r.errors, ...verdictFields(verdict, r.members), ...note },
      detail: { synced: r.synced, errors: r.errors, members: r.members, verdict },
    };
  } catch (err) {
    if (isTimeBoundEnded(err)) {
      // 504 and NOT an error: the cycle is still running, and saying "failed" would send an operator
      // looking for a fault that does not exist.
      return { status: 504, body: { ok: false, status: 'timeout', networkId, wait: true, timeoutMs: opts.timeoutMs, ...note } };
    }
    // Through the one sender (bundle-30 I13): a store failure is its 503 in our words — this answered the
    // exception's message, which for the store's names internal hosts and ports. Anything else is answered by what it is, in our
    // words (`sendCaughtFailure`): the reason is in the server log, not in a body.
    return {
      status: 500,
      body: { ok: false, status: 'error', networkId, wait: true, timeoutMs: opts.timeoutMs, error: SYNC_FAILED_TEXT, ...note },
      failure: { err, where: `synchronous sync trigger for network ${peerText(networkId)}` },
    };
  }
}

/**
 * Run a cycle for ONE PEER, across every network it belongs to, and say what came of it.
 *
 * No timeout race — see the note at the top of this file — so a `timeoutMs` is not taken here and no answer names one.
 * `networksSynced` rather than `synced`, because the unit a peer cycle reports is networks touched.
 */
export async function peerSyncOutcome(peerId: string, opts: { wait: boolean }): Promise<SyncAnswer> {
  const { runSyncForPeer } = await import('./engine.js');
  const closing = syncShutdownRefusal({ peerId }, opts.wait);
  if (closing) return closing;

  if (!opts.wait) {
    void runSyncForPeer(peerId).catch(err => log.error(`Triggered sync for peer ${peerText(peerId)} failed: ${peerText(err)}`));
    return { status: 200, body: { ok: true, status: 'triggered', peerId, wait: false } };
  }
  try {
    const r = await runSyncForPeer(peerId);
    const verdict = syncVerdict(r.members);
    return {
      status: verdict.status,
      body: { status: 'completed', peerId, wait: true, networksSynced: r.networksSynced, errors: r.errors, refused: r.refused, notFound: r.notFound, ...verdictFields(verdict, r.members) },
      detail: { ...r, verdict },
    };
  } catch (err) {
    return {
      status: 500,
      body: { ok: false, status: 'error', peerId, wait: true, error: SYNC_FAILED_TEXT },
      failure: { err, where: `synchronous sync trigger for peer ${peerText(peerId)}` },
    };
  }
}

/** Put a sync answer on the wire: its status and body, or — when the cycle threw — through the one sender every route catch uses. */
export function sendSyncAnswer(res: Response, answer: SyncAnswer): void {
  if (answer.failure) { sendCaughtFailure(res, answer.failure.where, answer.failure.err, answer.body); return; }
  res.status(answer.status).json(answer.body);
}

/** The REST rendering of {@link networkSyncOutcome}. */
export async function triggerNetworkSync(
  res: Response, networkId: string, opts: { wait: boolean; timeoutMs: number; noteId?: string },
): Promise<void> {
  sendSyncAnswer(res, await networkSyncOutcome(networkId, opts));
}

/** The REST rendering of {@link peerSyncOutcome}. */
export async function triggerPeerSync(res: Response, peerId: string, opts: { wait: boolean }): Promise<void> {
  sendSyncAnswer(res, await peerSyncOutcome(peerId, opts));
}
