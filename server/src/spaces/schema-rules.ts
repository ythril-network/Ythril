/**
 * Custom validation rules written in CEL (F-46): what a rule says about one record when it is EVALUATED, and the stored rules that went
 * bad. What a rule may be when it is SAVED is `@ythril/schema` (`schema/src/rules.ts`), re-exported below, so an app can ask it offline
 * and no door here can save a rule this instance could not apply. The engine is loaded once, there, and run here through the same
 * analysis ({@link compileRule}), so a rule the save accepted and the rule the evaluator runs are judged alike.
 *
 * ## What it prevents
 *
 * A rule is text an operator writes, stored in a space's schema, replicated to every member of a network and evaluated on every write
 * of a strict space — writes that arrive from a peer included:
 *
 * - **No rule can stall the server.** Each set of rules is priced at save (the package); here a value a rule reads over the input caps
 *   (strings of {@link LONGEST_CHECKED_STRING} code points, lists of 100, maps of 200) is not evaluated but reported as too large to check.
 * - **A stored rule that goes bad later is skipped and reported, never enforced as a violation.** A property removed from its type, a
 *   hand-edited `config.json`, a layer from another release: one dead rule must not refuse every write of its type. It is skipped (the
 *   other rules still run), named on `space_meta` as `invalidRules`, counted in `ythril_schema_rules_invalid`, and said once per
 *   (space, rule, content). The ENGINE failing is the opposite case: fail closed, every rule says "could not be evaluated".
 *
 * ## What a rule says about a record
 *
 * Nothing when it holds or does not apply (a PROPERTY it reads is absent). Otherwise one row on `rules.<name>` (`meta.rules.<name>` for a
 * space rule): violated (its message and a short hash of its text, so an edited rule is a new violation), could not be evaluated, or too
 * large to check — the last two value-free. A space whose validation is `off` evaluates nothing.
 */
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  ruleEngine, ENGINE_INPUT_CAPS, compileRule, rulesIn, namesKinds, spaceRuleKinds, LONGEST_CHECKED_STRING,
  type CompiledRule, type Refs, type StoredRule,
} from '@ythril/schema/internal';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import type { SpaceMeta, TypeSchema } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { ALL_VIEW_FIELDS, VIEW_FIELDS, viewFieldValue, type RecordView, type ViewField, type ViewKind } from '../brain/record-view.js';
import type { SchemaViolation } from './schema-validation.js';
import { withLibraryDefinitions } from './library-ref-expansion.js';
import { LruMap } from '../util/lru-map.js';
import { warnOnce } from '../util/warn-once.js';
import { sha256Hex } from '../util/sha256-hex.js';
import { log, NAME_QUOTED, peerText } from '../util/log.js';
import { isPlainObject, ownValue } from '../util/plain-object.js';

// The save-time half — the limits, the rule bodies and the checks every schema door runs — is the package's. Re-exported so a module
// (or a test) that reads it from here reads the one definition.
export {
  MAX_RULE_LENGTH, MAX_MESSAGE_LENGTH, MAX_RULES_PER_TYPE, MAX_RULES_PER_SPACE, MAX_APPLICABLE_RULES, RULE_NAME_PATTERN, LONGEST_CHECKED_STRING,
  TypeRuleZ, SpaceRuleZ, typeRuleIssues, spaceRuleIssues, applicableRuleIssues, ruleMapIssues, readingStoredRules,
  type RuleIssue, type ChangedRuleParts,
} from '@ythril/schema';

const { cel, env, loadError: engineLoadError } = ruleEngine;
const LIST_CAP = ENGINE_INPUT_CAPS.list;
const MAP_CAP = ENGINE_INPUT_CAPS.map;
/** The compiled-program cache is never smaller than this, and grows with the instance's rule count. */
const PROGRAM_CACHE_FLOOR = 2048;
/** The kinds a rule can govern: the knowledge types, by their one declaration. */
const ALL_KINDS: readonly ViewKind[] = KNOWLEDGE_TYPES;
const quoted = (s: string): string => peerText(s, { max: NAME_QUOTED });

/** Whether the rule engine loaded and passed its self-test (the boot check runs the test; before it, whether it loaded). */
let canaryPassed: boolean | null = null;
export function ruleEngineAvailable(): boolean {
  return cel !== null && canaryPassed !== false;
}

