/**
 * Phase 4.3 of the conversation extractor — the shortlist a mention is matched against (`F-31`,
 * DECOMPOSITION.md 4.3).
 *
 * 4.4 asks the decision model *"is this mention one of these cards, or new?"*. The model can only pick a card
 * it was dealt, so this is judged on whether the right entity is IN the hand — and it deliberately deals
 * near-misses: *"Carolin"* for *"Caroline"*, *"the support group"* for *"Caroline's LGBTQ support group"*.
 * Spelling, casing and paraphrase are the judge's to see past; a card left out can never be picked.
 *
 * Two sources, both bounded:
 *
 *  - **the run** — entities this extraction has already made, matched in code;
 *  - **the space** — what earlier ingests wrote, found through the space's own search (`searchSpace`, the
 *    production adapter is `spaceEntitySearch`), so a second conversation matches against the first.
 *
 * **No list of every entity is ever built.** One space lookup per DISTINCT mention, cached for the run. The
 * cache holds the SPACE's answer only: the run's entities are matched fresh each time, because they grow while
 * the run proceeds and a cached hand would miss the one made a turn ago.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { recall } from '../../brain/recall.js';
import type { DegradedReason } from '../../brain/degraded-reasons.js';

export interface KnownEntity {
  id: string;
  name: string;
  type: string;
  description?: string;
  /** Where the card came from: made by this run, or already in the space. */
  source: 'run' | 'space';
}

/**
 * Who a turn is between, and what it has just been about — what a mention WITHOUT a name refers to.
 *
 * *"I"* is the speaker and *"you"* the person spoken to: that is grammar, so it is dealt in code. *"They"*,
 * *"it"*, *"the book"* point back at something said a few turns ago — which one is a judgement, so the hand is
 * the entities of the recent turns and 4.4 picks. Measured on the committed extractions, references without a
 * name were most of what a name-only shortlist missed.
 */
export interface TurnContext {
  /** The speaker's entity, once there is one. */
  speaker?: KnownEntity;
  /** The one other speaker, when there is exactly one. */
  addressee?: KnownEntity;
  /** Entities of the last few turns, most recent first. */
  recent?: KnownEntity[];
}

const FIRST_PERSON = new Set(['i', 'me', 'my', 'mine', 'myself']);
const SECOND_PERSON = new Set(['you', 'your', 'yours', 'yourself']);
const PLURAL_FIRST = new Set(['we', 'us', 'our', 'ours', 'ourselves']);
/** Pronouns and bare demonstratives: nothing in the words themselves says what they are. */
const POINTING = new Set(['he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'theirs', 'it', 'its',
  'this', 'that', 'these', 'those', 'one', 'ones']);

/** Which kind of name-less mention this is, if it is one — the grammar the hand is dealt by. */
export function pronounKind(mentionName: string): 'first' | 'second' | 'plural-first' | 'pointing' | null {
  const key = normalizeName(mentionName);
  return FIRST_PERSON.has(key) ? 'first' : SECOND_PERSON.has(key) ? 'second'
    : PLURAL_FIRST.has(key) ? 'plural-first' : POINTING.has(key) ? 'pointing' : null;
}

export interface ShortlistSources {
  /** The space's entities that could be `text`. Absent: the run's own entities only. */
  searchSpace?: (text: string) => Promise<KnownEntity[]>;
}

/** Words too common to make two names the same thing on their own. */
const WEAK = new Set(['the', 'a', 'an', 'my', 'our', 'your', 'his', 'her', 'their', 'of', 'and', 'new', 'old', 'big', 'little']);

/** One normal form for a name: lowercase, no leading article, no trailing possessive, no punctuation. */
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/'s\b/g, '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^(the|a|an)\s+/, '');
}

/** Edits between two short strings — enough to see *"Carolin"* in *"Caroline"*, bounded so it stays cheap. */
function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

/**
 * How closely `mention` could be `name`, 0 for not at all — deliberately generous, the judge narrows.
 *
 * Ranked, not boolean, because the hand is bounded: every *"John's …"* shares the word *"john"*, and without a
 * rank the exact *"John's car"* can be crowded out of the hand by six other things John owns.
 */
function closeness(mention: string, name: string): number {
  if (mention === name) return 3;
  if (mention.length >= 4 && withinEdits(mention, name, mention.length >= 8 ? 2 : 1)) return 2;
  const words = (s: string) => s.split(/[\s-]+/).filter(w => w.length >= 4 && !WEAK.has(w));
  const theirs = new Set(words(name));
  return words(mention).some(w => theirs.has(w) || [...theirs].some(t => t.length >= 5 && withinEdits(w, t, 1))) ? 1 : 0;
}

