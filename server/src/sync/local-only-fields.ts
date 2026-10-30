/**
 * The name of the write guard an edge carries on this instance (`Q-439`): spelled ONCE, so no writer, projection or filter
 * can drift from the field the unique index is declared over by a typo that stores a second, unindexed field and guards
 * nothing. What it holds is `functionalSubjectKey(from, label)` (`brain/functional-subject.ts`), and it is classified in
 * {@link WRITE_GUARD_FIELDS}.
 */
export const FUNCTIONAL_GUARD = '_functionalGuard' as const;

/**
 * The name of the bit that says THIS instance wrote a record (`sync/written-here.ts`'s predicate stamps it): spelled once, as the guard is,
 * so no writer, projection or filter can drift from the field the push selection reads. A local write sets it in its landing patch
 * (`withLandingStamp`); it is restored with a backup's raw load and stamped fresh on every other landing.
 */
export const WRITTEN_HERE = 'writtenHere' as const;

/**
 * The name of the mark a FORK row carries when a peer's tombstone for it was declined here (Q-624, design rev 4 §9a): another instance
 * resolved its own copy of this unchosen version, this instance's deletion authority did not accept that removal, so the decision is owed
 * HERE, by this instance's user, in Review. Spelled once, as the guard is, so the decline writer, the list's projection, the rollback and
 * the hash exclusion cannot drift apart. Classified in {@link DECISION_OWED_FIELDS}.
 */
export const RESOLVED_ELSEWHERE = '_resolvedElsewhere' as const;

/**
 * The fields a record holds that belong to THIS INSTANCE and must never be taken from a peer.
 *
 * ## Why they are one list with two consumers
 *
 * The y-flows convention `convention-ythril-a-new-field-is-replicated-or-local-and-says-so` states the equivalence: **a field that is hashed must replicate.** Turn it round and the same
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
 * ## The classes, each named by the constant that lists it
 *
 * Read the classes from this module's exports, never from a count written elsewhere: {@link LOCAL_ONLY_FIELDS} is the whole set;
 * {@link RESTORED_LOCAL_FIELDS} is the record tier a restore keeps from its own backup (`writtenHere` among it); {@link WRITE_GUARD_FIELDS}
 * is the edge's functional guard; {@link POSITION_FIELDS} is the landing position (`pos`, `posAtSeq`); {@link TOMBSTONE_LOCAL_FIELDS} is
 * what a stored tombstone keeps for itself (`storedVia`, `issuedHere` and the position); {@link DECISION_OWED_FIELDS} is the decision a
 * fork row still owes here; and `ORDER_ONLY_FIELDS` (`brain/recall-shape.ts`) is `pos` as a field a read may order by and no answer returns.
 * What is in none of the restored, write-guard or position lists is {@link DERIVED_LOCAL_FIELDS}.
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
  // The position (`pos`) this instance took the record at when it landed, and the version that position was taken for (`posAtSeq`):
  // where the record sits in THIS instance's stream, which no peer can know (`POSITION_FIELDS`, bundle-81).
  'pos', 'posAtSeq',
  // Whether this instance wrote the record, or only holds a peer's copy of it: the bit mesh push selection reads (`sync/written-here.ts`).
  // A peer's would claim the receiver's own authorship, which a deliverer's text cannot prove.
  WRITTEN_HERE,
  // A decision owed here (Q-624, design rev 4 §9a): who resolved this fork elsewhere, behind a tombstone this instance declined. It is a fact
  // about THIS instance's copy and what its user still has to decide; a peer's copy of it would decide for this instance.
  RESOLVED_ELSEWHERE,
]);

/**
 * The write-guard class of local-only field: a marker THIS instance's store collides on, which is a pure function of the record
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
export const RESTORED_LOCAL_FIELDS: ReadonlySet<string> = new Set(['_expireAt', '_contentExpireAt', 'syncBase', 'deliveredBy', WRITTEN_HERE, RESOLVED_ELSEWHERE]);

/**
 * The decision-owed class of local-only field: A DECISION OWED HERE (Q-624, design rev 4 §9a). `_resolvedElsewhere` on a fork row says that another
 * instance resolved its own copy of this unchosen version behind a tombstone this instance's deletion authority declined, so the fork stays
 * here, listed in Review as resolved elsewhere, until THIS instance's user decides it (owner, 2026-10-25: my instance, my data).
 *
 * Against the other classes:
 *  - **never hashed and never replicated**, as every local-only field: two instances that differ only in their marks agree, and a peer
 *    cannot plant a mark by push (the arrival writer drops a peer's copy);
 *  - **carried across an ordinary arrival** (`carriedFields`), so a re-delivered fork keeps a decision this instance still owes;
 *  - **restored** ({@link RESTORED_LOCAL_FIELDS}), so an export and its import keep the decision owed;
 *  - **not derived**: an embed never clears it.
 * It lives and dies with the fork row: every path that removes the fork removes the mark with it, which is why it is a field and not a list.
 */
