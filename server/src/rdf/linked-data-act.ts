/**
 * What a Linked Data address reads, apart from how it is answered (bundle-271, Q-758; lens-2 A1): the space an address belongs to, a record's
 * statements and the question whether a type is in use, run over the quad source in a slot. `api/linked-data.ts` keeps the HTTP: the routes,
 * the rights guards, the content negotiation and the problem bodies.
 *
 * ## What it prevents
 *
 * - **Business logic in a route.** The reads and their bounds (the cap on statements, the half of an answer that is cut, the slot, the
 *   deadline) are decided here and can be driven without a response; the route puts the outcome on its wire.
 * - **A read outside the caller's scope.** Every read goes through the quad source of the one space the address resolved to, with the caller's
 *   rights (the source withholds a file's statements from a member read without `files: read`).
 * - **A slot held past the read.** Every ending (an answer, a refusal, a caller that left, a failure) releases the slot.
 * - **A refusal that tells more than the code.** A bound or a store failure comes back as a {@link LdRefusal} with its code and a fixed
 *   sentence; the address is in none of it.
 * - **A read that outlives its client.** The `signal` ends the read; the outcome is then `gone`, and nothing is answered.
 */
import type { Readable } from 'node:stream';
import { DataFactory } from 'n3';
import { getConfig } from '../config/loader.js';
import { sparqlLimits } from '../config/sparql-limits.js';
import { mayReadArea } from '../auth/reachable-spaces.js';
import type { TokenRights } from '../config/rights-shape.js';
import { takeSlot } from '../util/slots.js';
import { schemaFingerprintOf } from '../spaces/schema-stamp.js';
import { createQuadSource, type QuadSource } from './quad-source.js';
import { addressNames, recordOfAddress, termOfIri } from './term-reverse.js';
import { fromRdfJs, type RdfJsLike } from './rdf-js-terms.js';
import type { RdfMember } from './rdf-members.js';
import type { Quad } from './literals.js';
import type { UsedType } from './schema-export-act.js';
import { namesOf, resolveTermIri, type TermKind } from './term-iri.js';
import type { RdfCaller } from './rdf-space-state.js';
import { ByteMeter, termBytes } from './answer-size.js';
import {
  busyRefusal, sparqlRefusalOf, SPARQL_TOO_LARGE, SPARQL_TOO_MANY_RESULTS, SPARQL_TOO_MUCH_READ, SPARQL_TIMEOUT, SPARQL_ANSWER_TOO_LARGE,
} from './sparql-refusal.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** The kinds `readStatements` answers: a record kind, a file, an agent. */
export type LdStatementsKind = 'entity' | 'fact' | 'chrono' | 'edge' | 'file' | 'agent';

/** A refusal of a read: its status, a short title, its code and the sentence; the wait of a 503. Names no address. */
export interface LdRefusal { status: number; title: string; code: string; detail: string; retryAfterSeconds?: number }

/** What a read ended as. */
export type LdOutcome<T> = ({ answer: 'read' } & T) | { answer: 'not-found' } | { answer: 'refused'; refusal: LdRefusal } | { answer: 'gone' };

/** The space with RDF on whose base is the longest start of `address`, or null. */
export function spaceOfAddress(address: string): string | null {
  let best: { id: string; base: string } | null = null;
  for (const s of getConfig().spaces) {
    const rdf = s.meta?.rdf;
    if (rdf?.enabled !== true || typeof rdf.base !== 'string' || rdf.base === '' || !address.startsWith(rdf.base)) continue;
    if (best === null || rdf.base.length > best.base.length) best = { id: s.id, base: rdf.base };
  }
  return best?.id ?? null;
}

/**
 * At most `limit` quads of a match that `keep` admits, and whether there were more of them; the stream is closed either way. A quad `keep`
 * refuses is neither counted nor answered, so the cap and the "more" are about the statements the answer would carry.
 */
