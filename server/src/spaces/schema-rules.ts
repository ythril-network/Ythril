/**
 * Custom validation rules written in CEL (F-46): what a rule may be when it is SAVED, and what it says about one record when it is
 * EVALUATED. The one module that runs the engine, so no door can save a rule this instance could not apply, and no validator can run
 * one in a way another does not.
 *
 * ## What it prevents
 *
 * A rule is text an operator writes, stored in a space's schema, replicated to every member of a network and evaluated on every write
 * of a strict space — writes that arrive from a peer included. Three failures follow from that, and each is held here:
 *
 * - **A rule that can never be applied is refused where its author is standing.** `@bufbuild/cel` parses and evaluates and does no more
 *   (no exported checker, no cost estimate: the ADR in `docs/decisions` records it), so the checks are ours: the expression parses; it
 *   reads only `self` and only the fields the record's VIEW has (`brain/record-view.ts` — never an edge's `from`/`to`); a type rule reads
 *   only the properties its type declares; it calls only functions the engine has; `matches()` takes a string LITERAL pattern, compiled
 *   now; it has at most {@link AST_NODE_LIMIT} parts and no loop inside a loop; and it answers true or false on a synthetic set of
 *   records that is LINEAR in the paths it reads (all present, all absent, the boundary values, and each path on its own present and
 *   absent — never every combination). The verdict is cached by content, failures included.
 * - **No rule can stall the server.** Every set of rules that applies to one record is PRICED at save from its syntax tree — nodes,
 *   the largest list a loop can visit, the regex scans — and refused above a fixed budget: a function of the rules alone, never of a
 *   clock, so the same rules are refused the same way every time. The regex engine is RE2 (linear: `(a+)+$` is only a pattern), and
 *   the input a rule reads is capped per evaluation (strings of {@link LONGEST_CHECKED_STRING} code points, lists of 100, maps of 200)
 *   on the paths it reads.
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
import { z } from 'zod';
import type * as CelModule from '@bufbuild/cel';
import { KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import type { PropertySchema, SpaceMeta, TypeSchema } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { ALL_VIEW_FIELDS, VIEW_FIELDS, viewFieldValue, type RecordView, type ViewField, type ViewKind } from '../brain/record-view.js';
import type { SchemaViolation } from './schema-validation.js';
import { withLibraryDefinitions } from './library-ref-expansion.js';
import { LruMap } from '../util/lru-map.js';
import { warnOnce } from '../util/warn-once.js';
import { canonicalJson } from '../util/canonical-json.js';
import { sha256Hex } from '../util/sha256-hex.js';
import { log, NAME_QUOTED, peerText, refusalOfParse } from '../util/log.js';
import { isPlainObject, ownValue } from '../util/plain-object.js';
import { isObjectPrototypeName } from '../util/object-internal-keys.js';
import { PER_TYPE_META_FIELD } from './meta-fields.js';

// ── The limits a caller can hit. The client shows these numbers (client-limits-match-the-server.spec.ts reads them literally). ────────

/** Characters in a rule's text. */
export const MAX_RULE_LENGTH = 1000;
/** Characters in a rule's message — what a refused write says. */
export const MAX_MESSAGE_LENGTH = 300;
/** Rules one type may carry. */
export const MAX_RULES_PER_TYPE = 50;
/** Rules a space may carry. */
export const MAX_RULES_PER_SPACE = 50;
/** Rules that may apply to one record: its type's own plus the space's that name its kind. Refused at save, never truncated at write. */
export const MAX_APPLICABLE_RULES = 50;
/** A rule's name: a lower-case letter, then letters, digits, `_` and `-`, 64 characters in all. */
export const RULE_NAME_PATTERN = '^[a-z][a-zA-Z0-9_-]{0,63}$';

/**
 * The longest string a check reads: a rule reads strings up to this many code points, and a property `pattern` is not run on a value
 * longer than this (`schema-validation.ts` testPattern). One number for both, because both are "how much text a check will look at".
 */
