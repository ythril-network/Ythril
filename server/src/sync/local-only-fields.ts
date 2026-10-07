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
 * them from every document a peer delivers, by push or by pull — the one validation step zod-strips them as
 * well, because no `Incoming*` schema declares one, but the writer does not rely on it — and CARRIES the
 * receiver's own values across the replace, so a peer's edit does not erase what only this instance knows.
 * What it carries is decided per document (`carriedFields`): an arrival this instance SUPPRESSES carries the
 * record-tier half only, because the derived half describes content it no longer embeds (`Q-230`), and a
 * RESTORE carries nothing from the copy it replaces. The admin export leaves out the derived half and a restore
 * keeps the backup's record-tier half (`RESTORED_LOCAL_FIELDS` below) — never the replaced copy's (`Q-234`).
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
 * - **`deliveredBy`** — which peer delivered this version HERE. A peer's copy would say who delivered the record to
 *   the peer, which is a different fact, and a deletion authority resting on it would be the peer's to write.
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
  // Which peer DELIVERED this version here (bundle-51, D-14): the fact the upstream deletion ground stands on
  // (`sync/deletion-authority.ts`). It names a peer of THIS instance's network, so no other instance is told it, and
  // a peer's own stamp would say who delivered the record THERE, which is nothing about who delivered it here.
  'deliveredBy',
]);

/**
 * The local-only fields that are the RECORD's own state on this instance rather than something this instance
 * derived from it — what an admin RESTORE keeps from an export it is handed (`Q-205`).
 *
 * The retention stamps ARE the record tier of retention: a per-record `ttlDays` is never stored, only the stamp
 * it produced, so dropping them would hand a "never expire" record the space default and the sweep would delete
 * it network-wide. `syncBase` is what this instance last agreed with each peer about a file; dropping it on a
 * self-restore turns every divergent file into a conflict copy. `deliveredBy` is who delivered the record here: a
 * restore that dropped it would leave every relayed record without the stamp its upstream's deletion needs, and the
 * back-fill that stamped the pre-release rows has already run and will not run again. A PEER's copy of any of them
 * is still refused: these are kept only from a restore, which is this instance's own backup, never from a sync arrival.
 *
 * The default is not allowed to classify a field: `every-local-only-field-is-classified-on-purpose` holds that each
 * local-only name is here or is named derived, with a reason, in the gate.
 */
