/**
 * The type schemas of a space, read from the classes, properties and shapes of an RDF file (bundle-270, slice S8, Q-754; amendments A7, A13).
 * The inverse of `schemaGraph` (`schema-owl-shacl.ts`): a schema this product exports reads back as an equal schema, and a foreign ontology is
 * read as far as a type schema holds it exactly.
 *
 * ## What it prevents
 *
 * - **A schema that looks imported and is not.** Every statement of a type or property the reader takes is a `taken` entry (the field it set,
 *   the value), and every other statement about a term or shape it owns is a `notTaken` entry (the shape or term, the constraint, why): a
 *   statement is never dropped. The counts (`taken`, `notTaken`, `outside`) sum to the file's statements.
 * - **A strict space that accepts what its ontology forbids.** A statement is mapped to a field only where the field holds exactly what it
 *   says: `required`, a one-only edge label and an enumeration come back exactly as strict as they were written, a cardinality no field holds
 *   (`sh:minCount 2`, `sh:maxCount 2`) is named and never rounded, an `xsd:integer` is not a `number`, an exclusive bound is not a `minimum`,
 *   a bare `sh:class` is not an endpoint list (`schema-from-rdf-constraints.ts` holds the table of SHACL Core and the rule behind it).
 * - **A choice nobody made.** A statement CLAIMS a value for a field; a field is believed when its claims agree. A file that contradicts itself
 *   (one property with two datatypes, a class that is also an edge label, two names for one type, an enumeration in the axioms that differs
 *   from the shapes') is a REFUSAL carrying both statements, in every mode, and the answer is the stored schema unchanged. Names that collide
 *   after shortening (two addresses with one local part) are refused with both addresses, never merged and never numbered.
 * - **A write that loses work, or hides what it does.** `mode` says how the answer meets the stored type schemas (an argument, never touched):
 *   `generate` builds a whole schema into a space with no type; `expand` adds the types and properties that are absent; `update` also
 *   changes the stored values the file states. The answer lists each change; none deletes.
 * - **A space-level field.** The answer is type schemas only (amendment A7): the ontology's purpose, validation mode, strict linkage and rules
 *   are named `space-level`, never read.
 *
 * ## The answer
 *
 * `{ typeSchemas, taken, notTaken, changes, refusals, counts }`. `typeSchemas` is what the space's type schemas would be (all four kinds);
 * with a refusal it is the stored schema as it was. The addresses of the file's terms are kept: a term not under the space's own vocabulary
 * becomes the type's or property's `iri`; one the vocabulary names is read to its derived name and carries none.
 *
 * Pure: it reads the quads it is handed (the caller has bounded them: {@link SCHEMA_RDF_MAX_QUADS}), the space's reverse names and the stored
 * type schemas, and nothing else.
 */
import { IriZ, KNOWLEDGE_TYPES, TypeSchemaZ, refusalOfParse, type KnowledgeType } from '@ythril-network/schema';
import type { Quad } from './literals.js';
import type { AddressNames } from './term-reverse.js';
import { SHACL_CONSTRAINTS, leftoverWhy, type ConstraintRow } from './schema-from-rdf-constraints.js';
import {
  chooseName, localPart, mergeClaims, nameKey, refuseWith, validPropertyKey, validTypeName,
  type Draft, type Merged, type PropDraft, type ReadContext, type SchemaRefusal, type TypeDraft,
} from './schema-from-rdf-drafts.js';
import { buildWhole, firstStoredType, meetStored, normalizedStored, type BuiltType, type SchemaChange, type SchemaMode, type StoredTypeSchemas, type TypeSchemasByKind } from './schema-from-rdf-modes.js';
import { discoverDeclared, readDeclared } from './schema-from-rdf-owl.js';
import { discoverShapes, readShapes } from './schema-from-rdf-shacl.js';
import {
  Ledger, OWL, RDF, RDFS, SCHEMA_RDF_MAX_QUADS, SH, Store, type NotTakenEntry, type Place, type SchemaSource, type Stmt, type TakenEntry,
} from './schema-from-rdf-store.js';

export { SHACL_CONSTRAINTS, SCHEMA_RDF_MAX_QUADS };
export type { ConstraintRow, SchemaChange, SchemaMode, SchemaRefusal, SchemaSource, StoredTypeSchemas, TypeSchemasByKind, TakenEntry, NotTakenEntry };

