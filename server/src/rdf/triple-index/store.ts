/**
 * The stored triple index of one space: its statements with their counts, each record's statements, and its state (bundle-273, Q-764 S1;
 * owner D-90: a Mongo collection per space).
 *
 * ## The question it answers
 *
 * "Apply these records' current statements to the index, in one transaction, or tell me why not." The follower (`follow.ts`) reads the
 * records and computes their forms; this module owns the stored shape and the one write that changes it, so the diff, the counts and the
 * record rows can never be written apart.
 *
 * ## The stored shape (`SPACE_COLLECTIONS` suffixes, so a space delete and rename carry them by prefix)
 *
 * - `<space>_rdf_terms`: the dictionary (`terms.ts`).
 * - `<space>_rdf_quads`: `{ _id: Binary(s,p,o as three big-endian uint32), s, p, o, nK, nF }`, indexed `{p,o,s}` and `{o,s,p}` (the `_id`
 *   is the `{s,p,o}` order). `nK` counts the knowledge and link records that state it, `nF` the file records, so a reader without the files
 *   right reads `nK > 0` alone. A row whose two counts reach 0 is deleted in the same transaction.
 * - `<space>_rdf_records`: `{ _id: '<kind>:<id>', pos, q: Binary(the record's statement ids, sorted, 12 bytes each) }`. A record with no
 *   statements has no row.
 * - `<space>_rdf_state`: `{ _id: 'state', appliedPos, formKey, status, buildId, writes }` and the follower's lease `{ _id: 'lease', owner, until }`.
 *   `writes` counts the index's changes (bundle-378, Q-976 S2): raised by 1 in every apply transaction, every rebuild swap and status write,
 *   and every stale mark, in the same write as the change it counts. While it reads the same, the index answers every count as it did
 *   (`read.ts` keeps the planner's counts under it).
 * - `<space>_rdf_dirty`: the write journal (`journal.ts`); a batch deletes the rows it answers (`clearJournal`) in its transaction.
 *
 * A missing state row is an index that is not ready (a new space, a restore that dropped it, a delete and re-create).
 *
 * ## What it prevents
 *
 * - **A count applied twice.** The apply diffs the record's new statements against its stored row and moves the counts by the difference,
 *   so applying a record again changes nothing (the follower re-applies every record above `appliedPos`, design-r2 R1).
 * - **Two forms in one index (R3).** The batch's form key is compared with the stored one inside the transaction: a mismatch marks the index
 *   `stale` and applies nothing.
 * - **A batch written by a follower that lost its lease.** The lease is read inside the transaction; another owner's lease aborts the batch.
 */
import { Binary, type ClientSession } from 'mongodb';
import type { SpaceMeta } from '@ythril-network/schema';
import { canonicalJsonHash } from '../../util/canonical-json.js';
import { col, getDb, asFilter, asUpdate, asBulk } from '../../db/mongo.js';
import { spaceCollection, parseSpaceCollection, SPACE_COLLECTIONS, type SpacePart } from '../../db/space-collection.js';
import { inBoundedTransaction } from '../../db/bounded-transaction.js';
import { inChunks } from '../../util/chunks.js';
import { inOneCommandChunks, operationBytes } from '../../db/one-command.js';
import { readStoredById } from '../../db/read-by-id.js';
import type { RdfRecordKind } from '../record-triples.js';
import { termIds, MAX_TERM_ID } from './terms.js';

/** The space collections the index is: a backup leaves them out, since they are derived from the records and a restore drops them. */
export const TRIPLE_INDEX_PARTS: readonly SpacePart[] = Object.freeze(['rdfTerms', 'rdfQuads', 'rdfRecords', 'rdfState', 'rdfDirty'] satisfies SpacePart[]);
const TRIPLE_INDEX_SUFFIXES: ReadonlySet<string> = new Set(TRIPLE_INDEX_PARTS.map(p => SPACE_COLLECTIONS[p]));

/** Whether `name` is a collection of some space's triple index: a live one, or one a rebuild writes before its swap. */
export function isTripleIndexCollection(name: string): boolean {
  const parsed = parseSpaceCollection(name);
  if (parsed !== null) return TRIPLE_INDEX_SUFFIXES.has(parsed.suffix);
  const cut = name.indexOf('_');
  return cut > 0 && BUILD_COLLECTION.test(name.slice(cut + 1)) && spaceCollectionNameable(name.slice(0, cut));
}

