/**
 * The schema conversion run (Q-746, bundle-284 design r5 sections 4.2, 5 and 6): after a schema change, every copy of the changed types this
 * instance holds is stamped quietly when it conforms, rewritten when the declared steps change it, or listed as an item when it cannot be
 * converted; in the background, one page at a time, resumable.
 *
 * ## What it prevents
 *
 * - **A run a restart forgets.** The run is one local document per space (`<space>_schema_convert_run`, `_id: 'run'`, never synced or hashed):
 *   its target fingerprint, types, steps, cursor and counts. The boot ({@link resumeSchemaConvertRuns}) and the watcher's tick continue it.
 * - **Two sweepers of one run.** Whoever sweeps holds the lease (`sweepLeaseAt`, taken with one atomic `findOneAndUpdate`, renewed with every
 *   cursor save and as each peer of the first sync answers, stale after {@link SWEEP_LEASE_STALE_MS}); a run rewritten in place moves its
 *   `generation`, and a sweeper whose generation is no longer the document's stops.
 * - **A run stranded on a fingerprint the space no longer has** (finding B2). Before each page the run asks the space's fingerprint; when it
 *   moved (any schema door, a library edit, a layer pull) or a new start arrives while it is unfinished, the run is restarted in place
 *   ({@link restartedSchemaConvertRun}): the unfinished types and the new start's, the old steps checked again against the schema now.
 * - **A rewrite of a copy another member already converted.** A run a save or a vote started on a networked space first asks ONE sync of each
 *   peer it pulls from (`peerSyncOutcome`, the manual trigger, injectable as `syncPeer`), so a converted copy arrives first and is only stamped;
 *   a peer that fails or does not answer holds nothing up (amendment A2). An act-started run syncs with nobody.
 * - **A round-started run given up.** A run a passed vote started is owed (`owed: true`): a page the store fails is retried with backoff for as
 *   long as it is owed and never set `failed`; any other run is `failed` after {@link FAILED_AFTER_PASSES} failed passes.
 * - **One refused record failing the run** (B3): the converter answers a record's own refusal as an item, which this module writes
 *   (`brain/schema-convert-items.ts`), and the run goes on.
 *
 * The per-record work (the quiet stamp, the rewrite, the refusal classes, the edges of a re-typed entity) is `brain/schema-convert-record.ts`.
 * The run's start from a schema save or a round is wired by the write path; the act and the status doors call {@link startSchemaConvertRun}
 * and {@link schemaConvertStatus}.
 */
import {
  conversionStepIssues, spaceRuleKinds, rulesIn,
  type ConversionStep, type ConversionMeta, type ConversionIssueCode,
} from '@ythril-network/schema/internal';
import { isDeepStrictEqual } from 'node:util';
import { col, asFilter, asUpdate } from '../db/mongo.js';
import { idKeysetPage, type IdPageSpec } from '../db/id-keyset-page.js';
import { spaceCollection } from '../db/space-collection.js';
import { COLLECTION_SUFFIX, KNOWLEDGE_TYPES } from '../config/types-knowledge.js';
import type { KnowledgeType, SpaceMeta } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { configuredSpaces, findSpace } from './space-lookup.js';
import { readMetaForWrite, schemaFingerprintOf, SCHEMA_FINGERPRINT_FIELD } from './schema-stamp.js';
import { peerSyncOutcome } from '../sync/trigger.js';
import { exchangeDirections } from '../sync/space-exchange.js';
import { TYPE_FIELD } from '../brain/ttl.js';
import { CHOSEN_VERSION_ROWS } from '../brain/chosen-versions.js';
import {
  convertRecordsPage, convertProjectionOf, splitDeclaredKey, SchemaConvertTargetMoved, type ReadRecord, type SchemaConvertOutcome,
} from '../brain/schema-convert-record.js';
import {
  recordUnconvertedItem, sweepStaleUnconvertedItems, hasUnconvertedItems, UNCONVERTED_ITEMS_PER_RUN_MAX,
} from '../brain/schema-convert-items.js';
import { schemaConvertRecordsTotal, schemaConvertRunsInProgress } from '../metrics/schema-convert-metrics.js';
import { createCoalescingRunner } from '../sync/coalescing-runner.js';
import { outsideWriteBound, withinHousekeepingBound } from '../db/write-bound.js';
import { eachSpace, type WalkResult } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { intervalJob } from '../util/interval-job.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { backoffDelayMs } from '../util/backoff.js';
import { peerText } from '../util/log.js';
import { logInternalAudit } from '../audit/audit.js';
import { SCHEMA_CONVERT_RUN_OPERATION } from '../audit/middleware.js';
import { startOwedRoundConversions } from '../sync/governance.js';

