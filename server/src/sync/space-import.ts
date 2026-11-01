/**
 * The admin import: restore what an export wrote, say what was wrong with it, and queue it for embedding.
 *
 * The importer core, not a door: the import door (`api/admin-space-transfer.ts`) and the import act (`spaces/import-act.ts`) both call it, so it
 * lives beside the arrival writer and not under `api/` (bundle-40 A2; `no-module-outside-the-api-imports-from-it.test.js`).
 *
 * ## What it did before, and why none of it was a decision
 *
 * The handler lived inline in `app.ts` and did `replaceOne(…, { upsert: true })` on arbitrary documents. Zero
 * validation, zero schema references, and no embed job — so every imported record was stored and invisible to
 * meaning-ranked search until somebody thought to run a reindex they were never told they needed.
 *
 * The validation half READ as a decision, and was filed as one. The tension is real: an import is how you
 * restore a backup, and a backup taken before a schema change would be refused by its own instance, so
 * refusing the import makes backups unrestorable. Sync meets the identical problem on the identical kind of
 * payload and resolves it by RECORDING rather than refusing — the document is stored and what it carries is
 * reported back — through one module, `sync/arrival-recording.ts`, which the page accept and this restore both
 * ask. So the question was withdrawn rather than answered.
 *
 * ## Why the write goes through `writeArrivals` (`Q-205`)
 *
 * The arrival writer (`sync/arrivals.ts`) is the one thing that stores a record produced elsewhere, and it owns
 * every precondition a door used to hold a subset of. Import used it through `ingestBrainDoc` and still stored
 * whatever it was handed: a string seq (invisible to every seq-paged pull), a seq inside the protocol's ceiling
 * reserve (a stranded counter), retention stamps as the TEXT JSON made of them (a sweep never compares them), the
 * export's vectors (another model's), file chunks as files, and a repeated id in file order. Through the writer:
 *
 *  - **A seq is a non-negative integer the counter can carry**, or the record is refused, NAMED with the reason
 *    (`refused`). Absent is allowed for file metadata only, which predates seqs.
 *  - **It is a RESTORE, not a peer arrival** (`restore: true`): what is stored is replaced whatever its seq — an
 *    operator restoring a backup over newer data asked for exactly that — and the export's record-tier local
 *    fields are KEPT, as Dates: the retention stamps ARE the record tier (a per-record `ttlDays` is never
 *    stored), and `syncBase` keeps a self-restore from turning every divergent file into a conflict copy.
 *  - **What this instance derives is dropped**: the vector, its model and `matchedText` (re-embedded here),
 *    every file chunk and face record (re-derived from the blob), and every file-metadata key that is not on
 *    the wire — a size and a hash describe bytes this instance has not got. An edge's write guard (`_functionalGuard`,
 *    `Q-439`) is dropped too: it is a lock on a subject in THIS instance's index, never a backup's to bring, so a restored
 *    edge arrives unmarked.
 *  - **A soft-deleted file stays flagged** (`Q-257`): the export holds this instance's own audit rows, and a row with
 *    `deletedAt` is restored with it (`flagsKept` counts them) — never as a live row with no bytes, which every peer
 *    would be offered. A flag is not a wire key, so only a restore brings one.
 *  - **A restore removes what its backup lacks, and says how much** (`Q-256`): every authored key a backup row does not carry is
 *    taken off the row it replaces, and `keysRemoved` counts the ones that row held.
 *  - **A repeated id stores its highest seq**; **D-9**: a record with no stamp is stamped from its own
 *    `createdAt` by this instance's `schema > space` windows.
 *  - **The version counter is not moved**: an arrival, a restore's included, never moves it (D-19 B); a restored record takes a
 *    new position in this instance's stream (`withLandingStamp`) and keeps the version it was exported at.
 *
 * ## What is deliberately NOT done here
 *
 * **No `seq` allocation.** An exported document carries the seq it had, and a restore that renumbered them would
 * make this instance disagree with every peer about which copy is newer. Sync preserves an incoming seq for the
 * same reason.
 *
 * **No peer's tombstone refuses it.** A restore puts back the state its backup was taken at (D-69): a record a PEER's deletion
 * covers is landed and NAMED (`restoredOverTombstone`), and the next sync settles it by the deletion rule, as for an instance
 * back from being offline since the backup (the import act forgets what the space received, so every member is read again).
 * What THIS instance deleted after the backup is not landed: a document whose held tombstone was issued here (`issuedHere`)
 * at a version at or above its own, or a file row whose path's tombstone was, is left out and named (`deletedOnRestore`). Only
 * that bit and two versions are compared (no issuer, no author): nothing lands, so no tombstone is made or moved.
 *
 * ## Pages (bundle-40, Q-267)
 *
 * The door lands a body of any size from its spool a page at a time (`importSpool`, `sync/export-stream.ts`), and the
 * tests' `importDocuments` lands an object one family at a time: both through ONE page entry, {@link importPage}, the only
 * caller of the writer here, so what the tests exercise is what the door does. The answer's bounded lists are cut while
 * merging and their totals kept; the summary line, `sayRecorded` and the leaked-row restart are said once per import.
 *
 * **Files are not schema-validated.** A file has no `type` and therefore no type schema — the same asymmetry
 * `embeddingSuppressedFor` encodes by skipping the middle tier for files.
 */