/** A space id `spaceCollection` accepts (the one rule of what may name a collection). */
function spaceCollectionNameable(spaceId: string): boolean {
  try { spaceCollection(spaceId, 'rdfState'); return true; } catch { return false; }
}

/** The three collections one build of the index writes: the live ones, or a rebuild's own (named by its build id) before its swap. */
export interface IndexCollections { terms: string; quads: string; records: string }

/** The live collections of `spaceId`'s index: what the follower writes and a query reads. */
export const liveCollections = (spaceId: string): IndexCollections => ({
  terms: spaceCollection(spaceId, 'rdfTerms'), quads: spaceCollection(spaceId, 'rdfQuads'), records: spaceCollection(spaceId, 'rdfRecords'),
});

/** A build id: 16 hex characters, so the collections it names stay short and match {@link BUILD_COLLECTION}. */
const BUILD_ID = /^[0-9a-f]{16}$/;
/** The suffix of a rebuild's own collection: `rdf_b<build id>_<part>`. */
const BUILD_COLLECTION = /^rdf_b[0-9a-f]{16}_(terms|quads|records)$/;

/** The collections a rebuild of `spaceId` with `buildId` writes before its swap (design-r2 R5); a build id of another shape throws. */
export function buildCollectionsOf(spaceId: string, buildId: string): IndexCollections {
  if (!BUILD_ID.test(buildId)) throw new Error('a triple index build id is 16 hex characters');
  const at = (part: string): string => `${spaceCollection(spaceId, 'rdfState').slice(0, -SPACE_COLLECTIONS.rdfState.length)}rdf_b${buildId}_${part}`;
  return { terms: at('terms'), quads: at('quads'), records: at('records') };
}

/** The bytes of one statement id: three big-endian uint32 term ids. */
export const STATEMENT_BYTES = 12;
/** The bytes of one term id inside a statement id, and where the predicate's and the object's ids start (the subject's at 0). */
const TERM_ID_BYTES = 4;
const PREDICATE_AT = TERM_ID_BYTES;
const OBJECT_AT = PREDICATE_AT + TERM_ID_BYTES;
/** The most rows one bulk command sends. */
const ROWS_PER_COMMAND = 1_000;

/**
 * The version of the record form the index is built for: raised when `recordTriples` or the term key changes what it writes, so every
 * index built before reads as another form (`stale`) and is rebuilt.
 */
export const RDF_FORM_VERSION = 1;

/**
 * The key of the form `meta` gives: equal metas, equal keys. It lives here, beside the state that stores it, so the follower that writes
 * it and the reader that compares it both import it from the store and never from each other.
 */
export function formKeyOf(meta: SpaceMeta): string {
  return canonicalJsonHash({ formVersion: RDF_FORM_VERSION, meta });
}

/** How far the index is: being filled (`catching-up`), caught up (`ready`), or built for a form the space no longer has (`stale`). */
export type TripleIndexStatus = 'catching-up' | 'ready' | 'stale';

/**
 * `buildId`: the rebuild the live collections came from (`rebuild.ts`); absent on an index the follower started and nobody built whole.
 * `writes`: the count of the index's changes (the module docblock); absent on a row written before bundle-378, read as 0.
 */
export interface TripleIndexState { _id: 'state'; appliedPos: number; formKey: string; status: TripleIndexStatus; buildId?: string; writes?: number }

/** The update part that raises the write counter: one spelling, beside every write of the state row that changes the index. */
const RAISE_WRITES = Object.freeze({ $inc: Object.freeze({ writes: 1 }) });
interface LeaseRow { _id: 'lease'; owner: string; until: number }
/**
 * The rebuild's fence (design-r2 R5): the build that may write, until when. Every batch of a build writes this row in its transaction on the
 * condition that it is still its build's and not run out (`fenceTripleIndexBuild`), as `files/media/lease.ts` `writeUnderClaim` fences a
 * job. The follower's journal batch writes it too (`journalClears`), so a clear and a build's start never pass each other unseen.
 */
interface BuildRow { _id: 'build'; buildId?: string; until?: number; startedAt?: number; fencedWrites?: number; journalClears?: number }
interface QuadRow { _id: Binary; s: number; p: number; o: number; nK: number; nF: number }
interface RecordRow { _id: string; pos: number; q: Binary }