/** The operation of the one internal audit entry a finished run writes: declared in the audit middleware beside the other operations no route produces, re-exported here for the run's own readers. */
export { SCHEMA_CONVERT_RUN_OPERATION };
/** The most types one start may name. */
export const SCHEMA_CONVERT_TYPES_MAX = 50;
/** Records read per page. */
export const SCHEMA_CONVERT_PAGE_SIZE = 100;
/** A sweeper renews its lease with every page; one that has not for this long died, and another may take the run. */
const SWEEP_LEASE_STALE_MS = 60_000;
/** Failed passes after which a run nobody owes is `failed` (a reindex's count, `brain/reindex.ts`). An owed run is never failed. */
const FAILED_AFTER_PASSES = 3;
/** The watcher's interval. */
const WATCH_MS = 5_000;
/** The backoff of a failed pass before the tick retries it: from one second, at most five minutes. */
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 5 * 60_000;
/** The longest a status read counts the records left. */
const LEFT_COUNT_MS = 2_000;
/** The store's code for a read its `maxTimeMS` ended (`MaxTimeMSExpired`). */
const MAX_TIME_EXPIRED = 50;
/** The longest a run keeps the words of its last failure. */
const ERROR_TEXT_MAX = 300;
/** The status of the refusal of an explicit start while a run is unfinished. */
const SCHEMA_CONVERT_RUNNING_STATUS = 409;

const WATCH_STEP = declareStep('Schema convert watcher');
const RESUME_STEP = declareStep('Schema convert resume');
const PASS_STEP = declareStep('Schema convert pass');
const WHEN = 'next tick';

/** One type a run converts; `*` is every record of the kind. */
export interface SchemaConvertType { kind: KnowledgeType; type: string }
/** What started a run: a schema save, a passed vote, or the Convert act. */
export interface SchemaConvertSource { kind: 'write' | 'round' | 'act'; roundId?: string; at: string }
/** A step the run does not apply, and why (`null` step: all of them, e.g. a round whose steps the proposer did not sign). */
export interface SchemaConvertRefusedStep { step: ConversionStep | null; reason: string }
export interface SchemaConvertCounts { stamped: number; rewritten: number; unconverted: number; moved: number; edgesRestamped: number }

/** The run document. Local: never synced, never hashed, dropped by a restore and never loaded from a backup. */
export interface SchemaConvertRunDoc {
  _id: 'run';
  toFp: string;
  types: (SchemaConvertType & { done: boolean })[];
  steps: ConversionStep[];
  splitDeclared: Record<string, string[]>;
  stepsRefused: SchemaConvertRefusedStep[];
  sources: SchemaConvertSource[];
  owed: boolean;
  /** The first sync (design 5.3 step 0): absent until it ended; `{ 0, 0 }` for a run that asks none. */
  syncedFirst?: { asked: number; answered: number };
  startedAt: string;
  finishedAt?: string;
  cursor: { kind: KnowledgeType; type: string; afterId: string } | null;
  counts: SchemaConvertCounts;
  /** Items the run did not write because it had written {@link UNCONVERTED_ITEMS_PER_RUN_MAX}. */
  unconvertedNotListed?: number;
  state: 'running' | 'complete' | 'failed';
  failures: number;
  /** Before this (epoch ms) the tick does not retry a failed pass. */
  retryAt?: number;
  sweepLeaseAt: number;
  /** Moves with every rewrite of the run in place: a sweeper of an older generation stops. */
  generation: number;
  error?: string;
}

/** What a start hands in. `before` is the schema the steps start from (for a split's declared properties); default the current one. */
export interface SchemaConvertStart {
  spaceId: string;
  types: readonly SchemaConvertType[];
  steps?: readonly ConversionStep[];
  stepsRefused?: readonly SchemaConvertRefusedStep[];
  source: { kind: SchemaConvertSource['kind']; roundId?: string };
  before?: ConversionMeta;
}

export type SchemaConvertStartOutcome =
  | { ok: true; state: 'started' | 'restarted' | 'nothing'; run: SchemaConvertRunDoc | null }
  | { ok: false; status: typeof SCHEMA_CONVERT_RUNNING_STATUS; code: 'schema_convert_running'; error: string };

/** One peer's sync, as the manual trigger answers it (`peerSyncOutcome`). */
export type SchemaConvertSyncPeer = (peerId: string, opts: { wait: true }) => Promise<{ status: number; body: Record<string, unknown> }>;

/** What a run can be handed besides its document: the first sync's trigger (default the manual one) and a hook after each page. */
export interface SchemaConvertDeps {
  syncPeer?: SchemaConvertSyncPeer;
  afterPage?: (page: { kind: KnowledgeType; type: string; rows: number }) => Promise<void> | void;
}

/** What the status doors answer. */
export interface SchemaConvertStatus {
  state: SchemaConvertRunDoc['state'];
  toFp: string;
  types: SchemaConvertRunDoc['types'];
  steps: ConversionStep[];
  stepsRefused: SchemaConvertRefusedStep[];
  sources: SchemaConvertSource[];
  owed: boolean;
  syncedFirst?: { asked: number; answered: number };
  startedAt: string;
  finishedAt?: string;
  counts: SchemaConvertCounts;
  unconvertedNotListed?: number;
  /** Records of the unfinished types still to read, counted within a bound; `null` when the count did not finish in it. */
  left: number | null;
  failures: number;
  error?: string;
}

