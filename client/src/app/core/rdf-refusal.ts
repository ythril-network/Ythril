import { answerCode, refusalText, type RefusalSource, type RefusalTranslator } from './refusal-text';
import { RDF_REFUSAL_CODES } from './rdf-names';

/** The key family the RDF doors' refusals are worded under. */
export const RDF_REFUSAL_PREFIX = 'rdf.refusal';

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
  if (status === 400) return t.translate('rdf.refusal.badRequest');
  if (status === 403) return t.translate('rdf.refusal.forbidden');
  if (status === 404) return t.translate('rdf.refusal.notFound');
  if (status === 0 || status === undefined) return t.translate('rdf.refusal.unreachable');
  return t.translate('rdf.refusal.failed');
}
