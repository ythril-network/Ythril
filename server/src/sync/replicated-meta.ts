/**
 * The part of a space's meta that travels with its data, and how an arriving copy is merged into the local one
 * (`F-39.1`).
 *
 * ## Why this exists
 *
 * Only records travelled. A space created by a join arrived with no type schemas, no purpose and no usage notes,
 * so an agent reading it had no directive and a validator had nothing to validate against — the `flows` move needed
 * its meta copied by hand. Now an instance below the one that governs a pub/sub or braintree network takes the
 * meta from its upstream every cycle (`networks/network-spaces.ts` decides who that is).
 *
 * ## What travels: everything the network governs, derived rather than listed
 *
 * The meta is exactly what a `meta_change` round governs, and the operational settings a network never votes on —
 * duplicate rules, record TTL, document extraction — live on the SPACE, not in `meta`, so none of them is in reach
 * here. What is stripped is what the server owns (`SERVER_OWNED_META_FIELDS`: version, history, reindex flags): the
 * receiver keeps its own counters. A list of "the five fields that travel" would be a second copy of that split,
 * and the next field added to `SpaceMeta` would silently stay home.
 *
 * ## The merge is ADDITIVE, and that is the owner's rule rather than a default
 *
 * Owner, 2026-09-25: *"make sure schema is also additive (of course if an exact entity + property match that is
 * overwritten but even same entity should only add properties)"*, *"same for other knowledgetypes"*. So:
 *
 * - a type the receiver lacks is added;
 * - a type both hold keeps every local property (`propertySchemas`) and gains the network's new ones, and a property both hold takes the
 *   network's definition;
 * - a type's own fields (an edge's `endpoints`, a `namingPattern`) are the network's value where it sets one and the
 *   local value otherwise;
 * - a top-level field (`purpose`, `validationMode`, …) is the network's value where it sets one.
 *
 * Nothing local is ever removed. Mapping a network into a space that already has a schema can therefore never
 * delete a local type or property — which is the question an operator asks before joining.
 */
import { isDeepStrictEqual } from 'node:util';
import type { SpaceMeta } from '../config/types.js';
import { SpaceMetaBody, stripServerOwnedMeta } from '../spaces/body-schemas.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** The meta a sender hands a peer for one space: all of it but what the server owns. */
export function replicatedMetaOf(meta: SpaceMeta | undefined): Obj {
  const stripped = stripServerOwnedMeta(meta ?? {});
  return isObj(stripped) ? stripped : {};
}

/**
 * Merge one type definition: the network's fields over the local ones, and the two property maps unioned. A type
 * that is a schema-library reference (`$ref`) on either side is one unit — a reference cannot carry properties, so
 * the network's definition replaces the local one whole.
 */
function mergeType(local: unknown, incoming: Obj): Obj {
  if (!isObj(local) || '$ref' in local || '$ref' in incoming) return incoming;
  const merged: Obj = { ...local, ...incoming };
  const lp = local['propertySchemas'], ip = incoming['propertySchemas'];
  if (isObj(lp) || isObj(ip)) merged['propertySchemas'] = { ...(isObj(lp) ? lp : {}), ...(isObj(ip) ? ip : {}) };
  return merged;
}

/**
 * Merge an arriving meta into the local one, additively. `incoming` is untrusted: it is validated as a meta body
 * the local API would accept, and refused whole — `{ changed: false, invalid }` — if it is not, so one malformed
 * field cannot land half a schema.
 */
export function mergeReplicatedMeta(
  local: SpaceMeta | undefined,
  incoming: unknown,
): { meta: SpaceMeta; changed: boolean; invalid?: string } {
  const base: Obj = { ...(local ?? {}) };
  const parsed = SpaceMetaBody.safeParse(stripServerOwnedMeta(incoming));
  if (!parsed.success) return { meta: base as SpaceMeta, changed: false, invalid: parsed.error.message };
  const net = parsed.data as Obj;

  const next: Obj = { ...base };
  for (const [key, value] of Object.entries(net)) {
    if (key === 'typeSchemas' || value === undefined) continue;
    next[key] = value;
  }
  if (isObj(net['typeSchemas'])) {
    const localSchemas: Obj = isObj(base['typeSchemas']) ? base['typeSchemas'] : {};
    const schemas: Obj = { ...localSchemas };
    for (const [kind, types] of Object.entries(net['typeSchemas'])) {
      if (!isObj(types)) continue;
      const localTypes: Obj = isObj(localSchemas[kind]) ? localSchemas[kind] as Obj : {};
      const mergedTypes: Obj = { ...localTypes };
      for (const [name, def] of Object.entries(types)) {
        if (isObj(def)) mergedTypes[name] = mergeType(localTypes[name], def);
      }
      schemas[kind] = mergedTypes;
    }
    next['typeSchemas'] = schemas;
  }
  const comparable = (m: Obj) => replicatedMetaOf(m as SpaceMeta);
  return { meta: next as SpaceMeta, changed: !isDeepStrictEqual(comparable(next), comparable(base)) };
}

