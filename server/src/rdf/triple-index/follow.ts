/**
 * The follower of a space's triple index: it applies the records the space's stream positions to the index, before the write that
 * positioned them answers (bundle-273, Q-764 S1; design-r2 R1, R3, R4, R7).
 *
 * ## The question it answers
 *
 * "Bring this space's index up to the records as they are now." The records stream (`sync/record-position-stream.ts`) calls it after every
 * write it held has settled (`afterSettle`, `util/position-clock.ts`), so a door answers after its statements are indexed. A failure here
 * never fails the write: the clock logs it, and the next run applies what this one did not.
 *
 * ## How
 *
 * One run per space at a time in this process (a second call while one runs waits for the run after it, which reads everything the first
 * missed), and one follower per space across processes (a lease in `rdf_state`, checked again inside each batch). A run reads the settled cap
 * FIRST, then, in batches of at most {@link BATCH_RECORDS} by position, every row of the six record collections and of `tombstones` above
 * where it stands, and applies each record's form now (`store.ts`):
 *
 *  - **R1: every visible record above `appliedPos`, whatever the cap.** A transaction that holds a floor keeps the cap below it for as long as
 *    it runs; a write above the floor that committed is applied anyway. `appliedPos` moves only to `cap - 1` (or to the last row of a batch
 *    that is not the last), so a record below the cap that was not yet visible is read again by the next run. Applying a record twice is a
 *    no-op: the apply diffs against the record's stored row.
 *  - **R3: one form per index.** Each batch takes a snapshot of the space's resolved meta, computes its forms with it, and hands its key to
 *    the apply, which compares it with the stored `formKey` inside the transaction: another form marks the index `stale` and applies nothing.
 *    A rebuild (slice S4) is what makes a stale index ready again.
 *  - **R4: a tombstone is read too.** A record removed with its tombstone never shows its own row again, so the tombstones are read by
 *    position as well, and the record's current row is read for each: absent, its statements are dropped.
 *  - **R7: no row filter.** The record collections are read whole (a fork row, a chunk, a soft delete, a feed marker included): a row the
 *    form leaves out is a record with no statements, and its statements are dropped.
 *
 * A space with RDF off has no index and the follower does nothing for it; a space whose RDF is on but unsettled (a contested base, a term
 * clash) is not followed until it is settled. Nor does it start an index: a space whose index has no state row, or one no rebuild wrote, is
 * left alone until the rebuild's swap writes the state (the upkeep builds it), so a write in it does no index work meanwhile (P2).
 */
import { randomUUID } from 'node:crypto';
import type { SpaceMeta } from '@ythril-network/schema';
import { getConfig } from '../../config/loader.js';
import { col, asFilter } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { readStoredById } from '../../db/read-by-id.js';
import { log, peerText } from '../../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../../util/warn-once.js';
import { RDF_READ_FIELDS, recordTriples, type RdfRecordKind } from '../record-triples.js';
import { RDF_KIND_COLLECTIONS, rdfKindCollection } from '../rdf-members.js';
import { rdfSpaceState } from '../rdf-space-state.js';
import { onSettled, settledPositionCap, type SettledHook } from '../../util/position-clock.js';
import { recordPositions } from '../../sync/record-position-stream.js';
import { termKey } from './terms.js';
import {
  applyTripleIndexBatch, formKeyOf, markTripleIndexStale, readTripleIndexState, releaseTripleIndexLease, takeTripleIndexLease,
  type RecordChange, type StatementKeys,
} from './store.js';
import { clearableJournalRows, journalAsksForRebuild, journalRecordWrites } from './journal.js';
import { catchUpTripleIndexWith } from './read.js';

/** The most records one batch applies, in one transaction. */
export const BATCH_RECORDS = 500;
/** The most batches one run applies: a space far behind (records landed in bulk above its rebuild) is caught up over several writes, `catching-up` meanwhile. */
export const BATCHES_PER_RUN = 8;
/** How long a follower's lease lasts; renewed each batch. */
const LEASE_MS = 60_000;
/** This process's name as a lease owner. */
const OWNER = randomUUID();

