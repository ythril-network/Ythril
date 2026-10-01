/**
 * The link half of a plan: refuse what a write's `link*` set cannot hold, before anything is written.
 *
 * `assertDesiredLinks` (`links.ts`) asks the same two questions against the store — a class the record kind
 * cannot hold, and under `strictLinkage` an id that names nothing — and the update paths keep calling it. A
 * planner asks the read set instead, which loaded every link target the batch names in one read and also sees
 * what the batch itself is about to write. Both go through `refuseDesiredLinks`, so the order and the
 * sentences are written once and only the source of "which ids are missing" differs.
 */
import { refuseDesiredLinks, type DesiredLinks } from '../links.js';
import type { RefKind } from '../../config/types-knowledge.js';
import type { ReadSet, ReadWant } from './read-set.js';

/** The records a desired link set names — what `load` must read before `refuseLinks` can answer. */
export function linkTargets(desired: DesiredLinks): NonNullable<ReadWant['records']> {
  const out: NonNullable<ReadWant['records']> = {};
  for (const [kind, ids] of Object.entries(desired) as Array<[RefKind, readonly string[] | undefined]>) {
    if (ids && ids.length > 0) out[kind] = [...(out[kind] ?? []), ...ids];
  }
  return out;
}

/** Throw the refusal a desired link set earns, or return. */
export async function refuseLinks(view: ReadSet, fromKind: RefKind, desired: DesiredLinks): Promise<void> {
  // `assertDesiredLinks`' rule, answered from the read set instead of the store.
  await refuseDesiredLinks(view.spaceId, fromKind, desired, (kind, ids) => view.missing(kind, ids));
}