export const LONGEST_CHECKED_STRING = 10_000;

// ── The bounds that are the engine's business (not shown in the editor, so not exported under a limit's name). ───────────────────────

/** Parts of one rule's syntax tree. */
const AST_NODE_LIMIT = 200;
/** Elements of a list a rule reads, and so the most a loop can visit. */
const LIST_CAP = 100;
/** Properties of a map a rule reads whole. */
const MAP_CAP = 200;
/** What one regex scan costs, in node units: RE2 is linear, but over up to {@link LONGEST_CHECKED_STRING} code points. */
const REGEX_WEIGHT = 100;
/**
 * What the rules that apply to one record may cost together, in node units (a node evaluated once is 1, inside a loop it is
 * {@link LIST_CAP}). Room for about twenty-five rules of the heaviest shape the other limits allow — one loop over the tags with a
 * regex on each, thirty-odd times — and for every set of ordinary rules; fifty of the heaviest are refused.
 */
const COST_BUDGET = 10_000_000;
/** The compiled-program cache is never smaller than this, and grows with the instance's rule count. */
const PROGRAM_CACHE_FLOOR = 2048;

const RULE_NAME_RE = new RegExp(RULE_NAME_PATTERN);

// ── The engine, loaded so that its absence is a state and not a crash ───────────────────────────────────────────────────────────────

type Cel = typeof CelModule;
let engineLoadError: unknown;
/*
 * Loaded once, here, and only here. A failure to load (a broken install, a missing file in an image) must not stop the server or the
 * modules that import this one: it is reported by the boot check and fails closed — every rule then says "could not be evaluated".
 */
const cel: Cel | null = await import('@bufbuild/cel').then(m => m as Cel, (err: unknown) => { engineLoadError = err; return null; });
const env = cel ? cel.celEnv() : null;

/** Whether the rule engine loaded and passed its self-test (the boot check runs the test; before it, whether it loaded). */
let canaryPassed: boolean | null = null;
export function ruleEngineAvailable(): boolean {
  return cel !== null && canaryPassed !== false;
}

// ── The record view as the engine sees it ───────────────────────────────────────────────────────────────────────────────────────────

/** Whether `name` is a field of a `kind` view: `VIEW_FIELDS` (`brain/record-view.ts`), the one spelling of what `self` holds (R6-3). */
const hasViewField = (kind: ViewKind, name: string): boolean => (VIEW_FIELDS[kind] as readonly string[]).includes(name);
/** The kinds a rule can govern: the knowledge types, by their one declaration. */
const ALL_KINDS: readonly ViewKind[] = KNOWLEDGE_TYPES;

/** Identifiers CEL itself defines (type names), which a rule may use beside `self`. */
const TYPE_IDENTS: ReadonlySet<string> = new Set(['int', 'uint', 'double', 'bool', 'string', 'bytes', 'list', 'map', 'null_type', 'type', 'dyn']);
/** Operators the planner implements itself rather than through the function table. */
const PLANNER_OPERATORS: ReadonlySet<string> = new Set(['_&&_', '_||_', '_?_:_', '_[_]', '@not_strictly_false']);

/** `self` for the engine: what the view carries, with the fields a rule may always read always present. */
function engineSelf(kind: ViewKind, view: RecordView): Record<string, unknown> {
  // The tags as a list of the engine's own: the view's is read-only.
  return Object.fromEntries(VIEW_FIELDS[kind].map(f => [f, f === 'tags' ? [...view.tags] : viewFieldValue(view, f)]));
}

// ── Reading a rule's syntax tree ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The protobuf shape `parse` returns, as much of it as this module reads. */
interface Expr { exprKind: { case: string | undefined; value?: unknown } }

/** What a rule reads of `self`. */
interface Refs {
  /** `self` itself is read whole (`size(self)`, `self` handed to a function). */
  whole: boolean;
  /** Top-level fields read (`title`, `tags`, `properties` read WHOLE). */
  fields: Set<string>;
  /** `self.properties.<name>` whose VALUE is read — absent, and the rule does not apply. */
  props: Set<string>;
  /** `has(self.properties.<name>)` — presence only. */
  presence: Set<string>;
}