const RUN_ID = 'run' as const;
const runs = (spaceId: string) => col<SchemaConvertRunDoc>(spaceCollection(spaceId, 'schemaConvertRun'));
const ZERO: SchemaConvertCounts = Object.freeze({ stamped: 0, rewritten: 0, unconverted: 0, moved: 0, edgesRestamped: 0 });

// ── The types a run reaches ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The types a run reaches (design 5.1 "Types", finding S6): the changed types (`kind:Type`), the dropped types on a space in no network, every
 * type step's source; and when the space rules changed, every kind a changed rule governs (old or new text, old or new kinds), WHOLE (`*`).
 * A kind taken whole names no type of its own beside `*`.
 */
export function typesToConvert(input: {
  changedTypes: readonly string[]; droppedTypes: readonly string[]; inNetwork: boolean;
  rulesBefore?: unknown; rulesAfter?: unknown; steps?: readonly ConversionStep[];
}): SchemaConvertType[] {
  const named = new Map<KnowledgeType, Set<string>>();
  const whole = new Set<KnowledgeType>();
  const add = (kind: string, type: string): void => {
    if (!(KNOWLEDGE_TYPES as readonly string[]).includes(kind)) return;
    const k = kind as KnowledgeType;
    (named.get(k) ?? named.set(k, new Set()).get(k)!).add(type);
  };
  const addKey = (key: string): void => { const cut = key.indexOf(':'); if (cut > 0) add(key.slice(0, cut), key.slice(cut + 1)); };
  for (const t of input.changedTypes) addKey(t);
  if (!input.inNetwork) for (const t of input.droppedTypes) addKey(t);
  for (const s of input.steps ?? []) if (s.op === 'renameType' || s.op === 'splitType') add(s.kind, s.from);
  const before = new Map(rulesIn(input.rulesBefore));
  const after = new Map(rulesIn(input.rulesAfter));
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(name);
    const b = after.get(name);
    if (a && b && isDeepStrictEqual(a, b)) continue;
    for (const r of [a, b]) if (r) for (const k of spaceRuleKinds(r)) whole.add(k as KnowledgeType);
  }
  const out: SchemaConvertType[] = [];
  for (const kind of KNOWLEDGE_TYPES as readonly KnowledgeType[]) {
    if (whole.has(kind)) { out.push({ kind, type: '*' }); continue; }
    for (const type of [...(named.get(kind) ?? [])].sort()) out.push({ kind, type });
  }
  return out;
}

// ── Restart in place ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The codes that judge a step against the schema BEFORE: a restarted run's steps were checked against it once and are not again. */
const BEFORE_CODES: ReadonlySet<ConversionIssueCode> = new Set<ConversionIssueCode>([
  'property_not_declared_before', 'enum_not_declared_before', 'enum_key_not_in_before', 'type_not_declared_before', 'condition_refused', 'conditions_over_budget',
]);

/** Two steps act on one source: one type step per type, one rename per property, one map per property. A later one replaces an earlier. */
function sameSource(a: ConversionStep, b: ConversionStep): boolean {
  if (a.kind !== b.kind) return false;
  const typeStep = (s: ConversionStep): s is Extract<ConversionStep, { op: 'renameType' | 'splitType' }> => s.op === 'renameType' || s.op === 'splitType';
  if (typeStep(a) && typeStep(b)) return a.from === b.from;
  if (a.op === 'renameProperty' && b.op === 'renameProperty') return a.type === b.type && a.from === b.from;
  if (a.op === 'mapEnum' && b.op === 'mapEnum') return a.type === b.type && a.property === b.property;
  return false;
}

/** The declared properties of each split's source type in `before`, keyed as the converter reads them. */
function splitDeclaredOf(steps: readonly ConversionStep[], before: ConversionMeta | SpaceMeta | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of steps) {
    if (s.op !== 'splitType') continue;
    const type = (before?.typeSchemas as Record<string, Record<string, { propertySchemas?: Record<string, unknown> }> | undefined> | undefined)?.[s.kind]?.[s.from];
    // In declaration order: the compiled-program cache keys a declared set by its sorted names itself (`programFor`).
    out[splitDeclaredKey(s.kind, s.from)] = Object.keys(type?.propertySchemas ?? {});
  }
  return out;
}

const typeKey = (t: SchemaConvertType): string => `${t.kind}\u0000${t.type}`;

/**
 * The run document `run` becomes when it restarts toward `toFp` (pure): the cursor reset; its unfinished types and the new start's, none done;
 * its old steps checked again against `after` (the schema now; the before is not checked again), each that no longer holds or that a new step
 * on the same source replaces moved to `stepsRefused` with its reason, and the new start's steps added; `sources` gaining the new start's,
 * `owed` true when any source is a round, `syncedFirst` carried as it is (a restart asks for no second sync), the counts kept.
 */
