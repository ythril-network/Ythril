/**
 * The headers a read of a personal view names its members in (bundle-273, Q-762; bundle-269 drive, finding 11): the members read
 * (`Ythril-View-Members`) and the ones the caller reads that the read left out, RDF off or names not settled. The RDF export and the view's
 * Linked Data address answer through this one writer.
 *
 * ## What it prevents
 *
 * - **A member dropped without a word.** A door that writes the headers itself writes the ones it remembers: the Linked Data address of a
 *   SPARQL view left a member with RDF off out and said nothing, where the export of the same view named it. A door that reads a view as RDF
 *   asks this module, so the list of headers and the reasons they name cannot differ by door.
 * - **A header a browser cannot read.** {@link VIEW_MEMBER_HEADERS} is what a door exposes (`Access-Control-Expose-Headers`), beside the headers
 *   it sets here.
 *
 * Each id is percent-encoded (a header value is Latin-1). A leaf: it imports types only.
 */
import type { Response } from 'express';
import type { MembersLeftOut } from '../rdf/export-shapes.js';

/** The names of the headers {@link setViewHeaders} sets, as a door exposes them. */
export const VIEW_MEMBER_HEADERS = 'Ythril-View-Members, Ythril-View-Members-Without-Rdf, Ythril-View-Members-In-Conflict';

/**
 * Name the view's members on the answer: those read (`Ythril-View-Members`; absent for a space), and those the caller reads that were left
 * out, RDF off (`Ythril-View-Members-Without-Rdf`) or names not settled (`Ythril-View-Members-In-Conflict`). Each a member the guard accepted for
 * the caller.
 */
export function setViewHeaders(res: Response, viewMembers: readonly string[] | undefined, leftOut: MembersLeftOut): void {
  const list = (ids: readonly string[]): string => ids.map(encodeURIComponent).join(', ');
  if (viewMembers) res.setHeader('Ythril-View-Members', list(viewMembers));
  if (leftOut.withoutRdf.length > 0) res.setHeader('Ythril-View-Members-Without-Rdf', list(leftOut.withoutRdf));
  if (leftOut.inConflict.length > 0) res.setHeader('Ythril-View-Members-In-Conflict', list(leftOut.inConflict));
}