export interface SchemaFromRdfOptions {
  /** Which declarations to read: `declared` for OWL and RDFS classes and properties, `shacl` for shapes. */
  from: readonly SchemaSource[];
  mode: SchemaMode;
  /** The space's reverse names (`addressNames(meta, source?)`), so addresses under its vocabulary (or a source's) read to their derived names. */
  names: AddressNames;
  /** The type schemas the space has (`meta.typeSchemas`), for `expand` and `update`, and to refuse `generate` into a space with a type. */
  stored?: StoredTypeSchemas;
}

export interface SchemaFromRdfAnswer {
  typeSchemas: TypeSchemasByKind;
  taken: TakenEntry[];
  notTaken: NotTakenEntry[];
  changes: SchemaChange[];
  refusals: SchemaRefusal[];
  counts: { statements: number; taken: number; notTaken: number; outside: number };
}

const SOURCES: readonly string[] = Object.freeze(['declared', 'shacl']);
const MODES: readonly string[] = Object.freeze(['generate', 'expand', 'update']);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The first statement a draft's claims and structure give: where a refusal about the draft points when nothing says more. */
function anchorOf(draft: Draft): Stmt | undefined {
  return draft.structure[0]?.stmt ?? draft.claims[0]?.stmt;
}

/** Name every statement the draft holds that is not yet named: it has no name a schema can hold. */
function dropDraft(ctx: ReadContext, draft: Draft, why: 'unreadable-value', message: string): void {
  for (const s of [...draft.structure.map(x => x.stmt), ...draft.claims.map(c => c.stmt)]) if (!ctx.ledger.isUsed(s)) ctx.ledger.name(s, why, message);
}

// -- types: kind, name, collisions -------------------------------------------------------------------------------------------------------

function finalizeTypes(ctx: ReadContext): void {
  const live: TypeDraft[] = [];
  for (const draft of ctx.drafts.values()) {
    const at = draft.classStmts[0] ?? draft.labelStmts[0];
    if (at === undefined) { draft.broken = true; continue; }
    if (draft.classStmts[0] !== undefined && draft.labelStmts[0] !== undefined) {
      refuseWith(ctx, 'contradiction', 'a term is declared both a record type (a class) and an edge label (a property): it cannot be both', [draft.classStmts[0], draft.labelStmts[0]]);
      draft.broken = true;
      continue;
    }
    const first = draft.kinds[0];
    const other = first === undefined ? undefined : draft.kinds.find(k => k.kind !== first.kind);
    if (first !== undefined && other !== undefined) {
      refuseWith(ctx, 'contradiction', `the file gives one type two kinds: ${first.kind} and ${other.kind}`, [first.stmt, other.stmt]);
      draft.broken = true;
      continue;
    }
    const kind: KnowledgeType = first?.kind ?? (draft.labelStmts.length > 0 ? 'edge' : 'entity');
    if ((draft.classStmts.length > 0) === (kind === 'edge')) {
      refuseWith(ctx, 'contradiction', kind === 'edge' ? 'a class is read as an edge label by its address' : 'a property is read as a record type by its address', [at, first?.stmt ?? at]);
      draft.broken = true;
      continue;
    }
    const local = localPart(draft.termIri);
    if (local !== '') draft.nameBy(local, 'local', 'declared');
    const choice = chooseName(draft.names, validTypeName);
    if (!choice.ok) {
      draft.broken = true;
      if (choice.reason === 'conflict') {
        refuseWith(ctx, 'contradiction', `a type has two names: ${choice.a.text} and ${choice.b.text}`, [choice.a.stmt ?? at, choice.b.stmt ?? at].filter((s, i, all) => all.indexOf(s) === i));
      } else {
        const message = choice.reason === 'invalid' ? 'a name no schema can hold (empty, too long, or an object\'s internals)' : 'no name: no label, and the address has no local part';
        for (const s of [...draft.classStmts, ...draft.labelStmts]) ctx.ledger.name(s, 'unreadable-value', message);
      }
      continue;
    }
    draft.kind = kind;
    draft.name = choice.name;
    const where: Place = { kind, type: choice.name };
    for (const c of choice.agreeing) if (c.stmt !== undefined) ctx.ledger.take(c.source, c.stmt, '(name)', where);
    for (const c of choice.demoted) if (c.stmt !== undefined) ctx.ledger.name(c.stmt, 'second-value', `the type is named ${choice.name}, by its address or its other names: this ${c.level} says another`, where);
    live.push(draft);
  }
  for (const draft of live) {
    if (draft.kind === undefined || draft.name === undefined) continue;
    const key = nameKey(draft.kind, draft.name);
    const held = ctx.byName.get(key);
    if (held === undefined) { ctx.byName.set(key, draft); continue; }
    const a = held.classStmts[0] ?? held.labelStmts[0];
    const b = draft.classStmts[0] ?? draft.labelStmts[0];
    refuseWith(ctx, 'name-collision', `two addresses give one name: ${held.termIri} and ${draft.termIri} are both the ${draft.kind} type ${draft.name}`, [a, b].filter((s): s is Stmt => s !== undefined));
    held.broken = true;
    draft.broken = true;
    ctx.byName.delete(key);
  }
}

