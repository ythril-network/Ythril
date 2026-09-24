/**
 * The conversation extractor, end to end (`F-31`, DECOMPOSITION.md phases 1–9): a raw conversation in, an
 * extraction in the committed format out. Every phase is its own module; this only runs them in order and hands
 * each the previous one's output. Every model and service is injected — the decision model, the writer, the NLP
 * sidecar, the space's entity search — so the whole pipeline runs under test with stand-ins, and in production
 * with `decide()`, `generate()`, `spansOf()` and `spaceEntitySearch()`.
 *
 * What it returns besides the extraction: every judgement with its raw answers (so a threshold can be measured
 * and changed without asking again), the claims that were dropped and why, and the turns no claim covers.
 */
import type { Question } from '../decide.js';
import type { Decision } from '../decide.js';
import { loadConversation, type ConversationSource } from './load.js';
import { classifyTurns } from './classify.js';
import { judgeConversation, type JudgementRecord } from './judge-turns.js';
import { findMentions } from './mentions.js';
import type { Span } from './nlp-client.js';
import { Shortlister, type KnownEntity } from './shortlist.js';
import { judgeEntities } from './judge-entities.js';
import { groupExchanges, coverTurns, linkClaims } from './claims.js';
import { writeClaim, formatDate } from './write-claim.js';
import { judgeOrigin } from './origin.js';
import { mergeRepeats } from './repeats.js';
import { writeArcs } from './arcs.js';
import { describeEntities } from './describe-entities.js';
import { drawEdges, type EdgeLabel } from './relations.js';
import { dateEdges } from './edge-dates.js';
import { trackChange } from './change.js';
import { buildTimeline } from './timeline.js';
import { assembleExtraction, type Extraction } from './assemble.js';
import type { Resolution } from './time.js';

export interface ExtractDeps {
  decide: (state: unknown, questions: Record<string, Question>) => Promise<Decision>;
  write: (prompt: { system: string; user: string }) => Promise<string>;
  spans: (texts: string[]) => Promise<Span[][]>;
  searchSpace?: (text: string) => Promise<KnownEntity[]>;
}

export interface ExtractVocabulary {
  /** The target space's entity types and their descriptions. */
  entityTypes: Record<string, string>;
  /** The target space's edge labels, their descriptions and allowed endpoint types. */
  edgeLabels: Record<string, EdgeLabel>;
}

export interface ExtractResult {
  extraction: Extraction;
  judgements: JudgementRecord[];
  dropped: { exchange: string[]; reason: string; lastText: string }[];
  uncovered: string[];
}