/** Who a rule is checked for: its level, the kinds whose view it reads, and (a type rule) what its type declares. */
interface RuleScope {
  level: 'type' | 'space';
  kinds: readonly ViewKind[];
  /**
   * The kinds are every kind because the rule NAMED none (a space rule without `kinds`). Then a field only some kinds' view has
   * narrows the rule to those kinds — `self.title` governs entities, facts and chrono entries, not edges — instead of refusing it.
   * A rule that names its kinds is held to every one of them.
   */
  implicit?: boolean;
  /** The declared properties of the type, or `null` for a space rule, whose `properties` is an open map. */
  declared: ReadonlyMap<string, PropertySchema> | null;
}

interface Analysis {
  nodes: number;
  cost: number;
  problems: string[];
  refs: Refs;
  patterns: string[];
  /** The kinds of the scope whose view has every field the rule reads: the kinds it governs. */
  kinds: ViewKind[];
}

const kindOf = (e: unknown): string | undefined => (isPlainObject(e) && isPlainObject(e['exprKind']) ? e['exprKind']['case'] as string | undefined : undefined);
const valueOf = (e: unknown): Record<string, unknown> => ((e as Expr).exprKind.value ?? {}) as Record<string, unknown>;
const isSelf = (e: unknown): boolean => kindOf(e) === 'identExpr' && valueOf(e)['name'] === 'self';
const isSelfProperties = (e: unknown): boolean => kindOf(e) === 'selectExpr' && isSelf(valueOf(e)['operand']) && valueOf(e)['field'] === 'properties';
function stringConst(e: unknown): string | undefined {
  if (kindOf(e) !== 'constExpr') return undefined;
  const c = valueOf(e)['constantKind'] as { case?: string; value?: unknown } | undefined;
  return c?.case === 'stringValue' && typeof c.value === 'string' ? c.value : undefined;
}
const quoted = (s: string): string => peerText(s, { max: NAME_QUOTED });