// -- fields: claims, merged, taken, built -------------------------------------------------------------------------------------------------

/** Take what a draft's structural statements name, now that it has its place. */
function emitStructure(ctx: ReadContext, draft: Draft, where: Place): void {
  for (const s of draft.structure) ctx.ledger.take(s.source, s.stmt, s.field, where, s.value, s.declared === undefined ? {} : { declared: s.declared });
}

/**
 * Believe the claims of a draft: a field whose claims agree is its value and each claim is taken; a field whose claims differ is a refusal
 * naming two of them. A description is the exception: a type holds one, the first (shapes before axioms) wins and a different second is named.
 */
function settle(ctx: ReadContext, draft: Draft, where: Place): Merged['fields'] | undefined {
  const described = draft.claims.filter(c => c.field === 'description');
  const winner = [...described].sort((x, y) => (x.source === y.source ? x.order - y.order : x.source === 'shacl' ? -1 : 1))[0];
  const kept = draft.claims.filter(c => c.field !== 'description' || winner === undefined || c.value === winner.value);
  for (const c of described) if (winner !== undefined && c.value !== winner.value) ctx.ledger.name(c.stmt, 'second-value', 'a type or property holds one description: the first the file states is kept', where);
  const merged = mergeClaims(kept);
  for (const { field, a, b } of merged.conflicts) {
    refuseWith(ctx, 'contradiction', `${field} is stated two ways: ${String(JSON.stringify(a.value))} and ${String(JSON.stringify(b.value))}`, [a.stmt, b.stmt], { where, field });
  }
  if (merged.conflicts.length > 0) return undefined;
  for (const [field, { value, claims }] of merged.fields) {
    if (field === 'iri' && !IriZ.safeParse(value).success) {
      for (const c of claims) ctx.ledger.name(c.stmt, 'unreadable-value', 'an address a schema can hold (an absolute address with no character an RDF writer cannot spell)', where);
      merged.fields.delete(field);
      continue;
    }
    for (const c of claims) ctx.ledger.take(c.source, c.stmt, field, where, value);
  }
  return merged.fields;
}

const valueOf = (fields: Merged['fields'], field: string): unknown => fields.get(field)?.value;

/** The definition of a property from its believed fields. */
function propertyDef(fields: Merged['fields']): Record<string, unknown> {
  const def: Record<string, unknown> = {};
  for (const field of ['iri', 'description', 'type', 'enum', 'minimum', 'maximum', 'pattern', 'mergeFn']) {
    const value = valueOf(fields, field);
    if (value !== undefined) def[field] = value;
  }
  if (valueOf(fields, 'required') === true) def['required'] = true;
  const dflt = valueOf(fields, 'default');
  if (dflt !== undefined) def['default'] = dflt;
  return def;
}

/** The definition of a type from its believed fields and its properties. */
function typeDef(fields: Merged['fields'], props: Record<string, unknown>): Record<string, unknown> {
  const def: Record<string, unknown> = {};
  const ref = valueOf(fields, '$ref');
  if (ref !== undefined) { def['$ref'] = ref; return def; }
  for (const field of ['iri', 'description', 'namingPattern']) {
    const value = valueOf(fields, field);
    if (value !== undefined) def[field] = value;
  }
  const retention: Record<string, unknown> = {};
  for (const member of ['days', 'contentDays']) { const v = valueOf(fields, `retention.${member}`); if (v !== undefined) retention[member] = v; }
  if (Object.keys(retention).length > 0) def['retention'] = retention;
  const embeddings = valueOf(fields, 'suppressEmbeddings');
  if (embeddings !== undefined) def['suppressEmbeddings'] = embeddings;
  const due = valueOf(fields, 'whenDuePasses');
  if (due !== undefined) def['whenDuePasses'] = due;
  const endpoints: Record<string, unknown> = {};
  for (const side of ['from', 'to']) { const v = valueOf(fields, `endpoints.${side}`); if (v !== undefined) endpoints[side] = v; }
  if (Object.keys(endpoints).length > 0) def['endpoints'] = endpoints;
  if (valueOf(fields, 'functional') === true) def['functional'] = true;
  const rules: Record<string, unknown> = {};
  for (const [field, { value }] of fields) if (field.startsWith('rules.')) rules[field.slice('rules.'.length)] = value;
  if (Object.keys(rules).length > 0) def['rules'] = rules;
  if (Object.keys(props).length > 0) def['propertySchemas'] = props;
  return def;
}

