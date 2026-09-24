/**
 * Phase 5.9 of the conversation extractor — a background STATE told many times is written once (`F-31`,
 * DECOMPOSITION.md 5.9).
 *
 * *"Ada works at Acme"* said in five sessions is one fact told five times. Written five times it fills five ranked
 * slots with one answer and pushes everything else out of a recall. So a later telling is FOLDED into the first
 * claim that said it: the first keeps its text, and gains the later turns as source turns — coverage holds, and
 * the graph says it once.
 *
 * **Candidates, in code.** A later claim is compared with the few most recent earlier claims that share an entity
 * with it and come from a DIFFERENT session: two claims in one session are two things said, not a repetition. An
 * attributed claim and a person's are never paired — they are different records on purpose.
 *
 * **The question** is the same UNCHANGED fact told again. A change is phase 7's, and this runs BEFORE it, so a
 * changed job is never folded away: *"merge the telling, keep contradictions (phase 7) apart"*.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';

/** How many earlier claims one claim is compared with. */
const EARLIER_PER_CLAIM = 3;
/** Where a probability becomes a yes. UNMEASURED — see judge-turns.ts `TurnPolicy`. */
export const DEFAULT_REPEAT_POLICY = { sameAt: 0.5 };

type Claim = { text: string; session: string; sourceTurns: string[]; entityIds: string[]; attributed?: boolean };

export async function mergeRepeats<C extends Claim>(
  claims: C[],
  decide: Decide,
  policy = DEFAULT_REPEAT_POLICY,
): Promise<{ claims: C[]; merged: { kept: number; folded: number }[]; judgements: JudgementRecord[] }> {
  const judgements: JudgementRecord[] = [];
  const merged: { kept: number; folded: number }[] = [];
  /** Where each claim now lives: itself, or the claim it was folded into. */
  const home = claims.map((_, i) => i);
  const turns = claims.map(c => [...c.sourceTurns]);

  for (const [li, later] of claims.entries()) {
    const shared = new Set(later.entityIds);
    const earlier: number[] = [];
    for (let j = li - 1; j >= 0 && earlier.length < EARLIER_PER_CLAIM; j--) {
      const e = claims[j]!;
      if (home[j] !== j) continue;                                    // already folded; its home is asked instead
      if (e.session === later.session) continue;                      // one session: two things said
      if (!!e.attributed !== !!later.attributed) continue;            // a person's and an assistant's, on purpose
      if (e.entityIds.some(id => shared.has(id))) earlier.push(j);
    }
    if (!earlier.length) continue;

    const questions: Record<string, Question> = {};
    for (const j of earlier) {
      questions[`same:${j}`] = { type: 'noul', instructions: { earlier: claims[j]!.text, later: later.text,
        question: 'Is `later` the same UNCHANGED fact as `earlier`, simply told again? A change, an update or a new detail is not.' } };
    }
    const d = await decide({ later: later.text, earlier: earlier.map(j => claims[j]!.text) }, questions);
    judgements.push({ turnId: `claim:${li}`, backend: d.backend, model: d.model, questions, answers: d.answers });

    // The EARLIEST claim that is the same, so three tellings fold into the first rather than into each other.
    const same = earlier.filter(j => { const a = d.answers[`same:${j}`]; return a?.type === 'noul' && a.noul !== null && a.noul >= policy.sameAt; });
    if (!same.length) continue;
    const kept = Math.min(...same);
    home[li] = kept;
    turns[kept]!.push(...turns[li]!.filter(t => !turns[kept]!.includes(t)));
    merged.push({ kept, folded: li });
  }

  const out = claims.flatMap((c, i) => (home[i] === i ? [{ ...c, sourceTurns: turns[i]! }] : []));
  return { claims: out, merged, judgements };
}
