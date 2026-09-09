/**
 * Rung S0CD — the windows of S0W with the harness's bookkeeping out of the vector and the DATE left in.
 *
 * ## The cell that was missing, and why nobody noticed it was missing
 *
 * **Properties are embedded.** `memoryEmbedText` appends every property to the string that gets vectorised,
 * as `key value`. That is not what two rungs in this folder assume, and the assumption cost both of them.
 *
 * So an `S0W` record does not embed the dialogue. It embeds the dialogue followed by:
 *
 * ```text
 * session 1 turn D1:3,D1:4,D1:5,D1:6,D1:7 speaker Deborah,Jolene statedOn 2023-01-23 turns 5
 * ```
 *
 * Two things are wrong with that string and they pull in opposite directions, which is exactly why the two
 * existing rungs each got half of it:
 *
 * | rung | dialogue | date in the vector | turn ids in the vector | rank 1 |
 * |---|---|---|---|---|
 * | `s0w` | yes | yes | **yes** | 50.8% |
 * | `s0c` clean windows | yes | **no** | no | 50.3% |
 * | `s0wd` dated | yes | yes, twice | yes | 50.8% |
 * | **this rung** | yes | yes | no | — |
 *
 * `S0C` set out to take the bookkeeping out of the vector and took the date out with it, because it stopped
 * writing properties altogether. Two variables moved at once and the result is uninterpretable. `S0WD` set
 * out to put the date INTO the vector on the written premise that *"a property is not embedded, so the
 * record contains no trace of June, of 2023"* — which is false, so it added a second copy of a date that was
 * already there, and correctly measured nothing.
 *
 * This rung moves one variable from `S0W`: the turn ids leave the vector, the date stays.
 *
 * ## Why the turn ids are the expensive half
 *
 * `turn D1:3,D1:4,D1:5,D1:6,D1:7` is roughly thirty tokens that mean nothing to any reader, and it is unique
 * per record — the highest-entropy noise the corpus could carry. It exists only so the SCORER can join a
 * result back to the answer key, which makes it the benchmark harness contaminating the thing it measures.
 *
 * That dilution is not a theory here. It was measured in this codebase, on this dataset: memories used to
 * embed the NAMES of the entities they linked to, and removing them was worth **1.5 points** of strict
 * evidence recall — the same turn scored 0.8528 without them and 0.8369 with them.
 *
 * ## Why the date must NOT leave with them
 *
 * Sixteen percent of the questions are temporal, and their gold answers are things like *in 2022* and *the
 * weekend before October 24, 2023*. Those are derivable only from the session date — the turn itself says
 * *"last year"* and *"last weekend"*. A corpus with the dialogue and no date cannot answer them at all, so
 * dropping the date is not a neutral simplification, and `S0C` dropped it.
 *
 * `speaker` also stays. It is already in the fact text as the line prefix, so it costs a repetition rather
 * than a new token, and removing it would be a second variable.
 *
 * ## What leaves, and where it goes instead
 *
 * `turn`, `session` and `turns` are all harness bookkeeping. They are reported to the runner as `covers`,
 * stripped before the write, and kept in a map the runner joins on afterwards by record id — the mechanism
 * `S0C` established. Never stored, never embedded.
 */
import { WINDOW_SIZE, WINDOW_STEP } from './s0w-windowed-turns.mjs';

export const rung = 's0cd';
export const recallTypes = ['memory'];
export const needsModel = false;

/** Which turns a record covers is joined by record id, so it never reaches the corpus. */
export const coversOutOfBand = true;

/**
 * What this corpus may contain, declared so the instance enforces it.
 *
 * A space defaults to `validationMode: 'strict'` and a declared collection's keys are an ALLOWLIST, so an
 * undeclared type is a 400 and a missing `required` property is a 400. Without a declaration strict mode
 * validates NOTHING — there is no rule for an undeclared type, so nothing can be violated.
 *
 * A benchmark needs that more than an application does: an application with a broken corpus throws, and a
 * benchmark reports a NUMBER that reads as a finding about retrieval.
 *
 * `turn` is deliberately absent, and this is the rung where its absence is the point rather than an
 * oversight — declaring it would let a record carry one.
 */
export const typeSchemas = {
  memory: {
    utterance: {
      propertySchemas: {
        speaker: { type: 'string', required: true },
        statedOn: { type: 'date', required: true },
      },
    },
  },
};

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

    for (let i = 0; i < turns.length; i += WINDOW_STEP) {
      const window = turns.slice(i, i + WINDOW_SIZE);
      if (window.length === 0) break;

      await ythril.writeMemory(space, {
        // Byte-identical to what `S0W` writes, so the only difference between the two rungs is what the
        // properties add after it.
        fact: window.map(t => `${t.speaker}: ${t.text}`).join('\n'),
        type: 'utterance',
        properties: {
          speaker: [...new Set(window.map(t => t.speaker))].join(','),
          statedOn: day,
        },
        // Stripped before the POST and recorded against the created id. Never stored, never embedded.
        covers: window.map(t => t.id),
      });
      records++;

      // A short last window rather than none: stopping when a full one no longer fits drops the tail of
      // every session, and the end of a conversation is where its conclusions are.
      if (i + WINDOW_SIZE >= turns.length) break;
    }
  }

  return { records, modelCalls: 0 };
}
