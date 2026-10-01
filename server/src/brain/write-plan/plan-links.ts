/**
 * The link half of a plan: refuse what a write's `link*` set cannot hold, before anything is written.
 *
 * `assertDesiredLinks` (`links.ts`) asks the same two questions against the store — a class the record kind
 * cannot hold, and under `strictLinkage` an id that names nothing — and the update paths keep calling it. A
 * planner asks the read set instead, which loaded every link target the batch names in one read and also sees
 * what the batch itself is about to write. Both refuse in the same words: `linkClassRefusal` and
 * `missingRefsRefusal` are the sentences, and neither is written here.
 */
import { linkClassRefusal, type DesiredLinks } from '../links.js';
import { ReferenceRefusal, assertRefs, missingRefsRefusal } from '../entity-refs.js';
import { isStrictLinkage } from '../../spaces/proxy.js';
import { LINK_INPUT_FIELDS, type RefKind } from '../../config/types-knowledge.js';
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
export function refuseLinks(view: ReadSet, fromKind: RefKind, desired: DesiredLinks): void {
  const classes = Object.keys(desired) as RefKind[];
  for (const toKind of classes) {
    const refusal = linkClassRefusal(fromKind, toKind);
    if (refusal) throw new ReferenceRefusal(refusal);
  }
  if (!isStrictLinkage(view.spaceId)) return;
  // Named as the CALLER spells the field, as `assertDesiredLinks` names it.
  for (const toKind of classes) {
    const ids = desired[toKind] ?? [];
    if (ids.length === 0) continue;
    // Shape before existence, as `assertRefsResolve` asks them.
    assertRefs(LINK_INPUT_FIELDS[toKind], toKind, ids);
    const refusal = missingRefsRefusal(view.spaceId, LINK_INPUT_FIELDS[toKind], toKind, view.missing(toKind, ids));
    if (refusal) throw refusal;
  }
}
