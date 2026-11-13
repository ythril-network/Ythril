/**
 * What changed between two schema versions, per type, in four classes (bundle-267, Q-741/Q-742; design r1 A1-A3, r2 "Diff walk", r3 §2).
 *
 * ## The question it answers
 *
 * "Which types does a record written under version F see differently under version C, and how?" Asked text to text: each text is read as a
 * stored schema is read (`versionMetaOf`), and the two reads are walked key by key below each type, each property and each rule. Every change
 * is classed:
 *
 * - `structural`: it can change whether a record conforms (a property's type, a pattern, a rule's expression, a property or type added or
 *   removed, a space rule's kinds);
 * - `wording`: descriptions and rule messages;
 * - `write`: what a write does with a value (`mergeFn`, `default`);
 * - `lifecycle`: retention, embedding suppression, what a passed due moment means.
 *
 * Two rules reach past one type. A space rule governs every type of the kinds it names (absent kinds: every kind, `spaceRuleKinds`), so a
 * change to one makes every type of its old and new kinds differ, untyped records included (A1). A kind that declares no type takes records
 * of any type, so a kind that gains or loses its first declared type differs for every type of that kind, declared on either side or not (A2).
 *
 * ## What it prevents
 *
 * - **A key with no class hidden as "same".** {@link SCHEMA_DIFF_CLASSES} names a class for every key of every zod object a version text holds,
 *   and a pure test holds it total over the zod shapes; {@link keyClass} answers `structural` for a key it does not know (fail toward showing).
 * - **"Same" for what was not read.** A place either side's read dropped (`unread`) makes the pair `unclassified`, never equal.
 * - **Classifying one pair twice.** Both texts are fixed by their hash, so a pair's classification never goes stale: it is kept in a bounded
 *   per-process memo ({@link typesDifferingUnder}), keyed by the two texts' hashes and the mode.
 *
 * Not the question `typesAnEditChanges` (the price of an edit) or the field rights' `rulesOf` answer: those price a write and a notice, this
 * compares two stored versions.
 */
import { isPlainObject, spaceRuleKinds, type StoredRule } from '@ythril-network/schema/internal';
import { isDeepStrictEqual } from 'node:util';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { LruMap } from '../util/lru-map.js';
import { sha256Hex } from '../util/sha256-hex.js';
import { versionMetaOf, type VersionSchema } from './schema-version-text.js';

/** The four classes of a change; `nested` marks a key whose own table classes its parts. */
export type SchemaDiffClass = 'structural' | 'wording' | 'write' | 'lifecycle';
type TableClass = SchemaDiffClass | 'nested';

/**
 * The class of every key of every zod object a version text holds, one table per object, named by its path: a type (`InlineTypeSchemaZ`),
 * a property (`PropertySchemaZ`), a type's retention and endpoints, a type's rule (`TypeRuleZ`) and a space rule (`SpaceRuleZ`). A key
 * added to one of those shapes with no class here fails `a-schema-version-diff-says-what-changed-per-type`.
 */
export const SCHEMA_DIFF_CLASSES: Readonly<Record<string, Readonly<Record<string, TableClass>>>> = Object.freeze({
  type: {
    description: 'wording', namingPattern: 'structural', propertySchemas: 'nested', retention: 'nested', suppressEmbeddings: 'lifecycle',
    whenDuePasses: 'lifecycle', endpoints: 'nested', functional: 'structural', rules: 'nested',
  },
  'type.propertySchemas.*': {
    description: 'wording', type: 'structural', enum: 'structural', minimum: 'structural', maximum: 'structural', pattern: 'structural',
    mergeFn: 'write', required: 'structural', default: 'write',
  },
  'type.retention': { days: 'lifecycle', contentDays: 'lifecycle' },
  'type.endpoints': { from: 'structural', to: 'structural' },
  'type.rules.*': { rule: 'structural', message: 'wording' },
  spaceRule: { rule: 'structural', message: 'wording', kinds: 'structural' },
});

/** The class of `key` in `table`; `structural` for a key the table does not know, so a key added without a class is shown, never hidden. */
export function keyClass(table: string, key: string): SchemaDiffClass {
  const c = Object.hasOwn(SCHEMA_DIFF_CLASSES, table) && Object.hasOwn(SCHEMA_DIFF_CLASSES[table]!, key) ? SCHEMA_DIFF_CLASSES[table]![key] : undefined;
  return c === undefined || c === 'nested' ? 'structural' : c;
}

