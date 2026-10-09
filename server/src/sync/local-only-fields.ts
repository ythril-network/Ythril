/**
 * The name of the write guard an edge carries on this instance (`Q-439`): spelled ONCE, so no writer, projection or filter
 * can drift from the field the unique index is declared over by a typo that stores a second, unindexed field and guards
 * nothing. What it holds is `functionalSubjectKey(from, label)` (`brain/functional-subject.ts`), and it is classified in
 * {@link WRITE_GUARD_FIELDS}.
 */
export const FUNCTIONAL_GUARD = '_functionalGuard' as const;

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
  // The write guard (`Q-439`): `functionalSubjectKey(from, label)` on an edge a strict space inserted under a functional label,
  // the value the unique partial index refuses a second writer on. A peer's would name a subject under THIS instance's index.
  FUNCTIONAL_GUARD,
]);

/**
 * The third class of local-only field: a marker THIS instance's store collides on, which is a pure function of the record
 * that carries it (`_functionalGuard === functionalSubjectKey(from, label)`, `brain/functional-subject.ts`).
 *
 * Neither half of the older split fits it, so it is named:
 *  - **not restored.** An export or restore that carried it could bring a second marker for one subject, or one for an edge
 *    since relabelled, and a marker that no longer names its edge holds the subject's unique slot for ever and refuses every
 *    legitimate write under it. A restored edge arrives unmarked, which is harmless: an unmarked edge never collides and the
 *    planner's count still refuses.
 *  - **not derived.** `UNSET_DERIVED` clears every derived field when content changes, and an embed must never touch the guard.
 *
 * A writer that changes `from` or `label` — or replaces the whole document — must say what it does with it (drop, restamp,
 * carry only while both are unchanged): `every-edge-writer-says-what-it-does-with-the-functional-guard` holds each one to it.
 */
export const WRITE_GUARD_FIELDS: ReadonlySet<string> = new Set([FUNCTIONAL_GUARD]);

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
 * never taken from anywhere, a restore included. Derived, so a local-only field lands in the record tier or the write
 * guard by being named once, and one that is named in neither is derived data by default.
 */
export const DERIVED_LOCAL_FIELDS: ReadonlySet<string> =
  new Set([...LOCAL_ONLY_FIELDS].filter(f => !RESTORED_LOCAL_FIELDS.has(f) && !WRITE_GUARD_FIELDS.has(f)));

/**
 * Everything a backup never carries and a restore never takes: what this instance derives with its own model, and its write
 * guard. The record tier ({@link RESTORED_LOCAL_FIELDS}) is the rest of {@link LOCAL_ONLY_FIELDS}.
 *
 * ## What it prevents
 *
 * The export left these out and the arrival writer's `prepared()` dropped them, each by naming `DERIVED_LOCAL_FIELDS` and
 * `WRITE_GUARD_FIELDS` separately: a third class of local-only field would have been added to one of the two sites and not
 * the other, so a backup would carry a lock that a restore then dropped, or the reverse.
 */
export const NOT_CARRIED_BY_BACKUP: ReadonlySet<string> = new Set([...DERIVED_LOCAL_FIELDS, ...WRITE_GUARD_FIELDS]);

for (const f of RESTORED_LOCAL_FIELDS) {
  // A restored field that is not local-only would be a field the hash covers and the restore treats as local.
  if (!LOCAL_ONLY_FIELDS.has(f)) throw new Error(`RESTORED_LOCAL_FIELDS names '${f}', which is not a local-only field`);
}
for (const f of WRITE_GUARD_FIELDS) {
  if (!LOCAL_ONLY_FIELDS.has(f)) throw new Error(`WRITE_GUARD_FIELDS names '${f}', which is not a local-only field`);
  // Restored, a guard would come back from a backup; derived, an embed's content change would clear it.
  if (RESTORED_LOCAL_FIELDS.has(f)) throw new Error(`WRITE_GUARD_FIELDS names '${f}', which is also restored: a restore would bring a stale guard back`);
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
/** What an arrival this instance suppresses keeps of the stored copy: the record tier, and the write guard (suppression is not a change of subject). */
const KEPT_BY_SUPPRESSED: ReadonlySet<string> = new Set([...RESTORED_LOCAL_FIELDS, ...WRITE_GUARD_FIELDS]);

/**
 * What crosses a write from the STORED copy, per document (`Q-230`, `Q-234`): a restore takes nothing; an arrival this
 * instance suppresses, the record tier and the write guard; any other peer arrival, every local-only field. The write
 * guard crosses only while the record's `from` and `label` are the stored ones, which the arrival writer decides
 * (`replacementFor`): the set says what MAY cross, never that the stored marker still names its edge.
 *
 * Both of the arrival writer's write shapes read it — the replace (`sync/arrivals.ts`) and the file merge
 * (`sync/file-meta-write.ts`) — because the merge once decided for itself and kept a restored file's replaced vector
 * (bundle-30 I6, D2): one answer, so neither shape can carry what the other drops.
 */
export function carriedFields({ restore, suppressed }: { restore: boolean; suppressed: boolean }): ReadonlySet<string> {
  if (restore) return NOTHING;
  return suppressed ? KEPT_BY_SUPPRESSED : LOCAL_ONLY_FIELDS;
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
/**
 * `$unset` of the write guard — the edge's `(from, label)` changed and the marker would name the old subject. Beside
 * {@link UNSET_DERIVED}, because the guard is deliberately NOT derived (an embed must never clear it): a writer that moves an
 * edge asks for this one, never for the derived set.
 */
export const UNSET_GUARD: Readonly<Record<string, ''>> = Object.fromEntries([...WRITE_GUARD_FIELDS].map(f => [f, '']));
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
 * **It drops the write guard too (`Q-439`).** `_functionalGuard` is a function of `(from, label)`, and a re-key is the write that
 * changes them: the spread would carry the OLD marker onto the new identity, a phantom that holds the old subject's unique
 * slot for ever. The caller that moves an edge onto a functional label in a strict space stamps the new marker AFTER this
 * drop (`rekeyEdges`), never through `patch`, which the drop would also erase.
 *
 * `patch` wins over the old row, as the spread it replaces; the stamp and `syncBase` win over `patch`, and the write guard is
 * absent from the result whatever `patch` holds.
 */
export function rekeyedRow<T extends object, P extends object>(old: T, patch: P): Omit<T, keyof P | 'deliveredBy' | 'syncBase'> & P & { deliveredBy: '' } {
  const out = { ...old, ...patch, deliveredBy: '' } as Record<string, unknown>;
  delete out['syncBase'];
  for (const f of WRITE_GUARD_FIELDS) delete out[f];
  return out as Omit<T, keyof P | 'deliveredBy' | 'syncBase'> & P & { deliveredBy: '' };
}
