/**
 * The steps a Save proposes for converting records, and the rows the step editor edits them as (bundle-285 slice S5, Q-747; plan sections
 * 3.1 items 2 and 5, 5 rows D4 and E). Pure: it reads no instance, injects nothing and asks no translation.
 *
 * ## Where the steps come from
 *
 * The settings state keeps a rename ledger (`renameLedgerOf`, slice S4): every type and property renamed since the schema was stored, in the
 * names the records still carry. {@link convertBlocks} sets that against the stored schema and the staged one and answers one block per type
 * that changed. Only the ledger makes a step: a type rename is a `renameType`, a property rename a `renameProperty` on the type by its
 * NEW name (a conversion applies the type step first, so a property step names the type the record has afterwards). Nothing else is a step.
 *
 * ## What it prevents
 *
 * - **A step the ledger does not hold.** A removed enum value cannot say what it becomes, so it is an {@link MapOffer}: the editor shows
 *   a map row with every old value and NO target ({@link offerStep}), and the row is not a step until a person chose each one
 *   ({@link stepOf} is `null` for it). The page never sends a target it made up.
 * - **A rename that leaves a rule behind.** A rename rewrites no rule and no naming pattern, so a rule that still reads the old property
 *   name keeps reading nothing. {@link convertBlocks} finds each such rule (and a naming pattern that holds the old name) and says which,
 *   in `warnings` of the block of its type; the page words it as a line on the block.
 * - **A step the server would refuse on its face.** An editor row is strings throughout (a half-typed row must be representable), and
 *   {@link stepOf} is `null` for a row that is not yet a step: an empty name, an unchanged name, a map with an empty target or a value named
 *   twice, a split with no case or a case with no condition or target. Only complete rows are sent ({@link stepsOfEdits}); the index
 *   the server names in a refusal counts among exactly those ({@link locateStep}).
 * - **Two orders.** The order the rows are shown in is the order they are sent in is the order the server applies them in: type steps, then
 *   property renames, then value maps ({@link sortEdits}, which is `orderedConversionSteps` of the vote row, not a second copy of its rule).
 * - **A new type that shares a definition with its source.** {@link withAddedTypes} adds each type "Add a new type" made as a deep COPY
 *   of the type it was made from (so the records a split moves fit it), never touching the schema it is given.
 *
 * A type that is new, or removed, has no block: a new type has no records of its own to convert (a split's target is reached through the
 * block of the type it splits) and a removed type keeps its records, which the server converts nothing for.
 */
import { KNOWLEDGE_TYPES, type TypeSchema } from '../../core/api.types';
import type { ConvertBlock } from '../../core/conversion-counts';
import type { ConversionStep } from '../../core/conversion.types';
import type { TypedKind } from '../../core/type-field';
import { orderedConversionSteps } from '../../core/vote-round-view';
import type { RenameLedger } from './type-schema-edits';

/** The wire definitions of the types of a space, by kind and name: what `buildMeta()` writes as `typeSchemas`, stored and staged. */
export type ConvertSchemas = Partial<Record<TypedKind, Record<string, TypeSchema>>>;

/** A property whose stored enum had values the staged one lacks: the values, as text. The editor offers a map for them; none is a step. */
export interface MapOffer { kind: TypedKind; type: string; property: string; removed: string[] }

/** A rule, or the naming pattern, of a type that still names the old name of a renamed property. `property` is the old name, `to` the new one. */
export type ConvertWarning =
  | { kind: 'rule'; type: string; rule: string; property: string; to: string }
  | { kind: 'namingPattern'; type: string; property: string; to: string };

/** One changed type: S2's block (`was` is the stored name of a renamed type) with what the dialog also says about it. */
export interface ConvertBlockPlan extends ConvertBlock { offers: MapOffer[]; warnings: ConvertWarning[] }

/** A type "Add a new type" made: its name and the type its definition is copied from. The host adds it to the staged schema (`withAddedTypes`). */
export interface AddedType { kind: TypedKind; name: string; copyOf: string }

/** What the editor holds for one step: text throughout, so a row that is half typed is a row. */
export type EditStep =
  | { op: 'renameProperty'; kind: TypedKind; type: string; from: string; to: string }
  | { op: 'renameType'; kind: TypedKind; from: string; to: string }
  | { op: 'mapEnum'; kind: TypedKind; type: string; property: string; pairs: { from: string; to: string }[] }
  | { op: 'splitType'; kind: TypedKind; from: string; cases: { when: string; to: string }[]; otherwise: string };

