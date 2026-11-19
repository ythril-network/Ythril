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
 *   the schema graph need, and the fingerprint is the one every record names in `dcterms:conformsTo` (the door's `schemaFingerprintOf`).
 */
import type { SpaceMeta } from '@ythril-network/schema';
import type { Config, SpaceConfig } from '../config/types.js';
import type { TokenRights } from '../config/rights-shape.js';
import { rdfBaseConflictOf } from '../spaces/rdf-settle.js';
import { inlineResolvableRefs } from '../spaces/schema-validation.js';
import { termClashes } from './term-iri.js';
import { visibleNetworks } from '../auth/network-rights.js';
import { peerText, NAME_QUOTED } from '../util/log.js';
import { EXPORT_CONFLICT } from '../export/export-statuses.js';

/** The code of a space with RDF off. */
export const RDF_NOT_ENABLED = 'rdf_not_enabled';
/** The code of a space whose base a network contests. */
export const RDF_BASE_CONFLICT = 'rdf_base_conflict';
/** The code of a schema that gives two terms one address: the save doors' code, answered by the exports for a schema stored before the rule. */
export const RDF_TERM_CLASH = 'rdf_term_clash';

/** The code of a stored address no RDF document can carry (a value stored before the doors' rule refused it). */
export const RDF_UNWRITABLE = 'rdf_unwritable';

/** The longest part of a refused address a refusal repeats. */
const UNWRITABLE_SHOWN = 120;

/**
 * An address an export met that no RDF document can carry, with what holds it (`where`: a record, a type, a setting), so the refusal names
 * what to correct. The doors' `IriZ` refuses such an address now; one stored before (bundle-269 review, finding 2) is read and refused here.
 */
export class RdfUnwritable extends Error {
  override readonly name = 'RdfUnwritable';
  constructor(readonly where: string, readonly value: string | undefined) {
    super(`${where} holds an address no RDF document can carry`);
  }
}

/** The `409 rdf_unwritable` of an {@link RdfUnwritable}: what holds the address, the address bounded as peer text, and what to do. */
export function unwritableRefusal(err: RdfUnwritable): { status: typeof EXPORT_CONFLICT; code: typeof RDF_UNWRITABLE; error: string } {
  const shown = err.value === undefined ? '' : ` (${peerText(err.value, { max: UNWRITABLE_SHOWN })})`;
  return {
    status: EXPORT_CONFLICT, code: RDF_UNWRITABLE,
    error: `${err.where} holds an address no RDF document can carry${shown}: an administrator of the space's schema corrects it; the export answers nothing until then`,
  };
}

/** Who asks: what decides which networks a refusal may name. */
export interface RdfCaller { admin?: boolean; rights?: TokenRights | null }

export type RdfSpaceState =
  | { ok: true; meta: SpaceMeta; fingerprint: string }
  | { ok: false; status: typeof EXPORT_CONFLICT; code: typeof RDF_NOT_ENABLED | typeof RDF_BASE_CONFLICT | typeof RDF_TERM_CLASH; error: string; detail?: Record<string, unknown> };

/**
 * The fingerprint of a configured space's schema now (`schemaFingerprintOf`, `spaces/schema-stamp.ts`), handed in by the door: that module sits
 * in the server's largest import cycle, and an act that imported it would join the cycle with everything that imports the act.
 */
export type FingerprintOf = (space: SpaceConfig) => string;

/** Whether `spaceId` (a configured space) can be exported as RDF for `caller`, with its resolved meta and fingerprint. */
export function rdfSpaceState(cfg: Config, spaceId: string, caller: RdfCaller | undefined, fingerprintOf: FingerprintOf): RdfSpaceState {
  const space = cfg.spaces.find(s => s.id === spaceId);
  const rdf = space?.meta?.rdf;
  const named = `'${peerText(spaceId, { max: NAME_QUOTED })}'`;
  if (!space || rdf?.enabled !== true || !rdf.base) {
    return {
      ok: false, status: EXPORT_CONFLICT, code: RDF_NOT_ENABLED,
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
      ok: false, status: EXPORT_CONFLICT, code: RDF_BASE_CONFLICT,
      error: `Space ${named} has an RDF base that a network it is shared in contests, so its addresses are not settled and nothing is exported. `
        + 'An administrator of the space\'s networks settles it: accept the offered base or rebase the space (PATCH /api/spaces/:id with rdf.rebase).'
        + (told.length > 0 ? ` ${told.join('; ')}.` : ''),
      ...(seen.length > 0 ? { detail: { conflict: { held: conflict.held, offered: seen } } } : {}),
    };
  }
  const meta = inlineResolvableRefs(space.meta as SpaceMeta);
  // A schema stored before the clash rule grew (bundle-269 review, finding 6) can hold a pair the save doors now refuse: no migration, the
  // export answers the save's code naming the pair, so the shapes never contradict a record the server accepted.
  const clashes = termClashes(meta, Object.values(cfg.schemaLibraryNamespaces ?? {}));
  if (clashes.length > 0) {
    return {
      ok: false, status: EXPORT_CONFLICT, code: RDF_TERM_CLASH,
      error: `Space ${named} has a schema that gives two terms one RDF address, so its export would contradict its own shapes: `
        + `${clashes.map(c => c.message).join('; ')}. An administrator of its schema gives one of them another address`,
    };
  }
  return { ok: true, meta, fingerprint: fingerprintOf(space) };
}
