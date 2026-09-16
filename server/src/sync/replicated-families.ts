import type { BrainCollection } from '../config/types-knowledge.js';

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

export const REPLICATED_FAMILIES: readonly ReplicatedFamily[] = [
  { payloadKey: 'facts', collection: 'facts' },
  { payloadKey: 'entities', collection: 'entities' },
  { payloadKey: 'edges', collection: 'edges' },
  { payloadKey: 'chrono', collection: 'chrono' },
  { payloadKey: 'links', collection: 'links' },
  { payloadKey: 'filemeta', collection: 'files', pushFilter: { parentFileId: { $exists: false } } },
] as const;

/** A family's payload key. One declaration, on the row type, so the union cannot drift from the rows. */
export type PayloadKey = ReplicatedFamily['payloadKey'];