/**
 * The resolved meta of `spaceId` when its records have an RDF form now (`rdfSpaceState`, the one rule the exports ask); `null` when RDF is
 * off (the space has no index) or its names are not settled (it is not followed until they are). The fingerprint is not asked for.
 */
export function formMetaOf(spaceId: string): SpaceMeta | null {
  const state = rdfSpaceState(getConfig(), spaceId, undefined, () => '');
  return state.ok ? state.meta : null;
}

/** Per space: the run in progress, and the run queued after it (which every caller arriving meanwhile shares). */
const running = new Map<string, Promise<void>>();
const queued = new Map<string, Promise<void>>();

/**
 * Bring `spaceId`'s index up to its records. `settledCap` is the records stream's settled cap for the space (the clock hands it in, so this
 * module does not import the stream). Resolves when a run that started after this call has finished; rejects with that run's failure.
 */
export function followTripleIndex(spaceId: string, settledCap: () => Promise<number>): Promise<void> {
  const waiting = queued.get(spaceId);
  if (waiting) return waiting;
  const before = running.get(spaceId) ?? Promise.resolve();
  const run = before.catch(() => undefined).then(() => {
    queued.delete(spaceId);
    return followOnce(spaceId, settledCap);
  });
  queued.set(spaceId, run);
  const settled = run.catch(() => undefined).finally(() => { if (running.get(spaceId) === settled) running.delete(spaceId); });
  running.set(spaceId, settled);
  return run;
}

/** The hook the records stream runs after each settled write: one object, so registering it twice is a no-op. */
const FOLLOW_AFTER_SETTLE: SettledHook<number> = { after: (spaceId, settledCap) => followTripleIndex(spaceId, settledCap) };

/**
 * Make every settled write of the records stream bring its space's index up before it returns. Called once by the application at its start
 * (`app.ts`, which the server and every in-process test door load), never by the stream itself: the stream is read by every position-paged
 * reader, and a reader must not reach the follower's writes.
 */
export function followRecordWrites(): void {
  onSettled(recordPositions, FOLLOW_AFTER_SETTLE);
  journalRecordWrites(wakeFollower);
  catchUpTripleIndexWith(followTripleIndexNow);
}

/** A journal failure to wake the follower is said once per window and space: the next write, or the barrier's catch-up, runs it again. */
const wakeFailed = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });

/**
 * Run `spaceId`'s follower up to the records stream's settled cap now: the read side's catch-up (`read.ts`, the query barrier), which
 * resolves when a run that started after this call has finished.
 */
export function followTripleIndexNow(spaceId: string): Promise<void> {
  return followTripleIndex(spaceId, () => settledPositionCap(recordPositions, spaceId));
}

/** Run `spaceId`'s follower after a journaled write, not awaited: the write has answered, and its rows keep the space outstanding meanwhile. */
function wakeFollower(spaceId: string): void {
  followTripleIndexNow(spaceId).catch((err: unknown) => wakeFailed(spaceId,
    () => log.warn(`Triple index of space '${peerText(spaceId)}': the follower after a journaled write failed; the next one runs it again: ${peerText(String(err))}`)));
}

/** One run: see the module docblock. */
async function followOnce(spaceId: string, settledCap: () => Promise<number>): Promise<void> {
  if (formMetaOf(spaceId) === null) return;
  // An index no rebuild built is never read and the upkeep's rebuild replaces it: applying records to one (P2) was work thrown away inside
  // every write of the space until the rebuild landed. The rebuild's swap writes the state; the follower takes over from its `appliedPos`.
  if (typeof (await readTripleIndexState(spaceId))?.buildId !== 'string') return;
  if (!(await takeTripleIndexLease(spaceId, OWNER, LEASE_MS))) return;
  try {
    // The state is read again under the lease: a swap or a restore may have come between.
    const state = await readTripleIndexState(spaceId);
    if (state === null || typeof state.buildId !== 'string' || state.status === 'stale') return;
    if (!(await followPositions(spaceId, state.appliedPos, settledCap))) return;
    await followJournal(spaceId);
  } finally {
    await releaseTripleIndexLease(spaceId, OWNER);
  }
}

