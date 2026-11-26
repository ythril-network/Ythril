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
import { notFlaggedIfFile } from '../../files/live-file-row.js';
import { readRecordsById, type RecordsById } from '../walk-reads.js';
import { NEVER_RETURNED_PROJECTION } from '../read-projection.js';
import { edgeIdFor } from '../edge-id.js';
import { tripletClause } from '../edge-lookup.js';
import { CHOSEN_VERSION_ROWS } from '../chosen-versions.js';
import { refuseForkEdit } from '../forks.js';
import { SubjectEdges, functionalSubjectKey } from '../functional-subject.js';
import { inChunks } from '../../util/chunks.js';
import { RequestRefusal } from '../../util/errors.js';
import { missingRefs } from '../entity-refs.js';
import { RECORD_COLLECTION, REF_KINDS, type RefKind } from '../../config/types-knowledge.js';
import type { EdgeDoc, LinkDoc } from '../../config/types.js';
import { MAX_LINKS_PER_KIND } from '../../util/request-bounds.js';
import type { DesiredLinks } from '../links.js';
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
  /**
   * Ids whose EXISTENCE is all that is asked — an edge's far end of a kind whose type no rule reads. Answered with the
   * ids-only read every reference check makes (`missingRefs`), so a fact or a chrono entry is not read whole to learn
   * that it is there. An id also named in `records` is answered from that read.
   */
  exist?: Partial<Record<RefKind, readonly string[]>>;
  triplets?: readonly Triplet[];
  /** Subjects whose edges under a functional label are counted. */
  functional?: ReadonlyArray<{ from: string; label: string }>;
  /** Entity names whose existing copies the insert warning counts. */
  nameTypes?: ReadonlyArray<{ name: string; type: string }>;
  /**
   * Records whose stored LINK ROWS are read (`storedLinks`): what a converge that rewrites a record's link set would take away, so a caller that
   * must take nothing away (an import, amendment A4) can pass the union.
   */
  links?: ReadonlyArray<{ fromKind: RefKind; id: string }>;
}

/** The kinds a read set can be seeded with: the records an import brings, which an edge or a link can name. */
export type SeedKind = 'entity' | 'fact' | 'chrono';

/** A record only the import holds, as much of it as a planner asks about an edge's or a link's end: its id, and an entity's type. */
export interface SeedRecord { readonly _id: string; readonly type?: string | null }

/** Per read, at most this many `$or` clauses (a by-id read is chunked by its reader). Well under every bound the probe measured. */
const CHUNK = 500;
/** The link rows one owner may hold, as every link writer holds it: the per-class cap in each class. */
const LINK_ROWS_PER_OWNER = MAX_LINKS_PER_KIND * REF_KINDS.length;

/** A triplet's key is the edge's own id — an end stated as `entity` and one left unstated are one key. */
export const tripletKey = (t: Triplet) => edgeIdFor(t.from, t.to, t.label, t.fromKind, t.toKind);
const nameTypeKey = (name: string, type: string) => `${name}\u0000${type}`;
const linkOwnerKey = (fromKind: RefKind, id: string) => `${fromKind}\u0000${id}`;
/**
 * Several wants as one — a batch's single `load`, and an inline edge set's.
 *
 * Here, beside the type it merges, because two callers asked for it (the batch door and the single-record doors'
 * pre-write check) and the second spelling is how the two would come to disagree about which of the four wants a
 * merge forgets.
 */
export function mergeWants(wants: readonly ReadWant[]): ReadWant {
  const records: NonNullable<ReadWant['records']> = {};
  const exist: NonNullable<ReadWant['exist']> = {};
  const triplets: NonNullable<ReadWant['triplets']>[number][] = [];
  const functional: NonNullable<ReadWant['functional']>[number][] = [];
  const nameTypes: NonNullable<ReadWant['nameTypes']>[number][] = [];
  const links: NonNullable<ReadWant['links']>[number][] = [];
  for (const w of wants) {
    for (const [kind, ids] of Object.entries(w.records ?? {}) as Array<[keyof typeof records, readonly string[]]>) {
      records[kind] = [...(records[kind] ?? []), ...ids];
    }
    for (const [kind, ids] of Object.entries(w.exist ?? {}) as Array<[keyof typeof exist, readonly string[]]>) {
      exist[kind] = [...(exist[kind] ?? []), ...ids];
    }
    triplets.push(...(w.triplets ?? []));
    functional.push(...(w.functional ?? []));
    nameTypes.push(...(w.nameTypes ?? []));
    links.push(...(w.links ?? []));
  }
  return { records, exist, triplets, functional, nameTypes, ...(links.length > 0 ? { links } : {}) };
}

