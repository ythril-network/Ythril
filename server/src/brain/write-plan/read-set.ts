/**
 * What a write planner may know about the store — read once for a whole batch, and nothing read behind it.
 *
 * ## Why the planners read through this and nothing else
 *
 * A batch of 500 edges used to make about ten round trips per item: each end looked up twice, the triplet twice,
 * a functional count, an existence check. Read here, the batch is a handful of reads in total — one `$in` per
 * kind for every id it names, one `$or` of exact triplets on the unique index (measured: 500 clauses, 14–17 ms,
 * one key examined per clause), one read per functional label, one for the name+type warning.
 *
 * And a planner that read the store itself would read it WITHOUT the batch's own earlier items, so a repeated
 * triplet, a functional count or an `$ref` end would stop seeing them. The read set carries those too: a
 * planner records what it decided (`noteWritten`), and the next item asking about that record, that subject or
 * that name sees it as written.
 *
 * ## What it refuses
 *
 * A question about something nobody loaded. Answering "absent" for an id that was never read is the silent
 * wrong answer this design exists to remove, so `stored` throws instead — the caller forgot to name it in
 * `load`, and that is a bug to see rather than a record to miss.
 */
import { col, asFilter } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { NOT_A_FLAGGED_ROW } from '../../files/live-file-row.js';
import { readRecordsById, type RecordsById } from '../walk-reads.js';
import { NEVER_RETURNED_PROJECTION } from '../read-projection.js';
import { edgeIdFor } from '../edge-id.js';
import { tripletClause } from '../edge-lookup.js';
import { inChunks } from '../../util/chunks.js';
import { RECORD_COLLECTION, type RefKind } from '../../config/types-knowledge.js';
import type { EdgeDoc } from '../../config/types.js';
import type { PlanKind } from './types.js';

/** Any record the store holds, as the read returned it (never-returned fields projected away). */
export type StoredRecord = Record<string, unknown> & { _id: string; seq?: number };

/** The kinds a read set loads records of: every planned kind, plus files (an edge or link end can be one). */
export type ReadKind = PlanKind | RefKind;

/** An edge's identity, as the unique index holds it. */
export interface Triplet { from: string; to: string; label: string; fromKind?: RefKind; toKind?: RefKind }

/** Everything a batch will ask about, named up front. */
export interface ReadWant {
  records?: Partial<Record<ReadKind, readonly string[]>>;
  triplets?: readonly Triplet[];
  /** Subjects whose edges under a functional label are counted. */
  functional?: ReadonlyArray<{ from: string; label: string }>;
  /** Entity names whose existing copies the insert warning counts. */
  nameTypes?: ReadonlyArray<{ name: string; type: string }>;
}

/** Per read, at most this many `$or` clauses (a by-id read is chunked by its reader). Well under every bound the probe measured. */
const CHUNK = 500;

/** A triplet's key is the edge's own id — an end stated as `entity` and one left unstated are one key. */
export const tripletKey = (t: Triplet) => edgeIdFor(t.from, t.to, t.label, t.fromKind, t.toKind);
const subjectKey = (from: string, label: string) => `${from}\u0000${label}`;
const nameTypeKey = (name: string, type: string) => `${name}\u0000${type}`;

export class ReadSet {
  private readonly records = new Map<ReadKind, Map<string, StoredRecord | null>>();
  private readonly triplets = new Map<string, EdgeDoc | null>();
  /** Per functional subject: the edges under that label, by identity, with their `to`. */
  private readonly subjectEdges = new Map<string, Map<string, string>>();
  private readonly nameTypeCounts = new Map<string, number>();
  /** Ids this batch minted — records that cannot appear in any stored edge or link. */
  private readonly mintedIds = new Set<string>();

  constructor(readonly spaceId: string, private readonly read: RecordsById = readRecordsById) {}

