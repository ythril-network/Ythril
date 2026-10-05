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
 * kind — the self-healing shape this codebase's migration rule asks for. Since 5.6.4 it also runs at every start
 * (`sweepEverySpaceAtBoot`): not a one-shot boot migration, which would need a done-marker and so new local state, but
 * the same idempotent state-sweep, so the repair does not wait for a meta write that may never come.
 *
 * ## Why this is local, and takes no seq
 *
 * The vector does not replicate — `sync/local-only-fields.ts` is the list and names the three mechanisms
 * that hold it: no `Incoming*` schema declares it, so a PUSHED document loses it to zod; the pull path
 * strips it explicitly, because it stores a document as received; and the sending side projects it away so the bytes
 * never travel. So removing one is a purely local change — no tombstone, no seq bump, nothing to converge.
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
 *
 * ## When it runs, and what it covers (`Q-230`, `Q-361` item 11)
 *
 * - **After EVERY write of a space's effective meta**, from `updateSpace` (`spaces/spaces.ts`) — the one writer of
 *   `space.meta` — so an operator's edit, a schema route's (on a space no network carries too), a passed vote's and a
 *   network layer arriving all reach it. The callers used to ask for themselves, which swept a vote-applied change
 *   twice and a network layer not at all. Coalesced per space (`sweepAfterMetaWrite`).
 * - **At every start**, once the server listens, over EVERY concrete space and one space at a time
 *   (`sweepEverySpaceAtBoot`): the repair for vectors stranded before this version swept files, removed the model
 *   name, or heard of a network's suppression. A space with no meta is swept too — the record tier needs none, since a
 *   record's own flag suppresses it wherever the config says nothing.
 * - **Files and their derived rows.** A file has two tiers, its own flag and the space: the space tier reaches every
 *   file row that holds a vector, the record tier a flagged file and every row derived from it (`dropFileVectors`). The
 *   file filter never keys on a type a file does not have — the record kinds' filter with an undefined type field
 *   would match every row.
 * - **Each kind in its own `try`**: one collection the store refuses must not leave every kind after it holding its
 *   vectors. The failures are collected and raised once, naming every kind that failed.
 * - **In pages**: the ids of a space are read a page at a time, each page updated and its jobs retired before the next
 *   page is read, so a space of hundreds of thousands of records never holds every id — or one delete over them all,
 *   which would exceed the command size limit — at once. The cost, stated: one scan per record kind per start.
 */
import { col, asFilter } from '../db/mongo.js';
import { log, peerText } from '../util/log.js';
import { TYPE_FIELD } from './ttl.js';
import { recordNotSuppressedFilter, RECORD_SUPPRESS_FIELD } from './suppress-embeddings.js';
import type { BrainEmbedRecordType, KnowledgeType, SpaceMeta } from '../config/types.js';
import { COLLECTION_SUFFIX } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { inChunks } from '../util/chunks.js';
import { UNSET_VECTOR } from '../sync/local-only-fields.js';
import { cancelEmbedJobs } from './embed-queue.js';
import { MAX_ANCESTRY } from './embed-record.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { createCoalescingRunner } from '../sync/coalescing-runner.js';

/** The collection of each record kind: the shared map, never a hand copy of it. */
const COLLECTION = COLLECTION_SUFFIX;

/** Ids read, updated and retired per page of a sweep. */
export const SWEEP_PAGE = 1_000;

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
 * **What it removes is the vector and its model** (`UNSET_VECTOR`) — never `matchedText`: the content did not change,
 * and `matchedText` is the lexical channel's text, so removing it is a content decision, not a suppression one. It
 * removed `embedding` alone until 5.6.4, leaving the model name behind on a record with no vector.
 *
 * Reported per kind at INFO when it did anything, silent when it did not: this runs on every meta write, and a
 * line per write for a space with nothing to sweep would train the reader to skip it. The `file` kind counts rows —
 * a file and its derived rows alike.
 *
 * Every kind is swept in its own `try`; a failure is collected and thrown once at the end, naming every kind that
 * failed, for the caller's log.
 */