const stateCollection = (spaceId: string) => col<TripleIndexState>(spaceCollection(spaceId, 'rdfState'));
/** The same collection, read for its lease row. */
const leaseCollection = (spaceId: string) => col<LeaseRow>(spaceCollection(spaceId, 'rdfState'));
/** The same collection, read for its build row. */
const buildCollection = (spaceId: string) => col<BuildRow>(spaceCollection(spaceId, 'rdfState'));

/** A build that lost its row (another build took it, or its lease ran out): nothing it writes may land. */
export class RebuildFenced extends Error {
  constructor(spaceId: string, buildId: string) {
    super(`the triple index build ${buildId} of space '${spaceId}' no longer holds its build row: its lease ran out or another build took it`);
    this.name = 'RebuildFenced';
  }
}

/**
 * Take the build row of `spaceId` for `buildId` for `ms`: false when another build holds one that has not run out. A row without a lease
 * (written by the follower's journal batch) is free.
 */
export async function claimTripleIndexBuild(spaceId: string, buildId: string, ms: number): Promise<boolean> {
  const now = Date.now();
  const set = { buildId, until: now + ms, startedAt: now };
  const r = await buildCollection(spaceId).updateOne(
    asFilter<BuildRow>({ _id: 'build', $or: [{ until: { $lt: now } }, { until: { $exists: false } }] }), asUpdate<BuildRow>({ $set: set }));
  if (r.matchedCount === 1) return true;
  const inserted = await buildCollection(spaceId).updateOne(asFilter<BuildRow>({ _id: 'build' }), asUpdate<BuildRow>({ $setOnInsert: set }), { upsert: true });
  return inserted.upsertedCount === 1;
}

/**
 * The fence: in `session`, renew `buildId`'s lease on the build row for `ms`, on the condition that the row is still its build's and has not
 * run out; throws {@link RebuildFenced} otherwise, so the transaction it sits in writes nothing.
 */
export async function fenceTripleIndexBuild(spaceId: string, buildId: string, ms: number, session?: ClientSession): Promise<void> {
  const now = Date.now();
  const held = await buildCollection(spaceId).updateOne(asFilter<BuildRow>({ _id: 'build', buildId, until: { $gt: now } }),
    asUpdate<BuildRow>({ $set: { until: now + ms }, $inc: { fencedWrites: 1 } }), session ? { session } : {});
  if (held.matchedCount === 0) throw new RebuildFenced(spaceId, buildId);
}

/** Give the build row back, if `buildId` still holds it. */
export async function releaseTripleIndexBuild(spaceId: string, buildId: string): Promise<void> {
  await buildCollection(spaceId).updateOne(asFilter<BuildRow>({ _id: 'build', buildId }), asUpdate<BuildRow>({ $set: { until: 0 } }));
}

/** The build that holds `spaceId`'s build row now, or `null` when none does. */
export async function runningTripleIndexBuild(spaceId: string): Promise<{ buildId: string; startedAt: number } | null> {
  const row = await buildCollection(spaceId).findOne(asFilter<BuildRow>({ _id: 'build' })) as BuildRow | null;
  return row?.buildId && typeof row.until === 'number' && row.until > Date.now() ? { buildId: row.buildId, startedAt: row.startedAt ?? 0 } : null;
}

/**
 * The swap's state write, in `session` (fenced by the caller): the index is `buildId`'s, of `formKey`, applied up to `appliedPos`, with
 * `status`. Replaces whatever state the index had.
 */
export async function writeBuiltState(spaceId: string, state: Omit<TripleIndexState, '_id' | 'writes'>, session: ClientSession): Promise<void> {
  // Every field of the row is set (a row holds no other), but the write counter carries on, raised by one: a swap is a change of the index,
  // and a counter that went back could read as an earlier index again (`read.ts` keeps counts under it).
  const { buildId, ...rest } = state;
  await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state' }),
    asUpdate<TripleIndexState>({ $set: buildId === undefined ? rest : { ...rest, buildId }, ...RAISE_WRITES, ...(buildId === undefined ? { $unset: { buildId: '' } } : {}) }),
    { upsert: true, session });
  // The verify's cursors (`verify.ts`) count the old dictionary's ids and the old record rows: the new index starts them from the first
  // (finding F10). Here, so no swap can state a new index and keep the old cursors.
  await col<{ _id: string }>(spaceCollection(spaceId, 'rdfState')).deleteOne(asFilter<{ _id: string }>({ _id: 'verify' }), { session });
}

