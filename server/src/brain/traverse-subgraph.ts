/**
 * What a walk answers with: the nodes it reached, and every edge AMONG them.
 *
 * ## The question this exists to stop being answered by accident
 *
 * A breadth-first walk deduplicates NODES — a record reached twice is one record, and it is expanded once.
 * That decision is correct and it is not the answer. Up to `Q-24` the edge list was derived from it: one
 * edge kept per node emitted, whichever the query happened to return first. Two things then disappear, and
 * both look like nothing rather than like a loss:
 *
 * - **A self-loop, always.** Its far end is the node you are standing on, so it is "already visited" by
 *   definition, on every walk, at every depth, with or without a label filter.
 * - **The second of two edges between one pair.** Asked for individually each comes back; asked for
 *   together, one silently loses.
 *
 * Reported from outside against a live space: a node with six outbound edges answered with three, and
 * `truncated` said `false` — which the product documents as *"nothing was cut for size reasons"*, so the
 * only signal a caller had was pointing the wrong way.
 *
 * ## The forgettable half, which is why this is a module and not four lines
 *
 * **An edge is only reported when BOTH of its ends are in the answer.** A hand-written version collects the
 * edges it read and returns them, and that is wrong in three ways nobody notices: an edge to a record that
 * no longer exists, an edge to a node the `limit` cut, and an edge to a record in a space this walk cannot
 * read all name a node the caller was not given. A relationship to something absent from `nodes` says
 * nothing anybody can act on, and it invites a lookup that 404s.
 *
 * **And it deduplicates by edge id**, because a walk reads its frontier's edges once per hop and an edge
 * between two nodes on consecutive frontiers is read twice. Reporting it twice is the opposite failure to
 * the one above, and it is the one a fix for the above tends to introduce: a caller counting relationships
 * must get the number that exists.
 *
 * It lives beside `edges.ts` rather than inside it because that file is frozen at its size, and the gate
 * that freezes it says why: new behaviour goes BESIDE a god-file, or every change lands in the same place
 * for ever.
 */
import type { EdgeDoc } from '../config/types.js';

/** One relationship in a walk's answer: its identity, its two ends and its label. */
export interface TraverseEdge {
  _id: string;
  from: string;
  to: string;
  label: string;
}

/**
 * Collects a walk's edges and hands back the ones among its nodes.
 *
 * Stateful on purpose: a walk reads edges hop by hop and emits nodes hop by hop, and the two are only
 * comparable once it has stopped. A function taking both lists would make every caller hold them.
 */
export interface SubgraphEdges {
  /** Every edge a hop read. Called with the hop's whole batch, before anything decides what to expand. */
  saw(edges: readonly EdgeDoc[]): void;
  /** A node that made it into the answer. An edge is reported only when both of its ends have. */
  reached(id: string): void;
  /** The edges among the reached nodes, each once. */
  among(): TraverseEdge[];
}

export function subgraphEdges(): SubgraphEdges {
  const stored = new Map<string, EdgeDoc>();
  const emitted = new Set<string>();
  return {
    saw: (edges) => { for (const e of edges) stored.set(e._id, e); },
    reached: (id) => { emitted.add(id); },
    among: () => [...stored.values()]
      .filter(e => emitted.has(e.from) && emitted.has(e.to))
      .map(e => ({ _id: e._id, from: e.from, to: e.to, label: e.label })),
  };
}
