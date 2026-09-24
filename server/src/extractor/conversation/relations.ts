/**
 * Phase 6 of the conversation extractor — relations (`F-31`, DECOMPOSITION.md 6.1, 6.2, 6.4).
 *
 *  - **6.1** candidate pairs: entities one claim NAMES together (`linkClaims`), never entities merely mentioned
 *    near each other — *"not when merely mentioned together"*.
 *  - **6.2** one `choice` per pair among the labels whose declared endpoint types fit the pair, keyed with their
 *    direction (`owns:<from>><to>`), plus `none`. Code filters the vocabulary FIRST, so an illegal edge cannot be
 *    proposed; and code checks the answer AGAIN, so one that arrives anyway — a different backend, a replayed
 *    run — is not written either. A pair no label fits is not asked about.
 *  - **6.4** degree, strength and change stay in the claim: the edge record has no field for them.
 *
 * One request per claim: the claim's text is the state its pairs share. The same edge from two claims is one
 * edge citing both. `since` / `until` (6.3) arrive with the claim's resolved dates, in assembly.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';

export interface EdgeLabel { description: string; from: string[]; to: string[] }
export interface DrawnEdge { from: string; to: string; label: string; claims: number[] }

type Typed = { id: string; name: string; type: string };

export async function drawEdges(
  claims: { text: string; entityIds: string[] }[],
  ctx: { entities: Map<string, Typed>; vocabulary: Record<string, EdgeLabel>; decide: Decide },
): Promise<{ edges: DrawnEdge[]; judgements: JudgementRecord[] }> {
  const judgements: JudgementRecord[] = [];
  const edges = new Map<string, DrawnEdge>();
  /** The directed labels legal from `a` to `b`, as choice keys. */
  const legal = (a: Typed, b: Typed) => Object.entries(ctx.vocabulary)
    .filter(([, v]) => v.from.includes(a.type) && v.to.includes(b.type))
    .map(([label, v]) => ({ key: `${label}:${a.id}>${b.id}`, label, from: a.id, to: b.id,
      text: `${a.name} ${label.replace(/_/g, ' ')} ${b.name} — ${v.description}` }));

  for (const [ci, claim] of claims.entries()) {
    const ids = [...new Set(claim.entityIds)].filter(id => ctx.entities.has(id));
    const questions: Record<string, Question> = {};
    const options = new Map<string, ReturnType<typeof legal>>();
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = ctx.entities.get(ids[i]!)!, b = ctx.entities.get(ids[j]!)!;
      const opts = [...legal(a, b), ...legal(b, a)];
      if (!opts.length) continue;
      const qid = `rel:${a.id}|${b.id}`;
      options.set(qid, opts);
      questions[qid] = { type: 'choice', instructions: {
        a: a.name, b: b.name,
        question: 'Does `state.claim` ASSERT one of these relationships between `a` and `b` — not merely mention them together?',
      }, criteria: { ...Object.fromEntries(opts.map(o => [o.key, o.text])), none: 'No relationship between them is asserted.' } };
    }
    if (!Object.keys(questions).length) continue;
    const d = await ctx.decide({ claim: claim.text }, questions);
    judgements.push({ turnId: `claim:${ci}`, backend: d.backend, model: d.model, questions, answers: d.answers });
    for (const [qid, opts] of options) {
      const a = d.answers[qid];
      const picked = a?.type === 'choice' ? opts.find(o => o.key === a.choice) : undefined;
      if (!picked) continue;   // none, a refusal, or a key this pair was never offered
      const k = `${picked.label}:${picked.from}>${picked.to}`;
      const e = edges.get(k) ?? edges.set(k, { from: picked.from, to: picked.to, label: picked.label, claims: [] }).get(k)!;
      if (!e.claims.includes(ci)) e.claims.push(ci);
    }
  }
  return { edges: [...edges.values()], judgements };
}
