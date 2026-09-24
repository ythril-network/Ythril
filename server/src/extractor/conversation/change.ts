/**
 * Phase 7 of the conversation extractor — change over time (`F-31`, DECOMPOSITION.md 7.1–7.6).
 *
 * **7.1 candidates, in code.** Each claim is compared with the few most recent EARLIER claims that share an
 * entity with it — earlier by the order phase 1 fixed, never page order. A claim nothing earlier shares an
 * entity with is not asked about. One request per later claim; its earlier claims are listed in the state.
 *
 * **The questions, per earlier claim j:**
 *
 *  - `change:j` — a choice: `replaced` (the later states the new situation), `ended` (it only says the earlier
 *    stopped), `unchanged`, `unclear`. 7.2 and 7.4 as one choice: whether it changed, and whether anything
 *    replaced it — a `supersedes` edge only for the first, because an edge claims a successor.
 *  - `stillTrue:j` — a noul: was the earlier true of its own period (a habit that stopped, a pet that died)?
 *    A yes vetoes the supersede (7.3), the carve-out asked rather than remembered.
 *  - `telling:j` — a noul: the same unchanged world told two incompatible ways (7.5)? Both are then dated to
 *    their telling — *"As of 9 June 2023, …"* — a template, in code.
 *  - `count:j` — a choice, only when both claims carry a number: `replaced` composition (supersede),
 *    `cumulative` tally (date both), `neither` (both stand) (7.6).
 *
 * **Policy.** *"Expect very few"*: only a clear `replaced` / `ended` supersedes, a refusal retires nothing, and
 * *"never retire something the conversation did not retire"*.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';
import { formatDate } from './write-claim.js';

/** How many earlier claims about the same entity one claim is compared with. */
const EARLIER_PER_CLAIM = 3;
/** Where a probability becomes a yes. UNMEASURED — see judge-turns.ts `TurnPolicy`. */
export const DEFAULT_CHANGE_POLICY = { stillTrueAt: 0.5, tellingAt: 0.5 };

const HAS_NUMBER = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen)\b/i;

const CHANGE_CRITERIA = {
  replaced: 'The later claim states a NEW situation that replaces the earlier one (a new job, a new address).',
  ended: 'The later claim says the earlier situation stopped, with nothing stated in its place.',
  unchanged: 'The earlier claim still holds.',
  unclear: 'The claims do not say.',
};
const COUNT_CRITERIA = {
  replaced: 'The later number replaces the earlier one (the group is now this big).',
  cumulative: 'The later number adds to or counts on from the earlier one (a running tally).',
  neither: 'The numbers are about different things, or the claims do not say.',
};

export interface ChangeOutcome {
  /** Indexes of claims that are no longer true (`superseded: true` on their records). */
  superseded: number[];
  /** `supersedes` edges: the later claim replaced the earlier one. */
  supersedes: { later: number; earlier: number }[];
  /** Claims re-dated to their telling (7.5, 7.6 cumulative): index → the new text. */
  rewritten: Record<number, string>;
  judgements: JudgementRecord[];
}

export async function trackChange(
  claims: { text: string; entityIds: string[]; sessionDate: string }[],
  decide: Decide,
  policy = DEFAULT_CHANGE_POLICY,
): Promise<ChangeOutcome> {
  const out: ChangeOutcome = { superseded: [], supersedes: [], rewritten: {}, judgements: [] };
  const retire = (i: number) => { if (!out.superseded.includes(i)) out.superseded.push(i); };
  const dateTelling = (i: number) => {
    const c = claims[i]!;
    out.rewritten[i] ??= `As of ${formatDate({ precision: 'day', value: c.sessionDate })}, ${c.text}`;
  };

  for (const [li, later] of claims.entries()) {
    const shared = new Set(later.entityIds);
    const earlier: number[] = [];
    for (let j = li - 1; j >= 0 && earlier.length < EARLIER_PER_CLAIM; j--) {
      if (claims[j]!.entityIds.some(id => shared.has(id))) earlier.push(j);
    }
    if (!earlier.length) continue;

    const questions: Record<string, Question> = {};
    for (const j of earlier) {
      const ref = { earlier: claims[j]!.text, later: later.text };
      questions[`change:${j}`] = { type: 'choice', criteria: CHANGE_CRITERIA, instructions: { ...ref, question: 'Did the situation in `earlier` change by the time of `later`?' } };
      questions[`stillTrue:${j}`] = { type: 'noul', instructions: { ...ref, question: 'Was `earlier` true of its own period, even if it is no longer true now (a habit that stopped, a pet that died)?' } };
      questions[`telling:${j}`] = { type: 'noul', instructions: { ...ref, question: 'Are `earlier` and `later` two INCOMPATIBLE tellings of the same unchanged fact (one of them is simply wrong)?' } };
      if (HAS_NUMBER.test(claims[j]!.text) && HAS_NUMBER.test(later.text)) {
        questions[`count:${j}`] = { type: 'choice', criteria: COUNT_CRITERIA, instructions: { ...ref, question: 'How does the number in `later` relate to the number in `earlier`?' } };
      }
    }
    const d = await decide({ later: later.text, earlier: earlier.map(j => claims[j]!.text) }, questions);
    out.judgements.push({ turnId: `claim:${li}`, backend: d.backend, model: d.model, questions, answers: d.answers });
    const yes = (id: string, at: number) => { const a = d.answers[id]; return a?.type === 'noul' && a.noul !== null && a.noul >= at; };
    const choice = (id: string) => { const a = d.answers[id]; return a?.type === 'choice' ? a.choice : null; };

    for (const j of earlier) {
      const change = choice(`change:${j}`);
      if ((change === 'replaced' || change === 'ended') && !yes(`stillTrue:${j}`, policy.stillTrueAt)) {
        retire(j);
        if (change === 'replaced') out.supersedes.push({ later: li, earlier: j });
        continue;
      }
      const count = choice(`count:${j}`);
      if (count === 'replaced') { retire(j); out.supersedes.push({ later: li, earlier: j }); continue; }
      if (count === 'cumulative' || yes(`telling:${j}`, policy.tellingAt)) { dateTelling(j); dateTelling(li); }
    }
  }
  return out;
}
