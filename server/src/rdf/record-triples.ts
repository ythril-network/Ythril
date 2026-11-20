/**
 * The RDF form of one record: a pure function from a stored document to quads, built from standard vocabularies (Q-749, design r4 section 5.2).
 *
 * ## What it prevents
 *
 * - **A record form built twice.** Every door and the schema graph ask this module; a second mapper would give one record two forms. It
 *   names everything through `term-iri.ts` and writes only declared `ythril:` terms (`ythrilIri` refuses an undeclared one).
 * - **Data read as links.** A property value is ONE plain literal on its property's address, never an IRI or a node, whatever the string looks
 *   like (a record id, a URL). Richer content is held as edges and links (decision record 23, owner 2026-11-18) and travels as what it is:
 *   an edge is the statement `<from> <term(label)> <to>` (several edges of one label are the one predicate several times, each with its own
 *   reifier, the record address of the edge, typed by its label's class `edgeClassIri` so the label's property shapes reach it alone), a link
 *   is `dcterms:references`, a nested thing is a record of its own reached by an edge.
 * - **A silent drop or a guess.** A property value that is a list or an object (only a direct database write can leave one), a value that
 *   does not fit its declared type, and a number that is no decimal give NO triple and are returned in `counts.skippedValues` as
 *   `{ recordId, kind, key, reason }`; the rest of the record is exported intact. `null` states nothing and is not counted. The mapper never
 *   throws on a stored value; it throws `rdf_not_enabled` only for a space that has RDF off.
 * - **A local-only field going out.** It reads only the fields of {@link RDF_READ_FIELDS} (also the export's cursor projection), so a vector,
 *   matched text, a write guard or an expiry stamp can never reach a triple. A fork row and a file that is no live file are left out whole.
 * - **Two members' exports of one space differing.** Properties and tags are sorted; the same record gives the same quads whatever the order of
 *   its keys.
 *
 * It sets no graph: the stream names the graph. A personal view's record keeps the address of its home space because the caller hands in the
 * home space's meta.
 */
import type { KnowledgeType, SpaceMeta } from '@ythril-network/schema';
import { SCHEMA_FINGERPRINT_FIELD } from '@ythril-network/schema/internal';
import { isRefKind, type RefKind } from '../config/types-knowledge.js';
import {
  declaredTypeOf, iri, literalForBoolean, literalForDecimal, literalForInteger, literalForTemporal, literalForValue, plain, stdIri, temporalKind, triple,
  type EdgeDetails, type IriTerm, type LeftOutReason, type LiteralTerm, type Quad, type Term, type TemporalKind,
} from './literals.js';
import { agentIri, edgeClassIri, graphIri, recordAddressable, recordIri, resolveTermIri, versionIri, type TermKind } from './term-iri.js';
import { ythrilIri } from './ythril-vocabulary.js';

/** The record kinds this module gives a form: the four knowledge types, a link and a file. */
export type RdfRecordKind = KnowledgeType | 'link' | 'file';

export type { EdgeDetails } from './literals.js';

export interface RecordTriplesOptions {
  edgeDetails: EdgeDetails;
  /**
   * The caller's memory of agents already stated in this export, keyed by (agent, label). A record states its agent's label only when the pair
   * is not in it, and adds it. Omitted: every record states its agent, so a record's form is self-contained.
   */
  agentsSeen?: Set<string>;
}

/** One value (or field) left out of a record's form, named so the operator can find and repair it. */
export interface SkippedValue {
  recordId: string;
  kind: RdfRecordKind;
  /** The property key, or the field name when a field of the record itself did not hold what it must. */
  key: string;
  reason: LeftOutReason;
}

export interface RecordTriplesCounts {
  skippedValues: SkippedValue[];
  /** Time values written as plain strings because they are no calendar date or time. */
  untypedTemporals: number;
}

/** Why a record has no form at all: a fork row, a row that is no live file, a record that cannot be given an address. */
export type LeftOutRecord = 'fork' | 'not-live' | 'unaddressable';

export interface RecordTriplesResult {
  quads: Quad[];
  counts: RecordTriplesCounts;
  leftOut?: LeftOutRecord;
}

