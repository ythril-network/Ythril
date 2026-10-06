/**
 * After a space's meta is written, no record that resolves to suppressed still holds a vector.
 *
 * ## The promise this keeps
 *
 * `docs/userguide/02-brain.md` says it in the present tense: *"What it does is remove the record's embedding,
 * not hide the record."* It did not. The eleven write paths consult the flag, so a record written **after** it
 * was set never gets a vector — but nothing ever looked at records that already existed, and they kept
 * competing on meaning indefinitely. A promise the product makes and the code does not keep is a defect
 * rather than a missing feature, which is what settled the direction here.
 *
 * The same page is precise about the other direction — *"Turning suppression off does not go back and embed
 * what was written while it was on. Use the space's Reindex control"* — so only turning it ON is in scope.
 *
 * ## Why the sweep is unconditional rather than a before/after diff
 *
 * "Compute what NEWLY became suppressed" is the obvious shape and it is wrong, precisely because nothing ever
 * swept. A type whose schema has carried `suppressEmbeddings: true` for months still holds vectors for every
 * record written before the flag was set — and a diff would skip exactly that population, the one the defect
 * created, healing only spaces that happen to be edited twice.
 *
 * So the rule is a state, not an event: after a meta write, nothing suppressed still has a vector. Idempotent,
 * cheap when there is nothing to do, and it converges the historical backlog on the next meta write of any
 * kind — the self-healing shape this codebase's migration rule asks for rather than a one-shot boot migration.
 *
 * ## Why this is local, and takes no seq
 *
 * The vector does not replicate — `sync/local-only-fields.ts` is the list and names the mechanisms that hold
 * it: no `Incoming*` schema declares it, so an arriving document, pushed or pulled, loses it to the one
 * validation step (`sync/arrival-shape.ts`); the arrival writer drops it besides; and the sending side
 * projects it away so the bytes never travel. So removing one is a purely local change — no tombstone, no seq
 * bump, nothing to converge.
 *
 * This paragraph used to say `api/sync/docs.ts` *"strips `embedding` before sending, in all five places"*.
 * There was no such strip in that file and there never had been: the push path dropped it by OMISSION and
 * the pull path did not drop it at all. A mechanism named in prose is not a mechanism.
 * Bumping seq would replicate a no-op and re-send whole documents for a field the other side never receives.
 *
 * Each peer runs its own sweep when the meta reaches it, which is what makes that correct rather than merely
 * convenient: the meta replicates, so every peer performs the same local consequence of it.
 *
 * ## The tier rule, and the half that is easy to invert
 *
 * `record > schema > space`. **At the RECORD tier a `false` means "not stated"** and falls through — which is
 * why `recordSuppression()` returns `true | undefined` and never `false`. **At the SCHEMA tier a `false` DOES
 * override** the space. Conflating the two would either spare every record anybody had ever explicitly
 * un-suppressed, or sweep a type whose schema deliberately opted out.
 */
import { col, asFilter } from '../db/mongo.js';
import { log, peerText } from '../util/log.js';
import { TYPE_FIELD } from './ttl.js';
import { recordNotSuppressedFilter, RECORD_SUPPRESS_FIELD } from './suppress-embeddings.js';
import type { KnowledgeType, SpaceMeta } from '../config/types.js';
import { COLLECTION_SUFFIX } from '../config/types.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { READ_CHUNK, readStoredById } from '../db/read-by-id.js';
import { inChunks } from '../util/chunks.js';
import { UNSET_VECTOR } from '../sync/local-only-fields.js';
import { retireEmbedJobs } from './embed-queue.js';
import { MAX_ANCESTRY } from './embed-record.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { createCoalescingRunner } from '../sync/coalescing-runner.js';
import { eachSpace } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { reportSpaceFailure } from '../util/space-failure.js';

/** The step a failed sweep is reported and counted under (`ythril_housekeeping_space_failures_total{step}`). */
const STEP = declareStep('Suppression sweep');

/**
 * The collection of each record kind: the shared map (`COLLECTION_SUFFIX`, derived from the knowledge map), never a
 * hand copy of it — a fifth knowledge type would have been missing from the copy alone (bundle-30 I6, C14).
 */
const COLLECTION: Readonly<Record<KnowledgeType, SpacePart>> = COLLECTION_SUFFIX;

/**
 * Records of `kind` that resolve to suppressed **and** still hold a vector.
 *
 * Pure, and separated from the write so the tier logic can be exercised without a database — the three tiers
 * interacting is the whole difficulty, and it is not something to discover against a live collection.
 *
 * `TYPE_FIELD` rather than a literal `'type'`: **edges key their schema on `label`** while every other kind
 * keys on `type`, and `EdgeDoc` carries both. Reading `type` for an edge finds a schema that is never there
 * and sweeps nothing, silently, for the one kind suppression was specifically widened to cover.
 */