/** What a read of a stored record does with a fork row: refuse it (a write's read), or answer it as unresolved (a look). */
export type ForkRows = 'refuse' | 'unresolved';

export class ReadSet {
  private readonly records = new Map<ReadKind, Map<string, StoredRecord | null>>();
  /** Per kind: whether an id names a stored record, for the ids only asked about (`ReadWant.exist`). */
  private readonly existence = new Map<RefKind, Map<string, boolean>>();
  private readonly triplets = new Map<string, EdgeDoc | null>();
  /** The edges held under functional labels, by subject and identity — the one counting definition (`functional-subject.ts`). */
  private readonly subjectEdges = new SubjectEdges();
  /** The functional subjects whose stored edges were read; asking about any other is a bug, not a zero. */
  private readonly loadedSubjects = new Set<string>();
  /** Per functional subject: the identities (`tripletKey`) of the held edges this batch deletes (`noteDeleted`). */
  private readonly deletedEdges = new Map<string, Set<string>>();
  /** The held edges this batch deletes, by identity (`tripletKey`), as they were stored: `deletedTriplet`. Emptied when the identity is written again. */
  private readonly deletedDocs = new Map<string, EdgeDoc>();
  private readonly nameTypeCounts = new Map<string, number>();
  /** Ids this batch minted — records that cannot appear in any stored edge or link. */
  private readonly mintedIds = new Set<string>();
  /** Per kind: the records only the import holds (`seed`), until their own plan notes them written. */
  private readonly seededIds = new Map<SeedKind, Set<string>>();
  /** Per record (`linkOwnerKey`): its stored link rows' ends, by end kind — for the records `ReadWant.links` named. */
  private readonly linkRows = new Map<string, Map<RefKind, string[]>>();
  /** The owners (`linkOwnerKey`) that hold more link rows than {@link LINK_ROWS_PER_OWNER}: their links are not held, and asking for them is refused. */
  private readonly overLinked = new Set<string>();

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
        (guard => guard && { ...guard })(notFlaggedIfFile(kind)));
      for (const id of missing) held.set(id, null);
      for (const d of docs) held.set(String(d._id), d);
    }

    for (const [kind, ids] of Object.entries(want.exist ?? {}) as Array<[RefKind, readonly string[]]>) {
      const known = this.existenceOf(kind);
      const held = this.recordsOf(kind);
      const asked = [...new Set(ids)].filter(id => !known.has(id) && !held.has(id));
      if (asked.length === 0) continue;
      const absent = new Set(await missingRefs(this.spaceId, kind, asked));
      for (const id of asked) known.set(id, !absent.has(id));
    }

    // An end this batch minted has no stored edge, so its triplet and its subject are answered without a read —
    // the rule `triplet()` and `otherEdgesFromSubject()` apply. Reading them anyway costs one query per edge on
    // the commonest batch: records and the edges between them in one call.
    const tripletsWanted = (want.triplets ?? []).filter(t => !this.triplets.has(tripletKey(t))
      && !this.mintedIds.has(t.from) && !this.mintedIds.has(t.to));
    // Each collection is reached only when something is read from it: a load that asks only about seeded or minted records reads nothing.
    const edges = () => col<EdgeDoc>(spaceCollection(this.spaceId, 'edges'));
    for (const chunk of inChunks(tripletsWanted, CHUNK)) {
      // Exact clauses, the same one `findEdgeByTriplet` reads by. One clause per triplet is one index key each.
      const found = await edges().find(asFilter<EdgeDoc>({
        spaceId: this.spaceId, $or: chunk.map(tripletClause),
      } as never), { projection: NEVER_RETURNED_PROJECTION }).toArray() as EdgeDoc[];
      for (const t of chunk) this.triplets.set(tripletKey(t), null);
      for (const e of found) this.triplets.set(tripletKey(e), e);
    }

    const subjectsWanted = (want.functional ?? []).filter(s => !this.loadedSubjects.has(functionalSubjectKey(s.from, s.label))
      && !this.mintedIds.has(s.from));
    for (const chunk of inChunks(subjectsWanted, CHUNK)) {
      // A fork edge under the label is not a second edge from the subject (`CHOSEN_VERSION_ROWS`, Q-624).
      const found = await edges().find(asFilter<EdgeDoc>({
        $or: chunk.map(s => ({ from: s.from, label: s.label })), ...CHOSEN_VERSION_ROWS,
      } as never), { projection: { _id: 1, from: 1, to: 1, label: 1, fromKind: 1, toKind: 1 } }).toArray() as EdgeDoc[];
      for (const s of chunk) this.loadedSubjects.add(functionalSubjectKey(s.from, s.label));
      for (const e of found) this.subjectEdges.add(e);
    }

    const namesWanted = (want.nameTypes ?? []).filter(n => !this.nameTypeCounts.has(nameTypeKey(n.name, n.type)));
    const entities = () => col<{ name: string; type: string }>(spaceCollection(this.spaceId, 'entities'));
    for (const chunk of inChunks(namesWanted, CHUNK)) {
      // An unchosen version carries its subject's name and type and is not another entity of them (`CHOSEN_VERSION_ROWS`, Q-624).
      const found = await entities().find(asFilter<{ name: string; type: string }>({
        spaceId: this.spaceId, $or: chunk.map(n => ({ name: n.name, type: n.type })), ...CHOSEN_VERSION_ROWS,
      } as never), { projection: { _id: 0, name: 1, type: 1 } }).toArray();
      for (const n of chunk) this.nameTypeCounts.set(nameTypeKey(n.name, n.type), 0);
      for (const e of found) {
        const k = nameTypeKey(e.name, e.type);
        this.nameTypeCounts.set(k, (this.nameTypeCounts.get(k) ?? 0) + 1);
      }
    }

    // A record this batch minted (or seeded) has no stored link rows, so it is answered without a read, as its triplets are.
    const ownersWanted = [...new Map((want.links ?? []).map(o => [linkOwnerKey(o.fromKind, o.id), o])).values()]
      .filter(o => !this.linkRows.has(linkOwnerKey(o.fromKind, o.id)) && !this.mintedIds.has(o.id));
    const links = () => col<LinkDoc>(spaceCollection(this.spaceId, 'links'));
    type Row = Pick<LinkDoc, 'from' | 'fromKind' | 'to' | 'toKind'>;
    const projection = { _id: 0, from: 1, fromKind: 1, to: 1, toKind: 1 };
    const fill = (rows: readonly Row[]): void => {
      for (const row of rows) {
        const held = this.linkRows.get(linkOwnerKey(row.fromKind, row.from));
        if (!held) continue;
        const ends = held.get(row.toKind);
        if (ends) ends.push(row.to);
        else held.set(row.toKind, [row.to]);
      }
    };
    for (const chunk of inChunks(ownersWanted, CHUNK)) {
      // Bounded by its owners: each holds at most MAX_LINKS_PER_KIND rows per class, the bound every link writer refuses past.
      const limit = chunk.length * LINK_ROWS_PER_OWNER;
      const found = await links().find(asFilter<LinkDoc>({
        spaceId: this.spaceId, $or: chunk.map(o => ({ from: o.id, fromKind: o.fromKind })),
      } as never), { projection }).limit(limit).toArray() as Row[];
      for (const o of chunk) this.linkRows.set(linkOwnerKey(o.fromKind, o.id), new Map());
      if (found.length < limit) { fill(found); continue; }
      // The chunk's limit was reached, so some owner may hold more than its share (rows that arrived by sync are not held to the cap) and
      // may have crowded another's rows out of the one limit. Read each owner under its own: an owner within its bound is read whole, one
      // over it is marked, and is never answered with the part of its links that happened to fit (`storedLinks`).
      for (const o of chunk) {
        const own = await links().find(asFilter<LinkDoc>({ spaceId: this.spaceId, from: o.id, fromKind: o.fromKind } as never), { projection })
          .limit(LINK_ROWS_PER_OWNER + 1).toArray() as Row[];
        if (own.length > LINK_ROWS_PER_OWNER) this.overLinked.add(linkOwnerKey(o.fromKind, o.id));
        else fill(own);
      }
    }
  }

  /**
   * Hold `records` as records only the import brings: an edge or a link that names one is judged as naming a record that exists, an entity's
   * `type` is its end's type, and nothing stored can be an edge from it. Anything neither stored nor seeded is still absent, and anything
   * never loaded still throws.
   *
   * Refused (throws, holding nothing) when an id is STORED, or planned by this batch: a seed would hide the stored record from every plan that
   * asks about it. The ids not already held are read once to know (through the read set's own reader, so the read is the planners' read).
   * A seeded record's own plan inserts it (`trust.ts`, `mintedRecord`), and from then on it is held as written.
   */
  async seed(kind: SeedKind, records: readonly SeedRecord[]): Promise<void> {
    const held = this.recordsOf(kind);
    const planned = records.filter(r => held.get(r._id) && !this.seeded(kind, r._id));
    if (planned.length > 0) throw new Error(`read set: cannot seed ${kind} '${planned[0]!._id}': it is stored or planned`);
    const unread = [...new Set(records.map(r => r._id))].filter(id => !held.has(id));
    if (unread.length > 0) {
      const stored = await this.read<StoredRecord>(spaceCollection(this.spaceId, RECORD_COLLECTION[kind]), unread);
      if (stored.length > 0) throw new Error(`read set: cannot seed ${kind} '${String(stored[0]!._id)}': it is stored`);
    }
    let ids = this.seededIds.get(kind);
    if (!ids) { ids = new Set(); this.seededIds.set(kind, ids); }
    for (const r of records) {
      held.set(r._id, { _id: r._id, spaceId: this.spaceId, ...(r.type !== undefined ? { type: r.type } : {}) });
      ids.add(r._id);
      this.mintedIds.add(r._id);
    }
  }

  /**
   * Take back a seed: the record the import brought will not be written (the dry plan refused it), so an edge or a link planned afterwards
   * finds it absent, as the commit will. A record that is no longer only seeded (planned) or never was is left as it is, and `false` is
   * answered. The id stays one this import minted: nothing stored can be an edge from it, whether or not it is written.
   */
  unseed(kind: SeedKind, id: string): boolean {
    if (!this.seeded(kind, id)) return false;
    this.seededIds.get(kind)!.delete(id);
    this.recordsOf(kind).set(id, null);
    return true;
  }

  /** Whether `id` is a record only the import brings, not yet planned (`seed`). */
  seeded(kind: SeedKind, id: string): boolean {
    return this.seededIds.get(kind)?.has(id) === true;
  }

  /**
   * The ends of a record's stored link rows, by end kind (an empty map: none). A record this batch minted or seeded has none. Throws when the
   * record was never named in `ReadWant.links`, as `stored` does.
   */
  storedLinks(fromKind: RefKind, id: string): DesiredLinks {
    if (this.mintedIds.has(id) && !this.linkRows.has(linkOwnerKey(fromKind, id))) return {};
    if (this.overLinked.has(linkOwnerKey(fromKind, id))) {
      throw new RequestRefusal(`the ${fromKind} '${id}' holds more links than an import reads (${LINK_ROWS_PER_OWNER}), so what it holds cannot be known whole and nothing can be converged onto it without taking links away`);
    }
    const held = this.linkRows.get(linkOwnerKey(fromKind, id));
    if (!held) throw new Error(`read set: the links of ${fromKind} '${id}' were asked about but never loaded`);
    return Object.fromEntries(held) as DesiredLinks;
  }

  /**
   * The record as stored (or as this batch has planned it), `null` when absent. Throws when never loaded.
   *
   * A FORK row is refused (`forkRow: 'refuse'`, the default): this is the one door every planner reads a stored copy through, so a save by id
   * onto one stops here (Q-624 §8, S7). A reader that only LOOKS (the arrival recorder asking what type an edge's end has) says
   * `'unresolved'` and is answered `null`, as for a record nothing holds: an unchosen version is not what an end names, and a refusal
   * meant for a write must not stop the recording of a page of arrivals (Q-443).
   */
  stored(kind: ReadKind, id: string, forkRow: ForkRows = 'refuse'): StoredRecord | null {
    const held = this.recordsOf(kind);
    if (!held.has(id)) throw new Error(`read set: ${kind} '${id}' was asked about but never loaded`);
    const row = held.get(id)!;
    if (forkRow === 'unresolved' && row && typeof row['forkOf'] === 'string') return null;
    refuseForkEdit(kind, row);
    return row;
  }

  /**
   * Every id among `ids` that names no record — the read set's answer to `assertRefsResolve`. A record this batch
   * has planned counts as there; an id asked about by existence only (`ReadWant.exist`) is answered by that read.
   * Throws when an id was never asked about, as `stored` does.
   */
  missing(kind: ReadKind, ids: readonly string[]): string[] {
    return [...new Set(ids)].filter(id => !this.exists(kind, id));
  }

  private exists(kind: ReadKind, id: string): boolean {
    const held = this.recordsOf(kind);
    if (held.get(id)) return true;
    const known = this.existence.get(kind as RefKind)?.get(id);
    if (known !== undefined) return known;
    if (held.has(id)) return false;
    throw new Error(`read set: ${kind} '${id}' was asked about but never loaded`);
  }

  /**
   * Say that this id belongs to a record nobody has stored — an inline edge's subject before its record is written.
   * Nothing stored can be an edge from it, so its triplets and its functional count are answered without a read.
   * Not a note that anything is written: the id appears in no collection and in no plan.
   */
  mint(id: string): void {
    this.mintedIds.add(id);
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

  /**
   * The stored edge of this identity that this batch DELETES (`noteDeleted`), or `null`: what a later plan of the same triplet converges onto.
   * An edge's identity is its triplet and end kinds, so an edge deleted and planned again in one batch is one record, written once (the group
   * drops the delete). `triplet` still answers `null` for it: nothing else about the deleted edge is held.
   */
  deletedTriplet(t: Triplet): EdgeDoc | null {
    return this.deletedDocs.get(tripletKey(t)) ?? null;
  }

  /** Forget what is held for these records and triplets, so the next `load` reads them as they now stand. */
  forget(records: Partial<Record<ReadKind, readonly string[]>>, triplets: readonly Triplet[] = []): void {
    for (const [kind, ids] of Object.entries(records) as Array<[ReadKind, readonly string[]]>) {
      for (const id of ids) {
        this.recordsOf(kind).delete(id);
        this.existence.get(kind as RefKind)?.delete(id);
      }
    }
    for (const t of triplets) this.triplets.delete(tripletKey(t));
  }

  /**
   * How many OTHER edges carry `edge.label` from `edge.from` — stored or planned in this batch, counted ONCE each by
   * identity, so an earlier item that updates a stored edge is not counted twice. The edge being written is
   * excluded by its identity, as `resolveEdgeEndsForWrite` excludes it: an edge is not its own duplicate. The count is
   * `SubjectEdges`' (`functional-subject.ts`), the one the store's guard agrees with.
   */
  otherEdgesFromSubject(edge: Triplet, sameBody: readonly Triplet[] = []): number {
    // A subject minted by this batch has no stored edges; only this batch's own can count.
    if (!this.loadedSubjects.has(functionalSubjectKey(edge.from, edge.label)) && !this.mintedIds.has(edge.from)) {
      throw new Error(`read set: functional subject ${edge.from} -${edge.label}-> was never loaded`);
    }
    /*
     * `sameBody`: the edges of the one write that already passed, which no read set has noted — a refusal records
     * nothing, so a second edge under the label in the same body would otherwise meet a count that cannot see the
     * first. Counted by the same identity and the same arithmetic as a stored one, so an edge both stored and
     * repeated in the body is one edge, and the edge being asked about is still not its own duplicate.
     */
    const others = this.subjectEdges.others(edge, sameBody);
    // An edge this batch deletes is held (`noteDeleted` holds it, so the subtraction is exact) and is not another edge at its subject —
    // unless the same identity is written again in this body.
    const deleted = this.deletedEdges.get(functionalSubjectKey(edge.from, edge.label));
    if (!deleted) return others;
    const own = edgeIdFor(edge.from, edge.to, edge.label, edge.fromKind, edge.toKind);
    const again = new Set(sameBody.map(e => edgeIdFor(e.from, e.to, e.label, e.fromKind, e.toKind)));
    return others - [...deleted].filter(identity => identity !== own && !again.has(identity)).length;
  }

  /**
   * Record that this batch will DELETE the stored `kind` record `id` (`planDelete`, `Q-963`, design-r2 R6). Every later question sees it gone:
   * its existence (absent), its triplet (none, so an edge of the same identity is planned as an insert) and, for an edge, its subject's
   * functional count (no longer another edge there, so a swap in one batch is not refused). An entity no longer counts under its name.
   * Throws when the record was never loaded, as `stored` does.
   */
  noteDeleted(kind: PlanKind, id: string): void {
    const held = this.recordsOf(kind);
    if (!held.has(id)) throw new Error(`read set: ${kind} '${id}' was noted deleted but never loaded`);
    const doc = held.get(id);
    held.set(id, null);
    this.existenceOf(kind as RefKind).set(id, false);
    if (!doc) return;
    if (kind === 'edge') {
      const e = doc as unknown as EdgeDoc;
      this.triplets.set(tripletKey(e), null);
      this.deletedDocs.set(tripletKey(e), e);
      this.subjectEdges.add(e);
      const key = functionalSubjectKey(e.from, e.label);
      let deleted = this.deletedEdges.get(key);
      if (!deleted) { deleted = new Set(); this.deletedEdges.set(key, deleted); }
      deleted.add(tripletKey(e));
    }
    if (kind === 'entity') {
      const k = nameTypeKey(String(doc['name']), String(doc['type']));
      if (this.nameTypeCounts.has(k)) this.nameTypeCounts.set(k, Math.max(0, this.nameTypeCounts.get(k)! - 1));
    }
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
    // A seeded record that is now planned is held as written: a second plan of it converges.
    this.seededIds.get(kind as SeedKind)?.delete(doc._id);
    if (inserted) this.mintedIds.add(doc._id);
    if (kind === 'edge') {
      const e = doc as unknown as EdgeDoc;
      // Written again after a delete of the same identity: it is at its subject once more.
      this.deletedEdges.get(functionalSubjectKey(e.from, e.label))?.delete(tripletKey(e));
      this.deletedDocs.delete(tripletKey(e));
      this.triplets.set(tripletKey(e), e);
      // A subject this batch minted was never read (it has no stored edges), so its count starts here; one that was
      // read counts what this batch plans from then on. A subject nobody asked about is held too, and read by nobody.
      this.subjectEdges.add(e);
    }
    if (kind === 'entity' && inserted) {
      const k = nameTypeKey(String(doc['name']), String(doc['type']));
      if (this.nameTypeCounts.has(k)) this.nameTypeCounts.set(k, this.nameTypeCounts.get(k)! + 1);
    }
  }

  private existenceOf(kind: RefKind): Map<string, boolean> {
    let m = this.existence.get(kind);
    if (!m) { m = new Map(); this.existence.set(kind, m); }
    return m;
  }

  private recordsOf(kind: ReadKind): Map<string, StoredRecord | null> {
    let m = this.records.get(kind);
    if (!m) { m = new Map(); this.records.set(kind, m); }
    return m;
  }
}
