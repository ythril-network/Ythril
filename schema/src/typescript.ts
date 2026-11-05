/**
 * A space's type schemas written as TypeScript declarations, for an app that reads or writes the space's records with types: one call,
 * {@link typesOfSpaceMeta}, answering the source and what it could not carry.
 *
 * ## What the source says
 *
 * Per declared type two interfaces and one map over all of them:
 *
 * - `<Kind><Name>Properties` is the strict create contract: exactly the declared keys, a required property without a default is a
 *   required member, every other one optional. It is what `validationMode: 'strict'` accepts; warn and off accept more, and the type
 *   does not change with the mode, so a source does not silently loosen when a space does.
 * - `<Kind><Name>StoredProperties` is what a stored record may hold: every declared member optional and `unknown`, plus any other key.
 *   A stored value may predate the schema, may have been accepted under warn or off, and the instance writes keys of its own.
 * - `SpaceTypes` maps each knowledge type and each real type name, as a string literal, to `{ properties, stored }`: a lookup needs no
 *   identifier, and a name no identifier can spell still reaches its types.
 *
 * ## What is deliberate in here
 *
 * **It never refuses as a whole.** An app hands it what the meta answer gave it, which carries `spaceId`, `stats` and the server-owned
 * fields, library types expanded beside their `$ref`, and types a newer server wrote. Each type is parsed on its own with the package's own
 * parse, after the tolerant reader has stripped the fields this release does not know; a type the parse still refuses is skipped and
 * reported in the parse's own words, and the rest converts.
 *
 * **Nothing is dropped without a word.** What TypeScript cannot carry (a type's CEL rules, its naming pattern, retention, a space's rules)
 * is reported in `untranslated`, with one of {@link UNTRANSLATED_REASONS}. The reported type fields are every field of the inline body
 * except the translated ones, so a field added to the body is reported until someone translates it.
 *
 * **Schema text is data.** A type schema is written by whoever may edit the meta, and the source is compiled into an app. Names and values
 * reach code only as string literals or as identifiers built from `\p{ID_Start}`/`\p{ID_Continue}`; every other text goes through one
 * comment writer ({@link commentText}).
 *
 * **Linear.** The identifier allocator keeps a next-suffix counter per base, so many names that reduce to one identifier cost one probe
 * each, and an enum longer than {@link ENUM_LITERAL_MAX} is written as its base type.
 */
import { KNOWLEDGE_TYPES, type KnowledgeType, type PropertySchema, type TypeSchema } from './vocabulary.js';
import { withSchemaLibrary, type SchemaLibraryEntryLike } from './library.js';
import { libraryEntryNameOf } from './library-ref-name.js';
import { InlineTypeSchemaZ, SpaceMetaBody, parseInlineDefinition, readKnownTypeDefinition } from './space-meta.js';
import { PER_TYPE_META_FIELD } from './meta-fields.js';
import { isPlainObject, ownValue } from './plain-object.js';
import { NAME_QUOTED, peerText } from './text.js';

/**
 * Why an `untranslated` entry was written, the whole list: a reason added is a deliberate edit an app's switch can see.
 *
 * - `not-translated`: a field TypeScript cannot carry (a type's rules, naming pattern, retention, a space's rules), named in `field`.
 * - `type-skipped`: a type the parse refuses, or one that is not an object; `detail` has the parse's words.
 * - `unknown-field`: a field this release does not know (a newer server wrote it), stripped before the parse; named in `field`.
 * - `unresolved-ref`: a `$ref` no library entry answers; the type is written open.
 * - `wrong-kind-ref`: a `$ref` to an entry filed under another knowledge type; the type is written open, `detail` names that kind.
 * - `kind-not-verified`: a type converted from the definition beside its `$ref` with no library entry to confirm the kind.
 * - `enum-emptied`: an enum none of whose values has the declared type; the member is `never`.
 * - `enum-too-long`: an enum longer than {@link ENUM_LITERAL_MAX}; the member is its base type.
 * - `renamed`: a type whose identifier was taken; `detail` is the one it got.
 * - `no-type-schemas`: a meta with no type schemas to read (missing, or not an object, or the meta itself is not one).
 */