export function suppressedWithVectorFilter(meta: SpaceMeta, kind: KnowledgeType): Record<string, unknown> {
  const field = TYPE_FIELD[kind];
  const schemas = meta.typeSchemas?.[kind] ?? {};
  const statedTrue: string[] = [];
  const stated: string[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const v = (schema as { suppressEmbeddings?: boolean } | undefined)?.suppressEmbeddings;
    if (v === undefined) continue;
    stated.push(name);
    if (v === true) statedTrue.push(name);
  }

  const or: Record<string, unknown>[] = [
    // Record tier. One spelling since `D-6`: the pre-3.1.0 name is gone, and the peer floor excludes the
    // builds that could still have written it.
    { [RECORD_SUPPRESS_FIELD]: true },
    // Schema tier, where a type states `true` outright.
    { [field]: { $in: statedTrue }, ...recordNotSuppressedFilter() },
  ];
  // Space tier, reaching only the types whose schema states NOTHING — a schema `false` overrides it.
  if (meta.suppressEmbeddings === true) {
    or.push({ [field]: { $nin: stated }, ...recordNotSuppressedFilter() });
  }

  return { embedding: { $exists: true }, $or: or };
}

/**
 * Strip the vectors, and cancel anything queued to put one back.
 *
 * The queue half is not an optimisation. `enqueueEmbedJob` may already hold a job for a record the sweep is
 * about to un-embed, and the worker would write the vector straight back within seconds — the defect
 * returning by a different route, and one that would look like the sweep had simply not run.
 *
 * **What it removes is the vector and its model** (`UNSET_VECTOR`) — never `matchedText`: the content did not
 * change, and `matchedText` is the lexical channel's text, so removing it is a content decision, not a suppression
 * one. It removed `embedding` alone until bundle-30, leaving the model name behind on a record with no vector.
 *
 * **Files and their derived rows are covered** (bundle-30): a file has two tiers, its own flag and the space, so the
 * space tier reaches every file row and the record tier a flagged file and the rows derived from it, down to
 * `MAX_ANCESTRY` (a caption chunk of an image extracted from a document is the document's too). It covered none.
 *
 * **Each kind in its own `try`**: one collection the store refuses must not leave every kind after it holding its
 * vectors. A failure is collected and thrown once at the end, naming every kind that failed, for the caller's log.
 *
 * **Except a failure that says the space is not answering** (a bound ended the read, or the store's own condition): the kinds
 * after it are named "not reached" and not tried, because each would wait out a whole bound against the same hung space. The
 * next meta write, or the next boot, sweeps them.
 *
 * Reported per kind at INFO when it did anything, silent when it did not: this runs on every meta write, and a
 * line per write for a space with nothing to sweep would train the reader to skip it.
 */
export async function sweepSuppressedVectors(spaceId: string, meta: SpaceMeta): Promise<number> {
  let total = 0;
  const failed: string[] = [];
  const causes: unknown[] = [];
  // Set by a failure that says the SPACE (or the store) is not answering rather than that one kind refused: the next kind would
  // pay another whole bound against the same hung space — `kinds x bound`, 24 minutes at the production figure.
  let notAnswering = false;
  const isolated = async (kind: string, sweep: () => Promise<string[]>): Promise<void> => {
    if (notAnswering) { failed.push(`${kind} (not reached)`); return; }
    try {
      const ids = await sweep();
      if (ids.length === 0) return;
      total += ids.length;
      log.info(`Suppression sweep: removed ${ids.length} ${peerText(kind)} vector(s) in ${peerText(spaceId)}`);
    } catch (err) {
      failed.push(`${kind} (${err instanceof Error ? err.message : String(err)})`);
      causes.push(err);
      // The one question (`db/store-condition.ts`): a bound that ended the read, or the store's own condition. A plain
      // refusal (a view, a validation failure) is one kind's and the others are still swept.
      notAnswering = storeIsNotAnswering(err);
    }
  };
  for (const kind of Object.keys(COLLECTION) as KnowledgeType[]) {
    await isolated(kind, async () => {
      const filter = suppressedWithVectorFilter(meta, kind);
      const coll = col<Record<string, unknown>>(spaceCollection(spaceId, COLLECTION[kind]));
      const ids = (await coll.find(asFilter(filter), { projection: { _id: 1 } }).toArray()).map(d => String(d['_id']));
      if (ids.length === 0) return [];
      await coll.updateMany(asFilter(filter), { $unset: UNSET_VECTOR });
      await retireEmbedJobs(spaceId, kind, ids);
      return ids;
    });
  }
  await isolated('file', () => sweepFiles(spaceId, meta));
  // An AggregateError, not an Error with the kinds in its text: the boot walk classifies what it is handed (a store that
  // does not answer, a bound that ended a read) by reading the errors an error wraps, and a summary's text hides them.
  if (failed.length > 0) throw new AggregateError(causes, `the sweep failed for ${failed.join('; ')}`);
  return total;
}