/** `self` for the engine: what the view carries, with the fields a rule may always read always present. */
function engineSelf(kind: ViewKind, view: RecordView): Record<string, unknown> {
  // The tags as a list of the engine's own: the view's is read-only.
  return Object.fromEntries(VIEW_FIELDS[kind].map(f => [f, f === 'tags' ? [...view.tags] : viewFieldValue(view, f)]));
}

// ── Write time: what the rules say about one record ─────────────────────────────────────────────────────────────────────────────────

/** A compiled rule for one kind and one declared-property set: the program and what it reads, or dead. */
type Program = CompiledRule;

let compileHits = 0;
let compileMisses = 0;
let compileEvictions = 0;
const onEvict = (): void => { compileEvictions++; };
let programs = new LruMap<string, Program>(PROGRAM_CACHE_FLOOR, onEvict);

/** The program for `text` in `kind` against `declared` (`null`: a space rule's open map). Dead when it no longer compiles or reads what is not declared. */
function programFor(kind: ViewKind, level: 'type' | 'space', declared: ReadonlySet<string> | null, text: string): Program {
  const key = `${kind}\u0000${level}\u0000${declared === null ? '*' : [...declared].sort().join('\u0001')}\u0000${text}`;
  const cached = programs.get(key);
  if (cached) { compileHits++; return cached; }
  compileMisses++;
  const program = compileRule(kind, level, declared, text);
  programs.set(key, program);
  return program;
}

let evaluations = 0;
/** How many rule evaluations the engine has run in this process — the proof that a space in `off` runs none. */
export function ruleEvaluationCount(): number { return evaluations; }

type DurationObserver = (seconds: number) => void;
const durationObservers: DurationObserver[] = [];
/** Called with each evaluation's duration (the metrics registry's histogram); this module does not import the registry. */
export function onRuleEvaluated(observer: DurationObserver): void { durationObservers.push(observer); }

/** Code points of `s`, counted only as far as `cap` + 1. */
function overCodePoints(s: string, cap: number): boolean {
  if (s.length <= cap) return false;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) { const prev = s.charCodeAt(i - 1); if (prev >= 0xd800 && prev <= 0xdbff) continue; }
    if (++n > cap) return true;
  }
  return false;
}

/** Whether `v` is over the input caps, and if so a value-free word for how. */
function oversize(v: unknown, depth = 0): string | undefined {
  if (typeof v === 'string') return overCodePoints(v, LONGEST_CHECKED_STRING) ? `longer than ${LONGEST_CHECKED_STRING} characters` : undefined;
  if (Array.isArray(v)) {
    if (v.length > LIST_CAP) return `a list of more than ${LIST_CAP}`;
    for (const x of v) { const why = oversize(x, depth + 1); if (why) return why; }
    return undefined;
  }
  if (isPlainObject(v)) {
    if (depth > 8) return 'nested too deeply';
    const keys = Object.keys(v);
    if (keys.length > MAP_CAP) return `a map of more than ${MAP_CAP}`;
    for (const k of keys) { const why = oversize(v[k], depth + 1); if (why) return why; }
  }
  return undefined;
}

/** Which path the rule reads is over the caps, as `self.<path> is <how>`, or `undefined`. Only what the rule reads is measured. */
function tooLarge(refs: Refs, self: Record<string, unknown>): string | undefined {
  const props = (isPlainObject(self['properties']) ? self['properties'] : {}) as Record<string, unknown>;
  const check = (path: string, v: unknown): string | undefined => { const why = oversize(v); return why ? `self.${path} is ${why}` : undefined; };
  if (refs.whole) for (const [k, v] of Object.entries(self)) { const why = check(k, v); if (why) return why; }
  for (const f of refs.fields) { const why = check(f, self[f]); if (why) return why; }
  for (const p of refs.props) { const why = check(`properties.${quoted(p)}`, props[p]); if (why) return why; }
  return undefined;
}

/** The short hash that makes a rule's violation its own: the same text gives the same hash, an edited text a new one. */
const ruleHash = (text: string): string => sha256Hex(text).slice(0, 8);