export async function takeStatements(source: QuadSource, stream: Readable, limit: number, keep: (q: RdfJsLike) => boolean = () => true, meter?: ByteMeter): Promise<{ quads: RdfJsLike[]; more: boolean }> {
  const quads: RdfJsLike[] = [];
  for await (const q of stream as AsyncIterable<RdfJsLike>) {
    if (!keep(q)) continue;
    if (quads.length >= limit) return { quads, more: true };
    // The bytes of what is kept, counted as it is read: the meter throws `sparql_answer_too_large` past `sparql.maxResultBytes`.
    meter?.add(termBytes(q));
    quads.push(q);
  }
  // A read the source failed ends its stream with no error: the failure is the source's to tell, and a short read is no whole one.
  throwWhenFailed(source);
  return { quads, more: false };
}

/** Throw the refusal the source recorded for its query, if any: a stream that ended is the whole read only when this does not throw. */
function throwWhenFailed(source: QuadSource): void {
  const failed = source.failure();
  if (failed) throw failed;
  const defect = source.defect();
  if (defect) throw defect.error;
}

/** A statement in the default graph: an address's answer describes one resource, in one graph. */
const statementOf = (q: RdfJsLike): Quad => {
  const { subject, predicate, object } = fromRdfJs(q);
  return { subject, predicate, object };
};

/** The refusal a bound or the store answered, as a Linked Data refusal; null for an error nothing here names. */
function refusalOfError(err: unknown): LdRefusal | null {
  const named = sparqlRefusalOf(err);
  if (!named) return null;
  return {
    status: named.status, title: 'Not answered', code: named.code, detail: named.message,
    ...(named.retryAfterSeconds !== undefined ? { retryAfterSeconds: named.retryAfterSeconds } : {}),
  };
}

/** The busy answer of a read whose slot is spent. */
function busyOutcome(): { answer: 'refused'; refusal: LdRefusal } {
  const { status, code, error, retryAfterSeconds } = busyRefusal('sparql');
  return { answer: 'refused', refusal: { status, title: 'Busy', code, detail: error, retryAfterSeconds } };
}

/** What the read of a record, a file or an agent needs. */
export interface StatementsInput {
  /** The absolute address asked for. */
  address: string;
  /** The space whose base holds it, and its member read for this caller. */
  space: string;
  member: RdfMember;
  kind: LdStatementsKind;
  caller: RdfCaller | undefined;
  /** Who the slot counts against (`http/read-caller.ts`). */
  callerKey: string;
  /** Aborts when the caller goes away. */
  signal: AbortSignal;
}

/**
 * The statements of a record, a file or an agent (`kind`), read from the quad source: every statement about the address (a chrono entry's time
 * nodes too), then those pointing at it up to `sparql.maxResults` together. A record whose own statements pass the cap is refused
 * (`sparql_too_many_results`); the pointing half stops at the cap, the records read or the deadline, and `truncated` says so.
 */
