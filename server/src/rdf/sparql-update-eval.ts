/**
 * The evaluation of a SPARQL Update into its change set: the statements it removes and inserts in its one space, decided before anything is
 * planned or written (bundle-272, Q-965; design f, r2 R5, R11, vet-1 S1, S4, S6, vet-2 S8). The Update's act (Q-761) plans and commits
 * what this answers; nothing here writes a record.
 *
 * ## How an Update is evaluated
 *
 * The text is checked by the engine's update check ({@link checkSparqlUpdateAlgebra}). A composite (`;`) runs part by part
 * ({@link changeSetOf}): each part reads the space's quad source with the change set of the parts before it laid over it (what they removed
 * is gone, what they inserted is there), writes into a fresh {@link ChangeSetStore}, and is folded into the Update's change set after it
 * ran. One quad source serves every part, so its read cap, its deadline and its record of seqs span the whole Update.
 *
 * ## What it prevents
 *
 * - **A read outside the one space, or past the caller's rights.** The source is the space the Update changes and no other (`members`
 *   `[spaceId]`), read for the caller exactly as a query is: without `files: read` the file kind is never read, so an Update cannot copy a
 *   file's statements into a record ({@link SparqlUpdateChanges.filesWithheld} says so).
 * - **A part that reads its own writes, or misses an earlier part's.** Each part writes where it does not read, and reads every part before
 *   it (Comunica runs a composite's parts over one source and one destination, where a later part would not see an earlier part's changes
 *   unless the source layered them).
 * - **A conclusion drawn from a record that changed under the evaluation.** The change set carries every record read with its seq, and the
 *   source's lost race: a record read at two seqs ({@link SparqlUpdateChanges.lostRace}).
 * - **A removal of what the Update itself made.** A statement an earlier part inserted and a later part deletes is taken back, and counted
 *   as removed only when the space holds it ({@link ChangeSetStore.fold}).
 *
 * Comunica evaluates a DELETE/INSERT's WHERE once: the bindings are cloned to both templates (`ActorQueryOperationUpdateDeleteInsert`), and
 * the DELETE is handed to the destination before the INSERT.
 */
import { Readable } from 'node:stream';
import type * as N3 from 'n3';
import { graphIri } from './term-iri.js';
import { rdfMembers } from './rdf-members.js';
import { createQuadSource, type LostRace, type ReadRecord } from './quad-source.js';
import { CHANGE_SET_MAX_BYTES, CHANGE_SET_MAX_QUADS, ChangeMeter, ChangeSetStore } from './change-set-store.js';
import {
  checkSparqlUpdateAlgebra, recordedEnd, runSparqlUpdatePart, type SparqlAlgebra, type SparqlCheckRefusal, type SparqlUpdateDataset,
} from './sparql-engine.js';
import type { FingerprintOf, RdfCaller } from './rdf-space-state.js';

/** The source an Update reads: an RDF/JS source (the quad source), and what it recorded of a failed read when it has that. */
export interface UpdateSource {
  match(s?: unknown, p?: unknown, o?: unknown, g?: unknown): Readable;
  countQuads?(s?: unknown, p?: unknown, o?: unknown, g?: unknown): Promise<number> | number;
}

export interface ChangeSetOptions {
  /** When the evaluation must be done, in epoch milliseconds: every part runs inside it. */
  deadline: number;
  /** Ends the evaluation when the caller goes away. */
  signal?: AbortSignal;
  /** The most statements the change set takes ({@link CHANGE_SET_MAX_QUADS} when absent). */
  maxQuads?: number;
  /** The most bytes of statements the change set takes ({@link CHANGE_SET_MAX_BYTES} when absent). */
  maxBytes?: number;
}

/** What an Update removes and inserts, in the space's graph, and how many parts it ran. */
export interface SparqlChangeSet { removed: N3.Quad[]; inserted: N3.Quad[]; parts: number }

/** An evaluated Update: its change set, every record it read with its seq, its lost race, and what its caller could not read. */
export interface SparqlUpdateChanges extends SparqlChangeSet {
  reads: ReadRecord[];
  lostRace: LostRace | null;
  recordsRead: number;
  /** The caller holds no `files: read` in the space, so no file statement was read. */
  filesWithheld: boolean;
}

/** The parts of a checked Update, in order: a composite's updates, or the one operation. */
function partsOf(algebra: SparqlAlgebra): SparqlAlgebra[] {
  const root = algebra as unknown as { type?: string; updates?: SparqlAlgebra[] };
  return root.type === 'compositeupdate' && Array.isArray(root.updates) ? root.updates : [algebra];
}