/**
 * What each row {@link evaluateRules} returned read of the record, kept BESIDE the row and not on it: a row is the answer a caller reads
 * and replicates, and what a rule happens to read is the classifier's business only (`ruleReadsChanged`). A row copied by a caller loses
 * it, which is why the classification asks the rows the validator itself returned.
 */
const rowReads = new WeakMap<SchemaViolation, Refs>();

/** What a record's view says for one top-level field a rule may read, in the spelling the rule uses; nothing for a name no view has. */
function viewField(view: RecordView, name: string): unknown {
  return (ALL_VIEW_FIELDS as readonly string[]).includes(name) ? viewFieldValue(view, name as ViewField) : undefined;
}

/** Whether `row` is a RULE's row — `rules.<name>` (a type's rule) or `meta.rules.<name>` (a space rule) — and not a path's. */
export function isRuleRow(row: Pick<SchemaViolation, 'field'>): boolean {
  return /^(meta\.)?rules\./.test(row.field);
}

/**
 * Whether the write changed what the rule behind `row` reads (R6-3), or `undefined` when `row` is not a rule's row.
 *
 * A rule's identity is `(field, reason)`, so a record that breaks the same rule before and after has not necessarily had the same
 * break: a write that replaces the very property the rule reads with another value that fails it the same way is a NEW break, and a
 * record that arrived over sync with a value too large to check must not shelter another one. "Changed" is asked of exactly the paths
 * the rule reads — the fields it names, the properties whose VALUE it reads, the properties whose PRESENCE it tests, and the whole view
 * when it reads `self` whole — so an edit of anything else leaves the break the record's own (P-6).
 *
 * A row the engine could not read a rule for (the engine itself is down: every rule says it could not be evaluated, before and after)
 * has no reads to compare, and nothing the write did is its doing.
 */
export function ruleReadsChanged(row: SchemaViolation, before: RecordView, after: RecordView): boolean | undefined {
  if (!isRuleRow(row)) return undefined;
  const refs = rowReads.get(row);
  if (!refs) return false;
  const differs = (a: unknown, b: unknown): boolean => !isDeepStrictEqual(a, b);
  if (refs.whole) {
    for (const f of ALL_VIEW_FIELDS) if (differs(viewFieldValue(before, f), viewFieldValue(after, f))) return true;
    return false;
  }
  for (const f of refs.fields) if (differs(viewField(before, f), viewField(after, f))) return true;
  // Own keys only (`ownValue`): a property named like something on `Object.prototype` is not on the record because the prototype has it.
  for (const p of refs.props) {
    if (Object.hasOwn(before.properties, p) !== Object.hasOwn(after.properties, p)
      || differs(ownValue(before.properties, p), ownValue(after.properties, p))) return true;
  }
  for (const p of refs.presence) if (Object.hasOwn(before.properties, p) !== Object.hasOwn(after.properties, p)) return true;
  return false;
}

