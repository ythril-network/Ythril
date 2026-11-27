import { answerCode, refusalText, withRequestId, type RefusalSource, type RefusalTranslator } from './refusal-text';
import { RDF_REFUSAL_CODES } from './rdf-names';

/** The key family the RDF doors' refusals are worded under. */
export const RDF_REFUSAL_PREFIX = 'rdf.refusal';

/** The words of an answer with no code this family words, by its HTTP status: a refused body, the rights guard, an unknown space. */
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const STATUS_WORDS: Readonly<Record<number, string>> = {
  [BAD_REQUEST]: 'rdf.refusal.badRequest', [FORBIDDEN]: 'rdf.refusal.forbidden', [NOT_FOUND]: 'rdf.refusal.notFound',
};

/**
 * The words for a refusal of an RDF door on the RDF screens (Q-942): the settings save, the accept of an offered base, a base change, the
 * schema export and the records export.
 *
 * ## What it prevents
 *
 * The server's English on a screen in German or Polish. A code the RDF doors answer is worded under `rdf.refusal.<code>` through
 * `refusal-text.ts` (the one reader of a refusal body); an answer with a code this family does not word, or with none (the rights guard's
 * 403, an unknown space's 404, a lost connection), is worded by its status, never by the prose the server wrote. The second factor's lock
 * keeps its own words, which `refusal-text.ts` gives in every family.
 */
export function rdfRefusalText(t: RefusalTranslator, err: unknown): string {
  const code = answerCode(err);
  if ((RDF_REFUSAL_CODES as readonly string[]).includes(code) || code === 'MFA_LOCKED') {
    return refusalText(t, err as RefusalSource, 'rdf.refusal.failed', RDF_REFUSAL_PREFIX);
  }
  const status = (err as RefusalSource | null)?.status;
  const byStatus = STATUS_WORDS[status ?? 0];
  // A server fault (a 5xx) and a request that got no answer carry the request id their log line is filed under, as every refusal does.
  if (byStatus) return withRequestId(t.translate(byStatus), err);
  if (status === 0 || status === undefined) return withRequestId(t.translate('rdf.refusal.unreachable'), err);
  return withRequestId(t.translate('rdf.refusal.failed'), err);
}

/**
 * Whether the answer is one only this family words: a refusal of the RDF setting (`rdf_base_shared`, `rdf_base_nested`, ...). A screen
 * that words its refusals under another family (the Settings dialog's Save) asks this first, so these are never the server's English.
 */
export function isRdfRefusal(err: unknown): boolean {
  const code = answerCode(err);
  return code.startsWith('rdf_') && (RDF_REFUSAL_CODES as readonly string[]).includes(code);
}