export async function readStatements(input: StatementsInput): Promise<LdOutcome<{ id: string; statements: Quad[]; truncated: boolean }>> {
  const { address, space, member, kind } = input;
  const read = recordOfAddress(address, addressNames(member.meta));
  const id = kind === 'agent'
    ? (read.answer === 'other' && read.what === 'agent' ? read.name : undefined)
    : (read.answer === 'record' && read.kind === kind ? read.id : undefined);
  // A file's statements are the caller's only with `files: read`, as on the export: without it the file is not there for them. The quad source
  // withholds a file's statements from a member read without it (`findsOf`), so this check is a second line of defence: the answer would be 404
  // for want of statements anyway, and it keeps that true if the source's predicate ever moves.
  if (id === undefined || (kind === 'file' && !member.files)) return { answer: 'not-found' };

  const slot = takeSlot('sparql', input.callerKey);
  if (!slot) return busyOutcome();
  try {
    const { timeoutMs, maxResults, maxResultBytes } = sparqlLimits(getConfig());
    const source = createQuadSource({ members: [space], caller: input.caller, fingerprintOf: schemaFingerprintOf }, { deadline: Date.now() + timeoutMs, signal: input.signal });
    // One meter for the whole answer, both halves: the bytes of every statement kept (`sparql.maxResultBytes`).
    const meter = new ByteMeter(maxResultBytes);
    // The chrono entry's time nodes are its own statements: a fragment never travels, so they are answered at the entry's address.
    const subjects = kind === 'chrono' ? [address, `${address}#start`, `${address}#end`] : [address];
    const about: RdfJsLike[] = [];
    for (const s of subjects) {
      const got = await takeStatements(source, source.match(DataFactory.namedNode(s), undefined, undefined, undefined), maxResults + 1 - about.length, undefined, meter);
      about.push(...got.quads);
      if (about.length > maxResults) {
        return {
          answer: 'refused',
          refusal: {
            status: SPARQL_TOO_LARGE, title: 'Too many statements', code: SPARQL_TOO_MANY_RESULTS,
            detail: `The address has more than ${maxResults} statements of its own (sparql.maxResults), so none of them is answered: ask a SPARQL query for a part of them`,
          },
        };
      }
    }
    if (about.length === 0) return { answer: 'not-found' };
    let pointing: RdfJsLike[] = [];
    let truncated = false;
    // An agent is pointed at by every record it wrote: its answer is its own statements.
    if (kind !== 'agent') {
      const own = new Set(subjects);
      try {
        // A statement of the record's own (a self-reference) is answered in its own half: it is filtered before the cap counts, so an answer
        // that fits the cap is not called cut because of a statement it would not carry twice.
        const got = await takeStatements(source, source.match(undefined, undefined, DataFactory.namedNode(address), undefined), maxResults - about.length,
          q => !own.has(q.subject!.value), meter);
        pointing = got.quads;
        truncated = got.more;
      } catch (err) {
        // The pointing half stops at a bound of the read (the records read, the time, the bytes) as it stops at the cap: what was read about
        // the record is answered whole, and the answer says its inbound half was cut.
        const named = sparqlRefusalOf(err);
        if (named?.code !== SPARQL_TOO_MUCH_READ && named?.code !== SPARQL_TIMEOUT && named?.code !== SPARQL_ANSWER_TOO_LARGE) throw err;
        truncated = true;
      }
    }
    return { answer: 'read', id, statements: [...about, ...pointing].map(statementOf), truncated };
  } catch (err) {
    if (input.signal.aborted) return { answer: 'gone' };
    const refusal = refusalOfError(err);
    if (!refusal) throw err;
    return { answer: 'refused', refusal };
  } finally {
    slot.release();
  }
}

/**
 * The type a vocab address names when the space's schema does not declare it (`termOfIri` reads it by the Direct Mapping alone), or
 * undefined for any other address: a declared term, a property, a file's document.
 */
export function undeclaredTypeOf(address: string, meta: RdfMember['meta']): UsedType | undefined {
  const term = termOfIri(address, addressNames(meta));
  if (term.answer !== 'term' || term.of !== 'space' || term.how !== 'vocabulary') return undefined;
  const owner = term.owners[0];
  if (owner === undefined || owner.prop !== undefined || owner.type === null || owner.kind === 'file') return undefined;
  return { kind: owner.kind, type: owner.type };
}

/** The kinds whose records may have no type: their properties are fragments of the kind's own vocab document. */
const UNTYPED_KINDS: ReadonlySet<string> = new Set(['entity', 'fact', 'chrono', 'file']);
/** The most property names one document answers: a space whose records hold more is answered the first of them. */
const PROPERTY_NAMES_MAX = 1_000;

/**
 * The kind a vocab address names when it is that kind's own document (`<vocab>file`, `<vocab>fact`): where the properties of a record with
 * no type, and of a file, are fragments (`<vocab>file#owner`). Undefined for any other address.
 */
export function untypedKindOf(address: string, meta: RdfMember['meta']): TermKind | undefined {
  // The reverse reader names no term by a bare kind document (the forward rule names none), so the address is compared to the vocab here: the
  // kind's document is the vocab and the kind, nothing after (`vocab/file/`, a namespace, is no document).
  const { vocab } = namesOf(meta);
  if (!address.startsWith(vocab)) return undefined;
  const kind = address.slice(vocab.length);
  return UNTYPED_KINDS.has(kind) ? kind as TermKind : undefined;
}

/** The decoded name of a fragment (`iriFragment` percent-encodes), or undefined for a fragment that is no valid encoding. */
function nameOfFragment(fragment: string): string | undefined {
  try { return decodeURIComponent(fragment); } catch { return undefined; }
}

