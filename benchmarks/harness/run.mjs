/**
 * One graded run: every question, both arms, every seed, one report (`B-6`).
 *
 * ## The rules that live BETWEEN the modules
 *
 * `retrieve.mjs`, `arms.mjs` and `grade.mjs` each hold one rule. This holds the ones that only exist when
 * they are joined, and each of them produces a plausible number when dropped — which is why they are in a
 * module rather than left to whoever writes the next runner:
 *
 *  - **The judge's independence is checked before anything is called.** A run whose number cannot be
 *    published should not spend a key finding that out.
 *  - **Retrieval runs once per question, not once per seed.** Recall has no seed; three retrievals that
 *    ought to be identical are three chances to compare different memory arms without noticing.
 *  - **The answerer is handed the question, the context and the seed, and nothing else.** The arms may
 *    differ in their context alone, so nothing that names the arm reaches the model — an adapter that could
 *    see "this is the baseline" is an adapter that will one day act on it.
 *  - **A failed step makes a seed UNSCORED, never low.** A question whose recall threw leaves the memory
 *    arm unanswered rather than answered from an empty context, and an answer that did not arrive is never
 *    handed to the judge. `correctCount` then refuses the seed, and the report says why.
 *  - **The figure travels with its spread.** One mean over three seeds hides exactly the noise the protocol
 *    makes variance reporting mandatory for.
 *
 * ## What it does NOT do
 *
 * Own a key or know a provider. `answerer` and `judge` are handed in — `{ provider, model, ask }` — so this
 * runs against fakes today and against real models the day the keys in `_PARKED-DECISIONS.md` arrive,
 * with no change here.
 */
import { retrieveAll, runReport } from './retrieve.mjs';
import { armsFor, armsDisagreeOn, memoryDelta } from './arms.mjs';
import { assertIndependentJudge, gradeOne, deltaInputs } from './grade.mjs';

/**
 * @param {object} args
 * @param {object}   args.ythril        a client exposing `recall`
 * @param {string}   args.space         the space the conversation was written into
 * @param {object}   args.conversation  the loader's conversation, for the baseline's context
 * @param {{question: string, reference: string}[]} args.questions  chosen by the caller, never loaded here
 * @param {{provider: string, model: string, ask: (i: {question: string, context: unknown, seed: number}) => Promise<string>}} args.answerer
 * @param {{provider: string, model: string, ask: (prompt: string) => Promise<string>}} args.judge
 * @param {number[]} args.seeds         at least one; the protocol asks for three
 * @param {number}   [args.topK]
 * @param {number}   [args.traverse]
 * @param {string|null} [args.commit]   the commit the run was made at — passed, never guessed
 */
export async function runGraded({
  ythril, space, conversation, questions, answerer, judge, seeds, topK = 10, traverse = 1, commit = null,
}) {
  assertIndependentJudge(answerer, judge);
  if (!Array.isArray(seeds) || seeds.length === 0 || !seeds.every(Number.isInteger)) {
    throw new Error('a graded run needs at least one integer seed — a figure over no seeds has no spread, '
      + 'and the protocol makes reporting the spread mandatory');
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('a graded run needs at least one question: a score over none is undefined, not zero');
  }
  for (const [i, q] of questions.entries()) {
    if (typeof q?.question !== 'string' || typeof q?.reference !== 'string') {
      throw new Error(`questions[${i}] needs a question and a reference string`);
    }
  }

  const retrieval = await retrieveAll({ ythril, space, questions: questions.map(q => q.question), topK, traverse });

  const perSeed = [];
  for (const seed of seeds) {
    const memoryGraded = [];
    const baselineGraded = [];
    for (const [i, { question, reference }] of questions.entries()) {
      const r = retrieval[i];
      const { memory, baseline } = armsFor({
        conversation, question, hits: r.hits,
        config: { answererModel: answerer.model, judgeModel: judge.model, seed },
      });
      const drift = armsDisagreeOn(memory, baseline);
      if (drift.length > 0) {
        throw new Error(`the arms differ in ${drift.join(', ')}, so their difference is not the memory`);
      }
      memoryGraded.push(r.error
        ? { arm: memory, verdict: null, error: `retrieval failed, so the memory arm was not asked: ${r.error}` }
        : await answerAndGrade({ answerer, judge, arm: memory, reference }));
      baselineGraded.push(await answerAndGrade({ answerer, judge, arm: baseline, reference }));
    }

    let score = null;
    let unscored;
    try {
      score = memoryDelta(deltaInputs(memoryGraded, baselineGraded));
    } catch (err) {
      unscored = err instanceof Error ? err.message : String(err);
    }
    perSeed.push({ seed, score, ...(unscored ? { unscored } : {}), memory: memoryGraded, baseline: baselineGraded });
  }

  const retrieved = runReport({ space, conversationId: conversation?.id ?? null, results: retrieval });
  return {
    config: {
      space,
      conversationId: conversation?.id ?? null,
      topK,
      traverse,
      answerer: { provider: answerer.provider, model: answerer.model },
      judge: { provider: judge.provider, model: judge.model },
      seeds: [...seeds],
      commit,
    },
    retrieval: {
      asked: retrieved.asked, failed: retrieved.failed, answered: retrieved.answered, results: retrieved.results,
    },
    seeds: perSeed,
    summary: summarise(perSeed),
  };
}

/**
 * Ask one arm and grade what came back — or record that nothing came back.
 *
 * The answerer's input is built HERE, field by field, rather than by spreading the arm: an arm carries
 * `memory`, and a spread would hand the model the one fact about the run it must not have.
 */
async function answerAndGrade({ answerer, judge, arm, reference }) {
  let answer;
  try {
    answer = await answerer.ask({ question: arm.question, context: arm.context, seed: arm.seed });
  } catch (err) {
    return { arm, verdict: null, error: `the answerer failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof answer !== 'string') {
    return { arm, verdict: null, error: `the answerer returned ${typeof answer}, not an answer` };
  }
  return gradeOne({ judge, arm, answer, reference });
}

/**
 * The published figure across seeds: mean, min and max of each number, over the SCORED seeds alone.
 *
 * Which seeds were left out is part of the figure, not a footnote to it — a mean over two of three seeds is
 * a different measurement from a mean over three, and a reader has to be able to tell which one they have.
 */
function summarise(perSeed) {
  const scored = perSeed.filter(s => s.score);
  const stat = (key) => {
    if (scored.length === 0) return null;
    const xs = scored.map(s => s.score[key]);
    return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) };
  };
  return {
    scoredSeeds: scored.length,
    unscoredSeeds: perSeed.filter(s => !s.score).map(s => s.seed),
    deltaPoints: stat('deltaPoints'),
    memoryAccuracy: stat('memoryAccuracy'),
    baselineAccuracy: stat('baselineAccuracy'),
  };
}
