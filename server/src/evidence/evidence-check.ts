/**
 * The evidence check: a deterministic gate in front of any model that judges whether a text is supported by
 * its evidence — a written claim against its turns, a description against its claims, a proposed fact against
 * a document.
 *
 * ## It refutes only what code can prove
 *
 *  - a **name** in the text that neither the evidence nor the allowed names contain (*"Bella"* when the turns
 *    only ever said *"Luna"*);
 *  - a **number** the evidence does not contain — digits and number words compared as values, so *"two"* and
 *    *"2"* agree;
 *  - a **date** that is not one of the dates resolved for the text.
 *
 * Anything else is `undecided`, which means *ask the model*. **It never says `supported`**: every term being
 * present proves nothing about the relation between them (*"Luna adopted Ada"*), and a gate that passed texts
 * would be a second, weaker judge standing in front of the real one.
 *
 * **Negation that disagrees is a signal and decides nothing.** A claim that negates what its evidence asserts is
 * worth telling the judge about; but *"not"*, *"never"* and *"no"* are so common — *"I never thought I'd get a
 * cat, and now we have Luna"* — that treating a mismatch as proof would refute true claims.
 *
 * Every signal is returned whatever the verdict, so a caller can keep them in its audit trail.
 *
 * Pure, synchronous, and knows nothing about conversations: the caller says what the evidence is and which
 * names and dates are allowed.
 */
import { MONTHS, NUMBER_WORDS } from '../text/english.js';

export interface EvidenceContext {
  /** Names the text may use though the evidence does not spell them — speakers, canonical entity names. */
  names?: string[];
  /** Dates resolved for the text, as the text writes them (`9 May 2023`). Any other date in it is refuted. */
  dates?: string[];
}

export interface EvidenceSignals {
  missingNames: string[];
  missingNumbers: string[];
  missingDates: string[];
  negationMismatch: boolean;
}

export interface EvidenceVerdict {
  /** `refuted`: code can prove the text says something its evidence does not. `undecided`: ask the model. */
  verdict: 'refuted' | 'undecided';
  reasons: string[];
  signals: EvidenceSignals;
}

/** Words that open sentences and are never names; the rest of a sentence's capitals are candidates. */
const NOT_NAMES = new Set(['i', 'a', 'an', 'the', 'as', 'on', 'in', 'at', 'of', 'to', 'and', 'but', 'or', 'mr', 'mrs', 'ms', 'dr']);
const NEGATION = /\b(not|no|never|none|nobody|nothing|neither|nor|without|didn't|don't|doesn't|isn't|wasn't|won't|can't|cannot|hasn't|haven't)\b/i;
const MONTH_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})\\s+(\\d{4})\\b|\\b(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'gi');
/** Numbers as values. `a` / `an` count as one in the time lexicon and never here: they are articles. */
const WORD_NUMBERS = Object.entries(NUMBER_WORDS).filter(([w]) => w !== 'a' && w !== 'an');

const lower = (s: string) => s.toLowerCase().replace(/’/g, "'");

/** The dates a text states, as written — `9 May 2023`, `May 2023`. */
function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MONTH_RE)) out.push(m[0]);
  return out;
}

/** The numbers a text states, as values — digits and spelled-out words — excluding those inside its dates. */
function numbersIn(text: string): string[] {
  const noDates = text.replace(MONTH_RE, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  const out = new Set<string>();
  for (const m of noDates.matchAll(/\b\d+(?:[.,]\d+)?\b/g)) out.add(m[0].replace(',', '.'));
  const l = lower(noDates);
  for (const [w, n] of WORD_NUMBERS) if (new RegExp(`\\b${w}\\b`).test(l)) out.add(String(n));
  return [...out];
}

/** Capitalised words not at the start of a sentence — the names a text uses. */
function namesIn(text: string): string[] {
  const out = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const words = [...sentence.matchAll(/\b[\p{Lu}][\p{L}'-]*\b/gu)];
    for (const m of words) {
      if (m.index === sentence.search(/\S/)) continue;   // the sentence's first word
      const w = m[0].replace(/'s$/, '');
      if (NOT_NAMES.has(w.toLowerCase()) || MONTHS.includes(w.toLowerCase() as typeof MONTHS[number])) continue;
      out.add(w);
    }
  }
  return [...out];
}

export function checkEvidence(text: string, evidence: string[], ctx: EvidenceContext = {}): EvidenceVerdict {
  const body = evidence.join('\n');
  const bodyLower = lower(body);
  const allowed = new Set((ctx.names ?? []).flatMap(n => lower(n).split(/\s+/)));
  const bodyNumbers = new Set(numbersIn(body));
  const allowedDates = new Set((ctx.dates ?? []).map(lower));

  const missingNames = namesIn(text).filter(n => !allowed.has(lower(n)) && !new RegExp(`\\b${lower(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(bodyLower));
  const missingNumbers = numbersIn(text).filter(n => !bodyNumbers.has(n));
  const missingDates = datesIn(text).filter(d => !allowedDates.has(lower(d)) && !bodyLower.includes(lower(d)));
  const negationMismatch = NEGATION.test(text) !== NEGATION.test(body);

  const reasons = [
    ...missingNames.map(n => `names "${n}", which the evidence never mentions`),
    ...missingNumbers.map(n => `states the number ${n}, which the evidence does not`),
    ...missingDates.map(d => `states the date ${d}, which is not one resolved for it`),
  ];
  return {
    verdict: reasons.length ? 'refuted' : 'undecided',
    reasons,
    signals: { missingNames, missingNumbers, missingDates, negationMismatch },
  };
}
