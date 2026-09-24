/**
 * Phases 2 and 3 of the conversation extractor — the judgement half (`F-31`, DECOMPOSITION.md 2.3, 2.5, 3.4,
 * 3.12). `classify.ts` and `time.ts` are the code half; this asks about exactly what they could not decide,
 * and nothing else:
 *
 *  - 2.3  a speaker's role, when the source does not declare one — once per SPEAKER, all in one request;
 *  - 2.5  whether a candidate paste (`pasteReasons` non-empty) is material the speaker brought;
 *  - 3.12 whether a bare weekday (*"we met Friday"*) points back or forward — the tense is the judgement;
 *  - 3.4  whether a forward weekday that IS today's (*"see you Friday"*, said on a Friday) names today.
 *
 * A turn with none of these sends no request. The per-turn questions share one state — the turn and its
 * neighbours — so they go together, as the building guide asks.
 *
 * ## The model judges, code governs
 *
 * Every answer comes back through `decide()`, already checked against its question. What it MEANS is decided
 * here, and every no-match or refused answer routes to the outcome that cannot add a wrong fact: an unknown
 * role is a person (it never adds an `attributed` claim), an unsure paste is the speaker's own words (it is
 * mined, not dropped), an unclear weekday gets no day (it stays in the claim's text).
 *
 * The raw answers are returned with the run, so a threshold can change without asking again.
 */
import type { Decision, Question } from '../decide.js';
import type { LoadedConversation } from './load.js';
import type { ClassifiedTurn } from './classify.js';
import { findTemporalExpressions, resolveExpression, weekdayOf, type Resolution } from './time.js';
import { WEEKDAYS } from './time-lexicon.js';

/** What `decide` looks like to this module — the bound form of `extractor/decide.ts`'s `decide`. */
export type Decide = (state: unknown, questions: Record<string, Question>) => Promise<Decision>;

/**
 * Where a probability becomes a yes. **UNMEASURED**: 0.5 is "more likely yes than no", the one number that
 * needs no fixture to defend. DECOMPOSITION.md requires each to be measured per step on the fixtures, and the
 * raw answers are kept for exactly that — these are replaced when they are, not tuned by hand before.
 */
export interface TurnPolicy {
  /** 2.5 — at or above: the turn is pasted material. */
  pastedAt: number;
  /** 3.4 — at or above: the forward weekday names today. */
  placesTodayAt: number;
}
export const DEFAULT_TURN_POLICY: TurnPolicy = { pastedAt: 0.5, placesTodayAt: 0.5 };

export interface ResolvedTime {
  text: string;
  start: number;
  end: number;
  resolution: Resolution;
}

export interface JudgedTurn extends ClassifiedTurn {
  /** Declared by the source, or decided by 2.3. Never absent after this phase. */
  role: 'person' | 'assistant';
  /** 2.5 — material the speaker brought; phase 5 writes one claim about it and does not mine it. */
  pasted: boolean;
  /** Phase 3, over the SPEECH only — a caption is context, and a date in it is not something anyone said. */
  times: ResolvedTime[];
}

/** One request and what came back, kept whole. */
export interface JudgementRecord {
  /** Set for a per-turn request; absent for the speakers' request. */
  turnId?: string;
  backend: Decision['backend'];
  model: string;
  questions: Record<string, Question>;
  answers: Decision['answers'];
}

const ROLE_CRITERIA = {
  person: 'A human taking part in the conversation, speaking for themselves.',
  assistant: 'An AI assistant or bot answering the others — its statements are not facts about itself.',
  unclear: 'The turns do not show which.',
};

const DIRECTION_CRITERIA = {
  past: 'It refers to that weekday BEFORE the day of speaking (something that happened).',
  future: 'It refers to that weekday AFTER the day of speaking (something planned or expected).',
  unclear: 'The sentence does not say which.',
};

/** How many of a speaker's turns the role question is shown. Enough to see how they talk, not a transcript. */
const ROLE_SAMPLE_TURNS = 4;

