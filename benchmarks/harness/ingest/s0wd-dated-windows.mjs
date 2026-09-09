/**
 * Rung S0WD — the windows of S0W, with WHEN they were said written a SECOND time, into the fact.
 *
 * ## CORRECTED 2026-09-09: the hole this was built to close was never open
 *
 * This rung was written on the premise below, and the premise is false:
 *
 * > Every rung so far embeds `speaker: text` and files the date under `properties.statedOn`. A property is
 * > not embedded. So the record for a turn said on 27 June 2023 contains no trace of June, of 2023 [...]
 *
 * **`memoryEmbedText` appends every property to the embedded string as `key value`.** So an `S0W` record
 * already carries `statedOn 2023-01-23` in its vector, and always did. What this rung adds is a second copy
 * of a date that was in there the whole time.
 *
 * That is exactly what it measured, and the measurement now has a reason rather than a shrug: nothing moved.
 * The finding is kept here in full because a rung whose stated purpose is wrong is worse than a rung that
 * lost — somebody re-reads the premise, believes it, and builds the same thing again.
 *
 * **What was really wrong with the vector is the other half of that string**, and no rung tested it until
 * `s0cd`: `turn D1:3,D1:4,D1:5,D1:6,D1:7` is about thirty tokens of unique identifier, present in every
 * record, and it exists only so the scorer can join a result back to the answer key. `S0C` removed it and
 * removed the date along with it, so the two variables moved together. See `s0cd-clean-dated-windows.mjs`.
 *
 * ## Why this is a rank improvement rather than a coverage one
 *
 * It returns no more records, covers no more turns, and spends no more bytes worth mentioning — one short
 * line per window. What changes is WHICH record comes back first for a question about time. That is the
 * distinction the owner drew on 2026-09-06: *"first answer must be right - it must reflect reality, not brute
 * force."* Adding the date does not make the net wider, it makes the top of the list correct more often.
 *
 * ## And it is not fitting to the benchmark
 *
 * The test for that is whether the change would be right if the benchmark did not exist. A stored memory of
 * something somebody said, with no indication of when they said it, is an incomplete record by any standard —
 * the date is part of the fact, not metadata about it. Every chat log, every message archive and every
 * transcript ever written puts the date on the page. The corpus was wrong before this and would be wrong
 * without a benchmark to notice.
 *
 * The line stays deterministic, model-free, and question-blind, exactly as `S0W` is. It is built from
 * `session.startsAt`, which the source provides.
 *
 * ## MEASURED: the premise was right and the change did not pay
 *
 * Full run, 199 questions, equal 25 000-character budget, against `S0W` which differs by this one line
 * (2026-09-06):
 *
 * | | all at rank 1 | all within 3 | temporal at rank 1 | temporal within 3 |
 * |---|---|---|---|---|
 * | `s0w` undated | 50.8% | **69.3%** | 46.9% | 75.0% |
 * | `s0wd` this rung | 50.8% | 66.3% | **53.1%** | **81.3%** |
 *
 * **Nothing moved overall.** The temporal category gained two questions of thirty-two, and the whole set lost
 * six from `within 3`. Two of thirty-two is six percentage points on a category that small, which is inside
 * the noise this harness has already been shown to carry — so the honest reading is that the date line helped
 * time questions slightly, cost everything else slightly, and netted zero.
 *
 * **Why it is kept rather than deleted.** The premise it was built on is a real defect and remains true: a
 * stored memory says who spoke and not when, because the date lives in a property and a property is never
 * embedded. Confirming that closing the gap does NOT move the score is worth more than the guess it replaces,
 * and it is the kind of result that gets quietly dropped because it is not a win. The rung is one line of
 * text away from `S0W`, so it also stands as the control for any future claim that the corpus needs more
 * context in it.
 *
 * **What it does NOT license.** It says nothing about a bigger date treatment — relative phrasing (*"three
 * weeks after"*), a session index a query could match, or a date on every turn rather than every window. Each
 * of those is its own rung and its own run.
 */
export const rung = 's0wd';
export const recallTypes = ['memory'];
export const needsModel = false;