/**
 * The journal's part of a run (`journal.ts`), after the positioned part: a row `*` marks the index stale; otherwise the rows that may be
 * cleared (done, or abandoned) are read FIRST, then the records they name, and each batch applies those records' current forms and deletes
 * exactly those rows in one transaction. A row read as not done stays for a later run, so a write still in flight is never passed.
 */
async function followJournal(spaceId: string): Promise<void> {
  for (let batch = 1; batch <= BATCHES_PER_RUN; batch++) {
    if (await journalAsksForRebuild(spaceId)) { await markTripleIndexStale(spaceId); return; }
    const rows = await clearableJournalRows(spaceId, BATCH_RECORDS);
    if (rows.length === 0) return;
    const meta = formMetaOf(spaceId);
    if (meta === null) return;
    // Each named record as a re-read (the tombstone path of `currentForms`): its stored row now, or no statements when it is gone.
    const named: PositionedRow[] = [];
    for (const { key } of rows) {
      const cut = key.indexOf(':');
      const kind = key.slice(0, cut) as RdfRecordKind;
      if (cut > 0 && RDF_KIND_COLLECTIONS.some(c => c.kind === kind)) named.push({ pos: 0, kind, id: key.slice(cut + 1), tombstone: true, doc: null });
    }
    const outcome = await applyTripleIndexBatch(spaceId, {
      formKey: formKeyOf(meta), owner: OWNER, changes: await currentForms(spaceId, meta, named), appliedPos: 0, clearJournal: rows.map(r => r._id),
    });
    if (outcome !== 'applied' || rows.length < BATCH_RECORDS) return;
    if (!(await takeTripleIndexLease(spaceId, OWNER, LEASE_MS))) return;
  }
}

/** The positioned part of a run: false when the run must stop (the index went stale, the lease was lost, the space lost its form). */
async function followPositions(spaceId: string, appliedPos: number, settledCap: () => Promise<number>): Promise<boolean> {
  // The cap is read before any row: every record below it was visible when the rows were read.
  const cap = await settledCap();
  let after = appliedPos;
  for (let batch = 1; ; batch++) {
    const meta = formMetaOf(spaceId);
    if (meta === null) return false;
    const read = await changesAfter(spaceId, after);
    // A full batch may have rows after it: `appliedPos` stops at its last row (and below the cap), and the next batch reads on above it.
    // Rows tied at the last position (a legacy band can tie) are left whole to the next batch, or a row of the tie past the cut is never read.
    const full = read.length === BATCH_RECORDS;
    const rows = full ? withoutTrailingTie(read) : read;
    if (full && rows.length === 0) {
      tiedBatch(spaceId, () => log.warn(`Triple index of space '${peerText(spaceId)}': more than ${BATCH_RECORDS} rows share one position; it stays catching-up until a rebuild`));
      return true;
    }
    const lastPos = rows.length > 0 ? rows[rows.length - 1]!.pos : after;
    const more = full && batch < BATCHES_PER_RUN;
    const outcome = await applyTripleIndexBatch(spaceId, {
      formKey: formKeyOf(meta), owner: OWNER,
      changes: await currentForms(spaceId, meta, rows),
      appliedPos: full ? Math.min(lastPos, cap - 1) : cap - 1,
      status: full ? 'catching-up' : 'ready',
    });
    if (outcome !== 'applied') return false;
    if (!more) return true;
    after = lastPos;
    if (!(await takeTripleIndexLease(spaceId, OWNER, LEASE_MS))) return false;
  }
}

/** A batch made only of one tied position is said once per window and space. */
const tiedBatch = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });

/** `rows` (in position order) without the rows that share the last one's position. */
function withoutTrailingTie(rows: readonly PositionedRow[]): PositionedRow[] {
  const last = rows[rows.length - 1]?.pos;
  let end = rows.length;
  while (end > 0 && rows[end - 1]!.pos === last) end--;
  return rows.slice(0, end);
}

/** One positioned row: a record row (its kind and id) or a tombstone of one. */
interface PositionedRow { pos: number; kind: RdfRecordKind; id: string; tombstone: boolean; doc: Record<string, unknown> | null }