export function restartedSchemaConvertRun(run: SchemaConvertRunDoc, opts: {
  toFp: string; after: ConversionMeta | undefined; at: string;
  start?: { types: readonly SchemaConvertType[]; steps?: readonly ConversionStep[]; stepsRefused?: readonly SchemaConvertRefusedStep[];
    source: { kind: SchemaConvertSource['kind']; roundId?: string }; splitDeclared?: Record<string, string[]> };
}): SchemaConvertRunDoc {
  const { start } = opts;
  const types = new Map<string, SchemaConvertType>();
  for (const t of [...run.types.filter(t => !t.done), ...(start?.types ?? [])]) types.set(typeKey(t), { kind: t.kind, type: t.type });
  const newSteps = [...(start?.steps ?? [])];
  const stepsRefused: SchemaConvertRefusedStep[] = [...run.stepsRefused];
  const kept: ConversionStep[] = [];
  for (const old of run.steps) {
    if (newSteps.some(n => sameSource(old, n))) stepsRefused.push({ step: old, reason: 'replaced' });
    else kept.push(old);
  }
  const broken = new Map<number, ConversionIssueCode>();
  for (const issue of conversionStepIssues(kept, opts.after, opts.after)) {
    if (!BEFORE_CODES.has(issue.code) && !broken.has(issue.step)) broken.set(issue.step, issue.code);
  }
  const holding = kept.filter((s, i) => {
    const code = broken.get(i);
    if (code !== undefined) stepsRefused.push({ step: s, reason: code });
    return code === undefined;
  });
  const sources = [...run.sources, ...(start ? [{ kind: start.source.kind, ...(start.source.roundId ? { roundId: start.source.roundId } : {}), at: opts.at }] : [])];
  const next: SchemaConvertRunDoc = {
    ...run,
    toFp: opts.toFp,
    types: [...types.values()].map(t => ({ ...t, done: false })),
    steps: [...holding, ...newSteps],
    stepsRefused: [...stepsRefused, ...(start?.stepsRefused ?? [])],
    splitDeclared: { ...run.splitDeclared, ...(start?.splitDeclared ?? {}) },
    sources,
    owed: sources.some(s => s.kind === 'round'),
    cursor: null,
    state: 'running',
    generation: (run.generation ?? 0) + 1,
  };
  delete next.finishedAt;
  return next;
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A run that still has work: running, or failed while owed (an owed run is never given up; a failed one is a status a new start replaces). */
const unfinished = (run: SchemaConvertRunDoc | null): run is SchemaConvertRunDoc => run !== null && run.state === 'running';

/**
 * Start a run on `start.spaceId`: a new run document, or the unfinished run restarted in place with this start joined to it. Resolves once
 * the document is written (a restart from then on resumes it) and never awaits the conversion, which runs in the background. An act refuses
 * while a run is unfinished (`409 schema_convert_running`); a save or a round joins it. No types: nothing to run.
 */
export async function startSchemaConvertRun(start: SchemaConvertStart, deps: SchemaConvertDeps = {}): Promise<SchemaConvertStartOutcome> {
  const { spaceId } = start;
  const existing = await runs(spaceId).findOne(asFilter<SchemaConvertRunDoc>({ _id: RUN_ID })) as SchemaConvertRunDoc | null;
  if (unfinished(existing) && start.source.kind === 'act') {
    return { ok: false, status: SCHEMA_CONVERT_RUNNING_STATUS, code: 'schema_convert_running', error: `A schema conversion of '${peerText(spaceId)}' is already running` };
  }
  if (start.types.length === 0 && !unfinished(existing)) return { ok: true, state: 'nothing', run: null };
  const at = new Date().toISOString();
  const now = readMetaForWrite(spaceId);
  const steps = [...(start.steps ?? [])];
  const splitDeclared = splitDeclaredOf(steps, start.before ?? now.meta);
  let doc: SchemaConvertRunDoc;
  if (unfinished(existing)) {
    doc = restartedSchemaConvertRun(existing, {
      toFp: now.stamp.fp, after: now.meta as ConversionMeta | undefined, at,
      start: { types: start.types, steps, ...(start.stepsRefused ? { stepsRefused: start.stepsRefused } : {}), source: start.source, splitDeclared },
    });
  } else {
    const source: SchemaConvertSource = { kind: start.source.kind, ...(start.source.roundId ? { roundId: start.source.roundId } : {}), at };
    doc = {
      _id: RUN_ID, toFp: now.stamp.fp, types: start.types.map(t => ({ kind: t.kind, type: t.type, done: false })), steps, splitDeclared,
      stepsRefused: [...(start.stepsRefused ?? [])], sources: [source], owed: source.kind === 'round',
      // An act syncs with nobody: its step 0 is over before it starts.
      ...(source.kind === 'act' ? { syncedFirst: { asked: 0, answered: 0 } } : {}),
      startedAt: at, cursor: null, counts: { ...ZERO }, state: 'running', failures: 0, sweepLeaseAt: 0,
      generation: ((existing as SchemaConvertRunDoc | null)?.generation ?? 0) + 1,
    };
  }
  // Unleased: the background pass (or a tick, or another process) takes it by the one atomic step, so exactly one sweeps it.
  doc.sweepLeaseAt = 0;
  delete doc.retryAt;
  delete doc.error;
  await runs(spaceId).replaceOne(asFilter<SchemaConvertRunDoc>({ _id: RUN_ID }), doc, { upsert: true });
  runInBackground(spaceId, deps);
  watcher.start();
  return { ok: true, state: unfinished(existing) ? 'restarted' : 'started', run: doc };
}

/**
 * Restart the unfinished run of `spaceId` toward the fingerprint the space has now, in place, with nothing new joined: what a door that changes a
 * schema and takes no steps asks. Answers whether there was a run to restart.
 *
 * The restarted document is written with the lease RELEASED and a pass is woken, as a start does: a pass that was sweeping the old generation
 * stops at its next step (the generation moved) and writes nothing more for it, and the restarted run is taken at once by the one background job
 * of the space (a pass already running there is joined, never doubled), never left until the old lease goes stale. A page restarting its own
 * run keeps its lease instead (`restartInPlace`).
 */
export async function restartSchemaConvertRun(spaceId: string): Promise<boolean> {
  const run = await runs(spaceId).findOne(asFilter<SchemaConvertRunDoc>({ _id: RUN_ID })) as SchemaConvertRunDoc | null;
  if (!unfinished(run)) return false;
  const now = readMetaForWrite(spaceId);
  const next = restartedSchemaConvertRun(run, { toFp: now.stamp.fp, after: now.meta as ConversionMeta | undefined, at: new Date().toISOString() });
  next.sweepLeaseAt = 0;
  delete next.retryAt;
  const done = await runs(spaceId).replaceOne(asFilter<SchemaConvertRunDoc>({ _id: RUN_ID, generation: run.generation }), next);
  if (done.matchedCount === 1) {
    runInBackground(spaceId);
    watcher.start();
  }
  return true;
}

/** Rewrite `run` in place toward the fingerprint now, keeping the lease the caller holds; answers the new document, or null when it moved. */
async function restartInPlace(spaceId: string, run: SchemaConvertRunDoc): Promise<SchemaConvertRunDoc | null> {
  const now = readMetaForWrite(spaceId);
  const next = restartedSchemaConvertRun(run, { toFp: now.stamp.fp, after: now.meta as ConversionMeta | undefined, at: new Date().toISOString() });
  const done = await runs(spaceId).replaceOne(asFilter<SchemaConvertRunDoc>({ _id: RUN_ID, generation: run.generation }), next);
  return done.matchedCount === 1 ? next : null;
}

// ── One pass ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Take the run's lease: matches only a running run whose lease is stale or absent, and answers the run as it is now. `null`: not ours to sweep. */
async function takeLease(spaceId: string): Promise<SchemaConvertRunDoc | null> {
  const now = Date.now();
  return await runs(spaceId).findOneAndUpdate(
    asFilter<SchemaConvertRunDoc>({ _id: RUN_ID, state: 'running', sweepLeaseAt: { $not: { $gte: now - SWEEP_LEASE_STALE_MS } } }),
    asUpdate<SchemaConvertRunDoc>({ $set: { sweepLeaseAt: now } }),
    { returnDocument: 'after' },
  ) as SchemaConvertRunDoc | null;
}

/** Update the run of generation `generation` only: a sweeper whose run was rewritten in place writes nothing. Answers whether it matched. */
async function updateRun(spaceId: string, generation: number, update: Record<string, unknown>): Promise<boolean> {
  const done = await runs(spaceId).updateOne(asFilter<SchemaConvertRunDoc>({ _id: RUN_ID, generation }), asUpdate<SchemaConvertRunDoc>(update));
  return done.matchedCount === 1;
}

/** The peers a first sync asks: the distinct members of every network holding the space, other than this instance, that it pulls from. */
function peersToAsk(spaceId: string): string[] {
  const cfg = getConfig();
  const peers = new Set<string>();
  for (const net of cfg.networks ?? []) {
    if (!net.spaces.includes(spaceId)) continue;
    for (const m of net.members) if (m.instanceId !== cfg.instanceId && exchangeDirections(net, m).shouldPull) peers.add(m.instanceId);
  }
  return [...peers].sort();
}

/** A peer's rows say it answered: its turn ended in an exchange (`success`, `catching-up`, `records-refused`). */
const ANSWERED = new Set(['success', 'catching-up', 'records-refused']);

/**
 * The first sync (design 5.3 step 0): one sync of each peer, together, each waited for; a peer that throws or did not answer is asked and not
 * answered, and holds nothing up. The lease is renewed as each peer's turn ends.
 */
async function syncFirst(spaceId: string, run: SchemaConvertRunDoc, syncPeer: SchemaConvertSyncPeer): Promise<{ asked: number; answered: number }> {
  if (!run.sources.some(s => s.kind === 'write' || s.kind === 'round')) return { asked: 0, answered: 0 };
  const peers = peersToAsk(spaceId);
  const answers = await Promise.all(peers.map(async (peerId) => {
    let answered = false;
    try {
      // A sync is bounded by the peer's own request timeouts, as the manual trigger is: never by the pass's per-operation figure.
      const answer = await outsideWriteBound(() => syncPeer(peerId, { wait: true }));
      const rows = Array.isArray(answer.body['members']) ? answer.body['members'] as { outcome?: unknown }[] : [];
      answered = answer.body['status'] === 'completed' && rows.some(r => typeof r.outcome === 'string' && ANSWERED.has(r.outcome));
    } catch { /* a peer that cannot be reached is asked and not answered: it receives the converted records at its next sync */ }
    await updateRun(spaceId, run.generation, { $set: { sweepLeaseAt: Date.now() } });
    return answered;
  }));
  return { asked: peers.length, answered: answers.filter(Boolean).length };
}

/**
 * The page a run reads of type `type` of `kind` (`*`: every record of the kind) toward `toFp`: every copy that is not a fork and does not carry
 * `toFp`, in `_id` order, served by the `(type field, _id)` index (`spaces/space-indexes.ts`, `SCHEMA_CONVERT_INDEX`).
 */
export function schemaConvertPageSpec(spaceId: string, kind: KnowledgeType, type: string, toFp: string): IdPageSpec {
  return {
    collection: spaceCollection(spaceId, COLLECTION_SUFFIX[kind]),
    filter: { ...(type === '*' ? {} : { [TYPE_FIELD[kind]]: type }), ...CHOSEN_VERSION_ROWS, [SCHEMA_FINGERPRINT_FIELD]: { $ne: toFp } },
    projection: convertProjectionOf(kind),
    size: SCHEMA_CONVERT_PAGE_SIZE,
  };
}

const COUNT_OF: Record<SchemaConvertOutcome['outcome'], keyof SchemaConvertCounts> = {
  stamped: 'stamped', rewritten: 'rewritten', unconverted: 'unconverted', moved: 'moved',
};

/** Write the audit entry of a finished run: no token, its counts and types as its changes. */
function auditFinished(spaceId: string, run: SchemaConvertRunDoc): void {
  logInternalAudit({
    method: 'SWEEP', path: 'internal:schema-convert', spaceId, operation: SCHEMA_CONVERT_RUN_OPERATION, startedAt: Date.parse(run.startedAt),
    changes: [
      ...(Object.keys(ZERO) as (keyof SchemaConvertCounts)[]).map(k => ({ field: k, to: run.counts[k] })),
      // The types as a list (`kind:type`), which the allowlist records as `added`, so an operator reads each type as a name and not one joined
      // string. How the run was started: the kinds of its sources, each once, in order.
      { field: 'types', added: run.types.map(t => `${t.kind}:${t.type}`) },
      { field: 'sources', to: [...new Set(run.sources.map(s => s.kind))].join(',') },
    ],
  });
}

/**
 * One pass of a run whose lease the caller holds: the first sync if it is still owed, then page after page until the run is complete, it was
 * rewritten in place by another start (its generation moved), or a page fails. A failed page records `failures`, the `error` and when the
 * tick may retry, releases the lease, and sets the run `failed` after {@link FAILED_AFTER_PASSES} unless it is owed.
 */
async function pass(spaceId: string, held: SchemaConvertRunDoc, deps: SchemaConvertDeps): Promise<SchemaConvertRunDoc | null> {
  let run: SchemaConvertRunDoc = held;
  try {
    if (run.syncedFirst === undefined) {
      const syncedFirst = await syncFirst(spaceId, run, deps.syncPeer ?? peerSyncOutcome);
      if (!await updateRun(spaceId, run.generation, { $set: { syncedFirst, sweepLeaseAt: Date.now() } })) return await readRun(spaceId);
      run = { ...run, syncedFirst };
    }
    for (;;) {
      const fresh = await readRun(spaceId);
      if (!fresh || fresh.generation !== run.generation || fresh.state !== 'running') return fresh;
      run = fresh;
      // The fingerprint moved under the run: restarted in place toward the one the space has now, and the pass goes on with it.
      if (schemaFingerprintOf(findSpace(spaceId)) !== run.toFp) {
        const restarted = await restartInPlace(spaceId, run);
        if (!restarted) return await readRun(spaceId);
        run = restarted;
        continue;
      }
      const target = run.types.find(t => !t.done);
      if (!target) {
        const finished: SchemaConvertRunDoc = { ...run, state: 'complete', finishedAt: new Date().toISOString(), cursor: null, sweepLeaseAt: 0 };
        if (!await updateRun(spaceId, run.generation, { $set: { state: 'complete', finishedAt: finished.finishedAt, cursor: null, sweepLeaseAt: 0 }, $unset: { retryAt: '' } })) {
          return await readRun(spaceId);
        }
        auditFinished(spaceId, finished);
        return finished;
      }
      const after = run.cursor && run.cursor.kind === target.kind && run.cursor.type === target.type ? run.cursor.afterId : undefined;
      const page = await idKeysetPage<ReadRecord & { _id: string }>(schemaConvertPageSpec(spaceId, target.kind, target.type, run.toFp), after);
      let outcomes: SchemaConvertOutcome[];
      try {
        outcomes = page.rows.length > 0 ? await convertRecordsPage(spaceId, run, target.kind, page.rows) : [];
      } catch (err) {
        if (!(err instanceof SchemaConvertTargetMoved)) throw err;
        continue;   // the next turn sees the moved fingerprint and restarts the run
      }
      const inc: Record<string, number> = {};
      let notListed = 0;
      let listed = run.counts.unconverted;
      const meta = readMetaForWrite(spaceId).meta;
      for (let i = 0; i < outcomes.length; i++) {
        const o = outcomes[i]!;
        const key = `counts.${COUNT_OF[o.outcome]}`;
        inc[key] = (inc[key] ?? 0) + 1;
        schemaConvertRecordsTotal.labels({ outcome: o.outcome }).inc();
        if (o.outcome === 'rewritten' && o.edgesRestamped > 0) {
          inc['counts.edgesRestamped'] = (inc['counts.edgesRestamped'] ?? 0) + o.edgesRestamped;
          schemaConvertRecordsTotal.labels({ outcome: 'edge_restamped' }).inc(o.edgesRestamped);
        }
        if (o.outcome !== 'unconverted') continue;
        if (listed >= UNCONVERTED_ITEMS_PER_RUN_MAX) { notListed++; continue; }
        listed++;
        await recordUnconvertedItem(spaceId, {
          kind: target.kind, record: page.rows[i]!, toFp: run.toFp, reason: o.reason, violations: o.violations,
          ...(o.proposed ? { proposed: { ...(o.proposed.type !== undefined ? { type: o.proposed.type } : {}), set: o.proposed.set, unset: o.proposed.unset } } : {}),
        }, meta);
      }
      if (notListed > 0) inc['unconvertedNotListed'] = notListed;
      const types = page.end ? run.types.map(t => (t.kind === target.kind && t.type === target.type ? { ...t, done: true } : t)) : run.types;
      const cursor = page.end || page.last === undefined ? null : { kind: target.kind, type: target.type, afterId: page.last };
      // The cursor, the counts and the lease in one write: a sweep that is making progress is never one a tick may take.
      if (!await updateRun(spaceId, run.generation, { $set: { cursor, types, sweepLeaseAt: Date.now() }, $unset: { retryAt: '' }, ...(Object.keys(inc).length > 0 ? { $inc: inc } : {}) })) {
        return await readRun(spaceId);
      }
      await deps.afterPage?.({ kind: target.kind, type: target.type, rows: page.rows.length });
    }
  } catch (err) {
    const current = run;
    const failures = (current.failures ?? 0) + 1;
    const givenUp = !current.owed && failures >= FAILED_AFTER_PASSES;
    reportSpaceFailure(PASS_STEP, spaceId, err, { when: givenUp ? 'with the next start' : WHEN });
    await updateRun(spaceId, current.generation, {
      $set: {
        failures, error: peerText(err instanceof Error ? err.message : String(err), { max: ERROR_TEXT_MAX }), sweepLeaseAt: 0,
        retryAt: Date.now() + backoffDelayMs(failures - 1, RETRY_BASE_MS, RETRY_CAP_MS), ...(givenUp ? { state: 'failed' } : {}),
      },
    }).catch((recordErr: unknown) => { reportSpaceFailure(PASS_STEP, spaceId, recordErr, { when: WHEN, unit: 'record the failure' }); });
    return await readRun(spaceId).catch(() => null);
  }
}

const readRun = async (spaceId: string): Promise<SchemaConvertRunDoc | null> =>
  await runs(spaceId).findOne(asFilter<SchemaConvertRunDoc>({ _id: RUN_ID })) as SchemaConvertRunDoc | null;

/**
 * One pass of the run of `spaceId`, if its lease can be taken (no other sweeper holds it): what the watcher and the background make, and what a
 * test drives one at a time. Answers the run document as the pass left it, or `null` when there was no run to take.
 */
export async function driveSchemaConvertRun(spaceId: string, deps: SchemaConvertDeps = {}): Promise<SchemaConvertRunDoc | null> {
  const held = await takeLease(spaceId);
  if (!held) return null;
  return await pass(spaceId, held, deps);
}

/** One background job per space at a time: a trigger while one runs joins it and asks one more pass after it. */
const background = createCoalescingRunner<void>();

/** Run the run of `spaceId` in the background, pass after pass while a pass leaves it running and not waiting for a retry. Never rejects. */
function runInBackground(spaceId: string, deps: SchemaConvertDeps = {}): void {
  // Out of the caller's scope (a request's hold, or the watcher's walk unit, which only kicks the run): the passes are the run's own work, each
  // database operation of them ended at the housekeeping figure, and no deadline across a pass that converts as many records as it holds.
  outsideWriteBound(() => {
    void background.run(spaceId, () => withinHousekeepingBound(async () => {
      try {
        for (;;) {
          const after = await driveSchemaConvertRun(spaceId, deps);
          if (!after || after.state !== 'running' || after.retryAt !== undefined) return;
        }
      } catch (err) {
        reportSpaceFailure(PASS_STEP, spaceId, err, { when: WHEN });
      }
    }));
  });
}

// ── Status ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The run of `spaceId` as the status doors answer it, or `null` when the space never had one. Writes nothing. */
export async function schemaConvertStatus(spaceId: string): Promise<SchemaConvertStatus | null> {
  const run = await readRun(spaceId);
  if (!run) return null;
  let left: number | null = 0;
  if (run.state === 'running') {
    try {
      for (const t of run.types.filter(x => !x.done)) {
        const spec = schemaConvertPageSpec(spaceId, t.kind, t.type, run.toFp);
        left += await col(spec.collection).countDocuments(asFilter<Record<string, unknown>>(spec.filter as Record<string, unknown>), { maxTimeMS: LEFT_COUNT_MS });
      }
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code !== MAX_TIME_EXPIRED) throw err;   // MaxTimeMSExpired: the count did not finish in its bound
      left = null;
    }
  }
  return {
    state: run.state, toFp: run.toFp, types: run.types, steps: run.steps, stepsRefused: run.stepsRefused, sources: run.sources, owed: run.owed,
    ...(run.syncedFirst ? { syncedFirst: run.syncedFirst } : {}), startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    counts: run.counts, ...(run.unconvertedNotListed ? { unconvertedNotListed: run.unconvertedNotListed } : {}), left, failures: run.failures ?? 0,
    ...(run.error ? { error: run.error } : {}),
  };
}

