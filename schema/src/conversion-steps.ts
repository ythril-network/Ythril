/**
 * The steps a schema change may declare for converting the records already stored (Q-745): what they are, whether a schema before and
 * after can honour them, and what they make of one record. Pure: it reads no instance and runs no engine of its own, so the save that
 * accepts a step, the vote that carries it and the run that applies it agree on one meaning.
 *
 * ## What it prevents
 *
 * - **A step the schema cannot honour is saved, carried by the vote and then rewrites records into a shape no schema accepts.** Each step
 *   names one kind and one type and is held to the schema BEFORE (what it reads must be declared there) and AFTER (what it writes must be
 *   declared there), by {@link conversionStepIssues}, with a named code and the index of the step. A property's old name must be GONE
 *   from the after-type: own and layer definitions union their properties, so a rename between two names both still declared would move
 *   values every schema still accepts under the old name.
 * - **Two members that carry one vote rewrite one record two ways.** {@link convertedRecord} applies the steps in one fixed order whatever
 *   the order of the list: the type steps decide the type the record has afterwards, and only the property steps of THAT type then apply.
 *   A split's conditions are evaluated on the record as it is, in order, first true wins.
 * - **A condition no instance can apply, or one that costs more than the rules allow together, is saved.** A split's `when` texts are
 *   judged by the rules judge ({@link conditionIssues} in `rules.ts`): this module compiles nothing and prices nothing.
 * - **The same steps hash two ways.** {@link canonicalConvertRecordsText} is `canonicalJson` of the PARSED body and throws for a body that
 *   does not parse, so a signature over its hash cannot cover text no one validated.
 * - **A bound is cut instead of refused.** Over a bound is refused, with a code, by the check and by the body's parse alike.
 *
 * ## What it does not do
 *
 * It evaluates no condition itself (the caller hands in the judge of one condition on one record, `server/src/spaces/schema-rules.ts`),
 * writes no record and stamps nothing. A property step's `from` and `to` are property names, not paths.
 */
import { z } from 'zod';
import { KNOWLEDGE_TYPES, type KnowledgeType } from './vocabulary.js';
import { VIEW_FIELDS } from './view-fields.js';
import { MAX_RULES_PER_SPACE, MAX_RULE_LENGTH, conditionIssues } from './rules.js';
import { TYPE_NAME_MAX } from './space-meta.js';
import { canonicalJson } from './canonical-json.js';
import { isPlainObject, ownValue, setOwn } from './plain-object.js';
import { NAME_QUOTED, peerText } from './text.js';
import type { FingerprintedMeta } from './schema-fingerprint.js';

// ── The shape ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Steps one `convertRecords` may hold: as many as a space may have rules. */
export const CONVERSION_STEPS_MAX = MAX_RULES_PER_SPACE;
/** Entries one `mapEnum` may hold in its `values`: as many as a map of properties may hold (a type's `propertySchemas`). */
export const CONVERSION_VALUES_MAX = 200;
/** Cases one `splitType` may hold. */
export const CONVERSION_CASES_MAX = 20;

/** One declared rewrite. `kind` is a knowledge type; for an `edge` the type is its label. */
export type ConversionStep =
  | { op: 'renameProperty'; kind: KnowledgeType; type: string; from: string; to: string }
  | { op: 'mapEnum'; kind: KnowledgeType; type: string; property: string; values: Record<string, string> }
  | { op: 'renameType'; kind: KnowledgeType; from: string; to: string }
  | { op: 'splitType'; kind: KnowledgeType; from: string; cases: { when: string; to: string }[]; otherwise?: string };

/** What a schema change declares about the records it affects; `{}` stamps what conforms and rewrites nothing. */
export interface ConvertRecords { steps?: ConversionStep[] }

const KindZ = z.enum(KNOWLEDGE_TYPES);
const TypeNameZ = z.string().min(1).max(TYPE_NAME_MAX);
const PropertyNameZ = z.string().min(1);
const SplitCaseZ = z.object({ when: z.string().min(1).max(MAX_RULE_LENGTH), to: TypeNameZ }).strict();

/** One step, strict: an unknown key or op is refused, never ignored. */
export const ConversionStepZ = z.discriminatedUnion('op', [
  z.object({ op: z.literal('renameProperty'), kind: KindZ, type: TypeNameZ, from: PropertyNameZ, to: PropertyNameZ }).strict(),
  z.object({
    op: z.literal('mapEnum'), kind: KindZ, type: TypeNameZ, property: PropertyNameZ,
    values: z.record(z.string(), z.string()).refine(v => Object.keys(v).length <= CONVERSION_VALUES_MAX, `at most ${CONVERSION_VALUES_MAX} values`),
  }).strict(),
  z.object({ op: z.literal('renameType'), kind: KindZ, from: TypeNameZ, to: TypeNameZ }).strict(),
  z.object({
    op: z.literal('splitType'), kind: KindZ, from: TypeNameZ, cases: z.array(SplitCaseZ).min(1).max(CONVERSION_CASES_MAX), otherwise: TypeNameZ.optional(),
  }).strict(),
]) satisfies z.ZodType<ConversionStep>;

