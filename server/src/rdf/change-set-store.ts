/**
 * The change set of a SPARQL Update: the statements it removes and the statements it inserts, held in memory and never written to a record
 * (bundle-272, Q-965; design f, vet-1 S1). The engine writes an Update's DELETE and INSERT into it as into any RDF/JS store
 * (`RdfJsQuadDestination`: `remove`, then `import`); the planner reads what it holds.
 *
 * ## What it prevents
 *
 * - **A change set that grows without a bound.** A cross-product INSERT writes rows times rows statements from a read that stayed under its
 *   own cap. Every statement that arrives is counted by the Update's one {@link ChangeMeter}, in statements and in bytes, and the one past
 *   either cap ends the write with `413 sparql_too_many_changes`: its stream is destroyed, and nothing of the Update is answered.
 * - **A write outside the space.** A statement in a graph other than the space's own is refused `400 sparql_graph_management_refused`; a
 *   statement with no graph is the space's. `deleteGraph` and `removeMatches` (CLEAR, DROP and their kin) refuse: the store never empties a
 *   graph.
 * - **A part that reads its own writes.** The store records; it is no source. A composite's part writes into a store of its own, folded
 *   into the Update's afterwards ({@link ChangeSetStore.fold}), so no part sees what it writes while it reads.
 * - **An error event nobody listens for.** The emitter an `import` or a `remove` answers carries a listener of its own from construction;
 *   the engine's listener is told the refusal, and a refusal raised after the engine let go reaches no process handler.
 *
 * Also the leaf that names the update path's refusal codes, so the engine's update check and this store share them with no import cycle.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { DataFactory, Store } from 'n3';
import type * as N3 from 'n3';
import { termBytes } from './answer-size.js';
import { SPARQL_BAD_REQUEST, SPARQL_TOO_LARGE, SparqlRefusal } from './sparql-refusal.js';

export const SPARQL_TOO_MANY_CHANGES = 'sparql_too_many_changes';
export const SPARQL_GRAPH_MANAGEMENT_REFUSED = 'sparql_graph_management_refused';
export const SPARQL_NOT_AN_UPDATE = 'sparql_not_an_update';

/** Every code the update path answers on its own account (the query path's codes it shares are `SPARQL_REFUSAL_CODES`). */
export const SPARQL_UPDATE_REFUSAL_CODES: readonly string[] = Object.freeze([SPARQL_TOO_MANY_CHANGES, SPARQL_GRAPH_MANAGEMENT_REFUSED, SPARQL_NOT_AN_UPDATE]);

/** The most statements one Update's change set takes, removed and inserted together, counted as they arrive. */
export const CHANGE_SET_MAX_QUADS = 50_000;
/** The most bytes of term values one Update's change set takes (the write group's byte ceiling). */
export const CHANGE_SET_MAX_BYTES = 32 * 1024 * 1024;

/** The refusal of an Update that changes a graph, or a graph other than the space's. */
export const graphManagementRefusal = (what: string): SparqlRefusal => new SparqlRefusal(SPARQL_BAD_REQUEST, SPARQL_GRAPH_MANAGEMENT_REFUSED,
  `${what} is not offered: an Update changes the statements of its own space's graph only, never a graph as a whole or another graph`);

/** The refusal of a change set past a cap; it names the cap, never a statement. */
const tooManyChangesRefusal = (bound: string): SparqlRefusal => new SparqlRefusal(SPARQL_TOO_LARGE, SPARQL_TOO_MANY_CHANGES,
  `The Update changes more than ${bound}, so nothing of it is answered: narrow its WHERE or split it`);

/** One Update's count of the statements its change set took, in statements and bytes: {@link ChangeMeter.add} throws past either cap. */
export class ChangeMeter {
  private quads = 0;
  private bytes = 0;
  constructor(private readonly maxQuads: number, private readonly maxBytes: number) {}
  /** Count one statement more; throws `413 sparql_too_many_changes` when the count or the bytes pass their cap. */
  add(q: N3.Quad): void {
    this.quads++;
    this.bytes += termBytes(q);
    if (this.quads > this.maxQuads) throw tooManyChangesRefusal(`${this.maxQuads} statements`);
    if (this.bytes > this.maxBytes) throw tooManyChangesRefusal(`${this.maxBytes} bytes of statements`);
  }
}

/** What an engine hands `import` and `remove`: a stream of quads it can be told to stop. */
interface QuadStream {
  on(event: string, listener: (arg: unknown) => void): unknown;
  destroy?(cause?: Error): void;
}

/** A slot of a match as an engine hands it: an RDF/JS term, or nothing; read only through {@link storeSlot}. */
type Slot = unknown;

/** A slot of a match as the n3 store takes it: unbound (nothing, a variable, a triple term with one inside, the union default graph) is null. */
function storeSlot(t: Slot, graph = false): N3.Term | null {
  if (t === null || typeof t !== 'object') return null;
  const termType = (t as { termType?: unknown }).termType;
  if (typeof termType !== 'string' || termType === 'Variable') return null;
  if (graph && termType === 'DefaultGraph') return null;
  if (termType === 'Quad' && hasVariable(t)) return null;
  return t as N3.Term;
}

function hasVariable(t: unknown): boolean {
  if (t === null || typeof t !== 'object') return false;
  const term = t as { termType?: string; subject?: unknown; predicate?: unknown; object?: unknown };
  if (term.termType === 'Variable') return true;
  return term.termType === 'Quad' && (hasVariable(term.subject) || hasVariable(term.predicate) || hasVariable(term.object));
}

