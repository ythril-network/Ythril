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
 * - **Classifying one pair twice, or reading its texts to find it was classified.** A fingerprint is its text's hash, so a pair's
 *   classification never goes stale: it is kept in a bounded per-process memo ({@link typesDifferingBetween}) keyed by the two fingerprints
 *   and the mode, and a caller asks it ({@link knownTypesDiffering}) before it reads a text.
 *
 * Not the question `typesAnEditChanges` (the price of an edit) or the field rights' `rulesOf` answer: those price a write and a notice, this
 * compares two stored versions.
 */
import { isPlainObject, placeUnder, spaceRuleKinds, type StoredRule } from '@ythril-network/schema/internal';
import { isDeepStrictEqual } from 'node:util';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import { LruMap } from '../util/lru-map.js';
import { versionMetaOf, type VersionSchema, type VersionMeta } from './schema-version-text.js';
import { kindHasAllowlist } from './schema-validation.js';

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

/** The changes between two objects of `table`, each key by its class, a `nested` key walked by its own table (`entries` for a map of them). */
function changesOf(table: string, from: unknown, to: unknown, path: string, out: SchemaChange[]): void {
  if (isDeepStrictEqual(from, to)) return;
  const a = objOf(from), b = objOf(to);
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key], y = b[key];
    if (isDeepStrictEqual(x, y)) continue;
    const declared = SCHEMA_DIFF_CLASSES[table]?.[key];
    const place = placeUnder(path, key);
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
    const place = placeUnder(path, name);
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
    const from = kindHasAllowlist(a.typeSchemas, kind), to = kindHasAllowlist(b.typeSchemas, kind);
    if (from !== to) allowlists.push({ kind, from, to });
  }
  return { types, spaceRules, allowlists, unread };
}

/**
 * A version text read once, for a pass that diffs one text (its anchor) against many: {@link schemaVersionDiff} takes it in place of the text
 * and does not read it again (design r3 §5.4, amend 4).
 */
export interface ParsedVersion {
  readonly text: string;
  readonly read: VersionMeta | null;
}

/** `text` read as a stored version is read, once. */
export const parsedVersion = (text: string): ParsedVersion => ({ text, read: versionMetaOf(text) });

/** A version as a diff takes it: its text, or the text already read. */
export type VersionInput = string | ParsedVersion;

const readOf = (v: VersionInput): VersionMeta | null => (typeof v === 'string' ? versionMetaOf(v) : v.read);
const textOf = (v: VersionInput): string => (typeof v === 'string' ? v : v.text);

/** Both texts read, or the unread answer for a text that is not a version text at all. */
function readPair(from: VersionInput, to: VersionInput): { a: VersionSchema; b: VersionSchema; unread: string[] } {
  const a = readOf(from), b = readOf(to);
  const empty: VersionSchema = { typeSchemas: {}, rules: {} };
  const unread = [...(a ? a.unread.map(p => `from:${p}`) : ['from:text']), ...(b ? b.unread.map(p => `to:${p}`) : ['to:text'])];
  return { a: a?.meta ?? empty, b: b?.meta ?? empty, unread };
}

/** What changed from `from` to `to` (texts, or texts read once), per type, per space rule and per kind's allowlist, in the four classes. */
export function schemaVersionDiff(from: VersionInput, to: VersionInput): SchemaVersionDiff {
  if (textOf(from) === textOf(to)) return { types: [], spaceRules: [], allowlists: [], unread: [] };
  const { a, b, unread } = readPair(from, to);
  return diffOf(a, b, unread);
}

/**
 * Does a changed space rule reach the records of `kind`? It governs every type of the kinds it names on either side (A1). THE reach of a
 * space rule: the classification ({@link typesDifferingUnder}) and the narrowed comparison ({@link narrowedDiff}) both ask it, so a type's
 * history never shows a change the classification did not count, or hides one it did.
 */
export const ruleReaches = (rule: SchemaVersionDiff['spaceRules'][number], kind: string): boolean => rule.kinds.includes(kind);

/** Does a kind's allowlist change reach the records of `kind`? Only its own (A2). Asked by the classification and the narrowed comparison. */
export const allowlistReaches = (allowlist: SchemaVersionDiff['allowlists'][number], kind: string): boolean => allowlist.kind === kind;

/**
 * The comparison a type's history shows: `diff` cut to what reaches one (kind, type), in the same shape. `types` holds only that type's
 * entry, `spaceRules` only the rules that reach the kind ({@link ruleReaches}), `allowlists` only the kind's ({@link allowlistReaches}),
 * `unread` as it was. It counts a change exactly when the classification names the type or marks its kind `all` (the reach law, T7).
 */