export const UNTRANSLATED_REASONS = [
  'not-translated', 'type-skipped', 'unknown-field', 'unresolved-ref', 'wrong-kind-ref', 'kind-not-verified', 'enum-emptied',
  'enum-too-long', 'renamed', 'no-type-schemas',
] as const;

/**
 * The most values an enum is written with as a union of literals. A longer one is its base type and reported: a schema must not make an
 * app's compiler hold a union of thousands.
 */
export const ENUM_LITERAL_MAX = 200;

/** One thing the source does not say. `kind` and `type` name the type it is about, `field` the field, `detail` what more there is. */
export interface Untranslated {
  reason: (typeof UNTRANSLATED_REASONS)[number];
  kind?: KnowledgeType;
  type?: string;
  field?: string;
  detail?: string;
}

/** What {@link typesOfSpaceMeta} takes beside the meta: the schema-library entries the meta's `$ref`s name. */
export interface TypeScriptOptions {
  library?: readonly SchemaLibraryEntryLike[];
}

/** What {@link typesOfSpaceMeta} answers: the TypeScript source, and what it could not carry. */
export interface TypeScriptSource {
  source: string;
  untranslated: Untranslated[];
}

/**
 * The TypeScript type each declared property type is written as, which is also the `typeof` an enum value of that type has: a date is
 * stored as an ISO string. Keyed by the vocabulary's own type, so a property type added there fails the build here until it is written.
 */
const MEMBER_TYPE = { string: 'string', number: 'number', boolean: 'boolean', date: 'string' } as const satisfies
  Record<NonNullable<PropertySchema['type']>, 'string' | 'number' | 'boolean'>;

/** The type fields the source carries: `description` as a comment, `propertySchemas` as the members. Every other one is reported. */
const TRANSLATED_TYPE_FIELDS: ReadonlySet<string> = new Set(['description', 'propertySchemas'] satisfies (keyof TypeSchema)[]);

/** The type fields reported when a type sets them: the inline body's, less the translated ones, read from the body. */
const REPORTED_TYPE_FIELDS = Object.keys(InlineTypeSchemaZ.shape).filter(f => !TRANSLATED_TYPE_FIELDS.has(f)) as (keyof TypeSchema)[];

/**
 * The space fields that say nothing about a property's type: what the space is for, how strictly it judges a write, defaults for the
 * types. Every other field of the meta body but the type schemas is reported when set, so a field added to the body is reported until
 * someone classifies it.
 */
const IRRELEVANT_SPACE_FIELDS: ReadonlySet<string> = new Set([
  'purpose', 'usageNotes', 'validationMode', 'strictLinkage', 'suppressEmbeddings', 'whenDuePasses',
]);

/** The space fields reported when a meta sets them, read from the meta body. */
const REPORTED_SPACE_FIELDS = Object.keys(SpaceMetaBody.shape).filter(f => f !== PER_TYPE_META_FIELD && !IRRELEVANT_SPACE_FIELDS.has(f));

/**
 * The name of the map the source declares besides the per-type interfaces (no type is allocated it), and the two members each of its
 * entries has. Read by BOTH directions (`typesOfSpaceMeta` writes them, `@ythril/schema/from-typescript` reads them), so a rename of the
 * map or a member is one edit and a source one direction wrote is never one the other cannot find. Not part of either entry's surface.
 */
export const SPACE_TYPES = 'SpaceTypes';
export const SPACE_TYPE_PROPERTIES = 'properties';
export const SPACE_TYPE_STORED = 'stored';

/**
 * Schema text made safe inside a block comment: `*` `/` cannot close it, a line break (LF, CR, U+2028, U+2029) cannot start a new comment
 * line, and a leading `@` cannot start a directive (`@ts-ignore`) or a JSDoc tag. The one writer of schema text into a comment: a second
 * one would be the one that forgets a line separator. No `//` comment ever carries schema text.
 */
