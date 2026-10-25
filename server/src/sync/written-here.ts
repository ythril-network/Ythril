/**
 * "Was this row written here?" — the one predicate, as a database filter and as a test of a row (bundle-81, design rev 8 §6d, decisions 3 and 36).
 *
 * ## The question it answers
 *
 * A row is WRITTEN HERE when no peer delivered it AND it is authored by this instance or carries no author at all. It is asked by push selection
 * (a closed, democratic or club network pushes only what was written here), by the landing that stamps the stored `writtenHere` bit, by the
 * derived-description writer (a description is derived only on this instance's own rows), by the file-stamp report, by the file-link delete and by
 * the peer-sidecar retirement (which takes the complement).
 *
 * ## What it prevents
 *
 * The question was spelled at twelve sites as `'author.instanceId': <something>`, each correct for the rows its author had in mind. A row's
 * `author` is the SENDER's text on an arrival (`sync/upsert-plan.ts`), so a spelling that asks the author alone lets a peer push rows that name the
 * receiver as author and have them stored as the receiver's own and re-pushed on the mesh. The predicate therefore asks DELIVERY FIRST
 * (`notDeliveredByAPeer`, `sync/delivered-by.ts`: absent, `''` or this instance), and only then the author.
 *
 * - **Self is one spelling.** `self` is `authorRef().instanceId`, read here. A caller passes nothing, so no site can spell it another way
 *   (`cfg.instanceId`, `authorRef().instanceId ?? null`), and the one that did not is the one that compared a different id.
 * - **The author-less clause is `author: { $exists: false }`** (decision 36). The dotted spelling `'author.instanceId': { $exists: false }` (or
 *   `: null`) also admits `author: null` and `author: {}`, which a malformed arrival can store, and so would call a peer's malformed row ours.
 * - **The complement is `{ $nor: [writtenHereFilter()] }`**: a peer's delivery, or authored by someone else.
 *
 * `every-written-here-question-goes-through-one-predicate` derives every spelling of the question in `server/src` and allows this module and a
 * short list of named exemptions that ask ANOTHER question with the same words (D-14's whose-deletion-governs, the delivery back-fill, the
 * receiver-made placeholder).
 *
 * The filter is ONE `$and`, so a caller composes it with `andPredicates` (never a spread beside its own `$and`, `$or` or `$nor`).
 */
import { authorRef } from '../config/author.js';
import { notDeliveredByAPeer } from './delivered-by.js';

/** The filter matching rows written here: delivery first, then authored here or author-less. */
export function writtenHereFilter(): Record<string, unknown> {
  const self = authorRef().instanceId;
  return { $and: [notDeliveredByAPeer(self), { $or: [{ 'author.instanceId': self }, { author: { $exists: false } }] }] };
}

/** The shape of a row this asks about: what the predicate reads and nothing else. */
export interface WrittenHereRow {
  readonly author?: { readonly instanceId?: unknown } | null | undefined;
  readonly deliveredBy?: unknown;
}

/**
 * Is this row written here? The row's test of {@link writtenHereFilter}: delivery first (a peer's id is never ours, whatever the author
 * says), then authored here or with no author at all. A present but malformed author (`null`, `{}`) is not "no author": it is somebody's, not ours.
 */
export function isWrittenHere(row: WrittenHereRow): boolean {
  const self = authorRef().instanceId;
  const by = row.deliveredBy;
  if (typeof by === 'string' && by !== '' && by !== self) return false;
  if (by !== undefined && by !== null && typeof by !== 'string') return false;
  if (!('author' in row) || row.author === undefined) return true;
  return row.author !== null && typeof row.author === 'object' && row.author.instanceId === self;
}
