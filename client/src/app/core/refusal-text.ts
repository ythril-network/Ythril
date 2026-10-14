import type { TranslocoService } from '@jsverse/transloco';
import { formatList } from './list-format';
import { pluralText } from './plural-text';

/**
 * The ONE module that turns a failed request into words and rows (`Q-133`, bundle-23 `R6-14`).
 *
 * ## Why it is one module
 *
 * Three formatters said a refusal three ways (`fmtApiError`, `refusalText`, `httpErrorReason`) and sixty-odd screens read
 * `err.error.error` by hand. Q-93 and F-46 change what a refusal body IS: the `error` of a schema refusal is a CODE
 * (`schema_violation`), the sentence moves to `message`, and the rows (`introduced`, `preExisting`, `declared`, `truncated`,
 * a rule's `outcome`) are structured. A reader that still takes `error` shows the code, or the server's English, in every
 * language. So the body is read HERE and nowhere else (`refusal-readers-go-through-one-formatter.spec.ts` holds it), and the
 * three entry points below answer three different questions about it:
 *
 * - {@link describeRefusal}: the body -> a {@link RefusalView} (a sentence AND rows), for a screen that renders them;
 * - {@link refusalText}: the body -> one string, for a toast or a one-line error (the view's `text`);
 * - {@link httpErrorReason}: the body -> one untranslated string, for a state that has no translation service to hand.
 *
 * A code the client has no words for still says something true, so the server's sentence is the fallback - never a blank,
 * never the raw code. A refusal that is the server's own fault (a 5xx) carries the request id its log line is filed under.
 *
 * ## What it reads, and in which order
 *
 * 1. a 412 answers "someone changed the schema" and offers a reload, whatever the body says (the If-Match precondition);
 * 2. a `schema_violation` body is rows: an undeclared key, a broken property, a rule that is violated, could not be
 *    evaluated or was too large to check. Each row is its own sentence, built from a translation key, with its numbers
 *    formatted for the reader (`Intl.NumberFormat`), its lists by `Intl.ListFormat` and its plural by `Intl.PluralRules`;
 * 3. a `code` the client knows, translated under `keyPrefix` (the network refusals by default, `files.refusal` for a file
 *    act: a code names a sentence only inside its own family);
 * 4. the body's own prose, and last the caller's `fallbackKey`.
 */

/** Translation service as this module needs it: `translate`, and `getActiveLang` when the caller wants the language read for it. */
export type RefusalTranslator = {
  translate(key: string, params?: Record<string, unknown>): string;
  getActiveLang?: TranslocoService['getActiveLang'];
};
type Translate = RefusalTranslator;

/** The body of a refusal as far as callers name its members; anything else the server sent rides along unread. */
export interface RefusalBody {
  error?: string;
  message?: string;
  code?: string;
  path?: string;
  heldBy?: string;
}

/** What a failed request looks like to this module: an `HttpErrorResponse`, or anything thrown. Everything optional. */
export interface RefusalSource {
  error?: RefusalBody | null;
  message?: string;
  status?: number;
  statusText?: string;
  headers?: { get(name: string): string | null };
}

/** A row of a refusal or a warning, as the server writes it (`SchemaViolationError.toStructured()`). */
export interface WireRow {
  field: string;
  value?: unknown;
  reason?: string;
  declared?: string[];
  outcome?: string;
}

/** One sentence about one thing that is wrong with a write, and what kind of wrong it is. */
export interface RefusalRow {
  field: string;
  text: string;
  /** `introduced` is what THIS write broke, `preExisting` what the record already had, `warning` a violation that did not block. */
  kind: 'introduced' | 'preExisting' | 'warning';
  /** `undeclared` is a property key the type does not declare; the other three are the outcomes of a check. */
  outcome: 'undeclared' | 'violated' | 'could_not_evaluate' | 'too_large';
  /** The property key an undeclared or broken property row is about, without the `properties.` prefix; '' for any other field. */
  key: string;
}

