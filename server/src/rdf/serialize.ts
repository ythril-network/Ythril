/**
 * The RDF writers: Turtle, TriG, N-Quads and JSON-LD from one term model, a batch at a time (Q-749, design r4 section 5.3).
 *
 * ## What it prevents
 *
 * An RDF file another tool cannot parse is worth nothing, and a writer that leaves escaping to its callers is a writer whose callers forget: a
 * record whose text holds a quote, a backslash, a newline, a control character or a `>` would break the export or inject a statement into
 * it. This module is the ONLY one that spells a literal, an IRI, a label or a comment in any format, and it keeps the forgettable parts inside:
 *
 * - **Escaping per format.** Turtle and N-Quads: ECHAR for quote, backslash and the usual controls, a four-digit `u` escape for every other control
 *   character; JSON-LD: JSON. A lone UTF-16 surrogate, which no format can carry, becomes U+FFFD and is counted (`replacedCharacters`), never
 *   written.
 * - **An IRIREF guard.** An IRI with no scheme or with a character an IRI cannot hold (space, controls, `<>"{}|^` backtick, backslash, a lone
 *   surrogate) is refused with {@link RdfWriteError}, never written. Nothing built from data reaches it unencoded (`term-iri.ts` encodes
 *   every segment); this is the last check.
 * - **Compact names only where safe.** A prefixed name is written only for a local name of letters, digits, `_` and `-` that starts with a
 *   letter or `_`; every other IRI stays `<...>`. In JSON-LD an absolute IRI whose scheme is a declared prefix is refused (a processor would
 *   read it as a compact name), so the context never rewrites an emitted IRI.
 * - **A fixed order and fixed labels.** Within a batch, graphs, subjects, predicates (`rdf:type` first), objects and prefixes are sorted and a
 *   repeated statement is written once; blank nodes are `_:b0`, `_:b1`, ... in output order, one counter per document. One record gives the
 *   same bytes on every run, so two members' exports of one space compare equal.
 * - **Collections and triple terms.** A list is `( ... )` in Turtle and TriG, an `rdf:first`/`rdf:rest` chain in N-Quads, `@list` in JSON-LD;
 *   a triple term (the object of `rdf:reifies`) is `<<( s p o )>>` in the three text formats and refused in JSON-LD 1.1, which has none.
 * - **Streaming.** {@link createRdfWriter} gives a string per batch and {@link serializeRdf} a chunk per batch pulled from an (async) iterator
 *   as it is read; nothing holds the whole document, and a reader that stops closes the source.
 * - **One closing comment line.** {@link closingComment} and the writer's `close` put whatever ids a count names on ONE comment line, so a
 *   record id with a newline cannot start a statement.
 *
 * Pure apart from the writer's own counters.
 */
import type { BlankTerm, IriTerm, Quad, Term } from './literals.js';
import { STANDARD_PREFIXES } from './ythril-vocabulary.js';

export type RdfFormat = 'turtle' | 'trig' | 'nquads' | 'jsonld';
export const RDF_FORMATS: readonly RdfFormat[] = Object.freeze(['turtle', 'trig', 'nquads', 'jsonld']);

/** One piece of the document: usually one record's quads. `graph` is the graph of every quad that names none of its own. */
export interface QuadBatch { graph?: string; quads: readonly Quad[] }

export interface WriterOptions {
  /** The prefixes a Turtle or TriG document declares, JSON-LD puts in its context, and compact names are written with. */
  prefixes?: Readonly<Record<string, string>>;
}

/** What a writer refuses to write; `code` names it. */
export class RdfWriteError extends Error {
  readonly code = 'rdf_unwritable';
  constructor(message: string) {
    super(message);
    this.name = 'RdfWriteError';
  }
}

export interface RdfWriter {
  readonly format: RdfFormat;
  /** Lone surrogates written as U+FFFD so far. */
  readonly replacedCharacters: number;
  /** The start of the document (prefixes, or the JSON-LD context). */
  open(): string;
  /** One batch. */
  write(batch: QuadBatch): string;
  /** The end of the document; `comment` (one line of text, no `#`) is added as a comment in the text formats and ignored in JSON-LD. */
  close(comment?: string): string;
}

