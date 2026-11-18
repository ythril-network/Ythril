/**
 * What a schema conversion run does with the records it read (Q-746, bundle-284 design r5 section 5.3): stamp a conforming copy quietly, rewrite
 * a copy the steps change through its kind's own update function, or say why it cannot be converted.
 *
 * ## What it prevents
 *
 * - **A converted record written in a shape the schema refuses.** A rewrite goes through the kind's update function (which validates and stamps
 *   in the one write it makes) with an `onValidation` that throws {@link ConversionNotConforming} on any violation, before the write, so a
 *   converted record is never stored unconforming, whatever the space's validation mode.
 * - **A stamp that moves a version, a position or `updatedAt`, or fires a webhook or an embed job.** A record the steps leave as it is gets the
 *   stamp alone, written in place (`$set` of the fingerprint, nothing else): no version move, so nothing replicates and no list reorders. A
 *   rewrite passes no actor, so it publishes nothing either.
 * - **A write over a record that moved.** Both writes are filtered by the version (and, for the stamp, the stamp) the run READ: a record another
 *   write reached first matches nothing and is answered `moved`, never overwritten. The record is handed in as read for that reason.
 * - **A fork row touched.** The quiet stamp's filter excludes fork rows; the update functions refuse one (`fork`).
 * - **One refused record failing the run.** A refusal of the record itself (not conforming by the pre-check or the guard, an identity or
 *   functional guard in the way, the update function's own strict refusal, a version at the ceiling, a fork) is answered as an `unconverted`
 *   outcome with its reason; a store or write-gate failure is thrown, for the run to fail the page.
 * - **One record holding a run for ever.** Any other failure of a record's rewrite fails the page too, but only until that record has failed
 *   {@link SCHEMA_CONVERT_RECORD_FAILED_PASSES} passes in a row (the run counts them, `recordFailure`): then it is an item `conversion_failed`
 *   naming the error's kind, never its words, and the run goes on. An owed run, which is never set `failed`, would otherwise retry it for ever.
 * - **The edges of a re-typed entity left unstamped.** A rewrite that changes an entity's type takes the stamp off every edge at it; the edges
 *   that still conform are classified again and stamped quietly.
 *
 * It reads no run document and writes no item: the run module owns both.
 */
import {
  convertedRecord, type ConversionStep, type ConditionJudge, type RecordChange,
} from '@ythril-network/schema/internal';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { atReadSeq } from '../db/at-read-seq.js';
import { eachIdPage } from '../db/id-keyset-page.js';
import { readStoredById } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { COLLECTION_SUFFIX } from '../config/types-knowledge.js';
import type { KnowledgeType, SpaceMeta } from '../config/types.js';
import { readMetaForWrite, stampOp, stampSetOf, SCHEMA_FINGERPRINT_FIELD, type MetaForWrite } from '../spaces/schema-stamp.js';
import { evaluateCondition } from '../spaces/schema-rules.js';
import { admitSpaceWrite, SpaceNotWritableError } from '../spaces/space-write-gate.js';
import { recordViewOf, viewSourceProjection } from './record-view.js';
import { CHOSEN_VERSION_ROWS } from './chosen-versions.js';
import { edgeEndsAt } from './edge-ends-of-record.js';
import { resolveEdgeEndsOfPage } from './write-plan/plan-edge.js';
import {
  classifyEntityUpsertAgainst, classifyFactUpsertAgainst, classifyChronoUpsertAgainst, classifyEdgeUpsertAgainst, recordAfterPatch,
  SchemaViolationError, type UpdateValidation,
} from './write-validation.js';
import { classifyReadFailure } from './store-failure.js';
import type { SchemaViolation, ResolvedEdgeEnds } from '../spaces/schema-validation.js';
import { updateEntityById } from './entities.js';
import { updateFact } from './fact.js';
import { updateChrono } from './chrono.js';
import { updateEdgeById } from './edges.js';
import { EdgeIdentityTaken } from './edge-rekey.js';
import { WriteConflict } from './write-plan/types.js';
import { RecordVersionAtCeiling } from './write-precondition.js';
import { ForkRowReadOnly } from '../util/errors.js';
import { TYPE_FIELD } from './ttl.js';
import type { UnconvertedReason } from './schema-convert-items.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';

/** A rewrite the schema would refuse: thrown by the converter's `onValidation`, before the write, so nothing is written. */
export class ConversionNotConforming extends Error {
  constructor(readonly violations: readonly SchemaViolation[]) {
    super(`the converted record would not conform: ${violations.length} violation(s)`);
    this.name = 'ConversionNotConforming';
  }
}

