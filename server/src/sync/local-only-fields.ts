/**
 * The fields a record holds that belong to THIS INSTANCE and must never be taken from a peer.
 *
 * ## Why they are one list with two consumers
 *
 * `CLAUDE.md` states the equivalence: **a field that is hashed must replicate.** Turn it round and the same
 * sentence defines this list — a field that must not replicate must not be hashed, or every cycle logs a
 * `MERKLE_DIVERGENCE` for a space where nothing is wrong. So the set the space hash excludes and the set
 * ingest drops are the same set, and writing them separately means one of them is eventually wrong.
 *
 * `merkle.ts` excludes them from the hash. `sync/engine.ts` drops them from a PULLED document. The push
 * path drops them by omission — no `Incoming*` schema declares one, so zod strips them — which is why this
 * module has no third consumer.
 *
 * ## What each one is, and what taking a peer's copy would do
 *
 * - **`embedding` / `embeddingModel`** — computed by this instance's model. Ranking one model's vectors
 *   against another's does not fail; it returns plausible results in the wrong order, which is the kind of
 *   wrong nobody reports. The owner's ruling, 2026-09-01: *"dont transfer embeddings... on transfer the
 *   receiver applies its rules."*
 * - **`matchedText`** — the snippet a query matched. An artefact of a search, not content at all.
 * - **`_expireAt` / `_contentExpireAt`** — computed from this instance's retention policy, and
 *   `brain/ttl-sweep.ts` deletes every record whose `_expireAt` has passed, across every space, through
 *   the normal delete path. **A stamp taken from a peer lets one instance decide when another deletes its
 *   data** — an operator who configured a year of retention loses records after the sender's seven days,
 *   with nothing logged and nothing to distinguish it from their own policy working.
 *
 * A lapsed window's RESULT is not local and does replicate: `contentRedacted` and `contentRedactedAt` say
 * the record had a description and no longer has one, which is what the record IS.
 */
export const LOCAL_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'embedding', 'embeddingModel', 'matchedText',
  '_expireAt', '_contentExpireAt',
  // Per peer, the file hash this instance and that peer last both held (`sync/file-sync.ts`, Q-66): what THIS
  // instance agreed with whom, so it is served to no peer and hashed nowhere.
  'syncBase',
]);

/**
 * The same set as a Mongo projection, for the SENDING side.
 *
 * Not the guarantee — the receiver's strip is, because a peer decides what it sends and this instance
 * decides what it stores. This is the saving: a vector is several hundred floats per record and was the
 * bulk of every page.
 */
export const LOCAL_ONLY_EXCLUSION: Readonly<Record<string, 0>> =
  Object.fromEntries([...LOCAL_ONLY_FIELDS].map(f => [f, 0])) as Record<string, 0>;

/**
 * A copy of `doc` without the local-only fields.
 *
 * Returns the SAME object when there is nothing to drop, so the ordinary path allocates nothing — a sync
 * page is 200 documents and this runs on every one of them.
 */
export function stripLocalOnly<T extends object>(doc: T): T {
  let hit = false;
  for (const f of LOCAL_ONLY_FIELDS) {
    if (f in doc) { hit = true; break; }
  }
  if (!hit) return doc;
  const out = { ...doc } as Record<string, unknown>;
  for (const f of LOCAL_ONLY_FIELDS) delete out[f];
  return out as T;
}
