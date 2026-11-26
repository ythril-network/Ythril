/**
 * The bind join that hands the quad source a hundred bindings at once (bundle-273, Q-764 S3; design-r2 R8).
 *
 * ## Why an actor of our own
 *
 * Comunica 5.5.0's bind join (`ActorRdfJoinMultiBind`) puts each binding of its small side into the large side's pattern and asks the
 * source for that one pattern; it keeps at most four such asks open (the `MultiTransformIterator` default, asynciterator.js:856). Over a
 * store, each ask is a find: a hundred bindings were a hundred round trips. The engine's other batching actor,
 * `ActorRdfJoinMultiBindSource` (blockSize 16), runs only when the source's selector shape accepts join bindings, and an RDF/JS source's
 * never does (`QuerySourceRdfJs` builds a fixed shape with no `joinBindings`; probed in S3, see the S3 return).
 *
 * This actor is that bind join with one change: its large side, when it is a single pattern read from a quad source of
 * `quad-source.ts`, is asked {@link BATCH_PATTERNS} bindings at a time through the source's batch reader ({@link batchMatcherOf}), which
 * answers a member read from its triple index with one find of `rdf_quads` and one of `rdf_terms`. It is offered to the engine beside the
 * stock actor, with the stock actor's own coefficients made cheaper by the batch, so the planner keeps every other choice it made.
 *
 * ## What it prevents
 *
 * - **A different answer.** Only a pattern whose terms are plain (no triple term holding a variable) is batched; the rows of each binding
 *   are matched against its own pattern (`quad-source.ts` filters by the bound terms) and merged into its own binding, a variable the
 *   pattern names twice must take one value, and a variable graph is bound to the member's graph. Anything else is left to the stock actor.
 * - **An error inside the engine's iterators.** The batch reader never rejects: a failed read is recorded as the query's refusal or defect,
 *   which the engine's reader asks when the result ends (`sparql-engine.ts` `recordedEnd`), as for a match stream.
 */
import { ActorRdfJoinMultiBind, type IActorRdfJoinMultiBindArgs, type IActorRdfJoinMultiBindTestSideData } from '@comunica/actor-rdf-join-inner-multi-bind';
import type { IActionRdfJoin, IActorRdfJoinOutputInner, IActorRdfJoinTestSideData } from '@comunica/bus-rdf-join';
import { failTest, passTestWithSideData, type TestResult } from '@comunica/core';
import type { IMediatorTypeJoinCoefficients } from '@comunica/mediatortype-join-coefficients';
import type { Bindings, BindingsStream } from '@comunica/types';
import type { Algebra } from '@comunica/utils-algebra';
import { ChunkedIterator } from '@comunica/utils-iterator';
import { getOperationSource } from '@comunica/utils-query-operation';
import type * as RDF from '@rdfjs/types';
import { BATCH_PATTERNS, batchMatcherOf, type BatchMatcher, type BoundPattern } from './quad-source.js';

/** The name the actor is known by in the engine's logs and plans. */
const ACTOR_NAME = 'urn:ythril:rdf-join/actors#inner-multi-bind-batch';
/** The most engine nodes the walk for the stock actor visits. */
const WALK_NODES_MAX = 1_000_000;

/** A term of a pattern: an RDF/JS term, a variable included. */
type PatternTerm = RDF.Term;

/** The large side of a join this actor batches: one pattern of a quad source of ours, with no triple term holding a variable. */
function batchedSide(operation: Algebra.Operation): { pattern: Algebra.Pattern; matcher: BatchMatcher } | null {
  if (operation.type !== 'pattern') return null;
  const pattern = operation as Algebra.Pattern;
  const matcher = batchMatcherOf(getOperationSource(operation)?.source.referenceValue);
  if (!matcher) return null;
  const nested = (t: PatternTerm): boolean => t.termType === 'Quad' && [t.subject, t.predicate, t.object, t.graph].some(x => x.termType === 'Variable' || nested(x));
  if ([pattern.subject, pattern.predicate, pattern.object, pattern.graph].some(nested)) return null;
  return { pattern, matcher };
}

/** A pattern term with the binding put in: a bound variable becomes its value, anything else stays. */
const bindTerm = (t: PatternTerm, b: Bindings): PatternTerm => (t.termType === 'Variable' ? b.get(t) ?? t : t);

/** The pattern of one binding as the source reads it: a variable or default graph is free (the engine runs in union default graph mode). */
function boundPattern(p: Algebra.Pattern, b: Bindings): BoundPattern {
  const [s, pr, o, g] = [p.subject, p.predicate, p.object, p.graph].map(t => bindTerm(t, b));
  const slot = (t: PatternTerm | undefined): BoundPattern[number] => (t === undefined || t.termType === 'Variable' || t.termType === 'DefaultGraph' ? undefined : t);
  return [slot(s), slot(pr), slot(o), slot(g)];
}

/** `left` with the variables of `pattern` bound from `quad`, or null when a variable the pattern names twice would take two values. */
function merged(left: Bindings, pattern: Algebra.Pattern, quad: RDF.Quad): Bindings | null {
  let out = left;
  const pairs: Array<[PatternTerm, RDF.Term]> = [[pattern.subject, quad.subject], [pattern.predicate, quad.predicate], [pattern.object, quad.object]];
  if (pattern.graph.termType === 'Variable') pairs.push([pattern.graph, quad.graph]);
  for (const [term, value] of pairs) {
    if (term.termType !== 'Variable') continue;
    const had = out.get(term);
    if (had === undefined) out = out.set(term, value);
    else if (!had.equals(value)) return null;
  }
  return out;
}

