/**
 * The upkeep of every space's triple index: when an index needs a rebuild, and the drift verify that finds an index which no longer states
 * its records (bundle-273, Q-764 S4; contract rows 3 and 5).
 *
 * ## The question it answers
 *
 * "Does this space's index need rebuilding now?" Asked per space by the housekeeping job `Triple index upkeep` (every
 * {@link UPKEEP_INTERVAL_MS}, through `eachSpace`), whose step is {@link upkeepTripleIndex}. The answer is a reason, or none:
 *
 * - `missing`: the space has RDF on and settled names, and its index has no state row (a new space, an upgrade, a restore that dropped it), or
 *   one no rebuild wrote (`buildId` absent: a build of the index that a follower started from position 0, which never reads a row without a
 *   `pos`; the follower no longer starts one, so only that older state has it);
 * - `stale`: the index is marked `stale` (a record collection dropped or renamed, the positions rollback, a form change the follower met);
 * - `journal`: the journal holds a `*` row (a write no record row could name);
 * - `form`: the index was built for another form than the space's now;
 * - `verify`: the drift verify found a record whose statements differ from its record row;
 * - `unused-terms`: the verify's passes over the dictionary found more than {@link UNUSED_TERMS_SHARE} of its terms used by no statement
 *   (the dictionary never frees an id; a rebuild starts a fresh one).
 * A reason starts a rebuild (`rebuild.ts` `launchTripleIndexRebuild`), at most one per tick and none while one runs in this process
 * ({@link upkeepTripleIndexes}, finding F5), none while a space act holds the space (an RDF import holds it for its whole length; that the
 * rebuild waits is said once per hold); the reason is logged, and an outcome other than built too. A space whose rebuilds keep failing is retried after longer waits
 * (`rebuild-backoff.ts`).
 *
 * ## The drift verify
 *
 * At most every {@link VERIFY_EVERY_MS} per space, and only while the index is ready, of the form now and caught up (no record above
 * `appliedPos`, no journal row): the next {@link VERIFY_SAMPLE_RECORDS} records (a cursor in `rdf_state` `{_id:'verify'}` rolls through
 * the record collections) are recomputed with the record form and compared with their record rows, and the next
 * {@link VERIFY_SAMPLE_TERMS} dictionary terms are looked up in `rdf_quads`. The other way too (finding F9): the next
 * {@link VERIFY_SAMPLE_RECORDS} record rows (a second cursor, `rowAfter`) are checked against the stored records, and a row whose record is
 * gone is named. A record written meanwhile (its `pos` above `appliedPos`) is not compared; a mismatch counts only when the barrier still
 * holds after the sample, so a write landing during the verify is not drift, and none counts when the index state (status, build, form) is
 * not the one the verify started from at its end (another instance's swap, review point U4). Each mismatch is logged with the records it names.
 */
import { Binary, type Document } from 'mongodb';
import { col, asFilter, asUpdate } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { idKeysetPage } from '../../db/id-keyset-page.js';
import { readStoredById } from '../../db/read-by-id.js';
import { log, peerText } from '../../util/log.js';
import { eachSpace } from '../../util/housekeeping-walk.js';
import { declareStep } from '../../util/housekeeping-signals.js';
import { intervalJob } from '../../util/interval-job.js';
import { configuredSpaces } from '../../spaces/space-lookup.js';
import { RDF_KIND_COLLECTIONS, rdfKindCollection } from '../rdf-members.js';
import type { RdfRecordKind } from '../record-triples.js';
import { idsOfStoredKeys, storedKeyOf, type TermRow } from './terms.js';
import { formKeyOf, liveCollections, packStatement, readTripleIndexState, recordKeyOf, STATEMENT_BYTES } from './store.js';
import { hasOutstandingJournalRows, journalAsksForRebuild } from './journal.js';
import { formMetaOf, projectionOf, statementsOf } from './follow.js';
import { filterOf, lagOf } from './read.js';
import { anyRebuildRunsHere, launchTripleIndexRebuild, requestTripleIndexRebuild, type RebuildReason, type RebuildResult } from './rebuild.js';
import { rebuildBackoff } from './rebuild-backoff.js';
import { spaceWriteRefusal } from '../../spaces/space-write-gate.js';
import { warnOnce } from '../../util/warn-once.js';

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
/** Record keys a verify mismatch line names, at most. */
const KEYS_NAMED = 5;

export type { RebuildReason };

/**
 * Where the verify stands: the record cursor (a kind's place in `RDF_KIND_COLLECTIONS` and the last `_id`), the cursor over the record rows
 * (`rowAfter`: the last row key) and the dictionary pass. A swap deletes the row (`store.ts` `writeBuiltState`): the cursors belong to the index.
 */