/** What a refusal says: the whole sentence, its parts for a screen that lays them out, its rows, and whether a reload is the way out. */
export interface RefusalView {
  /** Everything, as one string: the headline, every row, the count of rows left out. */
  text: string;
  rows: RefusalRow[];
  /** True for a 412: the schema changed under the caller and reloading it is the recovery. */
  reload: boolean;
  /** The sentence before the rows; the same as `text` when there are no rows. */
  headline: string;
  /** "and N more rows were left out", '' when the answer was not cut. */
  more: string;
}

const REQUEST_ID_HEADER = 'X-Request-Id';
const PROPERTIES_PREFIX = 'properties.';
const RULE_FIELDS = /^(?:meta\.)?rules\./;
/** A single token with no space: a machine code (`schema_violation`, `MFA_REQUIRED`), not a sentence. */
const CODE_LIKE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Errors worth correlating: a server fault, or a request that never got an answer at all. */
function worthCorrelating(status: number | undefined): boolean {
  return status === 0 || status === undefined || status >= 500;
}

/**
 * `text` with the failure's request id appended when it is one worth quoting: a server fault or a request that got no
 * answer, and only when the response carried the header. The server logs that id with every unhandled error, so it is the
 * key from the screen to the log line; a 4xx the caller caused is self-explanatory and the id would be noise.
 */
export function withRequestId(text: string, err: unknown): string {
  const e = err as RefusalSource | null;
  if (!e || !worthCorrelating(e.status)) return text;
  let id: string | null = null;
  // Defensive: `headers.get` throws on nothing real, but this runs inside every error path in the app and must never be
  // the reason an error message fails to render.
  try { id = e.headers?.get(REQUEST_ID_HEADER) ?? null; } catch { id = null; }
  if (!id) return text;
  return text ? `${text} (request ${id})` : `request ${id}`;
}

const bodyOf = (err: unknown): Record<string, unknown> | null => {
  const body = (err as RefusalSource | null | undefined)?.error;
  return body !== null && typeof body === 'object' ? body as Record<string, unknown> : null;
};

const nonEmpty = (v: unknown): string => (typeof v === 'string' && v.trim() ? v : '');

/**
 * The body's `error` member, exactly as the server wrote it: a machine code for a schema refusal and for the MFA answers,
 * a sentence for most of the rest. For the caller that branches on the code (`MFA_REQUIRED`) and so must read it; every
 * other reader wants words, and asks {@link refusalText}.
 */
export function answerErrorField(err: unknown): string {
  return nonEmpty(bodyOf(err)?.['error']);
}

/**
 * The `issues` a refused request body lists (a zod-body refusal: `{ error, issues: [{ code, path, keys? }] }`), or [] when it lists none.
 * For the caller that follows an issue's path to the control it is about; the words for the refusal as a whole are `refusalText`'s.
 */
export function refusalIssues(err: unknown): unknown[] {
  const issues = bodyOf(err)?.['issues'];
  return Array.isArray(issues) ? issues : [];
}

/** The body's own prose: its `message` when `error` is a code, else its `error`; '' when it states none. */
function proseOf(err: unknown): string {
  const body = bodyOf(err);
  if (!body) return '';
  const error = nonEmpty(body['error']);
  const message = nonEmpty(body['message']);
  if (message && (!error || CODE_LIKE.test(error))) return message;
  return error;
}

const isSchemaViolation = (body: Record<string, unknown> | null): boolean => body?.['error'] === 'schema_violation';

const rowsOf = (v: unknown): WireRow[] =>
  Array.isArray(v) ? v.filter((r): r is WireRow => r !== null && typeof r === 'object' && typeof (r as WireRow).field === 'string') : [];

const languageOf = (transloco: Translate, language?: string): string => language || transloco.getActiveLang?.() || 'en';

/** The key's sentence, or `''` when the translation service answers the key itself (no such key). */
function tryTranslate(transloco: Translate, key: string, params?: Record<string, unknown>): string {
  const text = transloco.translate(key, params);
  return text && text !== key ? text : '';
}

type Outcome = RefusalRow['outcome'];