/** The rows the rules of `meta` give `view`, a `kind` record of type schema `typeSchema` (resolved). Nothing when validation is off. */
export function evaluateRules(meta: SpaceMeta, kind: ViewKind, view: RecordView, typeSchema: TypeSchema | undefined): SchemaViolation[] {
  if (meta?.validationMode !== 'warn' && meta?.validationMode !== 'strict') return [];
  const sources: { field: string; rule: StoredRule; level: 'type' | 'space'; declared: ReadonlySet<string> | null }[] = [];
  if (isPlainObject(typeSchema) && isPlainObject((typeSchema as Record<string, unknown>)['rules'])) {
    const declared = new Set(Object.keys(typeSchema.propertySchemas ?? {}));
    for (const [name, r] of rulesIn((typeSchema as Record<string, unknown>)['rules'])) sources.push({ field: `rules.${name}`, rule: r, level: 'type', declared });
  }
  for (const [name, r] of rulesIn((meta as Record<string, unknown>)['rules'])) {
    if (spaceRuleKinds(r).includes(kind)) sources.push({ field: `meta.rules.${name}`, rule: r, level: 'space', declared: null });
  }
  if (sources.length === 0) return [];

  const rows: SchemaViolation[] = [];
  const self = engineSelf(kind, view);
  for (const { field, rule, level, declared } of sources) {
    const hash = ruleHash(rule.rule);
    const addRow = (reason: string, reads?: Refs, outcome?: SchemaViolation['outcome']): void => {
      const row: SchemaViolation = { field, value: undefined, reason, ...(outcome ? { outcome } : {}) };
      if (reads) rowReads.set(row, reads);
      rows.push(row);
    };
    // A rule that could not judge the record: a violation that says which, by its `outcome` as well as in its reason.
    const say = (outcome: NonNullable<SchemaViolation['outcome']>, what: string, reads?: Refs): void => {
      addRow(`${rule.message} — ${what} (rule ${hash})`, reads, outcome);
    };
    const couldNot = (why: string, reads?: Refs): void => { say('could_not_evaluate', `could not be evaluated on this record (${why})`, reads); };
    if (!ruleEngineAvailable()) { couldNot('the rule engine is not available'); continue; }
    const program = programFor(kind, level, declared, rule.rule);
    if (!program.ok) continue; // dead: skipped here, reported by invalidRulesOf and the boot check
    if ([...program.refs.props].some(p => !Object.hasOwn(view.properties, p))) continue; // absent: the rule does not apply
    const large = tooLarge(program.refs, self);
    if (large) { say('too_large', `too large to check: ${large}`, program.refs); continue; }
    evaluations++;
    const t0 = performance.now();
    const out = program.run({ self });
    const seconds = (performance.now() - t0) / 1000;
    for (const observe of durationObservers) observe(seconds);
    if (cel!.isCelError(out)) couldNot(/overload/i.test(out.message) ? 'a value of a type the rule does not compare' : 'an evaluation error', program.refs);
    else if (typeof out !== 'boolean') couldNot('it did not answer true or false', program.refs);
    else if (!out) addRow(`${rule.message} (rule ${hash})`, program.refs);
  }
  return rows;
}

// ── Stored rules that went bad: named, counted, said once ───────────────────────────────────────────────────────────────────────────

/**
 * The stored rules of `meta` that no longer compile, or read what their type no longer declares — NAMES only (`typeSchemas.<kind>.<type>.rules.<name>`,
 * `meta.rules.<name>`), never a rule's text or message. Empty when the engine itself is down: that is not a rule's fault, and calling a live
 * rule dead would open a strict space. Library types are read with their definitions (`withLibraryDefinitions`) by the caller.
 */
export function invalidRulesOf(meta: Partial<SpaceMeta> | undefined): string[] {
  if (!ruleEngineAvailable() || !isPlainObject(meta)) return [];
  const out: string[] = [];
  const typeSchemas = isPlainObject(meta.typeSchemas) ? meta.typeSchemas as Record<string, unknown> : {};
  for (const kind of ALL_KINDS) {
    const types = isPlainObject(typeSchemas[kind]) ? typeSchemas[kind] as Record<string, unknown> : {};
    for (const [typeName, schema] of Object.entries(types)) {
      if (!isPlainObject(schema)) continue;
      const declared = new Set(Object.keys(isPlainObject(schema['propertySchemas']) ? schema['propertySchemas'] : {}));
      for (const [name, r] of rulesIn(schema['rules'])) {
        if (!programFor(kind, 'type', declared, r.rule).ok) out.push(`typeSchemas.${kind}.${typeName}.rules.${name}`);
      }
    }
  }
  for (const [name, r] of rulesIn((meta as Record<string, unknown>)['rules'])) {
    // A rule that names its kinds is dead when it cannot run for one of them; one that names none governs the kinds whose view has
    // what it reads, so it is dead only when it can run for none.
    const runs = spaceRuleKinds(r).map(k => programFor(k, 'space', null, r.rule).ok);
    if (namesKinds(r) ? runs.includes(false) : !runs.includes(true)) out.push(`meta.rules.${name}`);
  }
  return out.slice(0, 200);
}

/** The rule text a dead-rule name points at, for the once-only key: a fix and a new break is said again. */
function textOf(meta: Partial<SpaceMeta>, name: string): string {
  const parts = name.split('.');
  const rule = parts[0] === 'meta'
    ? (meta as Record<string, unknown>)['rules']
    : (((meta.typeSchemas as Record<string, Record<string, Record<string, unknown>>> | undefined)?.[parts[1]!]?.[parts[2]!]) ?? {})['rules'];
  const r = isPlainObject(rule) ? rule[parts[parts.length - 1]!] : undefined;
  return isPlainObject(r) && typeof r['rule'] === 'string' ? r['rule'] : '';
}

