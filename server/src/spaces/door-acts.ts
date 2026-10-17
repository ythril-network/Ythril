/**
 * Wait for the space acts a door started — under the door's stated budget — and say what they came to (bundle-106, design v5 §2.2
 * (1)-(3), W1, W6, X9, X17). One module for the wipe doors and the deletion door, so the repeat rule, the budget and the release are
 * written once.
 *
 * ## What it prevents
 *
 * An unbounded wait put a door's answer behind a ten-minute wipe, so a proxy answered `504` and the client read a failure; an answer
 * given before the act finished was never audited, because the completion assumed a door would tell; a retried wipe opened a second
 * round and wiped again; and a client looping on a failing act started a drain and a store operation per call. Here, once: the door's
 * wait ends at `spaceActAnswerMs()` (the act goes on, and its entry is durable, so "queued" is true across a restart); every act the door
 * waited for is RELEASED when it answers — from then on its completion is audited, because nobody else is told; a repeat joins the act
 * already registered as a waiter and never starts it twice; and an owed act whose `retryAt` is ahead is answered, not started.
 */
import type { Config, NetworkConfig, SpaceActEntry } from '../config/types.js';
import { settledWithin } from '../util/time-bound.js';
import { runSpaceAct, releaseSpaceActWaiter, spaceActAnswerMs, spaceActDueAt, SpaceActsClosedError } from './space-act-runner.js';
import { settleRounds, type SettledSpaceRound } from '../networks/round-conclusion.js';
import { roundAnswer, type RoundAnswer } from '../networks/vote-acts.js';
import type { Proposed, RoundInProgress } from '../networks/propose-round.js';

/**
 * One network's round a door opened or repeated — or, with no `answer`, the act no vote decides (an unnetworked space, a subscriber's
 * own copy): what the door waits for from it.
 */
export interface DoorRound {
  /** The round as every opening door answers it; absent for a local act, which acts at once and shows no round. */
  answer?: RoundAnswer;
  acts: string[];
  settled: Promise<SettledSpaceRound[]>[];
  /** An owed act the repeat found not yet due: nothing is started for it, and the door answers when it is retried. */
  retryAt?: string;
  /** A local act that joined one already standing (a door repeat). */
  repeated?: true;
}

/**
 * A local act — no vote decides it — as the door waits for it: the act already `standing` for it is answered (owed with its retry
 * ahead: nothing starts, X9) or joined as a waiter; with none standing, `register` registers it and it is joined.
 */
export function localAct(standing: SpaceActEntry | undefined, register: () => string): DoorRound {
  if (standing) {
    if (!spaceActDueAt(standing, Date.now())) {
      return { acts: [], settled: [], retryAt: standing.retryAt, repeated: true };
    }
    return { acts: [standing.id], settled: [joinSpaceAct(standing.id)], repeated: true };
  }
  const id = register();
  return { acts: [id], settled: [joinSpaceAct(id)] };
}

/** A round `proposeRound` just opened, as a door waits for it. */
export function openedRound(proposed: Pick<Proposed, 'answer' | 'acts' | 'settled'>): DoorRound {
  return { answer: proposed.answer, acts: [...proposed.acts], settled: [proposed.settled] };
}

/** Join (or start) the act of entry `entryId` as a waiter — for a door that repeats an act already registered. */
export function joinSpaceAct(entryId: string): Promise<SettledSpaceRound[]> {
  return runSpaceAct(entryId, { waiter: true, via: 'door' }).then(r => [r]);
}

/**
 * This instance's own round a door repeats (`ownSpaceRoundInProgress`), as the door waits for it: an open round answers itself; an act
 * running or due is joined (one owed and never registered — an older build's round — is registered by the settle, as the tick would);
 * one owed with its `retryAt` ahead starts nothing (X9: a client looping on a failing act costs a config read, never a store operation).
 */