import { TOMBSTONE_TYPE_OF } from '../config/types.js';
import type { BrainCollection } from '../config/types.js';
import { log, logSafe, peerList, peerText } from '../util/log.js';
import type { SchemaViolation } from '../spaces/schema-validation.js';
import { boundedRows } from '../brain/write-validation.js';
import { watchArrivals, recordedOf, sayRecorded, type RecordedFamilies } from './arrival-recording.js';
import { isNewerCopy } from './held-tombstone-rules.js';
import { writeArrivals, arrivalId, arrivalRefusal, NAMED_IN_SUMMARY, type ArrivalOutcome } from './arrivals.js';
import { PageStoppedError } from './page-stopped.js';
import { REPLICATED_FAMILIES, RECORD_TYPE_OF } from './replicated-families.js';
import { readPageTombstones } from './push-reads.js';
import { deletedHereSince } from '../files/tombstones.js';
import { restartLeakedRowScans } from '../files/leaked-rows-repair.js';
import { resetStampHealLatch } from '../brain/retention-stamp-heal.js';
import { edgeIdentityAdmitsForks } from '../spaces/edge-identity-index.js';
import { EdgeIdentityBuilding } from '../util/errors.js';
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { readFamilyPages, type ExportBodyIndex } from './export-stream.js';
import type { RestoreOrigin } from './local-only-fields.js';

/**
 * What an import may carry: every REPLICATED family, by collection name — the same list the export streams, so
 * an export always restores (`Q-206`: the export left out links, and a round trip lost every one).
 */
const IMPORT_TYPES: readonly BrainCollection[] = REPLICATED_FAMILIES.map(f => f.collection);
export type ImportType = BrainCollection;

/** How many documents of one family the door lands per page. */
export const IMPORT_PAGE_SIZE = 500;

/**
 * One document that was stored carrying something the schema does not accept and the copy it replaced lacked. A row is the field and the
 * reason, NEVER the value: the restore's answer is not where a backup's data goes (`R6-9`, names and counts only).
 */
export interface ImportViolation {
  _id: string;
  violations: Array<Pick<SchemaViolation, 'field' | 'reason'>>;
}

/** How many documents a restore's answer names; `schemaViolationsTotal` says how many there were. */
export const IMPORT_VIOLATIONS_NAMED = 50;

/** One document that was NOT stored, and why. */
export interface ImportRefusal {
  _id: string;
  reason: string;
}