/**
 * Drop every build collection of `spaceId` that is not `keepBuildId`'s: what a build that ended without dropping its own (its process was
 * killed in the fill, or the space was renamed under it) left behind. Only a build that holds the build row may call it: no other build of
 * the space writes then, so every other build collection is an orphan (review point U3). A collection that cannot be dropped is left for
 * the next build; answers the names dropped.
 */
export async function dropOrphanBuildCollections(spaceId: string, keepBuildId: string): Promise<string[]> {
  const own = new Set(Object.values(buildCollectionsOf(spaceId, keepBuildId)));
  // `<space>_`: a space id has no `_`, so the prefix names this space's collections alone.
  const prefix = spaceCollection(spaceId, 'rdfState').slice(0, -SPACE_COLLECTIONS.rdfState.length);
  const names = (await getDb().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name)
    .filter(n => n.startsWith(prefix) && BUILD_COLLECTION.test(n.slice(prefix.length)) && !own.has(n));
  const dropped: string[] = [];
  for (const name of names) {
    try { await getDb().dropCollection(name); dropped.push(name); } catch { /* left for the next build */ }
  }
  return dropped;
}

/** Set the status of `buildId`'s index, in `session`, when the index is still that build's. */
export async function setBuiltStatus(spaceId: string, buildId: string, status: TripleIndexStatus, session: ClientSession): Promise<void> {
  await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state', buildId }), asUpdate<TripleIndexState>({ $set: { status }, ...RAISE_WRITES }), { session });
}
/** The write journal (`journal.ts`): the apply clears the rows it was handed, in its own transaction. */
const journalCollection = (spaceId: string) => col<{ _id: string }>(spaceCollection(spaceId, 'rdfDirty'));

export { markTripleIndexStale } from './stale-mark.js';

/** The `_id` of a record's row: its kind and id. */
export const recordKeyOf = (kind: RdfRecordKind, id: string): string => `${kind}:${id}`;

/** One statement as the three keys of its terms (`terms.ts` `termKey`). */
export type StatementKeys = readonly [string, string, string];

/** A record's statements now: none for a record that is gone or has no form. */
export interface RecordChange { kind: RdfRecordKind; id: string; pos: number; statements: readonly StatementKeys[] }

/** The state row of `spaceId`'s index, or `null` when it has none (not ready). */
export async function readTripleIndexState(spaceId: string): Promise<TripleIndexState | null> {
  return await stateCollection(spaceId).findOne(asFilter<TripleIndexState>({ _id: 'state' })) as TripleIndexState | null;
}

/** Take or renew the follower's lease on `spaceId` for `ms`: false when another owner holds one that has not run out. */
export async function takeTripleIndexLease(spaceId: string, owner: string, ms: number): Promise<boolean> {
  const now = Date.now();
  const r = await leaseCollection(spaceId).updateOne(
    asFilter<LeaseRow>({ _id: 'lease', $or: [{ owner }, { until: { $lt: now } }] }),
    asUpdate<LeaseRow>({ $set: { owner, until: now + ms } }),
    { upsert: false },
  );
  if (r.matchedCount === 1) return true;
  // No lease row yet: the first follower writes it. Another that wrote it first meanwhile wins, and this one reads as not holding it.
  const inserted = await leaseCollection(spaceId).updateOne(asFilter<LeaseRow>({ _id: 'lease' }),
    asUpdate<LeaseRow>({ $setOnInsert: { owner, until: now + ms } }), { upsert: true });
  return inserted.upsertedCount === 1;
}

/** Give the lease back, if `owner` still holds it. */
export async function releaseTripleIndexLease(spaceId: string, owner: string): Promise<void> {
  await leaseCollection(spaceId).updateOne(asFilter<LeaseRow>({ _id: 'lease', owner }), asUpdate<LeaseRow>({ $set: { until: 0 } }));
}

/** A statement id: the three term ids, big-endian. */
export function packStatement(s: number, p: number, o: number): Buffer {
  const buf = Buffer.alloc(STATEMENT_BYTES);
  buf.writeUInt32BE(s, 0);
  buf.writeUInt32BE(p, PREDICATE_AT);
  buf.writeUInt32BE(o, OBJECT_AT);
  return buf;
}