/** Walk one parsed rule: count it, price it, find what it reads, and say what is wrong with it for `scope`. */
function analyse(root: unknown, scope: RuleScope): Analysis {
  const a: Analysis = {
    nodes: 0, cost: 0, problems: [], refs: { whole: false, fields: new Set(), props: new Set(), presence: new Set() }, patterns: [], kinds: [...scope.kinds],
  };
  const problem = (p: string): void => { if (!a.problems.includes(p) && a.problems.length < 5) a.problems.push(p); };
  const bound: string[] = [];
  let loopDepth = 0;

  const field = (name: string, testOnly: boolean, consumed: boolean): void => {
    if (name === 'from' || name === 'to') {
      problem(`reads self.${name}: a rule never sees an edge's ends, because an edge is checked before they exist`);
      return;
    }
    const lacking = scope.kinds.filter(k => !hasViewField(k, name));
    if (scope.implicit && lacking.length < scope.kinds.length) {
      a.kinds = a.kinds.filter(k => !lacking.includes(k));
    } else if (lacking.length > 0) {
      problem(`reads self.${quoted(name)}, which is not a field of ${lacking.length === ALL_KINDS.length ? 'a record' : `a${/^[aeiou]/.test(lacking[0]!) ? 'n' : ''} ${lacking[0]} record`} `
        + `(a rule reads ${[...VIEW_FIELDS[lacking[0]!]].join(', ')})`);
      return;
    }
    if (!testOnly && !(name === 'properties' && consumed)) a.refs.fields.add(name);
  };
  const property = (name: string, testOnly: boolean): void => {
    if (scope.declared && !scope.declared.has(name)) {
      problem(`reads self.properties.${quoted(name)}, which this type does not declare (a type rule reads only the properties its type declares)`);
      return;
    }
    (testOnly ? a.refs.presence : a.refs.props).add(name);
  };

  const visit = (e: unknown, mult: number, consumed = false): void => {
    if (e === undefined || e === null) return;
    a.nodes++;
    a.cost += mult;
    const v = valueOf(e);
    switch (kindOf(e)) {
      case 'constExpr':
        return;
      case 'identExpr': {
        const name = String(v['name']);
        if (bound.includes(name) || TYPE_IDENTS.has(name)) return;
        if (name === 'self') { if (!consumed) a.refs.whole = true; return; }
        problem(`reads '${quoted(name)}', which is not a variable a rule has: a rule reads only self (self.title, self.properties.<name>, ...)`);
        return;
      }
      case 'selectExpr': {
        const operand = v['operand'];
        const name = String(v['field']);
        const testOnly = v['testOnly'] === true;
        if (isSelf(operand)) { field(name, testOnly, consumed); visit(operand, mult, true); return; }
        if (isSelfProperties(operand)) { property(name, testOnly); visit(operand, mult, true); return; }
        visit(operand, mult);
        return;
      }
      case 'callExpr': {
        const fn = String(v['function']);
        const target = v['target'];
        const args = (Array.isArray(v['args']) ? v['args'] : []) as unknown[];
        if (fn === '_[_]' && args.length === 2) {
          const key = stringConst(args[1]);
          if (isSelfProperties(args[0])) {
            if (key !== undefined) { property(key, false); visit(args[0], mult, true); visit(args[1], mult); return; }
            if (scope.declared) problem('reads self.properties by a computed name: a type rule names each property it reads (self.properties.<name>)');
          } else if (isSelf(args[0]) && key !== undefined) {
            field(key, false, false); visit(args[0], mult, true); visit(args[1], mult); return;
          }
        }
        if (!PLANNER_OPERATORS.has(fn) && !env?.funcs.find(fn)) {
          problem(`calls ${quoted(fn)}(), which is not a function a rule can use`);
        }
        if (fn === 'matches') {
          const pattern = target !== undefined ? args[0] : args[1];
          const lit = stringConst(pattern);
          if (lit === undefined) problem('passes matches() a pattern that is not a string literal: the pattern is part of the rule, so a record can never choose the regex run over it');
          else a.patterns.push(lit);
          a.cost += mult * REGEX_WEIGHT;
        }
        visit(target, mult);
        for (const arg of args) visit(arg, mult);
        return;
      }
      case 'listExpr':
        for (const el of (Array.isArray(v['elements']) ? v['elements'] : []) as unknown[]) visit(el, mult);
        return;
      case 'structExpr':
        for (const entry of (Array.isArray(v['entries']) ? v['entries'] : []) as Record<string, unknown>[]) {
          const key = entry['keyKind'] as { case?: string; value?: unknown } | undefined;
          if (key?.case === 'mapKey') visit(key.value, mult);
          visit(entry['value'], mult);
        }
        return;
      case 'comprehensionExpr': {
        if (loopDepth > 0) problem('puts a loop inside a loop (a comprehension nested in another): its work grows with the square of the list, so a rule may hold one level');
        visit(v['iterRange'], mult);
        visit(v['accuInit'], mult);
        const vars = [v['iterVar'], v['iterVar2'], v['accuVar']].filter((x): x is string => typeof x === 'string' && x !== '');
        bound.push(...vars);
        loopDepth++;
        visit(v['loopCondition'], mult * LIST_CAP);
        visit(v['loopStep'], mult * LIST_CAP);
        loopDepth--;
        visit(v['result'], mult);
        bound.splice(bound.length - vars.length, vars.length);
        return;
      }
      default:
        problem('uses a kind of expression a rule cannot hold');
    }
  };
  visit(root, 1);
  if (a.nodes > AST_NODE_LIMIT) problem(`is too complex: ${a.nodes} nodes, and a rule may have at most ${AST_NODE_LIMIT}`);
  if (a.kinds.length === 0 && a.problems.length === 0) problem('reads fields no one kind of record has together (an edge has a label and no title or type), so it could never apply');
  return a;
}

