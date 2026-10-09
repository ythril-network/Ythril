import type { VoteRound } from '../../core/api.types';
import type { CastVoteResult } from '../../core/networks-api.service';
import { outcomeKey, outcomeWord, roundTypeKey } from '../../core/vote-round-view';

/** What `TranslocoService.translate` is to this module — passed in, so what is said is a pure function of its inputs. */
export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** What the page says after a cast, and what it does about the lists. */
export interface CastNotice {
  kind: 'success' | 'info' | 'error';
  message: string;
  /** The round is no longer open for this voter's cast: the lists were stale, and keyboard focus may be on a removed row. */
  reload: boolean;
}

/** "Add space: notes (member-b)" — a round as a person names it, in a toast, a confirmation or a screen reader label. */
export function roundName(round: Pick<VoteRound, 'type' | 'subject'> | undefined, t: Translate): string {
  return round ? `${t(roundTypeKey(round.type))}: ${round.subject}` : '';
}

function roundParams(round: Pick<VoteRound, 'type' | 'subject'> | undefined, t: Translate): Record<string, unknown> {
  return { type: round ? t(roundTypeKey(round.type)) : '', subject: round?.subject ?? '' };
}

/**
 * What a cast that WAS accepted says. A cast that ended the round names how it ended — in words, from the round the
 * server answered with; one that did not says only that the vote is recorded, because the server decides when a round
 * ends and a page that guessed would be announcing a result nobody reached.
 *
 * The answer may lack both fields (an older server answered with an empty body): that is a recorded vote.
 */
export function castNotice(
  result: Partial<CastVoteResult> | null | undefined,
  round: Pick<VoteRound, 'type' | 'subject'> | undefined,
  t: Translate,
): CastNotice {
  if (!result?.concluded) return { kind: 'success', message: t('networks.network.votes.recorded'), reload: false };
  const passed = result.round?.passed === true;
  const word = outcomeWord(result.round?.outcome ?? (passed ? 'passed' : undefined));
  const outcome = t(outcomeKey(word));
  return {
    kind: word === 'passed' ? 'success' : 'info',
    message: t('networks.network.votes.concluded', { ...roundParams(round, t), outcome }),
    reload: true,
  };
}

/**
 * What a REFUSED cast says. A cast on a round that has closed is answered 409 `round_expired` with the deadline as an
 * instant: the page formats it in the viewer's own date preference (`formatInstant`) rather than showing the server's
 * ISO text, and reloads — the row the voter acted on is stale. 404 (the round is gone) reloads the same way.
 */
export function castRefusalNotice(
  err: { status?: number; error?: { error?: string; code?: string; deadline?: string } } | null | undefined,
  round: Pick<VoteRound, 'type' | 'subject'> | undefined,
  t: Translate,
  formatInstant: (iso: string) => string,
): CastNotice {
  const body = err?.error;
  if (err?.status === 409 && body?.code === 'round_expired' && body.deadline) {
    return {
      kind: 'error',
      message: t('networks.network.votes.closed', { ...roundParams(round, t), deadline: formatInstant(body.deadline) }),
      reload: true,
    };
  }
  return {
    kind: 'error',
    message: body?.error ?? t('networks.error.castVoteFailed'),
    reload: err?.status === 404 || err?.status === 409,
  };
}
