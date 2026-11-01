/**
 * Custom validation rules written in CEL (F-46): what a rule may be when it is SAVED. The one module that judges a rule, so no door
 * can save a rule an instance could not apply — and so an app can ask the same question offline, before it sends a schema.
 *
 * What a rule says about one record when it is EVALUATED is the server's (`server/src/spaces/schema-rules.ts`): it compiles a rule
 * through {@link compileRule} here, so a rule the save-time check accepts and the evaluator compiles are judged by one analysis.
 *
 * ## What it prevents
 *
 * - **A rule that can never be applied is refused where its author is standing.** `@bufbuild/cel` parses and evaluates and does no more
 *   (no exported checker, no cost estimate: the ADR in `docs/decisions` records it), so the checks are ours: the expression parses; it
 *   reads only `self` and only the fields the record's VIEW has (`view-fields.ts` — never an edge's `from`/`to`); a type rule reads
 *   only the properties its type declares; it calls only functions the engine has; `matches()` takes a string LITERAL pattern, compiled
 *   now; it has at most {@link AST_NODE_LIMIT} parts and no loop inside a loop; and it answers true or false on a synthetic set of
 *   records that is LINEAR in the paths it reads (all present, all absent, the boundary values, and each path on its own present and
 *   absent — never every combination). The verdict is cached by content, failures included.
 * - **No rule can stall the server.** Every set of rules that applies to one record is PRICED at save from its syntax tree — nodes,
 *   what each loop runs over, the scans of text — and refused above a fixed budget: a function of the rules alone, never of a
 *   clock, so the same rules are refused the same way every time. The price follows what a rule can make an evaluation do: a list or
 *   a string a rule BUILDS (by `+`) is priced at the size it can reach, since the engine has no run-time limit and the input caps
 *   (strings of {@link LONGEST_CHECKED_STRING} code points, lists of 100, maps of 200) hold only for what a rule reads. The regex
 *   engine is RE2 (linear: `(a+)+$` is only a pattern).
 *
 * The engine is loaded with a top-level `await`, so this package is ESM only.
 */
import { z } from 'zod';
import type * as CelModule from '@bufbuild/cel';
import { KNOWLEDGE_TYPES, type PropertySchema } from './vocabulary.js';
import { VIEW_FIELDS, type ViewKind } from './view-fields.js';
import { LruMap } from './lru-map.js';
import { canonicalJson } from './canonical-json.js';
import { NAME_QUOTED, peerText, refusalOfParse } from './text.js';
import { isPlainObject } from './plain-object.js';
import { isObjectPrototypeName } from './object-internal-keys.js';
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
/**
 * Elements of a list one READ of `self` holds. It is also what a loop is priced per unit of its range: a loop over what a rule only
 * reads runs at most this often, and a loop over a list the rule BUILT (`self.tags + self.tags`) is priced for the bigger list, in
 * caps ({@link SizeInCaps}). The input cap alone bounds nothing a rule makes.
 */
const LIST_CAP = 100;
/** Properties of a map a rule reads whole; a loop over one is priced for this many entries ({@link readSize}). */
const MAP_CAP = 200;
/**
 * What one scan costs per cap of its subject, in node units: RE2 is linear, but over up to {@link LONGEST_CHECKED_STRING} code points
 * for each cap. A scan of a string the rule built is priced by the size it built, not by the one read it started from.
 */
const REGEX_WEIGHT = 100;
/** The functions that scan their subject: the price of one is {@link REGEX_WEIGHT} per cap of the text it is called on. */
const SCANS: ReadonlySet<string> = new Set(['matches', 'contains', 'startsWith', 'endsWith']);
/**
 * What the rules that apply to one record may cost together, in node units (a node evaluated once is 1, inside a loop it is
 * {@link LIST_CAP} times the size of what the loop runs over). The price of a set follows the work the rules can make a write do —
 * what they build as well as what they read — because the engine has no limit of its own at run time. Room for about twenty-five
 * rules of the heaviest shape the other limits allow — one loop over the tags with a regex on each, thirty-odd times — and for every
 * set of ordinary rules; fifty of the heaviest are refused.
 */
const COST_BUDGET = 10_000_000;
/**
 * How much a value of a rule can hold, in caps: 1 is what one read of `self` can hold (a list of {@link LIST_CAP}, a string of
 * {@link LONGEST_CHECKED_STRING} code points), 0 is a literal. A value a rule builds from others holds up to the sum of them.
 */
type SizeInCaps = number;
/**
 * What one read of the top-level field `name` of `self` can hold, in caps. `properties` is a map of up to {@link MAP_CAP} entries and
 * a loop over a map visits each of them, so the map is as many caps as it takes lists of {@link LIST_CAP} to hold that many entries
 * (two): a loop over the properties is priced for the entries it can visit, not for as many as a list holds. Every other field is one cap.
 */