// ── F-39.2: a space in more than one network ────────────────────────────────────────────────────────────

/** One network's governed meta for a space, as last received from it. */
export interface MetaLayer { networkId: string; meta: unknown }

/**
 * The meta a space runs on: its own definitions, then each network's layer merged additively, the LOWEST precedence
 * first so the network first in `layers` wins an exact type-and-property clash. Owner decision 2026-09-25, option A:
 * default precedence is the order the networks were joined, and the operator may reorder it.
 */
export function effectiveMeta(own: SpaceMeta | undefined, layers: readonly MetaLayer[]): SpaceMeta {
  let meta: SpaceMeta = { ...(own ?? {}) };
  for (const layer of [...layers].reverse()) meta = mergeReplicatedMeta(meta, layer.meta).meta;
  return meta;
}

/**
 * What this instance sends network `layer.networkId`: its own definitions plus that network's own layer — never
 * another network's layer, never the effective result. "Nothing mixed is sent on" (owner, 2026-09-25): otherwise
 * one network's definition would leak into the other, where nobody voted for it.
 */
export function metaForNetwork(own: SpaceMeta | undefined, layer: MetaLayer | undefined): SpaceMeta {
  return layer ? mergeReplicatedMeta({ ...(own ?? {}) }, layer.meta).meta : { ...(own ?? {}) };
}

export interface MetaClash {
  /** A top-level meta field (`purpose`, `validationMode`, …) — or absent for a type-schema clash. */
  field?: string;
  kind?: string;
  type?: string;
  /** A property of the type — or absent when the clash is one of the type's own fields (see `typeField`). */
  property?: string;
  typeField?: string;
  values: { networkId: string; value: unknown }[];
}

/**
 * Every place two layers define the same thing differently, with each network's value. Shown to the operator and
 * never resolved by arrival order: precedence decides what applies, and a clash is what the operator may settle by
 * proposing a combined definition to a network as an ordinary `meta_change`.
 */
export function clashesOf(layers: readonly MetaLayer[]): MetaClash[] {
  const out: MetaClash[] = [];
  const add = (key: Omit<MetaClash, 'values'>, networkId: string, value: unknown) => {
    const hit = out.find(c => c.field === key.field && c.kind === key.kind && c.type === key.type
      && c.property === key.property && c.typeField === key.typeField);
    if (hit) hit.values.push({ networkId, value });
    else out.push({ ...key, values: [{ networkId, value }] });
  };
  for (const { networkId, meta } of layers) {
    const m = replicatedMetaOf((isObj(meta) ? meta : {}) as SpaceMeta);
    for (const [field, value] of Object.entries(m)) {
      if (field === 'typeSchemas') continue;
      add({ field }, networkId, value);
    }
    const schemas = isObj(m['typeSchemas']) ? m['typeSchemas'] : {};
    for (const [kind, types] of Object.entries(schemas)) {
      if (!isObj(types)) continue;
      for (const [type, def] of Object.entries(types)) {
        if (!isObj(def)) continue;
        for (const [typeField, value] of Object.entries(def)) {
          if (typeField === 'propertySchemas' && isObj(value)) {
            for (const [property, p] of Object.entries(value)) add({ kind, type, property }, networkId, p);
          } else add({ kind, type, typeField }, networkId, value);
        }
      }
    }
  }
  // A clash is two or more networks holding DIFFERENT values; one network, or agreement, is not one.
  return out.filter(c => c.values.length > 1 && c.values.some(v => !isDeepStrictEqual(v.value, c.values[0]!.value)));
}
