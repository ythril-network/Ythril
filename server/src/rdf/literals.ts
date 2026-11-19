/**
 * The RDF term model every writer and mapper shares, and the one place a stored value becomes a typed literal (Q-749, design r4 sections 5.2, 5.3).
 *
 * ## What it prevents
 *
 * - **A literal typed twice, two ways.** A number written as `xsd:decimal` by the record mapper and as `xsd:integer` by the schema export
 *   would make one value two statements. {@link literalForValue} is the only function that turns a property value into a literal, typed by the
 *   property's DECLARED type (`string`, `number`, `boolean`, `date`), with the lexical form the datatype requires: a decimal has no exponent, a
 *   boolean is `true` or `false`, a date or time keeps its stored text and is typed only when it IS a calendar date or time (a property's
 *   `date` value that is not is left out and named; a record's own time field that is not stays a plain string, {@link literalForTemporal}).
 * - **A guess.** A value that is a list or an object (only a direct database write can leave one; owner, 2026-11-18, decision record 23), a
 *   number that is no decimal (NaN, Infinity) and a value that does not fit its declared type are never written: the outcome says they are LEFT
 *   OUT and why, so the caller can name them. `null` states nothing and is no outcome to name. `rdf:JSON` is used nowhere.
 * - **A broken date presented as one.** {@link literalForTemporal} checks the calendar (month lengths, leap years, hour 24 only as midnight,
 *   zone offsets) and types a value `xsd:dateTimeStamp` (with a zone), `xsd:dateTime` or `xsd:date`; anything else stays a plain string.
 *
 * Terms are plain objects (no class), so a test compares them with `deepEqual`. A blank node's `id` is local to the batch it is written in; the
 * writer labels it. A leaf: it imports only the vocabulary constants.
 */
import { STANDARD_PREFIXES } from './ythril-vocabulary.js';

/** A global name. */
export interface IriTerm { kind: 'iri'; value: string }
/** A blank node; `id` is local to one batch, the writer gives the document-wide label. */
export interface BlankTerm { kind: 'blank'; id: string }
/** A literal: no `datatype` is a plain literal (`xsd:string`, no language tag). */
export interface LiteralTerm { kind: 'literal'; value: string; datatype?: string }
/** An RDF collection; the writer writes it in each format's own way. */
export interface ListTerm { kind: 'list'; items: readonly Term[] }
/** An RDF 1.2 triple term, the object of `rdf:reifies`. */
export interface TripleTerm { kind: 'triple'; subject: IriTerm | BlankTerm; predicate: IriTerm; object: Term }
export type Term = IriTerm | BlankTerm | LiteralTerm | ListTerm | TripleTerm;

/** One statement, in the named graph `graph` or, with none, in the default graph. */
export interface Quad { subject: IriTerm | BlankTerm; predicate: IriTerm; object: Term; graph?: IriTerm }

export const iri = (value: string): IriTerm => ({ kind: 'iri', value });
export const blank = (id: string): BlankTerm => ({ kind: 'blank', id });
export const plain = (value: string): LiteralTerm => ({ kind: 'literal', value });
export const typed = (value: string, datatype: string): LiteralTerm => ({ kind: 'literal', value, datatype });
export const list = (items: readonly Term[]): ListTerm => ({ kind: 'list', items });
export const triple = (subject: IriTerm | BlankTerm, predicate: IriTerm, object: Term): TripleTerm => ({ kind: 'triple', subject, predicate, object });
export const quad = (subject: IriTerm | BlankTerm, predicate: IriTerm, object: Term): Quad => ({ subject, predicate, object });

/** The namespaces of the standard vocabularies a term can be named from. */
export type StandardPrefix = 'rdf' | 'rdfs' | 'xsd' | 'owl' | 'sh' | 'schema' | 'time' | 'dcterms' | 'prov';

/** The address of `local` in a standard vocabulary: `stdIri('rdfs', 'label')`. */
export function stdIri(prefix: StandardPrefix, local: string): IriTerm {
  return iri(STANDARD_PREFIXES[prefix]!.concat(local));
}

/** The address of an XML Schema datatype. */
export const xsd = (local: 'string' | 'decimal' | 'integer' | 'boolean' | 'date' | 'dateTime' | 'dateTimeStamp'): string => STANDARD_PREFIXES['xsd']!.concat(local);

/** The type a property schema declares (`schema/src/vocabulary.ts`, `PropertySchema.type`). */
export type DeclaredType = 'string' | 'number' | 'boolean' | 'date';

/** The kinds of temporal literal. */
export type TemporalKind = 'dateTimeStamp' | 'dateTime' | 'date';

const ZONE = '(?:Z|[+-](?:0\\d|1[0-3]):[0-5]\\d|[+-]14:00)';
/** XSD 1.1 `yearFrag` (Part 2 §D.3.1): four digits, or more with no leading zero (`02026` is no year); year 0000 and negative years are in. */
const YEAR = '(-?(?:[1-9]\\d{3,}|0\\d{3}))';
const DATE_RE = new RegExp(`^${YEAR}-(\\d{2})-(\\d{2})(${ZONE})?$`);
const DATETIME_RE = new RegExp(`^${YEAR}-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?(${ZONE})?$`);

const isLeap = (y: number): boolean => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const NONZERO_DIGIT = /[1-9]/;
const FEBRUARY = 2;
const LEAP_FEBRUARY_DAYS = 29;
const LAST_HOUR = 23;
const LAST_MINUTE_OR_SECOND = 59;
/** Hour 24 is allowed only as the end of a day (24:00:00). */
const END_OF_DAY_HOUR = 24;