  /** Read everything `want` names that is not already held. Idempotent: asking twice reads once. */
  async load(want: ReadWant): Promise<void> {
    for (const [kind, ids] of Object.entries(want.records ?? {}) as Array<[ReadKind, readonly string[]]>) {
      const held = this.recordsOf(kind);
      const missing = [...new Set(ids)].filter(id => !held.has(id));
      // Unchunked here: the by-id reader chunks (and bounds) its own reads — a second loop around it only split
      // one read set into more round trips (bundle-30 I6, C2).
      if (missing.length === 0) continue;
      // The batch door's twin of `missingRefs`: without the predicate a batch accepts a deleted file as a link
      // target where the single-write doors refuse it.
      const docs = await this.read<StoredRecord>(spaceCollection(this.spaceId, RECORD_COLLECTION[kind]), missing,
        kind === 'file' ? { ...NOT_A_FLAGGED_ROW } : undefined);
      for (const id of missing) held.set(id, null);
      for (const d of docs) held.set(String(d._id), d);
    }

    // An end this batch minted has no stored edge, so its triplet and its subject are answered without a read —
    // the rule `triplet()` and `otherEdgesFromSubject()` apply. Reading them anyway costs one query per edge on
    // the commonest batch: records and the edges between them in one call.
    const tripletsWanted = (want.triplets ?? []).filter(t => !this.triplets.has(tripletKey(t))
      && !this.mintedIds.has(t.from) && !this.mintedIds.has(t.to));
    const edges = col<EdgeDoc>(spaceCollection(this.spaceId, 'edges'));
    for (const chunk of inChunks(tripletsWanted, CHUNK)) {
      // Exact clauses, the same one `findEdgeByTriplet` reads by. One clause per triplet is one index key each.
      const found = await edges.find(asFilter<EdgeDoc>({
        spaceId: this.spaceId, $or: chunk.map(tripletClause),
      } as never), { projection: NEVER_RETURNED_PROJECTION }).toArray() as EdgeDoc[];
      for (const t of chunk) this.triplets.set(tripletKey(t), null);
      for (const e of found) this.triplets.set(tripletKey(e), e);
    }

    const subjectsWanted = (want.functional ?? []).filter(s => !this.subjectEdges.has(subjectKey(s.from, s.label))
      && !this.mintedIds.has(s.from));
    for (const chunk of inChunks(subjectsWanted, CHUNK)) {
      const found = await edges.find(asFilter<EdgeDoc>({
        $or: chunk.map(s => ({ from: s.from, label: s.label })),
      } as never), { projection: { _id: 1, from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 } }).toArray() as EdgeDoc[];
      for (const s of chunk) this.subjectEdges.set(subjectKey(s.from, s.label), new Map());
      for (const e of found) this.subjectEdges.get(subjectKey(e.from, e.label))?.set(tripletKey(e), e.to);
    }

    const namesWanted = (want.nameTypes ?? []).filter(n => !this.nameTypeCounts.has(nameTypeKey(n.name, n.type)));
    const entities = col<{ name: string; type: string }>(spaceCollection(this.spaceId, 'entities'));
    for (const chunk of inChunks(namesWanted, CHUNK)) {
      const found = await entities.find(asFilter<{ name: string; type: string }>({
        spaceId: this.spaceId, $or: chunk.map(n => ({ name: n.name, type: n.type })),
      } as never), { projection: { _id: 0, name: 1, type: 1 } }).toArray();
      for (const n of chunk) this.nameTypeCounts.set(nameTypeKey(n.name, n.type), 0);
      for (const e of found) {
        const k = nameTypeKey(e.name, e.type);
        this.nameTypeCounts.set(k, (this.nameTypeCounts.get(k) ?? 0) + 1);
      }
    }
  }

  /** The record as stored (or as this batch has planned it), `null` when absent. Throws when never loaded. */
  stored(kind: ReadKind, id: string): StoredRecord | null {
    const held = this.recordsOf(kind);
    if (!held.has(id)) throw new Error(`read set: ${kind} '${id}' was asked about but never loaded`);
    return held.get(id)!;
  }