/** The parsed expression, or the reason it is not one (the parser's words, bounded). */
function parsed(text: string): { ok: true; expr: unknown } | { ok: false; problem: string } {
  if (!cel) return { ok: false, problem: 'cannot be checked: the rule engine is not available on this instance' };
  try {
    return { ok: true, expr: cel.parse(text).expr };
  } catch (err) {
    return { ok: false, problem: `does not parse as an expression: ${quoted(String((err as Error)?.message ?? err))}` };
  }
}

/** Why a literal pattern does not compile on the engine's regex, or `undefined` when it does. */
function patternProblem(pattern: string): string | undefined {
  if (!cel) return 'cannot be checked: the rule engine is not available on this instance';
  const r = cel.run('x.matches(p)', { x: '', p: pattern });
  return cel.isCelError(r) ? `passes matches() a pattern that does not compile as a regex: ${quoted(r.message)}` : undefined;
}

// ── Save time: is this rule one the instance can apply, and what does it cost ───────────────────────────────────────────────────────

interface Verdict { ok: boolean; problems: string[]; cost: number }

/** Verdicts by content — rule text, level, kind view, declared properties — failures included (R6-2). */
const verdicts = new LruMap<string, Verdict>(4096);

/** While positive, a parse is READING something already stored (`readingStoredRules`), and the save-time checks do not apply. */
let storedReads = 0;

/**
 * Run `read` with the save-time rule checks off: for parsing a meta a store already holds (`readStoredMeta`). A stored meta was checked
 * when it was stored; a rule in it that no longer compiles is skipped and reported (`invalidRulesOf`), and must not make the parse drop
 * the TYPE that carries it.
 */
export function readingStoredRules<T>(read: () => T): T {
  storedReads++;
  try { return read(); } finally { storedReads--; }
}

/** One sample value per declared property, typical and boundary: what the synthetic records hold. */
function samples(ps: PropertySchema | undefined): [unknown, unknown] {
  if (ps?.enum && ps.enum.length > 0) return [ps.enum[0], ps.enum[ps.enum.length - 1]];
  switch (ps?.type) {
    case 'number': return [1, 0];
    case 'boolean': return [true, false];
    case 'date': return ['2026-01-01', '1970-01-01'];
    default: return ['x', ''];
  }
}

function describeValue(v: unknown): string {
  if (typeof v === 'string') return 'a string';
  if (typeof v === 'number' || typeof v === 'bigint') return 'a number';
  if (v === null) return 'null';
  if (Array.isArray(v) || (cel && cel.isCelList(v))) return 'a list';
  return 'a value that is not true or false';
}

/**
 * The bool check (R6-2): the rule evaluated on records that are linear in the paths it reads — every path present, every path absent,
 * every path at its boundary value, and each path on its own absent and on its own present. An input on which a path the rule reads by
 * VALUE is absent is one where the rule does not apply, as at write time, and is skipped.
 */
