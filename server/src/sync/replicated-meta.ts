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
import { readPeerMeta, readStoredMeta, stripServerOwnedMeta } from '../spaces/body-schemas.js';
import { eachTypeDefinition, mergeMetaFields, mergeTypeDefinition, PER_TYPE_META_FIELD } from '../spaces/meta-fields.js';
import { isPlainObject, ownValue } from '../util/plain-object.js';

type Obj = Record<string, unknown>;

/** The meta a sender hands a peer for one space: all of it but what the server owns. */
export function replicatedMetaOf(meta: SpaceMeta | undefined): Obj {
  const stripped = stripServerOwnedMeta(meta ?? {});
  return isPlainObject(stripped) ? stripped : {};
}

/**
 * A network's types laid additively over the local ones: a type the receiver lacks is added, one both hold is merged by
 * `mergeTypeDefinition` (`spaces/meta-fields.ts`) — the network's fields over the local ones, the property maps unioned, a `$ref` whole.
 */
function mergeTypesAdditively(local: unknown, incoming: unknown): unknown {
  if (!isPlainObject(incoming)) return local;
  const localSchemas: Obj = isPlainObject(local) ? local : {};
  const schemas: Obj = { ...localSchemas };
  for (const [kind, types] of Object.entries(incoming)) {
    if (!isPlainObject(types)) continue;
    const localTypes: Obj = isPlainObject(localSchemas[kind]) ? localSchemas[kind] as Obj : {};
    const mergedTypes: Obj = { ...localTypes };
    for (const [name, def] of Object.entries(types)) {
      if (isPlainObject(def)) mergedTypes[name] = mergeTypeDefinition(localTypes[name], def);
    }
    schemas[kind] = mergedTypes;
  }
  return schemas;
}

/**
 * Merge an arriving meta into the local one, additively, by the kind of each key (`spaces/meta-fields.ts`). `incoming` is untrusted
 * and is read as a TOLERANT reader (R6-7): every key and type field this release knows is validated as the meta body the local API
 * would accept and kept; one it has never heard of is dropped and named in `unknownFields` (bounded) instead of refusing the layer
 * — a newer peer's one new key used to cost this member the whole schema. A field that is KNOWN and WRONG is a different thing:
 * the meta is refused whole — `{ changed: false, invalid }` — so one malformed field cannot land half a schema.
 */
export function mergeReplicatedMeta(
  local: SpaceMeta | undefined,
  incoming: unknown,
): { meta: SpaceMeta; changed: boolean; invalid?: string; unknownFields?: string[] } {
  const base: Obj = { ...(local ?? {}) };
  const read = readPeerMeta(incoming);
  if (!read.ok) return { meta: base as SpaceMeta, changed: false, invalid: read.message };

  const next = mergeMetaFields(base, { ...read.meta } as Obj, mergeTypesAdditively);
  const comparable = (m: Obj) => replicatedMetaOf(m as SpaceMeta);
  return {
    meta: next as SpaceMeta,
    changed: !isDeepStrictEqual(comparable(next), comparable(base)),
    ...(read.unknown.length > 0 ? { unknownFields: read.unknown } : {}),
  };
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
  for (const layer of [...layers].reverse()) meta = layOverStored(meta, layer.meta);
  return meta;
}

/**
 * A layer a store ALREADY HOLDS laid additively over `base` — the one merge of a stored layer, for the effective meta and for what
 * this instance sends a network. It reads what is valid TODAY (`readStoredMeta`) and leaves out what is not: a layer was parsed when it
 * was stored, so this is no gate, and parsing it whole and dropping it for one stale type (the pattern rule is newer than the layer)
 * is how a member held a layer it did not run (`Q-216`). What ARRIVES goes through `mergeReplicatedMeta`, which parses.
 */
function layOverStored(base: SpaceMeta, stored: unknown): SpaceMeta {
  return mergeMetaFields({ ...base }, readStoredMeta(stored).meta, mergeTypesAdditively) as SpaceMeta;
}

/**
 * What this instance sends network `layer.networkId`: its own definitions plus that network's own layer — never
 * another network's layer, never the effective result. "Nothing mixed is sent on" (owner, 2026-09-25): otherwise
 * one network's definition would leak into the other, where nobody voted for it.
 */
export function metaForNetwork(own: SpaceMeta | undefined, layer: MetaLayer | undefined): SpaceMeta {
  return layer ? layOverStored({ ...(own ?? {}) }, layer.meta) : { ...(own ?? {}) };
}

/**
 * One place a definition lives in a meta: a top-level field, a property of a type, or one of a type's own fields. The same address
 * for a clash between layers and for a field's own value against the one the space runs on, so the two views name a thing alike.
 */
export interface MetaPlace {
  /** A top-level meta field (`purpose`, `validationMode`, …) — or absent for a type-schema place. */
  field?: string;
  kind?: string;
  type?: string;
  /** A property of the type — or absent when the place is one of the type's own fields (see `typeField`). */
  property?: string;
  typeField?: string;
}