/** Is `year-month-day` a day on the calendar? */
function calendarDay(year: string, month: string, day: string): boolean {
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > MONTH_DAYS.length || d < 1) return false;
  return d <= (m === FEBRUARY && isLeap(Number(year)) ? LEAP_FEBRUARY_DAYS : MONTH_DAYS[m - 1]!);
}

/**
 * What kind of temporal literal `s` is, or `null` when it is no calendar date or time: `xsd:date` (`2026-04-05`), `xsd:dateTime`
 * (`2026-04-05T10:00:00`, seconds required) and `xsd:dateTimeStamp` (a dateTime with a zone, `Z` or `+hh:mm`). The text is checked, not just
 * its shape: `2026-02-30` is no date, hour 24 is midnight only, a zone offset is within +-14:00.
 */
export function temporalKind(s: string): TemporalKind | null {
  const date = DATE_RE.exec(s);
  if (date) {
    const [, year, month, day] = date;
    return calendarDay(year!, month!, day!) ? 'date' : null;
  }
  const dateTime = DATETIME_RE.exec(s);
  if (!dateTime) return null;
  const [, year, month, day, hh, mm, ss, fraction, zone] = dateTime;
  if (!calendarDay(year!, month!, day!)) return null;
  const hour = Number(hh);
  const minute = Number(mm);
  const second = Number(ss);
  if (minute > LAST_MINUTE_OR_SECOND || second > LAST_MINUTE_OR_SECOND) return null;
  if (hour === END_OF_DAY_HOUR ? minute !== 0 || second !== 0 || NONZERO_DIGIT.test(fraction ?? '') : hour > LAST_HOUR) return null;
  return zone === undefined ? 'dateTime' : 'dateTimeStamp';
}

/** A temporal literal that keeps the stored text, typed by what it is; a string that is no calendar date or time stays a plain literal. */
export function literalForTemporal(s: string): LiteralTerm {
  const kind = temporalKind(s);
  return kind === null ? plain(s) : typed(s, xsd(kind));
}

/** The decimal lexical form of a finite number: no exponent, `-0` as `0`. Throws for NaN and the infinities (no decimal exists for them). */
export function decimalLexical(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`${String(n)} has no decimal form`);
  if (Object.is(n, -0)) return '0';
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, whole, frac = '', exponent] = m;
  const digits = `${whole}${frac}`;
  const point = whole!.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** An `xsd:decimal` literal, or `null` for a number that is no decimal. */
export function literalForDecimal(n: number): LiteralTerm | null {
  return Number.isFinite(n) ? typed(decimalLexical(n), xsd('decimal')) : null;
}

/** An `xsd:integer` literal, or `null` for a number that is no safe integer. */
export function literalForInteger(n: number): LiteralTerm | null {
  return Number.isSafeInteger(n) ? typed(String(n), xsd('integer')) : null;
}

/** An `xsd:boolean` literal. */
export const literalForBoolean = (b: boolean): LiteralTerm => typed(b ? 'true' : 'false', xsd('boolean'));

/** How an edge's own details are stated: RDF 1.2 `rdf:reifies` of a triple term, or the classic `rdf:Statement`. */
export type EdgeDetails = 'rdf12' | 'reification';

/**
 * Why a value was left out: it is no plain value (a list, an object), it does not fit the type its property declares (or is no decimal), or
 * its property key is empty, and an empty name has no address (only a direct database write can leave one).
 */
export type LeftOutReason = 'not-a-plain-value' | 'does-not-fit-its-declared-type' | 'key-has-no-address';

/** What a stored property value becomes. */
export type ValueOutcome =
  | { kind: 'literal'; literal: LiteralTerm }
  | { kind: 'nothing' }
  | { kind: 'left-out'; reason: LeftOutReason };

/**
 * The literal of one stored property value, typed by the property's declared type (`undefined`: by what the value is). `null` and `undefined`
 * state nothing. A list, an object or anything else that is no string, number or boolean is left out as not a plain value. A value that
 * does not fit its declared type is left out as `does-not-fit-its-declared-type`, for every declared type alike: another JS type than the
 * declared one, a number that is no decimal, a `date` string in none of the temporal grammars ({@link temporalKind}).
 */
export function literalForValue(value: unknown, declared?: DeclaredType | string): ValueOutcome {
  if (value === null || value === undefined) return { kind: 'nothing' };
  const t = typeof value;
  if (t !== 'string' && t !== 'number' && t !== 'boolean') return { kind: 'left-out', reason: 'not-a-plain-value' };
  const known = declared === 'string' || declared === 'number' || declared === 'boolean' || declared === 'date';
  const misfit: ValueOutcome = { kind: 'left-out', reason: known ? 'does-not-fit-its-declared-type' : 'not-a-plain-value' };
  if (known && (declared === 'number' || declared === 'boolean' || declared === 'string') && t !== declared) return misfit;
  if (declared === 'date' && t !== 'string') return misfit;
  if (t === 'boolean') return { kind: 'literal', literal: literalForBoolean(value as boolean) };
  if (t === 'number') {
    const literal = literalForDecimal(value as number);
    return literal === null ? misfit : { kind: 'literal', literal };
  }
  if (declared === 'date') {
    // A date property's value in none of the three temporal grammars does not fit its declared type: left out and named, never a plain
    // string in the date's place (owner's rule; bundle-269 drive, finding 6: `born: "yesterday"` was exported as a string and not counted).
    const literal = literalForTemporal(value as string);
    return literal.datatype === undefined ? misfit : { kind: 'literal', literal };
  }
  return { kind: 'literal', literal: plain(value as string) };
}