let invalidTotal = 0;
const deadSaid = warnOnce<string>({ max: 5_000 });

/** The canary: one known rule compiled and evaluated. False means the engine is not usable, whatever loaded. */
function canary(): boolean {
  if (!cel || !env) return false;
  try {
    const run = cel.plan(env, cel.parse(`self.title == 'canary' && self.tags.all(t, t.matches('^[a-z]+$'))`).expr);
    return run({ self: { title: 'canary', tags: ['ok'] } } as never) === true;
  } catch {
    return false;
  }
}

/**
 * The boot check (R6-4): run the canary, then compile every stored rule of every space. Counts the dead ones for the gauge (set, not
 * added, so a second run does not count them again), names them in one line per space said again only when a dead rule or its
 * text changes, and sizes the program cache to the
 * instance's rule count. Called by `startConfiguredInstanceServices`, the one function boot and the setup route both run.
 */
export async function checkStoredRules(): Promise<{ invalid: number; engine: boolean }> {
  canaryPassed = canary();
  if (!canaryPassed) {
    invalidTotal = 0;
    const why = engineLoadError !== undefined ? 'it could not be loaded' : 'its self-test failed';
    log.error(`Schema rules: the rule engine is not available (${why}): every rule now reports "could not be evaluated", so a strict space `
      + 'refuses the writes its rules govern until the engine loads. Reinstall or rebuild the server image.');
    return { invalid: 0, engine: false };
  }
  let total = 0;
  let ruleCount = 0;
  for (const space of getConfig().spaces) {
    const meta = withLibraryDefinitions(space.meta ?? {});
    ruleCount += Object.keys(isPlainObject(meta.rules) ? meta.rules : {}).length;
    for (const types of Object.values(meta.typeSchemas ?? {})) {
      for (const t of Object.values(types ?? {})) ruleCount += Object.keys(isPlainObject((t as Record<string, unknown>)['rules']) ? (t as Record<string, Record<string, unknown>>)['rules']! : {}).length;
    }
    const dead = invalidRulesOf(meta);
    total += dead.length;
    if (dead.length === 0) { deadSaid.forget(space.id); continue; }
    // One line per space naming its dead rules, said again only when the set or a dead rule's text changes: a restart loop says it
    // once, and a fix followed by a new break is news.
    deadSaid(space.id, () => {
      log.warn(`Schema rules: in space '${peerText(space.id, { max: NAME_QUOTED })}', ${dead.join(', ')} no longer compile${dead.length === 1 ? 's' : ''} `
        + 'or read a property the type no longer declares, so they are SKIPPED (not enforced) until fixed — see invalidRules on space_meta');
    }, sha256Hex(dead.map(n => `${n}\u0000${textOf(meta, n)}`).join('\u0001')));
  }
  invalidTotal = total;
  const wanted = Math.max(PROGRAM_CACHE_FLOOR, 2 * ruleCount);
  if (wanted > programs.max) programs = new LruMap<string, Program>(wanted, onEvict);
  return { invalid: total, engine: true };
}

/** What the metrics registry reads (it imports this module, never the reverse). */
export function ruleEngineStats(): { invalidRules: number; engineAvailable: boolean; compileHits: number; compileMisses: number; compileEvictions: number; evaluations: number } {
  return { invalidRules: invalidTotal, engineAvailable: ruleEngineAvailable(), compileHits, compileMisses, compileEvictions, evaluations };
}

/** The posture row about rules: a FAIL when the engine is down, a warning while stored rules are skipped, nothing when all is well. */
export function rulePostureCheck(): { id: string; level: 'warn' | 'fail'; message: string } | null {
  if (!ruleEngineAvailable()) {
    return { id: 'schema.rules.engine', level: 'fail', message: 'The schema rule engine is not available: every rule reports "could not be evaluated", so strict spaces refuse the writes their rules govern.' };
  }
  if (invalidTotal > 0) {
    return { id: 'schema.rules.invalid', level: 'warn', message: `${invalidTotal} stored schema rule(s) no longer compile and are skipped (not enforced) — see invalidRules on each space's meta.` };
  }
  return null;
}