/** The fingerprint the space has now is not the one the run converts toward: the run restarts (design 5.2) before any write of the page. */
export class SchemaConvertTargetMoved extends Error {
  constructor(readonly toFp: string, readonly now: string) {
    super('the space\'s schema fingerprint moved since the run read it: the run restarts toward the new one');
    this.name = 'SchemaConvertTargetMoved';
  }
}

/** What the converter needs of a run: its target, its steps, the steps it refused, and the declared properties of each split's source type. */
export interface SchemaConvertRecordRun {
  readonly toFp: string;
  readonly steps: readonly ConversionStep[];
  readonly stepsRefused?: readonly { readonly step: ConversionStep | null; readonly reason: string }[];
  /** Keyed by {@link splitDeclaredKey}: the property names the split's source type declared when the run was created. */
  readonly splitDeclared: Readonly<Record<string, readonly string[]>>;
  /** The record whose rewrite failed the run's last failed pass for a reason no class names, and on how many passes in a row. */
  readonly recordFailure?: { readonly kind: KnowledgeType; readonly id: string; readonly passes: number };
}

/** What a page can be handed besides the run: a hook called before each rewrite (a test makes a record's rewrite fail through it). */
export interface ConvertPageOptions {
  onRewrite?: (kind: KnowledgeType, record: ReadRecord) => void | Promise<void>;
}

/** How many passes in a row one record's rewrite may fail for a reason no class names before it is an item `conversion_failed`. */
export const SCHEMA_CONVERT_RECORD_FAILED_PASSES = 3;

/**
 * A record's rewrite failed for a reason no refusal class names, on fewer passes than {@link SCHEMA_CONVERT_RECORD_FAILED_PASSES}: the page fails
 * (the run counts the record's passes, `recordFailure`). The message names the record and the error's kind, never the error's words.
 */
export class RecordConversionFailed extends Error {
  constructor(readonly kind: KnowledgeType, readonly id: string, readonly passes: number, cause: unknown) {
    super(`the ${kind} ${id} could not be rewritten (${errorKindOf(cause)}), pass ${passes} of ${SCHEMA_CONVERT_RECORD_FAILED_PASSES} before it is listed`, { cause });
    this.name = 'RecordConversionFailed';
  }
}

/** The kind of an error as an item may name it: its class name when that is a plain identifier, else `Error`. Never its message. */
function errorKindOf(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  return typeof name === 'string' && ERROR_KIND.test(name) ? name : 'Error';
}
/** A class name: a letter, then letters, digits or underscores, short. */
const ERROR_KIND = /^[A-Za-z]\w{0,63}$/;

/** Is this failure the store's or the write gate's (the page fails and is retried), rather than something about one record? */
function pageFailure(err: unknown): boolean {
  if (err instanceof SpaceNotWritableError) return true;
  return classifyReadFailure(err).status !== NOT_THE_STORE;
}
/** The status `classifyReadFailure` gives a failure that is not the store's (a refusal in its own words). */
const NOT_THE_STORE = 400;

/** A record as a run read it: its id, version and stamp beside its body. */
export type ReadRecord = { readonly _id: string; readonly seq?: unknown; readonly [field: string]: unknown };

/** What became of one record. */
export type SchemaConvertOutcome =
  | { outcome: 'stamped' }
  | { outcome: 'rewritten'; edgesRestamped: number }
  | { outcome: 'moved' }
  | { outcome: 'unconverted'; reason: UnconvertedReason; violations: { field: string; reason: string }[]; proposed?: RecordChange };

/** The key of a split's declared properties in a run: one per kind and source type. */
export const splitDeclaredKey = (kind: KnowledgeType, from: string): string => `${kind}:${from}`;

/** The fields a page of `kind` reads: what the steps, the classifiers and the writes' filters need, and never a vector. */
export function convertProjectionOf(kind: KnowledgeType): Readonly<Record<string, 1>> {
  return {
    ...viewSourceProjection(kind), _id: 1, seq: 1, [SCHEMA_FINGERPRINT_FIELD]: 1, forkOf: 1, [TYPE_FIELD[kind]]: 1,
    ...(kind === 'edge' ? { from: 1, to: 1, fromKind: 1, toKind: 1 } : {}),
  };
}

const isEmptyChange = (c: RecordChange): boolean => c.type === undefined && Object.keys(c.set).length === 0 && c.unset.length === 0;
const namesOf = (violations: readonly SchemaViolation[]): { field: string; reason: string }[] => violations.map(v => ({ field: v.field, reason: v.reason }));
const unconverted = (reason: UnconvertedReason, violations: readonly SchemaViolation[] = [], proposed?: RecordChange): SchemaConvertOutcome =>
  ({ outcome: 'unconverted', reason, violations: namesOf(violations), ...(proposed ? { proposed } : {}) });

