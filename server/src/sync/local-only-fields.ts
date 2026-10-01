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
 * `merkle.ts` excludes them from the hash. The arrival writer (`sync/arrivals.ts`, `writeArrivals`) drops
 * them from every document a peer delivers, by push or by pull — push zod-strips them as well, because no
 * `Incoming*` schema declares one, but the writer does not rely on it — and CARRIES the receiver's own values
 * across the replace, so a peer's edit does not erase what only this instance knows. The admin export leaves
 * out the derived half and a restore keeps the record-tier half (`RESTORED_LOCAL_FIELDS` below).
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
 * The local-only fields that are the RECORD's own state on this instance rather than something this instance
 * derived from it — what an admin RESTORE keeps from an export it is handed (`Q-205`).
 *
 * The retention stamps ARE the record tier of retention: a per-record `ttlDays` is never stored, only the stamp
 * it produced, so dropping them would hand a "never expire" record the space default and the sweep would delete
 * it network-wide. `syncBase` is what this instance last agreed with each peer about a file; dropping it on a
 * self-restore turns every divergent file into a conflict copy. A PEER's copy of either is still refused: these
 * are kept only from a restore, which is this instance's own backup, never from a sync arrival.
 */
export const RESTORED_LOCAL_FIELDS: ReadonlySet<string> = new Set(['_expireAt', '_contentExpireAt', 'syncBase']);

/**
 * The rest — what THIS instance computes with its own model (`embedding`, `embeddingModel`, `matchedText`), so
 * never taken from anywhere, a restore included. Derived, so a seventh local-only field lands in one of the two
 * halves by being named once, and one that is named in neither is derived data by default.
 */
export const DERIVED_LOCAL_FIELDS: ReadonlySet<string> =
  new Set([...LOCAL_ONLY_FIELDS].filter(f => !RESTORED_LOCAL_FIELDS.has(f)));

for (const f of RESTORED_LOCAL_FIELDS) {
  // A restored field that is not local-only would be a field the hash covers and the restore treats as local.
  if (!LOCAL_ONLY_FIELDS.has(f)) throw new Error(`RESTORED_LOCAL_FIELDS names '${f}', which is not a local-only field`);
}

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