export async function sweepSuppressedVectors(spaceId: string, meta: SpaceMeta): Promise<number> {
  let total = 0;
  const failed: string[] = [];
  const isolated = async (kind: string, sweep: () => Promise<number>): Promise<void> => {
    try {
      const removed = await sweep();
      if (removed === 0) return;
      total += removed;
      log.info(`Suppression sweep: removed ${removed} ${peerText(kind)} vector(s) in ${peerText(spaceId)}`);
    } catch (err) {
      failed.push(`${kind} (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  for (const kind of Object.keys(COLLECTION) as KnowledgeType[]) {
    await isolated(kind, () => sweepPaged(spaceId, COLLECTION[kind], kind, suppressedWithVectorFilter(meta, kind)));
  }
  await isolated('file', () => sweepFiles(spaceId, meta));
  if (failed.length > 0) throw new Error(`the sweep failed for ${failed.join('; ')}`);
  return total;
}

/**
 * Remove the vector of every row of `part` that matches `filter`, a page of ids at a time (`SWEEP_PAGE`): the page is
 * read, updated and its jobs retired before the next is read. Paged by `_id`, not by re-reading the filter, so a row
 * the update did not take (a record un-suppressed meanwhile) cannot make the loop run for ever. Returns how many rows
 * had their vector removed.
 */
async function sweepPaged(
  spaceId: string, part: typeof COLLECTION[KnowledgeType] | 'files', jobKind: BrainEmbedRecordType, filter: Record<string, unknown>,
): Promise<number> {
  const coll = col<Record<string, unknown>>(spaceCollection(spaceId, part));
  let total = 0;
  await forEachPage(coll, filter, async (page) => {
    await coll.updateMany(asFilter({ $and: [filter, { _id: { $in: page } }] }), { $unset: UNSET_VECTOR });
    await cancelEmbedJobs(spaceId, jobKind, page);
    total += page.length;
  });
  return total;
}

/**
 * Hand `fn` each page of ids (`SWEEP_PAGE`, in `_id` order) of the rows of `coll` that match `filter`, reading a page
 * only after `fn` has finished the one before — the one spelling of the sweep's paging.
 */
async function forEachPage(
  coll: ReturnType<typeof col<Record<string, unknown>>>, filter: Record<string, unknown>,
  fn: (ids: string[]) => Promise<void>,
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const matching = after === undefined ? filter : { $and: [filter, { _id: { $gt: after } }] };
    const page = (await coll.find(asFilter(matching), { projection: { _id: 1 } }).sort({ _id: 1 }).limit(SWEEP_PAGE).toArray())
      .map(d => String(d['_id']));
    if (page.length === 0) return;
    await fn(page);
    after = page[page.length - 1];
  }
}

const WITH_VECTOR = { embedding: { $exists: true } };

/**
 * The file rows the meta suppresses that still hold a vector: every one at the space tier (parents and derived rows
 * alike, one filter, no walk), else the flagged files and the rows derived from them. A file has two tiers and no type,
 * so no filter here ever names a type field. Returns how many rows had their vector removed.
 */
async function sweepFiles(spaceId: string, meta: SpaceMeta): Promise<number> {
  if (meta.suppressEmbeddings === true) return sweepPaged(spaceId, 'files', 'file', WITH_VECTOR);
  // The record tier: a flagged file whether or not it holds a vector itself, since its derived rows may.
  const files = col<Record<string, unknown>>(spaceCollection(spaceId, 'files'));
  let total = 0;
  await forEachPage(files, { [RECORD_SUPPRESS_FIELD]: true }, async (page) => {
    total += (await dropFileVectors(spaceId, page)).length;
  });
  return total;
}

/**
 * These files, and every row derived from them down to `MAX_ANCESTRY`, hold no vector afterwards; returns the ids that
 * held one. The record tier of the sweep, and the arrival writer's for a file this instance suppresses on arrival
 * (`ingestFileMeta`, `Q-230`) — the file row's own derived fields go with its write, its chunks' here, BEFORE it.
 */
export async function dropFileVectors(spaceId: string, fileIds: readonly string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];
  const files = col<Record<string, unknown>>(spaceCollection(spaceId, 'files'));
  const reached = new Set(fileIds);
  let frontier = [...reached];
  // A caption chunk of an image extracted from a document is two levels down; nothing is deeper.
  for (let depth = 0; depth < MAX_ANCESTRY && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const part of inChunks(frontier, READ_CHUNK)) {
      const rows = await files.find(asFilter({ parentFileId: { $in: part } }), { projection: { _id: 1 } }).toArray();
      for (const r of rows) {
        const id = String(r['_id']);
        if (!reached.has(id)) { reached.add(id); next.push(id); }
      }
    }
    frontier = next;
  }
  const held: string[] = [];
  for (const part of inChunks([...reached], READ_CHUNK)) {
    const rows = await files.find(asFilter({ _id: { $in: part }, ...WITH_VECTOR }), { projection: { _id: 1 } }).toArray();
    held.push(...rows.map(r => String(r['_id'])));
  }
  for (const page of inChunks(held, SWEEP_PAGE)) {
    await files.updateMany(asFilter({ _id: { $in: page } }), { $unset: UNSET_VECTOR });
    await cancelEmbedJobs(spaceId, 'file', page);
  }
  return held;
}

/**
 * Sweep the vectors a meta write suppresses, without blocking the write on it; a failure is logged, since the sweep
 * is idempotent and the next meta write repeats it. Asked for by `updateSpace` (`spaces/spaces.ts`) — the one writer
 * of `space.meta`, so every meta change reaches it: an operator's edit, a schema route's, a passed vote's, and every
 * recompute of the effective meta (a network layer arriving, a network left, a precedence change).
 *
 * **Once per change, against the latest meta.** One change is often several writes in one turn — a vote passing on a
 * proposer that holds a layer writes its own definitions and then the layer, each through a recompute — and the
 * callers used to sweep after each, plus once more on top. So the sweep is coalesced per space
 * (`createCoalescingRunner`): it starts once this turn's writes have landed and sweeps the LAST meta written; a write
 * that lands while it runs queues one more, which sweeps that write's meta; a rerun with nothing newer does nothing.
 *
 * `meta` is undefined when the write carried no meta (a `textAnalysis`-only PATCH): suppression is read from meta
 * alone, so there is nothing to sweep (`Q-74`).
 */
export function sweepAfterMetaWrite(id: string, meta: SpaceMeta | undefined): void {
  void queueSweep(id, meta);
}

/** Queue `id`'s coalesced sweep against `meta`, settling when it has run; nothing to sweep without a meta. */
async function queueSweep(id: string, meta: SpaceMeta | undefined): Promise<void> {
  if (meta === undefined) return;
  nextSweep.set(id, meta);
  await metaSweeps.run(id, () => sweepLatestMeta(id));
}

/** Per space, the meta its next sweep runs against: the last one written and not yet swept. */
const nextSweep = new Map<string, SpaceMeta>();
const metaSweeps = createCoalescingRunner<void>();

/** One sweep of `id` against the latest meta written — after this turn's writes, so writes that land together sweep once. */
async function sweepLatestMeta(id: string): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  const meta = nextSweep.get(id);
  // A rerun the runner queued for a write this sweep already covered: nothing newer to sweep.
  if (meta === undefined) return;
  nextSweep.delete(id);
  try {
    await sweepSuppressedVectors(id, meta);
  } catch (err) {
    log.warn(`Suppression sweep failed for ${peerText(id)}: ${peerText(err)}`);
  }
}

/**
 * At every start, one sweep of every concrete space: vectors stored before this version swept files, removed the model
 * name, or heard of a network's suppression are cleared without waiting for the next meta write. Local derived fields
 * only — no seq, nothing replicated — so it is not a migration of synced data, and it is idempotent. A space with no
 * meta is swept as one that states nothing: the record tier needs none.
 *
 * **One space at a time**: each sweep is an unindexed scan per record kind, and starting every space's at once put all
 * of them in flight together on a large instance. Each is awaited before the next; a failure is the sweep's own warning
 * (`sweepLatestMeta`) and never stops the walk. The bootstrap starts it once the server listens (`afterListening`).
 */
export async function sweepEverySpaceAtBoot(): Promise<void> {
  for (const space of concreteSpaces()) {
    await queueSweep(space.id, space.meta ?? {});
  }
}
