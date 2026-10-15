import { computed, type Signal } from '@angular/core';
import { describeRefusal, propertyErrors, type RefusalSource, type RefusalTranslator, type RefusalView } from './refusal-text';

/**
 * What a write surface (a create form, an inline edit row, the record drawer) shows after a refused write, derived from the raw
 * failure it holds.
 *
 * A surface holds the FAILURE (what the request answered), never its words: the words depend on the viewer's language and are
 * made by whoever has the translation service, so a state class with no translation service (the drawer's state, the shared
 * list state) can still hold a refusal, and the component that renders it turns it into a {@link RefusalView} and the
 * per-property messages the properties editor marks its inputs with. One function for both so no surface words a refusal on
 * its own.
 */
export function refusalViewOf(
  transloco: RefusalTranslator,
  failure: Signal<RefusalSource | null>,
  fallbackKey: string,
): Signal<RefusalView | null> {
  return computed(() => {
    const f = failure();
    return f ? describeRefusal(transloco, '', f, fallbackKey) : null;
  });
}

/** The messages a refusal puts on property keys (key -> sentence), for the properties editor's `errors` input. */
export function propertyErrorsOf(view: Signal<RefusalView | null>): Signal<Record<string, string>> {
  return computed(() => propertyErrors(view()));
}