function commentText(text: unknown): string {
  return String(text)
    .replace(/\*\//g, '*\\/')
    .replace(/\r\n|[\r\n\u2028\u2029]/g, ' ')
    .replace(/^(\s*)@/, '$1\\@');
}

/** A value as a TypeScript literal: JSON's escaping, and the two line separators escaped too, so no raw one reaches the source. */
function literal(value: string | number | boolean): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** `word` with its first code point upper-cased, when the upper case is still an identifier character (`ß` is, a few are not). */
function capitalised(word: string): string {
  const first = String.fromCodePoint(word.codePointAt(0)!);
  const upper = first.toUpperCase();
  return (/^\p{ID_Continue}+$/u.test(upper) ? upper : first) + word.slice(first.length);
}

/**
 * A type name as the Pascal-case part of an identifier: the runs of `\p{ID_Continue}` characters, each capitalised, joined; `Type` when
 * none is left. Never at the start of an identifier (the kind is), so a run that starts with a digit is fine.
 */
function pascal(name: string): string {
  return name.split(/[^\p{ID_Continue}]+/u).filter(w => w !== '').map(capitalised).join('') || 'Type';
}

/**
 * The identifiers of one source: each type gets a base whose `Properties` and `StoredProperties` no other type has. A base that is
 * taken gets the next numeric suffix from a counter kept per base, so names that all reduce to one base cost one probe each, not a scan
 * from 2 for every one of them.
 */
class Identifiers {
  private readonly taken = new Set<string>([SPACE_TYPES]);
  private readonly next = new Map<string, number>();

  /** The base for `wanted`, now taken. */
  allocate(wanted: string): string {
    let n = this.next.get(wanted) ?? 1;
    let base = n === 1 ? wanted : `${wanted}${n}`;
    while (this.taken.has(`${base}Properties`) || this.taken.has(`${base}StoredProperties`)) base = `${wanted}${++n}`;
    this.next.set(wanted, n + 1);
    this.taken.add(`${base}Properties`);
    this.taken.add(`${base}StoredProperties`);
    return base;
  }
}

/** One type, read: its parsed definition, or `open` when its properties are not known (a reference nothing resolved). */
type Read = { open: false; schema: TypeSchema } | { open: true };

/** Reports one entry about the type being read. */
type Report = (entry: Omit<Untranslated, 'kind' | 'type'>) => void;

/** The library entries that can answer a `$ref`, by name: the first of a name wins, as a parse's lookup does; an entry not shaped like one is left out. */
function entriesByName(library: readonly unknown[]): Map<string, SchemaLibraryEntryLike> {
  const kinds = new Set<string>(KNOWLEDGE_TYPES);
  const byName = new Map<string, SchemaLibraryEntryLike>();
  for (const entry of library) {
    const name = ownValue(entry, 'name');
    const kind = ownValue(entry, 'knowledgeType');
    if (typeof name !== 'string' || typeof kind !== 'string' || !kinds.has(kind) || byName.has(name)) continue;
    byName.set(name, entry as SchemaLibraryEntryLike);
  }
  return byName;
}

/** One inline definition, the fields this release does not know stripped and reported, parsed for `kind`; `null` when it is skipped. */
function parseDefinition(kind: KnowledgeType, def: unknown, report: Report): Read | null {
  if (!isPlainObject(def)) { report({ reason: 'type-skipped', detail: 'not an object' }); return null; }
  const known = readKnownTypeDefinition(def);
  for (const field of known.unknown) report({ reason: 'unknown-field', field });
  const parse = parseInlineDefinition(InlineTypeSchemaZ, kind, known.def);
  if (!parse.ok) { report({ reason: 'type-skipped', detail: parse.message }); return null; }
  return { open: false, schema: parse.schema };
}

/**
 * One type as the meta holds it. A `$ref` is split off: alone, or beside the server's unresolved mark, it takes the entry from the
 * library; beside a definition (the meta answer's expansion), the definition is the type, its kind confirmed by the entry when there is
 * one. An entry of another kind, or none for a bare reference, gives an open type. The definition is never handed to the body's
 * library take-back, so no reference shape can throw.
 */
function readType(kind: KnowledgeType, def: unknown, library: Map<string, SchemaLibraryEntryLike>, report: Report): Read | null {
  const ref = ownValue(def, '$ref');
  if (typeof ref !== 'string') return parseDefinition(kind, def, report);
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(def as object)) if (key !== '$ref' && key !== '_unresolvedRef') rest[key] = ownValue(def, key);
  const name = libraryEntryNameOf(ref);
  const entry = name === undefined ? undefined : library.get(name);
  const quoted = peerText(ref, { max: NAME_QUOTED });
  if (entry && entry.knowledgeType !== kind) { report({ reason: 'wrong-kind-ref', detail: entry.knowledgeType }); return { open: true }; }
  if (Object.keys(rest).length === 0) {
    if (!entry) { report({ reason: 'unresolved-ref', detail: quoted }); return { open: true }; }
    return parseDefinition(kind, entry.schema, report);
  }
  if (!entry) report({ reason: 'kind-not-verified', detail: quoted });
  return parseDefinition(kind, rest, report);
}