export async function judgeConversation(
  conversation: LoadedConversation,
  classified: ClassifiedTurn[][],
  decide: Decide,
  policy: TurnPolicy = DEFAULT_TURN_POLICY,
): Promise<{ turns: JudgedTurn[][]; judgements: JudgementRecord[] }> {
  const judgements: JudgementRecord[] = [];
  const ask = async (state: unknown, questions: Record<string, Question>, turnId?: string) => {
    const d = await decide(state, questions);
    judgements.push({ ...(turnId ? { turnId } : {}), backend: d.backend, model: d.model, questions, answers: d.answers });
    return d.answers;
  };

  const roles = await judgeRoles(classified, ask);

  const turns: JudgedTurn[][] = [];
  for (const [si, session] of conversation.sessions.entries()) {
    const row: JudgedTurn[] = [];
    const sessionTurns = classified[si]!;
    for (const [ti, turn] of sessionTurns.entries()) {
      const found = findTemporalExpressions(turn.speech);
      const questions: Record<string, Question> = {};
      if (turn.pasteReasons.length) {
        questions['paste'] = { type: 'noul', instructions: {
          question: 'Is `turn.text` material the speaker brought into the conversation — a document, email, log or '
            + 'code they pasted — rather than something they are saying themselves?',
          whyAsked: turn.pasteReasons,
        } };
      }
      const today = weekdayOf(session.date);
      for (const [i, f] of found.entries()) {
        if (f.expr.kind !== 'weekday') continue;
        if (f.expr.direction === 'unknown') {
          questions[`direction:${i}`] = { type: 'choice', criteria: DIRECTION_CRITERIA, instructions: {
            question: `In \`turn.text\`, does "${f.text}" point back or forward from the day it was said?`,
          } };
        } else if (f.expr.direction === 'future' && f.expr.weekday === today) {
          questions[`today:${i}`] = { type: 'noul', instructions: {
            question: `"${f.text}" was said on a ${WEEKDAYS[today]}. Does the exchange place it TODAY — `
              + '"on my way", "see you in an hour" — rather than a week from now?',
          } };
        }
      }

      const answers = Object.keys(questions).length
        ? await ask({
          sessionDate: session.date,
          weekday: WEEKDAYS[today],
          turn: { speaker: turn.speaker, text: turn.speech },
          before: sessionTurns[ti - 1]?.speech,
          after: sessionTurns[ti + 1]?.speech,
        }, questions, turn.id)
        : {};

      const yes = (id: string, at: number) => {
        const a = answers[id];
        return a?.type === 'noul' && a.noul !== null && a.noul >= at;
      };
      const times: ResolvedTime[] = found.map((f, i) => {
        let expr = f.expr;
        if (expr.kind === 'weekday' && expr.direction === 'unknown') {
          const a = answers[`direction:${i}`];
          const dir = a?.type === 'choice' ? a.choice : null;
          if (dir === 'past' || dir === 'future') expr = { ...expr, direction: dir };
        }
        const resolution = resolveExpression(expr, session.date, { placesToday: yes(`today:${i}`, policy.placesTodayAt) });
        return { text: f.text, start: f.start, end: f.end, resolution };
      });

      row.push({ ...turn, role: roles.get(turn.speaker) ?? 'person', pasted: yes('paste', policy.pastedAt), times });
    }
    turns.push(row);
  }
  return { turns, judgements };
}

/**
 * 2.3 — every speaker's role. A role the source declared on any of the speaker's turns is taken as given;
 * the rest are asked together, shown a few of their own turns each.
 */
async function judgeRoles(
  classified: ClassifiedTurn[][],
  ask: (state: unknown, questions: Record<string, Question>) => Promise<Decision['answers']>,
): Promise<Map<string, 'person' | 'assistant'>> {
  const roles = new Map<string, 'person' | 'assistant'>();
  const samples = new Map<string, string[]>();
  for (const t of classified.flat()) {
    if (t.role) roles.set(t.speaker, t.role);
    const s = samples.get(t.speaker) ?? [];
    if (s.length < ROLE_SAMPLE_TURNS && t.speech) s.push(t.speech);
    samples.set(t.speaker, s);
  }
  const undeclared = [...samples.keys()].filter(sp => !roles.has(sp));
  if (!undeclared.length) return roles;

  // Ids are positional: a speaker's name is data, and data does not belong in a key the backend echoes.
  const questions: Record<string, Question> = {};
  undeclared.forEach((speaker, i) => {
    questions[`role:${i}`] = { type: 'choice', criteria: ROLE_CRITERIA, instructions: {
      speaker,
      question: 'Is `speaker` a person or an AI assistant, judging from their turns in `state.speakers`?',
    } };
  });
  const answers = await ask({ speakers: Object.fromEntries(undeclared.map(sp => [sp, samples.get(sp)])) }, questions);
  undeclared.forEach((speaker, i) => {
    const a = answers[`role:${i}`];
    // Only a clear `assistant` makes one. `unclear`, a refused answer, or nothing → person.
    roles.set(speaker, a?.type === 'choice' && a.choice === 'assistant' ? 'assistant' : 'person');
  });
  return roles;
}