// ── Reading a schema ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A name is looked up as an OWN key: a type called `constructor` or `__proto__` is a name, not a member of Object. */
const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => (map && Object.hasOwn(map, key) ? map[key] : undefined);

/** The definition as text with its keys sorted, so two definitions built in a different order compare equal. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v));
}

/** The names of the types of `kind` in the schema, in the order it holds them. */
export function typesOf(schemas: ConvertSchemas, kind: TypedKind): string[] {
  return Object.keys(schemas[kind] ?? {});
}

/** The allowed values of a property as text (a number or a flag is its text, as the editor's own chip list compares them); none for no enum. */
export function enumValuesOf(schemas: ConvertSchemas, kind: TypedKind, type: string, property: string): string[] {
  const schema = own(own(schemas[kind], type)?.propertySchemas, property);
  return Array.isArray(schema?.enum) ? schema.enum.map(String) : [];
}

/** The schema with each added type in it, as a deep copy of its source (an empty definition when the source is not there); the given schema is not touched. */
export function withAddedTypes(schemas: ConvertSchemas, added: readonly AddedType[]): ConvertSchemas {
  const out: ConvertSchemas = { ...schemas };
  for (const { kind, name, copyOf } of added) {
    const map = { ...(out[kind] ?? {}) };
    if (!Object.hasOwn(map, name)) {
      const source = own(map, copyOf);
      map[name] = source ? structuredClone(source) : {};
    }
    out[kind] = map;
  }
  return out;
}

// ── The blocks ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const IDENT = 'A-Za-z0-9_$';

/** Does the rule read property `name` of the record, as `properties.name` or `properties["name"]`? Not a longer name that starts with it. */
function ruleReads(rule: string, name: string): boolean {
  const dotted = new RegExp(`(^|[^${IDENT}])properties\\s*\\.\\s*${escaped(name)}(?![${IDENT}])`);
  const bracketed = new RegExp(`properties\\s*\\[\\s*(["'])${escaped(name)}\\1\\s*\\]`);
  return dotted.test(rule) || bracketed.test(rule);
}

/** Does the text hold `name` as a whole word (not inside a longer identifier)? */
function holdsWord(text: string, name: string): boolean {
  return new RegExp(`(^|[^${IDENT}])${escaped(name)}(?![${IDENT}])`).test(text);
}

/** The rules and the naming pattern of the staged type that still name the old name of a property this block renamed. */
function warningsOf(kind: TypedKind, type: string, now: TypeSchema, ledger: RenameLedger): ConvertWarning[] {
  const out: ConvertWarning[] = [];
  for (const rename of ledger.props) {
    if (rename.kind !== kind || rename.type !== type) continue;
    // The type declares the old name again: the name is in use, not stale.
    if (own(now.propertySchemas, rename.from)) continue;
    for (const [rule, body] of Object.entries(now.rules ?? {})) {
      if (typeof body?.rule === 'string' && ruleReads(body.rule, rename.from)) out.push({ kind: 'rule', type, rule, property: rename.from, to: rename.to });
    }
    if (typeof now.namingPattern === 'string' && holdsWord(now.namingPattern, rename.from)) {
      out.push({ kind: 'namingPattern', type, property: rename.from, to: rename.to });
    }
  }
  return out;
}

/** The maps to offer on this block: a property whose stored enum had values the staged one lacks, under the property's current name. */
function offersOf(kind: TypedKind, type: string, before: TypeSchema | undefined, now: TypeSchema, ledger: RenameLedger): MapOffer[] {
  const out: MapOffer[] = [];
  for (const [property, schema] of Object.entries(now.propertySchemas ?? {})) {
    const stored = ledger.props.find(p => p.kind === kind && p.type === type && p.to === property)?.from ?? property;
    const was = own(before?.propertySchemas, stored)?.enum;
    if (!Array.isArray(was) || !Array.isArray(schema.enum)) continue;
    const kept = new Set(schema.enum.map(String));
    const removed = [...new Set(was.map(String))].filter(v => !kept.has(v));
    if (removed.length > 0) out.push({ kind, type, property, removed });
  }
  return out;
}

/**
 * One block per type of the staged schema that changed, kinds in their fixed order and types in the order the schema holds them. A type is
 * changed when it was renamed (the ledger says so) or when its definition differs from the stored one; a type with no stored copy and no
 * rename (new) gives none. `original` and `staged` are the wire definitions `buildMeta()` writes; `ledger` is `renameLedger()`.
 */