function boolProblem(expr: unknown, a: Analysis, scope: RuleScope): string | undefined {
  if (!cel || !env) return 'cannot be checked: the rule engine is not available on this instance';
  const run = cel.plan(env, expr as Parameters<Cel['plan']>[1]);
  const paths = [...new Set([...a.refs.props, ...a.refs.presence])];
  const value = (p: string, which: 0 | 1): unknown => samples(scope.declared?.get(p))[which];
  type Input = { present: Set<string>; which: 0 | 1; says: string };
  const all = new Set(paths);
  const inputs: Input[] = [
    { present: all, which: 0, says: 'every property it reads is present' },
    { present: new Set(), which: 0, says: 'no property it reads is present' },
    { present: all, which: 1, says: 'every property it reads holds its boundary value' },
  ];
  for (const p of paths) {
    inputs.push({ present: new Set(paths.filter(q => q !== p)), which: 0, says: `self.properties.${quoted(p)} alone is absent` });
    inputs.push({ present: new Set([p]), which: 0, says: `self.properties.${quoted(p)} alone is present` });
  }
  for (const kind of a.kinds) {
    for (const input of inputs) {
      if ([...a.refs.props].some(p => !input.present.has(p))) continue;
      const properties = Object.fromEntries([...input.present].map(p => [p, value(p, input.which)]));
      const self = kind === 'edge'
        ? { label: 'x', description: input.which ? '' : 'x', tags: input.which ? [] : ['x'], properties }
        : { title: 'x', type: 'x', description: input.which ? '' : 'x', tags: input.which ? [] : ['x'], properties };
      const out = run({ self } as never);
      if (cel.isCelError(out)) {
        if (/unbound function/i.test(out.message)) return 'calls a function a rule cannot use';
        if (/error parsing regexp/i.test(out.message)) return 'passes matches() a pattern that does not compile as a regex';
        continue; // a value of the wrong type for this record: the record's business at write time, not the rule's
      }
      if (typeof out !== 'boolean') return `does not answer true or false: on a record where ${input.says} it answers ${describeValue(out)}`;
    }
  }
  return undefined;
}

