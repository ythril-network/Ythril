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
 * The vector does not replicate — `sync/local-only-fields.ts` is the list and names the three mechanisms
 * that hold it: no `Incoming*` schema declares it, so a PUSHED document loses it to zod; the pull path
 * strips it explicitly, because it validates nothing; and the sending side projects it away so the bytes
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
 */
import { col, asFilter } from '../db/mongo.js';
import { log } from '../util/log.js';
import { TYPE_FIELD } from './ttl.js';
import { recordNotSuppressedFilter, RECORD_SUPPRESS_FIELD } from './suppress-embeddings.js';
import type { BrainEmbedRecordType, KnowledgeType, SpaceMeta } from '../config/types.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { inChunks } from '../util/chunks.js';
import { UNSET_VECTOR } from '../sync/local-only-fields.js';
import { embedJobId } from './embed-queue.js';
import { MAX_ANCESTRY } from './embed-record.js';
import { concreteSpaces } from '../spaces/proxy.js';

/** The collection suffix for each record kind, in the one place that has to agree with the schema keys. */
const COLLECTION: Record<KnowledgeType, SpacePart> = {
  fact: 'facts', entity: 'entities', edge: 'edges', chrono: 'chrono',
};

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
 * Reported per kind at INFO when it did anything, silent when it did not: this runs on every meta write, and a
 * line per write for a space with nothing to sweep would train the reader to skip it.
 */
export async function sweepSuppressedVectors(spaceId: string, meta: SpaceMeta): Promise<number> {
  let total = 0;
  const failed: string[] = [];
  const isolated = async (kind: string, sweep: () => Promise<string[]>): Promise<void> => {
    try {
      const ids = await sweep();
      if (ids.length === 0) return;
      total += ids.length;
      log.info(`Suppression sweep: removed ${ids.length} ${kind} vector(s) in ${spaceId}`);
    } catch (err) {
      failed.push(`${kind} (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  for (const kind of Object.keys(COLLECTION) as KnowledgeType[]) {
    await isolated(kind, async () => {
      const filter = suppressedWithVectorFilter(meta, kind);
      const coll = col<Record<string, unknown>>(spaceCollection(spaceId, COLLECTION[kind]));
      const ids = (await coll.find(asFilter(filter), { projection: { _id: 1 } }).toArray()).map(d => String(d['_id']));
      if (ids.length === 0) return [];
      await coll.updateMany(asFilter(filter), { $unset: UNSET_VECTOR });
      await retireJobs(spaceId, kind, ids);
      return ids;
    });
  }
  await isolated('file', () => sweepFiles(spaceId, meta));
  if (failed.length > 0) throw new Error(`the sweep failed for ${failed.join('; ')}`);
  return total;
}

/** The file rows the meta suppresses that still hold a vector — every one at the space tier, else the flagged
 *  files and the rows derived from them. Returns their ids, vectors removed and jobs retired. */
async function sweepFiles(spaceId: string, meta: SpaceMeta): Promise<string[]> {
  const files = col<Record<string, unknown>>(spaceCollection(spaceId, 'files'));
  const withVector = { embedding: { $exists: true } };
  let ids: string[];
  if (meta.suppressEmbeddings === true) {
    ids = (await files.find(asFilter(withVector), { projection: { _id: 1 } }).toArray()).map(d => String(d['_id']));
  } else {
    // The record tier: a flagged file whether or not it holds a vector itself, since its derived rows may.
    let frontier = (await files.find(asFilter({ [RECORD_SUPPRESS_FIELD]: true }), { projection: { _id: 1 } }).toArray())
      .map(d => String(d['_id']));
    const reached = new Set(frontier);
    for (let depth = 0; depth < MAX_ANCESTRY && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const part of inChunks(frontier, READ_CHUNK)) {
        const rows = await files.find(asFilter({ parentFileId: { $in: part } }), { projection: { _id: 1 } }).toArray();
        for (const r of rows) { const id = String(r['_id']); if (!reached.has(id)) { reached.add(id); next.push(id); } }
      }
      frontier = next;
    }
    ids = [];
    for (const part of inChunks([...reached], READ_CHUNK)) {
      const rows = await files.find(asFilter({ _id: { $in: part }, ...withVector }), { projection: { _id: 1 } }).toArray();
      ids.push(...rows.map(r => String(r['_id'])));
    }
  }
  for (const part of inChunks(ids, READ_CHUNK)) {
    await files.updateMany(asFilter({ _id: { $in: part } }), { $unset: UNSET_VECTOR });
  }
  await retireJobs(spaceId, 'file', ids);
  return ids;
}

/** Cancel the queued embed jobs of swept records, a chunk of ids at a time — by `embedJobId`, never a spelling of it. */
async function retireJobs(spaceId: string, recordType: BrainEmbedRecordType, ids: readonly string[]): Promise<void> {
  for (const part of inChunks(ids, READ_CHUNK)) {
    await col(spaceCollection(spaceId, 'embedJobs')).deleteMany(
      asFilter({ _id: { $in: part.map(id => embedJobId(recordType, id)) } }),
    );
  }
}

/**
 * Sweep the vectors a meta write suppresses, without blocking the write on it; a failure is logged, since the sweep
 * is idempotent and the next meta write repeats it. The one trigger every meta change goes through: an operator's
 * edit (`spaces/meta-update.ts`) and every recompute of the effective meta (`spaces/effective-meta.ts` — a network
 * layer arriving by meta pull, meta round or space addition, a network left, a precedence change), moved here from
 * meta-update in bundle-30 because the recompute is where a network's suppression lands, and nothing swept there.
 *
 * `meta` is undefined when the write carried no meta (a `textAnalysis`-only PATCH): suppression is read from meta
 * alone, so there is nothing to sweep. Both callers cast it to `SpaceMeta` instead, and the sweep then failed on
 * every such write with a warning that meant nothing (`Q-74`).
 */
export function sweepAfterMetaWrite(id: string, meta: SpaceMeta | undefined): void {
  if (meta === undefined) return;
  void sweepSuppressedVectors(id, meta)
    .catch(err => log.warn(`Suppression sweep failed for ${id}: ${err instanceof Error ? err.message : String(err)}`));
}

/**
 * At boot, one sweep of every concrete space: vectors stored before this version swept files, removed the model
 * name, or heard of a network's suppression are cleared once, without waiting for the next meta write. Local derived
 * fields only — no seq, nothing replicated — so it is not a migration of synced data, and it is idempotent.
 */
export function sweepEverySpaceAtBoot(): void {
  for (const space of concreteSpaces()) sweepAfterMetaWrite(space.id, space.meta);
}
