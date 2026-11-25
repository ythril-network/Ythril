/**
 * The record form's terms (`literals.ts`) to RDF/JS terms and back (bundle-271, Q-756, design §1.1): the quad source hands the engine RDF/JS
 * quads, and a CONSTRUCT answer's RDF/JS quads come back to the record form for the writer (`serialize.ts`, r2 R3.2).
 *
 * ## What it prevents
 *
 * - **Two conversions that disagree.** A triple term becomes an RDF/JS `Quad` in object position (in the default graph, as RDF/JS states a
 *   quoted triple), a language literal with a direction keeps it, an `xsd:string` literal is a plain one both ways, so a statement read by
 *   the source and written back by a graph answer is the statement the export writes.
 * - **A term the model cannot hold passing silently.** A list (no RDF term of its own), a variable or a blank node as a predicate throw
 *   {@link RdfJsTermError}: the mapper never writes one, and an engine answer that holds one is a fault to see, never a statement to write.
 *
 * Not the import's reader: `parse.ts` converts a stranger's file under its bounds and with its refusals, a different question.
 */
import { DataFactory } from 'n3';
import type * as N3 from 'n3';
import { xsd, type BlankTerm, type IriTerm, type LiteralTerm, type Quad, type Term, type TripleTerm } from './literals.js';

const { namedNode, blankNode, literal, quad, defaultGraph } = DataFactory;

/** A term the record form cannot hold, or an RDF/JS term the conversion does not take. */
export class RdfJsTermError extends Error {
  constructor(message: string) { super(message); this.name = 'RdfJsTermError'; }
}

/** An RDF/JS term in subject or object position: an RDF 1.2 triple term is a `Quad` there. */
export type RdfJsTerm = N3.Term | N3.Quad;

/**
 * A term in object (or subject) position as n3's factory types it: `@types/n3` predates RDF 1.2 and leaves the triple term out of
 * `Quad_Object`, which n3 itself takes (the export's reader parses one), so a triple term is handed over as one.
 */
const asObject = (t: RdfJsTerm): N3.Quad_Object => t as unknown as N3.Quad_Object;
const asSubject = (t: RdfJsTerm): N3.Quad_Subject => t as unknown as N3.Quad_Subject;

/** The RDF/JS form of a record term. */
export function toRdfJsTerm(t: Term): RdfJsTerm {
  switch (t.kind) {
    case 'iri': return namedNode(t.value);
    case 'blank': return blankNode(t.id);
    case 'literal': {
      // A direction travels in the tag as the record form holds it (`en--rtl`): the mapper writes no language literal, and n3's factory
      // takes the tag whole.
      if (t.language !== undefined) return literal(t.value, t.language);
      return t.datatype === undefined || t.datatype === xsd('string') ? literal(t.value) : literal(t.value, namedNode(t.datatype));
    }
    case 'triple': return quad(asSubject(toRdfJsTerm(t.subject)), namedNode(t.predicate.value), asObject(toRdfJsTerm(t.object)), defaultGraph());
    default: throw new RdfJsTermError(`a ${t.kind} has no RDF/JS term`);
  }
}

/** The RDF/JS quad of a record quad, in the graph `graph` names (or the quad's own, or the default graph). */
export function toRdfJs(q: Quad, graph?: string): N3.Quad {
  const g = graph ?? q.graph?.value;
  return quad(asSubject(toRdfJsTerm(q.subject)), namedNode(q.predicate.value), asObject(toRdfJsTerm(q.object)), g === undefined ? defaultGraph() : namedNode(g));
}

/**
 * The part of an RDF/JS term the conversions read: what a SPARQL engine's row holds, and what the quad source's stream yields, typed once so no
 * door casts at the boundary.
 */
export interface RdfJsLike {
  termType: string;
  value: string;
  language?: string;
  direction?: string;
  datatype?: { value: string };
  subject?: RdfJsLike; predicate?: RdfJsLike; object?: RdfJsLike; graph?: RdfJsLike;
}

/** The record term of an RDF/JS term. */
export function fromRdfJsTerm(t: RdfJsLike): Term {
  switch (t.termType) {
    case 'NamedNode': return { kind: 'iri', value: t.value } satisfies IriTerm;
    case 'BlankNode': return { kind: 'blank', id: t.value } satisfies BlankTerm;
    case 'Literal': {
      if (t.language) return { kind: 'literal', value: t.value, language: t.direction ? `${t.language}--${t.direction}` : t.language } satisfies LiteralTerm;
      const datatype = t.datatype?.value;
      return datatype === undefined || datatype === xsd('string') ? { kind: 'literal', value: t.value } : { kind: 'literal', value: t.value, datatype };
    }
    case 'Quad': {
      const subject = fromRdfJsTerm(t.subject!);
      const predicate = fromRdfJsTerm(t.predicate!);
      if (subject.kind !== 'iri' && subject.kind !== 'blank') throw new RdfJsTermError('a triple term as the subject of a triple term');
      if (predicate.kind !== 'iri') throw new RdfJsTermError('a predicate that is no IRI');
      return { kind: 'triple', subject, predicate, object: fromRdfJsTerm(t.object!) } satisfies TripleTerm;
    }
    default: throw new RdfJsTermError(`a ${t.termType} is no term of a statement`);
  }
}

/** The record quad of an RDF/JS quad; its graph is kept when it is a named one. */
export function fromRdfJs(q: RdfJsLike): Quad {
  const subject = fromRdfJsTerm(q.subject!);
  const predicate = fromRdfJsTerm(q.predicate!);
  if (subject.kind !== 'iri' && subject.kind !== 'blank') throw new RdfJsTermError('a triple term as the subject of a statement');
  if (predicate.kind !== 'iri') throw new RdfJsTermError('a predicate that is no IRI');
  const object = fromRdfJsTerm(q.object!);
  const g = q.graph;
  if (!g || g.termType === 'DefaultGraph') return { subject, predicate, object };
  if (g.termType !== 'NamedNode') throw new RdfJsTermError('a graph name that is no IRI');
  return { subject, predicate, object, graph: { kind: 'iri', value: g.value } };
}
