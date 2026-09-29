/**
 * A standalone traversal's answer, paged: whole nodes in hop order under the byte budget, `nextSkip` reaching every
 * node the walk found (`Q-132`).
 *
 * Owner rule, 2026-09-28, every door. `graph_traverse` and `POST /api/brain/spaces/:id/traverse` cut their node list at
 * `limit` with `truncated` and nothing else: no bound on the SIZE of the answer (a hundred long entity bodies with a
 * projection is a very large page) and no way to read on. Both doors now answer through this, so neither can page
 * differently.
 *
 * **Two cuts, reported apart.** `limit` still caps the WALK — how many nodes are visited at all — and a walk that hit it
 * answers `limitReached: true`: a partial graph, which only a larger `limit` reaches. The PAGE is the budget's cut over
 * what the walk found, and it answers `nextSkip`. `truncated` is true for either, as it always meant "partial".
 *
 * **The unit is a node with its edges back to the nodes before it** (self-loops included). So a page's edges join only
 * nodes a reader already holds, every edge arrives exactly once across the pages, and an edge's cost is charged to the
 * page that delivers it — a budget over nodes alone would let a hub's hundred edges ride free.
 */
import { applyBudget, budgetFields, resolveBudget, resolvePaging, queryInt, type BudgetRequest } from './result-budget.js';
import type { TraverseResult } from './edges.js';

export interface TraversePageRequest extends BudgetRequest {
  skip?: unknown;
  remainderDump?: unknown;
}

type Node = TraverseResult['nodes'][number];
type Edge = TraverseResult['edges'][number];

export async function pageTraversal(
  walk: TraverseResult,
  req: TraversePageRequest,
  opts: { budgetChars: number; spillRemainder?: (remainder: Array<{ node: Node; edges: Edge[] }>) => Promise<unknown> },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const paging = resolvePaging({ skip: queryInt(req.skip), remainderDump: req.remainderDump });
  if (!paging.ok) return paging;
  const budget = resolveBudget({
    ...(req.maxChars !== undefined ? { maxChars: queryInt(req.maxChars) } : {}),
    ...(req.maxBytes !== undefined ? { maxBytes: queryInt(req.maxBytes) } : {}),
    ...(req.maxTokens !== undefined ? { maxTokens: queryInt(req.maxTokens) } : {}),
  } as BudgetRequest, opts.budgetChars);
  if (!budget.ok) return budget;

  // Hop order, stable within a hop: the walk's own order breaks ties.
  const ordered = walk.nodes.map((n, i) => ({ n, i })).sort((a, b) => ((a.n.depth ?? 0) - (b.n.depth ?? 0)) || (a.i - b.i)).map(x => x.n);
  const position = new Map(ordered.map((n, i) => [String((n as { _id?: unknown; id?: unknown })._id ?? (n as { id?: unknown }).id), i]));
  const unitsEdges: Edge[][] = ordered.map(() => []);
  for (const e of walk.edges) {
    const a = position.get(String(e.from)); const b = position.get(String(e.to));
    if (a === undefined || b === undefined) continue;
    unitsEdges[Math.max(a, b)]!.push(e);
  }
  const units = ordered.map((node, i) => ({ node, edges: unitsEdges[i]! }));

  const page = units.slice(paging.skip);
  const outcome = applyBudget(page, budget);
  const fields = budgetFields(outcome, units.length, budget, paging.skip);
  const body: Record<string, unknown> = {
    nodes: outcome.returned.map(u => u.node),
    edges: outcome.returned.flatMap(u => u.edges),
    ...fields,
    // `count` is the NODES the walk found, across all pages; `returned` is this page's.
    truncated: outcome.truncated || walk.truncated,
    limitReached: walk.truncated,
  };
  if (outcome.truncated && paging.remainderDump && opts.spillRemainder) {
    try {
      const kept = await opts.spillRemainder(outcome.remainder);
      if (kept && typeof kept === 'object' && 'spillRefused' in kept) body['spillRefused'] = (kept as { spillRefused: unknown }).spillRefused;
      else if (kept) body['remainder'] = kept;
    } catch {
      body['spillRefused'] = 'failed';
    }
  }
  return { ok: true, body };
}
