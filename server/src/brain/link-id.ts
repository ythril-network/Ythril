/**
 * The identity of one link — derived, so one connection has exactly one id for ever.
 *
 * Its own module because two writers need it and they sit on either side of each other: `links.ts` (the update
 * paths' reconcile) calls the write commit to store link rows, and the commit (`write-plan/commit.ts`) derives
 * the ids of the rows it writes. Living in `links.ts`, it made those two import each other.
 */
import { edgeIdFor } from './edge-id.js';
import { legacyField } from './link-adjacency.js';
import type { RefKind } from '../config/types-knowledge.js';

/**
 * The label a link carries in a traverse result — DERIVED, never stored.
 *
 * `LINK_CLASSES` prints `fact.entityIds`, `chrono.entityIds` and `file.entityIds` today, and the three
 * classes with no reader yet extend the same pattern. Deriving it here means the label a reader shows and
 * the id a writer computes come from one expression: store it and the two can disagree, which is the defect
 * shape this migration exists to remove rather than to reproduce.
 */
export const linkLabel = (fromKind: RefKind, toKind: RefKind): string => `${fromKind}.${legacyField(toKind)}`;

/** The id one connection always has. Exported so the conversion script derives it the same way. */
export const linkIdFor = (from: string, fromKind: RefKind, to: string, toKind: RefKind): string =>
  edgeIdFor(from, to, linkLabel(fromKind, toKind), fromKind, toKind);
