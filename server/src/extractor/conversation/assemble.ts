/**
 * Phase 9.1 of the conversation extractor — the extraction, in the committed format (`F-31`, DECOMPOSITION.md
 * 9.1). The format is `benchmarks/plan/extraction-format.md`, and it is the extractor's OUTPUT CONTRACT: the
 * same shape the ten committed LoCoMo extractions have, so the writer and the validator that already exist read
 * this without a second format ever existing.
 *
 * Keys are local to the file: slugs of names and titles, made unique. No Ythril id appears in a record — with
 * ONE product addition the benchmark never needs: a mention merged into an entity the SPACE already holds is
 * `existingEntities: [{ key, id }]`, beside the entities rather than inside them, so the format's own records
 * stay id-free and a writer into a fresh space sees an empty list.
 *
 * `sourceTurns` on an entity (4.11) are the first few turns that mention it, never most of a transcript.
 */
import type { LoadedConversation } from './load.js';
import type { RunEntity } from './judge-entities.js';
import type { KnownEntity } from './shortlist.js';
import type { DatedEdge } from './edge-dates.js';
import type { TimelineEvent } from './timeline.js';
import type { ChangeOutcome } from './change.js';

/** 4.11 — how many turns an entity cites as the ones that introduced it. */
const ENTITY_SOURCE_TURNS = 3;

export interface AssembledClaim {
  key?: string;
  session?: string;
  text: string;
  speaker: string;
  statedOn: string;
  superseded?: boolean;
  attributed?: boolean;
  entities: string[];
  chrono?: string[];
  sourceTurns: string[];
}

export interface Extraction {
  conversationId: string;
  /** `text` is the session's transcript, attached by `ingest` before the write; the extractor never sets it. */
  sessions: { key?: string; date: string; turns: string[]; text?: string }[];
  entities: { key: string; type: string; name: string; description: string; properties?: Record<string, string>; sourceTurns?: string[] }[];
  existingEntities: { key: string; id: string; type: string }[];
  edges: { label: string; from: string; to: string; properties?: Record<string, string> }[];
  chrono: { key: string; type: 'event'; title: string; date: string; endsAt?: string; status: string; entities: string[]; sourceTurns?: string[] }[];
  claims: AssembledClaim[];
  producedBy: { extractor: 'ythril-conversation'; unattended: boolean; backends: string[] };
}

export interface AssembleInput {
  conversationId: string;
  conversation: LoadedConversation;
  /** Minted entities and the speakers — the records this file creates. */
  entities: RunEntity[];
  /** Entities the space already held, that mentions were merged into. */
  existing: (KnownEntity & { aliases: string[] })[];
  descriptions: Map<string, string>;
  claims: { text: string; sourceTurns: string[]; entityIds: string[]; speaker: string; attributed?: boolean; statedOn: string; session: string }[];
  edges: DatedEdge[];
  events: TimelineEvent[];
  change: Pick<ChangeOutcome, 'superseded' | 'supersedes' | 'rewritten'>;
  backends: string[];
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

export function assembleExtraction(input: AssembleInput): Extraction {
  const used = new Set<string>();
  const keyFor = (base: string) => {
    let k = slug(base), n = 2;
    while (used.has(k)) k = `${slug(base)}-${n++}`;
    used.add(k);
    return k;
  };

  // A session carries its key only when the date alone does not identify it (two on one day).
  const sessions = input.conversation.sessions.map(s => ({
    ...(s.key !== s.date ? { key: s.key } : {}), date: s.date, turns: s.turns.map(t => t.id),
  }));

  const entityKey = new Map<string, string>();
  const entities = input.entities.map(e => {
    const key = keyFor(e.name);
    entityKey.set(e.id, key);
    const firstTurns = [...new Set(e.mentions.map(m => m.turnId))].slice(0, ENTITY_SOURCE_TURNS);
    return {
      key, type: e.type, name: e.name,
      description: input.descriptions.get(e.id) ?? `${e.name} (${e.type}).`,
      ...(e.aliases.length ? { properties: { aliases: e.aliases.join('; ') } } : {}),
      ...(firstTurns.length ? { sourceTurns: firstTurns } : {}),
    };
  });
  const existingEntities = input.existing.map(e => {
    const key = keyFor(e.name);
    entityKey.set(e.id, key);
    return { key, id: e.id, type: e.type };
  });
  const keysOf = (ids: string[]) => [...new Set(ids.map(id => entityKey.get(id)).filter((k): k is string => !!k))];

  const chronoKeyByClaim = new Map<number, string[]>();
  const chrono = input.events.map(ev => {
    const key = keyFor(`event ${ev.title}`);
    (chronoKeyByClaim.get(ev.claim) ?? chronoKeyByClaim.set(ev.claim, []).get(ev.claim)!).push(key);
    return {
      key, type: 'event' as const, title: ev.title, date: ev.date, ...(ev.endsAt ? { endsAt: ev.endsAt } : {}),
      status: ev.status, entities: keysOf(ev.entityIds), sourceTurns: input.claims[ev.claim]?.sourceTurns ?? [],
    };
  });

  // A claim carries a key only when an edge names it — the supersedes edges.
  const claimKey = new Map<number, string>();
  for (const s of input.change.supersedes) for (const i of [s.later, s.earlier]) {
    if (!claimKey.has(i)) claimKey.set(i, keyFor(`claim ${input.claims[i]!.text}`));
  }
  const superseded = new Set(input.change.superseded);
  const claims: AssembledClaim[] = input.claims.map((c, i) => ({
    ...(claimKey.has(i) ? { key: claimKey.get(i)! } : {}),
    ...(input.conversation.sessions.find(s => s.key === c.session && s.key !== s.date) ? { session: c.session } : {}),
    text: input.change.rewritten[i] ?? c.text,
    speaker: c.speaker,
    ...(c.attributed ? { attributed: true } : {}),
    statedOn: c.statedOn,
    ...(superseded.has(i) ? { superseded: true } : {}),
    entities: keysOf(c.entityIds),
    ...(chronoKeyByClaim.has(i) ? { chrono: chronoKeyByClaim.get(i)! } : {}),
    sourceTurns: c.sourceTurns,
  }));

  const edges = [
    ...input.edges.flatMap(e => {
      const from = entityKey.get(e.from), to = entityKey.get(e.to);
      return from && to ? [{ label: e.label, from, to, ...(e.properties ? { properties: e.properties } : {}) }] : [];
    }),
    ...input.change.supersedes.map(s => ({ label: 'supersedes', from: claimKey.get(s.later)!, to: claimKey.get(s.earlier)! })),
  ];

  return {
    conversationId: input.conversationId, sessions, entities, existingEntities, edges, chrono, claims,
    producedBy: { extractor: 'ythril-conversation', unattended: true, backends: [...new Set(input.backends)] },
  };
}
