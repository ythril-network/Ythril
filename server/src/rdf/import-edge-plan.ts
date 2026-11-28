/**
 * The read sets the dry plan of an RDF import plans its edges in, and what the one it may share costs (bundle-384, Q-983, second fix round, finding 1).
 *
 * ## What it prevents
 *
 * The dry plan reads the store in windows, and every edge window used to plan in ONE read set kept for the whole file: each planned edge adds its
 * document, its triplet key and its seeded ends to that set, so a file of bare edges (BSBM at 10 000 products makes 822 342) grew the heap by the
 * edge, uncharged and uncapped, after the index and the sets that the door counted were gone. The dry plan's read set is now freed with its window
 * unless the plan needs what an earlier window planned:
 *
 * - **A functional edge label**: an edge counts the edges its subject already has under the label, and the edges of one subject can fall in two windows.
 * - **A reified edge**: two reifiers that name one triplet are one edge, and the second finds the first in the read set (a converge, not a second insert).
 *
 * Neither is needed by a bare edge under a label that is not functional (an edge is minted once per triplet, and the plan of an edge asks the read set
 * for nothing an earlier window held), so such a file plans every window in a fresh read set and holds nothing beyond it. A plan that does share the
 * read set charges {@link EDGE_PLAN_BYTES} for each edge it plans, to a meter of the second phase's room (`import-memory.ts`), and the door's count
 * ({@link edgePlansCharged}) charges the same, so a file the door lets in is not refused here.
 *
 * ## What a caller cannot forget, because it is inside
 *
 * - **The choice is made here, from the plan and the window**: {@link EdgeReadSets.forWindow} answers the read set; a caller cannot share one for a
 *   file that does not need it, nor free one that does.
 * - **The charge comes with the answer**: {@link EdgeReadSets.planned} takes {@link EDGE_PLAN_BYTES} an edge exactly when the read set is shared.
 */
import type { SpaceMeta } from '@ythril-network/schema';
import type { ReadSet } from '../brain/write-plan/read-set.js';

import type { ImportMemoryMeter } from './import-memory.js';
import type { RecordOp } from './quads-to-ops.js';

/**
 * The heap bytes one planned edge keeps in the shared read set: its planned document, its entries in the set's maps (by id, by triplet, by subject),
 * the ids of its two ends it seeded, measured by `the-import-memory-charges-the-edge-plan-db.test.js` just after the maps doubled (their dearest) and
 * charged a little above.
 */
export const EDGE_PLAN_BYTES = 1700;

/** Does a plan schema hold a functional edge label: the one rule the planner reads across edge windows (`functionalIn` of `plan-edge.ts`). */
export function hasFunctionalEdge(planSchema: SpaceMeta['typeSchemas']): boolean {
  return Object.values(planSchema?.edge ?? {}).some(type => (type as { functional?: boolean } | undefined)?.functional === true);
}

/** An edge operation that comes from a reifier, not from a bare statement: a bare edge's correlation is its triplet key, a JSON array. */
const isReifiedEdge = (op: RecordOp): boolean => op.kind === 'edge' && !op.correlation.startsWith('[');

/**
 * The bytes the shared read set of `edges` planned edges takes, when the plan shares it: what the door charges to its second phase. `sharing`: the
 * plan schema holds a functional edge label, or the file holds a reified edge.
 */
export const edgePlansCharged = (edges: number, sharing: boolean): number => (sharing ? edges * EDGE_PLAN_BYTES : 0);

/** The read set for each window of edge operations of one dry plan run, and the charge of what it keeps. */
export class EdgeReadSets {
  #shared: ReadSet | null = null;
  #sharing: boolean;

  /** `meter`: this run's room for what the dry plan holds (a fork of the second phase's meter, since an earlier run's read set is gone); `open`: makes a read set. */
  constructor(planSchema: SpaceMeta['typeSchemas'], private readonly meter: ImportMemoryMeter, private readonly open: () => ReadSet) {
    this.#sharing = hasFunctionalEdge(planSchema);
  }

  /** The read set to plan `ops` (the operations of one window) in: the shared one once the plan needs it, else a fresh one. */
  forWindow(ops: readonly RecordOp[]): ReadSet {
    if (!this.#sharing && ops.some(isReifiedEdge)) this.#sharing = true;
    if (!this.#sharing) return this.open();
    return (this.#shared ??= this.open());
  }

  /** `edges` edges of a window were planned in the read set {@link forWindow} gave: charged when it is the shared one, which keeps them. */
  planned(edges: number): void {
    if (this.#shared !== null) this.meter.charge(edges * EDGE_PLAN_BYTES);
  }
}