const RDF_NS = STANDARD_PREFIXES['rdf']!;
const RDF_TYPE = RDF_NS.concat('type');
const RDF_FIRST = RDF_NS.concat('first');
const RDF_REST = RDF_NS.concat('rest');
const RDF_NIL = RDF_NS.concat('nil');

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const IRI_FORBIDDEN = /[\u0000- <>"{}|^`\\\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const SAFE_LOCAL = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SAFE_PREFIX = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CONTROL = /[\u0000-\u001f\u007f\u{85}\u{2028}\u{2029}]/gu;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const ECHAR: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };
const hex4 = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** The text of a string literal body in Turtle and N-Quads. */
const escapeString = (s: string): string => s.replace(/[\u0000-\u001f"\\\u007f]/g, c => ECHAR[c] ?? hex4(c));

type Subject = IriTerm | BlankTerm;

/** A sort key of a term that is the same for equal terms, so objects sort and repeat statements collapse. */
function termKey(t: Term): string {
  switch (t.kind) {
    case 'iri': return `I${t.value}`;
    case 'blank': return `B${t.id}`;
    case 'literal': return `L${t.value}\u0000${t.datatype ?? ''}`;
    case 'list': return `T[${t.items.map(termKey).join(',')}]`;
    case 'triple': return `X(${termKey(t.subject)} ${termKey(t.predicate)} ${termKey(t.object)})`;
  }
}

interface PredicateGroup { predicate: IriTerm; objects: Term[] }
interface SubjectGroup { subject: Subject; predicates: PredicateGroup[] }
interface GraphGroup { graph: string | null; subjects: SubjectGroup[] }

/** The batch as sorted, de-duplicated graph > subject > predicate > object groups. */
function groupBatch(batch: QuadBatch): GraphGroup[] {
  const graphs = new Map<string, Map<string, { subject: Subject; preds: Map<string, { predicate: IriTerm; objects: Map<string, Term> }> }>>();
  for (const q of batch.quads) {
    const g = q.graph?.value ?? batch.graph ?? '';
    let subjects = graphs.get(g);
    if (!subjects) graphs.set(g, subjects = new Map());
    const sKey = termKey(q.subject);
    let s = subjects.get(sKey);
    if (!s) subjects.set(sKey, s = { subject: q.subject, preds: new Map() });
    let p = s.preds.get(q.predicate.value);
    if (!p) s.preds.set(q.predicate.value, p = { predicate: q.predicate, objects: new Map() });
    p.objects.set(termKey(q.object), q.object);
  }
  return [...graphs.entries()].sort(([a], [b]) => cmp(a, b)).map(([g, subjects]) => ({
    graph: g === '' ? null : g,
    subjects: [...subjects.entries()].sort(([a], [b]) => cmp(a, b)).map(([, s]) => ({
      subject: s.subject,
      predicates: [...s.preds.values()]
        .sort((a, b) => (a.predicate.value === RDF_TYPE ? -1 : b.predicate.value === RDF_TYPE ? 1 : cmp(a.predicate.value, b.predicate.value)))
        .map(p => ({ predicate: p.predicate, objects: [...p.objects.entries()].sort(([a], [b]) => cmp(a, b)).map(([, o]) => o) })),
    })),
  }));
}

/** The last check of an IRI: a scheme, and no character an IRI cannot hold. */
function checkIri(value: string): string {
  if (!SCHEME.test(value) || IRI_FORBIDDEN.test(value) || new RegExp(LONE_SURROGATE.source).test(value)) {
    throw new RdfWriteError(`not a writable IRI: ${JSON.stringify(value.length > 200 ? `${value.slice(0, 200)}...` : value)}`);
  }
  return value;
}

/** The prefixes of a document, validated and sorted by name. */
function prefixTable(prefixes: Readonly<Record<string, string>>): { name: string; ns: string }[] {
  const rows = Object.entries(prefixes).map(([name, ns]) => {
    if (!SAFE_PREFIX.test(name)) throw new RdfWriteError(`not a writable prefix name: ${JSON.stringify(name)}`);
    return { name, ns: checkIri(ns) };
  });
  return rows.sort((a, b) => cmp(a.name, b.name));
}

/** A string whose lone surrogates are U+FFFD; `count` is told how many. */
function withoutLoneSurrogates(s: string, count: () => void): string {
  return s.replace(LONE_SURROGATE, () => { count(); return '\u{FFFD}'; });
}

/** Text for a one-line comment: lone surrogates replaced, every control and line separator a space. */
const oneLine = (s: string): string => s.replace(LONE_SURROGATE, '\u{FFFD}').replace(CONTROL, ' ');

/** The summary an export keeps of the values it left out (structurally `SkippedSummary` of `record-triples.ts`). */
export interface LeftOutSummary { count: number; named: readonly { recordId: string; key: string }[]; unnamed: number }

/** The one comment line an export ends with when it left values out, or `undefined` when it left none out. */
export function closingComment(summary: LeftOutSummary): string | undefined {
  if (summary.count === 0) return undefined;
  const names = summary.named.map(n => `${n.recordId} (${n.key})`);
  if (summary.unnamed > 0) names.push(`and ${summary.unnamed} more`);
  return oneLine(`ythril-export: ${summary.count} property values left out (not a plain value): ${names.join(', ')}`);
}

class Writer implements RdfWriter {
  replacedCharacters = 0;
  private blanks = 0;
  private first = true;
  private readonly table: { name: string; ns: string }[];
  /** The prefixes compact names are tried with: longest namespace first, then by name. */
  private readonly byLength: { name: string; ns: string }[];

  constructor(readonly format: RdfFormat, prefixes: Readonly<Record<string, string>>) {
    const all = prefixTable(prefixes);
    // JSON-LD reads a prefix only when its namespace ends in a delimiter; the others are left out of its context and its compact names.
    this.table = format === 'jsonld' ? all.filter(p => /[/#]$/.test(p.ns)) : all;
    this.byLength = [...this.table].sort((a, b) => b.ns.length - a.ns.length || cmp(a.name, b.name));
  }

  open(): string {
    if (this.format === 'nquads') return '';
    if (this.format === 'jsonld') {
      const context = Object.fromEntries(this.table.map(p => [p.name, p.ns]));
      return `{\n  "@context": ${JSON.stringify(context)},\n  "@graph": [`;
    }
    if (this.table.length === 0) return '';
    return `${this.table.map(p => `@prefix ${p.name}: <${p.ns}> .`).join('\n')}\n\n`;
  }

  close(comment?: string): string {
    if (this.format === 'jsonld') return '\n  ]\n}\n';
    return comment === undefined ? '' : `# ${oneLine(comment)}\n`;
  }

  write(batch: QuadBatch): string {
    const labels = new Map<string, string>();
    const label = (id: string): string => {
      let l = labels.get(id);
      if (l === undefined) labels.set(id, l = `b${this.blanks++}`);
      return l;
    };
    const groups = groupBatch(batch);
    switch (this.format) {
      case 'nquads': return groups.map(g => this.nquadsGroup(g, label)).join('');
      case 'jsonld': return this.jsonldGroups(groups, label);
      case 'turtle': return groups.map(g => {
        if (g.graph !== null) throw new RdfWriteError('Turtle holds one graph: a named graph needs TriG or N-Quads');
        return this.turtleBlocks(g, label);
      }).join('');
      case 'trig': return groups.map(g => (g.graph === null ? this.turtleBlocks(g, label) : `${this.name(g.graph)} {\n${this.turtleBlocks(g, label)}}\n`)).join('');
    }
  }

  private text(s: string): string {
    return withoutLoneSurrogates(s, () => { this.replacedCharacters++; });
  }

  /** A compact name, or `<iri>`. */
  private name(value: string): string {
    checkIri(value);
    for (const p of this.byLength) {
      if (value.startsWith(p.ns)) {
        const local = value.slice(p.ns.length);
        if (SAFE_LOCAL.test(local)) return `${p.name}:${local}`;
      }
    }
    return `<${value}>`;
  }

  // -- Turtle and TriG ------------------------------------------------------------------------------------------------------------------
  private turtleTerm(t: Term, label: (id: string) => string): string {
    switch (t.kind) {
      case 'iri': return this.name(t.value);
      case 'blank': return `_:${label(t.id)}`;
      case 'literal': return `"${escapeString(this.text(t.value))}"${t.datatype === undefined ? '' : `^^${this.name(t.datatype)}`}`;
      case 'list': return t.items.length === 0 ? '()' : `( ${t.items.map(i => this.turtleTerm(i, label)).join(' ')} )`;
      case 'triple': return `<<( ${this.turtleTerm(t.subject, label)} ${this.turtleTerm(t.predicate, label)} ${this.turtleTerm(t.object, label)} )>>`;
    }
  }

  private turtleBlocks(g: GraphGroup, label: (id: string) => string): string {
    return g.subjects.map(s => {
      const preds = s.predicates.map(p => `    ${p.predicate.value === RDF_TYPE ? 'a' : this.name(p.predicate.value)} ${p.objects.map(o => this.turtleTerm(o, label)).join(', ')}`);
      return `${this.turtleTerm(s.subject, label)}\n${preds.join(' ;\n')} .\n\n`;
    }).join('');
  }

  // -- N-Quads --------------------------------------------------------------------------------------------------------------------------
  /** A term of one statement; the statements of a list's chain are appended to `extra`. */
  private nquadsTerm(t: Term, label: (id: string) => string, extra: string[], tail: string): string {
    switch (t.kind) {
      case 'iri': return `<${checkIri(t.value)}>`;
      case 'blank': return `_:${label(t.id)}`;
      case 'literal': return `"${escapeString(this.text(t.value))}"${t.datatype === undefined ? '' : `^^<${checkIri(t.datatype)}>`}`;
      case 'triple': return `<<( ${this.nquadsTerm(t.subject, label, extra, tail)} ${this.nquadsTerm(t.predicate, label, extra, tail)} ${this.nquadsTerm(t.object, label, extra, tail)} )>>`;
      case 'list': {
        if (t.items.length === 0) return `<${RDF_NIL}>`;
        const nodes = t.items.map(() => `_:b${this.blanks++}`);
        t.items.forEach((item, i) => {
          const rest = i + 1 < nodes.length ? nodes[i + 1]! : `<${RDF_NIL}>`;
          const value = this.nquadsTerm(item, label, extra, tail);
          extra.push(`${nodes[i]} <${RDF_FIRST}> ${value}${tail} .\n`, `${nodes[i]} <${RDF_REST}> ${rest}${tail} .\n`);
        });
        return nodes[0]!;
      }
    }
  }

  private nquadsGroup(g: GraphGroup, label: (id: string) => string): string {
    const tail = g.graph === null ? '' : ` <${checkIri(g.graph)}>`;
    let out = '';
    for (const s of g.subjects) {
      for (const p of s.predicates) {
        for (const o of p.objects) {
          const extra: string[] = [];
          const subject = this.nquadsTerm(s.subject, label, extra, tail);
          const predicate = this.nquadsTerm(p.predicate, label, extra, tail);
          const object = this.nquadsTerm(o, label, extra, tail);
          out += `${subject} ${predicate} ${object}${tail} .\n${extra.join('')}`;
        }
      }
    }
    return out;
  }

  // -- JSON-LD --------------------------------------------------------------------------------------------------------------------------
  /** A compact name, or the absolute IRI; an absolute IRI whose scheme is a declared prefix is refused. */
  private jsonIri(value: string): string {
    const named = this.name(value);
    if (!named.startsWith('<')) return named;
    const scheme = value.slice(0, value.indexOf(':'));
    if (this.table.some(p => p.name === scheme)) throw new RdfWriteError(`the IRI ${JSON.stringify(value)} starts with the declared prefix "${scheme}:" and JSON-LD would read it as a compact name`);
    return value;
  }

  private jsonValue(t: Term, label: (id: string) => string): unknown {
    switch (t.kind) {
      case 'iri': return { '@id': this.jsonIri(t.value) };
      case 'blank': return { '@id': `_:${label(t.id)}` };
      case 'literal': {
        const value = this.text(t.value);
        return t.datatype === undefined ? { '@value': value } : { '@value': value, '@type': this.jsonIri(t.datatype) };
      }
      case 'list': return { '@list': t.items.map(i => this.jsonValue(i, label)) };
      case 'triple': throw new RdfWriteError('JSON-LD 1.1 has no triple term: write the classic reification form for JSON-LD');
    }
  }

  private jsonNode(s: SubjectGroup, label: (id: string) => string): Record<string, unknown> {
    const node: Record<string, unknown> = { '@id': s.subject.kind === 'iri' ? this.jsonIri(s.subject.value) : `_:${label(s.subject.id)}` };
    for (const p of s.predicates) {
      if (p.predicate.value === RDF_TYPE && p.objects.every(o => o.kind === 'iri')) {
        node['@type'] = p.objects.map(o => this.jsonIri((o as IriTerm).value));
      } else {
        node[this.jsonIri(p.predicate.value)] = p.objects.map(o => this.jsonValue(o, label));
      }
    }
    return node;
  }

  private jsonldGroups(groups: GraphGroup[], label: (id: string) => string): string {
    const items: unknown[] = [];
    for (const g of groups) {
      const nodes = g.subjects.map(s => this.jsonNode(s, label));
      if (g.graph === null) items.push(...nodes);
      else items.push({ '@id': this.jsonIri(g.graph), '@graph': nodes });
    }
    let out = '';
    for (const item of items) {
      out += `${this.first ? '' : ','}\n    ${JSON.stringify(item)}`;
      this.first = false;
    }
    return out;
  }
}

/** A writer for `format`, with the document's prefixes (default: none). */
export function createRdfWriter(format: RdfFormat, opts: WriterOptions = {}): RdfWriter {
  return new Writer(format, opts.prefixes ?? {});
}

/**
 * The document of `batches` as chunks: the start, a chunk per batch pulled from the (async) iterator as the reader asks, and the end.
 * `closing` is asked after the last batch, when the count of what was left out is known. A reader that stops closes the source.
 */
export async function* serializeRdf(
  format: RdfFormat,
  batches: Iterable<QuadBatch> | AsyncIterable<QuadBatch>,
  opts: WriterOptions & { closing?: () => string | undefined } = {},
): AsyncGenerator<string, void, undefined> {
  const writer = createRdfWriter(format, opts);
  yield writer.open();
  for await (const batch of batches) yield writer.write(batch);
  yield writer.close(opts.closing?.());
}