export interface MetaClash extends MetaPlace {
  values: { networkId: string; value: unknown }[];
}

/**
 * Every place a meta holds a definition, with the value it holds there: each top-level field, and inside the types each property and
 * each of a type's own fields. THE walk of the shape for the two views that compare metas place by place — the clashes between layers
 * and a field's own value against the one the space runs on — so the two cannot read the shape differently. A place whose value is
 * `undefined` is not a place. Own keys only: a name a peer chose is never read off a prototype.
 */
function placesOf(meta: unknown): Array<{ place: MetaPlace; value: unknown }> {
  const out: Array<{ place: MetaPlace; value: unknown }> = [];
  const m = replicatedMetaOf((isPlainObject(meta) ? meta : {}) as SpaceMeta);
  for (const [field, value] of Object.entries(m)) {
    if (field === PER_TYPE_META_FIELD || value === undefined) continue;
    out.push({ place: { field }, value });
  }
  for (const { kind, type, def } of eachTypeDefinition(m)) {
    for (const [typeField, value] of Object.entries(def)) {
      if (typeField === 'propertySchemas' && isPlainObject(value)) {
        for (const [property, p] of Object.entries(value)) out.push({ place: { kind, type, property }, value: p });
      } else out.push({ place: { kind, type, typeField }, value });
    }
  }
  return out;
}

/** What `meta` holds at `place`, or `undefined`. The read half of {@link placesOf}: own keys only, whatever the place's names are. */
function valueAt(meta: unknown, place: MetaPlace): unknown {
  const own = ownValue;
  const m = replicatedMetaOf((isPlainObject(meta) ? meta : {}) as SpaceMeta);
  if (place.field !== undefined) return own(m, place.field);
  const def = own(own(own(m, PER_TYPE_META_FIELD), place.kind), place.type);
  return place.property !== undefined ? own(own(def, 'propertySchemas'), place.property) : own(def, place.typeField);
}

const placeKey = (p: MetaPlace): string => JSON.stringify([p.field, p.kind, p.type, p.property, p.typeField]);

/**
 * Every place two layers define the same thing differently, with each network's value. Shown to the operator and
 * never resolved by arrival order: precedence decides what applies, and a clash is what the operator may settle by
 * proposing a combined definition to a network as an ordinary `meta_change`.
 */
export function clashesOf(layers: readonly MetaLayer[]): MetaClash[] {
  const out = new Map<string, MetaClash>();
  for (const { networkId, meta } of layers) {
    for (const { place, value } of placesOf(meta)) {
      const hit = out.get(placeKey(place));
      if (hit) hit.values.push({ networkId, value });
      else out.set(placeKey(place), { ...place, values: [{ networkId, value }] });
    }
  }
  // A clash is two or more networks holding DIFFERENT values; one network, or agreement, is not one.
  return [...out.values()].filter(c => c.values.length > 1 && c.values.some(v => !isDeepStrictEqual(v.value, c.values[0]!.value)));
}

/** One place a layer supplies, as the own definitions and the space's effective meta see it (R6-8). */
export interface MetaPlaceView extends MetaPlace {
  /** What this instance's own definitions hold there; absent when they hold nothing. */
  own?: unknown;
  /** What the space runs on there. */
  effective: unknown;
  /** The network whose layer the effective value comes from: the first of `layers` that supplies the place. */
  winner: string;
  /** The own definitions hold a value the space does not run on — an edit a layer outranks (`Q-67`). */
  hidden: boolean;
}

/**
 * For every place some layer supplies: what the own definitions hold, what the space runs on, which network's layer wins, and whether
 * the own value is HIDDEN by it (R6-8, `Q-67`).
 *
 * ## Derived, and that is the point
 *
 * Computed from the own definitions, the layers and their order at the moment of the read — `effectiveMeta`, the one merge the space's
 * meta is built by — and recorded nowhere. A hidden edit used to be invisible (the write answered saved, the space ran on a network's
 * value); a RECORD of it ("this edit was hidden by round X") would go stale with a precedence reorder, a layer arriving, a rename or a
 * network's removal, each of which changes the answer. Reading it fresh cannot.
 *
 * A place no layer supplies is the own definitions' and is not listed: nothing outranks it. `layers` are highest precedence first.
 */
export function ownAgainstEffective(own: SpaceMeta | undefined, layers: readonly MetaLayer[]): MetaPlaceView[] {
  const effective = effectiveMeta(own, layers);
  const rows = new Map<string, MetaPlaceView>();
  for (const { networkId, meta } of layers) {
    for (const { place } of placesOf(meta)) {
      const key = placeKey(place);
      if (rows.has(key)) continue;
      const mine = valueAt(own, place);
      const runsOn = valueAt(effective, place);
      rows.set(key, {
        ...place,
        ...(mine !== undefined ? { own: mine } : {}),
        effective: runsOn,
        winner: networkId,
        hidden: mine !== undefined && !isDeepStrictEqual(mine, runsOn),
      });
    }
  }
  return [...rows.values()];
}