/** The member type of one declared property; an untyped one is `value`, the kind's. An enum is filtered by the declared type. */
function memberType(property: PropertySchema, value: string, report: Report): string {
  const base = property.type ? MEMBER_TYPE[property.type] : value;
  if (!Array.isArray(property.enum)) return base;
  const declared = property.type ? MEMBER_TYPE[property.type] : undefined;
  const values = [...new Set(property.enum.filter(v => declared === undefined || typeof v === declared))];
  if (values.length > ENUM_LITERAL_MAX) { report({ reason: 'enum-too-long' }); return base; }
  if (values.length === 0) { report({ reason: 'enum-emptied' }); return 'never'; }
  return values.map(literal).join(' | ');
}

/** The JSDoc of one property: what the type cannot say about it, as text. */
function propertyDoc(property: PropertySchema): string {
  const notes: string[] = [];
  if (property.description) notes.push(commentText(property.description));
  if (property.type) notes.push(`type ${property.type}`);
  if (property.pattern !== undefined) notes.push(`pattern ${commentText(property.pattern)}`);
  if (property.minimum !== undefined) notes.push(`minimum ${property.minimum}`);
  if (property.maximum !== undefined) notes.push(`maximum ${property.maximum}`);
  if (property.default !== undefined) notes.push(`default ${commentText(JSON.stringify(property.default))}`);
  if (property.mergeFn) notes.push(`mergeFn ${commentText(property.mergeFn)}`);
  if (property.required) notes.push('required: a write must carry it, and not as null or an empty string');
  return notes.length === 0 ? '' : `  /**\n${notes.map(n => `   * ${n}`).join('\n')}\n   */\n`;
}

/** The two interfaces of one type. */
function declarations(base: string, kind: KnowledgeType, read: Read, report: Report): string[] {
  // Entity property values are primitives; a fact's, an edge's and a chrono entry's may be any JSON.
  const value = kind === 'entity' ? 'string | number | boolean' : 'unknown';
  const typeDoc = !read.open && read.schema.description ? `/** ${commentText(read.schema.description)} */\n` : '';
  const properties = read.open ? undefined : read.schema.propertySchemas;
  const keys = properties ? Object.keys(properties) : [];
  if (!properties || keys.length === 0) {
    return [
      `${typeDoc}export interface ${base}Properties {\n  [key: string]: ${value};\n}`,
      `export interface ${base}StoredProperties {\n  [key: string]: unknown;\n}`,
    ];
  }
  const create: string[] = [];
  const stored: string[] = [];
  for (const key of keys) {
    const property = properties[key]!;
    const type = memberType(property, value, entry => report({ ...entry, field: `propertySchemas.${key}` }));
    const doc = propertyDoc(property);
    const optional = property.required === true && property.default === undefined ? '' : '?';
    create.push(`${doc}  ${literal(key)}${optional}: ${type};`);
    stored.push(`${doc}  ${literal(key)}?: unknown;`);
  }
  return [
    `${typeDoc}export interface ${base}Properties {\n${create.join('\n')}\n}`,
    `export interface ${base}StoredProperties {\n${stored.join('\n')}\n  [key: string]: unknown;\n}`,
  ];
}