/** The judge of one split condition on one record, with the declared properties the run stored for the split's source type. */
function judgeOf(run: SchemaConvertRecordRun): ConditionJudge {
  return (kind, from, text, record) => evaluateCondition(kind, run.splitDeclared[splitDeclaredKey(kind, from)] ?? [], text, recordViewOf(kind, record));
}

/**
 * The classification of `record` as `change` leaves it (as stored, for none) against `meta` (resolved), as its kind's update path classifies a
 * write: the same classifier, the record as read beside the record the write would store. The meta comes first, as in every classification a
 * stamp follows: the stamp gate reads the first argument as the schema judged with.
 */
function classifyStored(meta: SpaceMeta | undefined, kind: KnowledgeType, record: ReadRecord, ends?: ResolvedEdgeEnds, change?: RecordChange): UpdateValidation {
  const left = recordAfterPatch(record, change ? patchOf(kind, record, change) : {}, {});
  const stored = record as never;
  switch (kind) {
    case 'entity': return classifyEntityUpsertAgainst(meta, stored, left);
    case 'fact': return classifyFactUpsertAgainst(meta, stored, left);
    case 'chrono': return classifyChronoUpsertAgainst(meta, stored, left);
    case 'edge': {
      // The ends the page resolved (the endpoint rule and the functional count read them); an edge judged without them would be judged wrong.
      if (!ends) throw new Error(`classifyStored: edge '${record._id}' was handed no resolved ends`);
      return classifyEdgeUpsertAgainst(meta, stored, left, ends);
    }
  }
}

/** What `change` sets on `record`: the type field when the type moves, and the properties with the renamed and mapped names. */
function patchOf(kind: KnowledgeType, record: ReadRecord, change: RecordChange): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...(record['properties'] && typeof record['properties'] === 'object' ? record['properties'] as Record<string, unknown> : {}) };
  for (const name of change.unset) delete properties[name];
  // Own data properties, so a property named like something on `Object.prototype` is a property and never a prototype.
  for (const [name, value] of Object.entries(change.set)) Object.defineProperty(properties, name, { value, enumerable: true, writable: true, configurable: true });
  return { ...(change.type !== undefined ? { [TYPE_FIELD[kind]]: change.type } : {}), properties };
}

/** Resolved ends for the edges of a page, in order; none for a page of another kind, whose records have no ends. */
async function endsOfPage(spaceId: string, kind: KnowledgeType, records: readonly ReadRecord[]): Promise<ResolvedEdgeEnds[]> {
  if (kind !== 'edge' || records.length === 0) return [];
  return await resolveEdgeEndsOfPage(spaceId, records.map(r => ({ from: r['from'], to: r['to'], label: r['label'], fromKind: r['fromKind'], toKind: r['toKind'] })));
}

/**
 * Stamp `records` (each read as it is stored, each conforming by `checks`) quietly, in one command: `$set` of the stamp alone, filtered by the
 * version and the stamp each was read with and by its not being a fork. Answers, per record, whether its stamp landed.
 */
async function stampQuietly(spaceId: string, kind: KnowledgeType, pair: MetaForWrite, records: readonly ReadRecord[], checks: readonly UpdateValidation[]): Promise<boolean[]> {
  if (records.length === 0) return [];
  const part = COLLECTION_SUFFIX[kind];
  const coll = col<{ _id: string }>(spaceCollection(spaceId, part));
  const filterOf = (r: ReadRecord): Record<string, unknown> => ({
    ...atReadSeq(r._id, typeof r.seq === 'number' ? r.seq : null),
    [SCHEMA_FINGERPRINT_FIELD]: typeof r[SCHEMA_FINGERPRINT_FIELD] === 'string' ? r[SCHEMA_FINGERPRINT_FIELD] : { $exists: false },
    ...CHOSEN_VERSION_ROWS,
  });
  const ops = records.map((r, i) => ({
    updateOne: { filter: asFilter<{ _id: string }>(filterOf(r)), update: asUpdate<{ _id: string }>({ $set: { ...stampSetOf(stampOp(pair, checks[i]!)) } }) },
  }));
  const done = await admitSpaceWrite(spaceId, part, () => coll.bulkWrite(ops, { ordered: false }));
  if (done.matchedCount === records.length) return records.map(() => true);
  if (done.matchedCount === 0) return records.map(() => false);
  // Some moved: which ones carry the stamp now is read back (the rare case; one read of the page's ids).
  const landed = await readStoredById<{ _id: string }>(spaceCollection(spaceId, part), records.map(r => r._id), { _id: 1 },
    { filter: { [SCHEMA_FINGERPRINT_FIELD]: pair.stamp.fp } });
  return records.map(r => landed.has(r._id));
}

