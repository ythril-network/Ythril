/**
 * The answer of a search that traverses — recall and similar with `traverse > 0`, on every door — in one place.
 *
 * The three doors (MCP recall, which REST recall routes into; MCP similar; REST similar) each built this
 * inline: walk, cap, spill, budget. Three copies of one rule is how REST similar came to carry an absolute node
 * ceiling the other two did not. Now each door hands in only what is its own — the seeds, the space list its
 * caller's rights allow, and how it shapes a row — and the rule is here:
 *
 * - every row is walked whole (`row-graphs.ts`), lazily, only while the budget can still take rows;
 * - a row that cannot be whole is named, never shortened; `graphTruncated` means exactly that some were;
 * - the byte budget decides what fits (`result-budget.ts`), and nothing is spilled unless `remainderDump`.
 */
import type { GraphNode } from './recall-graph.js';
import type { TraverseNarrowing } from './frontier-query.js';
import { rowGraphWalker } from './row-graphs.js';
import { budgetedRowsEnvelope, type ResolvedBudget, type IncompleteRow } from './result-budget.js';
import { countGraphNodes } from './graph-spill.js';
import { summariseRecall } from './recall-shape.js';
import type { RecallResult } from './recall.js';

export async function traversedAnswer<T, S>(opts: {
  seeds: readonly RecallResult[];
  /** The spaces the caller's rights allow the walk into. Empty walks nothing. */
  memberIds: readonly string[];
  maxDepth: number;
  narrowing?: TraverseNarrowing;
  /** Milliseconds left of the call's one deadline. */
  deadline: () => number;
  budget: ResolvedBudget;
  skip: number;
  remainderDump: boolean;
  /** The door's own shape for one whole row. What it returns is what is measured and what is sent. */
  shapeRow: (seed: RecallResult, nodes: GraphNode[] | undefined) => T;
  spillRemainder: (remainder: T[], about: { incompleteRows: IncompleteRow[]; incompleteCount: number; stoppedAt?: number })
    => Promise<S | null>;
}): Promise<{ results: T[]; fields: Record<string, unknown> }> {
  const walk = rowGraphWalker({
    memberIds: opts.memberIds, maxDepth: opts.maxDepth, narrowing: opts.narrowing, deadline: opts.deadline,
    // The page's rows, so the walker can walk a window of them in step (Q-136).
    seeds: opts.seeds,
  });
  const out = await budgetedRowsEnvelope<T, S>({
    total: opts.seeds.length,
    budget: opts.budget,
    skip: opts.skip,
    remainderDump: opts.remainderDump,
    spillRemainder: opts.spillRemainder,
    build: async (i, first) => {
      const seed = opts.seeds[i]!;
      const g = await walk(seed, first);
      if ('stop' in g) return g;
      if ('incomplete' in g) {
        return { incomplete: { _id: seed._id, spaceId: seed.spaceId, type: seed.type, name: summariseRecall(seed), reason: g.incomplete } };
      }
      return { row: opts.shapeRow(seed, g.nodes) };
    },
  });
  return {
    results: out.results,
    fields: {
      ...out.fields,
      // Counted from the payload actually being sent, never from what was walked — see `countGraphNodes`.
      graphNodes: countGraphNodes(out.results),
      // Its meaning CHANGED with Q-126: some rows were left out because their graph could not be read whole.
      // Every row that IS returned carries its whole graph, so this no longer means "a returned graph is short".
      ...(typeof out.fields['incompleteCount'] === 'number' ? { graphTruncated: true } : {}),
    },
  };
}