export class Shortlister {
  private readonly run: KnownEntity[] = [];
  private readonly spaceCache = new Map<string, Promise<KnownEntity[]>>();
  private readonly max: number;

  constructor(private readonly sources: ShortlistSources, opts: { max?: number } = {}) {
    this.max = opts.max ?? 6;
  }

  /** An entity this run made — it is a card for every later mention. */
  addRunEntity(e: KnownEntity): void { this.run.push(e); }

  /**
   * The cards `mentionName` is matched against, no card twice, bounded: a pronoun's by grammar and context; a
   * name's from the run first, then the recent turns' when the mention is a bare noun, then the space.
   */
  async shortlist(mentionName: string, ctx: TurnContext = {}): Promise<KnownEntity[]> {
    const key = normalizeName(mentionName);
    if (!key) return [];
    const bounded = (xs: (KnownEntity | undefined)[]) => {
      const seen = new Set<string>();
      return xs.filter((e): e is KnownEntity => !!e && !seen.has(e.id) && (seen.add(e.id), true)).slice(0, this.max);
    };
    switch (pronounKind(key)) {
      case 'first': return bounded([ctx.speaker]);
      case 'second': return bounded([ctx.addressee]);
      case 'plural-first': return bounded([ctx.speaker, ...(ctx.recent ?? [])]);
      case 'pointing': return bounded(ctx.recent ?? []);
    }
    const fromRun = this.run
      .map(e => ({ e, c: closeness(key, normalizeName(e.name)) }))
      .filter(x => x.c > 0)
      .sort((a, b) => b.c - a.c)
      .map(x => x.e);
    // A bare common noun ("the book", "the studio") names a kind, not a thing: which one is usually the one
    // just talked about, so the recent turns' entities join the hand behind the name matches.
    const bare = !/[A-Z]/.test(mentionName.replace(/^(The|A|An)\s/, '')) ? (ctx.recent ?? []) : [];
    let space = this.spaceCache.get(key);
    if (!space && this.sources.searchSpace) {
      space = this.sources.searchSpace(mentionName);
      this.spaceCache.set(key, space);
    }
    const fromSpace = space ? await space : [];
    return bounded([...fromRun, ...bare, ...fromSpace]);
  }
}

/**
 * Where the space searches of one extraction say they were incomplete (`Q-326`, vet A-S10, P10).
 *
 * While the space's entity index is being built or rebuilt, `recall` answers fewer candidates and says so in `degraded`;
 * a hand dealt from that answer can miss the entity a mention names, and the judge then makes a NEW one — a duplicate,
 * with nobody told. Deferring the extraction was ruled out (P10: a run does not retry, a thrown deferral fails it), so
 * the run proceeds and RECORDS the reasons. Ambient rather than a parameter, because the search is called from deep
 * inside the extractor (`extractConversation` → `Shortlister` → `searchSpace`) and the run that must hear it is the
 * caller of all of them: {@link collectingSearchDegraded} opens the scope, {@link spaceEntitySearch} adds to it.
 */
const searchDegraded = new AsyncLocalStorage<DegradedReason[]>();

/** Run `fn`, collecting into `into` every reason a space search inside it answered `degraded` for, once each. */
export function collectingSearchDegraded<T>(into: DegradedReason[], fn: () => Promise<T>): Promise<T> {
  return searchDegraded.run(into, fn);
}

/**
 * The production `searchSpace`: the space's own entity search — lexical and vector together, so a misspelt
 * name still finds its entity — limited to a handful. What `recall` ranks is what the space already trusts.
 * Its `degraded` reasons reach the scope {@link collectingSearchDegraded} opened, when one is open.
 */
export function spaceEntitySearch(spaceId: string, topK = 5): (text: string) => Promise<KnownEntity[]> {
  return async (text) => {
    // One collector per recall, merged after: the recall counts a reason on the metric once per recall it is new to.
    const degraded: string[] = [];
    const results = await recall(spaceId, text, topK, undefined, ['entity'], undefined, undefined, undefined, { degraded });
    const scope = searchDegraded.getStore();
    for (const reason of degraded as DegradedReason[]) if (scope && !scope.includes(reason)) scope.push(reason);
    return results.flatMap(r => (r.type === 'entity'
      ? [{ id: r._id, name: r.name, type: r.entityType, ...(r.description ? { description: r.description } : {}), source: 'space' as const }]
      : []));
  };
}