/** The content key of a verdict: everything the verdict depends on, and nothing else. */
function verdictKey(text: string, scope: RuleScope): string {
  const declared = scope.declared === null ? null
    : [...scope.declared.entries()].map(([k, ps]) => [k, ps?.type ?? null, ps?.enum ?? null]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  return canonicalJson({ t: text, l: scope.level, k: [...scope.kinds].sort(), i: scope.implicit === true, d: declared }) as string;
}

/** Is `text` a rule this instance can apply for `scope`, and what does it cost? Cached by content, failures included. */
function judge(text: string, scope: RuleScope): Verdict {
  const key = verdictKey(text, scope);
  const cached = verdicts.get(key);
  if (cached) return cached;
  let verdict: Verdict;
  const p = parsed(text);
  if (!p.ok) verdict = { ok: false, problems: [p.problem], cost: 0 };
  else {
    const a = analyse(p.expr, scope);
    const problems = [...a.problems];
    for (const pattern of a.patterns) {
      const why = patternProblem(pattern);
      if (why && !problems.includes(why)) problems.push(why);
    }
    if (problems.length === 0) {
      const why = boolProblem(p.expr, a, scope);
      if (why) problems.push(why);
    }
    verdict = { ok: problems.length === 0, problems, cost: a.cost };
  }
  verdicts.set(key, verdict);
  return verdict;
}

/** One refusal about a rule, as a zod issue's path (relative to where the check runs) and message. */
export interface RuleIssue { path: (string | number)[]; message: string }

/** A rule as stored, read defensively: the shape is the body's business, so a malformed entry is skipped here and refused there. */
interface StoredRule { rule: string; message: string; kinds?: readonly string[] }
function rulesIn(map: unknown): [string, StoredRule][] {
  if (!isPlainObject(map)) return [];
  return Object.entries(map).filter((e): e is [string, StoredRule] =>
    isPlainObject(e[1]) && typeof e[1]['rule'] === 'string' && typeof e[1]['message'] === 'string');
}
const declaredOf = (schema: Record<string, unknown>): Map<string, PropertySchema> =>
  new Map(Object.entries(isPlainObject(schema['propertySchemas']) ? schema['propertySchemas'] as Record<string, PropertySchema> : {}));
const namesKinds = (r: StoredRule): boolean => Array.isArray(r.kinds) && r.kinds.length > 0;
const spaceRuleKinds = (r: StoredRule): ViewKind[] => (namesKinds(r) ? ALL_KINDS.filter(k => r.kinds!.includes(k)) : [...ALL_KINDS]);
/** How a space rule is judged at save: for the kinds it names, or — naming none — for every kind whose view has what it reads. */
const spaceScope = (r: StoredRule): RuleScope => ({ level: 'space', kinds: spaceRuleKinds(r), implicit: !namesKinds(r), declared: null });

/**
 * The refusals for one inline type's own rules, filed under `collection`: each rule the instance cannot apply, and the price of the set
 * over the budget. Paths are relative to the type (`['rules', name]`). Nothing while a stored meta is being read.
 */
export function typeRuleIssues(collection: string, schema: unknown): RuleIssue[] {
  if (storedReads > 0 || !isPlainObject(schema) || typeof schema['$ref'] === 'string') return [];
  const kind = collection as ViewKind;
  if (!ALL_KINDS.includes(kind)) return [];
  const scope: RuleScope = { level: 'type', kinds: [kind], declared: declaredOf(schema) };
  const issues: RuleIssue[] = [];
  let cost = 0;
  for (const [name, r] of rulesIn(schema['rules'])) {
    const v = judge(r.rule, scope);
    cost += v.cost;
    for (const why of v.problems) issues.push({ path: ['rules', name], message: `rule '${quoted(name)}' ${why}` });
  }
  if (cost > COST_BUDGET) {
    issues.push({ path: ['rules'], message: `the rules of this ${kind} type are over the cost budget a record's rules may have together `
      + '(loops over lists and regex scans cost the most): remove or simplify some' });
  }
  return issues;
}

/** The refusals for a space's own rules: each rule the instance cannot apply for the kinds it names. Paths relative to the meta. */
export function spaceRuleIssues(rules: unknown): RuleIssue[] {
  if (storedReads > 0) return [];
  const issues: RuleIssue[] = [];
  for (const [name, r] of rulesIn(rules)) {
    for (const why of judge(r.rule, spaceScope(r)).problems) {
      issues.push({ path: ['rules', name], message: `rule '${quoted(name)}' ${why}` });
    }
  }
  return issues;
}

/** Which parts of a meta changed, for {@link applicableRuleIssues}: the space rules, and `kind:Type` of each changed type. */
export interface ChangedRuleParts { spaceRules: boolean; types: ReadonlySet<string> }

/**
 * The refusals for what APPLIES to one record (R6-1): a type's own rules plus the space rules that name its kind, at most
 * {@link MAX_APPLICABLE_RULES} and within the cost budget — per kind and type, judged on `meta` as it will be stored. With `only`, the
 * types and kinds a write did not touch are left alone: a stored meta is not re-judged by an unrelated edit.
 */
export function applicableRuleIssues(meta: unknown, only?: ChangedRuleParts): RuleIssue[] {
  if (storedReads > 0 || !isPlainObject(meta)) return [];
  const spaceRules = rulesIn(meta['rules']);
  const held = meta[PER_TYPE_META_FIELD];
  const typeSchemas: Record<string, unknown> = isPlainObject(held) ? held : {};
  const issues: RuleIssue[] = [];
  for (const kind of ALL_KINDS) {
    const applying = spaceRules.filter(([, r]) => spaceRuleKinds(r).includes(kind));
    const spaceVerdicts = applying.map(([, r]) => judge(r.rule, spaceScope(r)));
    if (spaceVerdicts.some(v => !v.ok)) continue; // refused rule by rule already
    const spaceCost = spaceVerdicts.reduce((n, v) => n + v.cost, 0);
    if (applying.length > 0 && (!only || only.spaceRules) && spaceCost > COST_BUDGET) {
      issues.push({ path: ['rules'], message: `the space rules that apply to every ${kind} record are over the cost budget a record's rules may have together: remove or simplify some` });
    }
    const types = isPlainObject(typeSchemas[kind]) ? typeSchemas[kind] as Record<string, unknown> : {};
    for (const [typeName, schema] of Object.entries(types)) {
      if (!isPlainObject(schema) || typeof schema['$ref'] === 'string') continue;
      if (only && !only.spaceRules && !only.types.has(`${kind}:${typeName}`)) continue;
      const own = rulesIn(schema['rules']);
      if (applying.length === 0) continue; // a type's own rules alone are bounded by the type body
      const n = own.length + applying.length;
      const where = `the ${kind} type '${quoted(typeName)}'`;
      if (n > MAX_APPLICABLE_RULES) {
        issues.push({ path: ['rules'], message: `${n} rules apply to ${where} (its own ${own.length} and ${applying.length} of the space's): `
          + `at most ${MAX_APPLICABLE_RULES} rules may apply to one record` });
        continue;
      }
      const scope: RuleScope = { level: 'type', kinds: [kind], declared: declaredOf(schema) };
      const ownVerdicts = own.map(([, r]) => judge(r.rule, scope));
      if (ownVerdicts.some(v => !v.ok)) continue;
      if (ownVerdicts.reduce((c, v) => c + v.cost, spaceCost) > COST_BUDGET) {
        issues.push({ path: ['rules'], message: `the rules that apply to ${where} (its own and the space's) are over the cost budget a record's rules may have together: remove or simplify some` });
      }
    }
  }
  return issues;
}

// ── The shape of a rule, which the bodies declare ───────────────────────────────────────────────────────────────────────────────────

/** A type's rule: exactly its expression and its message. The kind is the collection the type sits under. */
export const TypeRuleZ = z.object({
  rule: z.string().min(1).max(MAX_RULE_LENGTH),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
}).strict();

/** A space's rule: its expression, its message, and the knowledge types it governs (absent or empty: every kind). */
export const SpaceRuleZ = z.object({
  rule: z.string().min(1).max(MAX_RULE_LENGTH),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  kinds: z.array(z.enum(KNOWLEDGE_TYPES)).max(KNOWLEDGE_TYPES.length).optional(),
}).strict();

/**
 * The refusals for a rules MAP's shape: the count, each name (the pattern, and the names `Object.prototype` answers to — a map read by
 * key would answer `toString` from the prototype), and each entry against `ruleZ`. As issues and not as an inner zod failure, so a refusal
 * inside a type body is reported as itself and not as "no branch of the union matched".
 */
export function ruleMapIssues(map: Record<string, unknown>, ruleZ: z.ZodType, max: number): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const names = Object.keys(map);
  if (names.length > max) issues.push({ path: [], message: `${names.length} rules: at most ${max} may be declared here` });
  for (const name of names) {
    if (!RULE_NAME_RE.test(name)) {
      issues.push({ path: [name], message: `the rule name '${quoted(name)}' is not a name: a lower-case letter, then letters, digits, _ and -, 64 characters at most` });
    } else if (isObjectPrototypeName(name)) {
      issues.push({ path: [name], message: `the rule name '${name}' is a name every object answers to, so a rule under it could not be told from the object` });
    }
    const r = ruleZ.safeParse(map[name]);
    if (!r.success) {
      // Read through the one bounded reader, as every parse failure is: the entry's issues become the outer body's, path and reason.
      const refusal = refusalOfParse(r.error);
      refusal.issues.forEach((issue, k) => issues.push({ path: [name, ...issue.path], message: refusal.reasons[k] ?? issue.code }));
    }
  }
  return issues;
}

// ── Write time: what the rules say about one record ─────────────────────────────────────────────────────────────────────────────────

/** A compiled rule for one kind and one declared-property set: the program and what it reads, or dead. */
type Program = { ok: true; run: (ctx: { self: unknown }) => unknown; refs: Refs } | { ok: false };

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
  let program: Program = { ok: false };
  const p = parsed(text);
  if (p.ok && cel && env) {
    const declaredMap = declared === null ? null : new Map([...declared].map(k => [k, {} as PropertySchema]));
    const a = analyse(p.expr, { level, kinds: [kind], declared: declaredMap });
    if (a.problems.length === 0 && a.patterns.every(pt => patternProblem(pt) === undefined)) {
      const planned = cel.plan(env, p.expr as Parameters<Cel['plan']>[1]);
      program = { ok: true, run: (ctx) => planned(ctx as never), refs: a.refs };
    }
  }
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