/** The statement ids packed in a record row, as hex strings. */
function statementIdsOf(row: RecordRow | undefined): string[] {
  if (row === undefined) return [];
  const buf = Buffer.from(row.q.buffer);
  const ids: string[] = [];
  for (let at = 0; at + STATEMENT_BYTES <= buf.length; at += STATEMENT_BYTES) ids.push(buf.subarray(at, at + STATEMENT_BYTES).toString('hex'));
  return ids;
}

/** What one batch did: applied, found the index built for another form (now `stale`), or met a follower that holds the lease. */
export type BatchOutcome = 'applied' | 'stale' | 'lease-lost' | 'not-started' | 'building';

export interface TripleIndexBatch {
  /** The form the batch's statements were computed with (`formKeyOf` of the meta snapshot). */
  formKey: string;
  /** The follower's lease owner. */
  owner: string;
  changes: readonly RecordChange[];
  /** Where `appliedPos` moves to (never backwards), and the status after the batch (left as it is when omitted: a journal batch). */
  appliedPos: number;
  status?: Exclude<TripleIndexStatus, 'stale'>;
  /** The journal rows this batch answers (`journal.ts`), deleted in its transaction: a row goes only with the statements read after it. */
  clearJournal?: readonly string[];
}

/**
 * Apply `batch` to `spaceId`'s index in one bounded transaction: each record's statements diffed against its row, the counts moved by the
 * difference, rows at zero deleted, new terms added, the record rows and the state written. Nothing is written when the stored form is not
 * the batch's (the index is marked `stale` instead), when another follower holds the lease, or when the index has no state row.
 */
export async function applyTripleIndexBatch(spaceId: string, batch: TripleIndexBatch): Promise<BatchOutcome> {
  try {
    return await applyInTransaction(spaceId, batch);
  } catch (err) {
    if (err instanceof BuildRunning) return 'building';
    throw err;
  }
}

async function applyInTransaction(spaceId: string, batch: TripleIndexBatch): Promise<BatchOutcome> {
  return inBoundedTransaction(async (session) => {
    const lease = await leaseCollection(spaceId).findOne(asFilter<LeaseRow>({ _id: 'lease' }), { session }) as LeaseRow | null;
    if (lease?.owner !== batch.owner) return 'lease-lost';
    // R3, one statement: a state built for another form is marked stale here, whatever it said, so no read stands between the check and the mark.
    const staled = await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state', formKey: { $ne: batch.formKey } }),
      asUpdate<TripleIndexState>({ $set: { status: 'stale' }, ...RAISE_WRITES }), { session });
    if (staled.matchedCount === 1) return 'stale';
    // The state moves first, on the condition that it is this form's and not stale; the statements follow in the same transaction, so either
    // both land or neither does, and no read of the state stands before a write of it. `$max`: appliedPos never moves back.
    const moved = await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state', formKey: batch.formKey, status: { $ne: 'stale' } }),
      asUpdate<TripleIndexState>({ $max: { appliedPos: batch.appliedPos }, ...RAISE_WRITES, ...(batch.status !== undefined ? { $set: { status: batch.status } } : {}) }), { session });
    if (moved.matchedCount === 0) {
      return await stateCollection(spaceId).countDocuments(asFilter<TripleIndexState>({ _id: 'state' }), { session, limit: 1 }) === 0 ? 'not-started' : 'stale';
    }
    // A journal row is cleared only while no rebuild runs: a build swaps in what it read, and a row cleared after it read that record would
    // take the record's change with it. The build row is written here, so a build that starts meanwhile conflicts with this transaction.
    if ((batch.clearJournal?.length ?? 0) > 0) {
      const build = await buildCollection(spaceId).findOneAndUpdate(asFilter<BuildRow>({ _id: 'build' }), asUpdate<BuildRow>({ $inc: { journalClears: 1 } }),
        { upsert: true, returnDocument: 'after', session });
      if (typeof build?.until === 'number' && build.until > Date.now()) throw new BuildRunning();
    }
    await applyRecordChanges(spaceId, batch.changes, session);
    for (const chunk of inChunks([...batch.clearJournal ?? []], ROWS_PER_COMMAND)) {
      await journalCollection(spaceId).deleteMany(asFilter<{ _id: string }>({ _id: { $in: chunk } }), { session });
    }
    return 'applied';
  });
}

