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
  updateSpace(spaceId, { meta: next });
  return true;
}

/** Record what network `networkId` sends for `spaceId`, then recompute. @returns whether the effective meta changed. */
export function storeNetworkLayer(networkId: string, spaceId: string, meta: SpaceMeta): boolean {
  const net = getConfig().networks.find(n => n.id === networkId);
  if (!net) return false;
  // The same layer again — every cycle, for a network whose schema did not change — is nothing to do and nothing to write.
  if (isDeepStrictEqual(net.schemaLayers?.[spaceId], meta)) return false;
  (net.schemaLayers ??= {})[spaceId] = meta;
  return recomputeEffectiveMeta(spaceId, true);
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
  recomputeEffectiveMeta(spaceId, true);
  return getConfig().spaces.find(s => s.id === spaceId) ?? null;
}

/** `meta` with type `name` of kind `kind` set to `def` — the single-type upsert, as an own-definitions edit. */
export function withType(meta: SpaceMeta, kind: string, name: string, def: unknown): SpaceMeta {
  const types = meta.typeSchemas as Record<string, Record<string, unknown>> | undefined;
  return { ...meta, typeSchemas: { ...types, [kind]: { ...(types?.[kind] ?? {}), [name]: def } } as SpaceMeta['typeSchemas'] };
}

/** `meta` without type `name` of kind `kind`. A type a network layer defines returns at the next recompute. */
export function withoutType(meta: SpaceMeta, kind: string, name: string): SpaceMeta {
  const types = meta.typeSchemas as Record<string, Record<string, unknown>> | undefined;
  const { [name]: _gone, ...kept } = types?.[kind] ?? {};
  return { ...meta, typeSchemas: { ...types, [kind]: kept } as SpaceMeta['typeSchemas'] };
}
