/**
 * Is this vote round open, and what does a caller that finds it closed say? — ONE answer, for every reader.
 *
 * ## What it prevents
 *
 * A round past its deadline stayed `concluded: false` until a cast, a peer relay or a gossip pass happened to touch it, so every
 * reader that meant "open for votes" and wrote `!round.concluded` listed it as open, took a cast on it and counted it in the space
 * chip — seven readers, seven spellings, two of which parsed the deadline themselves. `a-round-is-open-by-one-reading.test.js`
 * holds that no file but this one parses a deadline and that each reader of "open for votes" asks {@link roundIsOpen}.
 *
 * ## The rules
 *
 * - **A round is open AT its deadline instant** and closed after it (`now <= deadline` is open): the boundary `isRoundPrunable` and
 *   the conclusion always had, so no round changes state at a different instant than it did.
 * - **A deadline nobody can read counts as PAST.** A round that cannot be dated cannot be allowed to stay open for ever, so it
 *   fails closed: not listed, not voted on, concluded by the next pass.
 * - **`now` is passed in.** A request reads the clock once and hands the same number to the check and to the conclusion; two
 *   reads of the clock are how a round came to be refused for being late and then concluded as if it were not.
 *
 * The readers that mean something else by `.concluded` (they want to know what a decided round decided) keep asking it.
 */

/** The longest a network lets a round stay open (`votingDeadlineHours` is 1 to 72). A deadline later than `openedAt` + this is not one a member could have set. */
export const MAX_VOTING_DEADLINE_HOURS = 72;

/** The part of a round this module reads. A peer-adopted copy carries no `concluded` key, which reads as not concluded. */
export interface RoundDatable {
  concluded?: boolean;
  deadline?: string | null;
}

/** Has the round's deadline passed at `now`? Strictly later: at the deadline instant it is still open. Undatable counts as past. */
export function roundPastDeadline(round: Pick<RoundDatable, 'deadline'>, now: number): boolean {
  const deadlineMs = typeof round.deadline === 'string' ? Date.parse(round.deadline) : Number.NaN;
  return !(deadlineMs >= now);
}

/**
 * Does the round's deadline lie further from `openedAt` than a network allows? An unreadable `openedAt` counts as beyond it: the
 * cap cannot be shown to hold. A peer serving such a round could keep it open here for as long as it chose; adoption refuses it.
 */
export function roundDeadlineBeyondCap(round: { openedAt?: string | null; deadline?: string | null }): boolean {
  const openedMs = typeof round.openedAt === 'string' ? Date.parse(round.openedAt) : Number.NaN;
  const deadlineMs = typeof round.deadline === 'string' ? Date.parse(round.deadline) : Number.NaN;
  if (Number.isNaN(openedMs) || Number.isNaN(deadlineMs)) return true;
  return deadlineMs > openedMs + MAX_VOTING_DEADLINE_HOURS * 3_600_000;
}

/** Can this round still be voted on at `now`: not concluded, and not past its deadline. */
export function roundIsOpen(round: RoundDatable, now: number): boolean {
  return !round.concluded && !roundPastDeadline(round, now);
}

/**
 * A passed, unvetoed `space_deletion` or `space_wipe` this instance must act on and has not finished (bundle-106, design v5 §2.1).
 *
 * One predicate of the round, read by the settle, the served mask and the prune — never by a door that refuses, holds or admits: those
 * ask the one standing predicate (`spaceActStands`), which reads the act's entry. A round with nothing to do here never stays owed: it
 * is settled `not-carried` the moment a reader meets it (`spaces/apply-wipe-round.ts`).
 */
export function spaceActOwed(r: { type?: string; concluded?: boolean; passed?: boolean; appliedHere?: boolean }): boolean {
  return (r.type === 'space_deletion' || r.type === 'space_wipe') && r.concluded === true && r.passed === true && r.appliedHere !== true;
}

/**
 * The round types a peer still needs after they end: a round whose effect every member applies is served after it passes, because its
 * proposer may have decided it at open (design v5 §3.1). `join` and `remove` stay out.
 */
export const SERVED_ONCE_PASSED: ReadonlySet<string> = new Set(['space_addition', 'meta_change', 'space_deletion', 'space_wipe']);

/** The part of a join round {@link joinRoundOf} reads. */
interface JoinRoundReadable extends RoundDatable {
  type?: string;
  subjectInstanceId?: string;
  passed?: boolean;
  pendingMember?: { instanceId?: string };
}

/**
 * What a network's join rounds say about one peer, read ONE way (Q-454): `'open'` while a join round naming it can still be voted
 * on; `'refused'` when such a round concluded without passing, or ran past its deadline, and is not yet pruned; `null` when no join
 * round names it, or the one that did passed.
 *
 * It prevents the third spelling. "A pending joiner" was `!r.passed` in the sync data guard — true for a DENIED round too, so read as
 * an admission it would have let a voted-down joiner in — and `!r.concluded` in the credential sweep, which kept a past-deadline
 * joiner's token alive. Each caller now states its question against this answer: standing admits only `'open'`; the data guard
 * refuses on either. `one-reading-of-a-join-round.test.js` holds that no other function scans a network's rounds for a joiner.
 */
export function joinRoundOf(
  net: { pendingRounds?: readonly JoinRoundReadable[] },
  peerId: string,
  now: number,
): 'open' | 'refused' | null {
  let refused = false;
  for (const r of net.pendingRounds ?? []) {
    if (r.type !== 'join') continue;
    if (r.subjectInstanceId !== peerId && r.pendingMember?.instanceId !== peerId) continue;
    if (roundIsOpen(r, now)) return 'open';
    if (!r.passed) refused = true;
  }
  return refused ? 'refused' : null;
}

/** What a door answers when a round cannot take a vote: the status, the sentence, and for an expired one the code and the deadline. */
export interface RoundRefusal {
  status: 404 | 409;
  error: string;
  /** Present on a 409 only: lets a client tell "closed by the clock" from "gone". */
  code?: 'round_expired';
  /** Present on a 409 only: the deadline as the round carries it, so a client formats it in the viewer's own style. */
  deadline?: string;
}

/**
 * The one refusal for a round that is not open, or `null` when it is. The operator act (REST and MCP) and the peer relay answer
 * with it, so the three cannot word it three ways.
 *
 * 404 for a concluded round (the sentence both doors have always used); 409 `round_expired` naming the deadline for one that is
 * still open on paper but past it. An undatable deadline is the 409 too, with the text the round holds.
 */
export function roundClosedRefusal(round: RoundDatable, now: number): RoundRefusal | null {
  if (round.concluded) return { status: 404, error: 'Round not found or already concluded' };
  if (!roundPastDeadline(round, now)) return null;
  const deadline = typeof round.deadline === 'string' ? round.deadline : '';
  return { status: 409, error: `Voting on this round closed at ${deadline || 'an unreadable time'}`, code: 'round_expired', deadline };
}