interface VerifyRow { _id: 'verify'; kind: number; after?: string; rowAfter?: string; termAfter: number; termsSeen: number; termsUnused: number }

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
  // Both directions (finding F9): each sampled record against its row above, and each sampled row against its record here.
  const rows = await sampleRecordRows(spaceId, row?.rowAfter);
  let mismatched = [...await mismatchesOf(spaceId, expected), ...await rowsWithoutRecords(spaceId, rows.keys)];
  const terms = await sampleTerms(spaceId, row);
  // The index is the one the verify started from (review point U4): another instance's swap renames a build onto the collections this
  // sample read, and what it read of them then is no drift. Nothing is recorded: the next verify reads the new index from its start.
  if (!(await sameIndex(spaceId, state))) return none;
  const fields = { kind: cursor.kind, termAfter: terms.termAfter, termsSeen: terms.seen, termsUnused: terms.unused, ...(cursor.after !== undefined ? { after: cursor.after } : {}),
    ...(rows.next !== undefined ? { rowAfter: rows.next } : {}) };
  const unset = { ...(cursor.after === undefined ? { after: '' } : {}), ...(rows.next === undefined ? { rowAfter: '' } : {}) };
  await verifyCollection(spaceId).updateOne(asFilter<VerifyRow>({ _id: 'verify' }),
    asUpdate<VerifyRow>({ $set: fields, ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}) }), { upsert: true });
  // A write that landed while the sample was read is the follower's, not drift.
  if (mismatched.length > 0 && !(await caughtUp(spaceId, state.appliedPos))) mismatched = [];
  if (mismatched.length > 0) {
    log.warn(`Triple index of space '${peerText(spaceId)}': the drift verify found ${mismatched.length} record(s) whose statements differ from the index `
      + `(${mismatched.slice(0, KEYS_NAMED).map(k => peerText(k)).join(', ')}); it is rebuilt`);
  }
  const reason = mismatched.length > 0 ? 'verify' : terms.overShare ? 'unused-terms' : null;
  return { checked: [...expected.keys()], mismatched, reason };
}

/** Whether `spaceId`'s index is still the state `was` (ready, the same build and form): no swap and no stale mark came between. */
async function sameIndex(spaceId: string, was: { buildId?: string; formKey: string }): Promise<boolean> {
  const now = await readTripleIndexState(spaceId);
  return now !== null && now.status === 'ready' && now.buildId === was.buildId && now.formKey === was.formKey;
}

/** The next record rows of the index by key after `after` (at most {@link VERIFY_SAMPLE_RECORDS}), and where the next sample starts (`undefined`: from the first). */
async function sampleRecordRows(spaceId: string, after: string | undefined): Promise<{ keys: string[]; next: string | undefined }> {
  const page = await idKeysetPage<{ _id: string }>({ collection: liveCollections(spaceId).records, filter: {}, projection: { _id: 1 }, size: VERIFY_SAMPLE_RECORDS }, after);
  return { keys: page.rows.map(r => r._id), next: page.end || page.last === undefined ? undefined : page.last };
}

/** The keys of `keys` (record rows) whose record is not stored: a row of a record that is gone, or one that names no record kind. */
async function rowsWithoutRecords(spaceId: string, keys: readonly string[]): Promise<string[]> {
  const byKind = new Map<RdfRecordKind, string[]>();
  const unnamed: string[] = [];
  for (const key of keys) {
    const cut = key.indexOf(':');
    const kind = RDF_KIND_COLLECTIONS.find(c => c.kind === key.slice(0, cut))?.kind;
    if (cut < 1 || kind === undefined) { unnamed.push(key); continue; }
    const ids = byKind.get(kind);
    if (ids) ids.push(key.slice(cut + 1)); else byKind.set(kind, [key.slice(cut + 1)]);
  }
  const strays = [...unnamed];
  for (const [kind, ids] of byKind) {
    const stored = await readStoredById<{ _id: string }>(spaceCollection(spaceId, rdfKindCollection(kind)), ids, { _id: 1 });
    for (const id of ids) if (!stored.has(id)) strays.push(`${kind}:${id}`);
  }
  return strays;
}

/** The keys of `expected` (record key: its statements, each the JSON of three term keys) whose record row states something else. */
async function mismatchesOf(spaceId: string, expected: ReadonlyMap<string, string[]>): Promise<string[]> {
  if (expected.size === 0) return [];
  const live = liveCollections(spaceId);
  const termKeys = new Set<string>();
  for (const statements of expected.values()) for (const s of statements) for (const k of JSON.parse(s) as string[]) termKeys.add(storedKeyOf(k));
  const ids = await idsOfStoredKeys(live.terms, [...termKeys]);
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
  const reason = await upkeepReasonOf(spaceId, opts.verify);
  if (reason === null) return { rebuilt: null, reason: null };
  log.info(`Triple index of space '${peerText(spaceId)}': rebuilt (${reason})`);
  const r = await requestTripleIndexRebuild(spaceId, reason);
  return { rebuilt: r.outcome === 'built' ? reason : null, reason, outcome: r.outcome };
}

