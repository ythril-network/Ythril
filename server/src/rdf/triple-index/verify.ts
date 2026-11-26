/**
 * The upkeep of every space's triple index: when an index needs a rebuild, and the drift verify that finds an index which no longer states
 * its records (bundle-273, Q-764 S4; contract rows 3 and 5).
 *
 * ## The question it answers
 *
 * "Does this space's index need rebuilding now?" Asked per space by the housekeeping job `Triple index upkeep` (every
 * {@link UPKEEP_INTERVAL_MS}, through `eachSpace`), whose step is {@link upkeepTripleIndex}. The answer is a reason, or none:
 *
 * - `missing`: the space has RDF on and settled names, and its index has no state row (a new space, a restore that dropped it), or one no
 *   rebuild wrote (`buildId` absent: the follower started it from position 0 and never read a row without a `pos`);
 * - `stale`: the index is marked `stale` (a record collection dropped or renamed, the positions rollback, a form change the follower met);
 * - `journal`: the journal holds a `*` row (a write no record row could name);
 * - `form`: the index was built for another form than the space's now;
 * - `verify`: the drift verify found a record whose statements differ from its record row;
 * - `unused-terms`: the verify's passes over the dictionary found more than {@link UNUSED_TERMS_SHARE} of its terms used by no statement
 *   (the dictionary never frees an id; a rebuild starts a fresh one).
 * A reason starts a rebuild (`rebuild.ts` `requestTripleIndexRebuild`); the reason is logged.
 *
 * ## The drift verify
 *
 * At most every {@link VERIFY_EVERY_MS} per space, and only while the index is ready, of the form now and caught up (no record above
 * `appliedPos`, no journal row): the next {@link VERIFY_SAMPLE_RECORDS} records (a cursor in `rdf_state` `{_id:'verify'}` rolls through
 * the record collections) are recomputed with the record form and compared with their record rows, and the next
 * {@link VERIFY_SAMPLE_TERMS} dictionary terms are looked up in `rdf_quads`. A record written meanwhile (its `pos` above `appliedPos`) is
 * not compared; a mismatch counts only when the barrier still holds after the sample, so a write landing during the verify is not drift.
 * Each mismatch is logged with the records it names.
 */
import { Binary, type Document } from 'mongodb';
import { col, asFilter, asUpdate } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { idKeysetPage } from '../../db/id-keyset-page.js';
import { readStoredById } from '../../db/read-by-id.js';
import { inChunks } from '../../util/chunks.js';
import { log, peerText } from '../../util/log.js';
import { eachSpace } from '../../util/housekeeping-walk.js';
import { declareStep } from '../../util/housekeeping-signals.js';
import { intervalJob } from '../../util/interval-job.js';
import { configuredSpaces } from '../../spaces/space-lookup.js';
import { RDF_KIND_COLLECTIONS } from '../rdf-members.js';
import { storedKeyOf, type TermRow } from './terms.js';
import { formKeyOf, liveCollections, packStatement, readTripleIndexState, recordKeyOf, STATEMENT_BYTES } from './store.js';
import { hasOutstandingJournalRows, journalAsksForRebuild } from './journal.js';
import { formMetaOf, projectionOf, statementsOf } from './follow.js';
import { filterOf, lagOf } from './read.js';
import { requestTripleIndexRebuild, type RebuildResult } from './rebuild.js';

/** The records one verify run recomputes, at most. */
export const VERIFY_SAMPLE_RECORDS = 200;
/** The dictionary terms one verify run looks up, at most. */
export const VERIFY_SAMPLE_TERMS = 200;
/** The share of unused terms over a whole pass of the dictionary above which the index is rebuilt. */
export const UNUSED_TERMS_SHARE = 0.5;
/** How often the upkeep job runs over every space. */
export const UPKEEP_INTERVAL_MS = 60_000;
/** How often one space's index is verified, at most. */
export const VERIFY_EVERY_MS = 10 * 60_000;
/** The longest one verify's barrier read may take. */
const BARRIER_MS = 10_000;
/** Ids per term lookup. */
const IDS_PER_FIND = 1_000;
/** Record keys a verify mismatch line names, at most. */
const KEYS_NAMED = 5;

/** Why an index is rebuilt. */
export type RebuildReason = 'missing' | 'stale' | 'journal' | 'form' | 'verify' | 'unused-terms';

/** Where the verify stands: the record cursor (a kind's place in `RDF_KIND_COLLECTIONS` and the last `_id`) and the dictionary pass. */
interface VerifyRow { _id: 'verify'; kind: number; after?: string; termAfter: number; termsSeen: number; termsUnused: number }

const verifyCollection = (spaceId: string) => col<VerifyRow>(spaceCollection(spaceId, 'rdfState'));