const readSize = (name: string): SizeInCaps => (name === 'properties' ? Math.ceil(MAP_CAP / LIST_CAP) : 1);

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

// ── The record view as the engine sees it ───────────────────────────────────────────────────────────────────────────────────────────

/** Whether `name` is a field of a `kind` view: `VIEW_FIELDS` (`brain/record-view.ts`), the one spelling of what `self` holds (R6-3). */
const hasViewField = (kind: ViewKind, name: string): boolean => (VIEW_FIELDS[kind] as readonly string[]).includes(name);
/** The kinds a rule can govern: the knowledge types, by their one declaration. */
const ALL_KINDS: readonly ViewKind[] = KNOWLEDGE_TYPES;

/** Identifiers CEL itself defines (type names), which a rule may use beside `self`. */
const TYPE_IDENTS: ReadonlySet<string> = new Set(['int', 'uint', 'double', 'bool', 'string', 'bytes', 'list', 'map', 'null_type', 'type', 'dyn']);
/** Operators the planner implements itself rather than through the function table. */
const PLANNER_OPERATORS: ReadonlySet<string> = new Set(['_&&_', '_||_', '_?_:_', '_[_]', '@not_strictly_false']);


// ── Reading a rule's syntax tree ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The protobuf shape `parse` returns, as much of it as this module reads. */
interface Expr { exprKind: { case: string | undefined; value?: unknown } }

/** What a rule reads of `self`. */
export interface Refs {
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

/**
 * Walk one parsed rule: count it, price it, find what it reads, and say what is wrong with it for `scope`. The price is of what the
 * rule can make an evaluation DO, so it follows the size of each value (what a read holds, what a `+` builds) into the loops and the
 * scans that run over it: a rule cannot dodge the budget by making its list or its text rather than reading it.
 */
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

