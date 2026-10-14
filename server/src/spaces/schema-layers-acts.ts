/**
 * See a space's network schema layers and reorder them (`F-39.3`) — once, for both doors.
 *
 * F-39.2 keeps each network's schema as its own layer and applies them in precedence, the network joined first
 * winning a clash (owner decision 2026-09-25, option A). What an operator could not do was SEE that — which networks
 * define what, where they disagree, and which one is winning — or change the order. These acts answer both; the
 * route and the MCP tool only translate.
 *
 * Rights are the doors' (`ROUTE_RIGHTS` / `TOOL_RIGHTS`): reading layers is `schema: read`, reordering is
 * `schema: admin`, because the order decides which definition the space enforces.
 */
import { z } from 'zod';
import { getConfig, saveConfig } from '../config/loader.js';
import { clashesOf, ownAgainstEffective, replicatedMetaOf } from '../sync/replicated-meta.js';
import { carriedLocalId } from '../sync/space-map.js';
import { layersFor, recomputeEffectiveMeta } from './effective-meta.js';

/** An act's answer: the HTTP status is the contract, so both doors carry it. */
export type SchemaLayersActResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404; error: string };

export const NetworkPrecedenceBody = z.object({ networks: z.array(z.string().min(1)).max(100) });

const notFound = (id: string) => ({ status: 404 as const, error: `Space '${id}' not found` });

/**
 * The space's own definitions, each network layer in the order it applies, every clash between layers — the
 * network that currently wins each clash is the first one listed in its `values` — and, per place a layer supplies, the own
 * value against the effective one (`fields`, with `hidden` for an own edit a layer outranks).
 */
export function schemaLayersAct(spaceId: string): SchemaLayersActResult {
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return notFound(spaceId);
  const layers = layersFor(cfg, spaceId);
  const label = (id: string) => cfg.networks.find(n => n.id === id)?.label ?? id;
  return {
    status: 200,
    body: {
      spaceId,
      own: replicatedMetaOf(space.ownMeta ?? space.meta),
      layers: layers.map(l => {
        const net = cfg.networks.find(n => n.id === l.networkId);
        // What this release left out of the layer as the network sent it (R6-7): names only, bounded — a layer that is partly
        // unread says so here instead of being refused, and an operator can see why it differs from what the peer holds.
        const unknownFields = net?.schemaLayerUnread?.[spaceId];
        // Rounds of this network about this space that passed or are open and that THIS member could not read (R6-6): its yes was
        // never cast on them and none of them was applied, and the reason is the round's own `refusedHere`.
        const refusedRounds = (net?.pendingRounds ?? [])
          .filter(r => r.type === 'meta_change' && r.refusedHere !== undefined && carriedLocalId(net!, r.spaceId) === spaceId)
          .map(r => ({ roundId: r.roundId, reason: r.refusedHere! }));
        return {
          networkId: l.networkId, networkLabel: label(l.networkId), meta: l.meta,
          ...(unknownFields?.length ? { unknownFields } : {}),
          ...(refusedRounds.length ? { refusedRounds } : {}),
        };
      }),
      precedence: layers.map(l => l.networkId),
      clashes: clashesOf(layers),
      // Every place a layer supplies: the own value against what the space runs on, the layer that wins, and whether an own edit is
      // hidden by it (R6-8, Q-67). Read fresh from the own definitions and the layers — nothing is recorded, so a reorder, a layer
      // arriving, a rename or a network's removal change it with no round.
      fields: ownAgainstEffective(space.ownMeta ?? space.meta, layers),
    },
  };
}

/**
 * Set which network wins a clash, highest first, and rebuild the space's meta. Every id must be a network that
 * carries the space; networks left out keep the order they were joined in, after the ones named.
 */
export function setNetworkPrecedenceAct(spaceId: string, input: unknown): SchemaLayersActResult {
  const parsed = NetworkPrecedenceBody.safeParse(input);
  if (!parsed.success) return { status: 400, error: parsed.error.message };
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space) return notFound(spaceId);
  const carrying = new Set(cfg.networks.filter(n => n.spaces.includes(spaceId)).map(n => n.id));
  const stray = parsed.data.networks.filter(id => !carrying.has(id));
  if (stray.length) return { status: 400, error: `Not networks that carry '${spaceId}': ${stray.join(', ')}` };
  const order = [...new Set(parsed.data.networks)];
  space.networkPrecedence = order.length ? order : undefined;
  saveConfig(cfg);
  recomputeEffectiveMeta(spaceId);
  return schemaLayersAct(spaceId);
}