/** A journal batch met a running rebuild: its transaction is aborted and the batch answers `building`. */
class BuildRunning extends Error {
  constructor() { super('a rebuild of the triple index runs: the journal is cleared after its swap'); this.name = 'BuildRunning'; }
}

/**
 * The diff of every change against its stored row in `target` (the live collections, or a rebuild's own), applied in `session`: the one
 * write of statements, counts and record rows, which the follower and a rebuild both go through.
 */
export async function applyRecordChanges(spaceId: string, changes: readonly RecordChange[], session: ClientSession,
  target: IndexCollections = liveCollections(spaceId)): Promise<void> {
  if (changes.length === 0) return;
  const keys = changes.map(c => recordKeyOf(c.kind, c.id));
  const stored = await readStoredById(target.records, keys, 'all', { session }) as unknown as Map<string, RecordRow>;
  const ids = await termIds(spaceId, changes.flatMap(c => c.statements.flat()), session, target.terms);
  const quadCollection = (_space: string) => col<QuadRow>(target.quads);
  const recordCollection = (_space: string) => col<RecordRow>(target.records);
  const idOf = (key: string): number => {
    const id = ids.get(key);
    if (id === undefined || id > MAX_TERM_ID) throw new Error(`the triple index of space '${spaceId}' has no term id for a key it was given`);
    return id;
  };
  // Per statement (hex of its id): how far each count moves, and its three ids for a row that is new.
  const deltas = new Map<string, { s: number; p: number; o: number; dK: number; dF: number }>();
  const move = (hex: string, file: boolean, by: number): void => {
    const buf = Buffer.from(hex, 'hex');
    const d = deltas.get(hex) ?? { s: buf.readUInt32BE(0), p: buf.readUInt32BE(PREDICATE_AT), o: buf.readUInt32BE(OBJECT_AT), dK: 0, dF: 0 };
    if (file) d.dF += by; else d.dK += by;
    deltas.set(hex, d);
  };
  const rowWrites: unknown[] = [];
  for (const change of changes) {
    const key = recordKeyOf(change.kind, change.id);
    const file = change.kind === 'file';
    const now = [...new Set(change.statements.map(([s, p, o]) => packStatement(idOf(s), idOf(p), idOf(o)).toString('hex')))].sort();
    const before = new Set(statementIdsOf(stored.get(key)));
    const after = new Set(now);
    for (const hex of before) if (!after.has(hex)) move(hex, file, -1);
    for (const hex of after) if (!before.has(hex)) move(hex, file, +1);
    if (now.length === 0) {
      if (stored.has(key)) rowWrites.push({ deleteOne: { filter: { _id: key } } });
      continue;
    }
    rowWrites.push({ replaceOne: { filter: { _id: key }, replacement: { _id: key, pos: change.pos, q: new Binary(Buffer.from(now.join(''), 'hex')) }, upsert: true } });
  }
  const quadWrites: unknown[] = [];
  const lowered: Binary[] = [];
  for (const [hex, d] of deltas) {
    if (d.dK === 0 && d.dF === 0) continue;
    const _id = new Binary(Buffer.from(hex, 'hex'));
    if (d.dK < 0 || d.dF < 0) lowered.push(_id);
    quadWrites.push({ updateOne: { filter: { _id }, update: { $inc: { nK: d.dK, nF: d.dF }, $setOnInsert: { s: d.s, p: d.p, o: d.o } }, upsert: true } });
  }
  for (const chunk of inOneCommandChunks(quadWrites, { maxItems: ROWS_PER_COMMAND, bytesOf: operationBytes })) await quadCollection(spaceId).bulkWrite(asBulk<QuadRow>(chunk), { session, ordered: true });
  for (const chunk of inChunks(lowered, ROWS_PER_COMMAND)) {
    await quadCollection(spaceId).deleteMany(asFilter<QuadRow>({ _id: { $in: chunk }, nK: { $lte: 0 }, nF: { $lte: 0 } }), { session });
  }
  for (const chunk of inOneCommandChunks(rowWrites, { maxItems: ROWS_PER_COMMAND, bytesOf: operationBytes })) await recordCollection(spaceId).bulkWrite(asBulk<RecordRow>(chunk), { session, ordered: true });
}
