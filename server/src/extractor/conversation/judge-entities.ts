/**
 * Phase 4 of the conversation extractor — the entity judgements and the policy over them (`F-31`,
 * DECOMPOSITION.md 4.12, 4.2, 4.4, 4.5, 4.6, 4.8, 4.9).
 *
 * Code has found the mentions (4.1, `mentions.ts`) and deals each a hand (4.3, `shortlist.ts`). Per turn, ONE
 * request asks the decision model about every mention in it — the questions share the turn as their state:
 *
 *   thing:i  noul    is this a thing the conversation is about, not a passing noun (4.12)
 *   match:i  choice  which of these cards is it — or `new` (a pronoun: or `none`) (4.4)
 *   type:i   choice  which of the SPACE's entity types would it be — or `none` (4.2)
 *   group:i  noul    does it name a group, *"the kids"* (4.6)
 *
 * `type` is asked with `match` rather than after it: it needs no candidates, so a second round trip would buy
 * nothing (the building guide's rule). A pronoun is never asked `thing` or `type` — it is not a thing, its
 * referent is — and *"I"* / *"you"* are not asked at all: the speaker and the one addressee are grammar.
 *
 * ## The policy, in code
 *
 * - **4.5 prefer the merge.** A picked card IS a merge, whatever the confidence: a wrong duplicate is netted by
 *   the space's near-duplicate scanner, while a missing merge splits one person in two with nothing to join
 *   them. (A merge that dates rule out — 4.7 — waits for phase 3's dates to reach claims.)
 * - **4.2 no type, no entity.** `none`, or an answer outside the space's types, and the mention stays text in
 *   the claim. *"Do not invent a type"* is structural: the choice has no other options.
 * - **4.8 mint only what the conversation returns to.** A new entity mentioned once is `unreturned`, not
 *   minted — kept aside so a claim or edge that links it (phases 5–6) can still mint it.
 * - **4.9 aliases** are every surface form merged into one entity other than its name.
 * - A refused answer never adds anything: no thing, no type, no merge.
 *
 * New entities join the shortlist as they are made, so a later mention can be matched to one made a turn ago.
 * Every request and its raw answers are returned with the run.
 */
import type { Question } from '../decide.js';
import type { Decide, JudgementRecord } from './judge-turns.js';
import type { Mention } from './mentions.js';
import { pronounKind, type KnownEntity, type Shortlister } from './shortlist.js';

/** Where a probability becomes a yes. UNMEASURED — see `TurnPolicy` in judge-turns.ts for why 0.5. */
export const DEFAULT_ENTITY_POLICY = { thingAt: 0.5, groupAt: 0.5 };

/** How many turns back "the recent turns" reach, for a pronoun's or a bare noun's hand. */
const RECENT_TURNS = 6;

export interface EntityTurn { id: string; speaker: string; speech: string }

export interface RunEntity {
  id: string;
  name: string;
  type: string;
  group: boolean;
  /** Every surface form merged into this entity other than its name (4.9). */
  aliases: string[];
  mentions: Pick<Mention, 'turnId' | 'start' | 'end' | 'text'>[];
}

export interface EntityJudgement {
  /** New entities the conversation returned to — to be minted. */
  entities: RunEntity[];
  /** New things mentioned once — minted only if a claim or edge links them (4.8). */
  unreturned: RunEntity[];
  /** Mentions merged into entities the SPACE already holds, by their existing id. */
  matchedExisting: (KnownEntity & { aliases: string[]; mentions: RunEntity['mentions'] })[];
  /** The speakers, with the mentions that are theirs (*"I"*, *"you"*, their name). */
  speakers: RunEntity[];
  judgements: JudgementRecord[];
}

