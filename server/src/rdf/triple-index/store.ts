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
 * - `<space>_rdf_state`: `{ _id: 'state', appliedPos, formKey, status }` and the follower's lease `{ _id: 'lease', owner, until }`.
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
import { col, asFilter, asUpdate, asBulk } from '../../db/mongo.js';
import { spaceCollection, parseSpaceCollection, SPACE_COLLECTIONS, type SpacePart } from '../../db/space-collection.js';
import { inBoundedTransaction } from '../../db/bounded-transaction.js';
import { inChunks } from '../../util/chunks.js';
import { inOneCommandChunks, operationBytes } from '../../db/one-command.js';
import { readStoredById } from '../../db/read-by-id.js';
import { buildSpaceIndex, TRIPLE_INDEX_INDEXES } from '../../spaces/space-indexes.js';
import type { RdfRecordKind } from '../record-triples.js';
import { termIds, MAX_TERM_ID } from './terms.js';

/** The space collections the index is: a backup leaves them out, since they are derived from the records and a restore drops them. */
export const TRIPLE_INDEX_PARTS: readonly SpacePart[] = Object.freeze(['rdfTerms', 'rdfQuads', 'rdfRecords', 'rdfState', 'rdfDirty'] satisfies SpacePart[]);
const TRIPLE_INDEX_SUFFIXES: ReadonlySet<string> = new Set(TRIPLE_INDEX_PARTS.map(p => SPACE_COLLECTIONS[p]));

/** Whether `name` is a collection of some space's triple index. */
export function isTripleIndexCollection(name: string): boolean {
  const parsed = parseSpaceCollection(name);
  return parsed !== null && TRIPLE_INDEX_SUFFIXES.has(parsed.suffix);
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

export interface TripleIndexState { _id: 'state'; appliedPos: number; formKey: string; status: TripleIndexStatus }
interface LeaseRow { _id: 'lease'; owner: string; until: number }
interface QuadRow { _id: Binary; s: number; p: number; o: number; nK: number; nF: number }
interface RecordRow { _id: string; pos: number; q: Binary }

const stateCollection = (spaceId: string) => col<TripleIndexState>(spaceCollection(spaceId, 'rdfState'));
/** The same collection, read for its lease row. */
const leaseCollection = (spaceId: string) => col<LeaseRow>(spaceCollection(spaceId, 'rdfState'));
const quadCollection = (spaceId: string) => col<QuadRow>(spaceCollection(spaceId, 'rdfQuads'));
const recordCollection = (spaceId: string) => col<RecordRow>(spaceCollection(spaceId, 'rdfRecords'));
/** The write journal (`journal.ts`): the apply clears the rows it was handed, in its own transaction. */
const journalCollection = (spaceId: string) => col<{ _id: string }>(spaceCollection(spaceId, 'rdfDirty'));

/**
 * Mark `spaceId`'s index `stale` (a rebuild, slice S4, makes it ready again), when it has a state row: for a change no record row can name
 * (a journal row `*`, a record collection dropped or renamed, a writer around the db door). Never creates a state row: a space whose index
 * has none is not ready already, and a row written under a name a rename is about to move into would stop the rename.
 */
export async function markTripleIndexStale(spaceId: string): Promise<void> {
  await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state' }), asUpdate<TripleIndexState>({ $set: { status: 'stale' } }));
}

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

/**
 * Start `spaceId`'s index for the form `formKey`: build its indexes and write its state row (`catching-up`, nothing applied). A state row
 * another follower wrote meanwhile is kept. Answers the state row stored.
 */
export async function startTripleIndex(spaceId: string, formKey: string): Promise<TripleIndexState> {
  for (const ix of TRIPLE_INDEX_INDEXES) await buildSpaceIndex(spaceId, ix);
  await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state' }),
    asUpdate<TripleIndexState>({ $setOnInsert: { appliedPos: 0, formKey, status: 'catching-up' } }), { upsert: true });
  const state = await readTripleIndexState(spaceId);
  if (state === null) throw new Error(`the triple index of space '${spaceId}' has no state row after it was started`);
  return state;
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
export type BatchOutcome = 'applied' | 'stale' | 'lease-lost' | 'not-started';

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
  return inBoundedTransaction(async (session) => {
    const lease = await leaseCollection(spaceId).findOne(asFilter<LeaseRow>({ _id: 'lease' }), { session }) as LeaseRow | null;
    if (lease?.owner !== batch.owner) return 'lease-lost';
    // R3, one statement: a state built for another form is marked stale here, whatever it said, so no read stands between the check and the mark.
    const staled = await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state', formKey: { $ne: batch.formKey } }),
      asUpdate<TripleIndexState>({ $set: { status: 'stale' } }), { session });
    if (staled.matchedCount === 1) return 'stale';
    // The state moves first, on the condition that it is this form's and not stale; the statements follow in the same transaction, so either
    // both land or neither does, and no read of the state stands before a write of it. `$max`: appliedPos never moves back.
    const moved = await stateCollection(spaceId).updateOne(asFilter<TripleIndexState>({ _id: 'state', formKey: batch.formKey, status: { $ne: 'stale' } }),
      asUpdate<TripleIndexState>({ $max: { appliedPos: batch.appliedPos }, ...(batch.status !== undefined ? { $set: { status: batch.status } } : {}) }), { session });
    if (moved.matchedCount === 0) {
      return await stateCollection(spaceId).countDocuments(asFilter<TripleIndexState>({ _id: 'state' }), { session, limit: 1 }) === 0 ? 'not-started' : 'stale';
    }
    await applyChanges(spaceId, batch.changes, session);
    for (const chunk of inChunks([...batch.clearJournal ?? []], ROWS_PER_COMMAND)) {
      await journalCollection(spaceId).deleteMany(asFilter<{ _id: string }>({ _id: { $in: chunk } }), { session });
    }
    return 'applied';
  });
}

/** The diff of every change against its stored row, applied in `session`. */
async function applyChanges(spaceId: string, changes: readonly RecordChange[], session: ClientSession): Promise<void> {
  if (changes.length === 0) return;
  const keys = changes.map(c => recordKeyOf(c.kind, c.id));
  const stored = await readStoredById(spaceCollection(spaceId, 'rdfRecords'), keys, 'all', { session }) as unknown as Map<string, RecordRow>;
  const ids = await termIds(spaceId, changes.flatMap(c => c.statements.flat()), session);
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