/** The file rows the meta suppresses that still hold a vector — every one at the space tier, else the flagged
 *  files and the rows derived from them. Returns their ids, vectors removed and jobs retired. */
async function sweepFiles(spaceId: string, meta: SpaceMeta): Promise<string[]> {
  const files = col<Record<string, unknown>>(spaceCollection(spaceId, 'files'));
  if (meta.suppressEmbeddings !== true) {
    // The record tier: a flagged file whether or not it holds a vector itself, since its derived rows may.
    const flagged = await files.find(asFilter({ [RECORD_SUPPRESS_FIELD]: true }), { projection: { _id: 1 } }).toArray();
    return dropFileVectors(spaceId, flagged.map(d => String(d['_id'])));
  }
  // The space tier reaches every file row, parents and derived alike: one write, no walk.
  const ids = (await files.find(asFilter(WITH_VECTOR), { projection: { _id: 1 } }).toArray()).map(d => String(d['_id']));
  if (ids.length === 0) return [];
  await files.updateMany(asFilter(WITH_VECTOR), { $unset: UNSET_VECTOR });
  await retireEmbedJobs(spaceId, 'file', ids);
  return ids;
}

const WITH_VECTOR = { embedding: { $exists: true } };

/**
 * These files, and every row derived from them down to `MAX_ANCESTRY`, hold no vector afterwards; returns the ids
 * that held one. The record tier of the sweep, and the arrival writer's for a file this instance suppresses on
 * arrival (`Q-230`) — the file row's own fields go with its write, its chunks' here.
 */
export async function dropFileVectors(spaceId: string, fileIds: readonly string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const files = col<Record<string, unknown>>(spaceCollection(spaceId, 'files'));
  const reached = new Set(fileIds);
  let frontier = [...reached];
  for (let depth = 0; depth < MAX_ANCESTRY && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const part of inChunks(frontier, READ_CHUNK)) {
      const rows = await files.find(asFilter({ parentFileId: { $in: part } }), { projection: { _id: 1 } }).toArray();
      for (const r of rows) { const id = String(r['_id']); if (!reached.has(id)) { reached.add(id); next.push(id); } }
    }
    frontier = next;
  }
  // The ones that hold a vector, through the one by-id reader.
  const ids = [...(await readStoredById(spaceCollection(spaceId, 'files'), [...reached], {}, { filter: WITH_VECTOR })).keys()];
  for (const part of inChunks(ids, READ_CHUNK)) {
    await files.updateMany(asFilter({ _id: { $in: part } }), { $unset: UNSET_VECTOR });
  }
  await retireEmbedJobs(spaceId, 'file', ids);
  return ids;
}

/**
 * Sweep the vectors a meta write suppresses, without blocking the write on it; a failure is logged, since the sweep
 * is idempotent and the next meta write repeats it. Asked for by `updateSpace` (`spaces/spaces.ts`) — the one writer
 * of `space.meta`, so every meta change reaches it: an operator's edit, a schema route's, a passed vote's, and every
 * recompute of the effective meta (a network layer arriving, a network left, a precedence change).
 *
 * **Once per change, against the latest meta.** One change is often several writes in one turn — a vote passing on
 * a proposer that holds a layer writes its own definitions and then the layer, each through a recompute — and the
 * callers used to sweep after each, plus once more on top (bundle-30 `I5`). So the sweep is coalesced per space
 * (`createCoalescingRunner`): it starts once this turn's writes have landed and sweeps the LAST meta written; a write
 * that lands while it runs queues one more, which sweeps that write's meta; a rerun with nothing newer does nothing.
 *
 * `meta` is undefined when the write carried no meta (a `textAnalysis`-only PATCH): suppression is read from meta
 * alone, so there is nothing to sweep. Both callers cast it to `SpaceMeta` instead, and the sweep then failed on
 * every such write with a warning that meant nothing (`Q-74`).
 */
export function sweepAfterMetaWrite(id: string, meta: SpaceMeta | undefined): void {
  void queueSweep(id, meta);
}

/**
 * Queue `id`'s coalesced sweep against `meta`; settles when the run it started or joined has, with the failure that run handed
 * back (see {@link sweepLatestMeta}), if any. Nothing to sweep without a meta. Not `async`: the job is started, or joined, before
 * this returns, which {@link sweepForTheWalk} relies on to mark the run it joined.
 */
