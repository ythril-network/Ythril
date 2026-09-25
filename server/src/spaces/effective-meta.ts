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

/** Rebuild `space.meta` from `ownMeta` and the layers; writes only when it changed. @returns whether it did. */
export function recomputeEffectiveMeta(spaceId: string): boolean {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return false;
  const layers = layersFor(cfg, spaceId);
  if (!layers.length && !space.ownMeta) return false;
  // The first layer is when the space's own definitions are set apart: until then `meta` is all its own.
  // Without the server's own counters: the version and history belong to `meta`, which `updateSpace` keeps.
  if (!space.ownMeta) space.ownMeta = replicatedMetaOf(space.meta) as SpaceMeta;
  const next = effectiveMeta(space.ownMeta, layers);
  if (isDeepStrictEqual(replicatedMetaOf(next), replicatedMetaOf(space.meta))) { saveConfig(cfg); return false; }
  updateSpace(spaceId, { meta: next });
  return true;
}

/** Record what network `networkId` sends for `spaceId`, then recompute. @returns whether the effective meta changed. */
export function storeNetworkLayer(networkId: string, spaceId: string, meta: SpaceMeta): boolean {
  const net = getConfig().networks.find(n => n.id === networkId);
  if (!net) return false;
  (net.schemaLayers ??= {})[spaceId] = meta;
  return recomputeEffectiveMeta(spaceId);
}

/**
 * Apply an edit of this instance's own definitions. Before any layer exists this is a plain write of `meta`; after,
 * it edits `ownMeta` and recomputes, so the edit survives the next layer arriving.
 */
export function commitOwnMetaEdit(spaceId: string, edit: (base: SpaceMeta) => SpaceMeta): SpaceConfig | null {
  const space = getConfig().spaces.find(s => s.id === spaceId);
  if (!space) return null;
  if (!space.ownMeta) return updateSpace(spaceId, { meta: edit(space.meta ?? {}) });
  space.ownMeta = replicatedMetaOf(edit(space.ownMeta)) as SpaceMeta;
  recomputeEffectiveMeta(spaceId);
  return getConfig().spaces.find(s => s.id === spaceId) ?? null;
}
