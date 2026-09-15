/**
 * LoCoMo, parsed into the harness's neutral shape.
 *
 * ## Why the conversations and the questions come out of separate doors
 *
 * `loadConversations` returns objects that carry no question data at all — not the evidence ids, not the
 * categories, not a count. That is not tidiness. The strongest way to overfit a memory benchmark is to shape
 * extraction around the answer key, and it is invisible from a results table; nobody can tell that a prompt was
 * iterated thirty times against the gold answers. `benchmark-ingest-cannot-see-the-questions.test.js` makes it
 * structural by refusing an ingest module that so much as names the question set, and this file is the other
 * half: even a module that wanted to reach the key from a conversation object has nothing to reach.
 *
 * The dependency runs one way only. Reading the turns is required to validate an evidence reference, so the
 * question loader uses the conversation loader's own session walk. The reverse never happens.
 *
 * ## The release's timestamps carry no timezone, so this file declares one
 *
 * A session reads `"1:56 pm on 8 May, 2023"`. There is no zone, and inventing a local one would make the parse
 * machine-dependent: the same benchmark run in Berlin and in CI would write chrono records hours apart and the
 * diff would look like a retrieval change. `startsAt` is therefore UTC by declaration — the relative ordering,
 * which is the only thing the corpus actually asserts, is identical either way, and a fixed zone is the version
 * that reproduces. The rejected alternative was emitting a naive `2023-05-08T13:56:00` with no `Z`; `new Date()`
 * reads that as local time, which is the machine dependence moved one layer down where it is harder to see.
 *
 * ## Nine malformed evidence references, repaired and reported
 *
 * The public release has nine evidence references that are not a single well-formed `D<session>:<turn>`:
 *
 * | conversation | as released                    | repaired to                        | what was wrong           |
 * |--------------|--------------------------------|------------------------------------|--------------------------|
 * | conv-26      | `D8:6; D9:17`                  | `D8:6`, `D9:17`                    | two ids in one string    |
 * | conv-42      | `D`                            | nothing                            | no id can be read        |
 * | conv-42      | `D10:19`                       | nothing                            | session 10 ends at D10:16|
 * | conv-43      | `D:11:26`                      | `D11:26`                           | a colon after D          |
 * | conv-47      | `D4:36`                        | nothing                            | session 4 ends at D4:25  |
 * | conv-49      | `D9:1 D4:4 D4:6`               | three ids                          | space-joined ids         |
 * | conv-49      | `D22:1 D22:2 D9:10 D9:11`      | four ids                           | space-joined ids         |
 * | conv-49      | `D21:18 D21:22 D11:15 D11:19`  | four ids                           | space-joined ids         |
 * | conv-50      | `D30:05`                       | `D30:5`                            | zero-padded turn number  |
 *
 * Every one of them is returned in a repair report rather than fixed in silence, because a loader that quietly
 * rewrites its input is a loader whose numbers cannot be traced back to the data anybody pinned. The two that
 * name turns which do not exist are reported the same way and dropped from `evidence`: keeping them would make
 * an evidence-recall metric permanently unreachable for those two questions, which reads from a results table as
 * a retriever that failed rather than as a dataset that is wrong.
 *
 * The count nine is documented, not asserted. A gate on it would refuse an upstream release that fixed them —
 * and, worse, would pass unchanged on a *different* nine. The report is the artifact; `report.mjs` writes it out
 * with the run so the repairs are visible next to the scores they affected.
 *
 * ## What this file deliberately leaves alone
 *
 * - **`conv-26` declares 35 `session_N_date_time` keys but has only 19 `session_N` arrays.** Sessions 20-35 have
 *   no turns, no observations, no summary and nothing in the question set references them. The walk is driven by
 *   the turn arrays, so those sixteen orphans never become empty sessions. Naming it here because a silent
 *   `Object.keys` count off by sixteen is exactly the kind of thing a later reader re-derives from scratch.
 * - **Turn text is not trimmed or otherwise touched.** Rung 0 stores it verbatim; a loader that normalised
 *   whitespace would move the lexical channel's floor without anything recording that it had.
 * - **An image caption is exposed beside the turn, never merged into it.** `INGESTION.md` composes rung 0's fact
 *   as `<text> [image: <caption>]` and attributes the caption at rung 2 with `source: 'image_caption'`. That
 *   reversibility only exists while the two are separate here — a caption folded into `text` by the loader is a
 *   machine's guess that has become indistinguishable from something a person said.
 * - **`query` and `re-download` on image turns are dropped.** They are the authors' stock-photo retrieval
 *   scaffolding, not anything either speaker saw or wrote.
 */

