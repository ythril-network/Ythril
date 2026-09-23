/**
 * The figures a file run publishes: F1 over every answer, and the judge's accuracy over the sample (`B-6`).
 *
 * ## Two numbers, and each says what it is over
 *
 * **F1** is deterministic and covers every scored question. It is the figure anyone can re-derive from the
 * committed answers with no model.
 *
 * **Judge accuracy** covers the sample only, so it travels with its sample size and a 95% interval — a
 * figure over 200 questions presented without its margin reads as more precise than it is, which is the
 * thing `B-2` says every self-reported number gets wrong.
 *
 * Both are reported per arm AND as the memory arm minus the baseline, because `B-2`'s point is that the
 * delta is the number: an accuracy on its own says nothing about whether the memory did anything.
 *
 * ## The judge figure is PAIRED
 *
 * A question counts only when both of its arms have a verdict. Scoring each arm over whatever it happened to
 * get graded would let a truncated batch that dropped more baseline items than memory items move the delta,
 * and the delta would then be about the upload rather than the memory.
 */
import { locomoF1 } from './f1.mjs';
import { scoredQuestions, readAnswers, readVerdicts, ARMS, SCORED_CATEGORIES } from './file-run.mjs';

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** F1 per arm, per category and overall, over every scored question of the given conversations. */
export function f1Scores({ runDir, conversations, questions }) {
  const rows = [];
  for (const c of conversations) {
    const answers = Object.fromEntries(ARMS.map(arm => [arm, readAnswers(runDir, c, arm)]));
    for (const q of scoredQuestions(questions, c)) {
      const row = { id: q.id, category: q.category };
      for (const arm of ARMS) row[arm] = locomoF1(answers[arm][q.id], q.answer, q.category);
      rows.push(row);
    }
  }
  const summarise = (subset) => ({
    n: subset.length,
    memory: mean(subset.map(r => r.memory)),
    baseline: mean(subset.map(r => r.baseline)),
    delta: subset.length === 0 ? null : mean(subset.map(r => r.memory - r.baseline)),
  });
  return {
    overall: summarise(rows),
    byCategory: Object.fromEntries(SCORED_CATEGORIES.map(cat => [cat, summarise(rows.filter(r => r.category === cat))])),
  };
}

/** Judge accuracy per arm over the paired sample, with the delta's 95% interval. */
export function judgeScores({ runDir }) {
  const byQuestion = new Map();
  for (const v of readVerdicts(runDir)) {
    if (!byQuestion.has(v.id)) byQuestion.set(v.id, {});
    byQuestion.get(v.id)[v.arm] = v.verdict === 'correct' ? 1 : 0;
  }
  const paired = [...byQuestion.values()].filter(p => ARMS.every(a => a in p));
  const n = paired.length;
  if (n === 0) return { n: 0, memory: null, baseline: null, delta: null, ci95: null, unpaired: byQuestion.size };
  const d = paired.map(p => p.memory - p.baseline);
  const dMean = mean(d);
  const sd = n > 1 ? Math.sqrt(d.reduce((a, x) => a + (x - dMean) ** 2, 0) / (n - 1)) : 0;
  const half = 1.96 * sd / Math.sqrt(n);
  return {
    n,
    memory: mean(paired.map(p => p.memory)),
    baseline: mean(paired.map(p => p.baseline)),
    delta: dMean,
    ci95: [dMean - half, dMean + half],
    unpaired: byQuestion.size - n,
  };
}
