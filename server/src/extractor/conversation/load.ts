/**
 * Phase 1 of the conversation extractor — load (`F-31`, DECOMPOSITION.md §1). Code end to end.
 *
 * Turns a source into sessions and turns the later phases can rely on: every session dated, keyed and in
 * TIME order; every turn identified. It refuses a source it cannot read rather than guessing at it (1.1),
 * because every later phase resolves dates against the session date — a wrong one here is wrong everywhere
 * downstream, and a confident date has nothing anywhere to contradict it.
 *
 * Nothing here knows about a benchmark. A conversation is sessions with dates and turns with speakers; that
 * is the whole contract.
 */

/** One turn as a caller sends it. */
export interface SourceTurn {
  /** Optional; assigned `<sessionKey>:<n>` when absent (1.4). */
  id?: string;
  speaker: string;
  text: string;
  /** Declared by sources that know it (a chat export does). Absent means phase 2 decides (2.3). */
  role?: 'person' | 'assistant';
}

/** One session as a caller sends it. */
export interface SourceSession {
  /** `YYYY-MM-DD`. Required: it is what every relative date in the session is resolved against. */
  date: string;
  /** `HH:MM`, optional — orders two sessions that share a day (1.2). */
  time?: string;
  /** Optional; derived when absent (1.3). Two sessions may not share one. */
  key?: string;
  turns: SourceTurn[];
}

export interface ConversationSource {
  sessions: SourceSession[];
}

export interface LoadedTurn {
  id: string;
  speaker: string;
  text: string;
  role?: 'person' | 'assistant';
  /** Position within its session, from 0 — what orders two claims inside one session (phase 7). */
  index: number;
}

export interface LoadedSession {
  key: string;
  date: string;
  time?: string;
  /** Where the caller put it, before ordering — kept so a report can name the session as they know it. */
  sourceIndex: number;
  turns: LoadedTurn[];
}

export interface LoadedConversation {
  /** In TIME order, never page order. */
  sessions: LoadedSession[];
}

/** A source the loader refuses, with every problem at once rather than the first. */
export class ConversationSourceError extends Error {
  constructor(readonly problems: string[]) {
    super(`the conversation cannot be read: ${problems.join('; ')}`);
    this.name = 'ConversationSourceError';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A real calendar day, not merely the right shape — `2023-02-30` is the shape and not a day. */
export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Load a conversation (1.1–1.4). Throws `ConversationSourceError` listing every problem.
 *
 * 1.5 — keeping the verbatim transcript — belongs to the writer, which already files one per session.
 */
export function loadConversation(source: ConversationSource): LoadedConversation {
  const problems: string[] = [];
  if (!source || !Array.isArray(source.sessions) || source.sessions.length === 0) {
    throw new ConversationSourceError(['`sessions` must be a non-empty array']);
  }

  source.sessions.forEach((s, i) => {
    const at = `session ${i}`;
    if (!s || typeof s !== 'object') { problems.push(`${at} is not an object`); return; }
    if (typeof s.date !== 'string' || !isCalendarDate(s.date)) problems.push(`${at}: \`date\` must be a real YYYY-MM-DD day`);
    if (s.time !== undefined && (typeof s.time !== 'string' || !TIME_RE.test(s.time))) problems.push(`${at}: \`time\` must be HH:MM`);
    if (s.key !== undefined && (typeof s.key !== 'string' || s.key.trim() === '')) problems.push(`${at}: \`key\` must be a non-empty string`);
    if (!Array.isArray(s.turns) || s.turns.length === 0) { problems.push(`${at}: \`turns\` must be a non-empty array`); return; }
    s.turns.forEach((t, j) => {
      if (!t || typeof t.speaker !== 'string' || t.speaker.trim() === '') problems.push(`${at} turn ${j}: \`speaker\` required`);
      if (!t || typeof t.text !== 'string') problems.push(`${at} turn ${j}: \`text\` must be a string`);
      if (t?.role !== undefined && t.role !== 'person' && t.role !== 'assistant') problems.push(`${at} turn ${j}: \`role\` is person or assistant`);
    });
  });
  if (problems.length > 0) throw new ConversationSourceError(problems);

  // 1.2 — time order. Date, then time; a session with no time sorts before a timed one on the same day only
  // when the caller put it first, because "no time" says nothing about where in the day it fell.
  const ordered = source.sessions
    .map((s, sourceIndex) => ({ s, sourceIndex }))
    .sort((a, b) => a.s.date.localeCompare(b.s.date)
      || ((a.s.time && b.s.time) ? a.s.time.localeCompare(b.s.time) : 0)
      || a.sourceIndex - b.sourceIndex);

  // 1.3 — keys. A given key is kept; a missing one is the date, suffixed when the day is shared, so the
  // collision is detected rather than remembered.
  const perDay = new Map<string, number>();
  for (const { s } of ordered) perDay.set(s.date, (perDay.get(s.date) ?? 0) + 1);
  const seenOnDay = new Map<string, number>();
  const used = new Set<string>();
  const sessions: LoadedSession[] = ordered.map(({ s, sourceIndex }) => {
    let key = s.key?.trim();
    if (!key) {
      const n = (seenOnDay.get(s.date) ?? 0) + 1;
      seenOnDay.set(s.date, n);
      key = (perDay.get(s.date) ?? 1) > 1 ? `${s.date}-${n}` : s.date;
    }
    if (used.has(key)) problems.push(`two sessions share the key '${key}'`);
    used.add(key);
    return {
      key, date: s.date, ...(s.time ? { time: s.time } : {}), sourceIndex,
      // 1.4 — turn ids.
      turns: s.turns.map((t, index) => ({
        id: t.id?.trim() || `${key}:${index + 1}`,
        speaker: t.speaker.trim(), text: t.text, index,
        ...(t.role ? { role: t.role } : {}),
      })),
    };
  });

  const turnIds = new Set<string>();
  for (const s of sessions) for (const t of s.turns) {
    if (turnIds.has(t.id)) problems.push(`two turns share the id '${t.id}'`);
    turnIds.add(t.id);
  }
  if (problems.length > 0) throw new ConversationSourceError(problems);
  return { sessions };
}
