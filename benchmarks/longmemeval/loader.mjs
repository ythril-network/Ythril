/**
 * LongMemEval, parsed into the same neutral shape the harness already reads LoCoMo in.
 *
 * ## The answer key is INSIDE the history, which LoCoMo's never was
 *
 * A LoCoMo release keeps its questions in a block beside the conversation, so a loader that returns the
 * conversation returns nothing about them. A LongMemEval instance is one object carrying the history AND
 * `question`, `answer`, `question_type` and `answer_session_ids` — and, measured across the corpus, **896
 * individual turns inside the haystack carry `has_answer: true`.**
 *
 * That last one is the dangerous one. The others are at the top of the object and any reader notices them;
 * `has_answer` is a third key on a turn that otherwise holds `role` and `content`, so a loader that passed
 * sessions through verbatim would hand the extraction model a flag saying *this turn is the evidence* —
 * on the very turns a score is computed from. Nothing downstream could see it, and the extraction would
 * quietly get better at this corpus and nothing else.
 *
 * ## So a turn is BUILT, never copied
 *
 * `readTurn` assembles a new object from named fields. Deleting the keys we know about would be the same
 * code today and a leak the day the authors add a fourth — and an unknown key is REFUSED rather than
 * dropped, so a release that changes shape stops the run instead of silently changing what the model sees.
 *
 * ## Ids are minted, because the corpus has none
 *
 * A turn carries no identifier. `sourceTurns` in the extraction format is how a claim is traced back to the
 * transcript, so the ids have to exist and have to be stable: `D<session>:<turn>`, one-based, exactly the
 * spelling LoCoMo uses, so nothing downstream needs to know which corpus a run came from.
 *
 * ## The timestamps carry no zone, so this file declares one
 *
 * A session date reads `2023/05/20 (Sat) 02:21`. There is no zone, and reading it as local time would make
 * the parse machine-dependent: the same run in Berlin and in CI would write chrono records hours apart and
 * the diff would look like a retrieval change. UTC by declaration, for the reason LoCoMo's loader gives at
 * more length — the relative ordering is the only thing the corpus asserts and it is identical either way.
 *
 * The weekday in the string is NOT checked against the date. It is the publisher's, it is redundant, and a
 * loader that refused a history over a disagreeing weekday would reject data whose turns are all fine.
 */
import { readFileSync } from 'node:fs';

/** The keys a turn may carry. Anything else stops the run — see the header. */
const TURN_KEYS = new Set(['role', 'content', 'has_answer']);

/** `2023/05/20 (Sat) 02:21` */
const SESSION_DATE = /^(\d{4})\/(\d{2})\/(\d{2})\s+\([A-Za-z]{3}\)\s+(\d{2}):(\d{2})$/;

function refuse(what) {
  throw new Error(`longmemeval: ${what}`);
}

/**
 * The instance's own id, under a name that is not a question word.
 *
 * The release calls it `question_id`. It identifies the INSTANCE — one history plus one question — and the
 * history half needs it to join an extraction back to a run. Renaming is not cosmetic: the gate that keeps
 * the extractor blind scans every key of everything a loader returns for question vocabulary, and a field
 * spelled `question_id` would trip it. A rename that made the gate pass while leaking would be worse than
 * either, so nothing but the id travels.
 */
function readId(entry, position) {
  const id = entry.question_id;
  if (typeof id !== 'string' || id.length === 0) refuse(`instance ${position} has no question_id to identify it by`);
  return id;
}