function queueSweep(id: string, meta: SpaceMeta | undefined): Promise<HandedFailure | undefined> {
  if (meta === undefined) return Promise.resolve(undefined);
  nextSweep.set(id, meta);
  return metaSweeps.run(id, () => sweepLatestMeta(id));
}

/** Per space, the meta its next sweep runs against: the last one written and not yet swept. */
const nextSweep = new Map<string, SpaceMeta>();

/** What a sweep that failed hands back, when it left the saying to the walk that awaits it. */
interface HandedFailure { readonly error: unknown }
const metaSweeps = createCoalescingRunner<HandedFailure | undefined>();

/** One run of the sweep job per space, while it is in flight: the state a joining walk marks, and the job reads when it fails. */
interface SweepRun { walkAwaits: boolean }
const inFlight = new Map<string, SweepRun>();

/**
 * One sweep of `id` against the latest meta written — after this turn's writes, so writes that land together sweep once.
 *
 * ## Who says a failure: one report per failure, whichever way the sweep was reached
 *
 * The job never rejects, because the coalescing runner re-runs it for a write that landed mid-sweep with nobody awaiting the
 * rerun, and `sweepAfterMetaWrite` has no caller to throw to: a rejection there is an unhandled one. So a failure is either
 *
 *  - **said here**, through `reportSpaceFailure` (synchronous, never throws: the shared words and counter of every
 *    housekeeping step), when nothing awaits this run for a walk — a meta write, or a rerun; or
 *  - **handed back** to the boot walk that joined this run ({@link sweepForTheWalk}), which rethrows it, so `eachSpace`
 *    classifies it (a bound that ended it, a store that does not answer) and says it exactly once.
 *
 * Which of the two is decided PER RUN, by the state the joining walk marked, so a rerun (a new run, unmarked) says its own.
 */
async function sweepLatestMeta(id: string): Promise<HandedFailure | undefined> {
  const run: SweepRun = { walkAwaits: false };
  inFlight.set(id, run);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const meta = nextSweep.get(id);
    // A rerun the runner queued for a write this sweep already covered: nothing newer to sweep.
    if (meta === undefined) return undefined;
    nextSweep.delete(id);
    try {
      await sweepSuppressedVectors(id, meta);
      return undefined;
    } catch (error) {
      if (run.walkAwaits) return { error };
      // The next meta write repeats the sweep (idempotent), and so does the next boot.
      reportSpaceFailure(STEP, id, error, { when: 'with the next meta write' });
      return undefined;
    }
  } finally {
    if (inFlight.get(id) === run) inFlight.delete(id);
  }
}

/**
 * One space's sweep for the boot walk: the coalesced sweep, awaited, REJECTING with its failure so the walk that called it reads
 * it. Joins a sweep already running and marks that run as awaited by a walk, so the run hands its failure over instead of saying
 * it. Goes through the runner (not the job directly) so it still coalesces with a meta write racing the boot.
 */
async function sweepForTheWalk(id: string, meta: SpaceMeta | undefined): Promise<void> {
  // Nothing to sweep: and no run is awaited, so none may be marked (its failure would be handed to nobody).
  if (meta === undefined) return;
  const settled = queueSweep(id, meta);
  // `run` has started or joined the in-flight job synchronously: the run now registered is the one this call awaits.
  const run = inFlight.get(id);
  if (run) run.walkAwaits = true;
  const handed = await settled;
  if (handed) throw handed.error;
}

/**
 * At boot, one sweep of every concrete space: vectors stored before this version swept files, removed the model
 * name, or heard of a network's suppression are cleared once, without waiting for the next meta write. Local derived
 * fields only — no seq, nothing replicated — so it is not a migration of synced data, and it is idempotent.
 *
 * **One space at a time** (bundle-30 I8): each sweep is an unindexed scan per record kind, and starting every space's
 * at once put all of them in flight together on a large instance. Each is awaited before the next. The bootstrap starts it
 * once the server listens.
 *
 * **Walked through `eachSpace`** (`Q-274`): one space at a time (the walk's default; never a `limit`), each inside the
 * housekeeping bound, so a space whose read hangs ends at the figure instead of holding the boot sweep for as long as the driver
 * waits — the bound reaches the sweep through the walk's scope, which the job inherits when this call starts it. A space's
 * failure REACHES the walk ({@link sweepForTheWalk}), so it is said in the walk's words and the walk's rules apply: a space that
 * timed out is quarantined, a store that does not answer stops the walk, and K spaces timing out in a row stop it.
 */
export async function sweepEverySpaceAtBoot(): Promise<void> {
  await eachSpace(STEP, concreteSpaces(), async (space) => {
    await sweepForTheWalk(space.id, space.meta);
  }, { when: 'with the next meta write' });
}