/** The update function of `kind`, called with the change as its own parameters, at the version read, with no actor and the conformance guard. */
async function rewrite(spaceId: string, kind: KnowledgeType, record: ReadRecord, change: RecordChange): Promise<{ written: boolean }> {
  const ifMatchSeq = typeof record.seq === 'number' ? record.seq : undefined;
  const properties = Object.keys(change.set).length > 0 ? change.set as Record<string, string | number | boolean> : undefined;
  const deleteFields = change.unset.length > 0 ? change.unset.map(p => `properties.${p}`) : undefined;
  const guard = (check: UpdateValidation): void => { if (check.all.length > 0) throw new ConversionNotConforming(check.all); };
  const id = record._id;
  switch (kind) {
    case 'entity':
      return { written: (await updateEntityById(spaceId, id, { ...(change.type ? { type: change.type } : {}), ...(properties ? { properties } : {}) },
        deleteFields, undefined, undefined, ifMatchSeq, guard)) !== null };
    case 'fact':
      return { written: (await updateFact(spaceId, id, { ...(change.type ? { type: change.type } : {}), ...(properties ? { properties } : {}) },
        deleteFields, undefined, undefined, ifMatchSeq, guard)) !== null };
    case 'chrono':
      return { written: (await updateChrono(spaceId, id, { ...(change.type ? { type: change.type as never } : {}), ...(properties ? { properties } : {}) },
        deleteFields, undefined, undefined, ifMatchSeq, guard)) !== null };
    case 'edge':
      return { written: (await updateEdgeById(spaceId, id, { ...(change.type ? { label: change.type } : {}), ...(properties ? { properties } : {}) },
        deleteFields, undefined, undefined, ifMatchSeq, guard)) !== null };
  }
}

/** The reason class of a refusal the record itself drew, or `undefined` for anything else (judged by {@link pageFailure} and the record's bound). */
function refusalOf(err: unknown): { reason: UnconvertedReason; violations: readonly SchemaViolation[] } | undefined {
  if (err instanceof ConversionNotConforming) return { reason: 'not_conforming', violations: err.violations };
  // The update function's own strict refusal, made before the guard runs: the record's refusal too (design 5.3's table; lens sweep S4).
  if (err instanceof SchemaViolationError) return { reason: 'not_conforming', violations: err.check.all };
  if (err instanceof EdgeIdentityTaken) return { reason: 'relationship_exists', violations: [] };
  if (err instanceof WriteConflict) return { reason: 'functional_taken', violations: [] };
  if (err instanceof RecordVersionAtCeiling) return { reason: 'version_ceiling', violations: [] };
  if (err instanceof ForkRowReadOnly) return { reason: 'fork', violations: [] };
  return undefined;
}

/**
 * The edges at entity `entityId` that a re-type just unstamped, classified again against `pair` and stamped quietly where they conform.
 * Answers how many were stamped.
 */
async function restampEdgesAt(spaceId: string, entityId: string, pair: MetaForWrite): Promise<number> {
  let stamped = 0;
  await eachIdPage<ReadRecord>({
    collection: spaceCollection(spaceId, 'edges'),
    filter: { ...edgeEndsAt(entityId, 'entity'), ...CHOSEN_VERSION_ROWS, [SCHEMA_FINGERPRINT_FIELD]: { $exists: false } },
    projection: convertProjectionOf('edge'),
    size: EDGES_PER_PAGE,
  }, async (edges) => {
    const ends = await endsOfPage(spaceId, 'edge', edges);
    const conforming = edges.map((e, i) => ({ e, check: classifyStored(pair.meta, 'edge', e, ends[i]) })).filter(x => x.check.all.length === 0);
    const landed = await stampQuietly(spaceId, 'edge', pair, conforming.map(x => x.e), conforming.map(x => x.check));
    stamped += landed.filter(Boolean).length;
  });
  return stamped;
}

/** Edges of one re-typed entity classified and stamped per command. */
const EDGES_PER_PAGE = 100;