/** The body a schema change carries: the steps, at most {@link CONVERSION_STEPS_MAX}. */
export const ConvertRecordsZ = z.object({
  steps: z.array(ConversionStepZ).max(CONVERSION_STEPS_MAX).optional(),
}).strict() satisfies z.ZodType<ConvertRecords>;

/**
 * The canonical text of a `convertRecords`: `canonicalJson` of its parsed form, so one hash on every member whatever order the keys were
 * written in. Throws (the body's parse error) for a value that is not a valid `convertRecords`: there is no text of one.
 */
export function canonicalConvertRecordsText(value: unknown): string {
  return canonicalJson(ConvertRecordsZ.parse(value)) as string;
}

// ── Checking the steps against the schema before and after ──────────────────────────────────────────────────────────────────────────

/** What a refused step is refused for. */
export type ConversionIssueCode =
  | 'malformed_step' | 'too_many_steps' | 'too_many_values' | 'too_many_cases' | 'no_cases' | 'type_name_too_long' | 'condition_too_long'
  | 'same_name' | 'duplicate_property_rename' | 'duplicate_enum_map' | 'duplicate_type_step' | 'type_not_reached'
  | 'property_not_declared_before' | 'property_not_declared_after' | 'property_still_declared'
  | 'enum_not_declared_before' | 'enum_key_not_in_before' | 'enum_not_declared_after' | 'enum_value_not_in_after' | 'value_equals_key'
  | 'type_not_declared_before' | 'type_not_declared_after' | 'condition_refused' | 'conditions_over_budget';

/** One refusal: the index of the step in the list, a code, and the reason in plain words. */
export interface ConversionStepIssue { step: number; code: ConversionIssueCode; message: string }

/** The schema a step is checked against: resolved (library `$ref`s inlined, as the fingerprint takes them). */
export type ConversionMeta = Pick<FingerprintedMeta, 'typeSchemas'>;

export interface ConversionCheckOptions {
  /**
   * A property rename is refused when the after-type still declares its `from` (default: yes). Turned off only by a caller whose
   * after-schema is not the whole schema the rename must hold under.
   */
  requireGone?: boolean;
}

const q = (name: string): string => peerText(name, { max: NAME_QUOTED });
const defined = (v: unknown): v is Record<string, unknown> => isPlainObject(v);

/** The definition of type `name` of `kind` in `meta`, if it declares one. */
const typeOf = (meta: ConversionMeta | undefined, kind: string, name: string): Record<string, unknown> | undefined => {
  const t = ownValue(ownValue(meta?.typeSchemas, kind), name);
  return defined(t) ? t : undefined;
};
/** The declaration of property `name` of type `type`, if the type declares it. */
const propertyOf = (meta: ConversionMeta | undefined, kind: string, type: string, name: string): Record<string, unknown> | undefined => {
  const p = ownValue(ownValue(typeOf(meta, kind, type), 'propertySchemas'), name);
  return defined(p) ? p : undefined;
};
const enumOf = (declaration: Record<string, unknown>): unknown[] | undefined => (Array.isArray(declaration['enum']) ? declaration['enum'] : undefined);

/** The key of one type of one kind, for a set. */
const typeKey = (kind: string, name: string): string => JSON.stringify([kind, name]);