export const RESTORED_LOCAL_FIELDS: ReadonlySet<string> = new Set(['_expireAt', '_contentExpireAt', 'syncBase', 'deliveredBy']);

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
 * The restored fields that are DATES, which JSON wrote as text and a restore must turn back (the two retention stamps).
 * Stored as text a stamp never compares with a Date and the sweep never fires; the other restored fields are not dates
 * (`deliveredBy` is a peer's id, `syncBase` an object), and reading a peer's id as one deletes it.
 */
export const RESTORED_DATE_FIELDS: ReadonlySet<string> = new Set(['_expireAt', '_contentExpireAt']);

for (const f of RESTORED_DATE_FIELDS) {
  if (!RESTORED_LOCAL_FIELDS.has(f)) throw new Error(`RESTORED_DATE_FIELDS names '${f}', which a restore does not keep`);
}

/**
 * The VECTOR half of the derived fields: the vector and the model that made it, without `matchedText`.
 *
 * Two removals ask two different questions, and each had been spelled by hand at every site (four `$unset`s, one of
 * which — the suppression sweep's — named `embedding` alone and left the model behind):
 *  - **the content changed or is gone** (a textless record, an arrival this instance suppresses): every derived field
 *    goes, `matchedText` too, because it is the lexical channel's copy of text the record no longer has (`Q-94`);
 *  - **only the decision to embed changed** (suppression turned on, an embed that failed): the vector goes and
 *    `matchedText` stays or is rewritten — the content did not change, and removing it is a content decision.
 */
const VECTOR_FIELDS: ReadonlySet<string> = new Set(['embedding', 'embeddingModel']);
for (const f of VECTOR_FIELDS) {
  if (!DERIVED_LOCAL_FIELDS.has(f)) throw new Error(`VECTOR_FIELDS names '${f}', which is not a derived local field`);
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * What crosses a write from the STORED copy, per document (`Q-230`, `Q-234`): a restore takes nothing; an arrival this
 * instance suppresses, the record tier only; any other peer arrival, every local-only field.
 *
 * Both of the arrival writer's write shapes read it — the replace (`sync/arrivals.ts`) and the file merge
 * (`sync/file-meta-write.ts`) — because the merge once decided for itself and kept a restored file's replaced vector
 * (bundle-30 I6, D2): one answer, so neither shape can carry what the other drops.
 */
export function carriedFields({ restore, suppressed }: { restore: boolean; suppressed: boolean }): ReadonlySet<string> {
  if (restore) return NOTHING;
  return suppressed ? RESTORED_LOCAL_FIELDS : LOCAL_ONLY_FIELDS;
}

/**
 * The `deliveredBy` stamp an arriving version is written with: a restore keeps the backup's own (`''` for a backup that
 * has none — what it replaced is never what it keeps), anything else is the peer the door proved delivered it (`''` for
 * nobody: an admin or local push). Never absent.
 *
 * ## What it prevents
 *
 * The stamp is the ground the upstream's deletion stands on (`sync/deletion-authority.ts`), so a row stored WITHOUT one
 * is a row nobody can say who delivered. Both write shapes of the arrival writer (the replace in `sync/arrivals.ts`, the file
 * merge in `sync/file-meta-write.ts`) spelled the restore-or-delivery choice themselves, and a copy that wrote `undefined`
 * where this writes `''` leaves the key out of the document. One answer, so neither shape can drop it.
 */
export function stampOfArrival(
  { restore, doc, deliveredBy }: { restore: boolean; doc: Readonly<Record<string, unknown>>; deliveredBy?: string | undefined },
): string {
  if (restore) return typeof doc['deliveredBy'] === 'string' ? doc['deliveredBy'] : '';
  return deliveredBy ?? '';
}

/** `$unset` of every derived field — the content changed or is gone. */
export const UNSET_DERIVED: Readonly<Record<string, ''>> = Object.fromEntries([...DERIVED_LOCAL_FIELDS].map(f => [f, '']));
/** `$unset` of the vector half — only the decision to embed changed. */
export const UNSET_VECTOR: Readonly<Record<string, ''>> = Object.fromEntries([...VECTOR_FIELDS].map(f => [f, '']));

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

/**
 * A row that is written out again under a NEW id — an edge or link whose endpoints moved, a file that was renamed —
 * is a new record written HERE, whatever the old one was: so it is stamped as nobody's delivery (`deliveredBy: ''`),
 * and it carries nothing that described the old identity (`syncBase`, this instance's per-peer agreement about the
 * old path).
 *
 * ## What it prevents
 *
 * A re-key spreads `{ ...old, _id: newId }`, and the stamp rode along: a record this instance made out of a relayed one
 * then looked relayed itself, and its upstream could delete it. The stamp is the one field a hand-written copy would
 * forget, because nothing but this rule ever reads it, so it is put inside the helper where no caller can leave it
 * out. The vector and the retention stamps are NOT dropped: they describe the content and this instance's policy,
 * which a re-key does not change (`edge-rekey.ts` keeps the vector on purpose).
 *
 * `patch` wins over the old row, as the spread it replaces; the stamp and `syncBase` win over `patch`.
 */
export function rekeyedRow<T extends object, P extends object>(old: T, patch: P): Omit<T, keyof P | 'deliveredBy' | 'syncBase'> & P & { deliveredBy: '' } {
  const out = { ...old, ...patch, deliveredBy: '' } as Record<string, unknown>;
  delete out['syncBase'];
  return out as Omit<T, keyof P | 'deliveredBy' | 'syncBase'> & P & { deliveredBy: '' };
}