/** The reason `spaceId`'s index needs a rebuild that its state alone gives (all but the verify's), or `null`. */
export async function tripleIndexRebuildReason(spaceId: string): Promise<Exclude<RebuildReason, 'verify' | 'unused-terms'> | null> {
  const meta = formMetaOf(spaceId);
  if (meta === null) return null;
  const state = await readTripleIndexState(spaceId);
  if (state === null || typeof state.buildId !== 'string') return 'missing';
  if (state.status === 'stale') return 'stale';
  if (await journalAsksForRebuild(spaceId)) return 'journal';
  if (state.formKey !== formKeyOf(meta)) return 'form';
  return null;
}

/** What one verify run found: the record keys it compared and those that differ, and the reason it gives (`null`: none). */
export interface VerifyResult { checked: string[]; mismatched: string[]; reason: 'verify' | 'unused-terms' | null }

/** The index is caught up: no visible record above `appliedPos`, no journal row. */
async function caughtUp(spaceId: string, appliedPos: number): Promise<boolean> {
  return await lagOf(spaceId, appliedPos, Date.now() + BARRIER_MS) === 0 && !(await hasOutstandingJournalRows(spaceId));
}

/** One verify run over `spaceId` (see the module docblock). An index that is not ready, of its form and caught up is not verified. */
export async function verifyTripleIndex(spaceId: string): Promise<VerifyResult> {
  const none: VerifyResult = { checked: [], mismatched: [], reason: null };
  const meta = formMetaOf(spaceId);
  const state = await readTripleIndexState(spaceId);
  if (meta === null || state === null || state.status !== 'ready' || state.formKey !== formKeyOf(meta)) return none;
  if (!(await caughtUp(spaceId, state.appliedPos))) return none;
  const row = await verifyCollection(spaceId).findOne(asFilter<VerifyRow>({ _id: 'verify' })) as VerifyRow | null;
  const cursor = { kind: row?.kind ?? 0, after: row?.after };
  const expected = new Map<string, string[]>();
  for (let step = 0; step < RDF_KIND_COLLECTIONS.length && expected.size < VERIFY_SAMPLE_RECORDS; step++) {
    const { kind, collection } = RDF_KIND_COLLECTIONS[cursor.kind % RDF_KIND_COLLECTIONS.length]!;
    const page = await idKeysetPage<{ _id: string } & Record<string, unknown>>({
      collection: spaceCollection(spaceId, collection), filter: {}, projection: projectionOf(kind), size: VERIFY_SAMPLE_RECORDS - expected.size,
    }, cursor.after);
    for (const doc of page.rows) {
      // A record written after the index was caught up is the follower's still: it is not drift.
      if (typeof doc['pos'] === 'number' && doc['pos'] > state.appliedPos) continue;
      expected.set(recordKeyOf(kind, String(doc._id)), [...new Set(statementsOf(meta, kind, doc).map(s => JSON.stringify(s)))]);
    }
    if (page.end || page.last === undefined) { cursor.kind = (cursor.kind + 1) % RDF_KIND_COLLECTIONS.length; cursor.after = undefined; } else cursor.after = page.last;
  }
  let mismatched = await mismatchesOf(spaceId, expected);
  const terms = await sampleTerms(spaceId, row);
  const fields = { kind: cursor.kind, termAfter: terms.termAfter, termsSeen: terms.seen, termsUnused: terms.unused, ...(cursor.after !== undefined ? { after: cursor.after } : {}) };
  await verifyCollection(spaceId).updateOne(asFilter<VerifyRow>({ _id: 'verify' }),
    asUpdate<VerifyRow>({ $set: fields, ...(cursor.after === undefined ? { $unset: { after: '' } } : {}) }), { upsert: true });
  // A write that landed while the sample was read is the follower's, not drift.
  if (mismatched.length > 0 && !(await caughtUp(spaceId, state.appliedPos))) mismatched = [];
  if (mismatched.length > 0) {
    log.warn(`Triple index of space '${peerText(spaceId)}': the drift verify found ${mismatched.length} record(s) whose statements differ from the index `
      + `(${mismatched.slice(0, KEYS_NAMED).map(k => peerText(k)).join(', ')}); it is rebuilt`);
  }
  const reason = mismatched.length > 0 ? 'verify' : terms.overShare ? 'unused-terms' : null;
  return { checked: [...expected.keys()], mismatched, reason };
}

/** The keys of `expected` (record key: its statements, each the JSON of three term keys) whose record row states something else. */
async function mismatchesOf(spaceId: string, expected: ReadonlyMap<string, string[]>): Promise<string[]> {
  if (expected.size === 0) return [];
  const live = liveCollections(spaceId);
  const termKeys = new Set<string>();
  for (const statements of expected.values()) for (const s of statements) for (const k of JSON.parse(s) as string[]) termKeys.add(storedKeyOf(k));
  const ids = new Map<string, number>();
  for (const chunk of inChunks([...termKeys], IDS_PER_FIND)) {
    const rows = await col<TermRow>(live.terms).find(asFilter<TermRow>({ k: { $in: chunk } }), { projection: { _id: 1, k: 1 } }).toArray();
    for (const r of rows) ids.set(r.k, r._id);
  }
  const stored = new Map<string, string>();
  const rows = await readStoredById<{ _id: string; q: Binary }>(live.records, [...expected.keys()], { _id: 1, q: 1 });
  for (const [id, r] of rows) stored.set(id, hexIds(Buffer.from(r.q.buffer)));
  const out: string[] = [];
  for (const [key, statements] of expected) {
    const packed: string[] = [];
    let known = true;
    for (const s of statements) {
      const [a, b, c] = (JSON.parse(s) as string[]).map(k => ids.get(storedKeyOf(k)));
      if (a === undefined || b === undefined || c === undefined) { known = false; break; }
      packed.push(packStatement(a, b, c).toString('hex'));
    }
    const want = known ? [...new Set(packed)].sort().join(',') : null;
    const have = stored.get(key) ?? '';
    if (want !== have) out.push(key);
  }
  return out;
}