/** The strings of a not-yet-parsed step that name a type, and the `when` texts: what the bounds read before the body's parse. */
function boundIssues(raw: Record<string, unknown>): { code: ConversionIssueCode; message: string }[] {
  const out: { code: ConversionIssueCode; message: string }[] = [];
  // The fields that name a TYPE: a property step's `from` and `to` are property names, which the schema bounds as it declares them.
  const isTypeStep = raw['op'] === 'renameType' || raw['op'] === 'splitType';
  const names: unknown[] = [raw['type'], raw['otherwise'], ...(isTypeStep ? [raw['from'], raw['to']] : [])];
  const cases = Array.isArray(raw['cases']) ? raw['cases'] as unknown[] : [];
  for (const c of cases) if (isPlainObject(c)) names.push(c['to']);
  if (names.some(n => typeof n === 'string' && n.length > TYPE_NAME_MAX)) {
    out.push({ code: 'type_name_too_long', message: `a type name is longer than the ${TYPE_NAME_MAX} characters a type name may have` });
  }
  if (isPlainObject(raw['values']) && Object.keys(raw['values']).length > CONVERSION_VALUES_MAX) {
    out.push({ code: 'too_many_values', message: `a map of enum values holds more than ${CONVERSION_VALUES_MAX} entries` });
  }
  if (cases.length > CONVERSION_CASES_MAX) {
    out.push({ code: 'too_many_cases', message: `a split holds more than ${CONVERSION_CASES_MAX} cases` });
  }
  if (raw['op'] === 'splitType' && Array.isArray(raw['cases']) && cases.length === 0) {
    out.push({ code: 'no_cases', message: 'a split has no case: every record would be left to `otherwise` or be unconvertible' });
  }
  if (cases.some(c => isPlainObject(c) && typeof c['when'] === 'string' && c['when'].length > MAX_RULE_LENGTH)) {
    out.push({ code: 'condition_too_long', message: `a condition is longer than the ${MAX_RULE_LENGTH} characters a rule may have` });
  }
  return out;
}

/**
 * The refusals for `steps` against the schema they start from (`before`) and the one they lead to (`after`), each with the index of its
 * step; none when every step holds. Both schemas are resolved metas. A property step is read against the type as it is AFTER the type
 * steps; its before-schema is the type its records came from.
 */
