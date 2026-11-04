/**
 * Is `incoming` a hash this write KNOWS, and does the row's `stored` hash equal it?
 *
 * The one place the "same bytes" test is spelled, for the dispatcher's `settledAndIdentical` and the write door's `replaceContent`.
 * What it prevents: an unknown hash (`undefined`, or the empty string a caller without a hash passes) read as equal to a row that has
 * none, which leaves a file silently unprocessed, discovered only when someone searches for it and it is not there. An unknown hash
 * is never the same bytes.
 */
export function sameKnownHash(incoming: string | undefined, stored: string | undefined): boolean {
  return incoming !== undefined && incoming !== '' && stored === incoming;
}