/** The rows of one chunk of the small side: each binding's pattern read in one batch, merged into its binding. */
async function joinChunk(chunk: readonly Bindings[], pattern: Algebra.Pattern, matcher: BatchMatcher): Promise<Bindings[]> {
  const found = await matcher.matchBatch(chunk.map(b => boundPattern(pattern, b)));
  const out: Bindings[] = [];
  chunk.forEach((b, i) => {
    for (const quad of found[i] ?? []) {
      const row = merged(b, pattern, quad);
      if (row) out.push(row);
    }
  });
  return out;
}

/** The stock bind join, batching its large side when that side is one pattern of a quad source of ours. */
export class BatchBindJoin extends ActorRdfJoinMultiBind {
  override async getJoinCoefficients(action: IActionRdfJoin, sideData: IActorRdfJoinTestSideData): Promise<TestResult<IMediatorTypeJoinCoefficients, IActorRdfJoinMultiBindTestSideData>> {
    const stock = await super.getJoinCoefficients(action, sideData);
    if (stock.isFailed()) return stock;
    const side = stock.getSideData();
    const rest = side.entriesSorted.slice(1);
    if (rest.length !== 1 || !batchedSide(rest[0]!.operation)) return failTest(`Actor ${this.name} batches only a single pattern of a Ythril quad source`);
    const c = stock.get();
    // One ask per batch instead of one per binding: the stock costs, the per-binding parts divided by the batch.
    return passTestWithSideData({ ...c, iterations: c.iterations / BATCH_PATTERNS, requestTime: c.requestTime / BATCH_PATTERNS }, side);
  }

  override async getOutput(action: IActionRdfJoin, sideData: IActorRdfJoinMultiBindTestSideData): Promise<IActorRdfJoinOutputInner> {
    const entries = sideData.entriesSorted;
    const side = batchedSide(entries[1]!.operation);
    if (!side) return super.getOutput(action, sideData);
    entries[1]!.output.bindingsStream.destroy();
    const chunks = new ChunkedIterator<Bindings>(entries[0]!.output.bindingsStream, BATCH_PATTERNS, { autoStart: false });
    // Each chunk is an iterator over at most BATCH_PATTERNS bindings of the small side (`ChunkedIterator`), read whole and joined in one
    // batch; `joinChunk` never rejects (the batch reader records a failed read as the query's), so `done` always follows.
    const bindingsStream: BindingsStream = chunks.transform<Bindings>({
      autoStart: false,
      transform: (chunk, done, push) => {
        chunk.toArray()
          .then(rows => joinChunk(rows, side.pattern, side.matcher))
          .then((rows) => { for (const row of rows) push(row); done(); }, () => done());
      },
    });
    return {
      result: {
        type: 'bindings',
        bindingsStream,
        metadata: () => this.constructResultMetadata(entries, entries.map(e => e.metadata), action.context),
      },
      physicalPlanMetadata: { bindIndex: sideData.entriesUnsorted.indexOf(entries[0]!), bindOrder: 'batch' },
    };
  }
}

/**
 * Offer {@link BatchBindJoin} to `engine` beside its stock bind join, with the stock actor's settings and bus: found by walking the engine's
 * object graph for the one `ActorRdfJoinMultiBind`. Throws when there is none (an engine update that renamed it must be seen, not run
 * unbatched in silence). Called once per engine.
 */
export function offerBatchBindJoin(engine: object): BatchBindJoin {
  const stock = findStockBindJoin(engine);
  if (!stock) throw new Error('The SPARQL engine has no stock bind join to batch beside: the engine changed under the batched join');
  const args: IActorRdfJoinMultiBindArgs = {
    name: ACTOR_NAME, bus: stock.bus, mediatorJoinSelectivity: stock.mediatorJoinSelectivity,
    bindOrder: stock.bindOrder, selectivityModifier: stock.selectivityModifier, minMaxCardinalityRatio: stock.minMaxCardinalityRatio,
    subQueryCost: stock.subQueryCost, lookupCost: stock.lookupCost, mediatorJoinEntriesSort: stock.mediatorJoinEntriesSort,
    mediatorQueryOperation: stock.mediatorQueryOperation, mediatorMergeBindingsContext: stock.mediatorMergeBindingsContext,
  };
  // The actor subscribes itself to the bus in its constructor (as every Comunica actor does).
  return new BatchBindJoin(args);
}

/** The engine's stock bind join, or null. */
function findStockBindJoin(root: object): ActorRdfJoinMultiBind | null {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0 && seen.size < WALK_NODES_MAX) {
    const node = stack.pop();
    if (typeof node !== 'object' || node === null || seen.has(node)) continue;
    seen.add(node);
    if (node instanceof ActorRdfJoinMultiBind && !(node instanceof BatchBindJoin)) return node;
    for (const value of Object.values(node)) if (typeof value === 'object' && value !== null) stack.push(value);
  }
  return null;
}
