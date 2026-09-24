/**
 * Phase 8 of the conversation extractor — the timeline (`F-31`, DECOMPOSITION.md 8.1–8.4, with 3.9 and 3.11).
 *
 *  - **8.1** a claim with a resolved date is a candidate event; one without is never asked about.
 *  - **8.2** status is a `choice` among completed / upcoming / cancelled / `unclear`. `active` and `overdue` are
 *    not options, so they cannot be written; `unclear` means no chrono entry — the event stays a claim.
 *  - **8.3** set up and never mentioned again stays `upcoming`: nothing here promotes it.
 *  - **8.4** merely ongoing (a course, a diet) with no stated start moment is an entity, not an event: a `noul`.
 *  - **3.9 + 3.11** a span only when the conversation handed BOTH ends and the thing genuinely lasted more than
 *    a day — the multi-day `noul` is asked only when both ends were handed. Otherwise `chronoDatesFor` decides:
 *    a single day, or nothing, and a date that is not an event's lives in the claim's sentence.
 *
 * The title is the claim's sentence (8.5 — a shortened, generated title is later polish; the claim already
 * reads on its own, which is what a title must do). One request per candidate claim.
 */
import type { Decide, JudgementRecord } from './judge-turns.js';
import { chronoDatesFor, type Resolution } from './time.js';

/** Where a probability becomes a yes. UNMEASURED — see judge-turns.ts `TurnPolicy`. */
export const DEFAULT_TIMELINE_POLICY = { ongoingAt: 0.5, multiDayAt: 0.5 };

export type EventStatus = 'completed' | 'upcoming' | 'cancelled';

export interface TimelineEvent {
  title: string;
  date: string;
  endsAt?: string;
  status: EventStatus;
  entityIds: string[];
  claim: number;
}

const STATUS_CRITERIA = {
  completed: 'It happened.',
  upcoming: 'It is planned or expected and has not happened yet.',
  cancelled: 'It was planned and will not happen.',
  unclear: 'The claim does not say.',
};

export async function buildTimeline(
  claims: { text: string; entityIds: string[]; dates: Resolution[] }[],
  decide: Decide,
  policy = DEFAULT_TIMELINE_POLICY,
): Promise<{ events: TimelineEvent[]; judgements: JudgementRecord[] }> {
  const events: TimelineEvent[] = [];
  const judgements: JudgementRecord[] = [];
  for (const [ci, c] of claims.entries()) {
    // The date the event hangs on: a two-ended one first (it is the one that can make a span), else the first day.
    const dated = c.dates.filter(d => d.precision === 'day' && d.value);
    const res = dated.find(d => d.endsAt) ?? dated[0];
    if (!res) continue;
    const bothEnds = !!res.endsAt;
    const questions = {
      status: { type: 'choice' as const, criteria: STATUS_CRITERIA, instructions: { question: 'What is the status of what `state.claim` describes?' } },
      ongoing: { type: 'noul' as const, instructions: { question: 'Is `state.claim` about something merely ongoing (a course, a diet, a habit) with no single moment it started or happened?' } },
      ...(bothEnds ? { multiDay: { type: 'noul' as const, instructions: {
        question: 'Did what `state.claim` describes genuinely take more than one day — entailed by what it IS (camping, a stay, a festival), not merely possible?' } } } : {}),
    };
    const d = await decide({ claim: c.text }, questions);
    judgements.push({ turnId: `claim:${ci}`, backend: d.backend, model: d.model, questions, answers: d.answers });
    const yes = (id: string, at: number) => { const a = d.answers[id]; return a?.type === 'noul' && a.noul !== null && a.noul >= at; };
    const s = d.answers['status'];
    const status = s?.type === 'choice' ? s.choice : null;
    if (status !== 'completed' && status !== 'upcoming' && status !== 'cancelled') continue;   // unclear, refused
    if (yes('ongoing', policy.ongoingAt)) continue;                                             // 8.4
    const when = chronoDatesFor(res, bothEnds && yes('multiDay', policy.multiDayAt));          // 3.9 + 3.11
    if (!when) continue;
    events.push({ title: c.text, date: when.date, ...(when.endsAt ? { endsAt: when.endsAt } : {}), status, entityIds: c.entityIds, claim: ci });
  }
  return { events, judgements };
}