  /**
   * Visit one part of the rule and answer how much it can HOLD, in caps (see {@link SizeInCaps}): the price of a loop or a scan is
   * what it runs over, and what it runs over may be something the rule built.
   */
  const visit = (e: unknown, mult: number, consumed = false): SizeInCaps => {
    if (e === undefined || e === null) return 0;
    a.nodes++;
    a.cost += mult;
    const v = valueOf(e);
    switch (kindOf(e)) {
      case 'constExpr':
        return 0;
      case 'identExpr': {
        const name = String(v['name']);
        if (bound.includes(name)) return 1;
        if (TYPE_IDENTS.has(name)) return 0;
        if (name === 'self') { if (!consumed) a.refs.whole = true; return 1; }
        problem(`reads '${quoted(name)}', which is not a variable a rule has: a rule reads only self (self.title, self.properties.<name>, ...)`);
        return 0;
      }
      case 'selectExpr': {
        const operand = v['operand'];
        const name = String(v['field']);
        const testOnly = v['testOnly'] === true;
        if (isSelf(operand)) { field(name, testOnly, consumed); visit(operand, mult, true); return readSize(name); }
        if (isSelfProperties(operand)) { property(name, testOnly); visit(operand, mult, true); return 1; }
        return visit(operand, mult);
      }
      case 'callExpr': {
        const fn = String(v['function']);
        const target = v['target'];
        const args = (Array.isArray(v['args']) ? v['args'] : []) as unknown[];
        if (fn === '_[_]' && args.length === 2) {
          const key = stringConst(args[1]);
          if (isSelfProperties(args[0])) {
            if (key !== undefined) { property(key, false); visit(args[0], mult, true); visit(args[1], mult); return 1; }
            if (scope.declared) problem('reads self.properties by a computed name: a type rule names each property it reads (self.properties.<name>)');
          } else if (isSelf(args[0]) && key !== undefined) {
            field(key, false, false); visit(args[0], mult, true); visit(args[1], mult); return readSize(key);
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
        }
        const targetSize = visit(target, mult);
        const argSizes = args.map(arg => visit(arg, mult));
        const operands = argSizes.reduce((n, s) => n + s, targetSize);
        // A scan costs what it scans: its subject, which a rule may have built as well as read.
        if (SCANS.has(fn)) a.cost += mult * REGEX_WEIGHT * Math.max(1, target !== undefined ? targetSize : argSizes[0] ?? 0);
        switch (fn) {
          case '_+_': a.cost += mult * operands; return operands; // the copy is paid for as often as it is made
          case '_?_:_': return Math.max(argSizes[1] ?? 0, argSizes[2] ?? 0);
          case '_[_]': return argSizes[0] ?? 0;
          default: return operands;
        }
      }
      case 'listExpr': {
        let size = 0;
        for (const el of (Array.isArray(v['elements']) ? v['elements'] : []) as unknown[]) size += visit(el, mult);
        return size;
      }
      case 'structExpr': {
        let size = 0;
        for (const entry of (Array.isArray(v['entries']) ? v['entries'] : []) as Record<string, unknown>[]) {
          const key = entry['keyKind'] as { case?: string; value?: unknown } | undefined;
          if (key?.case === 'mapKey') size += visit(key.value, mult);
          size += visit(entry['value'], mult);
        }
        return size;
      }
      case 'comprehensionExpr': {
        if (loopDepth > 0) problem('puts a loop inside a loop (a comprehension nested in another): its work grows with the square of the list, so a rule may hold one level');
        const range = Math.max(1, visit(v['iterRange'], mult));
        visit(v['accuInit'], mult);
        const vars = [v['iterVar'], v['iterVar2'], v['accuVar']].filter((x): x is string => typeof x === 'string' && x !== '');
        bound.push(...vars);
        loopDepth++;
        // The body runs once per element, and a range the rule BUILT holds more than the input caps allow a read to.
        const perRun = mult * LIST_CAP * range;
        visit(v['loopCondition'], perRun);
        const step = Math.max(1, visit(v['loopStep'], perRun));
        loopDepth--;
        visit(v['result'], mult);
        bound.splice(bound.length - vars.length, vars.length);
        return range * step;
      }
      default:
        problem('uses a kind of expression a rule cannot hold');
        return 0;
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
export interface StoredRule { rule: string; message: string; kinds?: readonly string[] }
export function rulesIn(map: unknown): [string, StoredRule][] {
  if (!isPlainObject(map)) return [];
  return Object.entries(map).filter((e): e is [string, StoredRule] =>
    isPlainObject(e[1]) && typeof e[1]['rule'] === 'string' && typeof e[1]['message'] === 'string');
}
const declaredOf = (schema: Record<string, unknown>): Map<string, PropertySchema> =>
  new Map(Object.entries(isPlainObject(schema['propertySchemas']) ? schema['propertySchemas'] as Record<string, PropertySchema> : {}));
export const namesKinds = (r: StoredRule): boolean => Array.isArray(r.kinds) && r.kinds.length > 0;
export const spaceRuleKinds = (r: StoredRule): ViewKind[] => (namesKinds(r) ? ALL_KINDS.filter(k => r.kinds!.includes(k)) : [...ALL_KINDS]);
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

// ── What the server's evaluator reads from here (through `@ythril/schema/internal`) ─────────────────────────────────────────────────

/**
 * The engine as this module loaded it: `cel` and its environment, or `null` and the reason it did not load. The server's evaluator and
 * its boot check read the ONE load, so a rule judged here and a rule run there are run by the same engine.
 */
export const ruleEngine: { readonly cel: Cel | null; readonly env: ReturnType<Cel['celEnv']> | null; readonly loadError: unknown } = Object.freeze({
  cel, env, loadError: engineLoadError,
});

/** The input caps a rule's reads are held to at evaluation: a list of `list` elements, a map of `map` entries (see {@link LIST_CAP}). */
export const ENGINE_INPUT_CAPS: Readonly<{ list: number; map: number }> = Object.freeze({ list: LIST_CAP, map: MAP_CAP });

/** A rule compiled for one kind and one declared-property set: the program and what it reads, or dead. */
export type CompiledRule = { ok: true; run: (ctx: { self: unknown }) => unknown; refs: Refs } | { ok: false };

/**
 * `text` compiled for `kind` against `declared` (`null`: a space rule's open map) — dead when it no longer parses, reads what is not
 * declared or passes `matches()` a pattern that does not compile. The same analysis the save-time check runs, so a rule cannot be
 * accepted by one and run differently by the other. Not cached here: the evaluator keeps its own program cache, sized to the instance.
 */
export function compileRule(kind: ViewKind, level: 'type' | 'space', declared: ReadonlySet<string> | null, text: string): CompiledRule {
  const p = parsed(text);
  if (!p.ok || !cel || !env) return { ok: false };
  const declaredMap = declared === null ? null : new Map([...declared].map(k => [k, {} as PropertySchema]));
  const a = analyse(p.expr, { level, kinds: [kind], declared: declaredMap });
  if (a.problems.length > 0 || !a.patterns.every(pt => patternProblem(pt) === undefined)) return { ok: false };
  const planned = cel.plan(env, p.expr as Parameters<Cel['plan']>[1]);
  return { ok: true, run: (ctx) => planned(ctx as never), refs: a.refs };
}