  /** Every id among `ids` that names no record — the read set's answer to `assertRefsResolve`. */
  missing(kind: ReadKind, ids: readonly string[]): string[] {
    return [...new Set(ids)].filter(id => this.stored(kind, id) === null);
  }

  /**
   * The stored edge with this identity, or `null`. Throws when never loaded — except for an end this batch
   * minted: no stored edge can name a record that did not exist until a moment ago, so that answer needs no read.
   */
  triplet(t: Triplet): EdgeDoc | null {
    const k = tripletKey(t);
    if (!this.triplets.has(k)) {
      if (this.mintedIds.has(t.from) || this.mintedIds.has(t.to)) return null;
      throw new Error(`read set: triplet ${t.from} -${t.label}-> ${t.to} was never loaded`);
    }
    return this.triplets.get(k)!;
  }

  /** Forget what is held for these records and triplets, so the next `load` reads them as they now stand. */
  forget(records: Partial<Record<ReadKind, readonly string[]>>, triplets: readonly Triplet[] = []): void {
    for (const [kind, ids] of Object.entries(records) as Array<[ReadKind, readonly string[]]>) {
      for (const id of ids) this.recordsOf(kind).delete(id);
    }
    for (const t of triplets) this.triplets.delete(tripletKey(t));
  }

  /**
   * How many OTHER edges carry `label` from `from` — stored or planned in this batch, counted ONCE each by
   * identity, so an earlier item that updates a stored edge is not counted twice. The edge being written is
   * excluded by its `to`, as `resolveEdgeEndsForWrite` excludes it: an edge is not its own duplicate.
   */
  otherEdgesFromSubject(from: string, label: string, to: string): number {
    // A subject minted by this batch has no stored edges; only this batch's own can count.
    if (!this.subjectEdges.has(subjectKey(from, label)) && this.mintedIds.has(from)) {
      this.subjectEdges.set(subjectKey(from, label), new Map());
    }
    const edges = this.subjectEdges.get(subjectKey(from, label));
    if (!edges) throw new Error(`read set: functional subject ${from} -${label}-> was never loaded`);
    let n = 0;
    for (const target of edges.values()) if (target !== to) n++;
    return n;
  }

  /** How many entities named `name` with `type` exist — stored, plus this batch's earlier inserts. */
  entitiesNamed(name: string, type: string): number {
    const k = nameTypeKey(name, type);
    if (!this.nameTypeCounts.has(k)) throw new Error(`read set: entity name '${name}' (${type}) was never loaded`);
    return this.nameTypeCounts.get(k)!;
  }

  /**
   * Record that this batch will write `doc` as a `kind` record. Every later question about it — its existence,
   * its type as an edge end, its triplet, its subject's functional count, its name — sees it as written.
   */
  noteWritten(kind: PlanKind, written: { _id: string }, inserted: boolean): void {
    const doc = written as StoredRecord;
    this.recordsOf(kind).set(doc._id, doc);
    if (inserted) this.mintedIds.add(doc._id);
    if (kind === 'edge') {
      const e = doc as unknown as EdgeDoc;
      this.triplets.set(tripletKey(e), e);
      const sk = subjectKey(e.from, e.label);
      // A subject this batch minted was never read (it has no stored edges), so its count starts here.
      if (!this.subjectEdges.has(sk) && this.mintedIds.has(e.from)) this.subjectEdges.set(sk, new Map());
      this.subjectEdges.get(sk)?.set(tripletKey(e), e.to);
    }
    if (kind === 'entity' && inserted) {
      const k = nameTypeKey(String(doc['name']), String(doc['type']));
      if (this.nameTypeCounts.has(k)) this.nameTypeCounts.set(k, this.nameTypeCounts.get(k)! + 1);
    }
  }

  private recordsOf(kind: ReadKind): Map<string, StoredRecord | null> {
    let m = this.records.get(kind);
    if (!m) { m = new Map(); this.records.set(kind, m); }
    return m;
  }
}