export function conversionStepIssues(
  steps: readonly ConversionStep[], before: ConversionMeta | undefined, after: ConversionMeta | undefined, options: ConversionCheckOptions = {},
): ConversionStepIssue[] {
  const requireGone = options.requireGone ?? true;
  const issues: ConversionStepIssue[] = [];
  const add = (step: number, code: ConversionIssueCode, message: string): void => { issues.push({ step, code, message }); };

  if (steps.length > CONVERSION_STEPS_MAX) {
    add(CONVERSION_STEPS_MAX, 'too_many_steps', `a conversion holds at most ${CONVERSION_STEPS_MAX} steps and this one holds ${steps.length}`);
  }
  // A step is read further only once it is within its bounds and parses; one that does not is named here and left out of the rest.
  const sound: (ConversionStep | undefined)[] = steps.map((raw, index) => {
    if (isPlainObject(raw)) {
      const bounds = boundIssues(raw);
      for (const b of bounds) add(index, b.code, b.message);
      if (bounds.length > 0) return undefined;
    }
    const parsed = ConversionStepZ.safeParse(raw);
    if (parsed.success) return parsed.data;
    add(index, 'malformed_step', `is not a conversion step: ${q(parsed.error.issues[0]?.message ?? 'it does not parse')}`);
    return undefined;
  });
  const each = <T extends ConversionStep['op']>(op: T, run: (step: Extract<ConversionStep, { op: T }>, index: number) => void): void => {
    sound.forEach((s, i) => { if (s?.op === op) run(s as Extract<ConversionStep, { op: T }>, i); });
  };

  // Type steps: one per `from`, and which types each one targets (a type's before-schema is the `from` of the step that targets it).
  const typeSteps = new Set<string>();
  const targets = new Map<string, Set<string>>();
  const aim = (kind: string, to: string, from: string): void => {
    const key = typeKey(kind, to);
    (targets.get(key) ?? targets.set(key, new Set()).get(key)!).add(from);
  };
  sound.forEach((s, i) => {
    if (s?.op !== 'renameType' && s?.op !== 'splitType') return;
    const key = typeKey(s.kind, s.from);
    if (typeSteps.has(key)) {
      add(i, 'duplicate_type_step', `the ${s.kind} type '${q(s.from)}' is already moved by an earlier step: a type has one type step`);
      return;
    }
    typeSteps.add(key);
    if (s.op === 'renameType') aim(s.kind, s.to, s.from);
    else {
      for (const c of s.cases) aim(s.kind, c.to, s.from);
      if (s.otherwise !== undefined) aim(s.kind, s.otherwise, s.from);
    }
  });
  /** The types the records of `type` (as it is after the type steps) came from; `undefined` when no record can be of it. */
  const beforeNamesOf = (kind: string, type: string): string[] | undefined => {
    const from = targets.get(typeKey(kind, type));
    if (from) return [...from];
    return typeSteps.has(typeKey(kind, type)) ? undefined : [type];
  };

  // Type steps against the schemas.
  const declaredAfter = (step: number, kind: string, name: string, role: string): void => {
    if (!typeOf(after, kind, name)) add(step, 'type_not_declared_after', `${role} '${q(name)}' is not a ${kind} type the schema after the change declares`);
  };
  each('renameType', (s, i) => {
    if (s.from === s.to) add(i, 'same_name', `the ${s.kind} type '${q(s.from)}' is renamed to itself`);
    else {
      if (!typeOf(before, s.kind, s.from)) add(i, 'type_not_declared_before', `the ${s.kind} type '${q(s.from)}' is not declared by the schema before the change`);
      declaredAfter(i, s.kind, s.to, 'the new type name');
    }
  });
  each('splitType', (s, i) => {
    const source = typeOf(before, s.kind, s.from);
    if (!source) add(i, 'type_not_declared_before', `the ${s.kind} type '${q(s.from)}' is not declared by the schema before the change`);
    for (const to of new Set([...s.cases.map(c => c.to), ...(s.otherwise === undefined ? [] : [s.otherwise])])) {
      declaredAfter(i, s.kind, to, 'a type a record may be split into,');
    }
    if (source) {
      for (const issue of conditionIssues(s.kind, source, s.cases.map(c => c.when))) {
        if (issue.path.length === 0) add(i, 'conditions_over_budget', issue.message);
        else add(i, 'condition_refused', issue.message);
      }
    }
  });

  // Property steps: the type as it is after the type steps, read against the types its records came from.
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  const mapped = new Set<string>();
  /** True when a property step on `type` can be checked; says why not otherwise. */
  const reached = (i: number, kind: string, type: string): boolean => {
    if (typeSteps.has(typeKey(kind, type)) && !targets.has(typeKey(kind, type))) {
      add(i, 'type_not_reached', `the ${kind} type '${q(type)}' is moved by a type step, so none of its records is of it afterwards`);
      return false;
    }
    return true;
  };
  const declaredBefore = (kind: string, type: string, property: string): { declaration: Record<string, unknown> | undefined; missing: boolean }[] =>
    (beforeNamesOf(kind, type) ?? []).map(name => {
      const declaration = propertyOf(before, kind, name, property);
      return { declaration, missing: declaration === undefined };
    });
  each('renameProperty', (s, i) => {
    if (s.from === s.to) { add(i, 'same_name', `the property '${q(s.from)}' is renamed to itself`); return; }
    const fromKey = JSON.stringify([s.kind, s.type, s.from]);
    const toKey = JSON.stringify([s.kind, s.type, s.to]);
    if (renamedFrom.has(fromKey) || renamedTo.has(toKey)) {
      add(i, 'duplicate_property_rename', `the ${s.kind} type '${q(s.type)}' has another rename of '${q(s.from)}' or to '${q(s.to)}'`);
    }
    renamedFrom.add(fromKey);
    renamedTo.add(toKey);
    if (!reached(i, s.kind, s.type)) return;
    if (declaredBefore(s.kind, s.type, s.from).some(b => b.missing)) {
      add(i, 'property_not_declared_before', `the property '${q(s.from)}' is not declared by the ${s.kind} type '${q(s.type)}' before the change`);
    }
    if (!propertyOf(after, s.kind, s.type, s.to)) {
      add(i, 'property_not_declared_after', `the property '${q(s.to)}' is not declared by the ${s.kind} type '${q(s.type)}' after the change`);
    }
    if (requireGone && propertyOf(after, s.kind, s.type, s.from)) {
      add(i, 'property_still_declared', `the property '${q(s.from)}' is still declared by the ${s.kind} type '${q(s.type)}' after the change: `
        + 'a rename moves a name out of the schema, and a name every schema still accepts is not renamed');
    }
  });
  each('mapEnum', (s, i) => {
    const key = JSON.stringify([s.kind, s.type, s.property]);
    if (mapped.has(key)) add(i, 'duplicate_enum_map', `the property '${q(s.property)}' of the ${s.kind} type '${q(s.type)}' is mapped by an earlier step: a property has one map`);
    mapped.add(key);
    const pairs = Object.entries(s.values);
    const same = pairs.find(([k, v]) => k === v);
    if (same) add(i, 'value_equals_key', `the value '${q(same[0])}' is mapped to itself`);
    if (!reached(i, s.kind, s.type)) return;
    // The map names the property by its name AFTER the renames; its before-name is the `from` of the rename that makes it.
    const rename = sound.find((x): x is Extract<ConversionStep, { op: 'renameProperty' }> =>
      x?.op === 'renameProperty' && x.kind === s.kind && x.type === s.type && x.to === s.property);
    const beforeName = rename?.from ?? s.property;
    for (const b of declaredBefore(s.kind, s.type, beforeName)) {
      if (!b.declaration) { add(i, 'property_not_declared_before', `the property '${q(beforeName)}' is not declared by the ${s.kind} type '${q(s.type)}' before the change`); break; }
      const held = enumOf(b.declaration);
      if (!held) { add(i, 'enum_not_declared_before', `the property '${q(beforeName)}' has no enum before the change`); break; }
      const absent = pairs.find(([k]) => !held.includes(k));
      if (absent) { add(i, 'enum_key_not_in_before', `the value '${q(absent[0])}' is not in the enum of '${q(beforeName)}' before the change`); break; }
    }
    const declaration = propertyOf(after, s.kind, s.type, s.property);
    if (!declaration) { add(i, 'property_not_declared_after', `the property '${q(s.property)}' is not declared by the ${s.kind} type '${q(s.type)}' after the change`); return; }
    const held = enumOf(declaration);
    if (!held) { add(i, 'enum_not_declared_after', `the property '${q(s.property)}' has no enum after the change`); return; }
    const missing = pairs.find(([, v]) => !held.includes(v));
    if (missing) add(i, 'enum_value_not_in_after', `the value '${q(missing[1])}' is not in the enum of '${q(s.property)}' after the change`);
  });

  return issues.sort((a, b) => a.step - b.step);
}

