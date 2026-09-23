/**
 * The token-overlap F1 score LoCoMo's own evaluation reports — every answer, no model (`B-6`).
 *
 * ## Why a deterministic score beside the judged one
 *
 * Owner rule, 2026-09-19: the harness is as deterministic as it can be. A judge is a model and a model can
 * be re-run into a different number; F1 is a function of two strings and gives the same figure to anyone who
 * runs it, for ever. So every answer gets this score, and the judge is kept to a SAMPLE whose job is to put a
 * number beside the ones other systems quote.
 *
 * ## What it follows, and the one place it does not
 *
 * The normalisation is LoCoMo's: lowercase, drop punctuation, drop `a`/`an`/`the`, collapse whitespace.
 * Category 1 (multi-hop) answers are lists, so each comma-separated part of the reference is scored against
 * its best-matching part of the prediction and the parts are averaged. Category 3 references carry a
 * rationale after a semicolon, which is not part of the answer.
 *
 * **It does not stem.** LoCoMo's script runs a Porter stemmer over the tokens, so `runs` and `running`
 * match there and not here. The figure is therefore close to theirs and not identical, and the report says
 * so rather than quoting it as their metric. A stemmer is a dependency and a second implementation of
 * somebody else's rules; stating the difference is cheaper than owning one.
 */

const ARTICLES = new Set(['a', 'an', 'the']);

/** LoCoMo's normalisation, as tokens. */
function tokens(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t && !ARTICLES.has(t));
}

/** Token F1 between one prediction and one reference. Zero, not NaN, when either side is empty. */
export function tokenF1(prediction, reference) {
  const p = tokens(prediction);
  const r = tokens(reference);
  if (p.length === 0 || r.length === 0) return 0;
  const counts = new Map();
  for (const t of r) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of p) {
    const n = counts.get(t) ?? 0;
    if (n > 0) { common++; counts.set(t, n - 1); }
  }
  if (common === 0) return 0;
  const precision = common / p.length;
  const recall = common / r.length;
  return (2 * precision * recall) / (precision + recall);
}

/**
 * The score for one LoCoMo answer, by the rule its category uses.
 *
 * @param {string} prediction what the answerer said
 * @param {string} reference  the release's answer
 * @param {number} category   1–4; category 5 is not scored
 */
export function locomoF1(prediction, reference, category) {
  if (category === 3) return tokenF1(prediction, String(reference).split(';')[0]);
  if (category === 1) {
    const refs = String(reference).split(',').map(s => s.trim()).filter(Boolean);
    const preds = String(prediction ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (refs.length === 0) return 0;
    const best = refs.map(r => Math.max(0, ...preds.map(p => tokenF1(p, r))));
    return best.reduce((a, b) => a + b, 0) / refs.length;
  }
  return tokenF1(prediction, reference);
}
