/**
 * The two arms of a run, derived from ONE configuration so they cannot differ in anything but the memory.
 *
 * ## The column this exists for
 *
 * `B-2`, on what a benchmark should publish: *"the number to publish is not the accuracy, it is the
 * accuracy minus what the same answerer scores with the whole history in its context. Same questions, same
 * judge, same seeds, memory off. Without that column a figure in the eighties says nothing about whether
 * the memory did anything, and it is the column every self-reported figure omits."*
 *
 * The evidence for taking it seriously is in that row: Bench'd, running these systems themselves rather
 * than accepting their numbers, puts the plain-context baseline at 50.4% on LoCoMo — with LlamaIndex at
 * 54.8% and LangChain at 51.9%, which is **three points of memory**. Mem0 self-reports 93.4% on
 * LongMemEval and scores 32.4% when somebody else runs its open build.
 *
 * ## Why one config produces both, instead of a caller configuring each
 *
 * A subtraction is only meaningful if the two arms differ in exactly one thing. Two arms configured
 * separately drift in a way nothing reports: a different `topK`, a different seed, a judge swapped in one
 * and not the other — and the difference between the numbers stops being the memory and starts being the
 * configuration, while still looking like a result.
 *
 * So there is no way to ask this module for one arm. `armsFor` returns both or refuses, every shared field
 * is copied from one source, and `MEMORY_ONLY` is the entire list of what is allowed to differ. A reader
 * checking whether the comparison is fair reads that list rather than diffing two objects.
 *
 * ## What it does NOT do
 *
 * Call a model. The answerer and the judge are parked on two provider keys — see `_PARKED-DECISIONS.md` —
 * and this is the part that decides what they would be ASKED, which needs none.
 */

/**
 * Everything the two arms are allowed to differ in. Nothing else may.
 *
 * `context` is the whole point: one arm gets what retrieval returned, the other gets the entire history.
 * `memory` names which is which, so a report never has to infer it from the size of the context.
 */
export const MEMORY_ONLY = ['memory', 'context'];

/**
 * The whole history as an answerer would be handed it, oldest session first.
 *
 * Built from the loader's shape rather than from a transcript file, so the baseline reads exactly what the
 * extraction read — a baseline fed a different rendering of the same conversation is measuring the
 * rendering. Sessions arrive in time order from the loader; this does not re-sort them, because a second
 * sort is a second opinion about which order is right.
 */
export function wholeHistory(conversation) {
  const sessions = conversation?.sessions ?? [];
  if (sessions.length === 0) {
    throw new Error('the no-memory arm was handed a conversation with no sessions, which would score zero '
      + 'for the baseline and make the memory look better by exactly that much');
  }
  return sessions.map(s => {
    const head = `# session ${s.index} — ${String(s.startsAt ?? '').slice(0, 10)}`;
    // The image caption in the same form `bench.mjs dump` gives the extractor: a baseline that sees less of
    // the conversation than the memory was built from inflates the delta by exactly the difference.
    return [head, ...s.turns.map(t => `${t.speaker}: ${t.text}${t.imageCaption ? ` [image: ${t.imageCaption}]` : ''}`)].join('\n');
  }).join('\n\n');
}

/**
 * Both arms for one question, from one configuration.
 *
 * @param {object} args
 * @param {object} args.conversation the loader's conversation, for the baseline's context
 * @param {string} args.question     the question text, identical in both arms
 * @param {object[]} args.hits       what retrieval returned for the memory arm
 * @param {object} args.config       answerer, judge, seed — shared, never per-arm
 * @returns {{memory: object, baseline: object}}
 */
export function armsFor({ conversation, question, hits, config = {} }) {
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('armsFor needs the question text: the two arms must be asked the same thing');
  }
  if (!Array.isArray(hits)) {
    throw new Error('armsFor needs the retrieval hits, even when empty. An absent array and an empty one '
      + 'are different: one is a question retrieval failed on, the other is one it found nothing for.');
  }
  /*
   * SHARED, and built once. Spreading this into both arms is what makes "same questions, same judge, same
   * seeds" structural instead of a promise in a docblock — a field added here reaches both arms, and a
   * field added to one arm by hand is the drift this module exists to prevent.
   */
  const shared = {
    question,
    answererModel: config.answererModel ?? null,
    judgeModel: config.judgeModel ?? null,
    seed: config.seed ?? null,
  };
  return {
    memory: { ...shared, memory: 'on', context: hits },
    baseline: { ...shared, memory: 'off', context: wholeHistory(conversation) },
  };
}

/**
 * Do these two arms differ in anything they are not allowed to?
 *
 * Returns the offending field names. Exported because the report calls it on every pair rather than
 * trusting that they were built here: a run assembled by a future caller that builds arms itself would
 * otherwise publish a subtraction between two different configurations, and the number would look fine.
 */
export function armsDisagreeOn(memory, baseline) {
  const keys = [...new Set([...Object.keys(memory), ...Object.keys(baseline)])];
  return keys.filter(k => !MEMORY_ONLY.includes(k) && memory[k] !== baseline[k]);
}

/**
 * The published figure: what the memory was worth, and both numbers it came from.
 *
 * The DELTA is the headline and the two accuracies travel with it, because a delta alone cannot be checked
 * and an accuracy alone is the figure `B-2` says means nothing. Percentage points, not a ratio: "three
 * points of memory" is the sentence a reader can compare against somebody else's table.
 */
export function memoryDelta({ memoryCorrect, baselineCorrect, asked }) {
  if (!Number.isInteger(asked) || asked <= 0) {
    throw new Error('a delta over no questions is not zero, it is undefined');
  }
  const pct = (n) => (n / asked) * 100;
  return {
    asked,
    memoryAccuracy: pct(memoryCorrect),
    baselineAccuracy: pct(baselineCorrect),
    /** The number to publish. Negative means the memory made the answerer worse, which is a real result. */
    deltaPoints: pct(memoryCorrect) - pct(baselineCorrect),
  };
}
