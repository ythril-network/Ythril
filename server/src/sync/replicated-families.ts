import type { BrainCollection, RecordType } from '../config/types-knowledge.js';
import { RECORD_TYPES, RECORD_COLLECTION } from '../config/types-knowledge.js';
import { LIVE_FILE_ROW } from '../files/live-file-row.js';

/**
 * The replicated record families, as one list.
 *
 * ## Why this is a module and not a constant in `sync/engine.ts`
 *
 * Which record types replicate is a fact about REPLICATION, not about the engine's loop — the merkle
 * hash, the ingest schemas and the retention sweep all have their own opinion of the same set, and each
 * of those has been wrong about it at least once. A shared home is where the next one can stop guessing.
 *
 * It also pays back what `A-12` owes. That row exists because `Q-2` raised the engine's god-file ceiling
 * (975 -> 979) and a raise queues its decomposition; folding the enumerations into a table INSIDE the
 * engine made the file bigger, not smaller, which would have been the refactor charging the raise a
 * second time.
 */
/**
 * THE SIX REPLICATED FAMILIES, in one place, iterated by both directions of a sync cycle.
 *
 * They were enumerated twice — six `pullType` calls and six `pushCollection` calls — so a seventh family
 * was six edits in two places. That is exactly how the SIXTH came to be missing from three separate
 * lists: `Q-2` found `filemeta` absent from pull's watermark max, from push's, and from the local seq
 * bump, and every omission was silent. Nothing breaks when a family reaches one list and not the other;
 * it compiles, it runs, and one direction ignores a whole record type.
 *
 * **`payloadKey` and `collection` differ for exactly one row, which is why there are two fields.** The
 * `filemeta` route serves METADATA while `/api/files` serves bytes, so the URL says `filemeta` and the
 * collection is `_files` — one word apart on purpose. Collapsing them would force a special case at the
 * call site, which is where the sixth family kept going missing.
 *
 * **`pushFilter` travels with the row for the same reason.** File metadata pushes PARENTS ONLY: a chunk
 * is derived from the blob and the receiver makes its own, with its own chunker and its own model —
 * sent, it would carry passage text and a vector another instance cannot rank. That is a property of the
 * family, not of the moment it happens to be pushed.
 *
 * **And it offers LIVE FILES only (`LIVE_FILE_ROW`).** With `softDeleteFileMeta` on, a deleted file leaves a row flagged
 * `deletedAt`: this instance's own audit record, never a peer's. The deletion reaches a peer as the file TOMBSTONE the delete
 * wrote; the flagged row, offered, would land LIVE there (the flag is not a wire key) and remove the tombstone the peer holds
 * (`Q-257`). The same filter governs `GET /filemeta` and `GET /filemeta/:id`, which share this family's filter.
 */
/**
 * One row's shape. Declared rather than inferred, because `as const` alone gives each row its OWN
 * literal type — and then `pushFilter` does not exist on the five rows that omit it, so the loop cannot
 * read it uniformly. `satisfies` does not help: it CHECKS the value without widening it, so the rows
 * keep their narrow types and the error stays. The annotation is what makes every row the same shape.
 */
export type ReplicatedFamily = {
  /**
   * The name this family goes by ON THE WIRE — the URL suffix and the payload key.
   *
   * **NOT ALL BRAIN COLLECTIONS, and not spelled the same either.** It is the collections plus one
   * rename: file metadata is the `files` collection and the `filemeta` route, because that route serves
   * METADATA while `/api/files` serves bytes. Deriving this from `BrainCollection` would put the rename
   * back at the call site, which is where the sixth family kept going missing.
   */
  readonly payloadKey: BrainCollection | 'filemeta';
  /** The collection this family is stored in — derived, so a seventh collection cannot be invented here. */
  readonly collection: BrainCollection;
  readonly pushFilter?: Record<string, unknown>;
};

/**
 * **The ORDER is a rule: every family a reference can point at comes before every family that holds references**
 * (bundle-30 I13). A sender pushes one family per `batch-upsert` request in this order, and the receiver checks strict
 * linkage after each request (`sync/linkage-check.ts`). The order was facts, entities, edges, chrono, links, filemeta,
 * so an edge to a chrono entry and a link to a file created in the same interval arrived ahead of their targets and
 * were recorded missing for good. Targets first, the receiver never sees a reference before a target the same cycle
 * carries — and neither does a receiver that predates this order, since it checks the same way.
 *
 * A SENDER that predates it still pushes the old order, and the receiver cannot tell: from such a sender an edge to a
 * chrono entry, or a link to a file, created in the same interval can still be recorded. `familiesAfter` is what the
 * push door tells the check is still to come, read from this list. Held by
 * `the-sync-order-puts-targets-before-references.test.js`, which derives both sets from the code.
 */
export const REPLICATED_FAMILIES: readonly ReplicatedFamily[] = [
  { payloadKey: 'facts', collection: 'facts' },
  { payloadKey: 'entities', collection: 'entities' },
  { payloadKey: 'chrono', collection: 'chrono' },
  { payloadKey: 'filemeta', collection: 'files', pushFilter: LIVE_FILE_ROW },
  { payloadKey: 'edges', collection: 'edges' },
  { payloadKey: 'links', collection: 'links' },
] as const;

/**
 * The collections a sender pushing in `REPLICATED_FAMILIES` order has still to send after a request carrying `keys`:
 * every family after the LAST one the request carries. What the push door passes the linkage check as `stillToCome`,
 * so a target in one of them is not judged missing before its request arrives.
 */
export function familiesAfter(keys: readonly PayloadKey[]): BrainCollection[] {
  const last = Math.max(-1, ...keys.map(k => REPLICATED_FAMILIES.indexOf(familyOf(k))));
  return REPLICATED_FAMILIES.slice(last + 1).map(f => f.collection);
}

/** A family's payload key. One declaration, on the row type, so the union cannot drift from the rows. */
export type PayloadKey = ReplicatedFamily['payloadKey'];

const FAMILY_BY_KEY: ReadonlyMap<string, ReplicatedFamily> = new Map(REPLICATED_FAMILIES.map(f => [f.payloadKey, f]));
/**
 * The family a payload key names — THROWS for a key that is not one, where the two hand lookups it replaced answered
 * `undefined` behind a `!` (bundle-30 I6, C9): a typo there failed later and elsewhere, as a read of `collection` on
 * nothing.
 */
export function familyOf(key: PayloadKey): ReplicatedFamily {
  const f = FAMILY_BY_KEY.get(key);
  if (!f) throw new Error(`'${String(key)}' is not a replicated family's payload key`);
  return f;
}

/**
 * The record type each replicated collection holds — what the embed queue, the type schema and the retention
 * bucket are keyed by — or `null` for a collection whose documents carry nothing to embed.
 *
 * `null` for `links` and it is not a gap: a link says one record concerns another and carries no text, so there
 * is nothing to embed, no type schema to check, and no retention bucket (a link lives as long as its endpoints).
 * TOTAL over the collections and DERIVED from `RECORD_COLLECTION`, so a new record type gets its row by being
 * declared there, and the arrival writer, the pull and the import read one table rather than three.
 */
export const RECORD_TYPE_OF: Readonly<Record<BrainCollection, RecordType | null>> = Object.freeze({
  ...Object.fromEntries(RECORD_TYPES.map(t => [RECORD_COLLECTION[t], t])),
  links: null,
} as Record<BrainCollection, RecordType | null>);
