/**
 * Where the gold evidence actually sits, and the ceiling that puts on a rank-1 score.
 *
 * ## The question this answers
 *
 * *"If retrieval were perfect, what would this question set score?"* — and on the metric the protocol
 * publishes, that is not 100%.
 *
 * The headline asks whether the SINGLE top result held every turn the gold answer cites. Most questions
 * cite one turn, so most are winnable. But a question citing two turns needs one record containing both,
 * and when those turns are in different sessions of the conversation, no record built from consecutive
 * turns can contain them — at any window size. Those questions are lost before retrieval runs.
 *
 * Measured on the published 199-question sample: 160 cite a single turn, 9 more cite turns inside one
 * session, and **30 cite turns from different sessions**. So every window rung in the programme is capped
 * at 84.9%, and the sweep from a 3-turn window to a 25-turn window can move at most 1 point of it.
 *
 * ## Why it is a module and not a number in a document
 *
 * A number written into prose is a second copy of a fact the dataset already holds, and this repository has
 * a rule about that: it rots, and nobody re-reads a reason once it is written. The sample is seeded and the
 * dataset is pinned by hash, so the ceiling is derivable exactly — and it must be derived per run, because
 * a different `--questions` or `--seed` is a different set of questions with a different layout.
 *
 * ## What this ceiling does NOT bound, and the boundary is the point
 *
 * Rank-1 credit reaches through a record's graph expansions: `turnRanks` in the runner walks `_graph` and
 * gives every expanded node its parent's rank, because a caller reading result 1 reads them with it. So a
 * rung that LINKS turns across sessions can carry a second session's turn into the first result, and is
 * genuinely not bound by this number.
 *
 * That is why the export is named for contiguous windows rather than called "the ceiling". A gate or a
 * report that treats it as a bound on every strategy would be concluding about more than it checked, which
 * is the failure this repository produces most.
 */

/** `D<session>:<turn>` — the only evidence id shape the LoCoMo release uses after `loadQuestions` repairs it. */
const EVIDENCE_ID = /^D(\d+):(\d+)$/;

/**
 * The layout of the evidence across a question set.
 *
 * @param {Array<{evidence: string[]}>} questions  answerable questions, as `loadQuestions` returns them
 * @returns {{n: number, singleTurn: number, withinSession: number, crossSession: number, spans: number[]}}
 *   `spans` holds one entry per within-session question: how many consecutive turns a record would have to
 *   cover to contain all of its evidence. A cross-session question contributes no span, because no width
 *   answers it.
 *
 * Throws rather than returning a plausible answer on an empty set, a question with no evidence, or an id it
 * cannot parse. Each of those would otherwise shrink the denominator silently and report a ceiling for a
 * smaller set than the one being measured — the specific way a derived number goes wrong without anything
 * contradicting it.
 */
export function evidenceShape(questions) {
  const list = questions ?? [];
  if (list.length === 0) {
    throw new Error('evidenceShape: no questions. A ceiling over an empty set formats as 0% and reads as a result.');
  }

  let singleTurn = 0;
  let withinSession = 0;
  let crossSession = 0;
  const spans = [];

  for (const question of list) {
    const evidence = question?.evidence ?? [];
    if (evidence.length === 0) {
      throw new Error(
        'evidenceShape: a question cites no evidence. Filter to answerable questions before calling — '
        + 'skipping it here would divide by a denominator nobody chose.',
      );
    }

    const parsed = evidence.map(one => {
      const m = EVIDENCE_ID.exec(String(one).trim());
      if (!m) {
        throw new Error(`evidenceShape: evidence id ${JSON.stringify(one)} is not D<session>:<turn>. `
          + 'loadQuestions repairs the nine malformed ids in the release, so an unparseable one here means '
          + 'the caller skipped that step.');
      }
      return { session: Number(m[1]), turn: Number(m[2]) };
    });

    if (evidence.length === 1) singleTurn++;

    // The session is half the identity: `D3:7` and `D9:7` are different turns, and treating them as the
    // same turn number would make a spread look like a single record's worth of content.
    const sessions = new Set(parsed.map(p => p.session));
    if (sessions.size > 1) {
      crossSession++;
      continue;
    }
    withinSession++;
    const turns = parsed.map(p => p.turn);
    spans.push(Math.max(...turns) - Math.min(...turns) + 1);
  }

  return { n: list.length, singleTurn, withinSession, crossSession, spans };
}

/**
 * The highest rank-1 score reachable by a strategy whose answering record is a run of consecutive turns
 * from one session.
 *
 * @param {ReturnType<evidenceShape>} shape
 * @param {number} windowTurns  how many consecutive turns one record covers
 * @returns {number} a fraction of all questions, 0..1
 *
 * Flat above the widest within-session span, and never above `withinSession / n` however wide the window
 * gets: widening a window cannot reach into another session.
 */
export function contiguousWindowCeiling(shape, windowTurns) {
  return shape.spans.filter(span => span <= windowTurns).length / shape.n;
}

/**
 * The one line a report prints beside its rank-1 score.
 *
 * Uses the ceiling for an UNLIMITED window, because that is the one number that bounds every window rung
 * whatever shape it was given — a report covering four rungs cannot print four ceilings and stay readable,
 * and the widest one is the honest single figure.
 *
 * Here rather than in the report writer so the sentence and the arithmetic cannot drift apart, and so a
 * second report surface gets the same wording for free.
 */
export function ceilingSentence(shape) {
  // A report is the whole reason the ceiling is computed, so a missing shape is a report published
  // without one — the exact state this module was written to end. It says so instead of throwing on
  // a property of undefined three lines later.
  if (!shape || typeof shape.n !== 'number') {
    throw new Error('ceilingSentence: no evidence shape. Pass evidenceShape(sample) in the report meta — '
      + 'a rank-1 score published with no ceiling beside it cannot be read as near or far from the maximum.');
  }
  const pct = value => `${(100 * value).toFixed(1)}%`;
  return `**Ceiling:** ${pct(contiguousWindowCeiling(shape, Infinity))} for any rung whose answering record `
    + 'is a run of consecutive turns — '
    + `${shape.crossSession} of ${shape.n} questions (${pct(shape.crossSession / shape.n)}) are `
    + '**cross-session**, citing turns from different sessions, and no window of any width holds both. '
    + 'A rung that LINKS turns across sessions is not bound by it: rank-1 credit reaches through a '
    + "result's graph expansions.";
}
