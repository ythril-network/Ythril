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
import { clashesOf, replicatedMetaOf } from '../sync/replicated-meta.js';
import { layersFor, recomputeEffectiveMeta } from './effective-meta.js';

/** An act's answer: the HTTP status is the contract, so both doors carry it. */
export type SchemaLayersActResult =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404; error: string };

export const NetworkPrecedenceBody = z.object({ networks: z.array(z.string().min(1)).max(100) });

const notFound = (id: string) => ({ status: 404 as const, error: `Space '${id}' not found` });

/**
 * The space's own definitions, each network layer in the order it applies, and every clash between layers — the
 * network that currently wins each clash is the first one listed in its `values`.
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
      layers: layers.map(l => ({ networkId: l.networkId, networkLabel: label(l.networkId), meta: l.meta })),
      precedence: layers.map(l => l.networkId),
      clashes: clashesOf(layers),
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
