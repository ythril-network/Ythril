/**
 * The triple index's write journal: a row for every record write the follower does not see by position, written at the one db door before
 * the write runs (bundle-273, Q-764 S2; design-r2 R2 and R6; contract rows 1 to 5).
 *
 * ## The question it answers
 *
 * "Which records may this write change that no position will bring to the follower?" The follower (`follow.ts`) reads records by position.
 * A write that carries none still changes what a statement reads: chrono redaction, a schema stamp set or cleared, a converged file date, a
 * migration, a wipe, every delete without a tombstone. Each such write first inserts its own rows into `<space>_rdf_dirty`, one per record
 * it may change: `{ _id: <own>, key: '<kind>:<id>', done, at }`. The follower re-reads each record a row names and clears the row in the
 * transaction that applies what it read.
 *
 * ## What it prevents
 *
 * - **A change nothing names.** The row is written BEFORE the write, in the write's session when it has one, so a crash between the two
 *   leaves a row (cleared once older than {@link journalRowAbandonedMs}, after the record is read again) and never a change without one.
 * - **R2 (finding F2): one write's done mark clearing another's row.** Each write has its own rows. Outside a transaction a row is written
 *   `done: false` and marked done only after its write settled; the follower clears only rows it read as done (or abandoned) BEFORE it read
 *   the records, so the record it applies was read after the write landed. A row that is not done keeps the space outstanding
 *   ({@link hasOutstandingJournalRows}, which the drift verify asks; the query barrier reads the same in its one command, `read.ts`) and survives every run until it is done. Inside a transaction the row is
 *   written done in the transaction's session: it becomes visible only with the commit that makes the write visible, and an abort takes both.
 * - **A filter the journal cannot name record by record** (no `_id`, no `$in` or `$or` of ids) writes the row `*`, which marks the index
 *   stale (a rebuild, slice S4). R6: the writers whose filter was an end of an edge or a file's links read their ids first.
 * - **A dropped or renamed record collection**: its space's index (and a rename target's) is marked stale before the call.
 * - **A positioned write in a transaction that holds no floor** (`withLandingStamp` handed a session outside `inHeldTransaction`): its stamp
 *   settles before the commit, so the follower runs while the record is not visible and passes its position. It is journaled too.
 *
 * A write that changes no field a statement reads (`RDF_READ_FIELDS` of its kind) needs no row. A write that would need one in a space with RDF
 * off writes none (nothing follows the index of the time before) and marks that index stale instead (G3), as a drop or rename does. Writes
 * carrying a numeric `pos` are the follower's.
 */
import { randomUUID } from 'node:crypto';
import { col, asFilter, asUpdate } from '../../db/mongo.js';
import { parseSpaceCollection, spaceCollection, SPACE_COLLECTIONS } from '../../db/space-collection.js';
import { setRecordWriteJournal, type JournalTicket, type RecordWriteJournal } from '../../db/record-write-observer.js';
import { holdDeadlineMs, writeTimeoutMs } from '../../db/write-bound.js';
import { getConfig } from '../../config/loader.js';
import { inChunks } from '../../util/chunks.js';
import { inOneCommandChunks } from '../../db/one-command.js';
import { log, peerText } from '../../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../../util/warn-once.js';
import { insideFloorOf } from '../../util/position-clock.js';
import { recordPositions } from '../../sync/record-position-stream.js';
import { RDF_READ_FIELDS, type RdfRecordKind } from '../record-triples.js';
import { RDF_KIND_COLLECTIONS } from '../rdf-members.js';
import { markTripleIndexStale, recordKeyOf } from './store.js';

/** The key of a row that names no record: the whole space may have changed, so its index needs a rebuild. */
export const EVERY_RECORD = '*';

/** One journal row. `at` is when it was written (ms), so a row whose writer died is known by its age. */
export interface JournalRow { _id: string; key: string; done: boolean; at: number }

/** The most rows one insert sends. */
const ROWS_PER_INSERT = 1_000;

const journalOf = (spaceId: string) => col<JournalRow>(spaceCollection(spaceId, 'rdfDirty'));

/**
 * How old a row that is not done must be before the follower takes it as abandoned (its writer died between the write and the mark): twice
 * the longest a write or a held transaction may run, so a write still in flight is never taken for a dead one.
 */
export function journalRowAbandonedMs(): number {
  return ABANDONED_AFTER_BOUNDS * Math.max(writeTimeoutMs(), holdDeadlineMs());
}