/** What the read of an untyped kind's property names needs. */
export interface UsedPropertiesInput {
  space: string;
  meta: RdfMember['meta'];
  address: string;
  kind: TermKind;
  caller: RdfCaller | undefined;
  rights: TokenRights | null | undefined;
  callerKey: string;
  signal: AbortSignal;
}

/**
 * The names of the properties the records of an untyped kind use: the predicates of the space's statements that are fragments of `address`
 * (`<address>#<prop>`), read with one pass of the quad source in a slot of family `sparql` under the query bounds. Asked only of a caller who
 * reads the records (`knowledge: read`): the vocab address is read with schema read, and it must not tell such a caller what the records hold.
 */
export async function usedPropertiesOf(input: UsedPropertiesInput): Promise<LdOutcome<{ names: string[] }>> {
  if (!mayReadArea(input.rights, input.space, 'knowledge')) return { answer: 'read', names: [] };
  const slot = takeSlot('sparql', input.callerKey);
  if (!slot) return busyOutcome();
  try {
    const { timeoutMs } = sparqlLimits(getConfig());
    const source = createQuadSource({ members: [input.space], caller: input.caller, fingerprintOf: schemaFingerprintOf }, { deadline: Date.now() + timeoutMs, signal: input.signal });
    const names = new Set<string>();
    const prefix = `${input.address}#`;
    for await (const q of source.match(undefined, undefined, undefined, undefined) as AsyncIterable<RdfJsLike>) {
      const predicate = q.predicate!.value;
      if (!predicate.startsWith(prefix)) continue;
      // A name counts when the forward rule gives the predicate back for it: no spelling the export does not write is a property here.
      const name = nameOfFragment(predicate.slice(prefix.length));
      if (name !== undefined && name !== '' && resolveTermIri(input.meta, input.kind, null, name) === predicate) names.add(name);
      if (names.size >= PROPERTY_NAMES_MAX) return { answer: 'read', names: [...names].sort() };
    }
    throwWhenFailed(source);
    return { answer: 'read', names: [...names].sort() };
  } catch (err) {
    if (input.signal.aborted) return { answer: 'gone' };
    const refusal = refusalOfError(err);
    if (!refusal) throw err;
    return { answer: 'refused', refusal };
  } finally {
    slot.release();
  }
}

/** What the question whether a type is in use needs. */
export interface TypeInUseInput {
  space: string;
  address: string;
  used: UsedType;
  caller: RdfCaller | undefined;
  rights: TokenRights | null | undefined;
  callerKey: string;
  signal: AbortSignal;
}

/**
 * Does a record of the space use the undeclared type at `address`: a record typed with it (`?s rdf:type <address>`), or for an edge label
 * an edge under it (`?s <address> ?o`)? One statement of the quad source, read in a slot of family `sparql` under the query bounds. Asked
 * only of a caller who reads the records (`knowledge: read`): the vocab address is read with schema read, and it must not tell such a
 * caller that a record of a type exists.
 */
export async function typeInUse(input: TypeInUseInput): Promise<LdOutcome<{ used: boolean }>> {
  if (!mayReadArea(input.rights, input.space, 'knowledge')) return { answer: 'read', used: false };
  const slot = takeSlot('sparql', input.callerKey);
  if (!slot) return busyOutcome();
  try {
    const { timeoutMs } = sparqlLimits(getConfig());
    const source = createQuadSource({ members: [input.space], caller: input.caller, fingerprintOf: schemaFingerprintOf }, { deadline: Date.now() + timeoutMs, signal: input.signal });
    const term = DataFactory.namedNode(input.address);
    const stream = input.used.kind === 'edge' ? source.match(undefined, term, undefined, undefined) : source.match(undefined, DataFactory.namedNode(RDF_TYPE), term, undefined);
    return { answer: 'read', used: (await takeStatements(source, stream, 1)).quads.length > 0 };
  } catch (err) {
    if (input.signal.aborted) return { answer: 'gone' };
    const refusal = refusalOfError(err);
    if (!refusal) throw err;
    return { answer: 'refused', refusal };
  } finally {
    slot.release();
  }
}