/** The properties of a type, named and settled: their names (refused when two addresses give one), their claims, their definitions. */
function buildProperties(ctx: ReadContext, draft: TypeDraft, where: Place): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const held = new Map<string, PropDraft>();
  const refused = new Set<PropDraft>();
  for (const prop of draft.props.values()) {
    const at = anchorOf(prop);
    const local = localPart(prop.termIri);
    if (local !== '') prop.nameBy(local, 'local', 'declared');
    const choice = chooseName(prop.names, validPropertyKey);
    if (!choice.ok) {
      refused.add(prop);
      if (choice.reason === 'conflict') {
        refuseWith(ctx, 'contradiction', `a property has two names: ${choice.a.text} and ${choice.b.text}`, [choice.a.stmt ?? at, choice.b.stmt ?? at].filter((s, i, all): s is Stmt => s !== undefined && all.indexOf(s) === i), { where });
      } else dropDraft(ctx, prop, 'unreadable-value', choice.reason === 'invalid' ? 'a name no schema can hold as a property key' : 'no name: no label, and the address has no local part');
      continue;
    }
    prop.name = choice.name;
    const placed: Place = { ...where, prop: choice.name };
    for (const c of choice.agreeing) if (c.stmt !== undefined) ctx.ledger.take(c.source, c.stmt, '(key)', placed);
    for (const c of choice.demoted) if (c.stmt !== undefined) ctx.ledger.name(c.stmt, 'second-value', `the property is named ${choice.name}, by its address or its other names: this ${c.level} says another`, placed);
    const other = held.get(choice.name);
    if (other !== undefined) {
      refuseWith(ctx, 'name-collision', `two addresses give one name: ${other.termIri} and ${prop.termIri} are both the property ${choice.name} of ${where.kind} type ${where.type}`, [anchorOf(other), at].filter((s): s is Stmt => s !== undefined), { where });
      refused.add(other);
      refused.add(prop);
      continue;
    }
    held.set(choice.name, prop);
  }
  for (const [name, prop] of held) {
    if (refused.has(prop)) continue;
    const placed: Place = { ...where, prop: name };
    emitStructure(ctx, prop, placed);
    const fields = settle(ctx, prop, placed);
    if (fields !== undefined) out[name] = propertyDef(fields);
  }
  return out;
}

/** The types the file builds, settled; each is checked by the schema package's own parse before it is answered. */
function buildTypes(ctx: ReadContext): BuiltType[] {
  const built: BuiltType[] = [];
  for (const draft of ctx.drafts.values()) {
    if (draft.broken || draft.kind === undefined || draft.name === undefined) continue;
    const where: Place = { kind: draft.kind, type: draft.name };
    emitStructure(ctx, draft, where);
    const props = buildProperties(ctx, draft, where);
    const fields = settle(ctx, draft, where);
    if (fields === undefined) continue;
    const ref = fields.get('$ref');
    const own = [...fields.entries()].find(([f]) => f !== '$ref' && f !== 'iri');
    if (ref !== undefined && (own !== undefined || Object.keys(props).length > 0)) {
      refuseWith(ctx, 'contradiction', 'a type refers to a library entry and also states fields of its own', [ref.claims[0]!.stmt, ...(own === undefined ? [] : [own[1].claims[0]!.stmt])], { where });
      continue;
    }
    const def = typeDef(fields, props);
    const parsed = TypeSchemaZ.safeParse(def);
    if (!parsed.success) {
      refuseWith(ctx, 'invalid-schema', `the ${draft.kind} type ${draft.name} read from the file is no type schema: ${refusalOfParse(parsed.error).error}`, [], { where });
      continue;
    }
    built.push({ kind: draft.kind, name: draft.name, def });
  }
  return built.sort((a, b) => KNOWLEDGE_TYPES.indexOf(a.kind) - KNOWLEDGE_TYPES.indexOf(b.kind) || byName(a.name, b.name));
}