/** Which of the four kinds of wrong a row is. An outcome this client has no word for is a violation: its reason is the answer. */
function outcomeOf(row: WireRow): Outcome {
  if (row.outcome === 'could_not_evaluate' || row.outcome === 'too_large') return row.outcome;
  if (row.field.startsWith(PROPERTIES_PREFIX) && Array.isArray(row.declared)) return 'undeclared';
  return 'violated';
}

/** The name a rule row is about: `rules.minAge` and `meta.rules.minAge` are both `minAge`. */
const ruleNameOf = (field: string): string => field.replace(RULE_FIELDS, '');

function rowText(transloco: Translate, language: string, row: WireRow, kind: RefusalRow['kind']): { text: string; outcome: Outcome; key: string } {
  const outcome = outcomeOf(row);
  const isRule = RULE_FIELDS.test(row.field);
  const key = row.field.startsWith(PROPERTIES_PREFIX) ? row.field.slice(PROPERTIES_PREFIX.length) : '';
  const when = kind === 'preExisting' ? 'preExisting' : 'introduced';
  const reason = row.reason ?? '';
  const subject = key || row.field;
  const family = 'refusal.row';
  const ask = (name: string, params: Record<string, unknown>): string => tryTranslate(transloco, `${family}.${name}.${when}`, params);

  let text = '';
  if (outcome === 'undeclared') {
    text = ask('undeclared', { key, declared: formatList(row.declared ?? [], language) });
  } else if (outcome === 'could_not_evaluate') {
    text = ask('couldNotEvaluate', { name: ruleNameOf(row.field) });
  } else if (outcome === 'too_large') {
    text = ask('tooLarge', { name: ruleNameOf(row.field) });
  } else if (isRule) {
    text = ask('rule', { message: reason });
  } else {
    text = ask('violated', { field: subject, reason });
  }
  // A key the shipped locale lacks must still say the server's reason, and about WHAT, rather than the raw key: never blank.
  // A rule's reason is its author's message and stands alone.
  const fallback = isRule || !reason ? reason || subject : `${subject}: ${reason}`;
  return { text: text || fallback, outcome, key };
}

function toRows(transloco: Translate, language: string, rows: WireRow[], kind: RefusalRow['kind']): RefusalRow[] {
  return rows.map(r => ({ field: r.field, kind, ...rowText(transloco, language, r, kind) }));
}

/**
 * The sentences for the `warnings` of a write that SUCCEEDED (warn mode, or a violation a strict space does not block).
 * The same row builder as a refusal, so a warning and a refusal about one key read alike.
 */
export function describeWarnings(transloco: Translate, language: string, warnings: unknown): RefusalRow[] {
  return toRows(transloco, languageOf(transloco, language), rowsOf(warnings), 'warning');
}

/** The property keys a view's INTRODUCED rows are about, mapped to their sentence: what each properties editor row marks invalid. */
export function propertyErrors(view: RefusalView | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of view?.rows ?? []) if (r.kind === 'introduced' && r.key) out[r.key] = r.text;
  return out;
}

/** The undeclared-key rows a retype can resolve by removing the key, and whether the refusal is ONLY those (else the removal would not fix the write). */
export function retypeKeys(err: unknown): { key: string; value: unknown }[] | null {
  const body = bodyOf(err);
  if (!isSchemaViolation(body)) return null;
  const introduced = rowsOf(body!['introduced']);
  if (introduced.length === 0) return null;
  if (!introduced.every(r => r.field.startsWith(PROPERTIES_PREFIX) && Array.isArray(r.declared))) return null;
  return introduced.map(r => ({ key: r.field.slice(PROPERTIES_PREFIX.length), value: r.value }));
}

