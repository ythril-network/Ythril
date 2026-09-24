/**
 * Phase 5.2 + 5.10 of the conversation extractor — one claim per exchange, written and then CHECKED (`F-31`,
 * DECOMPOSITION.md 5.2, 5.3, 5.10).
 *
 * The writer (the assist model, `extractor/generate.ts`) is handed everything already resolved: the dates from
 * phase 3, formatted the way a reader reads them, and the entity names from phase 4. It has nothing to resolve
 * itself, which is the whole point — every judgement that could be a choice was made before it was asked to write.
 *
 * Then the claim is checked twice, because generated text is the one output nothing structural guarantees:
 *
 *  - **5.3 lint** in code (`lintClaim`): dates present, subject named, no conversation structure;
 *  - **5.10 citation** by the decision model: is the claim supported by its own source turns?
 *
 * Either failure gets ONE rewrite with the failure as input. A second failure drops the claim and reports why —
 * *verify and escalate*. A refused citation answer is not a pass.
 *
 * Turns that ride along (5.1 `neither`) are cited in `sourceTurns` and never handed to the writer.
 */
import type { Decide } from './judge-turns.js';
import type { Resolution } from './time.js';
import { lintClaim } from './claims.js';
import { MONTHS } from './time-lexicon.js';

/** Where the citation check's probability becomes a yes. UNMEASURED — see judge-turns.ts `TurnPolicy`. */
export const SUPPORTED_AT = 0.5;

export interface ClaimExchange {
  sessionDate: string;
  turns: { id: string; speaker: string; speech: string }[];
  ridesAlong: string[];
  /** Phase 3's resolutions for the exchange; only those with a day, month or year are handed on. */
  dates: Pick<Resolution, 'precision' | 'value'>[];
  /** Phase 4's names for what the exchange mentions. */
  entities: string[];
}

export interface WrittenClaim { text: string; sourceTurns: string[] }

export interface WriteOutcome {
  claim: WrittenClaim | null;
  dropped?: { reason: string; lastText: string };
  attempts: number;
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** A resolved date as a reader reads it: `9 May 2023`, `March 2023`, `2021` — or null when there is no date. */
export function formatDate(r: Pick<Resolution, 'precision' | 'value'>): string | null {
  if (!r.value) return null;
  const [y, m, d] = r.value.split('-');
  if (r.precision === 'day' && d) return `${Number(d)} ${cap(MONTHS[Number(m) - 1]!)} ${y}`;
  if (r.precision === 'month' && m) return `${cap(MONTHS[Number(m) - 1]!)} ${y}`;
  if (r.precision === 'year') return y!;
  return null;
}

const SYSTEM = [
  'Write ONE claim: a single self-contained sentence stating the fact this exchange establishes.',
  '- Name every subject; never open with a pronoun.',
  '- Use the dates exactly as given; do not compute or add any other date.',
  '- State only what the turns say. Do not guess, generalise or add.',
  '- Never mention the conversation itself: no turns, messages or sessions.',
  'Reply with the sentence only.',
].join('\n');

export async function writeClaim(
  x: ClaimExchange,
  models: { write: (prompt: { system: string; user: string }) => Promise<string>; decide: Decide },
): Promise<WriteOutcome> {
  const riding = new Set(x.ridesAlong);
  const spoken = x.turns.filter(t => !riding.has(t.id));
  const dates = [...new Set(x.dates.map(formatDate).filter((d): d is string => !!d))];
  const brief = [
    `Conversation date: ${formatDate({ precision: 'day', value: x.sessionDate })}.`,
    dates.length ? `Dates, already resolved — use them as written: ${dates.join('; ')}.` : 'No dates to state.',
    x.entities.length ? `Names to use for what is mentioned: ${x.entities.join('; ')}.` : '',
    'Turns:',
    ...spoken.map(t => `${t.speaker}: ${t.speech}`),
  ].filter(Boolean).join('\n');

  let failure = '';
  let text = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    text = (await models.write({ system: SYSTEM, user: failure ? `${brief}\n\nYour previous attempt was refused: ${failure}\nWrite it again.` : brief })).trim();
    const problems = lintClaim(text, { dates });
    if (problems.length) { failure = `"${text}" — ${problems.join('; ')}`; continue; }
    const d = await models.decide({ turns: spoken.map(t => ({ speaker: t.speaker, text: t.speech })) },
      { supported: { type: 'noul', instructions: { claim: text,
        question: 'Is every part of `claim` stated in `state.turns` — nothing added, guessed or changed?' } } });
    const a = d.answers['supported'];
    if (a?.type === 'noul' && a.noul !== null && a.noul >= SUPPORTED_AT) {
      return { claim: { text, sourceTurns: x.turns.map(t => t.id) }, attempts: attempt };
    }
    failure = `"${text}" — not supported by the turns: state only what they say.`;
  }
  return { claim: null, dropped: { reason: failure, lastText: text }, attempts: 2 };
}
