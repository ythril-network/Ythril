import { refusalText, httpErrorReason, type RefusalSource, type RefusalTranslator } from './refusal-text';
import { VIEW_REFUSAL_PREFIX } from './views-api.service';

/**
 * What a failed LOAD of a list, a listing or a graph says, in the reader's language.
 *
 * A page that opens a personal view is refused with a coded answer when the view is one the page's door does not read (`view_is_construct`:
 * a view defined by a SPARQL CONSTRUCT is read by the RDF doors alone). The client has one sentence per such code under `views.refusal`.
 * A load that wrote its failure with `httpErrorReason` showed the server's English instead, so every page that stores a failed load
 * asks here: a coded refusal the client has words for reads in those words, any other failure keeps `httpErrorReason`'s text (the
 * server's own sentence, the status text, the request id of a server fault), byte for byte.
 *
 * What it prevents: a German or Polish reader told in English that a view cannot be opened here, while the dictionary holds the
 * sentence. `refusal-keys-have-callers.spec.ts` fails a source that stores a failed load without asking here.
 */
export function loadFailureText(transloco: RefusalTranslator, err: unknown): string {
  const plain = httpErrorReason(err);
  const code = (err as RefusalSource | null | undefined)?.error?.code;
  if (typeof code !== 'string' || code === '') return plain;
  return refusalText(transloco, err as RefusalSource, '', VIEW_REFUSAL_PREFIX) || plain;
}
