/**
 * Phase 5.4 + 5.5 of the conversation extractor — who ORIGINATED a claim (`F-31`, DECOMPOSITION.md 5.4, 5.5).
 *
 * A claim used to be the speaker of its exchange's first turn, whoever that was. So an assistant that supplied a
 * fact produced a claim filed as the person's — indistinguishable at retrieval from something they said — and one
 * named `assistant` produced a claim the validator refuses, failing the whole conversation.
 *
 * **5.4, asked only where it can matter:** an exchange with an assistant turn in it (the role phase 2.3 judged).
 * One choice: the person, the assistant restating the person, the assistant as origin, or unclear. Policy, in
 * code: only `origin` is the assistant's (`speaker: "assistant"`, `attributed: true`, which the writer stores
 * unranked). Restating, unclear and a refused answer are the PERSON's claim, because they never add an unearned
 * `attributed` — a person's fact hidden from ranking is the worse error.
 *
 * **5.5, for an assistant-originated fact:** did the exchange DO something with it — pick it, book it, come back
 * to it? *"When in doubt, leave it out"*: below the threshold the claim is dropped and reported, so a model's
 * passing suggestion never becomes a record.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';

/** Where a probability becomes a yes. UNMEASURED — see judge-turns.ts `TurnPolicy`. */
export const DEFAULT_ORIGIN_POLICY = { actedAt: 0.5 };

const ORIGIN_CRITERIA = {
  person: 'A person in the exchange stated the fact.',
  restating: 'The assistant repeated or summarised something the person had said.',
  origin: 'The assistant supplied the fact itself — knowledge, a suggestion, something it produced.',
  unclear: 'The turns do not say who it came from.',
};

export interface OriginTurn { id: string; speaker: string; speech: string; role?: 'person' | 'assistant' }

export interface Origin {
  speaker: string;
  attributed: boolean;
  /** Set when the claim must not be written, with the reason (5.5). */
  drop?: string;
  judgement?: JudgementRecord;
}

export async function judgeOrigin(
  input: { claim: string; turns: OriginTurn[]; /** The person to credit when no person speaks in the exchange. */ person?: string },
  decide: Decide,
  policy = DEFAULT_ORIGIN_POLICY,
): Promise<Origin> {
  const firstPerson = input.turns.find(t => t.role !== 'assistant')?.speaker ?? input.person ?? input.turns[0]!.speaker;
  const persons: Origin = { speaker: firstPerson, attributed: false };
  if (!input.turns.some(t => t.role === 'assistant')) return persons;

  const questions: Record<string, Question> = {
    origin: { type: 'choice', criteria: ORIGIN_CRITERIA, instructions: { claim: input.claim, question: 'Who originated the fact in `claim`?' } },
    acted: { type: 'noul', instructions: { claim: input.claim, question: 'If the assistant supplied it: did the exchange DO something with it — pick it, book it, act on it, or come back to it?' } },
  };
  const d = await decide({ claim: input.claim, turns: input.turns.map(t => ({ id: t.id, speaker: t.speaker, role: t.role ?? 'person', text: t.speech })) }, questions);
  const judgement: JudgementRecord = { turnId: input.turns[0]!.id, backend: d.backend, model: d.model, questions, answers: d.answers };
  const origin = d.answers['origin'];
  if (origin?.type !== 'choice' || origin.choice !== 'origin') return { ...persons, judgement };

  const acted = d.answers['acted'];
  if (acted?.type === 'noul' && acted.noul !== null && acted.noul >= policy.actedAt) {
    return { speaker: 'assistant', attributed: true, judgement };
  }
  return { ...persons, drop: 'the assistant supplied it and the exchange did nothing with it — when in doubt, leave it out', judgement };
}
