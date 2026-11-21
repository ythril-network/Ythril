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
 * - **One address, two meanings.** A base another space of this instance holds too is `409 rdf_base_shared` (the other space named only to
 *   a caller who may read its schema): `<base>schema` would name two ontologies (bundle-269 drive, finding 10). The save doors refuse to make
 *   such a pair (slice F, by the same comparison, `otherHoldersOfRdfBase`); a pair that already exists (a peer's round, a stored config) is
 *   refused here.
 * - **A refusal that blames the wrong holder.** A stored address no document can carry (the base, the vocab, an explicit `iri`, a library
 *   namespace) is `409 rdf_unwritable` naming what holds it, before any record is read (drive, finding 9).
 * - **A second spelling of the space's names.** The meta handed back is the resolved one (`inlineResolvableRefs`), which the record form and
 *   the schema graph need, and the fingerprint is the one every record names in `dcterms:conformsTo` (the door's `schemaFingerprintOf`).
 */
import type { SpaceMeta } from '@ythril-network/schema';
import type { Config, SpaceConfig } from '../config/types.js';
import type { TokenRights } from '../config/rights-shape.js';
import { rdfBaseConflictOf, otherHoldersOfRdfBase, RDF_BASE_SHARED } from '../spaces/rdf-settle.js';
import { inlineResolvableRefs } from '../spaces/schema-validation.js';
import { isWritableIri } from '@ythril-network/schema/internal';
import { prefixesFor, termClashes } from './term-iri.js';
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

/**
 * Who asks: what decides which networks a refusal may name; `id`, the token's, by which an act that writes later (the data import's schema step,
 * Q-955) reads the token again.
 */
export interface RdfCaller { id?: string; admin?: boolean; rights?: TokenRights | null }

// `RDF_BASE_SHARED` (the code of a space whose base another space of this instance holds too) is the save doors' code as well: it lives with
// the one comparison in `spaces/rdf-settle.ts` and is re-exported here for the exports.
export { RDF_BASE_SHARED };

export type RdfSpaceState =
  | { ok: true; meta: SpaceMeta; fingerprint: string }
  | {
    ok: false; status: typeof EXPORT_CONFLICT;
    code: typeof RDF_NOT_ENABLED | typeof RDF_BASE_CONFLICT | typeof RDF_BASE_SHARED | typeof RDF_TERM_CLASH | typeof RDF_UNWRITABLE;
    error: string; detail?: Record<string, unknown>;
  };

/**
 * What in a space's resolved meta holds `value`: the type or property whose explicit `iri` it is (`kind:type[.property]`), else the RDF
 * setting or a library namespace. The one place an address an export cannot write is traced to what an administrator corrects; the schema
 * export asks it for what its writer refuses.
 */
export function holderOfAddress(meta: SpaceMeta, value: string | undefined): string {
  const rdf = meta.rdf;
  if (value !== undefined && rdf?.base !== undefined && value === rdf.base) return 'The RDF setting of the space (meta.rdf.base)';
  if (value !== undefined && rdf?.vocab !== undefined && value === rdf.vocab) return 'The RDF setting of the space (meta.rdf.vocab)';
  for (const [kind, map] of Object.entries((meta.typeSchemas ?? {}) as Record<string, Record<string, { iri?: unknown; propertySchemas?: Record<string, { iri?: unknown }> }> | undefined>)) {
    for (const [type, def] of Object.entries(map ?? {})) {
      if (def?.iri === value) return `The type ${kind}:${type} of the schema (its iri)`;
      for (const [prop, p] of Object.entries(def?.propertySchemas ?? {})) if (p?.iri === value) return `The property ${kind}:${type}.${prop} of the schema (its iri)`;
    }
  }
  return 'The RDF setting of the space (meta.rdf.base or meta.rdf.vocab) or a library namespace its terms use';
}

/**
 * The first stored address of `meta` that no RDF document can carry, with what holds it, or `null`: the base, the vocab, every explicit
 * `iri`, and the namespaces its terms are written under. Asked before any record is read, so a refusal names the setting or the type to
 * correct, never the first record whose address happened to be built from it (bundle-269 drive, finding 9: a base holding U+0001 was blamed
 * on "the entity '00000000-...'").
 */
function firstUnwritableAddress(meta: SpaceMeta, namespaces: readonly { prefix: string; iri: string }[]): RdfUnwritable | null {
  const addresses: string[] = [];
  if (meta.rdf?.base !== undefined) addresses.push(meta.rdf.base);
  if (meta.rdf?.vocab !== undefined) addresses.push(meta.rdf.vocab);
  for (const map of Object.values((meta.typeSchemas ?? {}) as Record<string, Record<string, { iri?: unknown; propertySchemas?: Record<string, { iri?: unknown }> }> | undefined>)) {
    for (const def of Object.values(map ?? {})) {
      if (typeof def?.iri === 'string') addresses.push(def.iri);
      for (const p of Object.values(def?.propertySchemas ?? {})) if (typeof p?.iri === 'string') addresses.push(p.iri);
    }
  }
  const bad = addresses.find(a => !isWritableIri(a));
  if (bad !== undefined) return new RdfUnwritable(holderOfAddress(meta, bad), bad);
  const ns = Object.values(prefixesFor(meta, namespaces)).find(a => !isWritableIri(a));
  return ns === undefined ? null : new RdfUnwritable('A library namespace the space\'s terms are written under', ns);
}

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
  // Two spaces of this instance with one base give one address two meanings (`<base>schema` would name two ontologies; bundle-269 drive,
  // finding 10). The other space is named only to a caller who may read its schema: a refusal reveals nothing the other doors would not.
  const sharing = otherHoldersOfRdfBase(cfg, spaceId, rdf.base, caller?.rights);
  if (sharing.holders.length > 0) {
    return {
      ok: false, status: EXPORT_CONFLICT, code: RDF_BASE_SHARED,
      error: `Space '${peerText(spaceId, { max: NAME_QUOTED })}' holds the RDF base ${peerText(rdf.base, { max: UNWRITABLE_SHOWN })}, which another space of this `
        + `instance holds too, so its addresses are not its own and nothing is exported. An administrator gives one of them another base `
        + `(PATCH /api/spaces/:id with rdf.rebase).${sharing.named.length > 0 ? ` Holding it too: ${sharing.named.map(id => `'${peerText(id, { max: NAME_QUOTED })}'`).join(', ')}.` : ''}`,
    };
  }
  const meta = inlineResolvableRefs(space.meta as SpaceMeta);
  const namespaces = Object.values(cfg.schemaLibraryNamespaces ?? {});
  // A schema stored before the clash rule grew (bundle-269 review, finding 6) can hold a pair the save doors now refuse: no migration, the
  // export answers the save's code naming the pair, so the shapes never contradict a record the server accepted.
  const clashes = termClashes(meta, namespaces);
  if (clashes.length > 0) {
    return {
      ok: false, status: EXPORT_CONFLICT, code: RDF_TERM_CLASH,
      error: `Space ${named} has a schema that gives two terms one RDF address, so its export would contradict its own shapes: `
        + `${clashes.map(c => c.message).join('; ')}. An administrator of its schema gives one of them another address`,
    };
  }
  const unwritable = firstUnwritableAddress(meta, namespaces);
  if (unwritable) return { ok: false, ...unwritableRefusal(unwritable) };
  return { ok: true, meta, fingerprint: fingerprintOf(space) };
}