import { readFileSync } from 'node:fs';

/** Every refusal in this file is one sentence about the data, prefixed so a stack trace names the subject. */
function refuse(what) {
  throw new Error(`locomo: ${what}`);
}

/*
 * ---------------------------------------------------------------------------------------------------------
 * Timestamps
 * ---------------------------------------------------------------------------------------------------------
 */

/**
 * Month name to number, written out.
 *
 * An index-derived mapping (`MONTHS.indexOf(name) + 1`) is one transposed entry away from moving every date in
 * the corpus by a month with nothing failing. `_mojibake.mjs` carries the same lesson from a positional string
 * literal that put a repair off by four bytes; explicit pairs cannot shift.
 */
const MONTHS = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

/** `"1:56 pm on 8 May, 2023"` — the only shape the release uses for a session's own timestamp. */
const SESSION_TIMESTAMP = /^(\d{1,2}):(\d{2})\s+(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})$/i;

/** `"8 May, 2023"` — the date on an `event_summary` block, which carries no time. */
const EVENT_DATE = /^(\d{1,2})\s+([A-Za-z]+),\s*(\d{4})$/;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** The month number, refusing an unknown name rather than letting `undefined` become `NaN` downstream. */
function monthNumber(name, where) {
  const n = MONTHS[name];
  if (n === undefined) refuse(`${where}: "${name}" is not a month name this release uses`);
  return n;
}

/**
 * Proof that a Y/M/D triple is a real calendar date, and the ISO text for it.
 *
 * `Date.UTC` accepts 31 February and silently rolls it into March — a coercion that would put a memory in the
 * wrong month with nothing to notice it. Round-tripping the components back out is what turns that into a
 * refusal. The ISO string is then formatted from the validated components rather than from `toISOString()`,
 * which appends a `.000` millisecond field the corpus does not have.
 */
