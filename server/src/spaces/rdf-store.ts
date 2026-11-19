/**
 * Writing a space's RDF setting once it has moved: a passed `space_rebase` round landing at its deadline (`apply-rebase-round.ts`), or an admin
 * accepting the base a peer of a voted network offered at a higher epoch (`meta-update.ts`) (Q-748).
 *
 * ## What it prevents
 *
 * Two writers of the moved base, each with its own copy of "parse it as every stored meta is, in the effective meta and in the own definitions
 * (or the next recompute takes it back), and forget the base conflicts it settles". A copy that skipped the own definitions would lose the
 * move at the next layer; one that kept the conflicts would leave the RDF doors answering 409 for a base already taken. One function, called by
 * both. Synchronous: the caller saves.
 */
import type { RdfSetting } from '@ythril-network/schema';
import type { Config, SpaceConfig } from '../config/types.js';
import { parseSpaceMeta } from './body-schemas.js';
import { log, peerText } from '../util/log.js';

/**
 * Store `rdf` as `space`'s setting, parsed, in its effective meta and its own definitions, and forget every network's recorded base conflict of
 * the space. Returns whether it was stored (a meta that no longer parses is said and left as it was).
 */
export function storeMovedRdf(cfg: Config, space: SpaceConfig, rdf: RdfSetting): boolean {
  const effective = parseSpaceMeta({ ...(space.meta ?? {}), rdf }, { against: space.meta ?? {} });
  if (!effective.ok) {
    log.warn(`space '${peerText(space.id)}': its moved RDF base could not be stored: ${peerText(effective.message)}`);
    return false;
  }
  space.meta = effective.meta;
  if (space.ownMeta) {
    const own = parseSpaceMeta({ ...space.ownMeta, rdf }, { against: space.ownMeta });
    if (own.ok) space.ownMeta = own.meta;
  }
  cfg.networks.forEach((n) => {
    if (n.rdfBaseConflicts?.[space.id] === undefined) return;
    const { [space.id]: _gone, ...kept } = n.rdfBaseConflicts;
    n.rdfBaseConflicts = Object.keys(kept).length > 0 ? kept : undefined;
  });
  return true;
}
