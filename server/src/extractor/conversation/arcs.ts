/**
 * Phase 5.8 of the conversation extractor — the ARC as well as the moments (`F-31`, DECOMPOSITION.md 5.8).
 *
 * *"Ada applied in August"* and *"Ada passed in October"* answer when; *"the adoption went from researching
 * agencies in May to passing the interviews in October"* answers how it went — and a question about the arc has
 * nothing to match without a claim of its own. So a subject with claims in three or more sessions gets one.
 *
 * **The trigger is code, the text is generative, and the text is checked** — verify and escalate, like 5.10:
 * written by the assist model from the subject's own claims and nothing else, linted (`lintClaim`), refused by the
 * evidence gate for a name, number or date its claims do not contain, citation-checked by the decision model; one
 * rewrite with the failure named, then left out. The writer may answer NONE: a subject mentioned often is not one
 * that developed, and an arc written anyway is a summary nobody asked for.
 *
 * **Bounded.** An arc cites the first turn of each moment it draws on, capped — never most of the conversation,
 * which the validator refuses as a summary. It is ADDITIONAL: the moments stay, and it is added after change
 * tracking, so an arc can never retire the claims it describes. A person's claims only: an assistant's are not
 * the person's history.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';
import { lintClaim } from './claims.js';
import { checkEvidence } from '../../evidence/evidence-check.js';

/** Where a probability becomes a yes. UNMEASURED — see judge-turns.ts `TurnPolicy`. */
export const DEFAULT_ARC_POLICY = { minSessions: 3, maxTurns: 8, supportedAt: 0.5 };

const SYSTEM = [
  'Write ONE sentence saying how the subject developed across the conversation, using ONLY the claims given.',
  '- Name the subject. Keep every date exactly as written; add nothing the claims do not say.',
  '- Never mention the conversation itself: no turns, messages or sessions.',
  'If the claims do not show something that developed or changed over time, reply NONE.',
  'Reply with the sentence only.',
].join('\n');

type Claim = { text: string; session: string; statedOn: string; sourceTurns: string[]; entityIds: string[]; speaker: string; attributed?: boolean };

export async function writeArcs<C extends Claim>(
  claims: C[],
  entities: Map<string, { name: string }>,
  deps: { write: (prompt: { system: string; user: string }) => Promise<string>; decide: Decide },
  policy = DEFAULT_ARC_POLICY,
): Promise<{ arcs: Claim[]; judgements: JudgementRecord[]; dropped: { entityId: string; reason: string }[] }> {
  const arcs: Claim[] = [];
  const judgements: JudgementRecord[] = [];
  const dropped: { entityId: string; reason: string }[] = [];

  for (const [entityId, entity] of entities) {
    const own = claims.filter(c => !c.attributed && c.entityIds.includes(entityId));
    const sessions = [...new Set(own.map(c => c.session))];
    if (sessions.length < policy.minSessions) continue;

    const evidence = own.map(c => c.text);
    const brief = [`Subject: ${entity.name}.`, 'Claims, in order:', ...own.map(c => `- (${c.statedOn}) ${c.text}`)].join('\n');
    const names = [...new Set(own.flatMap(c => c.entityIds).map(id => entities.get(id)?.name).filter((n): n is string => !!n))];
    let failure = '';
    let text = '';
    for (let attempt = 1; attempt <= 2 && !text; attempt++) {
      const got = (await deps.write({ system: SYSTEM, user: failure ? `${brief}\n\nYour previous attempt was refused: ${failure}\nWrite it again, or reply NONE.` : brief })).trim();
      if (!got || /^none\.?$/i.test(got)) { failure = ''; break; }
      const problems = lintClaim(got, {});
      const gate = checkEvidence(got, evidence, { names });
      if (problems.length) { failure = `"${got}" — ${problems.join('; ')}`; continue; }
      if (gate.verdict === 'refuted') { failure = `"${got}" — it ${gate.reasons.join('; it ')}.`; continue; }
      const questions: Record<string, Question> = { supported: { type: 'noul', instructions: { arc: got, question: 'Is every part of `arc` stated by the claims?' } } };
      const d = await deps.decide({ claims: evidence }, questions);
      judgements.push({ turnId: `arc:${entityId}`, backend: d.backend, model: d.model, questions, answers: d.answers });
      const a = d.answers['supported'];
      if (a?.type === 'noul' && a.noul !== null && a.noul >= policy.supportedAt) text = got;
      else failure = `"${got}" — the claims do not support all of it.`;
    }
    if (!text) { if (failure) dropped.push({ entityId, reason: failure }); continue; }

    const last = own[own.length - 1]!;
    // The speaker most of the moments came from: an arc is theirs, told across the sessions.
    const bySpeaker = new Map<string, number>();
    for (const c of own) bySpeaker.set(c.speaker, (bySpeaker.get(c.speaker) ?? 0) + 1);
    const speaker = [...bySpeaker.entries()].sort((x, y) => y[1] - x[1])[0]![0];
    arcs.push({
      text, speaker, statedOn: last.statedOn, session: last.session,
      sourceTurns: [...new Set(own.map(c => c.sourceTurns[0]!).filter(Boolean))].slice(0, policy.maxTurns),
      entityIds: [entityId],
    });
  }
  return { arcs, judgements, dropped };
}