export function convertBlocks(original: ConvertSchemas, staged: ConvertSchemas, ledger: RenameLedger): ConvertBlockPlan[] {
  const blocks: ConvertBlockPlan[] = [];
  for (const kind of KNOWLEDGE_TYPES) {
    for (const [type, now] of Object.entries(staged[kind] ?? {})) {
      const was = ledger.types.find(t => t.kind === kind && t.to === type)?.from;
      const before = own(original[kind], was ?? type);
      if (was === undefined && (before === undefined || stable(before) === stable(now))) continue;
      const steps: ConversionStep[] = [];
      if (was !== undefined) steps.push({ op: 'renameType', kind, from: was, to: type });
      for (const p of ledger.props) if (p.kind === kind && p.type === type) steps.push({ op: 'renameProperty', kind, type, from: p.from, to: p.to });
      blocks.push({
        kind, type, ...(was !== undefined ? { was } : {}), steps,
        offers: offersOf(kind, type, before, now, ledger), warnings: warningsOf(kind, type, now, ledger),
      });
    }
  }
  return blocks;
}

// ── The rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const blank = (text: string): boolean => text.trim() === '';

/** A step as the editor holds it. */
export function editOf(step: ConversionStep): EditStep {
  switch (step.op) {
    case 'mapEnum': return { op: 'mapEnum', kind: step.kind, type: step.type, property: step.property, pairs: Object.entries(step.values).map(([from, to]) => ({ from, to })) };
    case 'splitType': return { op: 'splitType', kind: step.kind, from: step.from, cases: step.cases.map(c => ({ ...c })), otherwise: step.otherwise ?? '' };
    default: return { ...step };
  }
}

/** The map row of an offer: every removed value, no target. It is not a step until each value has one. */
export function offerStep(offer: MapOffer): EditStep {
  return { op: 'mapEnum', kind: offer.kind, type: offer.type, property: offer.property, pairs: offer.removed.map(from => ({ from, to: '' })) };
}

/** The step a row is, or `null` while it is not one yet. A split with no `otherwise` has no such key (the server leaves a record no case matches unconverted). */
export function stepOf(edit: EditStep): ConversionStep | null {
  switch (edit.op) {
    case 'renameProperty':
      return blank(edit.from) || blank(edit.to) || edit.from === edit.to ? null : { op: 'renameProperty', kind: edit.kind, type: edit.type, from: edit.from, to: edit.to };
    case 'renameType':
      return blank(edit.from) || blank(edit.to) || edit.from === edit.to ? null : { op: 'renameType', kind: edit.kind, from: edit.from, to: edit.to };
    case 'mapEnum': {
      const keys = edit.pairs.map(p => p.from);
      const done = !blank(edit.property) && edit.pairs.length > 0 && new Set(keys).size === keys.length
        && edit.pairs.every(p => !blank(p.from) && !blank(p.to) && p.from !== p.to);
      return done ? { op: 'mapEnum', kind: edit.kind, type: edit.type, property: edit.property, values: Object.fromEntries(edit.pairs.map(p => [p.from, p.to])) } : null;
    }
    case 'splitType': {
      const done = !blank(edit.from) && edit.cases.length > 0 && edit.cases.every(c => !blank(c.when) && !blank(c.to));
      return done
        ? { op: 'splitType', kind: edit.kind, from: edit.from, cases: edit.cases.map(c => ({ when: c.when, to: c.to })), ...(blank(edit.otherwise) ? {} : { otherwise: edit.otherwise }) }
        : null;
    }
  }
}

/** The rows in the order they are sent and applied in: type steps, then property renames, then value maps, each group in the order it had. */
export function sortEdits(edits: readonly EditStep[]): EditStep[] {
  return orderedConversionSteps(edits) as unknown as EditStep[];
}

/** The steps to send: the complete rows, in the order shown. */
export function stepsOfEdits(edits: readonly EditStep[]): ConversionStep[] {
  return edits.flatMap(e => { const step = stepOf(e); return step ? [step] : []; });
}

/**
 * Which row of which block the index of a refusal names. The server counts the steps it was SENT, one list over all blocks in order, so a
 * half-typed row (not sent) is not counted. `null` when the index names none.
 */
export function locateStep(rows: readonly (readonly EditStep[])[], index: number): { block: number; row: number } | null {
  if (!Number.isInteger(index) || index < 0) return null;
  let sent = 0;
  for (let block = 0; block < rows.length; block++) {
    const edits = rows[block]!;
    for (let row = 0; row < edits.length; row++) {
      if (stepOf(edits[row]!) === null) continue;
      if (sent === index) return { block, row };
      sent++;
    }
  }
  return null;
}
