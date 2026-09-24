/**
 * Phase 6.3 of the conversation extractor — an edge's `since` / `until`, only when the text says so (`F-31`,
 * DECOMPOSITION.md 6.3).
 *
 * *"Ada has worked at Acme since 1 March 2021"* dates the relationship; *"on Tuesday Ada talked about Acme"* dates
 * the telling. A date near an edge is not the edge's date, so it is ASKED — one noul per candidate date and end —
 * and the policy is *absent unless confident*: a wrong `since` is a fact the graph states and nobody wrote.
 *
 * **Asked only where an answer can be written.** The candidates are the dates phase 3 resolved to a DAY and did
 * not mark approximate, from the claims the edge was drawn from: the store takes `YYYY-MM-DD`, and 3.6 forbids
 * deriving a day from an approximate date. An edge with none is not asked about at all.
 *
 * **A contradiction writes nothing.** An end before its start means one of the two answers is wrong and code
 * cannot tell which, so both stay absent rather than one being kept at random.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';
import type { DrawnEdge } from './relations.js';
import type { Resolution } from './time.js';

/** Where a probability becomes a yes. UNMEASURED — see judge-turns.ts `TurnPolicy`. */
export const DEFAULT_EDGE_DATE_POLICY = { at: 0.5 };

export type DatedEdge = DrawnEdge & { properties?: { since?: string; until?: string } };

export async function dateEdges(
  edges: DrawnEdge[],
  claims: { text: string; dates: Resolution[] }[],
  ctx: { entities: Map<string, { name: string }>; decide: Decide },
  policy = DEFAULT_EDGE_DATE_POLICY,
): Promise<{ edges: DatedEdge[]; judgements: JudgementRecord[] }> {
  const judgements: JudgementRecord[] = [];
  const out: DatedEdge[] = [];
  for (const edge of edges) {
    const candidates = [...new Set(edge.claims.flatMap(i => claims[i]?.dates ?? [])
      .filter(d => d.precision === 'day' && !d.approximate && d.value).map(d => d.value!))];
    if (!candidates.length) { out.push(edge); continue; }

    const relationship = `${ctx.entities.get(edge.from)?.name ?? edge.from} ${edge.label.replace(/_/g, ' ')} ${ctx.entities.get(edge.to)?.name ?? edge.to}`;
    const questions: Record<string, Question> = {};
    for (const [n, date] of candidates.entries()) {
      questions[`since:${n}`] = { type: 'noul', instructions: { relationship, date, question: 'Does the text say this relationship STARTED on `date`?' } };
      questions[`until:${n}`] = { type: 'noul', instructions: { relationship, date, question: 'Does the text say this relationship ENDED on `date`?' } };
    }
    const d = await ctx.decide({ relationship, claims: edge.claims.map(i => claims[i]?.text) }, questions);
    judgements.push({ turnId: `edge:${edge.from}>${edge.to}:${edge.label}`, backend: d.backend, model: d.model, questions, answers: d.answers });

    /** The candidate the judge was most sure of, at or above the threshold — or none. */
    const pick = (kind: 'since' | 'until') => {
      let best: { date: string; p: number } | undefined;
      for (const [n, date] of candidates.entries()) {
        const a = d.answers[`${kind}:${n}`];
        if (a?.type === 'noul' && a.noul !== null && a.noul >= policy.at && (!best || a.noul > best.p)) best = { date, p: a.noul };
      }
      return best?.date;
    };
    const since = pick('since'), until = pick('until');
    if (since && until && until < since) { out.push(edge); continue; }
    const properties = { ...(since ? { since } : {}), ...(until ? { until } : {}) };
    out.push(Object.keys(properties).length ? { ...edge, properties } : edge);
  }
  return { edges: out, judgements };
}