/**
 * What this corpus may contain, declared to the instance rather than trusted to the ingest.
 *
 * A space defaults to `validationMode: 'strict'`, and the keys of each collection are an ALLOWLIST — so an
 * undeclared type is refused, and a `required` property that is missing is refused. Without a declaration
 * strict mode validates NOTHING: there is no rule for an undeclared type, so there is nothing to violate.
 *
 * **A benchmark needs this more than an application does.** An application with a broken corpus throws. A
 * benchmark reports a number, and a corpus missing a field scores low and reads as a finding about
 * retrieval — the most expensive kind of wrong available here, and it has happened twice in one afternoon.
 * `turn` is the sharpest example: it is how a result is joined back to the answer key, so a rung that stops
 * writing it does not score badly, it scores ZERO.
 */
export const typeSchemas = {
  memory: {
    utterance: {
      propertySchemas: {
        session: { type: 'number', required: true, minimum: 1 },
        /*
         * NO GROUPS IN THIS PATTERN, and that is not style. The natural form —
         * `^D[0-9]+:[0-9]+(,D[0-9]+:[0-9]+)*$` — is refused by the instance as a ReDoS risk, and a refused
         * pattern surfaces as `does not match pattern` against the VALUE. So every correct record is
         * rejected, permanently, with an error naming the data. Filed as `F-25`. This form has no
         * parentheses and so cannot trip the heuristic; it is looser, and a rule that runs and is
         * approximate beats a rule that is exact and silently refuses everything.
         */
        turn: { type: 'string', required: true, pattern: '^D[0-9]+:[0-9,:D]*$' },
        speaker: { type: 'string', required: true },
        statedOn: { type: 'date', required: true },
        turns: { type: 'number', required: true, minimum: 1 },
      },
    },
  },
};

/**
 * Same defaults as `S0W`, and read from the SAME environment variables on purpose.
 *
 * The two rungs have to be comparable, and a sweep that changed the window shape for one but not the other
 * would report the date's effect mixed with a shape difference. One axis at a time is the protocol's rule.
 */
export const WINDOW_SIZE = Number(process.env['BENCH_WINDOW_SIZE'] ?? 5);
export const WINDOW_STEP = Number(process.env['BENCH_WINDOW_STEP'] ?? 2);

/** Weekday and month in full, because that is how a question about time is usually worded. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/**
 * The one line prepended to a window's text.
 *
 * Written out in words as well as digits — *"Tuesday, 27 June 2023"* — because a question asks *"what did
 * they do in June"* far more often than it asks about `2023-06-27`, and an embedding of the numeric form
 * carries little of the month. Both spellings cost about ten words.
 *
 * `UTC` throughout: the source's timestamps carry no zone, and reading them in the runner's local time would
 * make the corpus depend on where the benchmark was run. A date that shifts by a machine is worse than a
 * date that is arguably off by hours in one direction for everybody.
 */
function dateLine(startsAt, sessionIndex) {
  const at = new Date(startsAt);
  if (Number.isNaN(at.getTime())) return `Conversation ${sessionIndex}.`;
  const day = DAY_NAMES[at.getUTCDay()];
  const month = MONTH_NAMES[at.getUTCMonth()];
  return `On ${day}, ${at.getUTCDate()} ${month} ${at.getUTCFullYear()} `
    + `(${startsAt.slice(0, 10)}), in conversation ${sessionIndex}:`;
}

/**
 * @param {object} args
 * @param {object} args.conversation  no question data on it
 * @param {object} args.ythril
 * @param {string} args.space
 * @returns {Promise<{records: number, modelCalls: number}>}
 */
export async function ingest({ conversation, ythril, space }) {
  let records = 0;

  for (const session of conversation.sessions) {
    const turns = session.turns;
    const day = session.startsAt.slice(0, 10);
    const when = dateLine(session.startsAt, session.index);

    for (let i = 0; i < turns.length; i += WINDOW_STEP) {
      const window = turns.slice(i, i + WINDOW_SIZE);
      if (window.length === 0) break;

      // The date leads, then the turns exactly as S0W writes them. Identical below the first line, so the
      // difference between the two rungs is one line of text and nothing else.
      const fact = `${when}\n` + window.map(t => `${t.speaker}: ${t.text}`).join('\n');

      await ythril.writeMemory(space, {
        fact,
        type: 'utterance',
        properties: {
          session: session.index,
          turn: window.map(t => t.id).join(','),
          speaker: [...new Set(window.map(t => t.speaker))].join(','),
          statedOn: day,
          turns: window.length,
        },
      });
      records++;

      if (i + WINDOW_SIZE >= turns.length) break;
    }
  }

  return { records, modelCalls: 0 };
}
