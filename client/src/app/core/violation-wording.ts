import { formatList } from './list-format';
import { formatCount, pluralText } from './plural-text';
import { translatedOrEmpty, type KeyTranslator } from './translated-text';

/**
 * What a schema violation says to this user (bundle-285, Q-943): the ONE place a violation row becomes a sentence.
 *
 * ## What it prevents
 *
 * The server words a violation in English (`reason`); a screen that showed `reason` said a German reader's problems in English, and each
 * screen that wanted better wrote its own sentence. Since Q-943 every row carries a stable `code` and the `params` its sentence names
 * (`server/src/spaces/schema-violation-codes.ts`), so the client words the row itself, here, in the reader's language. The fallback is inside:
 * a code this client does not know, a row without one (an item stored before the change), params that do not fit the code's shape, or a
 * sentence the locale lacks all answer the server's own `reason`, so no caller can show a raw key, a blank or a guess.
 *
 * ## Values
 *
 * A name or value from a schema or a record (a pattern, a label, an allowed value, a rule's message) is bounded in length here and answered as
 * TEXT: every place binds it as text, never as HTML. A list names its first {@link VIOLATION_LIST_SHOWN} and counts the rest, the server's own
 * cut marker (`…(+N more)`, the last entry of a list it cut) included in the count.
 *
 * `VIOLATION_PARAMS` is the client's code list with the shape of each param; `testing/violation-codes-contract.spec.ts` pins it to the server's
 * table, so a code or a param added there fails the client suite until it has words here.
 */

/**
 * A translator as this module needs it: `translate` alone. The language is the caller's to pass (the one the page's words are loaded in),
 * never read here: a list's "and" and a count's form belong to the sentence around them (`the-active-language-has-one-reader.spec.ts` (d)).
 */
export type ViolationTranslator = KeyTranslator;

/** The declared value types a property can have (`PropertySchema.type`), each with its words under `violation.valueType.<name>`. */
export const VALUE_TYPE_NAMES = ['string', 'number', 'boolean', 'date'] as const;
/** The JSON types a value the validator found can have (`typeof`), each with its words under `violation.valueType.<name>`. */
export const FOUND_TYPE_NAMES = ['string', 'number', 'boolean', 'object'] as const;

/** A param's shape: a text, a finite number, a list of texts, or one of a closed set. */
type ParamShape = 'text' | 'number' | 'list' | readonly string[];

const RULE = { rule: 'text', message: 'text', hash: 'text' } as const;

/** Every code the client words, with the shape of each param its sentence reads (the server's table, pinned by the contract spec). */
export const VIOLATION_PARAMS = {
  type_not_allowed: { allowlist: ['entityTypes', 'edgeLabels', 'memoryTypes', 'chronoTypes'], allowedValues: 'list' },
  ref_unresolved: { entry: 'text' },
  naming_pattern: { type: 'text', pattern: 'text' },
  naming_pattern_not_evaluated: { type: 'text', pattern: 'text' },
  endpoint_type: { label: 'text', end: ['from', 'to'], allowedValues: 'list' },
  functional: { label: 'text', count: 'number' },
  required: { missingProperty: 'text' },
  additional_properties: { additionalProperty: 'text' },
  type: { type: VALUE_TYPE_NAMES, got: FOUND_TYPE_NAMES },
  enum: { allowedValues: 'list' },
  minimum: { comparison: ['>='], limit: 'number' },
  maximum: { comparison: ['<='], limit: 'number' },
  pattern: { pattern: 'text' },
  pattern_not_evaluated: { pattern: 'text' },
  rule: RULE,
  rule_not_evaluated: { ...RULE, cause: ['engine_unavailable', 'type_mismatch', 'evaluation_error', 'not_boolean'] },
  rule_too_large: { ...RULE, path: 'text', bound: ['characters', 'list', 'map', 'depth'], limit: 'number' },
  link_target_removed: { entityId: 'text' },
  reference_not_found: { refField: 'text', refKind: ['entity', 'fact', 'chrono', 'file'], space: 'text', ids: 'list' },
  conversion_error: { errorKind: 'text' },
} as const satisfies Record<string, Readonly<Record<string, ParamShape>>>;

type Code = keyof typeof VIOLATION_PARAMS;

/** How many names of a list a sentence names before it counts the rest. */
export const VIOLATION_LIST_SHOWN = 5;
/** The longest a value from a schema or a record is shown, in characters, its ellipsis included. */
export const VIOLATION_TEXT_MAX = 120;
/** The longest one name of a list is shown. */
const NAME_MAX = 60;
/** The server's mark for the names it cut from a list (`boundedNames`): the last entry, `…(+N more)`. */
const CUT_MARK = /^…\(\+(\d+) more\)$/;