/** The statement ids of a record row, sorted, as one text. */
function hexIds(buf: Buffer): string {
  const ids: string[] = [];
  for (let at = 0; at + STATEMENT_BYTES <= buf.length; at += STATEMENT_BYTES) ids.push(buf.subarray(at, at + STATEMENT_BYTES).toString('hex'));
  return ids.sort().join(',');
}

/** The next terms of the dictionary looked up in `rdf_quads`; a pass that ends says whether its unused share is over the line. */
async function sampleTerms(spaceId: string, row: VerifyRow | null): Promise<{ termAfter: number; seen: number; unused: number; overShare: boolean }> {
  const live = liveCollections(spaceId);
  const after = row?.termAfter ?? 0;
  const terms = await col<TermRow>(live.terms).find(asFilter<TermRow>({ _id: { $gt: after } }), { projection: { _id: 1 }, sort: { _id: 1 }, limit: VERIFY_SAMPLE_TERMS }).toArray();
  const ids = terms.map(t => t._id);
  const used = new Set<number>();
  const quads = col<Document>(live.quads);
  // One bounded, indexed look per place a term may stand, as a query looks it up (`read.ts` `filterOf`), stopping at the first hit.
  const wheres = (id: number): Document[] => [filterOf(undefined, id, undefined), filterOf(undefined, undefined, id), filterOf(id, undefined, undefined)];
  for (const id of ids) {
    for (const where of wheres(id)) {
      if (await quads.countDocuments(asFilter<Document>(where), { limit: 1 }) > 0) { used.add(id); break; }
    }
  }
  const seen = (row?.termsSeen ?? 0) + ids.length;
  const unused = (row?.termsUnused ?? 0) + ids.filter(id => !used.has(id)).length;
  if (ids.length < VERIFY_SAMPLE_TERMS) {
    // The pass is over: judge it, and start the next one from the first term.
    return { termAfter: 0, seen: 0, unused: 0, overShare: seen > 0 && unused / seen > UNUSED_TERMS_SHARE };
  }
  return { termAfter: ids[ids.length - 1]!, seen, unused, overShare: false };
}

/** What one upkeep step did: the reason it rebuilt for (`null`: none), and the rebuild's outcome when it started one. */
export interface UpkeepResult { rebuilt: RebuildReason | null; reason: RebuildReason | null; outcome?: RebuildResult['outcome'] }

/** The upkeep of `spaceId`'s index: rebuild it when it needs one; `verify` runs the drift verify when nothing else asks for a rebuild. */
export async function upkeepTripleIndex(spaceId: string, opts: { verify: boolean }): Promise<UpkeepResult> {
  let reason: RebuildReason | null = await tripleIndexRebuildReason(spaceId);
  if (reason === null && opts.verify) reason = (await verifyTripleIndex(spaceId)).reason;
  if (reason === null) return { rebuilt: null, reason: null };
  log.info(`Triple index of space '${peerText(spaceId)}': rebuilt (${reason})`);
  const r = await requestTripleIndexRebuild(spaceId);
  return { rebuilt: r.outcome === 'built' ? reason : null, reason, outcome: r.outcome };
}

const STEP = declareStep('Triple index upkeep');
/** When each space was verified last in this process. */
const verifiedAt = new Map<string, number>();

/** One tick: every configured space's upkeep, its verify when one is due. */
async function upkeepAll(): Promise<void> {
  await eachSpace(STEP, configuredSpaces(), async (s) => {
    const now = Date.now();
    const due = now - (verifiedAt.get(s.id) ?? 0) >= VERIFY_EVERY_MS;
    if (due) verifiedAt.set(s.id, now);
    await upkeepTripleIndex(s.id, { verify: due });
  });
}

const upkeepJob = intervalJob('Triple index upkeep', UPKEEP_INTERVAL_MS, () => upkeepAll());

/** Start the upkeep job (`bootstrap.ts`). */
export function startTripleIndexUpkeep(): void {
  if (upkeepJob.armed) return;
  upkeepJob.start();
}

/** Stop it (`shutdown.ts`). */
export function stopTripleIndexUpkeep(): void {
  upkeepJob.stop();
}