export async function judgeEntities(input: {
  turns: EntityTurn[];
  mentions: Map<string, Mention[]>;
  /** The SPACE's entity types and their descriptions — the only types a new entity may take. */
  entityTypes: Record<string, string>;
  shortlister: Shortlister;
  decide: Decide;
  policy?: typeof DEFAULT_ENTITY_POLICY;
}): Promise<EntityJudgement> {
  const { turns, mentions, entityTypes, shortlister, decide } = input;
  const policy = input.policy ?? DEFAULT_ENTITY_POLICY;
  const judgements: JudgementRecord[] = [];

  // Every card this run can deal, by id: the speakers, the entities it makes, and the space's it meets.
  const made = new Map<string, RunEntity>();
  const existing = new Map<string, KnownEntity & { aliases: string[]; mentions: RunEntity['mentions'] }>();
  const speakers = new Map<string, RunEntity>();
  for (const name of new Set(turns.map(t => t.speaker))) {
    const e: RunEntity = { id: `speaker:${name}`, name, type: 'person', group: false, aliases: [], mentions: [] };
    speakers.set(name, e);
    shortlister.addRunEntity({ id: e.id, name, type: 'person', source: 'run' });
  }
  const cardOf = (e: RunEntity): KnownEntity => ({ id: e.id, name: e.name, type: e.type, source: 'run' });
  const attach = (id: string, card: KnownEntity | undefined, m: Mention) => {
    const target = made.get(id) ?? speakersById.get(id)
      ?? existing.get(id) ?? (card && card.source === 'space'
        ? existing.set(id, { ...card, aliases: [], mentions: [] }).get(id)! : undefined);
    if (!target) return false;
    target.mentions.push({ turnId: m.turnId, start: m.start, end: m.end, text: m.text });
    // A pronoun is a way of pointing, not a name — it never becomes an alias.
    if (!pronounKind(m.name) && m.name !== target.name && !target.aliases.includes(m.name)) target.aliases.push(m.name);
    return true;
  };
  const speakersById = new Map([...speakers.values()].map(e => [e.id, e]));
  const recentIds: string[][] = [];   // per previous turn, the entity ids its mentions resolved to

  const typeCriteria = { ...entityTypes, none: 'None of these types fits — it stays a word in the claim, not an entity.' };
  let nextId = 0;

  for (const [ti, turn] of turns.entries()) {
    const found = mentions.get(turn.id) ?? [];
    const others = [...speakers.keys()].filter(s => s !== turn.speaker);
    const recent = [...new Set(recentIds.flat())].map(id => made.get(id) ?? speakersById.get(id))
      .filter((e): e is RunEntity => !!e).map(cardOf);
    const ctx = {
      speaker: cardOf(speakers.get(turn.speaker)!),
      ...(others.length === 1 ? { addressee: cardOf(speakers.get(others[0]!)!) } : {}),
      recent,
    };

    const questions: Record<string, Question> = {};
    const hands: KnownEntity[][] = [];
    const resolvedNow: string[] = [];
    for (const [i, m] of found.entries()) {
      const kind = pronounKind(m.name);
      const hand = await shortlister.shortlist(m.name, ctx);
      hands[i] = hand;
      // "I" and "you" with their one card are grammar, not a question.
      if ((kind === 'first' || kind === 'second') && hand.length === 1) continue;
      const card = (e: KnownEntity) => `${e.name} (${e.type})${e.description ? ` — ${e.description}` : ''}`;
      if (hand.length) {
        questions[`match:${i}`] = { type: 'choice', instructions: {
          mention: m.text,
          question: kind ? 'Who or what does `mention` refer to in `turn.text`?' : 'Is `mention` in `turn.text` one of these, or something new?',
        }, criteria: {
          ...Object.fromEntries(hand.map(e => [e.id, card(e)])),
          ...(kind ? { none: 'None of these — it refers to something not listed, or to nothing specific.' }
            : { new: 'None of these — it is something new.' }),
        } };
      }
      if (kind) continue;
      questions[`thing:${i}`] = { type: 'noul', instructions: { mention: m.text,
        question: 'Is `mention` a specific person, animal, place, organisation, work, object, activity or other THING the '
          + 'conversation is about — not a passing noun or a figure of speech?' } };
      questions[`type:${i}`] = { type: 'choice', instructions: { mention: m.text, question: 'What kind of thing is `mention`?' },
        criteria: typeCriteria };
      questions[`group:${i}`] = { type: 'noul', instructions: { mention: m.text,
        question: 'Does `mention` name a GROUP of people or things taken together ("the kids", "my parents")?' } };
    }

    let answers: Record<string, import('../decide.js').Answer> = {};
    if (Object.keys(questions).length) {
      const d = await decide({
        turn: { speaker: turn.speaker, text: turn.speech },
        before: turns[ti - 1]?.speech,
        after: turns[ti + 1]?.speech,
      }, questions);
      judgements.push({ turnId: turn.id, backend: d.backend, model: d.model, questions, answers: d.answers });
      answers = d.answers;
    }
    const yes = (id: string, at: number) => { const a = answers[id]; return a?.type === 'noul' && a.noul !== null && a.noul >= at; };
    const choice = (id: string) => { const a = answers[id]; return a?.type === 'choice' ? a.choice : null; };

    for (const [i, m] of found.entries()) {
      const kind = pronounKind(m.name);
      const hand = hands[i]!;
      if ((kind === 'first' || kind === 'second') && hand.length === 1) {
        if (attach(hand[0]!.id, hand[0], m)) resolvedNow.push(hand[0]!.id);
        continue;
      }
      const picked = choice(`match:${i}`);
      const pickedCard = hand.find(e => e.id === picked);
      if (pickedCard) {                                      // 4.5: a picked card is a merge
        if (attach(pickedCard.id, pickedCard, m)) resolvedNow.push(pickedCard.id);
        continue;
      }
      if (kind || !yes(`thing:${i}`, policy.thingAt)) continue;   // a pronoun with no referent; a passing noun
      const type = choice(`type:${i}`);
      if (!type || type === 'none' || !(type in entityTypes)) continue;   // 4.2: no type, no entity
      const e: RunEntity = { id: `run:${nextId++}`, name: m.name, type, group: yes(`group:${i}`, policy.groupAt), aliases: [], mentions: [] };
      made.set(e.id, e);
      shortlister.addRunEntity(cardOf(e));
      attach(e.id, undefined, m);
      resolvedNow.push(e.id);
    }
    recentIds.unshift(resolvedNow);
    if (recentIds.length > RECENT_TURNS) recentIds.pop();
  }

  const all = [...made.values()];
  return {
    entities: all.filter(e => e.mentions.length >= 2),
    unreturned: all.filter(e => e.mentions.length < 2),
    matchedExisting: [...existing.values()],
    speakers: [...speakers.values()],
    judgements,
  };
}
