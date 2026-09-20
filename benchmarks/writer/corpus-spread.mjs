/**
 * How unevenly did one prompt treat the corpus?
 *
 * ## The figure this exists to keep honest
 *
 * `B-4` extracted ten conversations with one prompt and one model, and the result decided the three rows
 * after it: chrono entries per 1,000 turns ranged from **10.3 to 67.8** — a 6.6x spread — with supersessions
 * running 0 to 8 across conversations of comparable length. The prompt's own standard is that two models
 * disagreeing a lot is a finding about the prompt. One model disagreed with itself by 6.6x, which met that
 * test before a second model was ever run, and most of `B-14` was about what caused it.
 *
 * `B-16` is judged by whether the spread narrows, so the figure gets recomputed every round. **A number
 * arrived at by a command somebody typed once is a number nobody can check and everybody quotes** — this
 * repo's rule about a count in prose, one level up. The derivation lives here so there is one place to be
 * wrong instead of one per round.
 *
 * ## Why chrono density is the axis
 *
 * It is the measurement that moved. Claims track turns closely because every turn must be named by one, and
 * entities track how many distinct subjects a conversation has — both are properties of the transcript. What
 * reaches the TIMELINE was decided by the prompt's date rules, and those rules were where the gaps were: a
 * marriage, a diagnosis, a pride parade and a career-high game were all absent from their timelines while a
 * photograph taken on a named Friday was present.
 *
 * ## The two headlines it refuses to print
 *
 * A conversation with no chrono entries makes the ratio infinite, and `Infinity` beside nine honest numbers
 * reads as a catastrophe rather than as one empty file. A corpus of one has no spread, and reporting `1.0`
 * for it looks like perfect consistency. Both return `null` with a `why` — a headline nobody can interpret
 * is worse than one that says what is missing.
 */

/** One decimal, because a second is precision the input does not have. */
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {object[]} extractions merged extraction files
 * @returns {{rows: object[], totals: object, chronoSpread: number|null, why: string|null,
 *            densest: object|null, sparsest: object|null}}
 */
export function corpusSpread(extractions) {
  if (!Array.isArray(extractions) || extractions.length === 0) {
    throw new Error('no extractions to measure — an empty corpus has no spread, it has no corpus');
  }

  const rows = extractions.map((x) => {
    const turns = new Set((x.sessions ?? []).flatMap(s => s.turns ?? [])).size;
    if (turns === 0) {
      /*
       * The guard a hand-written loop drops. Zero turns divides by zero, which in JavaScript is `Infinity`
       * rather than an error — so an unreadable extraction would report as the densest in the corpus and
       * set the headline single-handed.
       */
      throw new Error(`'${x.conversationId}' declares no turns, so its density would be Infinity and it `
        + 'would set the spread by itself');
    }
    const chrono = (x.chrono ?? []).length;
    return {
      id: x.conversationId,
      turns,
      claims: (x.claims ?? []).length,
      entities: (x.entities ?? []).length,
      edges: (x.edges ?? []).length,
      chrono,
      /** Chrono entries a thousand turns of conversation yielded — the one figure two sizes can be compared on. */
      chronoPer1000: round1((chrono / turns) * 1000),
      /** Superseded CLAIMS, not `supersedes` edges: a retirement with no successor has no edge and is still one. */
      superseded: (x.claims ?? []).filter(c => c.superseded === true).length,
      spansUsed: (x.chrono ?? []).filter(c => c.endsAt !== undefined).length,
    };
  }).sort((a, b) => a.chronoPer1000 - b.chronoPer1000);

  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
  const totals = {
    conversations: rows.length,
    turns: sum('turns'),
    claims: sum('claims'),
    entities: sum('entities'),
    chrono: sum('chrono'),
    edges: sum('edges'),
    superseded: sum('superseded'),
    spansUsed: sum('spansUsed'),
    /* Summed, never averaged from the rates: an average weights a 369-turn conversation like a 689-turn one. */
    chronoPer1000: round1((sum('chrono') / sum('turns')) * 1000),
  };

  const sparsest = rows[0];
  const densest = rows[rows.length - 1];
  if (rows.length < 2) {
    return { rows, totals, chronoSpread: null, densest: null, sparsest: null,
      why: 'a spread needs more than one conversation, and this is one' };
  }
  if (sparsest.chronoPer1000 === 0) {
    return { rows, totals, chronoSpread: null, densest, sparsest,
      why: `'${sparsest.id}' has no chrono entries at all, so the ratio is infinite. That is a fact about `
        + 'that one extraction and not about the corpus — fix or explain it before reading a spread.' };
  }
  return {
    rows, totals, densest, sparsest, why: null,
    chronoSpread: round1(densest.chronoPer1000 / sparsest.chronoPer1000),
  };
}