const SHARED_FIELDS = ['_id', 'tags', 'description', 'author', 'createdAt', 'updatedAt', SCHEMA_FINGERPRINT_FIELD, 'superseded', 'forkOf'] as const;

/**
 * The fields the mapper reads, per record kind, and nothing else. Also the export's cursor projection. Includes the marks that exclude a
 * row (`forkOf`; `parentFileId`, `deletedAt`, `feedMarker`), so the exclusion holds even if a caller forgets the cursor's filter.
 */
export const RDF_READ_FIELDS: Readonly<Record<RdfRecordKind, readonly string[]>> = Object.freeze({
  entity: Object.freeze([...SHARED_FIELDS, 'name', 'type', 'properties']),
  fact: Object.freeze([...SHARED_FIELDS, 'fact', 'type', 'properties']),
  chrono: Object.freeze([...SHARED_FIELDS, 'title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'properties', 'recurrence', 'contentRedacted']),
  edge: Object.freeze([...SHARED_FIELDS, 'from', 'to', 'fromKind', 'toKind', 'label', 'type', 'weight', 'properties']),
  link: Object.freeze(['_id', 'from', 'fromKind', 'to', 'toKind']),
  file: Object.freeze(['_id', 'path', 'description', 'tags', 'properties', 'createdAt', 'updatedAt', 'sizeBytes', 'sha256', 'parentFileId', 'deletedAt', 'feedMarker']),
});

/** How many left-out values an export names one by one; the rest are counted (design r4 section 5.2). */
export const SKIPPED_VALUES_NAMED_MAX = 100;

export interface SkippedSummary { count: number; named: SkippedValue[]; unnamed: number }

/** The export's tally of left-out values: the count of all of them, the first {@link SKIPPED_VALUES_NAMED_MAX} named, the rest counted. */
export function createSkippedLog(): { add(values: readonly SkippedValue[]): void; summary(): SkippedSummary } {
  let count = 0;
  const named: SkippedValue[] = [];
  return {
    add(values) {
      for (const v of values) {
        count++;
        if (named.length < SKIPPED_VALUES_NAMED_MAX) named.push(v);
      }
    },
    summary: () => ({ count, named: [...named], unnamed: count - named.length }),
  };
}

const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isBag = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const TYPE = (): IriTerm => stdIri('rdf', 'type');
const CHRONO_INSTANT_PREDICATE: Record<TemporalKind, string> = { dateTimeStamp: 'inXSDDateTimeStamp', dateTime: 'inXSDDateTime', date: 'inXSDDate' };


/** The accumulator of one record: its quads, what it left out, the agents it states. */
class Form {
  readonly quads: Quad[] = [];
  readonly skipped: SkippedValue[] = [];
  untypedTemporals = 0;
  constructor(readonly meta: SpaceMeta, readonly kind: RdfRecordKind, readonly recordId: string, readonly opts: RecordTriplesOptions) {}

  add(subject: IriTerm, predicate: IriTerm, object: Term): void {
    this.quads.push({ subject, predicate, object });
  }
  skip(key: string, reason: LeftOutReason): void {
    this.skipped.push({ recordId: this.recordId, kind: this.kind, key, reason });
  }
  /** A time value as a literal; a string that is no calendar date or time stays plain and is counted. */
  temporal(value: string): LiteralTerm {
    const literal = literalForTemporal(value);
    if (literal.datatype === undefined) this.untypedTemporals++;
    return literal;
  }
  /** `subject predicate <text>` when `value` is a non-empty string; a value of another type is left out and named by its field. */
  text(subject: IriTerm, predicate: IriTerm, value: unknown, field: string): void {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string') { this.skip(field, 'does-not-fit-its-declared-type'); return; }
    this.add(subject, predicate, plain(value));
  }
  /** A time field of the record itself. */
  time(subject: IriTerm, predicate: IriTerm, value: unknown, field: string): void {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string') { this.skip(field, 'does-not-fit-its-declared-type'); return; }
    this.add(subject, predicate, this.temporal(value));
  }
  /** A number field of the record itself, as a decimal. */
  decimal(subject: IriTerm, predicate: IriTerm, value: unknown, field: string): void {
    if (value === undefined || value === null) return;
    const literal = typeof value === 'number' ? literalForDecimal(value) : null;
    if (literal === null) { this.skip(field, 'does-not-fit-its-declared-type'); return; }
    this.add(subject, predicate, literal);
  }

  /** dcterms:created / modified, keywords, description. */
  common(subject: IriTerm, d: Record<string, unknown>): void {
    this.time(subject, stdIri('dcterms', 'created'), d['createdAt'], 'createdAt');
    this.time(subject, stdIri('dcterms', 'modified'), d['updatedAt'], 'updatedAt');
    const tags = d['tags'];
    if (Array.isArray(tags)) {
      const words = [...new Set(tags.filter((t): t is string => typeof t === 'string'))].sort();
      for (const w of words) this.add(subject, stdIri('schema', 'keywords'), plain(w));
      if (words.length !== new Set(tags).size) this.skip('tags', 'not-a-plain-value');
    } else if (tags !== undefined && tags !== null) this.skip('tags', 'not-a-plain-value');
    this.text(subject, stdIri('schema', 'description'), d['description'], 'description');
  }

  /** The triples every knowledge record carries beside {@link common}: the author, the superseded mark, the schema version it conforms to. */
  knowledge(subject: IriTerm, d: Record<string, unknown>): void {
    this.common(subject, d);
    const author = d['author'];
    if (isBag(author) && isText(author['instanceId'])) {
      const id = author['instanceId'];
      const label = isText(author['instanceLabel']) ? author['instanceLabel'] : null;
      const agent = iri(agentIri(this.meta, id));
      this.add(subject, stdIri('prov', 'wasAttributedTo'), agent);
      const key = JSON.stringify([id, label]);
      if (!this.opts.agentsSeen?.has(key)) {
        this.opts.agentsSeen?.add(key);
        this.add(agent, TYPE(), stdIri('prov', 'Agent'));
        if (label !== null) this.add(agent, stdIri('rdfs', 'label'), plain(label));
      }
    }
    if (d['superseded'] === true) this.add(subject, iri(ythrilIri('superseded')), literalForBoolean(true));
    const stamp = d[SCHEMA_FINGERPRINT_FIELD];
    if (isText(stamp)) this.add(subject, stdIri('dcterms', 'conformsTo'), iri(versionIri(this.meta, stamp)));
  }

  /** Each property as one literal on its term, typed by its declared type; what is no plain value or does not fit is left out and named. */
  properties(subject: IriTerm, raw: unknown, termKind: TermKind, type: string | null): void {
    if (raw === undefined || raw === null) return;
    if (!isBag(raw)) { this.skip('properties', 'not-a-plain-value'); return; }
    // The outcomes are ordered by property key (code units), so two members' exports of one record agree whatever the order a store gave its keys.
    const outcomes = Object.keys(raw).map(key => ({ key, outcome: literalForValue(raw[key], declaredTypeOf(this.meta, termKind, type, key)) }));
    outcomes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const { key, outcome } of outcomes) {
      if (outcome.kind === 'nothing') continue;
      if (key === '') { this.skip(key, 'key-has-no-address'); continue; }
      if (outcome.kind === 'left-out') { this.skip(key, outcome.reason); continue; }
      this.add(subject, iri(resolveTermIri(this.meta, termKind, type, key)), outcome.literal);
    }
  }
}

const typeOf = (d: Record<string, unknown>): string | null => (isText(d['type']) ? d['type'] : null);
const fragmentOf = (subject: IriTerm, name: string): IriTerm => iri(`${subject.value}#${name}`);

function entityForm(f: Form, d: Record<string, unknown>, s: IriTerm): void {
  const type = typeOf(d);
  f.add(s, TYPE(), iri(ythrilIri('Entity')));
  f.add(s, TYPE(), iri(resolveTermIri(f.meta, 'entity', type)));
  f.text(s, stdIri('rdfs', 'label'), d['name'], 'name');
  f.knowledge(s, d);
  f.properties(s, d['properties'], 'entity', type);
}

function factForm(f: Form, d: Record<string, unknown>, s: IriTerm): void {
  const type = typeOf(d);
  f.add(s, TYPE(), iri(ythrilIri('Fact')));
  if (type !== null) f.add(s, TYPE(), iri(resolveTermIri(f.meta, 'fact', type)));
  f.text(s, stdIri('schema', 'text'), d['fact'], 'fact');
  f.knowledge(s, d);
  f.properties(s, d['properties'], 'fact', type);
}

/** The `time:` nodes of a chrono entry: an instant when it has no end, an interval of two instants when both ends are calendar times. */
function chronoTimes(f: Form, s: IriTerm, start: unknown, end: unknown): void {
  if (!isText(start)) return;
  const startKind = temporalKind(start);
  const instant = (node: IriTerm, value: string, kind: TemporalKind): void => {
    f.add(node, TYPE(), stdIri('time', 'Instant'));
    f.add(node, stdIri('time', CHRONO_INSTANT_PREDICATE[kind]), literalForTemporal(value));
  };
  if (startKind === null) return;
  if (end === undefined || end === null || end === '') { instant(s, start, startKind); return; }
  const endKind = isText(end) ? temporalKind(end) : null;
  if (!isText(end) || endKind === null) return;
  f.add(s, TYPE(), stdIri('time', 'Interval'));
  const begin = fragmentOf(s, 'start');
  const finish = fragmentOf(s, 'end');
  f.add(s, stdIri('time', 'hasBeginning'), begin);
  f.add(s, stdIri('time', 'hasEnd'), finish);
  instant(begin, start, startKind);
  instant(finish, end, endKind);
}

function chronoForm(f: Form, d: Record<string, unknown>, s: IriTerm): void {
  const type = typeOf(d);
  if (type !== null) f.add(s, TYPE(), iri(resolveTermIri(f.meta, 'chrono', type)));
  if (type === 'event') {
    f.add(s, TYPE(), stdIri('schema', 'Event'));
    const status = d['status'];
    if (status === 'cancelled') f.add(s, stdIri('schema', 'eventStatus'), stdIri('schema', 'EventCancelled'));
    else if (status === 'upcoming' || status === 'active') f.add(s, stdIri('schema', 'eventStatus'), stdIri('schema', 'EventScheduled'));
  }
  chronoTimes(f, s, d['startsAt'], d['endsAt']);
  f.time(s, stdIri('schema', 'startDate'), d['startsAt'], 'startsAt');
  f.time(s, stdIri('schema', 'endDate'), d['endsAt'], 'endsAt');
  f.text(s, stdIri('rdfs', 'label'), d['title'], 'title');
  f.text(s, iri(ythrilIri('status')), d['status'], 'status');
  f.decimal(s, iri(ythrilIri('confidence')), d['confidence'], 'confidence');
  const rec = d['recurrence'];
  if (isBag(rec)) {
    f.text(s, iri(ythrilIri('recurrenceFreq')), rec['freq'], 'recurrence');
    if (rec['interval'] !== undefined && rec['interval'] !== null) {
      const interval = typeof rec['interval'] === 'number' ? literalForInteger(rec['interval']) : null;
      if (interval === null) f.skip('recurrence', 'does-not-fit-its-declared-type'); else f.add(s, iri(ythrilIri('recurrenceInterval')), interval);
    }
    f.time(s, iri(ythrilIri('recurrenceUntil')), rec['until'], 'recurrence');
  } else if (rec !== undefined && rec !== null) f.skip('recurrence', 'not-a-plain-value');
  if (d['contentRedacted'] === true) f.add(s, iri(ythrilIri('contentRedacted')), literalForBoolean(true));
  f.knowledge(s, d);
  f.properties(s, d['properties'], 'chrono', type);
}

/** The two ends of an edge or link as record addresses; the kind of an edge end defaults to entity, a link states both. */
function endsOf(meta: SpaceMeta, d: Record<string, unknown>, defaultKind: RefKind | null): { from: IriTerm; to: IriTerm } | null {
  const fromKind = d['fromKind'] ?? defaultKind;
  const toKind = d['toKind'] ?? defaultKind;
  if (!isText(d['from']) || !isText(d['to']) || !isRefKind(fromKind) || !isRefKind(toKind)) return null;
  if (!recordAddressable(fromKind, d['from']) || !recordAddressable(toKind, d['to'])) return null;
  return { from: iri(recordIri(meta, fromKind, d['from'])), to: iri(recordIri(meta, toKind, d['to'])) };
}

function edgeForm(f: Form, d: Record<string, unknown>, s: IriTerm, ends: { from: IriTerm; to: IriTerm }, label: string): void {
  const predicate = iri(resolveTermIri(f.meta, 'edge', label));
  f.add(ends.from, predicate, ends.to);
  // The reifier is of its label's class, so the shapes of the label's own properties reach this label's edges and no other's.
  f.add(s, TYPE(), iri(edgeClassIri(f.meta, label)));
  if (f.opts.edgeDetails === 'rdf12') {
    f.add(s, stdIri('rdf', 'reifies'), triple(ends.from, predicate, ends.to));
  } else {
    f.add(s, TYPE(), stdIri('rdf', 'Statement'));
    f.add(s, stdIri('rdf', 'subject'), ends.from);
    f.add(s, stdIri('rdf', 'predicate'), predicate);
    f.add(s, stdIri('rdf', 'object'), ends.to);
  }
  f.decimal(s, iri(ythrilIri('weight')), d['weight'], 'weight');
  f.text(s, iri(ythrilIri('edgeType')), d['type'], 'type');
  f.knowledge(s, d);
  f.properties(s, d['properties'], 'edge', label);
}

function fileForm(f: Form, d: Record<string, unknown>, s: IriTerm): void {
  f.add(s, TYPE(), stdIri('schema', 'MediaObject'));
  f.text(s, iri(ythrilIri('path')), d['path'] ?? d['_id'], 'path');
  const size = d['sizeBytes'];
  if (size !== undefined && size !== null) {
    const literal = typeof size === 'number' ? literalForInteger(size) : null;
    if (literal === null) f.skip('sizeBytes', 'does-not-fit-its-declared-type'); else f.add(s, iri(ythrilIri('sizeBytes')), literal);
  }
  f.text(s, stdIri('schema', 'sha256'), d['sha256'], 'sha256');
  f.common(s, d);
  f.properties(s, d['properties'], 'file', null);
}

/**
 * The RDF form of `doc`, a stored record of `kind`, in the space whose RESOLVED meta is `meta` (library `$ref`s inlined). Never throws on a
 * stored value; throws `rdf_not_enabled` when the space has RDF off. A record with no form (a fork row, a row that is no live file, one that
 * cannot be addressed) answers no quads and says why in `leftOut`.
 */
export function recordTriples(meta: SpaceMeta, kind: RdfRecordKind, doc: unknown, opts: RecordTriplesOptions): RecordTriplesResult {
  graphIri(meta); // throws rdf_not_enabled before anything of the record is read
  const d = (doc !== null && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const none = (leftOut: LeftOutRecord): RecordTriplesResult => ({ quads: [], counts: { skippedValues: [], untypedTemporals: 0 }, leftOut });
  const idField = kind === 'file' ? d['path'] ?? d['_id'] : d['_id'];
  if (!isText(idField) || (kind !== 'link' && !recordAddressable(kind, idField))) return none('unaddressable');
  if (kind !== 'link' && kind !== 'file' && d['forkOf'] !== undefined && d['forkOf'] !== null) return none('fork');
  if (kind === 'file' && [d['parentFileId'], d['deletedAt'], d['feedMarker']].some(v => v !== undefined && v !== null)) return none('not-live');
  const f = new Form(meta, kind, idField, opts);
  const done = (): RecordTriplesResult => ({ quads: f.quads, counts: { skippedValues: f.skipped, untypedTemporals: f.untypedTemporals } });

  if (kind === 'link') {
    const ends = endsOf(meta, d, null);
    if (ends === null) return none('unaddressable');
    f.add(ends.from, stdIri('dcterms', 'references'), ends.to);
    return done();
  }
  if (kind === 'edge') {
    const ends = endsOf(meta, d, 'entity');
    if (ends === null || !isText(d['label'])) return none('unaddressable');
    edgeForm(f, d, iri(recordIri(meta, 'edge', idField)), ends, d['label']);
    return done();
  }
  const subject = iri(recordIri(meta, kind, idField));
  if (kind === 'entity') entityForm(f, d, subject);
  else if (kind === 'fact') factForm(f, d, subject);
  else if (kind === 'chrono') chronoForm(f, d, subject);
  else fileForm(f, d, subject);
  return done();
}