export function narrowedDiff(diff: SchemaVersionDiff, kind: string, type: string): SchemaVersionDiff {
  return {
    types: diff.types.filter(t => t.kind === kind && t.type === type),
    spaceRules: diff.spaceRules.filter(r => ruleReaches(r, kind)),
    allowlists: diff.allowlists.filter(a => allowlistReaches(a, kind)),
    unread: diff.unread,
  };
}

/** Which changes count: `structural` alone, or `any` of the four classes. */
export type SchemaChangedMode = 'structural' | 'any';

/** The types a record of each kind sees differently: a set of type names, or `all` (every type of the kind, untyped records included). */
export interface TypesDiffering {
  readonly kinds: Map<string, Set<string> | 'all'>;
  /** The pair differs and a place either side could not read stands in the way: no type may be answered the same. */
  readonly unclassified: boolean;
}

/**
 * The pairs classified, by both FINGERPRINTS and the mode (`fromFp>toFp|mode`, design r3 §2). A fingerprint is the sha256 of its text
 * (`schema-stamp.ts`; a row's `_id` is verified against its text when it arrives), so an entry never goes stale, and a hit reads no text.
 * 4,096 (bundle-268, design r3 §5.3): one type history makes at most n − 1 neighbour pairs plus `COMPARE_MAX` (4,096) representative pairs, so
 * a history paged twice finds its pairs here; the walk over every carried version (the older mark, `older`) keeps its own standing memo and
 * does not cycle through this one.
 */
export const PAIR_MEMO_MAX = 4_096;
const pairMemo = new LruMap<string, TypesDiffering>(PAIR_MEMO_MAX);
const pairKey = (fromFp: string, toFp: string, mode: SchemaChangedMode): string => `${fromFp}>${toFp}|${mode}`;

/** A version as the memo knows it: its fingerprint and the text it names (or that text, read once). */
export interface FingerprintedText { readonly fp: string; readonly text: VersionInput }

/**
 * The types of each kind that differ from `fromText` to `toText` under `mode`, from {@link schemaVersionDiff} with A1 (a space rule's kinds)
 * and A2 (allowlists). Not memoised: a caller that holds the fingerprints asks {@link knownTypesDiffering} first and reads the texts only on a miss.
 */
export function typesDifferingUnder(from: VersionInput, to: VersionInput, mode: SchemaChangedMode): TypesDiffering {
  return classify(schemaVersionDiff(from, to), mode);
}

/** The memo's answer for the pair of fingerprints and `mode`, or `undefined`: then read both texts and ask {@link typesDifferingBetween}. */
export function knownTypesDiffering(fromFp: string, toFp: string, mode: SchemaChangedMode): TypesDiffering | undefined {
  return pairMemo.get(pairKey(fromFp, toFp, mode));
}

/**
 * {@link typesDifferingUnder} of two versions, memoised per process by their fingerprints and the mode (at most {@link PAIR_MEMO_MAX} pairs):
 * the same pair and mode answer the same object.
 */
export function typesDifferingBetween(from: FingerprintedText, to: FingerprintedText, mode: SchemaChangedMode): TypesDiffering {
  const key = pairKey(from.fp, to.fp, mode);
  const held = pairMemo.get(key);
  if (held) return held;
  const answer = typesDifferingUnder(from.text, to.text, mode);
  pairMemo.set(key, answer);
  return answer;
}

function classify(diff: SchemaVersionDiff, mode: SchemaChangedMode): TypesDiffering {
  const counts = (changes: readonly SchemaChange[]): boolean => changes.some(c => mode === 'any' || c.class === 'structural');
  const kinds = new Map<string, Set<string> | 'all'>();
  const all = (kind: string): void => { kinds.set(kind, 'all'); };
  const reachable = new Set([...KNOWLEDGE_TYPES, ...diff.spaceRules.flatMap(r => r.kinds), ...diff.allowlists.map(a => a.kind)]);
  for (const r of diff.spaceRules) if (counts(r.changes)) for (const kind of reachable) if (ruleReaches(r, kind)) all(kind);
  for (const a of diff.allowlists) for (const kind of reachable) if (allowlistReaches(a, kind)) all(kind);
  for (const t of diff.types) {
    if (!counts(t.changes)) continue;
    const held = kinds.get(t.kind);
    if (held === 'all') continue;
    if (held) held.add(t.type); else kinds.set(t.kind, new Set([t.type]));
  }
  return { kinds, unclassified: diff.unread.length > 0 };
}