/** How many of the longest write bounds a row that is not done must outlive before it is taken as abandoned. */
const ABANDONED_AFTER_BOUNDS = 2;

/** The record kind of each record collection suffix. */
const KIND_OF_SUFFIX: ReadonlyMap<string, RdfRecordKind> = new Map(RDF_KIND_COLLECTIONS.map(c => [SPACE_COLLECTIONS[c.collection], c.kind] as const));

/** The space and record kind of a collection name, or null for a collection that holds no records with a form. */
function recordCollectionOf(name: string): { spaceId: string; kind: RdfRecordKind } | null {
  const parsed = parseSpaceCollection(name);
  const kind = parsed ? KIND_OF_SUFFIX.get(parsed.suffix) : undefined;
  return parsed && kind ? { spaceId: parsed.spaceId, kind } : null;
}

/** Whether `spaceId` has RDF on, so an index. A configuration not loaded yet (a boot step) is answered yes: a row too many is cleared. */
function rdfOn(spaceId: string): boolean {
  let spaces;
  try { spaces = getConfig().spaces; } catch { return true; }
  const rdf = spaces.find(s => s.id === spaceId)?.meta?.rdf;
  return rdf?.enabled === true && Boolean(rdf.base);
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isId = (v: unknown): v is string | number => typeof v === 'string' || typeof v === 'number';

/**
 * The ids a filter is limited to, or null when it is not limited to ids (R6): `_id` equal to a value, `$eq` or `$in` of values, an `$and`
 * of which one branch is, an `$or` of which every branch is. Other conditions beside the `_id` only narrow the set further.
 */
export function idsOfFilter(filter: unknown): Array<string | number> | null {
  if (!isPlain(filter)) return null;
  if ('_id' in filter) {
    const v = filter['_id'];
    if (isId(v)) return [v];
    if (isPlain(v)) {
      if (isId(v['$eq'])) return [v['$eq']];
      if (Array.isArray(v['$in']) && v['$in'].every(isId)) return v['$in'] as Array<string | number>;
    }
  }
  if (Array.isArray(filter['$and'])) {
    for (const branch of filter['$and']) { const ids = idsOfFilter(branch); if (ids) return ids; }
  }
  if (Array.isArray(filter['$or']) && filter['$or'].length > 0) {
    const all: Array<string | number> = [];
    for (const branch of filter['$or']) { const ids = idsOfFilter(branch); if (!ids) return null; all.push(...ids); }
    return all;
  }
  return null;
}

/** A numeric position, as a value or a pipeline `$literal`. */
const isPosition = (v: unknown): boolean => typeof v === 'number' || (isPlain(v) && typeof v['$literal'] === 'number');

/** Whether an update sets `pos` to a position (a landing's). A copy of another field (`'$seq'`) is not one: that write is judged by its fields. */
function setsPosition(update: unknown): boolean {
  if (Array.isArray(update)) return update.some(stage => isPlain(stage) && [stage['$set'], stage['$addFields']].some(s => isPlain(s) && isPosition(s['pos'])));
  return isPlain(update) && isPlain(update['$set']) && isPosition(update['$set']['pos']);
}

/** Whether an update may change a field `kind`'s statements read. An operator or a stage this does not know is taken as touching. */
function touchesRead(kind: RdfRecordKind, update: unknown): boolean {
  const read = new Set(RDF_READ_FIELDS[kind]);
  const hits = (path: string): boolean => read.has(path.split('.')[0]!);
  if (Array.isArray(update)) {
    return update.some((stage) => {
      if (!isPlain(stage)) return true;
      return Object.entries(stage).some(([op, body]) => {
        if (op === '$set' || op === '$addFields') return !isPlain(body) || Object.keys(body).some(hits);
        if (op === '$unset') return (Array.isArray(body) ? body : [body]).some(f => typeof f !== 'string' || hits(f));
        return true;
      });
    });
  }
  if (!isPlain(update)) return true;
  return Object.entries(update).some(([op, body]) => {
    if (!op.startsWith('$') || !isPlain(body)) return true;
    if (op === '$rename') return Object.entries(body).some(([from, to]) => hits(from) || typeof to !== 'string' || hits(to));
    return Object.keys(body).some(hits);
  });
}

/** What one write needs: no row, the ids it may change, or the whole space. */
type Need = null | { ids: Array<string | number> } | 'every';

const fromFilter = (filter: unknown): Need => { const ids = idsOfFilter(filter); return ids ? { ids } : 'every'; };
const docId = (doc: unknown): Need => (isPlain(doc) && isId(doc['_id']) ? { ids: [doc['_id']] } : 'every');

/**
 * What a write of `method` with `args` on a collection of `kind` needs journaled. `positionedCounts`: a write carrying a position is the
 * follower's (false inside a transaction that holds no floor, where it is journaled too).
 */
function needOf(kind: RdfRecordKind, method: string, args: readonly unknown[], positionedCounts: boolean): Need[] {
  const positioned = (doc: unknown): boolean => positionedCounts && isPlain(doc) && typeof doc['pos'] === 'number';
  const update = (filter: unknown, u: unknown): Need => {
    if (setsPosition(u)) return positionedCounts ? null : fromFilter(filter);
    return touchesRead(kind, u) ? fromFilter(filter) : null;
  };
  const replace = (filter: unknown, doc: unknown): Need => {
    if (positioned(doc)) return null;
    const byFilter = fromFilter(filter);
    return byFilter === 'every' ? docId(doc) : byFilter;
  };
  switch (method) {
    case 'insertOne': return [positioned(args[0]) ? null : docId(args[0])];
    case 'insertMany': return (Array.isArray(args[0]) ? args[0] : []).map(d => (positioned(d) ? null : docId(d)));
    case 'replaceOne': case 'findOneAndReplace': return [replace(args[0], args[1])];
    case 'updateOne': case 'updateMany': case 'findOneAndUpdate': return [update(args[0], args[1])];
    case 'deleteOne': case 'deleteMany': case 'findOneAndDelete': return [fromFilter(args[0])];
    case 'bulkWrite': return (Array.isArray(args[0]) ? args[0] : []).flatMap((op: unknown): Need[] => {
      if (!isPlain(op)) return ['every'];
      const [name, body] = Object.entries(op)[0] ?? [];
      if (!isPlain(body)) return ['every'];
      if (name === 'insertOne') return [positioned(body['document']) ? null : docId(body['document'])];
      if (name === 'replaceOne') return [replace(body['filter'], body['replacement'])];
      if (name === 'updateOne' || name === 'updateMany') return [update(body['filter'], body['update'])];
      if (name === 'deleteOne' || name === 'deleteMany') return [fromFilter(body['filter'])];
      return ['every'];
    });
    default: return ['every'];
  }
}

interface SessionArg { inTransaction(): boolean }
function sessionOf(args: readonly unknown[]): SessionArg | undefined {
  for (const a of args) {
    const s = isPlain(a) ? a['session'] as Partial<SessionArg> | undefined : undefined;
    if (s && typeof s.inTransaction === 'function') return s as SessionArg;
  }
  return undefined;
}

/** What `before` hands to `after`: the space, the rows to mark done (none inside a transaction: they were written done). */
interface Ticket extends JournalTicket { spaceId: string; rows: string[] }

/** A failure to mark rows done is said once per window and space: the rows stay outstanding until the follower takes them as abandoned. */
const markFailed = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });

/**
 * The journal the db door keeps (`setRecordWriteJournal`). `wake(spaceId)` runs the follower of a space whose rows are done; the caller
 * (`follow.ts`) hands it in, so this module does not import the follower.
 */
export function recordWriteJournal(wake: (spaceId: string) => void): RecordWriteJournal {
  return {
    wants: (name) => recordCollectionOf(name) !== null,
    before(name, method, args) {
      const target = recordCollectionOf(name);
      if (target === null) return null;
      // G3: a space with RDF off keeps the index of the time before, which nothing follows. Every write that would be journaled (and every
      // drop or rename) marks that index stale instead, so RDF on again never reads statements an unpositioned write has outdated.
      if (method === 'drop' || method === 'rename') return forgetting(target.spaceId, method === 'rename' ? args[0] : undefined);
      const session = sessionOf(args);
      const inTransaction = session?.inTransaction() === true;
      const needs = needOf(target.kind, method, args, !inTransaction || insideFloorOf(recordPositions, target.spaceId));
      if (needs.every(n => n === null)) return null;
      if (!rdfOn(target.spaceId)) return staleWhileOff(target.spaceId);
      const keys = needs.some(n => n === 'every')
        ? [EVERY_RECORD]
        : [...new Set(needs.flatMap(n => (n === null || n === 'every' ? [] : n.ids.map(id => recordKeyOf(target.kind, String(id))))))];
      return writeRows(target.spaceId, keys, session, inTransaction);
    },
    async after(ticket) {
      const { spaceId, rows } = ticket as Ticket;
      try {
        for (const chunk of inChunks(rows, ROWS_PER_INSERT)) {
          await journalOf(spaceId).updateMany(asFilter<JournalRow>({ _id: { $in: chunk } }), asUpdate<JournalRow>({ $set: { done: true } }));
        }
      } catch (err) {
        markFailed(spaceId, () => log.warn(`Triple index of space '${peerText(spaceId)}': a write's journal rows were not marked done; they are taken as abandoned once old: ${peerText(String(err))}`));
        return;
      }
      wake(spaceId);
    },
  };
}

