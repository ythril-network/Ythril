/**
 * Phase 5 of the conversation extractor, the parts that are not writing (`F-31`, DECOMPOSITION.md 5.1, 5.3,
 * 5.7). Writing a claim (5.2) is the generative step and lives with the generation client; everything around
 * it is here, so the generated text arrives already grouped and leaves already checked.
 *
 *  - **5.1 exchanges** — which turns are about one thing. A `choice` per turn: `continues` the exchange
 *    before it, `starts` one, or `neither` (thanks, greetings). One request per SESSION: the questions share
 *    the session as their state, and a session boundary always splits.
 *  - **5.3 lint** — a claim reads on its own: every date resolved for its exchange is in the text, it does not
 *    open with a pronoun, and it carries no conversation structure (turn ids, turn numbers, session ordinals).
 *  - **5.7 coverage** — every turn is in some claim's `sourceTurns`, by construction: an uncovered turn joins
 *    the claim of its own exchange, and an exchange with no claim at all is reported rather than dropped.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';

export interface ExchangeSession {
  key: string;
  date: string;
  turns: { id: string; speaker: string; speech: string }[];
}

export interface Exchange {
  sessionKey: string;
  turnIds: string[];
  /** Turns about nothing (`neither`): kept in `sourceTurns`, never written from (5.1 policy, 5.7). */
  ridesAlong: string[];
}

const EXCHANGE_CRITERIA = {
  continues: 'It is about the same thing as the turn before it.',
  starts: 'It turns to something new.',
  neither: 'It is about nothing in particular — a greeting, thanks, a reaction.',
};

/** 5.1 — the exchanges of every session. */
export async function groupExchanges(
  sessions: ExchangeSession[],
  decide: Decide,
): Promise<{ exchanges: Exchange[]; judgements: JudgementRecord[] }> {
  const exchanges: Exchange[] = [];
  const judgements: JudgementRecord[] = [];
  for (const s of sessions) {
    if (!s.turns.length) continue;
    const questions: Record<string, Question> = {};
    for (const t of s.turns.slice(1)) {
      questions[t.id] = { type: 'choice', criteria: EXCHANGE_CRITERIA, instructions: {
        turn: t.id,
        question: 'In `state.turns`, how does the turn with this id relate to the turn just before it?',
      } };
    }
    let answers: Awaited<ReturnType<Decide>>['answers'] = {};
    if (Object.keys(questions).length) {
      const d = await decide({ date: s.date, turns: s.turns.map(t => ({ id: t.id, speaker: t.speaker, text: t.speech })) }, questions);
      judgements.push({ turnId: s.key, backend: d.backend, model: d.model, questions, answers: d.answers });
      answers = d.answers;
    }
    let current: Exchange = { sessionKey: s.key, turnIds: [s.turns[0]!.id], ridesAlong: [] };
    for (const t of s.turns.slice(1)) {
      const a = answers[t.id];
      const said = a?.type === 'choice' ? a.choice : null;
      // A refused answer continues: one exchange too many splits a fact across two claims, which the reader
      // cannot rejoin; one too few makes a longer claim, which still reads.
      if (said === 'starts') {
        exchanges.push(current);
        current = { sessionKey: s.key, turnIds: [t.id], ridesAlong: [] };
      } else {
        current.turnIds.push(t.id);
        if (said === 'neither') current.ridesAlong.push(t.id);
      }
    }
    exchanges.push(current);
  }
  return { exchanges, judgements };
}

/** Words a claim may not open with: its subject has to be NAMED. */
const LEADING_PRONOUN = /^(he|she|they|it|we|i|you|his|her|their|its|our|my|this|that|these|those)\b/i;
/** The conversation's own structure, which is not a fact about the world. */
const STRUCTURE = [
  /\bD\d+:\d+\b/,                                           // a turn id
  /\b(turn|message)\s+#?\d+\b/i,                            // a turn number
  /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|next|previous|\d+(st|nd|rd|th))\s+session\b/i,
  /\bsession\s+#?\d+\b/i,
];

/** 5.3 — why this claim does not read on its own, or `[]`. */
export function lintClaim(text: string, ctx: { dates?: string[] }): string[] {
  const problems: string[] = [];
  for (const d of ctx.dates ?? []) if (!text.includes(d)) problems.push(`the resolved date "${d}" is missing`);
  if (LEADING_PRONOUN.test(text.trim())) problems.push('it opens with a pronoun — name the subject');
  if (STRUCTURE.some(re => re.test(text))) problems.push('it carries conversation structure (a turn or session reference)');
  return problems;
}

/** 5.7 — every turn in some claim: uncovered turns join their exchange's first claim; claimless exchanges are reported. */
export function coverTurns<C extends { sourceTurns: string[] }>(
  claims: C[],
  exchanges: Pick<Exchange, 'turnIds'>[],
): { claims: C[]; uncovered: string[] } {
  const out = claims.map(c => ({ ...c, sourceTurns: [...c.sourceTurns] }));
  const uncovered: string[] = [];
  for (const x of exchanges) {
    const inX = new Set(x.turnIds);
    const owner = out.find(c => c.sourceTurns.some(t => inX.has(t)));
    const covered = new Set(out.flatMap(c => c.sourceTurns));
    const missing = x.turnIds.filter(t => !covered.has(t));
    if (!owner) { uncovered.push(...missing); continue; }
    owner.sourceTurns.push(...missing);
    owner.sourceTurns.sort((a, b) => x.turnIds.indexOf(a) - x.turnIds.indexOf(b));
  }
  return { claims: out, uncovered };
}
