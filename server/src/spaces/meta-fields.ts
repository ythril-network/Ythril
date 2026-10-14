/**
 * What each key of a space's meta IS when two metas are merged — one table, read by every merge (`Q-217`; R5-5, R6-5; D-i3).
 *
 * ## What it prevents
 *
 * Three functions merge a meta into a meta, and each kept its own list of what it knew. `mergeSpaceMeta` (a PATCH and `schema_update`)
 * copied six named fields and the type schemas, so `meta.whenDuePasses` — accepted by the body, priced in the rights table, declared
 * on the MCP tool — was parsed and then NOT STORED: a 200 for a write that did not happen; `stampSkew` fell out of the same list.
 * `mergeReplicatedMeta` (a network's layer arriving) replaced every top-level key it was handed, and `applyMetaRound` (a passed
 * `meta_change` round) replaced every field the round named. They agreed on what they listed and were free to disagree about the
 * rest, which is the defect this repository produces most: one rule, three implementations, the weaker one wins silently.
 *
 * So the answer is written once, as a KIND per key, and every walker of the shape reads it: `mergeSpaceMeta`,
 * `mergeReplicatedMeta`, `applyMetaRound`, the effective-meta type edits and the layer clash scan.
 *
 * | kind | keys | what a merge does |
 * |---|---|---|
 * | `scalar` | purpose, usageNotes, validationMode, strictLinkage, suppressEmbeddings, whenDuePasses | the incoming value replaces; a `false` is a value |
 * | `object-replaced-whole` | stampSkew | the incoming object replaces; a property the old one had and the new one lacks is gone |
 * | `per-type` | typeSchemas | a type not named is untouched; a type named is merged by the rule of the DOOR (the caller says how) |
 * | `replaced-whole` | rules | the incoming map replaces; a rule absent from it is deleted (R6-5: send the map without it) |
 *
 * ## What is inside, so no caller can drop it
 *
 * - **{@link mergeMetaFields} reads the table** and skips a key it has no kind for, so a merge cannot invent a replace for a key
 *   nobody decided about. It is the only loop over a meta's keys that merges.
 * - **{@link metaFieldKind} answers `undefined` for a key without a kind, and the body asserts it never does**:
 *   `spaces/body-schemas.ts` refuses to load when `SpaceMetaBody` accepts a key this table lacks, so a field added to the body is
 *   decided here on the commit that adds it, never silently treated as a scalar by a merge written before it existed.
 * - **The per-type field is named once** ({@link PER_TYPE_META_FIELD}), so the walkers that go INSIDE the types (a single-type edit,
 *   the clash scan) do not each spell it.
 *
 * What differs between doors is only how a TYPE is merged: a PATCH replaces a type by name (or the whole map under `replace`), a
 * passed round replaces per type name, a network layer is additive (its fields win, the property maps are unioned — the owner's
 * ruling). That difference is the `mergeTypes` argument, and it is the only one.
 */

import { NAME_QUOTED, peerText } from '../util/log.js';

/** How a merge treats one key of a meta. */
export type MetaFieldKind = 'scalar' | 'object-replaced-whole' | 'per-type' | 'replaced-whole';

/**
 * The kind of every settable key of a meta. A key absent from here is not merged by anything: the housekeeping the server owns
 * (`version`, `updatedAt`, `previousVersions`, the reindex marks) is deliberately not a row.
 */
export const META_FIELD_KINDS: Readonly<Record<string, MetaFieldKind>> = Object.freeze({
  purpose: 'scalar',
  usageNotes: 'scalar',
  validationMode: 'scalar',
  strictLinkage: 'scalar',
  suppressEmbeddings: 'scalar',
  whenDuePasses: 'scalar',
  stampSkew: 'object-replaced-whole',
  typeSchemas: 'per-type',
  rules: 'replaced-whole',
});

/** The kind of `key`, or `undefined` when no merge may carry it. Own keys only: a prototype-named key is never a field. */
export function metaFieldKind(key: string): MetaFieldKind | undefined {
  return Object.hasOwn(META_FIELD_KINDS, key) ? META_FIELD_KINDS[key] : undefined;
}

/** The one key whose kind is `per-type`: the map of knowledge type to its per-type definitions. */
export const PER_TYPE_META_FIELD: string = Object.entries(META_FIELD_KINDS).find(([, kind]) => kind === 'per-type')![0];

type Obj = Record<string, unknown>;

/**
 * `incoming`'s fields laid over `base` by the kind of each, as a new object. An `undefined` value is "not stated" and changes
 * nothing; a key with no kind is not carried. `mergeTypes` merges the per-type field: `(what base holds, what arrives)`.
 */
export function mergeMetaFields(base: Obj, incoming: Obj, mergeTypes: (existing: unknown, incoming: unknown) => unknown): Obj {
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const kind = metaFieldKind(key);
    if (kind === undefined) continue;
    out[key] = kind === 'per-type' ? mergeTypes(out[key], value) : value;
  }
  return out;
}

/** The keys of `keys` that no merge carries — the names a tolerant reader reports instead of storing. */
export function unknownMetaFields(keys: Iterable<string>): string[] {
  return [...keys].filter(k => metaFieldKind(k) === undefined);
}

/** How many unknown names a tolerant reader keeps; the rest are counted. What a peer chose is never echoed whole or without end. */
export const MAX_UNKNOWN_NAMES = 50;

/**
 * `names` as a reader reports them: at most {@link MAX_UNKNOWN_NAMES}, each one bounded in length and made safe for a line
 * (`peerText`), then `…(+N more)`. `total` is how many there were when the caller stopped collecting at the bound.
 */
export function boundedNames(names: readonly string[], total: number = names.length): string[] {
  const shown = names.slice(0, MAX_UNKNOWN_NAMES).map(n => peerText(n, { max: NAME_QUOTED }));
  const more = total - shown.length;
  return more > 0 ? [...shown, `…(+${more} more)`] : shown;
}
