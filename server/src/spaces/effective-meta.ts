/**
 * A space's meta once networks send it schema: its OWN definitions, each network's LAYER, and the EFFECTIVE meta
 * everything reads (`F-39.2`).
 *
 * ## Why this exists
 *
 * F-39.1 merged an arriving meta straight into `space.meta`. With one network that is enough; with two it loses the
 * one thing the owner's rule needs — which definition came from where — so the instance could neither apply a
 * precedence nor send each network only its own (owner decision 2026-09-25, option A). So:
 *
 * - `net.schemaLayers[spaceId]` — each network's governed meta, as last received from it;
 * - `space.ownMeta` — this instance's own definitions, kept apart from the first time a layer arrives. Absent means
 *   `meta` is all its own, which is every space until then, so no migration;
 * - `space.meta` — the EFFECTIVE meta, own ⊕ layers in precedence, which every existing reader goes on reading.
 *
 * ## The one rule a caller must not skip
 *
 * Once `ownMeta` exists, an edit that writes `space.meta` directly is lost at the next recompute, which rebuilds
 * `meta` from `ownMeta` and the layers. So an edit goes through `commitOwnMetaEdit`, which edits `ownMeta` and
 * recomputes. A passed `meta_change` is such an edit.
 */
import { isDeepStrictEqual } from 'node:util';
import type { Config, SpaceConfig, SpaceMeta } from '../config/types.js';
import { getConfig, saveConfig } from '../config/loader.js';
import { effectiveMeta, replicatedMetaOf, type MetaLayer } from '../sync/replicated-meta.js';
import { PER_TYPE_META_FIELD } from './meta-fields.js';
import { derivedFromStored, type ParsedSpaceMeta, type ParsedTypeSchema } from './body-schemas.js';
import { updateSpace } from './spaces.js';

/** The layers that apply to `spaceId`, highest precedence first: the operator's order, then the order joined. */
export function layersFor(cfg: Config, spaceId: string): MetaLayer[] {
  const space = cfg.spaces.find(s => s.id === spaceId);
  const carrying = cfg.networks.filter(n => n.spaces.includes(spaceId) && n.schemaLayers?.[spaceId]);
  const rank = (id: string) => {
    const i = space?.networkPrecedence?.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  // Stable: networks the operator did not rank keep config order, which is the order they were created or joined.
  return carrying
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n.id) - rank(b.n.id) || a.i - b.i)
    .map(({ n }) => ({ networkId: n.id, meta: n.schemaLayers![spaceId] }));
}

/**
 * Rebuild `space.meta` from `ownMeta` and the layers; writes only when it changed. @returns whether it did.
 *
 * `persist` says the CALLER changed stored state (a layer, the own definitions) that must be saved even when the
 * effective meta comes out the same. Without it an unchanged recompute writes nothing — this runs for every space
 * on every sync cycle, and a full config rewrite per call is the write loop this repo has been bitten by before.
 */
export function recomputeEffectiveMeta(spaceId: string, persist = false): boolean {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return false;
  const layers = layersFor(cfg, spaceId);
  if (!layers.length && !space.ownMeta) return false;
  // The first layer is when the space's own definitions are set apart: until then `meta` is all its own.
  // Without the server's own counters: the version and history belong to `meta`, which `updateSpace` keeps.
  const setApart = !space.ownMeta;
  if (setApart) space.ownMeta = replicatedMetaOf(space.meta) as SpaceMeta;
  const next = effectiveMeta(space.ownMeta!, layers);
  if (isDeepStrictEqual(replicatedMetaOf(next), replicatedMetaOf(space.meta))) {
    if (setApart || persist) saveConfig(cfg);
    return false;
  }
  // A layer may have turned suppression on (bundle-30 `R5`): `updateSpace` sweeps what the new meta suppresses — every
  // way a network changes the meta ends here, and swept nothing, so the space reported its records suppressed and
  // went on ranking them by meaning.
  //
  // The effective meta is DERIVED: the own definitions laid under each layer, every one of which was parsed when it was stored
  // (`derivedFromStored`, the named trusted source). Nothing arrives here from outside.
  updateSpace(spaceId, { meta: derivedFromStored(next) });
  return true;
}