/** The fields a record's statements read, and its position: what the follower, a rebuild and the verify read of a record. */
export const projectionOf = (kind: RdfRecordKind): Record<string, 1> => Object.fromEntries([...RDF_READ_FIELDS[kind], 'pos'].map(f => [f, 1 as const]));
/** The tombstone types are the record kinds a tombstone buries (never `file`: a deleted file is a feed marker row, read with the files). */
const TOMBSTONE_KINDS: ReadonlySet<string> = new Set<RdfRecordKind>(['entity', 'fact', 'chrono', 'edge', 'link']);

/**
 * The first {@link BATCH_RECORDS} rows above `after`, by position, over the record collections (no row filter: R7) and the tombstones
 * (R4). Each source is read in its `pos` order with the same limit, so the merge holds the true first rows.
 */
async function changesAfter(spaceId: string, after: number): Promise<PositionedRow[]> {
  const rows: PositionedRow[] = [];
  for (const { kind, collection } of RDF_KIND_COLLECTIONS) {
    const docs = await col<Record<string, unknown> & { _id: string }>(spaceCollection(spaceId, collection))
      .find(asFilter({ pos: { $gt: after } }), { projection: projectionOf(kind), sort: { pos: 1 }, limit: BATCH_RECORDS }).toArray();
    for (const doc of docs) rows.push({ pos: doc['pos'] as number, kind, id: String(doc._id), tombstone: false, doc });
  }
  const tombs = await col<{ _id: string; type: string; pos: number }>(spaceCollection(spaceId, 'tombstones'))
    .find(asFilter({ pos: { $gt: after } }), { projection: { _id: 1, type: 1, pos: 1 }, sort: { pos: 1 }, limit: BATCH_RECORDS }).toArray();
  for (const t of tombs) {
    if (TOMBSTONE_KINDS.has(t.type)) rows.push({ pos: t.pos, kind: t.type as RdfRecordKind, id: String(t._id), tombstone: true, doc: null });
  }
  rows.sort((a, b) => a.pos - b.pos);
  return rows.slice(0, BATCH_RECORDS);
}

/**
 * Each record of `rows` once, with its statements now: a record a tombstone of the batch names is read again (after the tombstones were
 * read, so a removal the row read missed is seen), a row the form leaves out states nothing.
 */
async function currentForms(spaceId: string, meta: SpaceMeta, rows: readonly PositionedRow[]): Promise<RecordChange[]> {
  const latest = new Map<string, PositionedRow>();
  for (const row of rows) latest.set(`${row.kind}:${row.id}`, row);
  const buried = new Map<RdfRecordKind, string[]>();
  for (const row of rows) {
    if (!row.tombstone) continue;
    const ids = buried.get(row.kind);
    if (ids) ids.push(row.id); else buried.set(row.kind, [row.id]);
  }
  const now = new Map<string, Record<string, unknown> | null>();
  for (const [kind, ids] of buried) {
    const docs = await readStoredById<Record<string, unknown>>(spaceCollection(spaceId, rdfKindCollection(kind)), ids, projectionOf(kind));
    for (const id of ids) now.set(`${kind}:${id}`, docs.get(id) ?? null);
  }
  const changes: RecordChange[] = [];
  for (const [key, row] of latest) {
    const doc = now.has(key) ? now.get(key)! : row.doc;
    changes.push({ kind: row.kind, id: row.id, pos: row.pos, statements: doc === null ? [] : statementsOf(meta, row.kind, doc) });
  }
  return changes;
}

/** The statements of one stored record, as the export's mapper gives them (RDF 1.2 edge details, no agent memory). */
export function statementsOf(meta: SpaceMeta, kind: RdfRecordKind, doc: Record<string, unknown>): StatementKeys[] {
  const form = recordTriples(meta, kind, doc, { edgeDetails: 'rdf12' });
  if (form.leftOut !== undefined) return [];
  return form.quads.map(q => [termKey(q.subject), termKey(q.predicate), termKey(q.object)] as const);
}
