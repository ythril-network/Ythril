/**
 * Whether a space can be exported as RDF now, and the names its export is built from (Q-750, Q-751, design r4 §5.4, §6): the one question
 * both RDF exports ask of every space they read.
 *
 * ## What it prevents
 *
 * - **Addresses that are not settled.** A space with RDF off has no base, and a space whose base a network contests (`rdfBaseConflictOf`,
 *   slice A) would give out names another member does not use: both are refused, `409 rdf_not_enabled` and `409 rdf_base_conflict`.
 * - **A refusal that tells more than the caller may read** (parent, 2026-11-19). The conflict names the offering network, member and base
 *   only to a caller who may read that network through its own doors (`visibleNetworks`: `networks: read` on every space it carries, or
 *   administering them all); anyone else is told the base is in conflict and who can settle it.
 * - **A second spelling of the space's names.** The meta handed back is the resolved one (`inlineResolvableRefs`), which the record form and
 *   the schema graph need, and the fingerprint is the one every record names in `dcterms:conformsTo` (`schemaFingerprintOf`).
 */
import type { SpaceMeta } from '@ythril-network/schema';
import type { Config } from '../config/types.js';
import type { TokenRights } from '../config/rights-shape.js';
import { rdfBaseConflictOf } from '../spaces/rdf-settle.js';
import { inlineResolvableRefs } from '../spaces/schema-validation.js';
import { schemaFingerprintOf } from '../spaces/schema-stamp.js';
import { visibleNetworks } from '../auth/network-rights.js';
import { peerText, NAME_QUOTED } from '../util/log.js';

/** The code of a space with RDF off. */
export const RDF_NOT_ENABLED = 'rdf_not_enabled';
/** The code of a space whose base a network contests. */
export const RDF_BASE_CONFLICT = 'rdf_base_conflict';

/** Who asks: what decides which networks a refusal may name. */
export interface RdfCaller { admin?: boolean; rights?: TokenRights | null }

export type RdfSpaceState =
  | { ok: true; meta: SpaceMeta; fingerprint: string }
  | { ok: false; status: 409; code: typeof RDF_NOT_ENABLED | typeof RDF_BASE_CONFLICT; error: string; detail?: Record<string, unknown> };

/** Whether `spaceId` (a configured space) can be exported as RDF for `caller`, with its resolved meta and fingerprint. */
export function rdfSpaceState(cfg: Config, spaceId: string, caller: RdfCaller | undefined): RdfSpaceState {
  const space = cfg.spaces.find(s => s.id === spaceId);
  const rdf = space?.meta?.rdf;
  const named = `'${peerText(spaceId, { max: NAME_QUOTED })}'`;
  if (!space || rdf?.enabled !== true || !rdf.base) {
    return {
      ok: false, status: 409, code: RDF_NOT_ENABLED,
      error: `Space ${named} has RDF switched off, so its records have no addresses to export: an administrator of its schema switches it on (meta.rdf.enabled)`,
    };
  }
  const conflict = rdfBaseConflictOf(cfg, spaceId);
  if (conflict) {
    const seen = conflict.offered.filter(o => {
      const net = o.networkId === undefined ? undefined : cfg.networks.find(n => n.id === o.networkId);
      return net !== undefined && caller?.rights != null && visibleNetworks({ rights: caller.rights }, [net]).length > 0;
    });
    const told = seen.map(o => `network '${peerText(o.networkId ?? '', { max: NAME_QUOTED })}'${o.memberId ? ` (member '${peerText(o.memberId, { max: NAME_QUOTED })}')` : ''} offers the base ${o.base} at epoch ${o.epoch}`);
    return {
      ok: false, status: 409, code: RDF_BASE_CONFLICT,
      error: `Space ${named} has an RDF base that a network it is shared in contests, so its addresses are not settled and nothing is exported. `
        + 'An administrator of the space\'s networks settles it: accept the offered base or rebase the space (PATCH /api/spaces/:id with rdf.rebase).'
        + (told.length > 0 ? ` ${told.join('; ')}.` : ''),
      ...(seen.length > 0 ? { detail: { conflict: { held: conflict.held, offered: seen } } } : {}),
    };
  }
  return { ok: true, meta: inlineResolvableRefs(space.meta as SpaceMeta), fingerprint: schemaFingerprintOf(space) };
}