/** Does `source` hold `q`? One read, its stream let go at the first statement; a read that failed is the evaluation's failure. */
async function isStored(source: UpdateSource, q: N3.Quad): Promise<boolean> {
  const statements = source.match(q.subject, q.predicate, q.object, q.graph)[Symbol.asyncIterator]();
  const first = await statements.next();
  await statements.return?.();
  const found = first.done !== true;
  const failed = recordedEnd(source);
  if (failed) throw failed.error;
  return found;
}

/** `source` with `changes` laid over it: a statement they removed is gone, one they inserted is there, once. */
function layered(source: UpdateSource, changes: ChangeSetStore): UpdateSource & { failure?: () => unknown; defect?: () => unknown } {
  const base = source as UpdateSource & { failure?: () => unknown; defect?: () => unknown };
  return {
    match(s, p, o, g) {
      const read = source.match(s, p, o, g);
      const own = changes.insertedMatching(s, p, o, g);
      async function* statements(): AsyncGenerator<unknown, void, undefined> {
        for await (const q of read) if (!changes.removes(q as N3.Quad) && !changes.inserts(q as N3.Quad)) yield q;
        yield* own;
      }
      const out = Readable.from(statements());
      // As the quad source's own streams: an error raised after the engine let go of this stream reaches no process handler.
      out.on('error', () => undefined);
      return out;
    },
    async countQuads(s, p, o, g) {
      const counted = base.countQuads ? await base.countQuads(s, p, o, g) : 1;
      return counted + changes.insertedMatching(s, p, o, g).length;
    },
    ...(base.failure ? { failure: () => base.failure!() } : {}),
    ...(base.defect ? { defect: () => base.defect!() } : {}),
  };
}

/**
 * The change set of the checked Update `algebra` (from {@link checkSparqlUpdateAlgebra}) over `source`, in the space's graph `ownGraph`:
 * part by part, each reading the source and the parts before it, bounded by one meter and one deadline.
 */
export async function changeSetOf(algebra: SparqlAlgebra, source: UpdateSource, ownGraph: string, opts: ChangeSetOptions): Promise<SparqlChangeSet> {
  const parts = partsOf(algebra);
  const meter = new ChangeMeter(opts.maxQuads ?? CHANGE_SET_MAX_QUADS, opts.maxBytes ?? CHANGE_SET_MAX_BYTES);
  const total = new ChangeSetStore({ graph: ownGraph, meter });
  for (const part of parts) {
    const destination = new ChangeSetStore({ graph: ownGraph, meter });
    await runSparqlUpdatePart(part, total.isEmpty() ? source : layered(source, total), destination, opts);
    await total.fold(destination, (q) => isStored(source, q));
  }
  return { removed: total.removed(), inserted: total.inserted(), parts: parts.length };
}

/**
 * Evaluate the Update `text` for `scope` (the one space it changes and its caller, as the door's guard accepted them): its change set, or
 * the refusal of its text. A space that is not read as RDF answers the refusal the export answers for it; a bound or a failed read throws
 * its SPARQL refusal, as a query's does.
 */
export async function evaluateSparqlUpdate(
  text: string,
  scope: { spaceId: string; caller: RdfCaller | undefined; fingerprintOf?: FingerprintOf },
  opts: ChangeSetOptions & { maxRecordsRead?: number; using?: SparqlUpdateDataset },
): Promise<{ refusal: SparqlCheckRefusal } | { changes: SparqlUpdateChanges }> {
  const resolved = rdfMembers([scope.spaceId], scope.caller, scope.fingerprintOf);
  const { members, leftOut } = resolved;
  const member = members[0];
  if (!member) {
    const out = leftOut[0];
    // The door's guard admits only a space its caller reads: one that is neither read nor left out is the door's defect, never an empty read.
    if (!out) throw new Error('The space an Update changes is not one its caller reads');
    return { refusal: { status: out.status, code: out.code, error: out.error } };
  }
  const ownGraph = graphIri(member.meta);
  const checked = await checkSparqlUpdateAlgebra(text, ownGraph, opts.using);
  if ('refusal' in checked) return checked;
  const source = createQuadSource(
    // The member resolved above is reused, never resolved again (Q-976).
    { members: [scope.spaceId], caller: scope.caller, ...(scope.fingerprintOf ? { fingerprintOf: scope.fingerprintOf } : {}), resolved },
    // An Update plans on the records and seqs it read (`readRecords`, `lostRace`), so it is evaluated over the records, never the index.
    { deadline: opts.deadline, index: false, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.maxRecordsRead !== undefined ? { maxRecordsRead: opts.maxRecordsRead } : {}) },
  );
  const changes = await changeSetOf(checked.algebra, source as unknown as UpdateSource, ownGraph, opts);
  return {
    changes: {
      ...changes, reads: source.readRecords(), lostRace: source.lostRace(), recordsRead: source.recordsRead(), filesWithheld: source.filesWithheld().length > 0,
    },
  };
}