/** One change at one place: `place` relative to its type or space rule (`propertySchemas.p.type`), absent sides left out. */
export interface SchemaChange {
  readonly place: string;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly class: SchemaDiffClass;
}

/** What {@link schemaVersionDiff} answers. */
export interface SchemaVersionDiff {
  /** Every type with at least one change, by kind and name. */
  readonly types: { kind: string; type: string; changes: SchemaChange[] }[];
  /** Every space rule with at least one change, with the kinds it governs on either side. */
  readonly spaceRules: { name: string; kinds: string[]; changes: SchemaChange[] }[];
  /** Every kind whose "declares any type" state differs. */
  readonly allowlists: { kind: string; from: boolean; to: boolean }[];
  /** Every place either side's read dropped: the pair cannot be classified there. */
  readonly unread: string[];
}

type Obj = Record<string, unknown>;
const objOf = (v: unknown): Obj => (isPlainObject(v) ? v : {});
const sides = (from: unknown, to: unknown): { from?: unknown; to?: unknown } => ({ ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
const under = (path: string, key: string): string => (path === '' ? key : `${path}.${key}`);

/** The changes between two objects of `table`, each key by its class, a `nested` key walked by its own table (`entries` for a map of them). */
function changesOf(table: string, from: unknown, to: unknown, path: string, out: SchemaChange[]): void {
  if (isDeepStrictEqual(from, to)) return;
  const a = objOf(from), b = objOf(to);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key], y = b[key];
    if (isDeepStrictEqual(x, y)) continue;
    const declared = SCHEMA_DIFF_CLASSES[table]?.[key];
    const place = under(path, key);
    if (declared !== 'nested') { out.push({ place, ...sides(x, y), class: keyClass(table, key) }); continue; }
    const mapOf = `${table}.${key}.*`;
    if (Object.hasOwn(SCHEMA_DIFF_CLASSES, mapOf)) entriesOf(mapOf, x, y, place, out);
    else changesOf(`${table}.${key}`, x, y, place, out);
  }
}

/** The changes between two maps whose values are objects of `table`: an entry added or removed is structural, a kept one is walked. */
function entriesOf(table: string, from: unknown, to: unknown, path: string, out: SchemaChange[]): void {
  const a = objOf(from), b = objOf(to);
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[name], y = b[name];
    if (isDeepStrictEqual(x, y)) continue;
    const place = under(path, name);
    if (x === undefined || y === undefined || !isPlainObject(x) || !isPlainObject(y)) { out.push({ place, ...sides(x, y), class: 'structural' }); continue; }
    changesOf(table, x, y, place, out);
  }
}

/** The changes of one type: a type added, removed or named by a library `$ref` on either side is one structural change of the whole. */
function typeChanges(from: unknown, to: unknown): SchemaChange[] {
  const out: SchemaChange[] = [];
  if (isDeepStrictEqual(from, to)) return out;
  const isRef = (v: unknown): boolean => isPlainObject(v) && typeof v['$ref'] === 'string';
  if (!isPlainObject(from) || !isPlainObject(to) || isRef(from) || isRef(to)) return [{ place: '', ...sides(from, to), class: 'structural' }];
  changesOf('type', from, to, '', out);
  return out;
}

const declaresAny = (schema: VersionSchema, kind: string): boolean => Object.keys(objOf(schema.typeSchemas[kind])).length > 0;
const ruleKinds = (r: unknown): string[] => (isPlainObject(r) ? spaceRuleKinds(r as unknown as StoredRule) : []);