// ── What the steps make of one record ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether one split condition holds for one record: `true`, `false`, or `'could_not_evaluate'` (an input too large, an engine error).
 * The caller binds the kind, the type the split is on (`from`, which names the declared properties the run stored for it) and the record.
 * A condition that reads a property the record lacks answers `false`.
 */
export type ConditionJudge = (kind: KnowledgeType, from: string, text: string, record: Readonly<Record<string, unknown>>) => boolean | 'could_not_evaluate';

/** What the steps change of one record: its new type if it changes, the properties to set, the properties to remove. Empty when nothing changes. */
export interface RecordChange { type?: string; set: Record<string, unknown>; unset: string[] }

/** Why the steps cannot convert a record. */
export type NotConvertible = 'no_case_matched' | 'both_set' | 'could_not_evaluate';

/** The field that names a record's type: an edge's label, the `type` of every other kind (as the view of a record has it). */
const typeFieldOf = (kind: KnowledgeType): 'label' | 'type' => ((VIEW_FIELDS[kind] as readonly string[]).includes('label') ? 'label' : 'type');
const hasOwn = (o: object, key: string): boolean => Object.hasOwn(o, key);

/**
 * What `steps` make of `record` (of `kind`), in the fixed order: the type steps first (a rename, or a split by its conditions on the
 * record as it is, the first true case and else `otherwise`), then the property steps of the type the record has afterwards: every
 * rename, then every enum map by the name after the renames. The record is never changed.
 */
export function convertedRecord(
  steps: readonly ConversionStep[], kind: KnowledgeType, record: Readonly<Record<string, unknown>>, judge: ConditionJudge,
): RecordChange | { notConvertible: NotConvertible } {
  const mine = steps.filter(s => s.kind === kind);
  const field = typeFieldOf(kind);
  const current = typeof record[field] === 'string' ? record[field] as string : undefined;

  let after = current;
  const typeStep = current === undefined ? undefined : mine.find(s => (s.op === 'renameType' || s.op === 'splitType') && s.from === current);
  if (typeStep?.op === 'renameType') after = typeStep.to;
  else if (typeStep?.op === 'splitType') {
    let chosen: string | undefined;
    for (const c of typeStep.cases) {
      const answer = judge(kind, typeStep.from, c.when, record);
      if (answer === 'could_not_evaluate') return { notConvertible: 'could_not_evaluate' };
      if (answer) { chosen = c.to; break; }
    }
    chosen ??= typeStep.otherwise;
    if (chosen === undefined) return { notConvertible: 'no_case_matched' };
    after = chosen;
  }

  const properties = isPlainObject(record['properties']) ? record['properties'] : {};
  const set: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const s of mine) {
    if (s.op !== 'renameProperty' || s.type !== after || !hasOwn(properties, s.from)) continue;
    if (hasOwn(properties, s.to)) return { notConvertible: 'both_set' };
    setOwn(set, s.to, properties[s.from]);
    unset.push(s.from);
  }
  for (const s of mine) {
    if (s.op !== 'mapEnum' || s.type !== after) continue;
    const value = hasOwn(set, s.property) ? set[s.property] : (hasOwn(properties, s.property) && !unset.includes(s.property) ? properties[s.property] : undefined);
    if (typeof value === 'string' && hasOwn(s.values, value)) setOwn(set, s.property, s.values[value]);
  }

  return { ...(after !== undefined && after !== current ? { type: after } : {}), set, unset: unset.sort() };
}
