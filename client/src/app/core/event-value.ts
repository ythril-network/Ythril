/**
 * The value of the control an event came from, typed as the caller's own options.
 *
 * ## What it prevents
 *
 * An `$any($event.target).value` in a template, which type-checks nothing: a handler that read the wrong element would compile. The
 * handler of a `<select>` whose options are the component's own states which type they are, here, once.
 */
export function valueOfEvent<T extends string = string>(e: Event): T {
  return (e.target as HTMLInputElement | HTMLSelectElement).value as T;
}