/** Insert one row per key (done inside a transaction, where the commit shows them with the write) and answer the ticket. */
async function writeRows(spaceId: string, keys: readonly string[], session: SessionArg | undefined, inTransaction: boolean): Promise<Ticket> {
  const at = Date.now();
  const rows: JournalRow[] = keys.map(key => ({ _id: randomUUID(), key, done: inTransaction, at }));
  for (const chunk of inOneCommandChunks(rows, { maxItems: ROWS_PER_INSERT, bytesOf: r => Buffer.byteLength(JSON.stringify(r)) })) {
    await journalOf(spaceId).insertMany(chunk, { ordered: false, ...(session ? { session: session as never } : {}) });
  }
  return { spaceId, rows: inTransaction ? [] : rows.map(r => r._id) };
}

/**
 * A write the journal would have named, made while RDF is off: the index it leaves behind (if any) is marked stale. Answers no ticket.
 * The update is its own existence check (`markTripleIndexStale` matches no row and writes nothing for a space with no index), so one round
 * trip per write is the cheapest answer: a find first would be a second one, and a memory of "no index here" would miss an index a rebuild
 * built after RDF went on and that RDF off again leaves behind.
 */
async function staleWhileOff(spaceId: string): Promise<null> {
  await markTripleIndexStale(spaceId);
  return null;
}

/** A record collection about to be dropped or renamed: its space's index, and a rename target's, need a rebuild. Answers no ticket. */
async function forgetting(spaceId: string, renamedTo: unknown): Promise<null> {
  await markTripleIndexStale(spaceId);
  const target = typeof renamedTo === 'string' ? recordCollectionOf(renamedTo) : null;
  if (target !== null && target.spaceId !== spaceId) await markTripleIndexStale(target.spaceId);
  return null;
}

/** Register the journal at the db door. Called once, with the follower's wake (`follow.ts` `followRecordWrites`). */
export function journalRecordWrites(wake: (spaceId: string) => void): void {
  setRecordWriteJournal(recordWriteJournal(wake));
}

/** Whether `spaceId`'s journal holds any row, done or not: the index is not caught up while it does (the barrier of slice S3). */
export async function hasOutstandingJournalRows(spaceId: string): Promise<boolean> {
  return await journalOf(spaceId).countDocuments(asFilter<JournalRow>({}), { limit: 1 }) > 0;
}

/** Whether a row of `spaceId`'s journal names no record (`*`): its index needs a rebuild. */
export async function journalAsksForRebuild(spaceId: string): Promise<boolean> {
  return await journalOf(spaceId).countDocuments(asFilter<JournalRow>({ key: EVERY_RECORD }), { limit: 1 }) > 0;
}

/**
 * Up to `limit` rows the follower may clear: done, or older than {@link journalRowAbandonedMs}; never `*` (a rebuild clears those). The
 * follower reads these BEFORE it reads the records they name, so what it applies was read after each row's write landed.
 */
export async function clearableJournalRows(spaceId: string, limit: number): Promise<Array<Pick<JournalRow, '_id' | 'key'>>> {
  const abandonedBefore = Date.now() - journalRowAbandonedMs();
  return await journalOf(spaceId).find(asFilter<JournalRow>({ key: { $ne: EVERY_RECORD }, $or: [{ done: true }, { at: { $lt: abandonedBefore } }] }),
    { projection: { _id: 1, key: 1 }, limit }).toArray() as Array<Pick<JournalRow, '_id' | 'key'>>;
}