function isoAt(year, month, day, hour, minute, where) {
  const back = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    refuse(`${where}: ${year}-${pad2(month)}-${pad2(day)} is not a real date`);
  }
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:00Z`;
}

/**
 * A session's `"H:MM am|pm on D Month, YYYY"` as an ISO instant in UTC.
 *
 * The 12-hour conversion is written as the two exceptions plus the rule because that is where clock parsing goes
 * wrong: `12:09 am` is 00:09 and `12:30 pm` is 12:30, and a bare `+12 when pm` gets the first one right by
 * accident and the second one wrong. The release happens to contain `am` cases at 12 and no `pm` ones today,
 * which is precisely why the untested half has to be correct by construction rather than by observation.
 */
function parseSessionTimestamp(text, where) {
  if (typeof text !== 'string') refuse(`${where}: the session timestamp is ${typeof text}, not a string`);
  const m = SESSION_TIMESTAMP.exec(text.trim());
  if (!m) refuse(`${where}: cannot read a timestamp from ${JSON.stringify(text)}`);

  const [, hourText, minuteText, meridiemText, dayText, monthName, yearText] = m;
  const hour12 = Number(hourText);
  if (hour12 < 1 || hour12 > 12) refuse(`${where}: ${hour12} is not an hour on a 12-hour clock`);
  const minute = Number(minuteText);
  if (minute > 59) refuse(`${where}: ${minute} is not a minute`);

  const meridiem = meridiemText.toLowerCase();
  let hour = hour12;
  if (meridiem === 'am' && hour12 === 12) hour = 0;
  else if (meridiem === 'pm' && hour12 !== 12) hour = hour12 + 12;

  return isoAt(Number(yearText), monthNumber(monthName, where), Number(dayText), hour, minute, where);
}

/** An `event_summary` block's `"D Month, YYYY"` as a calendar date. No time is claimed because none is given. */
function parseEventDate(text, where) {
  if (typeof text !== 'string') refuse(`${where}: the event date is ${typeof text}, not a string`);
  const m = EVENT_DATE.exec(text.trim());
  if (!m) refuse(`${where}: cannot read a date from ${JSON.stringify(text)}`);
  const [, dayText, monthName, yearText] = m;
  const year = Number(yearText);
  const month = monthNumber(monthName, where);
  isoAt(year, month, Number(dayText), 0, 0, where);
  return `${year}-${pad2(month)}-${pad2(Number(dayText))}`;
}

/*
 * ---------------------------------------------------------------------------------------------------------
 * Turn references
 * ---------------------------------------------------------------------------------------------------------
 */

/** A well-formed reference: `D<session>:<turn>`, both 1-based and unpadded. Every real `dia_id` matches this. */
const CANONICAL_REFERENCE = /^D[1-9][0-9]*:[1-9][0-9]*$/;

/** One reference as the release may spell it: an optional stray colon after `D`, digits possibly zero-padded. */
const LOOSE_REFERENCE = /^D:?([0-9]+):([0-9]+)$/;

/** Ids run together inside one string are separated by a semicolon, a comma or whitespace — in any combination. */
const REFERENCE_SEPARATORS = /[;,\s]+/;

/** What a repair record can say went wrong. Each is a distinct defect, so a report can be counted by kind. */
const REPAIR_KINDS = {
  concatenated: 'several ids in one string',
  strayColon: 'a colon after D',
  leadingZero: 'a zero-padded number',
  unreadable: 'no id could be read from it',
  absentTurn: 'names a turn the conversation does not contain',
};

/**
 * Every turn id a reference string names, plus what had to be repaired to read them.
 *
 * Pure: it does not know which turns exist, so the same function serves the question set and the author-produced
 * observation layer, which carries five instances of the identical comma-concatenation defect. Writing the split
 * a second time over there is the failure `CLAUDE.md` names as the one this repo produces most — one rule, two
 * implementations, and the weaker one wins silently.
 *
 * Splitting on a separator class rather than on offsets is deliberate: `"D9:1 D4:4 D4:6"` and `"D8:6; D9:17"`
 * differ in both separator and arity, and any parse that reached for a character position would be right for one
 * of them and wrong for the other.
 */
function readReference(raw) {
  if (typeof raw !== 'string') return { ids: [], kinds: ['unreadable'] };
  if (CANONICAL_REFERENCE.test(raw)) return { ids: [raw], kinds: [] };

  const pieces = raw.trim().split(REFERENCE_SEPARATORS).filter(piece => piece.length > 0);
  const kinds = new Set();
  if (pieces.length > 1) kinds.add('concatenated');

  const ids = [];
  for (const piece of pieces) {
    const m = LOOSE_REFERENCE.exec(piece);
    if (!m) { kinds.add('unreadable'); continue; }

    const [, sessionText, turnText] = m;
    if (piece.startsWith('D:')) kinds.add('strayColon');
    if (/^0[0-9]/.test(sessionText) || /^0[0-9]/.test(turnText)) kinds.add('leadingZero');

    const session = Number(sessionText);
    const turn = Number(turnText);
    // A zero component is not a turn number this corpus uses; reading it as one would invent a reference.
    if (session < 1 || turn < 1) { kinds.add('unreadable'); continue; }
    ids.push(`D${session}:${turn}`);
  }

  if (ids.length === 0) kinds.add('unreadable');
  return { ids, kinds: [...kinds] };
}

/** One row of a repair report: the string as released, what it now means, and why it needed touching. */
function repairRecord({ conversationId, context, raw, resolved, absent, kinds }) {
  return {
    conversationId,
    context,
    raw,
    resolved,
    absent,
    kinds,
    note: kinds.map(kind => REPAIR_KINDS[kind]).join('; '),
  };
}

/**
 * Attach a repair report to a returned array.
 *
 * The contract says `loadQuestions` returns `Question[]`, and it does — the report rides along as a property so
 * the shape every other module was written against is unchanged. **`.filter()` and `.slice()` return a plain
 * array and drop it**, which matters because subsampling the question set is the first thing `run.mjs` does; the
 * standalone `evidenceRepairs(path)` exists so the report survives that. Enumerable on purpose: a report nobody
 * sees when they log the value is a report nobody reads.
 */
function withReport(array, repairs) {
  Object.defineProperty(array, 'repairs', { value: repairs, enumerable: true, writable: false });
  return array;
}

/*
 * ---------------------------------------------------------------------------------------------------------
 * The release file
 * ---------------------------------------------------------------------------------------------------------
 */

/**
 * The parsed release, checked far enough that a later failure names the data rather than a property access.
 *
 * Read fresh on every call rather than memoised by path. A cache would make the two loaders cheaper and would
 * also let a parse survive a re-downloaded file — the exact failure `pins.mjs` exists to prevent, traded for
 * about thirty milliseconds.
 */
function readRelease(path) {
  if (typeof path !== 'string' || path.length === 0) refuse('a path to the release file is required');

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`locomo: ${path} is not readable JSON: ${cause.message}`, { cause });
  }

  if (!Array.isArray(parsed)) refuse(`${path} parses to ${typeof parsed}, not the array of conversations expected`);
  parsed.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object') refuse(`${path} entry ${i} is not an object`);
    if (typeof entry.sample_id !== 'string' || entry.sample_id.length === 0) {
      refuse(`${path} entry ${i} has no sample_id, so nothing it contains can be attributed`);
    }
    if (entry.conversation === null || typeof entry.conversation !== 'object') {
      refuse(`${entry.sample_id}: no conversation block`);
    }
  });
  return parsed;
}

/** `session_7` — a block of turns. `session_7_date_time` does not match, which is what keeps the two apart. */
const SESSION_KEY = /^session_([1-9][0-9]*)$/;

/** The three author-produced layers, each keyed by its own spelling of the session number. */
const OBSERVATION_KEY = /^session_([1-9][0-9]*)_observation$/;
const EVENTS_KEY = /^events_session_([1-9][0-9]*)$/;
const SUMMARY_KEY = /^session_([1-9][0-9]*)_summary$/;

/**
 * The sessions of one conversation, in session order, with their turns.
 *
 * `index` is the number in the key, never the position in the walk. `dia_id` encodes the session it belongs to,
 * so a positional index would renumber every turn id the moment a release skipped a session — and the evidence
 * references would then point at the wrong turns while every id still looked well-formed. Each turn's own id is
 * checked against the session it was found in for the same reason.
 */
function readSessions(conversation, conversationId, speakers) {
  const indices = [];
  for (const key of Object.keys(conversation)) {
    const m = SESSION_KEY.exec(key);
    if (m) indices.push(Number(m[1]));
  }
  indices.sort((a, b) => a - b);

  const seenIds = new Set();
  return indices.map(index => {
    const where = `${conversationId} session ${index}`;
    const turns = conversation[`session_${index}`];
    if (!Array.isArray(turns)) refuse(`${where}: session_${index} is ${typeof turns}, not an array of turns`);

    const startsAt = parseSessionTimestamp(conversation[`session_${index}_date_time`], where);

    return {
      index,
      startsAt,
      turns: turns.map((turn, position) => readTurn(turn, index, position, where, speakers, seenIds)),
    };
  });
}

/** One turn, refusing anything that would silently become an empty or misattributed memory record. */
function readTurn(turn, sessionIndex, position, where, speakers, seenIds) {
  if (turn === null || typeof turn !== 'object') refuse(`${where}: turn ${position} is not an object`);

  const id = turn.dia_id;
  if (typeof id !== 'string' || !CANONICAL_REFERENCE.test(id)) {
    refuse(`${where}: turn ${position} has dia_id ${JSON.stringify(id)}, which is not a D<session>:<turn> id`);
  }
  if (!id.startsWith(`D${sessionIndex}:`)) {
    refuse(`${where}: turn ${id} is filed under session ${sessionIndex}, so its id and its session disagree`);
  }
  // A repeated id makes evidence resolution ambiguous, and the ambiguity would be resolved by whichever copy the
  // lookup happened to reach — a per-run difference that no score could be traced back to.
  if (seenIds.has(id)) refuse(`${where}: ${id} appears more than once in this conversation`);
  seenIds.add(id);

  const { speaker, text } = turn;
  if (typeof speaker !== 'string' || speaker.length === 0) refuse(`${where}: ${id} has no speaker`);
  if (!speakers.includes(speaker)) {
    refuse(`${where}: ${id} is spoken by "${speaker}", who is neither ${speakers[0]} nor ${speakers[1]}`);
  }
  if (typeof text !== 'string' || text.trim().length === 0) {
    refuse(`${where}: ${id} has no text, so there is nothing to store for it`);
  }

  const out = { id, sessionIndex, speaker, text };

  // Kept beside the text, never folded into it — see the header. 316 turns carry a caption with no url, so the
  // two are independent rather than one optional block.
  if (typeof turn.blip_caption === 'string' && turn.blip_caption.length > 0) out.imageCaption = turn.blip_caption;
  if (Array.isArray(turn.img_url) && turn.img_url.length > 0) out.imageUrl = turn.img_url[0];

  return out;
}

/** The two participants, taken from the conversation's own declaration rather than inferred from the turns. */
function readSpeakers(conversation, conversationId) {
  const { speaker_a: a, speaker_b: b } = conversation;
  if (typeof a !== 'string' || a.length === 0) refuse(`${conversationId}: speaker_a is missing`);
  if (typeof b !== 'string' || b.length === 0) refuse(`${conversationId}: speaker_b is missing`);
  if (a === b) refuse(`${conversationId}: both speakers are "${a}", so no turn can be attributed`);
  return [a, b];
}

/*
 * ---------------------------------------------------------------------------------------------------------
 * The exports
 * ---------------------------------------------------------------------------------------------------------
 */

/**
 * Every conversation, and nothing else.
 *
 * `Conversation = { id, speakers: [a, b], sessions: [{ index, startsAt, turns: [Turn] }] }`
 * `Turn = { id, sessionIndex, speaker, text, imageCaption?, imageUrl? }`
 *
 * This is the whole of what the ingest stage is given. There is no question data on these objects at any depth,
 * which is what makes the protocol's claim checkable rather than promised.
 */
export function loadConversations(path) {
  return readRelease(path).map(entry => {
    const id = entry.sample_id;
    const speakers = readSpeakers(entry.conversation, id);
    return { id, speakers, sessions: readSessions(entry.conversation, id, speakers) };
  });
}

/**
 * The turn ids and session numbers of one conversation, from the same walk that builds the conversation objects.
 *
 * Both callers need the ids, and the author-layer loader also needs to know which sessions exist. Deriving the
 * session number by cutting the id string apart would be a second, weaker parser of the same format sitting a
 * few lines from the real one; taking it off the session record cannot drift.
 */
function indexConversation(entry) {
  const speakers = readSpeakers(entry.conversation, entry.sample_id);
  const turnIds = new Set();
  const sessionIndices = new Set();
  for (const session of readSessions(entry.conversation, entry.sample_id, speakers)) {
    sessionIndices.add(session.index);
    for (const turn of session.turns) turnIds.add(turn.id);
  }
  return { turnIds, sessionIndices };
}

/**
 * Every question, with its evidence normalised and a report of what that took.
 *
 * `Question = { conversationId, question, answer?, evidence: [turnId], category, adversarialAnswer? }`
 *
 * Returns `Question[]` with a `repairs` property; see `withReport` for why that property does not survive a
 * `.filter()` and what to use instead.
 *
 * **`answer` is absent, not empty, on the 444 adversarial questions that have none.** Their correct behaviour is
 * abstention, so there is no gold string to score against; substituting `''` would hand `grade/lexical.mjs` an
 * answerable question with an empty gold and score a correct abstention as a miss. Two conv-26 questions carry
 * both an `answer` and an `adversarial_answer`, so neither field implies the other's absence.
 */
export function loadQuestions(path) {
  const out = [];
  const repairs = [];

  for (const entry of readRelease(path)) {
    const conversationId = entry.sample_id;
    const graded = entry.qa;
    if (!Array.isArray(graded)) refuse(`${conversationId}: qa is ${typeof graded}, not an array`);
    const { turnIds } = indexConversation(entry);

    graded.forEach((row, position) => {
      const where = `${conversationId} question ${position}`;
      if (row === null || typeof row !== 'object') refuse(`${where}: not an object`);
      if (typeof row.question !== 'string' || row.question.trim().length === 0) refuse(`${where}: no question`);
      if (!Number.isInteger(row.category)) {
        refuse(`${where}: category is ${JSON.stringify(row.category)}, not the integer the release uses`);
      }

      const question = {
        conversationId,
        question: row.question,
        evidence: resolveEvidence(row, conversationId, turnIds, repairs),
        category: row.category,
      };

      // Six answers in the release are numbers (a bare year, `2022`). Stringifying is lossless and is the only
      // coercion in this file; the alternative — refusing — would reject the pinned release over six rows.
      if (typeof row.answer === 'string') question.answer = row.answer;
      else if (typeof row.answer === 'number') question.answer = String(row.answer);
      else if (row.answer !== undefined) refuse(`${where}: answer is a ${typeof row.answer}`);

      if (typeof row.adversarial_answer === 'string') question.adversarialAnswer = row.adversarial_answer;
      else if (row.adversarial_answer !== undefined) {
        refuse(`${where}: adversarial_answer is a ${typeof row.adversarial_answer}`);
      }

      out.push(question);
    });
  }

  return withReport(out, repairs);
}

/** The evidence ids for one row, appending a repair record for every reference that was not already well formed. */
function resolveEvidence(row, conversationId, turnIds, repairs) {
  const raw = row.evidence;
  if (!Array.isArray(raw)) refuse(`${conversationId}: "${row.question}" has evidence that is not an array`);

  const evidence = [];
  for (const reference of raw) {
    const { ids, kinds } = readReference(reference);
    const resolved = ids.filter(id => turnIds.has(id));
    const absent = ids.filter(id => !turnIds.has(id));
    if (absent.length > 0) kinds.push('absentTurn');

    evidence.push(...resolved);
    if (kinds.length > 0) {
      repairs.push(repairRecord({
        conversationId, context: row.question, raw: reference, resolved, absent, kinds,
      }));
    }
  }
  return evidence;
}

/**
 * The evidence repair report on its own, for a caller that has already subsampled the question set.
 *
 * Re-reads the release rather than caching the previous result: the report and the questions are produced by one
 * pipeline, so the two can never describe different repairs, and a stale report is worse than a slow one.
 */
export function evidenceRepairs(path) {
  return loadQuestions(path).repairs;
}

/**
 * The author-produced layers — `observation`, `event_summary` and `session_summary`.
 *
 * **Named at length because reaching for these by accident is the thing to prevent.** They are not part of the
 * conversation: they are the dataset authors' own extractions, written by the same generative pipeline that
 * produced the questions, and ingesting them means measuring how well one extraction matches a question written
 * against another. The protocol treats them as a declared rung — a row of its own, compared against the rungs
 * that read only the turns, never folded into the default path and never mixed into `loadConversations`.
 *
 * `AuthorLayers = { conversationId, sessions: [{ index, summary?, eventDate?, events: [{ speaker, event }],
 *                   observations: [{ speaker, claim, turnIds: [turnId] }] }] }`
 *
 * Returns the array with a `repairs` property: the observation layer carries five instances of the same
 * comma-concatenated reference defect as the question set, and they are reported for the same reason.
 */
export function loadAuthorProducedLayers(path) {
  const out = [];
  const repairs = [];

  for (const entry of readRelease(path)) {
    const conversationId = entry.sample_id;
    const { turnIds, sessionIndices } = indexConversation(entry);

    const observation = layerBlock(entry.observation, `${conversationId} observation`);
    const events = layerBlock(entry.event_summary, `${conversationId} event_summary`);
    const summaries = layerBlock(entry.session_summary, `${conversationId} session_summary`);

    const indices = new Set([
      ...layerIndices(observation, OBSERVATION_KEY),
      ...layerIndices(events, EVENTS_KEY),
      ...layerIndices(summaries, SUMMARY_KEY),
    ]);

    const sessions = [...indices].sort((a, b) => a - b).map(index => {
      // A layer about a session with no turns would inject content whose source cannot be cited. Today there are
      // none; refusing keeps it that way rather than letting an unciteable claim into a space unannounced.
      if (!sessionIndices.has(index)) {
        refuse(`${conversationId}: an author layer describes session ${index}, which has no turns`);
      }
      const summary = readSummary(summaries[`session_${index}_summary`], `${conversationId} summary ${index}`);
      return {
        index,
        ...(summary === undefined ? {} : { summary }),
        ...readEvents(events[`events_session_${index}`], `${conversationId} events ${index}`),
        observations: readObservations(
          observation[`session_${index}_observation`], conversationId, index, turnIds, repairs,
        ),
      };
    });

    out.push({ conversationId, sessions });
  }

  return withReport(out, repairs);
}

/** A layer block, defaulting to empty only when the layer is absent outright — never when it is the wrong type. */
function layerBlock(value, where) {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`${where}: expected an object keyed by session, got ${Array.isArray(value) ? 'an array' : typeof value}`);
  }
  return value;
}

/** The session numbers a layer block names, read from its own key spelling. */
function layerIndices(block, keyPattern) {
  const indices = [];
  for (const key of Object.keys(block)) {
    const m = keyPattern.exec(key);
    if (m) indices.push(Number(m[1]));
  }
  return indices;
}

function readSummary(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) refuse(`${where}: not a non-empty string`);
  return value;
}

/**
 * A session's events, flattened to `{ speaker, event }` pairs with the block's own date beside them.
 *
 * The release nests events under each speaker's name and puts a `date` key in the same object. Flattening keeps
 * the attribution — an event is something one participant did — while getting the date out of a position where a
 * speaker happened to be called `date` would collide with it.
 */
function readEvents(block, where) {
  if (block === undefined) return { events: [] };
  if (block === null || typeof block !== 'object' || Array.isArray(block)) refuse(`${where}: not an object`);

  const events = [];
  let eventDate;
  for (const [key, value] of Object.entries(block)) {
    if (key === 'date') { eventDate = parseEventDate(value, where); continue; }
    if (!Array.isArray(value)) refuse(`${where}: events for "${key}" are ${typeof value}, not an array`);
    for (const event of value) {
      if (typeof event !== 'string') refuse(`${where}: an event for "${key}" is a ${typeof event}, not a string`);
      // conv-41 `events_session_19` carries one empty string among Maria's events, and it is the only one in the
      // release. Refusing over it would reject the pinned dataset outright; an empty event has no content to
      // lose, so it is dropped — named here rather than left as an unexplained arity difference in the output.
      if (event.trim().length === 0) continue;
      events.push({ speaker: key, event });
    }
  }
  return eventDate === undefined ? { events } : { eventDate, events };
}

/**
 * A session's observations: `[claim, reference]` pairs, where the reference is one id, several ids in an array,
 * or — five times in the release — several ids concatenated into one string.
 *
 * Run through the same `readReference` as the question set's evidence, so the corpus has exactly one definition
 * of what a turn reference is.
 */
function readObservations(block, conversationId, index, turnIds, repairs) {
  if (block === undefined) return [];
  const where = `${conversationId} observation ${index}`;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) refuse(`${where}: not an object`);

  const observations = [];
  for (const [speaker, rows] of Object.entries(block)) {
    if (!Array.isArray(rows)) refuse(`${where}: observations for "${speaker}" are ${typeof rows}, not an array`);
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2) refuse(`${where}: an observation for "${speaker}" is not a pair`);
      const [claim, reference] = row;
      if (typeof claim !== 'string' || claim.trim().length === 0) refuse(`${where}: an observation has no claim`);

      const references = Array.isArray(reference) ? reference : [reference];
      const resolvedIds = [];
      for (const one of references) {
        const { ids, kinds } = readReference(one);
        const resolved = ids.filter(id => turnIds.has(id));
        const absent = ids.filter(id => !turnIds.has(id));
        if (absent.length > 0) kinds.push('absentTurn');
        resolvedIds.push(...resolved);
        if (kinds.length > 0) {
          repairs.push(repairRecord({ conversationId, context: claim, raw: one, resolved, absent, kinds }));
        }
      }
      observations.push({ speaker, claim, turnIds: resolvedIds });
    }
  }
  return observations;
}