function describeViolation(transloco: Translate, language: string, body: Record<string, unknown>): { headline: string; rows: RefusalRow[]; more: string } {
  let introduced = rowsOf(body['introduced']);
  const preExisting = rowsOf(body['preExisting']);
  // An answer that carries only `violations` (the union) states its rows once; take them as this write's.
  if (introduced.length === 0 && preExisting.length === 0) introduced = rowsOf(body['violations']);
  const rows = [...toRows(transloco, language, introduced, 'introduced'), ...toRows(transloco, language, preExisting, 'preExisting')];

  // The server states `truncated` only when it cut rows; whatever number it states is said, so a count is never swallowed.
  const left = typeof body['truncated'] === 'number' && body['truncated'] >= 0 ? body['truncated'] : null;
  const more = left === null ? '' : pluralText(transloco, language, 'refusal.truncated', left);

  const headline = rows.length === 0 && !more
    // Nothing structured to say: the server's own sentence is the truest thing there is.
    ? nonEmpty(body['message']) || tryTranslate(transloco, 'refusal.schema.headline')
    : tryTranslate(transloco, 'refusal.schema.headline');
  return { headline, rows, more };
}

/**
 * What a refused request says, as a sentence and as rows. See the module docblock for the order it reads the answer in.
 *
 * `fallbackKey` is the caller's sentence for an answer that carried nothing. `keyPrefix` is the family a `code` is
 * translated under (the network refusals by default). `language` formats numbers, lists and plurals; '' reads the active one.
 */
export function describeRefusal(
  transloco: Translate,
  language: string,
  err: RefusalSource | null | undefined,
  fallbackKey?: string,
  keyPrefix = 'networks.refusal',
): RefusalView {
  const lang = languageOf(transloco, language);
  const plain = (text: string, reload = false): RefusalView => ({ text, rows: [], reload, headline: text, more: '' });

  if (err?.status === 412) return plain(tryTranslate(transloco, 'refusal.schemaChanged') || proseOf(err), true);

  const body = bodyOf(err);
  if (body && isSchemaViolation(body)) {
    const { headline, rows, more } = describeViolation(transloco, lang, body);
    const text = [headline && rows.length ? `${headline}: ${rows.map(r => r.text).join('; ')}` : headline, more].filter(Boolean).join(rows.length ? ' - ' : ' ');
    return { text: withRequestId(text, err), rows, reload: false, headline, more };
  }

  const code = nonEmpty(body?.['code']);
  if (code) {
    const sentence = tryTranslate(transloco, `${keyPrefix}.${code}`, { path: nonEmpty(body?.['path']), heldBy: nonEmpty(body?.['heldBy']) });
    if (sentence) return plain(withRequestId(sentence, err));
  }
  const prose = proseOf(err);
  if (prose) return plain(withRequestId(prose, err));
  return plain(withRequestId(fallbackKey ? transloco.translate(fallbackKey) : '', err));
}

/**
 * The sentence to show for a refused request, as one string: the translation of its `code` when this client knows the
 * code, the structured sentence of a schema refusal, the server's own prose when it does not, and `fallbackKey` when the
 * answer carried none (`Q-133`). For a toast or a one-line error; a screen that lays out rows asks {@link describeRefusal}.
 */
export function refusalText(
  transloco: Translate,
  err: RefusalSource | null | undefined,
  fallbackKey: string,
  keyPrefix = 'networks.refusal',
): string {
  return describeRefusal(transloco, '', err, fallbackKey, keyPrefix).text;
}

/**
 * A short human-readable reason for any thrown error, with no translation service: the server's own sentence, then the
 * HTTP status text, then the JS message. '' when nothing useful is available (the UI then shows a generic line). A server
 * fault carries its request id (see {@link withRequestId}).
 */
export function httpErrorReason(err: unknown): string {
  const e = err as RefusalSource | null;
  if (!e) return '';
  const base = (() => {
    const prose = proseOf(e);
    if (prose) return prose;
    if (typeof e.statusText === 'string' && e.statusText && e.statusText !== 'OK') {
      return e.status ? `${e.status} ${e.statusText}` : e.statusText;
    }
    if (typeof e.status === 'number' && e.status > 0) return `HTTP ${e.status}`;
    if (typeof e.message === 'string' && e.message.trim()) return e.message;
    return '';
  })();
  return withRequestId(base, e);
}