/** The leading comment of every source. Says in prose what the types leave out; it lists no value the server holds. */
const HEADER = `/**
 * TypeScript types for a Ythril space's properties, written by @ythril/schema typesOfSpaceMeta. A snapshot: regenerate it after a
 * schema change or a validationMode change.
 *
 * <Kind><Name>Properties is the strict create contract (validationMode strict): a required property without a default is required, and
 * no undeclared key is accepted. A patch is Partial<...> of it. Under warn or off the instance accepts more than these types state.
 * <Kind><Name>StoredProperties is what a stored record may hold: every member unknown, and keys the schema never declared or no longer
 * declares, among them keys the instance writes itself.
 * SpaceTypes lists the declared types only: a kind with no declared type accepts any type, a fact may be untyped, an edge may carry a
 * label the server writes, and a space with no chrono type accepts the server's built-in chrono types.
 */`;

/**
 * A space meta's type schemas as TypeScript: `<Kind><Name>Properties` (the strict create contract), `<Kind><Name>StoredProperties` (what a
 * stored record may hold) and the `SpaceTypes` map, with every field the source does not carry reported in `untranslated`.
 *
 * `meta` is a space meta in any shape an app has it: the GET meta answer (its `spaceId`, `stats` and server-owned fields are ignored, a
 * library type expanded beside its `$ref` is read from the definition), a stored or written meta, or one a newer server wrote (a field this
 * release does not know is stripped and reported). Convert with the package of the server the meta was read from, or a newer one. Pass
 * `library` to resolve a bare `$ref` and to confirm an expanded one's kind. Never throws and never refuses as a whole.
 */
export function typesOfSpaceMeta(meta: unknown, options: TypeScriptOptions = {}): TypeScriptSource {
  const given = ownValue(options, 'library');
  const library = Array.isArray(given) ? (given as readonly unknown[]) : [];
  const byName = entriesByName(library);
  return withSchemaLibrary([...byName.values()], () => convert(meta, byName));
}

/** {@link typesOfSpaceMeta}'s walk, inside the library scope: the space fields, then each kind's types in the order the meta holds them. */
function convert(meta: unknown, library: Map<string, SchemaLibraryEntryLike>): TypeScriptSource {
  const untranslated: Untranslated[] = [];
  for (const field of REPORTED_SPACE_FIELDS) if (ownValue(meta, field) !== undefined) untranslated.push({ reason: 'not-translated', field });
  const typeSchemas = ownValue(meta, PER_TYPE_META_FIELD);
  if (!isPlainObject(typeSchemas)) untranslated.push({ reason: 'no-type-schemas' });
  else {
    const kinds = new Set<string>(KNOWLEDGE_TYPES);
    for (const kind of Object.keys(typeSchemas)) {
      if (!kinds.has(kind)) untranslated.push({ reason: 'unknown-field', field: `${PER_TYPE_META_FIELD}.${kind}` });
    }
  }
  const identifiers = new Identifiers();
  const declared: string[] = [];
  const map: string[] = [];
  for (const kind of KNOWLEDGE_TYPES) {
    const defs = ownValue(typeSchemas, kind);
    if (defs !== undefined && !isPlainObject(defs)) untranslated.push({ reason: 'type-skipped', kind, detail: 'not an object' });
    const entries: string[] = [];
    for (const name of isPlainObject(defs) ? Object.keys(defs) : []) {
      const report: Report = entry => untranslated.push({ kind, type: name, ...entry });
      const read = readType(kind, ownValue(defs, name), library, report);
      if (read === null) continue;
      const wanted = `${capitalised(kind)}${pascal(name)}`;
      const base = identifiers.allocate(wanted);
      if (base !== wanted) report({ reason: 'renamed', detail: base });
      if (!read.open) {
        for (const field of REPORTED_TYPE_FIELDS) if (read.schema[field] !== undefined) report({ reason: 'not-translated', field });
      }
      declared.push(...declarations(base, kind, read, report));
      entries.push(`    ${literal(name)}: { ${SPACE_TYPE_PROPERTIES}: ${base}Properties; ${SPACE_TYPE_STORED}: ${base}StoredProperties };`);
    }
    map.push(`  ${literal(kind)}: {${entries.length === 0 ? '' : `\n${entries.join('\n')}\n  `}};`);
  }
  const source = [HEADER, ...declared, `export interface ${SPACE_TYPES} {\n${map.join('\n')}\n}`].join('\n\n') + '\n';
  return { source, untranslated };
}