function readSessionDate(raw, where) {
  if (typeof raw !== 'string') refuse(`${where}: session date is ${typeof raw}, not a string`);
  const m = SESSION_DATE.exec(raw.trim());
  if (!m) refuse(`${where}: session date ${JSON.stringify(raw)} is not \`YYYY/MM/DD (Day) HH:MM\``);
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:00Z`;
}

/**
 * Attach a repair report to the array it describes, the way LoCoMo's loader does.
 *
 * A loader that quietly rewrites its input is a loader whose numbers cannot be traced back to the data
 * anybody pinned. The property does not survive a `.filter()`, which is a property of arrays rather than a
 * decision here — read it off what this returns.
 */
function withReport(array, repairs) {
  Object.defineProperty(array, 'repairs', { value: repairs, enumerable: false, writable: false });
  return array;
}

/**
 * One turn, built from named fields so nothing the release adds later can ride along.
 *
 * Returns `null` for a turn with no content, which the caller drops and REPORTS. Twelve turns of 246,930
 * are empty in the pinned release, across seven histories, nine of the user's and three of the assistant's,
 * and **none of them is evidence** — so dropping loses nothing a question could be asked about. Refusing
 * instead would make seven histories unreadable over twelve blank strings; rewriting in silence would make
 * every count this repository publishes untraceable to the file it came from.
 */
function readTurn(turn, sessionIndex, position, where, repairs) {
  if (turn === null || typeof turn !== 'object' || Array.isArray(turn)) {
    refuse(`${where}: turn ${position} is not an object`);
  }
  for (const key of Object.keys(turn)) {
    if (!TURN_KEYS.has(key)) {
      refuse(`${where}: turn ${position} carries an unknown key '${key}'. The release has changed shape — `
        + 'decide whether it is content or answer-key data before letting it through, because a new field '
        + 'on a turn is invisible to everything downstream.');
    }
  }
  const { role, content } = turn;
  if (role !== 'user' && role !== 'assistant') {
    refuse(`${where}: turn ${position} has role ${JSON.stringify(role)}, which is neither user nor assistant`);
  }
  /*
   * THE ID IS MINTED FROM THE PUBLISHED POSITION, not from the position in what survives.
   *
   * Numbering the kept turns would renumber every turn after a dropped one, so `D13:9` would name a
   * different remark than it did before the drop — and `sourceTurns` in a committed extraction would point
   * at the wrong line with nothing to reveal it. A gap in the ids is the honest shape: it says a turn was
   * there and is not.
   */
  const id = `D${sessionIndex}:${position + 1}`;
  if (typeof content !== 'string' || content.trim().length === 0) {
    repairs.push({ turn: id, where, what: 'dropped: the release carries no content for this turn' });
    return null;
  }
  // `has_answer` is destructured nowhere and named only here: saying so is what records that we know it
  // exists, know what it is, and are refusing to pass it on.
  return { id, sessionIndex, speaker: role, text: content };
}

/**
 * Every history in the release, carrying no question data of any kind.
 *
 * `History = { id, sessions: [{ index, id, startsAt, turns: [{ id, sessionIndex, speaker, text }] }] }`
 *
 * The three parallel arrays the release uses — `haystack_sessions`, `haystack_dates`, `haystack_session_ids`
 * — are zipped here and their lengths are checked against each other. A short `haystack_dates` would
 * otherwise give the last sessions an undefined date, which resolves to a chrono record nobody can order.
 */
export function loadHistories(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (entries.length === 0) refuse('the release parsed to no instances at all');

  const repairs = [];
  const histories = entries.map((entry, position) => {
    const id = readId(entry, position);
    const sessions = entry.haystack_sessions;
    const dates = entry.haystack_dates;
    const ids = entry.haystack_session_ids;
    if (!Array.isArray(sessions)) refuse(`${id}: haystack_sessions is not an array`);
    if (!Array.isArray(dates) || dates.length !== sessions.length) {
      refuse(`${id}: ${sessions.length} sessions and ${Array.isArray(dates) ? dates.length : 'no'} dates. `
        + 'A session with no date produces a chrono record nothing can order.');
    }
    if (!Array.isArray(ids) || ids.length !== sessions.length) {
      refuse(`${id}: ${sessions.length} sessions and ${Array.isArray(ids) ? ids.length : 'no'} session ids`);
    }
    return {
      id,
      sessions: sessions.map((turns, i) => {
        const index = i + 1;
        const where = `${id} session ${index}`;
        if (!Array.isArray(turns)) refuse(`${where}: it is ${typeof turns}, not an array of turns`);
        return {
          index,
          id: String(ids[i]),
          startsAt: readSessionDate(dates[i], where),
          turns: turns.map((t, position) => readTurn(t, index, position, where, repairs)).filter(Boolean),
        };
      }),
    };
  });
  return withReport(histories, repairs);
}

/**
 * What reading the release took, without the histories.
 *
 * A separate door because the report is what a results file should carry, and a caller that wanted only the
 * repairs should not have to hold 500 histories in memory to get at them.
 */
export function historyRepairs(path) {
  return loadHistories(path).repairs;
}

/**
 * Where the pinned release sits, read from the pin rather than spelled here.
 *
 * The cache path contains the hash, so a literal would be a second copy of the thing the pin exists to
 * assert — and it would go on resolving to the old file after a re-pin, which is the one failure that looks
 * exactly like everything working.
 */
export function pinnedPath(pinJson, repoRoot) {
  const cachePath = pinJson?.datasets?.longmemeval_s?.cachePath;
  if (typeof cachePath !== 'string') refuse('the pin declares no cachePath for longmemeval_s');
  return `${repoRoot}/${cachePath}`;
}