export function repeatedRound(net: NetworkConfig, cfg: Config, prior: RoundInProgress, now: number): DoorRound {
  const answer: RoundAnswer = { ...roundAnswer(net, prior.round, prior.state === 'open' ? 'open' : 'passed'), repeated: true };
  if (prior.state === 'open') return { answer, acts: [], settled: [] };
  if (prior.state === 'queued') return { answer, acts: [], settled: [], ...(prior.entry?.retryAt ? { retryAt: prior.entry.retryAt } : {}) };
  if (prior.entry) return { answer, acts: [prior.entry.id], settled: [joinSpaceAct(prior.entry.id)] };
  const retry = settleRounds(net, cfg, [], 'retry', now, [prior.round]);
  return { answer, acts: [...retry.acts], settled: [retry.settled] };
}

/** What the door's rounds came to. `repeated` when any answered round was this instance's earlier one. */
export type DoorEnd =
  /** No round passed here: nothing acted yet. */
  | { kind: 'pending'; rounds: RoundAnswer[]; repeated?: true }
  /** A round passed and its act is still running (the budget ended first), or is owed and retried at `retryAt`. */
  | { kind: 'queued'; rounds: RoundAnswer[]; retryAt?: string; repeated?: true }
  /** A round passed and its act failed: the first failure's cause. */
  | { kind: 'failed'; rounds: RoundAnswer[]; cause: unknown }
  /** Every act that passed completed; `open` when another network's round is still open. */
  | { kind: 'done'; rounds: RoundAnswer[]; results: SettledSpaceRound[]; open: boolean; repeated?: true };

/**
 * Wait for what the rounds a door opened or repeated started, within the door's budget, then release every waiter. Throws only
 * `SpaceActsClosedError` (an act interrupted by shutdown: the doors answer `503`).
 */
export async function awaitDoorRounds(opened: readonly DoorRound[]): Promise<DoorEnd> {
  const rounds = opened.flatMap(o => (o.answer ? [o.answer] : []));
  const repeated = opened.some(o => o.repeated || o.answer?.repeated) ? { repeated: true as const } : {};
  const open = rounds.some(r => r.outcome === 'vote_pending');
  // A local act has no round: it acts as a round that passed would.
  if (!opened.some(o => !o.answer || o.answer.outcome === 'passed')) return { kind: 'pending', rounds, ...repeated };
  const acts = opened.flatMap(o => o.acts);
  const settled = opened.flatMap(o => o.settled);
  const retryAt = opened.map(o => o.retryAt).filter((t): t is string => t !== undefined).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  if (settled.length === 0 && retryAt) return { kind: 'queued', rounds, retryAt, ...repeated };
  const wait = await awaitDoorActs(acts, settled);
  if (!wait.finished) return { kind: 'queued', rounds, ...repeated };
  for (const r of wait.results) {
    if (r.ok) continue;
    if ('interrupted' in r && r.interrupted) throw new SpaceActsClosedError();
    if ('refused' in r && r.refused) continue;
    return { kind: 'failed', rounds, cause: ('cause' in r && r.cause !== undefined) ? r.cause : new Error(r.error ?? 'the act did not complete') };
  }
  if (retryAt) return { kind: 'queued', rounds, retryAt, ...repeated };
  return { kind: 'done', rounds, results: wait.results, open, ...repeated };
}

/** What a door's wait came to: every act and addition it waited for, or `finished: false` when the budget ended first. */
export type DoorWait<T> = { finished: true; results: T[] } | { finished: false };

/**
 * Wait for `settled` within the door's budget, then release the waiters of `acts` — whichever came first. Never rejects (`settled`
 * never does).
 */
export async function awaitDoorActs<T>(acts: readonly string[], settled: readonly Promise<T[]>[]): Promise<DoorWait<T>> {
  try {
    const wait = await settledWithin(Promise.all(settled).then(lists => lists.flat()), spaceActAnswerMs());
    return wait.finished ? { finished: true, results: wait.value } : { finished: false };
  } finally {
    for (const id of new Set(acts)) releaseSpaceActWaiter(id);
  }
}