/** A violation row as far as this module reads it: anything else the row carries rides along unread. */
export interface ViolationRowIn {
  reason?: unknown;
  code?: unknown;
  params?: unknown;
}

/** What a violation says: the sentence to show, the key it was worded from (null when it is the server's own), and the server's sentence. */
export interface ViolationWording {
  text: string;
  key: string | null;
  serverText: string;
}

type Params = Record<string, string | number | readonly string[]>;

/** The row's params when every param the code reads is there and has its shape; null otherwise (the row then says its reason). */
function fitting(code: Code, params: unknown): Params | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  const given = params as Record<string, unknown>;
  const out: Params = {};
  for (const [name, shape] of Object.entries(VIOLATION_PARAMS[code]) as [string, ParamShape][]) {
    const v = given[name];
    if (shape === 'text') { if (typeof v !== 'string') return null; out[name] = v; }
    else if (shape === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) return null; out[name] = v; }
    else if (shape === 'list') { if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) return null; out[name] = v as string[]; }
    else { if (typeof v !== 'string' || !shape.includes(v)) return null; out[name] = v; }
  }
  return out;
}

/** A value cut to `max` characters (code points), an ellipsis marking the cut. */
function bounded(value: string, max: number = VIOLATION_TEXT_MAX): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join('')}…`;
}

/** The sentence builder for one row: every piece it asks for must exist, or the whole row says the server's reason. */
class Wording {
  missing = false;
  constructor(private readonly t: ViolationTranslator, readonly language: string) {}

  say(key: string, params: Record<string, unknown> = {}): string {
    const text = translatedOrEmpty(this.t, key, params);
    if (!text) this.missing = true;
    return text;
  }

  /** A counted sentence: the base's form for `count` in this language (`count` and every number formatted). */
  count(base: string, count: number, params: Record<string, unknown> = {}): string {
    const text = pluralText(this.t, this.language, base, count, params);
    if (!text) this.missing = true;
    return text;
  }

  number(n: number): string { return formatCount(this.language, n); }

  /** How many names a list holds in all: the names given plus what the server's cut mark counts. */
  total(values: readonly string[]): number {
    const cut = CUT_MARK.exec(values.at(-1) ?? '');
    return cut ? values.length - 1 + Number(cut[1]) : values.length;
  }

  /** A list joined the language's way: the first names, bounded, then "N more" for the rest. */
  list(values: readonly string[]): string {
    const cut = CUT_MARK.exec(values.at(-1) ?? '');
    const names = cut ? values.slice(0, -1) : values;
    const shown = names.slice(0, VIOLATION_LIST_SHOWN).map(n => bounded(n, NAME_MAX));
    const rest = names.length - shown.length + (cut ? Number(cut[1]) : 0);
    return formatList(rest > 0 ? [...shown, this.count('violation.more', rest)] : shown, this.language);
  }

  /** A declared or found value type in this language, as the type sentence names it. */
  valueType(name: string): string {
    switch (name) {
      case 'string': return this.say('violation.valueType.string');
      case 'number': return this.say('violation.valueType.number');
      case 'boolean': return this.say('violation.valueType.boolean');
      case 'date': return this.say('violation.valueType.date');
      case 'object': return this.say('violation.valueType.object');
      default: this.missing = true; return '';
    }
  }
}

const text = (p: Params, name: string): string => bounded(p[name] as string);
const list = (p: Params, name: string): readonly string[] => p[name] as readonly string[];
const num = (p: Params, name: string): number => p[name] as number;

/** The key each code is worded from (for the caller that records which sentence was said), and the sentence. */
function sentenceOf(w: Wording, code: Code, p: Params): { key: string; text: string } {
  switch (code) {
    case 'type_not_allowed': return { key: 'violation.code.type_not_allowed', text: w.say('violation.code.type_not_allowed', { values: w.list(list(p, 'allowedValues')) }) };
    case 'ref_unresolved': return { key: 'violation.code.ref_unresolved', text: w.say('violation.code.ref_unresolved', { entry: text(p, 'entry') }) };
    case 'naming_pattern': return { key: 'violation.code.naming_pattern', text: w.say('violation.code.naming_pattern', { type: text(p, 'type'), pattern: text(p, 'pattern') }) };
    case 'naming_pattern_not_evaluated': return { key: 'violation.code.naming_pattern_not_evaluated', text: w.say('violation.code.naming_pattern_not_evaluated', { type: text(p, 'type'), pattern: text(p, 'pattern') }) };
    case 'endpoint_type': {
      const params = { label: text(p, 'label'), values: w.list(list(p, 'allowedValues')) };
      return p['end'] === 'from'
        ? { key: 'violation.code.endpoint_type.from', text: w.say('violation.code.endpoint_type.from', params) }
        : { key: 'violation.code.endpoint_type.to', text: w.say('violation.code.endpoint_type.to', params) };
    }
    case 'functional': return { key: 'violation.code.functional', text: w.count('violation.code.functional', num(p, 'count'), { label: text(p, 'label') }) };
    case 'required': return { key: 'violation.code.required', text: w.say('violation.code.required', { property: text(p, 'missingProperty') }) };
    case 'additional_properties': return { key: 'violation.code.additional_properties', text: w.say('violation.code.additional_properties', { property: text(p, 'additionalProperty') }) };
    case 'type': return { key: 'violation.code.type', text: w.say('violation.code.type', { type: w.valueType(p['type'] as string), got: w.valueType(p['got'] as string) }) };
    case 'enum': return { key: 'violation.code.enum', text: w.say('violation.code.enum', { values: w.list(list(p, 'allowedValues')) }) };
    case 'minimum': return { key: 'violation.code.minimum', text: w.say('violation.code.minimum', { limit: w.number(num(p, 'limit')) }) };
    case 'maximum': return { key: 'violation.code.maximum', text: w.say('violation.code.maximum', { limit: w.number(num(p, 'limit')) }) };
    case 'pattern': return { key: 'violation.code.pattern', text: w.say('violation.code.pattern', { pattern: text(p, 'pattern') }) };
    case 'pattern_not_evaluated': return { key: 'violation.code.pattern_not_evaluated', text: w.say('violation.code.pattern_not_evaluated', { pattern: text(p, 'pattern') }) };
    case 'rule': return { key: 'violation.code.rule', text: w.say('violation.code.rule', { message: text(p, 'message') }) };
    case 'rule_not_evaluated': return { key: 'violation.code.rule_not_evaluated', text: w.say('violation.code.rule_not_evaluated', { message: text(p, 'message'), cause: causeOf(w, p['cause'] as string) }) };
    case 'rule_too_large': return { key: 'violation.code.rule_too_large', text: w.say('violation.code.rule_too_large', { message: text(p, 'message'), path: text(p, 'path'), bound: boundOf(w, p['bound'] as string, num(p, 'limit')) }) };
    case 'link_target_removed': return { key: 'violation.code.link_target_removed', text: w.say('violation.code.link_target_removed', { entityId: text(p, 'entityId') }) };
    case 'reference_not_found': {
      const ids = list(p, 'ids');
      return { key: 'violation.code.reference_not_found', text: w.count('violation.code.reference_not_found', w.total(ids), { space: text(p, 'space'), ids: w.list(ids) }) };
    }
    case 'conversion_error': return { key: 'violation.code.conversion_error', text: w.say('violation.code.conversion_error', { errorKind: text(p, 'errorKind') }) };
  }
}

/** Why a rule could not judge the record, in words. */
function causeOf(w: Wording, cause: string): string {
  switch (cause) {
    case 'engine_unavailable': return w.say('violation.cause.engine_unavailable');
    case 'type_mismatch': return w.say('violation.cause.type_mismatch');
    case 'evaluation_error': return w.say('violation.cause.evaluation_error');
    default: return w.say('violation.cause.not_boolean');
  }
}

/** Which input cap a value a rule reads is over, in words, with the cap counted in the language's plural. */
function boundOf(w: Wording, bound: string, limit: number): string {
  switch (bound) {
    case 'characters': return w.count('violation.bound.characters', limit);
    case 'list': return w.count('violation.bound.list', limit);
    case 'map': return w.count('violation.bound.map', limit);
    default: return w.say('violation.bound.depth');
  }
}

/**
 * What a violation row says to this reader: the sentence worded from its code and params in `language` (the language the caller's words are
 * shown in; '' is English), or the server's own `reason` when the client cannot word it. `serverText` is always the server's sentence ('' when it gave none),
 * for the place that keeps it reachable (a title).
 */
export function violationWording(t: ViolationTranslator, language: string, row: ViolationRowIn): ViolationWording {
  const serverText = typeof row.reason === 'string' ? row.reason : '';
  const fallback: ViolationWording = { text: serverText, key: null, serverText };
  const code = row.code;
  if (typeof code !== 'string' || !Object.hasOwn(VIOLATION_PARAMS, code)) return fallback;
  const params = fitting(code as Code, row.params);
  if (!params) return fallback;
  const w = new Wording(t, language || 'en');
  const said = sentenceOf(w, code as Code, params);
  if (w.missing || !said.text) return fallback;
  return { text: said.text, key: said.key, serverText };
}