/** The diff of two read schemas, with the places either read dropped. */
function diffOf(a: VersionSchema, b: VersionSchema, unread: string[]): SchemaVersionDiff {
  const types: SchemaVersionDiff['types'] = [];
  for (const kind of new Set([...KNOWLEDGE_TYPES, ...Object.keys(a.typeSchemas), ...Object.keys(b.typeSchemas)])) {
    const x = objOf(a.typeSchemas[kind]), y = objOf(b.typeSchemas[kind]);
    for (const type of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const changes = typeChanges(x[type], y[type]);
      if (changes.length > 0) types.push({ kind, type, changes });
    }
  }
  const spaceRules: SchemaVersionDiff['spaceRules'] = [];
  for (const name of new Set([...Object.keys(a.rules), ...Object.keys(b.rules)])) {
    const x = a.rules[name], y = b.rules[name];
    if (isDeepStrictEqual(x, y)) continue;
    const changes: SchemaChange[] = [];
    if (!isPlainObject(x) || !isPlainObject(y)) changes.push({ place: '', ...sides(x, y), class: 'structural' });
    else changesOf('spaceRule', x, y, '', changes);
    spaceRules.push({ name, kinds: [...new Set([...ruleKinds(x), ...ruleKinds(y)])], changes });
  }
  const allowlists: SchemaVersionDiff['allowlists'] = [];
  for (const kind of KNOWLEDGE_TYPES) {
    const from = declaresAny(a, kind), to = declaresAny(b, kind);
    if (from !== to) allowlists.push({ kind, from, to });
  }
  return { types, spaceRules, allowlists, unread };
}

/** Both texts read, or the unread answer for a text that is not a version text at all. */
function readPair(fromText: string, toText: string): { a: VersionSchema; b: VersionSchema; unread: string[] } {
  const a = versionMetaOf(fromText), b = versionMetaOf(toText);
  const empty: VersionSchema = { typeSchemas: {}, rules: {} };
  const unread = [...(a ? a.unread.map(p => `from:${p}`) : ['from:text']), ...(b ? b.unread.map(p => `to:${p}`) : ['to:text'])];
  return { a: a?.meta ?? empty, b: b?.meta ?? empty, unread };
}

/** What changed from `fromText` to `toText`, per type, per space rule and per kind's allowlist, in the four classes. */
export function schemaVersionDiff(fromText: string, toText: string): SchemaVersionDiff {
  if (fromText === toText) return { types: [], spaceRules: [], allowlists: [], unread: [] };
  const { a, b, unread } = readPair(fromText, toText);
  return diffOf(a, b, unread);
}

/** Which changes count: `structural` alone, or `any` of the four classes. */
export type SchemaChangedMode = 'structural' | 'any';

/** The types a record of each kind sees differently: a set of type names, or `all` (every type of the kind, untyped records included). */
export interface TypesDiffering {
  readonly kinds: Map<string, Set<string> | 'all'>;
  /** The pair differs and a place either side could not read stands in the way: no type may be answered the same. */
  readonly unclassified: boolean;
}

/** The pairs classified, by both texts' hashes and the mode: both texts are fixed by their hash, so an entry never goes stale. */
const PAIR_MEMO_MAX = 256;
const pairMemo = new LruMap<string, TypesDiffering>(PAIR_MEMO_MAX);

/**
 * The types of each kind that differ from `fromText` to `toText` under `mode`, from {@link schemaVersionDiff} with A1 (a space rule's kinds)
 * and A2 (allowlists). Memoised per process (at most {@link PAIR_MEMO_MAX} pairs): the same pair and mode answer the same object.
 */
export function typesDifferingUnder(fromText: string, toText: string, mode: SchemaChangedMode): TypesDiffering {
  const key = `${sha256Hex(fromText)}>${sha256Hex(toText)}|${mode}`;
  const held = pairMemo.get(key);
  if (held) return held;
  const answer = classify(schemaVersionDiff(fromText, toText), mode);
  pairMemo.set(key, answer);
  return answer;
}

function classify(diff: SchemaVersionDiff, mode: SchemaChangedMode): TypesDiffering {
  const counts = (changes: readonly SchemaChange[]): boolean => changes.some(c => mode === 'any' || c.class === 'structural');
  const kinds = new Map<string, Set<string> | 'all'>();
  const all = (kind: string): void => { kinds.set(kind, 'all'); };
  for (const r of diff.spaceRules) if (counts(r.changes)) for (const kind of r.kinds) all(kind);
  for (const a of diff.allowlists) all(a.kind);
  for (const t of diff.types) {
    if (!counts(t.changes)) continue;
    const held = kinds.get(t.kind);
    if (held === 'all') continue;
    if (held) held.add(t.type); else kinds.set(t.kind, new Set([t.type]));
  }
  return { kinds, unclassified: diff.unread.length > 0 };
}
