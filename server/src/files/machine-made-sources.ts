/**
 * The `descriptionSource` values that say THIS instance made the `description` from the bytes — the only way to tell one from a
 * person's. The one list: the predicate, the Mongo `$in`s, the wire enum and the types all read it, so a third source cannot be
 * added to some and not the others (a description read as a person's, a stamp report that calls a machine's text "edited here").
 */
export const MACHINE_MADE_SOURCES = Object.freeze(['generated', 'extracted'] as const);
export type MachineMadeSource = typeof MACHINE_MADE_SOURCES[number];

/** Whether `value` is a `descriptionSource` that marks a machine-made description. Anything else — absent, a person's — is not. */
export function isMachineMadeSource(value: unknown): value is MachineMadeSource {
  return MACHINE_MADE_SOURCES.some(s => s === value);
}