export interface ImportTypeResult {
  inserted: number;
  updated: number;
  /** How many were not stored — the total; `refused` names the first of them. */
  errors: number;
  /**
   * The documents not stored, by id and reason — the first `NAMED_IN_SUMMARY` of them, so a 50 000-record restore
   * that fails answers a bounded body; `errors` is how many there were in all.
   */
  refused?: ImportRefusal[];
  /** File chunks and face records left out because this instance derives them from the blob. */
  derived?: number;
  /**
   * Files only: how many restored rows kept the `deletedAt` flag their backup carried (`Q-257`) — files this instance had
   * soft-deleted, brought back as the audit records they were rather than as live rows with no bytes. Present only when any did.
   */
  flagsKept?: number;
  /**
   * Files only: how many authored keys (a description, its source, the properties, the tags, a suppression mark) the restored rows
   * LOST because their backup row lacks them — an export is a full record, so a restore of an older backup over newer edits removes
   * what the backup does not say. Counts the keys the replaced rows held, not the keys the backup lacks. Present only when any were.
   */
  keysRemoved?: number;
  /**
   * Records restored over a PEER's deletion this instance holds — the next sync settles each by the deletion rule (a peer holding the
   * deletion refuses the restored copy unless the record's author pushes it). The first `NAMED_IN_SUMMARY` ids; `restoredOverTombstoneTotal`
   * is how many there were.
   */
  restoredOverTombstone?: string[];
  restoredOverTombstoneTotal?: number;
  /**
   * Documents NOT landed because THIS instance deleted them after the backup was taken: their held tombstone (a file row's: its path's) was
   * issued here at a version at or above theirs (D-69). The first `NAMED_IN_SUMMARY` ids; `deletedOnRestoreTotal` is how many there were.
   */
  deletedOnRestore?: string[];
  deletedOnRestoreTotal?: number;
  /**
   * Records that landed already due for deletion by this space's retention (their `_expireAt` has passed): the next sweep removes them, and
   * each removal issues a tombstone peers apply. The first `NAMED_IN_SUMMARY` ids; `dueTotal` is how many there were.
   */
  due?: string[];
  dueTotal?: number;
  /**
   * Documents stored carrying something the schema does not accept that the copy they replaced lacked, named so an operator can find them: the
   * first {@link IMPORT_VIOLATIONS_NAMED} of them, each with its fields and reasons and no value. An `off` space reports none.
   *
   * Reported rather than refused, and reported per record rather than counted: a number would tell an operator
   * that something in a 50 000-record restore is wrong and nothing about which one — and bounded, because a number of names is not.
   */
  schemaViolations?: ImportViolation[];
  /** How many documents there were in all, when `schemaViolations` names fewer. Present with `schemaViolations`. */
  schemaViolationsTotal?: number;
  /** `schemaViolations` stopped at {@link IMPORT_VIOLATIONS_NAMED} of {@link schemaViolationsTotal}. Present only then. */
  schemaViolationsTruncated?: true;
}

export interface ImportResult {
  spaceId: string;
  results: Record<ImportType, ImportTypeResult>;
}

/** How an import treats what it lands. */
export interface ImportOptions {
  /**
   * Whose backup this is (`RESTORED_INSTANCE_FIELDS`): 'foreign' drops the backup's `syncBase` and `_resolvedElsewhere`. The door decides it from
   * the envelope ({@link restoreOriginOf}); a caller handing documents in code is this instance's own and defaults to 'own'.
   */
  origin?: RestoreOrigin;
}

/** What a whole import has gathered so far, merged page by page: the answer, and what `sayRecorded` says once at the end. */
export interface ImportAccumulator {
  readonly spaceId: string;
  readonly results: Record<ImportType, ImportTypeResult>;
  readonly recorded: Map<string, Map<string, readonly SchemaViolation[]>>;
}

/** Why a family could not be written at all — every document of it is refused with this reason. */
const familyFailed = (err: unknown): string =>
  `the store could not write this family (${peerText(err)}); retry the import`;

/** Append `items` to a bounded list, cut at `max`; the caller keeps the total. */
function cutInto<T>(list: T[] | undefined, items: readonly T[], max: number): T[] {
  const out = list ?? [];
  for (const i of items) { if (out.length >= max) break; out.push(i); }
  return out;
}

/** Name `ids` in a bounded list of the result and count them in its total. */
function nameInto(r: ImportTypeResult, list: 'restoredOverTombstone' | 'deletedOnRestore' | 'due', ids: readonly string[]): void {
  if (ids.length === 0) return;
  r[list] = cutInto(r[list], ids.map(id => peerText(id)), NAMED_IN_SUMMARY);
  const total = `${list}Total` as const;
  r[total] = (r[total] ?? 0) + ids.length;
}

/**
 * Whose backup an envelope names: 'own' when it names THIS instance and the target space, 'foreign' otherwise (another instance, another
 * space, an export older than the field, no envelope). A convenience, never an authority: it decides only `RESTORED_INSTANCE_FIELDS`.
 */
export function restoreOriginOf(envelope: ReadonlyMap<string, unknown>, instanceId: string, spaceId: string): RestoreOrigin {
  return envelope.get('instanceId') === instanceId && envelope.get('spaceId') === spaceId ? 'own' : 'foreign';
}