/** The reason `spaceId`'s index needs a rebuild now: its state's, else the drift verify's when `verify` asks for it. */
async function upkeepReasonOf(spaceId: string, verify: boolean): Promise<RebuildReason | null> {
  const reason: RebuildReason | null = await tripleIndexRebuildReason(spaceId);
  return reason === null && verify ? (await verifyTripleIndex(spaceId)).reason : reason;
}

const STEP = declareStep('Triple index upkeep');
/**
 * When each space was verified last in this process. A space the tick sees for the first time starts a random part of {@link VERIFY_EVERY_MS}
 * ago, so a process that just started does not verify every space at its first tick: each first verify falls somewhere in the next interval.
 */
const verifiedAt = new Map<string, number>();
/** The waits after rebuilds of a space failed (`rebuild-backoff.ts`). */
const backoff = rebuildBackoff(UPKEEP_INTERVAL_MS);

/** What a tick takes from outside: the clock and the rebuild launcher (the defaults are the real ones; a spec moves the clock and fails the launch). */
export interface UpkeepOptions { now?: () => number; launch?: typeof launchTripleIndexRebuild }

/**
 * One tick: every configured space's upkeep, its verify when one is due. It starts at most one rebuild, and none while one runs in this
 * process (finding F5): on an upgrade every RDF space is `missing`, and a tick that rebuilt them all, each awaited, ran for as long as all of
 * them together and left the verify of every other space waiting. The rebuild is started and not awaited; the walk goes on, and a space that
 * needs one meanwhile waits for a later tick. Nor does a tick verify a space it cannot rebuild: a verify that found drift would have
 * moved its cursor past it. A space whose rebuilds failed is left alone for the wait `rebuild-backoff.ts` gives, and a space an act holds
 * until the act ends ({@link waitsForAnAct}).
 */
export async function upkeepTripleIndexes(opts: UpkeepOptions = {}): Promise<void> {
  const clock = opts.now ?? Date.now;
  let started = false;
  await eachSpace(STEP, configuredSpaces(), async (s) => {
    if (started || anyRebuildRunsHere()) return;
    const now = clock();
    if (!backoff.mayStart(s.id, now)) return;
    if (await waitsForAnAct(s.id)) return;
    if (!verifiedAt.has(s.id)) verifiedAt.set(s.id, now - Math.floor(Math.random() * VERIFY_EVERY_MS));
    const due = now - verifiedAt.get(s.id)! >= VERIFY_EVERY_MS;
    const reason = await upkeepReasonOf(s.id, due);
    if (due) verifiedAt.set(s.id, now);
    if (reason === null) return;
    started = true;
    log.info(`Triple index of space '${peerText(s.id)}': rebuilding (${reason})`);
    // The launch is written out here, in the walk's own unit, so the walk gates see the rebuild this tick starts.
    const launched = opts.launch ? opts.launch(s.id, 'the upkeep', reason) : launchTripleIndexRebuild(s.id, 'the upkeep', reason);
    const { run, joined } = await launched.catch((err: unknown) => { backoff.settled(s.id, null, clock()); throw err; });
    if (!joined) {
      run.result.then(r => {
        backoff.settled(s.id, r.outcome, clock());
        // Every "rebuilding" line gets its outcome: a built one says `rebuilt` itself (`rebuild.ts`), a failed one is warned there.
        if (r.outcome !== 'built') log.info(`Triple index of space '${peerText(s.id)}': the rebuild ended without a swap (${r.outcome})`);
      }, () => backoff.settled(s.id, null, clock()));
    }
  });
}

/** The spaces whose rebuild waits for an act, said once per hold and reason (bundle-385, Q-985). */
const waitSaid = warnOnce<string>();

/**
 * Whether a space act (an RDF import, a restore, a wipe, a rename) holds `spaceId`, so the tick leaves it alone: no verify (one that found drift
 * would move its cursor past a space it cannot rebuild) and no rebuild, which the act would refuse at its first line (`rebuild.ts`, `held`). An
 * RDF import holds its space for its whole length: the tick logged "rebuilding" and the rebuild ended unsaid every minute of it (bundle-384
 * drives, 39 times in one import). When the index needs a rebuild meanwhile, that it waits is said once per hold; the first tick after the act
 * finds the reason again and rebuilds.
 */
async function waitsForAnAct(spaceId: string): Promise<boolean> {
  const why = spaceWriteRefusal(spaceId);
  if (why === null) { waitSaid.forget(spaceId); return false; }
  const reason = await tripleIndexRebuildReason(spaceId);
  if (reason !== null) waitSaid(spaceId, () => log.info(`Triple index of space '${peerText(spaceId)}': its rebuild (${reason}) waits, since ${why}`), why);
  return true;
}

const upkeepJob = intervalJob('Triple index upkeep', UPKEEP_INTERVAL_MS, () => upkeepTripleIndexes());

/** Start the upkeep job (`bootstrap.ts`). */
export function startTripleIndexUpkeep(): void {
  if (upkeepJob.armed) return;
  upkeepJob.start();
}

/** Stop it (`shutdown.ts`). */
export function stopTripleIndexUpkeep(): void {
  upkeepJob.stop();
}