/**
 * Record what network `networkId` sends for `spaceId`, then recompute. @returns whether the effective meta changed.
 *
 * Takes a `ParsedSpaceMeta` only (`Q-216`): a layer that arrived without being parsed was stored here, and `effectiveMeta` then
 * dropped it when it no longer parsed — silently, so a member held a layer it did not run. `unread` names what this release left
 * out of the layer as the network sent it (R6-7), bounded; it is local state, kept so `space_schema_layers` can say a layer is
 * partly unread and why.
 */
export function storeNetworkLayer(networkId: string, spaceId: string, meta: ParsedSpaceMeta, unread: readonly string[] = []): boolean {
  const net = getConfig().networks.find(n => n.id === networkId);
  if (!net) return false;
  // What was left out of the layer is kept beside it, and only written when it changes.
  if (!isDeepStrictEqual(net.schemaLayerUnread?.[spaceId] ?? [], unread)) {
    const kept = { ...(net.schemaLayerUnread ?? {}) };
    if (unread.length > 0) kept[spaceId] = [...unread]; else delete kept[spaceId];
    net.schemaLayerUnread = Object.keys(kept).length > 0 ? kept : undefined;
    saveConfig(getConfig());
  }
  // The same layer again — every cycle, for a network whose schema did not change — is nothing to do and nothing to write.
  if (isDeepStrictEqual(net.schemaLayers?.[spaceId], meta)) return false;
  (net.schemaLayers ??= {})[spaceId] = meta;
  return recomputeEffectiveMeta(spaceId, true);
}

/**
 * Apply an edit of this instance's own definitions. Before any layer exists this is a plain write of `meta`; after,
 * it edits `ownMeta` and recomputes, so the edit survives the next layer arriving.
 *
 * The edit answers a `ParsedSpaceMeta` (`Q-216`): what it returns is what is stored, so it is either parsed by the call that made it
 * or made of what this store already holds (`withType`, `withoutType`).
 */
export function commitOwnMetaEdit(spaceId: string, edit: (base: SpaceMeta) => ParsedSpaceMeta): SpaceConfig | null {
  const space = getConfig().spaces.find(s => s.id === spaceId);
  if (!space) return null;
  if (!space.ownMeta) return updateSpace(spaceId, { meta: edit(space.meta ?? {}) });
  space.ownMeta = replicatedMetaOf(edit(space.ownMeta)) as SpaceMeta;
  recomputeEffectiveMeta(spaceId, true);
  return getConfig().spaces.find(s => s.id === spaceId) ?? null;
}

/**
 * `meta` with type `name` of kind `kind` set to `def` — the single-type upsert, as an own-definitions edit. `def` is parsed
 * (`parseTypeSchema`) and the rest is `meta` as it is stored, so the result is a parsed meta.
 */
export function withType(meta: SpaceMeta, kind: string, name: string, def: ParsedTypeSchema): ParsedSpaceMeta {
  const types = meta[PER_TYPE_META_FIELD as 'typeSchemas'] as Record<string, Record<string, unknown>> | undefined;
  return derivedFromStored({ ...meta, [PER_TYPE_META_FIELD]: { ...types, [kind]: { ...(types?.[kind] ?? {}), [name]: def } } } as SpaceMeta);
}

/** `meta` without type `name` of kind `kind`. A type a network layer defines returns at the next recompute. */
export function withoutType(meta: SpaceMeta, kind: string, name: string): ParsedSpaceMeta {
  const types = meta[PER_TYPE_META_FIELD as 'typeSchemas'] as Record<string, Record<string, unknown>> | undefined;
  const { [name]: _gone, ...kept } = types?.[kind] ?? {};
  return derivedFromStored({ ...meta, [PER_TYPE_META_FIELD]: { ...types, [kind]: kept } } as SpaceMeta);
}