// -- the schema groups of a data file (Q-955) ------------------------------------------------------------------------------------------------

/**
 * The classes a subject is typed with when it declares something the mapping reads, by the source that reads it: the one list, never a namespace
 * prefix (an `owl:NamedIndividual` or an `owl:Thing` instance is a record, and so is a SHACL validation report). The classes the mapping asks the
 * file for (`withType` in `schema-from-rdf-owl.ts` and `-shacl.ts`) are all here, which `the-rdf-import-takes-as-schema-only-what-declares-one`
 * holds against their source, so the selector and the mapping cannot drift apart. `owl:Restriction` and `rdfs:Datatype` are the nodes a class or a
 * range is built from; the other OWL property kinds are declarations a file states beside the two the mapping builds from.
 */
export const SCHEMA_DECLARING_CLASSES: Readonly<Record<SchemaSource, readonly string[]>> = Object.freeze({
  declared: Object.freeze([
    OWL('Ontology'), OWL('Class'), OWL('ObjectProperty'), OWL('DatatypeProperty'), OWL('AnnotationProperty'), OWL('FunctionalProperty'), OWL('Restriction'),
    RDFS('Class'), RDFS('Datatype'), RDF('Property'),
  ]),
  shacl: Object.freeze([SH('NodeShape'), SH('PropertyShape')]),
});
/** The predicates only a declaration states, by source: an RDFS declaration of a class or property, and what makes a shape of one with no type. */
export const SCHEMA_DECLARING_PREDICATES: Readonly<Record<SchemaSource, readonly string[]>> = Object.freeze({
  declared: Object.freeze([RDFS('subClassOf'), RDFS('subPropertyOf'), RDFS('domain'), RDFS('range')]),
  shacl: Object.freeze([SH('targetClass'), SH('targetSubjectsOf'), SH('targetObjectsOf'), SH('targetNode'), SH('path'), SH('property')]),
});

/** The test of a declaring group for the sources asked: the sets are made once, the test is called per group. */
function declaringTest(from: readonly SchemaSource[]): (quads: readonly Quad[]) => boolean {
  const classes = new Set(from.flatMap(source => SCHEMA_DECLARING_CLASSES[source]));
  const predicates = new Set(from.flatMap(source => SCHEMA_DECLARING_PREDICATES[source]));
  const type = RDF('type');
  return (quads) => quads.some(q => predicates.has(q.predicate.value) || (q.predicate.value === type && q.object.kind === 'iri' && classes.has(q.object.value)));
}

/**
 * Is the subject of `quads` a declaration of a source in `from` (both by default): typed with one of {@link SCHEMA_DECLARING_CLASSES}, or stating
 * one of {@link SCHEMA_DECLARING_PREDICATES} of its own (a shape with no type, a property with only a domain). A data record is typed with a
 * class of a vocabulary, never with one of these.
 */
export function isSchemaGroup(quads: readonly Quad[], from: readonly SchemaSource[] = SOURCES as readonly SchemaSource[]): boolean {
  return declaringTest(from)(quads);
}

/** A group of a sorted file as the selector reads it: its key, its graph, its subject and its quads. */
export interface SchemaGroupInput { key: string; graph?: { value: string }; subject: { kind: string }; quads: Quad[] }

/** The schema groups of a file: their keys and their quads, or `over` when their quads pass the bound. */
export type SchemaGroups = { kind: 'groups'; keys: Set<string>; quads: Quad[] } | { kind: 'over'; limit: number };

/**
 * The groups of a data file the schema option builds from (Q-955), read in two passes over `groups` (a sorted file, read again for each pass):
 * every {@link isSchemaGroup}, and every blank node such a group reaches through its objects, followed through blank nodes to any depth (a
 * blank-node property shape, `sh:property [ ... ]`, its `sh:in` list, an OWL restriction). `keyOfBlank` gives a blank object's group key in its
 * graph (the spool's own key). Their quads are collected up to `max`; one more answers `over`, before anything maps them. `max` null: the keys
 * alone, in one pass (an act that skips the groups a door already bounded).
 */