/** The winning copy of each id of a page, by the writer's rule (highest seq, the earlier of equal ones); refused documents are not in it. */
function winnersOf(family: BrainCollection, docs: readonly unknown[]): Map<string, Record<string, unknown> & { _id: string }> {
  const winners = new Map<string, Record<string, unknown> & { _id: string }>();
  for (const doc of docs) {
    if (arrivalRefusal(doc, { seqOptional: family === 'files' }) !== null) continue;
    const held = winners.get(arrivalId(doc));
    if (held === undefined || isNewerCopy((doc as { seq?: number }).seq, held['seq'] as number | undefined)) winners.set(arrivalId(doc), doc as Record<string, unknown> & { _id: string });
  }
  return winners;
}

/**
 * What the held deletions say of a page's winners, read ONCE for the page: the ids THIS instance deleted after the backup (its own tombstone
 * at a version at or above the document's: not landed, D-69), and, for a record, every id a tombstone is held for (named
 * `restoredOverTombstone` if it lands). A file row with no seq counts as version 0; a file tombstone with no recorded version covers nothing.
 */
async function heldDeletions(
  spaceId: string, family: BrainCollection, winners: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Promise<{ ownSince: Set<string>; held: Set<string> }> {
  const ownSince = new Set<string>();
  const held = new Set<string>();
  if (winners.size === 0) return { ownSince, held };
  const versionOf = (id: string): number => { const s = winners.get(id)?.['seq']; return typeof s === 'number' ? s : 0; };
  if (family === 'files') {
    for (const path of await deletedHereSince(spaceId, [...winners.keys()].map(id => ({ path: id, seq: versionOf(id) })))) ownSince.add(path);
    return { ownSince, held };
  }
  const tombType = TOMBSTONE_TYPE_OF[family];
  if (tombType === undefined) return { ownSince, held };
  for (const [id, t] of (await readPageTombstones(spaceId, [...winners.keys()])).get(tombType) ?? []) {
    held.add(id);
    if (t.issuedHere && t.seq >= versionOf(id)) ownSince.add(id);
  }
  return { ownSince, held };
}

/** The landed ids whose stored retention stamp has already passed: the next sweep deletes them. A read that fails says nothing. */
async function dueOf(spaceId: string, family: BrainCollection, landed: readonly string[]): Promise<string[]> {
  if (landed.length === 0) return [];
  try {
    const stored = await readStoredById<{ _expireAt?: unknown }>(spaceCollection(spaceId, family), landed, { _expireAt: 1 });
    const now = Date.now();
    return landed.filter(id => { const at = stored.get(id)?._expireAt; return at instanceof Date && at.getTime() <= now; });
  } catch (err) {
    log.debug(`Import into space '${peerText(spaceId)}': which ${family} are due could not be read: ${logSafe(String(err))}`);
    return [];
  }
}

/** A fresh accumulator for one import of `spaceId`. */
export function newImportAccumulator(spaceId: string): ImportAccumulator {
  return {
    spaceId,
    results: Object.fromEntries(IMPORT_TYPES.map(t => [t, { inserted: 0, updated: 0, errors: 0 } as ImportTypeResult])) as Record<ImportType, ImportTypeResult>,
    recorded: new Map(),
  };
}

/**
 * Land ONE page of documents of `family` into `acc.spaceId` and merge what it came to into `acc`: the import's one landing site (the door's
 * pages and `importDocuments` both come here). A repeated id inside the page keeps its highest seq (the writer's rule); across pages the
 * caller hands each id once (`readFamilyPages`).
 */
export async function importPage(family: BrainCollection, docs: readonly unknown[], acc: ImportAccumulator, opts: ImportOptions = {}): Promise<void> {
  const spaceId = acc.spaceId;
  if (docs.length === 0) return;
  const result = acc.results[family];

  /*
   * Recorded, never refused — see the docblock, and `sync/arrival-recording.ts` for what recording is: only a document that was STORED,
   * only what the copy it replaced lacked, nothing in an `off` space, names and counts and never a value. Looked at BEFORE the write —
   * the copy a restore replaces is gone afterwards — and only where there is a type SCHEMA to check against (a file has none, a link
   * neither: `watchArrivals` answers nothing for them).
   */
  const winners = winnersOf(family, docs);
  // What this instance deleted after the backup is not landed (D-69); every other held deletion is landed over and named after the write.
  const { ownSince, held } = await heldDeletions(spaceId, family, winners);
  for (const id of ownSince) winners.delete(id);
  nameInto(result, 'deletedOnRestore', [...ownSince]);
  const toLand = ownSince.size === 0 ? docs : docs.filter(d => !ownSince.has(arrivalId(d)));
  if (toLand.length === 0) return;
  // A fork edge shares its subject's five identity fields: a space whose identity index is still the full one cannot hold it. The import answers the push
  // doors' `503 edge_identity_building` (design 5.4) and the families before it stay, because a restore is idempotent and a re-run lands the rest.
  if (family === 'edges' && [...winners.values()].some(d => typeof d['forkOf'] === 'string') && !(await edgeIdentityAdmitsForks(spaceId))) throw new EdgeIdentityBuilding(spaceId);
  const watch = await watchArrivals(spaceId, family, [...winners.values()], 'import');

  let out: ArrivalOutcome;
  try {
    out = await writeArrivals(spaceId, family, RECORD_TYPE_OF[family], toLand, { restore: true, restoreOrigin: opts.origin ?? 'own' });
  } catch (err) {
    log.warn(`Import into space '${peerText(spaceId)}': ${family} could not be written: ${logSafe(String(err))}`);
    // `Q-224`: the writer always says what it had done when it stopped — a record write that failed part-way.
    // What it vouches for is reported as landed.
    const partial = err instanceof PageStoppedError ? err.partial : undefined;
    if (!partial) {
      // Nothing of the page is vouched for, so every document is named.
      result.refused = cutInto(result.refused, toLand.slice(0, NAMED_IN_SUMMARY).map(d => ({ _id: peerText(arrivalId(d)), reason: familyFailed(err) })), NAMED_IN_SUMMARY);
      result.errors += toLand.length;
      return;
    }
    // The writer stopped part-way: the chunks before the fault are COMMITTED. Report what landed, and refuse only
    // what did not — a restore that says "nothing was written" over records it did write is the worse lie.
    out = partial;
    const settled = new Set([...out.inserted, ...out.updated, ...out.derived, ...out.newerLocal,
      ...out.duplicates, ...out.refused.map(r => r._id)]);
    const unwritten = [...new Set(toLand.map(arrivalId))].filter(id => !settled.has(id));
    out = { ...out, refused: [...out.refused, ...unwritten.map(_id => ({ _id, reason: familyFailed(err) }))] };
  }
  result.inserted += out.inserted.length;
  result.updated += out.updated.length;
  const refused: ImportRefusal[] = [
    ...out.refused,
    ...out.duplicates.map(_id => ({ _id, reason: 'a uniquely-indexed duplicate of a record held here under another id' })),
  ];
  result.errors += refused.length;
  // Named in the answer bounded (`Q-270`): a megabyte `_id` or seq is cut where it is SHOWN, never where it is a
  // key — `settled` above and the writer match refusals to documents by the id as it arrived.
  if (refused.length > 0) {
    result.refused = cutInto(result.refused, refused.slice(0, NAMED_IN_SUMMARY).map(r => ({ ...r, _id: peerText(r._id), reason: peerText(r.reason) })), NAMED_IN_SUMMARY);
  }
  if (out.derived.length > 0) result.derived = (result.derived ?? 0) + out.derived.length;
  if (out.flagKept.length > 0) result.flagsKept = (result.flagsKept ?? 0) + out.flagKept.length;
  if (out.keysRemoved > 0) result.keysRemoved = (result.keysRemoved ?? 0) + out.keysRemoved;
  // What the documents that LANDED carry that the copies they replaced did not. The answer names the first `IMPORT_VIOLATIONS_NAMED`
  // of them, by id and by field and reason — never a value — and says how many there were in all and that it stopped short.
  const landed = [...out.inserted, ...out.updated];
  const stored = new Set(landed);
  const recorded = recordedOf(watch, [...winners.values()].filter(d => stored.has(d._id)), 'import');
  if (recorded.size > 0) {
    const rows = [...recorded];
    result.schemaViolations = cutInto(result.schemaViolations, rows.slice(0, IMPORT_VIOLATIONS_NAMED).map(([doc, found]) => ({
      _id: peerText(doc._id),
      // The one bounded renderer, without values (an import's report never carries one), then the report's own two fields.
      violations: boundedRows(found, { value: false }).map(({ field, reason }) => ({ field, reason })),
    })), IMPORT_VIOLATIONS_NAMED);
    result.schemaViolationsTotal = (result.schemaViolationsTotal ?? 0) + rows.length;
    if (result.schemaViolationsTotal > IMPORT_VIOLATIONS_NAMED) result.schemaViolationsTruncated = true;
    const seen = acc.recorded.get(family) ?? new Map<string, readonly SchemaViolation[]>();
    for (const [doc, found] of rows) seen.set(doc._id, found);
    acc.recorded.set(family, seen);
  }
  // A PEER's deletion this instance holds for a record the restore just brought back: named, and settled by the next sync.
  nameInto(result, 'restoredOverTombstone', landed.filter(id => held.has(id)));
  nameInto(result, 'due', await dueOf(spaceId, family, landed));
}

/** Pages of one import, in landing order: a family and its documents. */
type ImportPages = AsyncIterable<readonly [BrainCollection, readonly unknown[]]>;

/** The import's driver: every page through {@link importPage}, then the one summary of the whole import. */
async function importInto(spaceId: string, pages: ImportPages, opts: ImportOptions): Promise<ImportResult> {
  const acc = newImportAccumulator(spaceId);
  for await (const [family, docs] of pages) await importPage(family, docs, acc, opts);
  const results = acc.results;

  // Said once for the restore, names and counts only. Never throws, so it cannot turn a restore that landed into one that failed.
  sayRecorded({ spaceId, source: 'import', peer: 'import', families: acc.recorded as RecordedFamilies });

  log.info(
    `Import into space '${peerText(spaceId)}': `
    + peerList(IMPORT_TYPES.map(t => {
      const r = results[t];
      const v = r.schemaViolationsTotal ?? 0;
      const tomb = r.restoredOverTombstoneTotal ?? 0;
      const gone = r.deletedOnRestoreTotal ?? 0;
      const due = r.dueTotal ?? 0;
      return `${t}: +${r.inserted} ~${r.updated} !${r.errors}${v > 0 ? ` ?${v}` : ''}${tomb > 0 ? ` over-tombstone ${tomb}` : ''}${gone > 0 ? ` deleted-since ${gone}` : ''}`
        + `${due > 0 ? ` due ${due}` : ''}${r.flagsKept ? ` flagged ${r.flagsKept}` : ''}${r.keysRemoved ? ` keys-removed ${r.keysRemoved}` : ''}`;
    }), ', '),
  );

  return { spaceId, results };
}

/** What every import does once it has landed, however far it got: the space's leaked-row scan and its stamp heal see the new records. */
function afterImport(spaceId: string): void {
  restartLeakedRowScans([spaceId]);
  // An import is the one door left that can store a retention stamp that is not a Date (an older body, a hand-made one): the sweep's heal asks this space's
  // collections again (`brain/retention-stamp-heal.ts`).
  resetStampHealLatch(spaceId);
}

/** An object's families as pages, one per family in `IMPORT_TYPES` order: a family is one call, so a repeated id keeps its highest seq. */
async function* pagesOfPayload(payload: Record<string, unknown>): ImportPages {
  for (const t of IMPORT_TYPES) {
    const docs = Array.isArray(payload[t]) ? payload[t] as unknown[] : [];
    if (docs.length > 0) yield [t, docs] as const;
  }
}

/** A spooled body's families as pages of {@link IMPORT_PAGE_SIZE}, in `IMPORT_TYPES` order whatever the body's order; each id once. */
async function* pagesOfSpool(file: string, index: ExportBodyIndex): ImportPages {
  for (const t of IMPORT_TYPES) {
    for await (const page of readFamilyPages(file, index, t, { pageSize: IMPORT_PAGE_SIZE })) yield [t, page] as const;
  }
}

/**
 * Import a payload of exported documents into one space — the import as code, which the tests drive.
 *
 * **It restarts the space's leaked-rows scan before it answers** (`files/leaked-rows-repair.ts`), whatever the payload carried and
 * however far it got: the records it brought were never read, and a scan that had completed would sit out its day over them. The scan
 * is not run here; the next tick of the sweep does it.
 */
export async function importDocuments(spaceId: string, payload: Record<string, unknown>, opts: ImportOptions = {}): Promise<ImportResult> {
  try { return await importInto(spaceId, pagesOfPayload(payload), opts); }
  finally { afterImport(spaceId); }
}

/** Import the body spooled at `file`, read and validated whole before (`indexExportBody`), a page at a time: the door's import act. */
export async function importSpool(spaceId: string, file: string, index: ExportBodyIndex, opts: ImportOptions = {}): Promise<ImportResult> {
  try { return await importInto(spaceId, pagesOfSpool(file, index), opts); }
  finally { afterImport(spaceId); }
}