// ── The watcher, the boot resume ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Did the walk answer for every space it was given? Only then is a count made from it the whole truth. */
function walkAnswered(walk: WalkResult<unknown>, spaces: number): boolean {
  return !walk.storeDown && !walk.stalled && walk.outcomes.length === spaces && walk.outcomes.every(o => o.status === 'ok');
}

/**
 * One tick of the watcher, for every space: a running run nobody sweeps (its lease is stale) and whose retry time has come is taken and run in
 * the background; the stale items of a space that has any are removed (bounded per space). Exported so a test drives it instead of a timer.
 */
export async function schemaConvertRunTick(): Promise<void> {
  // A passed round's run still owed (its start crashed or failed) is started again first: an owed act is never given up (decision 12).
  startOwedRounds();
  const spaces = configuredSpaces();
  let active = 0;
  const walk = await eachSpace(WATCH_STEP, spaces, async (space) => {
    const run = await readRun(space.id);
    if (run?.state === 'running') {
      active++;
      if ((run.retryAt === undefined || run.retryAt <= Date.now()) && run.sweepLeaseAt < Date.now() - SWEEP_LEASE_STALE_MS) runInBackground(space.id);
    }
    if (await hasUnconvertedItems(space.id)) await sweepStaleUnconvertedItems(space.id);
  }, { when: WHEN });
  if (walkAnswered(walk, spaces.length)) schemaConvertRunsInProgress.set(active);
}