/**
 * An RDF/JS store that records an Update's changes in the space's graph `graph`: what `remove` is handed is removed, what `import` is handed
 * is inserted, in that order of arrival, an insert taking back an earlier removal of the same statement. Every arrival is counted by `meter`.
 */
export class ChangeSetStore {
  private readonly removedStore = new Store();
  private readonly insertedStore = new Store();
  private readonly graph: N3.NamedNode;
  private readonly meter: ChangeMeter;
  private ended: Error | null = null;

  constructor(opts: { graph: string; meter: ChangeMeter }) {
    this.graph = DataFactory.namedNode(opts.graph);
    this.meter = opts.meter;
  }

  /** The statements inserted that fit the pattern (the store's content, as an RDF/JS source reads it). */
  match(s?: Slot, p?: Slot, o?: Slot, g?: Slot): Readable {
    return Readable.from(this.insertedMatching(s, p, o, g));
  }

  /** The statements inserted that fit the pattern, at once. */
  insertedMatching(s?: Slot, p?: Slot, o?: Slot, g?: Slot): N3.Quad[] {
    return this.insertedStore.getQuads(storeSlot(s), storeSlot(p), storeSlot(o), storeSlot(g, true));
  }

  /** Record the statements of `stream` as removed. */
  remove(stream: QuadStream): EventEmitter { return this.consume(stream, (q) => this.applyRemove(q)); }

  /** Record the statements of `stream` as inserted. */
  import(stream: QuadStream): EventEmitter { return this.consume(stream, (q) => this.applyInsert(q)); }

  /** Refused: an Update never empties a graph (CLEAR, DROP, MOVE). */
  deleteGraph(_graph?: unknown): never { throw graphManagementRefusal('Emptying a graph'); }

  /** Refused: an Update removes the statements its DELETE names, never every statement of a pattern. */
  removeMatches(..._pattern: unknown[]): never { throw graphManagementRefusal('Removing every statement of a pattern'); }

  removed(): N3.Quad[] { return this.removedStore.getQuads(null, null, null, null); }
  inserted(): N3.Quad[] { return this.insertedStore.getQuads(null, null, null, null); }
  isEmpty(): boolean { return this.removedStore.size === 0 && this.insertedStore.size === 0; }
  /** Is `q` (in the space's graph) recorded as removed? */
  removes(q: N3.Quad): boolean { return has(this.removedStore, q); }
  /** Is `q` (in the space's graph) recorded as inserted? */
  inserts(q: N3.Quad): boolean { return has(this.insertedStore, q); }

  /** End every write still to come with `cause` (the deadline's, the caller's): the next statement that arrives destroys its stream. */
  end(cause: Error): void { this.ended ??= cause; }

  /**
   * Fold a part's store in after the part ran: its removals, then its inserts. A removal of a statement an earlier part inserted takes
   * that insert back, and is recorded as removed only when `stored` says the source holds it too (a statement the Update made and then
   * took back was never stored, and is no removal).
   */
  async fold(part: ChangeSetStore, stored: (q: N3.Quad) => Promise<boolean>): Promise<void> {
    for (const q of part.removed()) {
      if (has(this.insertedStore, q)) {
        this.insertedStore.removeQuad(q);
        if (await stored(q)) this.removedStore.addQuad(q);
        continue;
      }
      this.removedStore.addQuad(q);
    }
    for (const q of part.inserted()) this.applyInsert(q);
  }

  /** `q` in the space's graph; a statement naming another graph is refused. */
  private own(q: N3.Quad): N3.Quad {
    const g = q.graph;
    if (g.termType === 'DefaultGraph' || (g.termType === 'NamedNode' && g.value === this.graph.value)) {
      return DataFactory.quad(q.subject, q.predicate, q.object, this.graph);
    }
    throw graphManagementRefusal('A statement in another graph');
  }

  private applyRemove(q: N3.Quad): void {
    const own = this.own(q);
    if (has(this.insertedStore, own)) this.insertedStore.removeQuad(own);
    this.removedStore.addQuad(own);
  }

  private applyInsert(q: N3.Quad): void {
    const own = this.own(q);
    if (has(this.removedStore, own)) this.removedStore.removeQuad(own);
    this.insertedStore.addQuad(own);
  }

  /** Read `stream` into `apply`, each statement counted first; the first refusal destroys the stream and is the emitter's error. */
  private consume(stream: QuadStream, apply: (q: N3.Quad) => void): EventEmitter {
    const out = new EventEmitter();
    out.on('error', () => undefined);
    let done = false;
    const finish = (err?: unknown): void => {
      if (done) return;
      done = true;
      if (err === undefined) { out.emit('end'); return; }
      stream.destroy?.();
      out.emit('error', err);
    };
    stream.on('data', (item) => {
      if (done) return;
      try {
        if (this.ended) throw this.ended;
        const q = item as N3.Quad;
        this.meter.add(q);
        apply(q);
      } catch (err) {
        finish(err);
      }
    });
    stream.on('end', () => finish());
    stream.on('error', (err) => finish(err ?? new Error('The statement stream failed')));
    return out;
  }
}

const has = (store: Store, q: N3.Quad): boolean => store.countQuads(q.subject, q.predicate, q.object, q.graph) > 0;