export const DECISION_OWED_FIELDS: ReadonlySet<string> = new Set([RESOLVED_ELSEWHERE]);

/**
 * The landing-position class of local-only field: where a record sits in THIS instance's stream (bundle-81, design rev 8 §2). `pos` is the position
 * the record landed at (`util/position-clock.ts`) and `posAtSeq` the version it was taken for, so a row whose `posAtSeq` is not its `seq`
 * changed without a position (a 5.6 build `$set` it and kept `pos`) and is found and repaired at re-upgrade.
 *
 * Its own class, because neither older half fits:
 *  - **not derived.** `UNSET_DERIVED` clears every derived field when content changes, and a position is not about content: unset, the
 *    record would drop out of every pager and every list order until it was written again.
 *  - **not taken from anywhere.** A peer's would sit below this instance's own marks and the record would never be offered on; a backup's
 *    export or an admin import's would too. The writer stamps fresh ones (`withLandingStamp`): {@link NOT_CARRIED_BY_BACKUP} says so,
 *    and `carriedFields` never carries them across a replace (the landing's patch is the new value).
 *  - **kept by the restore act's raw load**, which puts a database back as it was (a 6.0 backup keeps its positions).
 * It is excluded from every answer (`LOCAL_ONLY_EXCLUSION`), so 6.0 never serves a position; the order-only class
 * (`ORDER_ONLY_FIELDS`, `brain/recall-shape.ts`) is how a read may ORDER by `pos` without ever returning it.
 */
export const POSITION_FIELDS: ReadonlySet<string> = new Set(['pos', 'posAtSeq']);

/**
 * The local-only fields of a stored BRAIN TOMBSTONE, which `listTombstones` and every serving read leave off the wire: how it reached this
 * instance (`storedVia`, the upstream it is relayed for), whether this instance issued it (`issuedHere`, a mark the local tombstone writer
 * stamps and nothing a peer says can set: `TombstoneShape` strips an arriving one), and where it sits in this instance's stream
 * (`pos`, `posAtSeq`). Tombstones are not hashed (`brain/merkle.ts`), so no hash list changes with it.
 */
export const TOMBSTONE_LOCAL_FIELDS: ReadonlySet<string> = new Set(['storedVia', 'issuedHere', ...POSITION_FIELDS]);

/**
 * What a landing stamps afresh on every row that lands, whatever the door: the position class and the written-here bit. Never taken from
 * what arrived and never carried from the copy a landing replaces, a restore and an import included — the landing's patch
 * (`withLandingStamp`) is the only source. NOT a `*_FIELDS` class of its own (`the-docs-name-every-local-only-field` derives those from
 * what the module exports): every member is already named by a class that is.
 */
const LANDING_STAMPED: ReadonlySet<string> = new Set([...POSITION_FIELDS, WRITTEN_HERE]);

/** Is `field` stamped afresh by every landing (see {@link LANDING_STAMPED})? */
export const isLandingStamped = (field: string): boolean => LANDING_STAMPED.has(field);

/**
 * The rest — what THIS instance computes with its own model (`embedding`, `embeddingModel`, `matchedText`), so
 * never taken from anywhere, a restore included. Derived, so a local-only field lands in the record tier, the write
 * guard or the position class by being named once, and one that is named in none is derived data by default.
 */
export const DERIVED_LOCAL_FIELDS: ReadonlySet<string> =
  new Set([...LOCAL_ONLY_FIELDS].filter(f => !RESTORED_LOCAL_FIELDS.has(f) && !WRITE_GUARD_FIELDS.has(f) && !POSITION_FIELDS.has(f)));

/**
 * Everything a backup never carries and a restore never takes: what this instance derives with its own model, its write
 * guard, and its positions (the writer stamps fresh ones). The record tier ({@link RESTORED_LOCAL_FIELDS}) is the rest of
 * {@link LOCAL_ONLY_FIELDS}.
 *
 * ## What it prevents
 *
 * The export left these out and the arrival writer's `prepared()` dropped them, each by naming `DERIVED_LOCAL_FIELDS` and
 * `WRITE_GUARD_FIELDS` separately: a third class of local-only field would have been added to one of the two sites and not
 * the other, so a backup would carry a lock that a restore then dropped, or the reverse.
 */