/**
 * Convert one page of `kind` records toward `run.toFp`, each as READ. The quiet stamps of the page are one command; each rewrite is one write
 * of its update function. Answers one outcome per record, in order.
 *
 * @throws {@link SchemaConvertTargetMoved} when the space's fingerprint is no longer `run.toFp` (nothing of the page is written); a store or
 *   write-gate failure, or anything a record's own refusal does not explain, as thrown.
 */
export async function convertRecordsPage(
  spaceId: string, run: SchemaConvertRecordRun, kind: KnowledgeType, records: readonly ReadRecord[], opts: ConvertPageOptions = {},
): Promise<SchemaConvertOutcome[]> {
  const pair = readMetaForWrite(spaceId);
  if (pair.stamp.fp !== run.toFp) throw new SchemaConvertTargetMoved(run.toFp, pair.stamp.fp);
  const judge = judgeOf(run);
  const refused = (run.stepsRefused ?? []).map(r => r.step).filter((s): s is ConversionStep => s !== null);
  const out: SchemaConvertOutcome[] = new Array(records.length);
  const ends = await endsOfPage(spaceId, kind, records);
  const toStamp: { at: number; record: ReadRecord; check: UpdateValidation }[] = [];

  for (let i = 0; i < records.length; i++) {
    // One record between two turns of the event loop: a page of conditions and rewrites never holds the server's thread.
    if (i > 0) await yieldToEventLoop();
    const record = records[i]!;
    const change = convertedRecord(run.steps, kind, record, judge);
    if ('notConvertible' in change) { out[i] = unconverted(change.notConvertible); continue; }
    if (isEmptyChange(change)) {
      const check = classifyStored(pair.meta, kind, record, ends[i]);
      if (check.all.length === 0) { toStamp.push({ at: i, record, check }); continue; }
      // A step the run refused would have changed this record: the reason is the refusal, which an operator can answer with other steps.
      const wouldChange = refused.length > 0 && (() => { const c = convertedRecord(refused, kind, record, judge); return !('notConvertible' in c) && !isEmptyChange(c); })();
      out[i] = unconverted(wouldChange ? 'step_refused' : 'not_conforming', check.all);
      continue;
    }
    // The pre-check (design 5.3 step 4): the record as the change leaves it, against the schema now. Any violation is an item and nothing is
    // written; the guard inside the write (`ConversionNotConforming`) still holds if the schema moved in between.
    const patchedEnds = kind === 'edge'
      ? (await endsOfPage(spaceId, 'edge', [{ ...record, ...(change.type !== undefined ? { label: change.type } : {}) }]))[0]
      : undefined;
    const precheck = classifyStored(pair.meta, kind, record, patchedEnds, change);
    if (precheck.all.length > 0) { out[i] = unconverted('not_conforming', precheck.all, change); continue; }
    try {
      await opts.onRewrite?.(kind, record);
      const { written } = await rewrite(spaceId, kind, record, change);
      if (!written) { out[i] = { outcome: 'moved' }; continue; }
      const retyped = kind === 'entity' && change.type !== undefined;
      out[i] = { outcome: 'rewritten', edgesRestamped: retyped ? await restampEdgesAt(spaceId, record._id, pair) : 0 };
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal) { out[i] = unconverted(refusal.reason, refusal.violations, change); continue; }
      // The store's or the write gate's condition fails the page, which the run retries; it says nothing about this record.
      if (pageFailure(err)) throw err;
      // Anything else is about this record: it fails the page until the record has failed the stated number of passes, then it is an item that
      // names the kind of error (never its words) and the run goes on, so one record never holds an owed run for ever (lens sweep S4).
      const failed = run.recordFailure;
      const passes = (failed?.kind === kind && failed.id === record._id ? failed.passes : 0) + 1;
      if (passes < SCHEMA_CONVERT_RECORD_FAILED_PASSES) throw new RecordConversionFailed(kind, record._id, passes, err);
      out[i] = { outcome: 'unconverted', reason: 'conversion_failed', violations: [{ field: '', reason: errorKindOf(err) }], proposed: change };
    }
  }

  const landed = await stampQuietly(spaceId, kind, pair, toStamp.map(s => s.record), toStamp.map(s => s.check));
  toStamp.forEach((s, j) => { out[s.at] = landed[j] ? { outcome: 'stamped' } : { outcome: 'moved' }; });
  return out;
}

/** {@link convertRecordsPage} for one record, as read: the window a test holds open by handing in a read whose version moved after it. */
export async function convertOneRecord(spaceId: string, run: SchemaConvertRecordRun, kind: KnowledgeType, record: ReadRecord): Promise<SchemaConvertOutcome> {
  const [outcome] = await convertRecordsPage(spaceId, run, kind, [record]);
  return outcome!;
}
