/**
 * Turn an arm's answer into a verdict, and refuse to turn anything else into one (`B-6`).
 *
 * ## The one thing this module exists to make impossible
 *
 * Counting a judge call that FAILED as an answer the judge marked wrong. It is a `catch` returning
 * `false` — four characters — and what comes out is a run that publishes a low score rather than
 * reporting that it could not be scored. Nothing downstream can tell the two apart afterwards: a 41%
 * built from nine timeouts reads exactly like a 41% that was measured.
 *
 * `retrieve.mjs` draws the same line one step earlier, where it costs less. Here it is the published
 * number, so the refusal is structural rather than advised: `gradeOne` never returns a verdict it did not
 * receive, and `correctCount` THROWS on a list holding an ungraded item instead of counting it as
 * incorrect. A partial figure is available and has to be asked for by name.
 *
 * ## Why the judge's independence is checked here and not in the runner
 *
 * `B-2` requires the answerer and the judge to come from two different hosted families, so the judge is
 * not marking its own phrasing. Bench'd's numbers are what makes that more than tidiness: self-reported
 * figures and independently-run ones differ by tens of points on the same systems.
 *
 * A runner that forgets the check produces a plausible number several points high, and there is nothing
 * in the output to see it by. So the check lives beside the thing it protects, and it is on the
 * PROVIDER — a table of model-name prefixes is a list that goes stale the week a provider renames
 * something, and a stale list here fails open.
 *
 * ## What it does NOT do
 *
 * Own a key, or know which provider to call. `judge.ask` is handed in — one function, question in,
 * verdict word out. That is what lets every rule above be tested without a model, and it is why the
 * parked half of `B-6` is a configuration change rather than a build when the keys arrive.
 */

/**
 * The only two things a judge may say.
 *
 * There is deliberately no third for "cannot tell". A judge that is unsure has produced no verdict, which
 * is the `error` path — folding it in here would put an unmeasured question back into the denominator
 * under a friendlier name.
 */
export const VERDICTS = Object.freeze(['correct', 'incorrect']);

/** The prompt the judge is given. One place, so the two arms cannot be asked differently. */
export function judgePrompt({ question, answer, reference }) {
  return [
    'Decide whether the ANSWER is correct for the QUESTION, using the REFERENCE as ground truth.',
    'Reply with exactly one word: correct, or incorrect.',
    '',
    `QUESTION: ${question}`,
    `REFERENCE: ${reference}`,
    `ANSWER: ${answer}`,
  ].join('\n');
}

/**
 * Refuse a judge drawn from the answerer's own provider.
 *
 * Both roles must NAME a provider. A missing one is refused rather than read as "different from the
 * other" — the whole point is that the two are known to be independent, and an absent field is not
 * evidence of anything.
 */
export function assertIndependentJudge(answerer, judge) {
  const a = answerer?.provider;
  const j = judge?.provider;
  if (!a || !j) {
    throw new Error('the answerer and the judge must each name a provider — an absent provider is not '
      + 'evidence that the two are independent, and B-2 requires that they are');
  }
  if (a === j) {
    throw new Error(`the judge and the answerer are both on provider "${a}". B-2 requires two different `
      + 'hosted families so the judge is not marking its own phrasing.');
  }
}

/**
 * Grade one answer.
 *
 * @param {object} args
 * @param {{provider: string, model: string, ask: (prompt: string) => Promise<string>}} args.judge
 * @param {object} args.arm       the arm this answer came from, carried through for the report
 * @param {string} args.answer    what the answerer said
 * @param {string} args.reference the ground truth
 * @returns {Promise<{verdict: string|null, error?: string, raw?: string, judgeModel: string, arm: object}>}
 */
export async function gradeOne({ judge, arm, answer, reference }) {
  const base = { arm, judgeModel: judge?.model ?? null, verdict: null };
  let raw;
  try {
    raw = await judge.ask(judgePrompt({ question: arm?.question, answer, reference }));
  } catch (err) {
    // NOT a verdict. See the header: this is the whole reason the module exists.
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
  const word = String(raw ?? '').trim().toLowerCase();
  if (!VERDICTS.includes(word)) {
    /*
     * Quoted back, because the fix for this is always in the prompt and a refusal that says only "invalid
     * verdict" sends somebody to read the judge's source instead of its reply.
     */
    return { ...base, error: `the judge answered ${JSON.stringify(String(raw ?? ''))}, which is neither `
      + `${VERDICTS.join(' nor ')}`, raw: String(raw ?? '') };
  }
  return { ...base, verdict: word, raw: String(raw) };
}

/**
 * Grade many, in order, keeping the failures.
 *
 * Sequential for the reason `retrieveAll` is: two runs of one configuration have to produce the same
 * order, or a diff between them cannot be attributed to anything.
 */
export async function gradeAll({ judge, items }) {
  const out = [];
  for (const item of items) {
    out.push(await gradeOne({ judge, ...item }));
  }
  return out;
}

/**
 * How many the judge marked correct — over a list it actually graded.
 *
 * **Throws when anything is ungraded**, naming the count, because the alternative is the failure at the
 * top of this file. `allowUngraded` gives the partial figure to a caller who has decided that is what
 * they want; having to type it is the point, and the number is then over the graded items alone.
 */
export function correctCount(graded, { allowUngraded = false } = {}) {
  if (!Array.isArray(graded) || graded.length === 0) {
    throw new Error('a score over no questions is undefined, not zero correct');
  }
  const ungraded = graded.filter(g => !VERDICTS.includes(g?.verdict));
  if (ungraded.length > 0 && !allowUngraded) {
    throw new Error(`${ungraded.length} of ${graded.length} answers have no verdict, so this run cannot `
      + 'be scored. Counting them as incorrect publishes a low number instead of a broken run. Pass '
      + '{ allowUngraded: true } to score the graded ones alone.');
  }
  return graded.filter(g => g.verdict === 'correct').length;
}

/**
 * The three numbers `memoryDelta` needs, derived from the two graded lists rather than typed.
 *
 * **`asked` is the part this exists for.** `memoryDelta` takes a denominator, and a caller who scored with
 * `{ allowUngraded: true }` and then passed the number of questions they SENT gets the ungraded ones back
 * in the denominator as zeros — the exact failure `correctCount` refuses, walking in through the next
 * function along. Here the denominator cannot be supplied at all.
 *
 * **Two lists of different lengths are refused**, because a subtraction between different question sets is
 * not a subtraction. `armsDisagreeOn` checks that the two arms were configured alike; this checks they
 * were asked the same number of things, which is the other half of the same promise.
 */
export function deltaInputs(memoryGraded, baselineGraded) {
  if (!Array.isArray(memoryGraded) || !Array.isArray(baselineGraded)) {
    throw new Error('deltaInputs needs both graded lists — an absent arm is not a zero score');
  }
  if (memoryGraded.length !== baselineGraded.length) {
    throw new Error(`the arms were graded over different question sets (${memoryGraded.length} and `
      + `${baselineGraded.length}). A subtraction between them is not the memory's contribution.`);
  }
  return {
    memoryCorrect: correctCount(memoryGraded),
    baselineCorrect: correctCount(baselineGraded),
    asked: memoryGraded.length,
  };
}
