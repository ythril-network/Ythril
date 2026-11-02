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
  /**
   * The key this family is COUNTED under, in a cycle's history (`pulled` / `pushed`) and as the `type` label of the item metrics (bundle-39, Q-265).
   * File metadata counts as `filemeta`: `files` is the count of FILES the file routes moved, a different thing, and one label with two meanings made
   * a cycle that moved only file metadata count nothing.
   */
  readonly countKey: Exclude<CountKey, 'files'>;
  readonly pushFilter?: Record<string, unknown>;
};

/**
 * **The ORDER is a rule: every family a reference can point at comes before every family that holds references**
 * (bundle-30 I13). A sender pushes one family per `batch-upsert` request in this order, and the receiver checks strict
 * linkage after each request (`sync/linkage-check.ts`).
 * <!-- replicated-family-order: history -->
 * The order was facts, entities, edges, chrono, links, filemeta,
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
  { payloadKey: 'facts', collection: 'facts', countKey: 'facts' },
  { payloadKey: 'entities', collection: 'entities', countKey: 'entities' },
  { payloadKey: 'chrono', collection: 'chrono', countKey: 'chrono' },
  { payloadKey: 'filemeta', collection: 'files', countKey: 'filemeta', pushFilter: LIVE_FILE_ROW },
  { payloadKey: 'edges', collection: 'edges', countKey: 'edges' },
  { payloadKey: 'links', collection: 'links', countKey: 'links' },
] as const;

/**
 * What a cycle counts: each family under its `countKey`, and `files`, the FILES the file routes moved (`sync/file-sync.ts`; a count, not bytes).
 * Spelled here because the rows' own type names it; `every-replicated-family-is-counted-db` holds that the counts a cycle writes are exactly the
 * rows' keys plus `files`.
 */
export const COUNT_KEYS = ['facts', 'entities', 'chrono', 'filemeta', 'edges', 'links', 'files'] as const;
export type CountKey = typeof COUNT_KEYS[number];

/** A cycle's counts, one per key: the `pulled` / `pushed` of a history row. */
export type SyncCounts = Record<CountKey, number>;

/** Every count at 0: where a member's or a cycle's tally starts. */
export function zeroCounts(): SyncCounts {
  return Object.fromEntries(COUNT_KEYS.map(k => [k, 0])) as SyncCounts;
}

/** One direction's family counts, each under its `countKey`, read off the per-family results by `pick`: a family that did not run counts 0. */
export function countsOf<T>(perFamily: Partial<Record<PayloadKey, T>>, pick: (r: T) => number): SyncCounts {
  const out = zeroCounts();
  for (const f of REPLICATED_FAMILIES) { const r = perFamily[f.payloadKey]; if (r !== undefined) out[f.countKey] = pick(r); }
  return out;
}

/** Add `more` into `into`, every key of the list: a hand-written sum of five keys never summed links (Q-59). */
export function addCounts(into: SyncCounts, more: Partial<SyncCounts>): void {
  for (const k of COUNT_KEYS) into[k] += more[k] ?? 0;
}

/**
 * The collections a sender pushing in `REPLICATED_FAMILIES` order has still to send after a request carrying `keys`:
 * every family after the LAST one the request carries. What the push door passes the linkage check as `stillToCome`,
 * so a target in one of them is not judged missing before its request arrives.
 */
export function familiesAfter(keys: readonly PayloadKey[], incomplete: readonly TargetKey[] = []): BrainCollection[] {
  const last = Math.max(-1, ...keys.map(k => REPLICATED_FAMILIES.indexOf(familyOf(k))));
  const after = REPLICATED_FAMILIES.slice(last + 1).map(f => f.collection);
  // The target families the sender says stopped early earlier in its cycle (bundle-39 D4, Q-334): still to come, whatever the order says. Mapped to
  // their collections, which is what the check is told (`filemeta` is the `files` collection, v6 S3).
  for (const k of incomplete) { const c = familyOf(k).collection; if (!after.includes(c)) after.push(c); }
  return after;
}

/**
 * The families whose records hold references: the ones the linkage check collects (`sync/linkage-check.ts`, which re-exports this). Every family a
 * reference can point at travels before these (`REPLICATED_FAMILIES`), which the order gate derives from this list and `REF_KINDS`. Declared here, beside
 * the rows, so `TARGET_KEYS` derives from the two without this module importing the check (which pulls in the database).
 */
export const REFERENCE_FAMILIES = ['edges', 'links'] as const satisfies readonly PayloadKey[];

/**
 * The families a reference can point at, by payload key: every replicated family but the two that hold references (`REFERENCE_FAMILIES`), in list order.
 * Nothing points at an edge or a link, so naming one would hide nothing a receiver judges. Derived, so a seventh family is a target unless it is declared
 * a holder.
 */
export type TargetKey = Exclude<PayloadKey, typeof REFERENCE_FAMILIES[number]>;
export const TARGET_KEYS: readonly TargetKey[] = REPLICATED_FAMILIES
  .map(f => f.payloadKey)
  .filter((k): k is TargetKey => !(REFERENCE_FAMILIES as readonly string[]).includes(k));

/**
 * The target families whose transfer stopped early (truncated, any kind) among `transfers`, in list order: a reference that travels after them must
 * not be judged against them this cycle (bundle-39 D4). The pull's own check reads it; the push sends it as `incomplete` on every later request.
 */
export function familiesNotComplete(transfers: Partial<Record<PayloadKey, { truncated: boolean } | undefined>>): TargetKey[] {
  return TARGET_KEYS.filter(k => transfers[k]?.truncated === true);
}

/**
 * A pushing peer's `incomplete`, read defensively (bundle-39 v4 S1, v6 S4): the target payload keys it names, deduped; anything else (a string, an
 * unknown key, a non-string, an object) is dropped and never reaches `familyOf`, which throws. `ignored` says something was dropped, for the one warn.
 * An untrusted peer can only leave its own request's targets unjudged, which it could already do by splitting requests (`familiesAfter`).
 */
export function parseIncompleteFamilies(raw: unknown): { keys: TargetKey[]; ignored: boolean } {
  if (raw === undefined) return { keys: [], ignored: false };
  if (!Array.isArray(raw)) return { keys: [], ignored: true };
  const keys = TARGET_KEYS.filter(k => raw.includes(k));
  return { keys, ignored: raw.length > TARGET_KEYS.length || raw.some(v => typeof v !== 'string' || !(TARGET_KEYS as readonly string[]).includes(v)) };
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