/** One interval for every space's run and items, armed by a start or by a boot that found a run or items, or could not tell. */
const watcher = intervalJob('Schema convert watcher', WATCH_MS, schemaConvertRunTick);

/** End the watcher's timer: for a shutdown, and for a test that drives the tick itself. A tick already running is left to finish. */
export function stopSchemaConvertWatcher(): void { watcher.stop(); }

/** Arm the watcher: after a passed round's start failed, so its tick starts the run again (`startOwedRoundConversions`). */
export function wakeSchemaConvertWatcher(): void { watcher.start(); }

/** Start every passed round's run still owed here; answers how many are owed. A failure to ask is reported, and the next tick asks again. */
function startOwedRounds(): number {
  try {
    return startOwedRoundConversions();
  } catch (err) {
    reportSpaceFailure(RESUME_STEP, '*', err, { when: WHEN, unit: 'owed round runs' });
    return 0;
  }
}

/**
 * Pick up every run this instance had when it stopped: once services start, on every boot. A run whose lease is stale is taken and continued
 * in the background; one another process holds is left to it. A space that could not be read is not a space with no run: the watcher is armed
 * whenever a run or an item was found, or any space could not be asked, and its tick does what this boot could not.
 */
export async function resumeSchemaConvertRuns(): Promise<void> {
  // A passed round's run that a crash or a failed start left unstarted is started at boot, once (the start asks whether its run already exists).
  const owedRounds = startOwedRounds();
  const spaces = configuredSpaces();
  let active = 0;
  let items = false;
  const walk = await eachSpace(RESUME_STEP, spaces, async (space) => {
    const run = await readRun(space.id);
    if (run?.state === 'running') {
      active++;
      if (run.sweepLeaseAt < Date.now() - SWEEP_LEASE_STALE_MS) runInBackground(space.id);
    }
    if (await hasUnconvertedItems(space.id)) items = true;
  }, { when: WHEN });
  const answered = walkAnswered(walk, spaces.length);
  if (active > 0 || items || !answered || owedRounds > 0) watcher.start();
  if (answered) schemaConvertRunsInProgress.set(active);
}