export async function schemaGroupsOf(
  groups: () => AsyncIterable<SchemaGroupInput>, keyOfBlank: (id: string, graph: { value: string } | undefined) => string, max: number | null,
  from: readonly SchemaSource[] = SOURCES as readonly SchemaSource[],
): Promise<SchemaGroups> {
  const declares = declaringTest(from);
  const keys = new Set<string>();
  const reached: string[] = [];
  /** A blank subject's blank objects, by key: only these edges are kept, so a file of records holds nothing here. */
  const blankEdges = new Map<string, string[]>();
  const blankObjectsOf = (g: SchemaGroupInput): string[] =>
    g.quads.filter(q => q.object.kind === 'blank').map(q => keyOfBlank((q.object as { id: string }).id, g.graph));
  for await (const g of groups()) {
    if (declares(g.quads)) { keys.add(g.key); reached.push(...blankObjectsOf(g)); continue; }
    if (g.subject.kind === 'blank') {
      const objects = blankObjectsOf(g);
      if (objects.length > 0) blankEdges.set(g.key, objects);
    }
  }
  while (reached.length > 0) {
    const key = reached.pop()!;
    if (keys.has(key)) continue;
    keys.add(key);
    reached.push(...(blankEdges.get(key) ?? []));
  }
  const quads: Quad[] = [];
  if (keys.size === 0 || max === null) return { kind: 'groups', keys, quads };
  for await (const g of groups()) {
    if (!keys.has(g.key)) continue;
    if (quads.length + g.quads.length > max) return { kind: 'over', limit: max };
    quads.push(...g.quads);
  }
  return { kind: 'groups', keys, quads };
}

// -- the entry -------------------------------------------------------------------------------------------------------------------------------

function checkOptions(options: SchemaFromRdfOptions): void {
  if (!Array.isArray(options.from) || options.from.length === 0 || options.from.some(f => !SOURCES.includes(f))) {
    throw new TypeError('from names the declarations to read: declared (OWL and RDFS classes and properties), shacl (shapes), or both');
  }
  if (!MODES.includes(options.mode)) throw new TypeError('mode is generate, expand or update');
  if (options.names === undefined || options.names === null) throw new TypeError('names are the space\'s reverse names (addressNames)');
}

/**
 * The type schemas the classes, properties and shapes of `quads` give, and what became of each statement. Never throws for what a file says:
 * a contradiction, a collision, a stored schema `generate` may not build into and a file over {@link SCHEMA_RDF_MAX_QUADS} are `refusals`.
 *
 * @throws TypeError for options that are none (a mode that is not one, no source of declarations, no names).
 */
export function schemaFromRdf(quads: Iterable<Quad>, options: SchemaFromRdfOptions): SchemaFromRdfAnswer {
  checkOptions(options);
  const held: Quad[] = [];
  for (const quad of quads) {
    held.push(quad);
    if (held.length > SCHEMA_RDF_MAX_QUADS) {
      return {
        typeSchemas: normalizedStored(options.stored), taken: [], notTaken: [], changes: [],
        refusals: [{ code: 'too-large', message: `a schema file holds at most ${SCHEMA_RDF_MAX_QUADS} statements`, statements: [] }],
        counts: { statements: held.length, taken: 0, notTaken: 0, outside: held.length },
      };
    }
  }
  const store = new Store(held);
  const ledger = new Ledger(store);
  const ctx: ReadContext = {
    store, ledger, names: options.names, drafts: new Map(), byName: new Map(), owned: new Set(), refusals: [], reifiers: [], skip: new Set(),
  };
  const sources = new Set<string>(options.from);
  if (sources.has('declared')) discoverDeclared(ctx);
  if (sources.has('shacl')) discoverShapes(ctx);
  finalizeTypes(ctx);
  if (sources.has('declared')) readDeclared(ctx);
  if (sources.has('shacl')) readShapes(ctx);
  const built = buildTypes(ctx);
  ledger.sweep(ctx.owned, leftoverWhy);

  const stored = normalizedStored(options.stored);
  if (options.mode === 'generate') {
    const have = firstStoredType(stored);
    if (have !== undefined) ctx.refusals.push({ code: 'schema-not-empty', message: `generate builds into a space with no type, and this one has ${have}: use expand or update`, statements: [] });
  }
  let result: { typeSchemas: TypeSchemasByKind; changes: SchemaChange[] };
  if (ctx.refusals.length > 0) result = { typeSchemas: stored, changes: [] };
  else if (options.mode === 'generate') result = buildWhole(built);
  else result = meetStored(options.mode, built, options.stored, ledger);
  const entries = ledger.entries();
  return { typeSchemas: result.typeSchemas, taken: entries.taken, notTaken: entries.notTaken, changes: result.changes, refusals: ctx.refusals, counts: entries.counts };
}