export const NOT_CARRIED_BY_BACKUP: ReadonlySet<string> = new Set([...DERIVED_LOCAL_FIELDS, ...WRITE_GUARD_FIELDS, ...POSITION_FIELDS]);

for (const f of RESTORED_LOCAL_FIELDS) {
  // A restored field that is not local-only would be a field the hash covers and the restore treats as local.
  if (!LOCAL_ONLY_FIELDS.has(f)) throw new Error(`RESTORED_LOCAL_FIELDS names '${f}', which is not a local-only field`);
}
for (const f of POSITION_FIELDS) {
  if (!LOCAL_ONLY_FIELDS.has(f)) throw new Error(`POSITION_FIELDS names '${f}', which is not a local-only field`);
  // Restored from a backup's export, a position would sit below peers' marks; derived, a content change would clear it.
  if (RESTORED_LOCAL_FIELDS.has(f) || WRITE_GUARD_FIELDS.has(f)) throw new Error(`POSITION_FIELDS names '${f}', which another class also claims`);
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

for (const f of DECISION_OWED_FIELDS) {
  // Not restored, a decision owed before an export would be gone after its import; derived, an embed would clear it.
  if (!RESTORED_LOCAL_FIELDS.has(f)) throw new Error(`DECISION_OWED_FIELDS names '${f}', which a restore does not keep`);
}

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
 * What an ordinary peer arrival keeps of the stored copy: every local-only field except what the landing stamps afresh (the position class
 * and the written-here bit, which describe THIS landing and not the copy it replaces).
 */
const KEPT_BY_ARRIVAL: ReadonlySet<string> = new Set([...LOCAL_ONLY_FIELDS].filter(f => !LANDING_STAMPED.has(f)));
/** What an arrival this instance suppresses keeps of the stored copy: the record tier, and the write guard (suppression is not a change of subject). */
const KEPT_BY_SUPPRESSED: ReadonlySet<string> = new Set([...RESTORED_LOCAL_FIELDS, ...WRITE_GUARD_FIELDS].filter(f => !LANDING_STAMPED.has(f)));

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
  return suppressed ? KEPT_BY_SUPPRESSED : KEPT_BY_ARRIVAL;
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
 * **It drops the position class and `writtenHere` too (bundle-81).** A carried `pos` sits below the marks peers hold for this instance's
 * stream, so the re-keyed row would never be pushed; a carried `writtenHere` describes the old row. The caller's landing
 * (`withLandingStamp`) puts fresh ones on, and EVERY copier of a record to a new id goes through here
 * (`a-record-copied-to-a-new-id-goes-through-rekeyed-row`): the forgettable part is inside, so a copier that spreads the row by
 * hand is the one that keeps a stale position.
 *
 * `patch` wins over the old row, as the spread it replaces; the stamp and `syncBase` win over `patch`, and the write guard is
 * absent from the result whatever `patch` holds.
 *
 * **The one row that is the SAME record at its key** (`{ sameRecord: true }`, the re-key of a legacy file row, Q-413) keeps `deliveredBy` and
 * `syncBase`: nothing about the file's identity changed, only the spelling of its id, so who delivered it and the hash each peer agreed on still
 * hold. Everything else here (the guard, the position class, `writtenHere`) goes for it as for every copy. A parameter and not a second helper,
 * so the drop of the stale position stays in one place.
 */
export function rekeyedRow<T extends object, P extends object>(old: T, patch: P): Omit<T, keyof P | 'deliveredBy' | 'syncBase'> & P & { deliveredBy: '' };
export function rekeyedRow<T extends object, P extends object>(old: T, patch: P, opts: { sameRecord: true }): Omit<T, keyof P> & P;
export function rekeyedRow<T extends object, P extends object>(old: T, patch: P, opts: { sameRecord?: boolean } = {}): object {
  const out = { ...old, ...patch } as Record<string, unknown>;
  // `sameRecord`: the row is not a NEW record but the same file's row put at its key (the re-key of a legacy file row, Q-413), so what this instance
  // knows of it stays: who delivered it and the per-peer hash it agreed on. A copy to another identity drops both, as above (bundle-88 review F7).
  if (opts.sameRecord !== true) { out['deliveredBy'] = ''; delete out['syncBase']; }
  for (const f of WRITE_GUARD_FIELDS) delete out[f];
  // The old row's position sits where the OLD record landed, below peers' marks, so a re-keyed row that kept it would never be
  // offered on; and the old row's provenance (`writtenHere`) says nothing of this write. The caller's `withLandingStamp` patch puts
  // fresh ones on. A field `patch` names is the caller's own and stays, whatever class it is in.
  for (const f of LANDING_STAMPED) if (!(f in patch)) delete out[f];
  return out;
}
