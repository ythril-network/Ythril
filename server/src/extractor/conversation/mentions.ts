/**
 * Phase 4.1 of the conversation extractor — candidate mentions (`F-31`, DECOMPOSITION.md 4.1).
 *
 * **Select instead of generate**: the model is never asked to NAME a mention, only to judge one proposed here
 * (4.12). So this is judged on RECALL — a thing never proposed can never become an entity — and precision,
 * casing and misspellings are the judge's.
 *
 * The spans come from the NLP sidecar (spaCy's named entities and noun phrases, `nlp-client.ts`); what is
 * added here is only what spaCy cannot know, because it is about the CONVERSATION rather than the language:
 * whose *"my"* is. Ada saying *"my mom"* proposes *"Ada's mom"*, which is how an unnamed person becomes a
 * candidate. *"your"* is the other speaker when there is exactly one; otherwise it stays as said.
 *
 * Run over SPEECH only: a caption is context (2.2), and nothing in it was said.
 */
import { spansOf, type Span } from './nlp-client.js';

export interface MentionTurn {
  id: string;
  speaker: string;
  /** Speech only, captions removed — `ClassifiedTurn.speech`. */
  speech: string;
}

export interface Mention {
  turnId: string;
  start: number;
  end: number;
  /** As said: *"my mom"*. */
  text: string;
  /** As it would be named: possessor resolved (*"Ada's mom"*), otherwise the words as said. */
  name: string;
  /** What the sidecar called it: a named entity, a noun phrase, or a phrase's head noun. */
  kind: 'entity' | 'phrase' | 'head';
  /** spaCy's entity label, a hint for 4.2 — never the type itself. */
  label?: string;
}

const OWN = /^(my|our)\s+/i;
const YOURS = /^your\s+/i;

/** The candidate mentions of every turn, by turn id. `spans` is the sidecar call, handed in by tests. */
export async function findMentions(
  sessions: MentionTurn[][],
  spans: (texts: string[]) => Promise<Span[][]> = spansOf,
): Promise<Map<string, Mention[]>> {
  const turns = sessions.flat();
  const found = await spans(turns.map(t => t.speech));
  const out = new Map<string, Mention[]>();
  let k = 0;
  for (const session of sessions) {
    const speakers = [...new Set(session.map(t => t.speaker))];
    for (const turn of session) {
      const others = speakers.filter(s => s !== turn.speaker);
      const addressee = others.length === 1 ? others[0] : undefined;
      const resolve = (text: string) => (OWN.test(text) ? text.replace(OWN, `${turn.speaker}'s `)
        : YOURS.test(text) && addressee ? text.replace(YOURS, `${addressee}'s `) : text);

      const seen = new Set<string>();
      const list: Mention[] = [];
      const add = (m: Omit<Mention, 'turnId' | 'name'>) => {
        const name = resolve(m.text);
        if (seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        list.push({ turnId: turn.id, ...m, name });
      };
      for (const s of found[k++] ?? []) {
        add({ start: s.start, end: s.end, text: s.text, kind: s.kind, ...(s.label ? { label: s.label } : {}) });
        if (s.head && (s.head.start !== s.start || s.head.end !== s.end)) {
          add({ start: s.head.start, end: s.head.end, text: turn.speech.slice(s.head.start, s.head.end), kind: 'head' });
        }
      }
      out.set(turn.id, list);
    }
  }
  return out;
}
