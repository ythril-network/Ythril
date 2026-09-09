/**
 * Which source turns an answer covered, and at what rank.
 *
 * ## Why a RANK and not a set
 *
 * A set answers "did the evidence come back anywhere in `topK`", and that question rewards breadth: a rung
 * that packs more of the conversation into each record scores better without ever having ranked the right
 * thing first. Owner's ruling, 2026-09-06: *"first answer must be right - it must reflect reality, not brute
 * force."* Reading twenty records to find the evidence in the twentieth is not retrieval working; it is the
 * caller doing the retrieval by hand.
 *
 * So the rank is recorded per turn and the report leads with rank 1, which no amount of coverage can fake —
 * there is only one first result, and either it holds what the question needed or it does not.
 *
 * **A record's graph expansions carry that record's own rank**, because they were returned as part of its
 * payload and a caller reading result 1 reads them with it.
 *
 * ## The shape that made that last sentence false for every graph rung
 *
 * A recall answer nests a WRAPPER, not a node: `{ edge, node, paths, _graph }`. The children of a node hang
 * off the **wrapper's** `_graph`, and `node._graph` does not exist. The first version of this walk read
 * `g.node` and then recursed into that node's `_graph` — so it descended exactly one level and stopped, at
 * any depth, silently.
 *
 * Measured against a live instance while the linking rung was being investigated: a recall at `depth: 2` with
 * `includeMemories: true` returned 10 seeds, 18 subject entities and **92 linked memories**, and the scorer
 * credited the 18 and none of the 92. `s0wl` — whose entire claim is that a match walks to a shared subject
 * and back out to a window in a different session, which is the only mechanism that can answer a
 * cross-session question at rank 1 — was therefore scored as though its walk returned nothing. It came in at
 * 50.3% against the un-walked control's 50.8% and read as "linking does not help".
 *
 * Nothing in the report could have shown this. A scorer that credits too little produces a plausible number,
 * and a plausible number is never questioned — which is why the fix ships with a gate that nests two levels
 * and one that nests three, rather than a comment saying to be careful.
 *
 * ## Extracted from the runner
 *
 * It lived inside `run-tier0r.mjs`, which executes its `main()` on import, so it could not be tested without
 * driving a live instance. A scoring rule that cannot be tested in isolation is one nobody checks.
 */

/**
 * @param {Array<object>} results  the `results` array of a recall answer, in rank order
 * @param {Map<string, string[]>} [covers]  record id -> turn ids, for rungs that keep coverage out of the
 *        corpus. Consulted BEFORE a record's own property, because a rung that keeps its bookkeeping outside
 *        the embedded text is the correct arrangement and must not be penalised for it.
 * @returns {Map<string, number>} turn id -> 1-based rank of the result that brought it back, first wins
 */
export function turnRanks(results, covers) {
  const ranks = new Map();
  const note = (ids, rank) => {
    for (const one of ids) {
      const id = String(one).trim();
      // First appearance wins: a turn reached at rank 1 through an expansion must not be demoted when the
      // same turn also arrives as a lower-ranked result in its own right.
      if (id && !ranks.has(id)) ranks.set(id, rank);
    }
  };

  /**
   * @param node     the record itself
   * @param children the wrapper's `_graph` — passed in rather than read off the node, because that is where
   *                 a nested child actually lives. `node._graph` is the fallback for a hand-built tree.
   */
  const walk = (node, children, rank) => {
    /*
     * The OUT-OF-BAND map first, then the record's own property.
     *
     * A rung that keeps its coverage outside the corpus is the correct arrangement — a memory's embedded text
     * includes its properties, key and value, so `turn D3:1,D3:2,D3:3` inside the record puts a dozen
     * meaningless tokens into every vector in the corpus. Rungs written before that was noticed still store
     * it, and their numbers are still readable, so both are supported and the record's own field is the
     * fallback rather than the error.
     */
    const outOfBand = covers?.get(node?._id);
    if (Array.isArray(outOfBand)) note(outOfBand, rank);
    else if (typeof node?.properties?.turn === 'string') note(node.properties.turn.split(','), rank);

    for (const g of children ?? node?._graph ?? []) {
      walk(g?.node ?? g, g?._graph ?? g?.node?._graph, rank);
    }
  };

  (results ?? []).forEach((r, i) => walk(r, r?._graph, i + 1));
  return ranks;
}
