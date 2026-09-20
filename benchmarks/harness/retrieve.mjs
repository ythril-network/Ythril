/**
 * Ask one question of one written space, and record exactly what was asked.
 *
 * ## What this is, and what `#1282` deleted
 *
 * The first increment of `B-6`. A graded runner was deleted in `#1282` — 56 files, on the owner's
 * instruction — because everything in it rested on one premise: that a conversation is a pile of
 * transcript chunks and the question is how big to cut them. At an equal byte budget the best of twelve
 * strategies answered 50.8% at rank 1, and **multi-hop scored 0.0% under every one of them**, because
 * those answers need two remarks from sessions weeks apart and no run of consecutive turns holds both.
 *
 * So this is a rebuild rather than a revert, and the thing it retrieves from is the GRAPH the writer now
 * produces — entities that a mention in session 3 and a mention in session 18 both hang off — rather than
 * a window over the transcript.
 *
 * ## It does not grade, and that is deliberate rather than unfinished
 *
 * `B-2`'s answer is *"one Tier 0 run, then decide"*, with an answerer and a judge from **two different
 * hosted families** so the judge is not marking its own phrasing. Both need keys this repository does not
 * have, so the grading half is parked on the owner with exactly that written down. Retrieval needs no
 * model at all, is the half every tier shares, and is what a `B-2` cost estimate is an estimate OF.
 *
 * ## Why the request is returned with the answer
 *
 * A retrieval result on its own cannot be reproduced or compared: `topK`, the traversal depth and the
 * space are all part of what the number means, and the protocol requires a run to name its configuration
 * or the figure is worth nothing. So every call hands back the exact request it made, and the caller
 * writes it into the report rather than reconstructing it from the settings it *believes* it passed.
 *
 * ## What it must never do
 *
 * Touch a question set. `loadQuestions` exists and this file does not import it: retrieval is handed a
 * question STRING by whoever is running the tier, and the module that chooses which questions to ask is a
 * different one with a different contract. Extraction blindness is enforced in the loaders; this keeps the
 * separation on the other side of the pipeline, where a convenience import would quietly join them.
 */

/** The fields a recall result carries back, flattened out of the wire envelope. */
function hitOf(result) {
  const record = result?.record ?? {};
  return {
    id: record._id ?? null,
    kind: result?.type ?? null,
    /*
     * The record's own text, under whichever key its kind uses. Not a summary and not a join of several:
     * a grader reads this, and a field that silently concatenated two would score a retrieval that found
     * one of them.
     */
    text: record.fact ?? record.name ?? record.title ?? record.path ?? record.label ?? null,
    /*
     * Carried because it changes what the text MEANS. A superseded record is still true of its time and
     * false of now, and a grader that cannot see the mark scores a correct historical answer as a wrong
     * current one — or the reverse.
     */
    ...(record.superseded === true ? { superseded: true } : {}),
    score: typeof result?.score === 'number' ? result.score : null,
  };
}

/**
 * Ask one question.
 *
 * @param {object} args
 * @param {object} args.ythril   a client exposing `recall({ space, query, topK, traverse })`
 * @param {string} args.space    the space id the conversation was written into
 * @param {string} args.question the question TEXT, chosen by the caller — see the header
 * @param {number} [args.topK]   how many matches to ask for
 * @param {number} [args.traverse] graph hops off each match
 * @returns {Promise<{request: object, hits: object[], error?: string}>}
 */
export async function retrieveOne({ ythril, space, question, topK = 10, traverse = 1 }) {
  if (!space) throw new Error('retrieveOne needs a space: a run against no space is not a zero score');
  if (typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('retrieveOne needs a question string. It does not read a question SET — see the header.');
  }
  const request = { space, query: question, topK, traverse };

  let answer;
  try {
    answer = await ythril.recall(request);
  } catch (err) {
    /*
     * A FAILED CALL IS NOT AN EMPTY RESULT, and conflating them is how a broken run reports a low score
     * instead of a broken run. The request is still returned, so the report can say which question could
     * not be asked rather than which one was answered badly.
     */
    return { request, hits: [], error: err instanceof Error ? err.message : String(err) };
  }
  return { request, hits: (answer?.results ?? []).map(hitOf) };
}

/**
 * Ask many, in order, and keep going when one fails.
 *
 * Sequential on purpose. Parallel calls would finish in a different order each run and make two runs of
 * the same configuration produce diffs nobody can attribute — the same reason the loader breaks ties on
 * the published position rather than leaving the sort to chance.
 */
export async function retrieveAll({ ythril, space, questions, topK, traverse }) {
  const out = [];
  for (const question of questions) {
    out.push(await retrieveOne({ ythril, space, question, topK, traverse }));
  }
  return out;
}

/**
 * What a run has to say about itself, or its number is worth nothing.
 *
 * `B-2` requires a report to name both models and both seeds. There are no models here yet, and the
 * fields are present and `null` rather than absent: a report that omits what it did not use reads
 * identically to one written before anybody thought to record it, and the protocol's whole complaint
 * about self-reported figures is that they leave out the column that would explain them.
 */
export function runReport({ space, conversationId, results, config = {} }) {
  const asked = results.length;
  const failed = results.filter(r => r.error).length;
  return {
    conversationId,
    space,
    asked,
    failed,
    answered: asked - failed,
    /** Every hit, flattened, so a grader never re-derives what was retrieved. */
    results,
    config: {
      topK: config.topK ?? null,
      traverse: config.traverse ?? null,
      /** Tier 0 and above fill these. Present-and-null says "no model ran", which is a fact about the run. */
      answererModel: config.answererModel ?? null,
      judgeModel: config.judgeModel ?? null,
      seed: config.seed ?? null,
      /** The commit the run was made at. The caller passes it; guessing it here would be a second source. */
      commit: config.commit ?? null,
    },
  };
}