export async function extractConversation(
  conversationId: string,
  source: ConversationSource,
  vocabulary: ExtractVocabulary,
  deps: ExtractDeps,
): Promise<ExtractResult> {
  const judgements: JudgementRecord[] = [];
  const backends = new Set<string>();
  const decide: ExtractDeps['decide'] = async (state, questions) => {
    const d = await deps.decide(state, questions);
    backends.add(d.backend);
    return d;
  };

  // 1–3: load, classify, judge roles / pastes / time.
  const conversation = loadConversation(source);
  const classified = classifyTurns(conversation);
  const turnPhase = await judgeConversation(conversation, classified, decide);
  judgements.push(...turnPhase.judgements);
  const turns = turnPhase.turns;
  const flat = turns.flat();
  const byId = new Map(flat.map(t => [t.id, t]));
  const sessionOf = new Map(conversation.sessions.flatMap(s => s.turns.map(t => [t.id, s] as const)));

  // 4: mentions (pasted material is not the speaker's words), shortlist, judgements.
  const mentions = await findMentions(
    turns.map(s => s.map(t => ({ id: t.id, speaker: t.speaker, speech: t.pasted ? '' : t.speech }))), deps.spans);
  const shortlister = new Shortlister({ ...(deps.searchSpace ? { searchSpace: deps.searchSpace } : {}) });
  const judged = await judgeEntities({
    // 4.7: each turn's resolved dates, so a merge its dates contradict can be seen as one.
    turns: flat.map(t => {
      const dates = [...new Set(t.times.map(tm => formatDate(tm.resolution)).filter((d): d is string => !!d))];
      return { id: t.id, speaker: t.speaker, speech: t.speech, ...(dates.length ? { dates } : {}) };
    }),
    mentions, entityTypes: vocabulary.entityTypes, shortlister, decide,
  });
  judgements.push(...judged.judgements);
  const allEntities = [...judged.entities, ...judged.unreturned, ...judged.speakers,
    ...judged.matchedExisting.map(e => ({ ...e, group: false }))];
  const namesByTurn = new Map<string, Set<string>>();
  for (const e of allEntities) for (const m of e.mentions) (namesByTurn.get(m.turnId) ?? namesByTurn.set(m.turnId, new Set()).get(m.turnId)!).add(e.name);

  // 5: exchanges, one checked claim each, coverage, links.
  const grouped = await groupExchanges(conversation.sessions.map(s => ({
    key: s.key, date: s.date, turns: s.turns.map(t => ({ id: t.id, speaker: t.speaker, speech: byId.get(t.id)!.speech })),
  })), decide);
  judgements.push(...grouped.judgements);
  const written: { text: string; sourceTurns: string[]; speaker: string; attributed?: boolean; statedOn: string; session: string; dates: Resolution[] }[] = [];
  const dropped: ExtractResult['dropped'] = [];
  for (const x of grouped.exchanges) {
    const xTurns = x.turnIds.map(id => byId.get(id)!);
    const spoken = xTurns.filter(t => !x.ridesAlong.includes(t.id));
    const dates = spoken.flatMap(t => t.times.map(tm => tm.resolution));
    const session = sessionOf.get(x.turnIds[0]!)!;
    const outcome = await writeClaim({
      sessionDate: session.date,
      turns: xTurns.map(t => ({ id: t.id, speaker: t.speaker, speech: t.speech, ...(t.pasted ? { pasted: true } : {}) })),
      ridesAlong: x.ridesAlong,
      dates,
      entities: [...new Set(x.turnIds.flatMap(id => [...(namesByTurn.get(id) ?? [])]))],
    }, { write: deps.write, decide });
    if (!outcome.claim) { dropped.push({ exchange: x.turnIds, ...outcome.dropped! }); continue; }
    // 5.4 / 5.5: whose claim it is — asked only when an assistant speaks in the exchange.
    const origin = await judgeOrigin({
      claim: outcome.claim.text,
      turns: spoken.map(t => ({ id: t.id, speaker: t.speaker, speech: t.speech, role: t.role })),
      person: flat.find(t => sessionOf.get(t.id) === session && t.role !== 'assistant')?.speaker,
    }, decide);
    if (origin.judgement) judgements.push(origin.judgement);
    if (origin.drop) { dropped.push({ exchange: x.turnIds, reason: origin.drop, lastText: outcome.claim.text }); continue; }
    written.push({
      ...outcome.claim, speaker: origin.speaker, ...(origin.attributed ? { attributed: true } : {}),
      statedOn: session.date, session: session.key, dates,
    });
  }
  const covered = coverTurns(written, grouped.exchanges);
  // A speaker takes part in every turn they speak, and nobody mentions themselves by name — so without this a
  // claim naming its speaker ("Ada adopted a cat") could never link her. Present in her own turns, named in the
  // claim: the same two halves `linkClaims` asks of everything else.
  for (const sp of judged.speakers) {
    const own = new Set(sp.mentions.map(m => m.turnId));
    for (const t of flat) if (t.speaker === sp.name && !own.has(t.id)) sp.mentions.push({ turnId: t.id, start: -1, end: -1, text: '' });
  }
  const linked = linkClaims(covered.claims, judged);
  // 5.9: a state told in several sessions is written once — before phase 7, so a change is never folded away.
  const repeats = await mergeRepeats(linked.claims, decide);
  judgements.push(...repeats.judgements);
  const claims = repeats.claims;

  // 4.10: descriptions of what this file creates.
  const created = [...linked.minted, ...judged.speakers];
  const descriptions = await describeEntities(created, claims, deps.write);

  // 6–8: relations, change over time, timeline.
  const typed = new Map(allEntities.map(e => [e.id, { id: e.id, name: e.name, type: e.type }]));
  const rel = await drawEdges(claims, { entities: typed, vocabulary: vocabulary.edgeLabels, decide });
  judgements.push(...rel.judgements);
  // 6.3: an edge's `since` / `until`, only when its own claims say so.
  const dated = await dateEdges(rel.edges, claims, { entities: typed, decide });
  judgements.push(...dated.judgements);
  const change = await trackChange(claims.map(c => ({ text: c.text, entityIds: c.entityIds, sessionDate: c.statedOn })), decide);
  judgements.push(...change.judgements);
  const timeline = await buildTimeline(claims.map(c => ({ text: c.text, entityIds: c.entityIds, dates: c.dates })), decide);
  judgements.push(...timeline.judgements);

  // 5.8: arcs, as well as the moments — added after phase 7, so an arc can never retire the claims it describes.
  const arcs = await writeArcs(claims, typed, { write: deps.write, decide });
  judgements.push(...arcs.judgements);

  // 9: the committed format.
  const usedExisting = new Set(claims.flatMap(c => c.entityIds));
  const extraction = assembleExtraction({
    conversationId, conversation,
    entities: created,
    existing: judged.matchedExisting.filter(e => usedExisting.has(e.id)),
    descriptions,
    claims: [...claims, ...arcs.arcs],
    edges: dated.edges,
    events: timeline.events,
    change,
    backends: [...backends, 'assist'],
  });
  return { extraction, judgements, dropped, uncovered: covered.uncovered };
}
