/**
 * "Which linked records hang off this frontier" — asked once, for both traversals.
 *
 * ## Why it is its own module
 *
 * `traverseGraph` carried three near-identical blocks, one per link class: scan the collection for records
 * whose `entityIds` meet the frontier, skip the visited, work out which frontier node each hangs off, keep
 * it. `traverseFromSeeds` — recall's expansion — needed the same three, which would have made six copies of
 * one rule in one file.
 *
 * `CLAUDE.md` names that exact shape as the defect this repo produces most, and the three copies had already
 * started to differ in the small: chrono and fact read `doc.entityIds` directly, files read
 * `(doc.entityIds ?? [])` because a filemeta record may have none. One of those is right for all three.
 *
 * ## What it deliberately does NOT do
 *
 * It does not emit nodes. A standalone traverse returns `TraverseNode`s and a recall returns records nested
 * under the seed that reached them — two shapes, correctly, because they answer different questions. What is
 * shared is the *scan*: the query, the visit bookkeeping, and the choice of which frontier node is the
 * `from` of the synthetic edge. Folding the emit in too would have produced a function with a mode flag,
 * which is two functions wearing one name.
 */
import { col, asFilter } from '../db/mongo.js';
import {
  LINK_CLASSES, assertLinkRecords, linksPointingAt, linksStartingFrom, docsFromCollection,
  type LinkClass, type LinkEnd,
} from './link-adjacency.js';
import type { ChronoEntry, FactDoc, FileMetaDoc } from '../config/types.js';

/**
 * The shape both scans read a FROM record as: an id plus whichever of the three arrays the class names.
 *
 * Indexed rather than three optional fields, because the field is chosen by `cls.field` at run time and a
 * closed shape here would mean casting at every access — which is how `entityIds` came to be hardcoded in
 * both scans while five of the six classes are named through something else.
 */
type LinkRow = { _id: string } & Record<string, unknown>;

/** A record reached through a link rather than an edge. */
export interface LinkedRecord {
  /** Which class reached it — also what `TraverseNode.kind` and the nested `node.kind` report. */
  kind: LinkClass['kind'];
  /** The synthetic edge's label, taken from the class so the two cannot drift. */
  label: string;
  /** The record, holding only its class's projection. */
  doc: ChronoEntry | FactDoc | FileMetaDoc;
  /** The frontier entity it hangs off — the `from` of the synthetic edge. */
  via: string;
}

/**
 * Which link classes a walk follows.
 *
 * Three booleans rather than a set of kinds, because that is how both doors already spell it and how the
 * standalone `traverse` tool has always spelled it. A caller flipping one on should not have to restate the
 * other two.
 */
export interface LinkInclusion {
  includeChrono?: boolean | undefined;
  includeMemories?: boolean | undefined;
  includeFiles?: boolean | undefined;
}

/**
 * Whether this class is switched on for this walk, and — for facts — whether ALL of them or only the
 * attributed ones.
 *
 * ## Why facts have three answers and the other two have two
 *
 * A claim an AI assistant originated is stored with no vector, so nothing can rank it. That is half a
 * decision: it must also ARRIVE, or it is merely hidden by a different mechanism. Owner's ruling,
 * 2026-09-19 — *"(2) fills context very often with stuff thats not interesting"* and excluding it hides
 * real content, so: never ranked, but reached as context.
 *
 * Reaching it means following `fact.entityIds`, and that class is off by default for a reason written into
 * the schema: *"a match is counted with its whole `_graph` subtree, so every record admitted by default is
 * paid for in matches that no longer fit."* Turning it on wholesale would drag every linked fact into
 * every answer, which is the cost the ruling was about.
 *
 * So the default admits the class NARROWED to attributed records. It is bounded rather than exhaustive
 * because `attributed` is a DECLARED property, which makes it a native index pre-filter instead of a scan.
 *
 * ## `false` still means false, and that is why absent and false are kept apart
 *
 * `undefined` is *"you did not say"* and gets the attributed context. An explicit `includeMemories: false`
 * is *"I said no"* and gets nothing — otherwise the flag would stop meaning what its own description says,
 * which is worse than the gap it closes. `parseTraverseOption` preserves the difference already.
 */
export type FactInclusion = 'all' | 'attributedOnly' | 'none';

function included(cls: LinkClass, inc: LinkInclusion): boolean {
  if (cls.kind === 'chrono') return inc.includeChrono === true;
  if (cls.kind === 'fact') return factInclusion(inc) !== 'none';
  return inc.includeFiles === true;
}

/** How much of the fact class this walk follows. Exported so a caller can explain what it will get. */
export function factInclusion(inc: LinkInclusion): FactInclusion {
  if (inc.includeMemories === true) return 'all';
  if (inc.includeMemories === false) return 'none';
  return 'attributedOnly';
}

/** The narrowing a fact scan carries when only attributed claims are wanted. */
const ATTRIBUTED_ONLY = { 'properties.attributed': true } as const;

/**
 * Whether an explicit `edgeLabels` filter admits this class's synthetic label.
 *
 * An explicit filter excludes a link unless it names it — otherwise asking for `depends_on` would quietly
 * return chrono entries too, and a filter that cannot exclude something is not a filter. No filter, or an
 * empty one, means every label.
 */
function labelWanted(cls: LinkClass, edgeLabels?: readonly string[] | undefined): boolean {
  return !edgeLabels || edgeLabels.length === 0 || edgeLabels.includes(cls.label);
}

/** What one scan found, and whether the database stopped handing documents over before it ran out. */
interface FoundRecords {
  /**
   * `via` is the FRONTIER id this record was reached from, and it comes off the link row.
   *
   * It used to be recomputed by the caller, by reading the record's own array field and picking the first
   * id in it that was on the frontier. That field is gone in 5.0, and the fallback it had — `frontier[0]`
   * — is a synthetic edge drawn from the wrong node, which reads as a real relationship rather than as a
   * missing value. So the row carries it: the row is what actually knows.
   */
  found: Array<{ cls: LinkClass; doc: LinkRow; via: string }>;
  capped: boolean;
}

/**
 * The link-record path: rows already fetched, turned into the records they name.
 *
 * **One document fetch per COLLECTION, not per class.** A file has three classes and a chrono entry two, so
 * fetching per class reads the same document two or three times — and that repetition, six link queries
 * deep, is what measured 3.8× slower than the arrays this replaced.
 *
 * A row can satisfy more than one class only if two classes share a `(fromKind, toKind)` pair, which none
 * do — so each row maps to exactly one class, and the record it names is emitted once per class that
 * claimed it.
 */
async function linkedRecordsFromRows(
  mid: string, rows: readonly LinkEnd[], wanted: readonly LinkClass[], remaining: number | undefined,
  attributedOnly: ReadonlySet<LinkClass>,
): Promise<FoundRecords> {
  // A cursor that came back FULL is the case that hides: the database stopped reading, so there may be
  // more behind it — and that is true however many of these survive the class filter and the visited set.
  const capped = remaining !== undefined && rows.length >= remaining;

  const byPair = new Map<string, LinkClass>();
  for (const c of wanted) byPair.set(`${c.kind}>${c.toKind}`, c);

  /** Which ids each COLLECTION must be asked for, and which class each id was claimed by. */
  const idsPerCollection = new Map<LinkClass['collection'], Set<string>>();
  const classOfId = new Map<string, LinkClass[]>();
  /** `${recordId}>${fromKind}>${toKind}` → the frontier id the row reached it from. */
  const viaOf = new Map<string, string>();
  for (const r of rows) {
    const cls = byPair.get(`${r.fromKind}>${r.toKind}`);
    if (!cls) continue;
    let ids = idsPerCollection.get(cls.collection);
    if (!ids) { ids = new Set(); idsPerCollection.set(cls.collection, ids); }
    ids.add(r.from);
    const claimed = classOfId.get(r.from) ?? [];
    if (!claimed.includes(cls)) { claimed.push(cls); classOfId.set(r.from, claimed); }
    // FIRST row wins, matching what the array path did: it took the first id in the record's field that
    // was on the frontier. A record reached from two frontier nodes has two honest answers.
    const key = `${r.from}>${cls.kind}>${cls.toKind}`;
    if (!viaOf.has(key)) viaOf.set(key, r.to);
  }

  const found: FoundRecords['found'] = [];
  for (const [collection, ids] of idsPerCollection) {
    // The chunk exclusion rides here — a link row has no `parentFileId`, so a file link and a chunk link
    // are indistinguishable in the links collection and the narrowing has to happen against the record.
    // The narrowing is per COLLECTION here because the hydration is: a collection whose every claiming
    // class is attributed-only is read with the filter, and one with a class that wants everything is not.
    // No collection is claimed by both today — only fact classes read `facts` — and the `every` says so
    // rather than assuming it, because a class added later that shares a collection would otherwise have
    // its records silently withheld.
    const claiming = wanted.filter(c => c.collection === collection);
    const narrowed = claiming.length > 0 && claiming.every(c => attributedOnly.has(c));
    for (const doc of await docsFromCollection<LinkRow>(mid, collection, [...ids], undefined,
      narrowed ? { ...ATTRIBUTED_ONLY } : undefined)) {
      for (const cls of classOfId.get(doc._id) ?? []) {
        found.push({ cls, doc, via: viaOf.get(`${doc._id}>${cls.kind}>${cls.toKind}`) as string });
      }
    }
  }
  return { found, capped };
}

/**
 * Every linked record meeting `frontier`, across `memberIds`, for the classes this walk follows.
 *
 * **Mutates `visited`**, exactly as the edge half of a BFS does: a record reached at depth 2 must not be
 * emitted again at depth 3. Passing the caller's set rather than returning ids to merge is what keeps the
 * two halves of one walk honest about each other.
 *
 * **`frontierSet` WAS A PARAMETER and is gone in 5.0.** It existed to answer which frontier node a record
 * hangs off, by reading the record's own array field and picking the first id in it that was on the
 * frontier. That field no longer exists, and the link ROW carries the answer — so the caller no longer has
 * to hand in a set to reconstruct something the data already knows, and the `frontier[0]` fallback that
 * drew a synthetic edge from the wrong node is gone with it.
 */
export async function linkedRecordsAtFrontier(
  memberIds: readonly string[],
  frontier: readonly string[],
  visited: Set<string>,
  inclusion: LinkInclusion,
  edgeLabels?: readonly string[] | undefined,
  /**
   * The most records this scan may return — the WALK'S OWN cap, never a number chosen here.
   *
   * Without it one hub entity returns its whole mention set, once per link class, per member space, per hop.
   * The node cap does not help: it counts records after they are hydrated, so the read has already happened.
   *
   * Owner's decision 2026-08-30: reuse the cap the walk already derives from `topK` and the byte budget,
   * rather than inventing a second number nobody tunes. The
   * accepted cost is that link scans and edge scans share one budget, so a hub with thousands of mentions can
   * crowd out its edge neighbours.
   *
   * **Hitting it is reported, and the first version of this said the existing truncation reporting covered
   * it. That was false.** The limit is spent on documents that are then discarded — `.limit()` runs before the
   * `visited` check — so a hop can consume its whole budget on records already emitted and still finish BELOW
   * the walk's node cap, which is the only thing either traversal looked at. The answer came back short and
   * flagged complete. Hence `scanCapped` below.
   */
  limit?: number,
): Promise<ScanResult<LinkedRecord>> {
  const out: LinkedRecord[] = [];
  let scanCapped = false;
  if (frontier.length === 0) return { records: out, scanCapped };

  const wanted = LINK_CLASSES.filter(cls => included(cls, inclusion) && labelWanted(cls, edgeLabels));
  // Which of those are admitted only for their ATTRIBUTED records. Carried beside `wanted` rather than
  // folded into it, so every existing use of a class stays a class and only the scan reads the mode.
  const attributedOnly = new Set(
    factInclusion(inclusion) === 'attributedOnly' ? wanted.filter(c => c.kind === 'fact') : []);
  if (wanted.length === 0) return { records: out, scanCapped };

  for (const mid of memberIds) {
    const remaining = limit === undefined ? undefined : Math.max(0, limit - out.length);
    // A budget spent before every member space was read leaves whole spaces unlooked-at, not merely
    // trimmed — so this is a truncation even though nothing was thrown away here.
    if (remaining === 0) return { records: out, scanCapped: true };

    /*
     * ONE QUERY PER HOP on the link-record path, and it is the whole point of the migration working out.
     *
     * The first version asked per class — six link queries plus up to six document fetches — and MEASURED
     * 3.8× SLOWER than the array walk it replaced, for an identical answer. The indexed lookup was never
     * the cost; the round trips were. See `linksPointingAt`.
     *
     * There is ONE shape from 5.0. A space that never converted is refused rather than walked, because
     * its pre-upgrade links were only ever in the arrays this release removed — see `assertLinkRecords`.
     */
    assertLinkRecords(mid);
    const rows = await linkedRecordsFromRows(
      mid, await linksPointingAt(mid, frontier, remaining), wanted, remaining, attributedOnly);
    if (rows.capped) scanCapped = true;

    for (const { cls, doc, via } of rows.found) {
      if (visited.has(doc._id)) continue;
      visited.add(doc._id);
      // `via` comes off the LINK ROW now. It used to be recomputed here from the record's own array field
      // — `cls.field`, never a hardcoded `entityIds`, because five of the six classes are named through a
      // different one — and that field is gone. Its fallback was `frontier[0]`, a synthetic edge drawn
      // from the wrong node, which reads as a real relationship rather than as a missing value; the row
      // knows the answer, so nothing has to fall back.
      out.push({ kind: cls.kind, label: cls.label, doc: doc as unknown as LinkedRecord['doc'], via });
    }
  }
  return { records: out, scanCapped };
}

/**
 * What a bounded scan found, and whether it stopped reading before it ran out of matches.
 *
 * **`scanCapped` is "the scan stopped reading", not "the result filled up",** and only the first is knowable
 * at the cursor. The bound is spent on documents that are then discarded, so a hop can burn its whole budget
 * on records already visited and still return fewer than the walk's node cap — at which point every
 * length-based truncation check says the neighbourhood is complete. It is not, and the caller has no other
 * way to find out.
 */
export interface ScanResult<T> {
  records: T[];
  scanCapped: boolean;
}

/** One entity named by a linked record's `entityIds` — the link followed the OTHER way. */
export interface OutboundLink {
  /** The linked record the link starts from. */
  from: string;
  /** The entity it names. */
  to: string;
  /** The synthetic edge's label, the same one the backward direction uses. */
  label: string;
  /** Which class `from` belongs to. */
  kind: LinkClass['kind'];
}

/**
 * The entities that `recordIds` NAME — a link read forwards.
 *
 * ## Why this direction exists at all
 *
 * A link is undirected in fact and one-way in storage: the fact holds the ids, the entity holds nothing. So
 * "which facts mention this entity" and "which entities does this fact mention" are two queries, and
 * until 3.6 the server only ever asked the first.
 *
 * That is what made a non-entity RECALL SEED a dead end. Edge endpoints are entity ids, so a fact that
 * matched semantically had no edges to follow, and `recall(traverse: n)` returned it with an empty `_graph` at
 * any depth. Both doors documented the limit and told the caller to lift the `entityIds` off the match and
 * traverse from one of those by hand — which is this query, performed by the caller because the server
 * declined to.
 *
 * Only the seeds need it. Everything the walk reaches afterwards is an entity or a leaf, so this runs once
 * rather than per hop; a general version would spend three queries a hop to find nothing.
 */
export async function entitiesLinkedFromRecords(
  memberIds: readonly string[],
  recordIds: readonly string[],
  inclusion: LinkInclusion,
  edgeLabels?: readonly string[] | undefined,
  /** The walk's own cap — see `linkedRecordsAtFrontier`'s. */
  limit?: number,
): Promise<ScanResult<OutboundLink>> {
  const out: OutboundLink[] = [];
  let scanCapped = false;
  if (recordIds.length === 0) return { records: out, scanCapped };

  const wanted = LINK_CLASSES.filter(cls => included(cls, inclusion) && labelWanted(cls, edgeLabels));
  if (wanted.length === 0) return { records: out, scanCapped };

  for (const mid of memberIds) {
    /*
     * Bounded on the RECORDS read, not on the links emitted. One record can name many others, so the two
     * are different numbers — and the read is what this bound exists to limit. The seed set is already
     * small (it is the recall's matches), so this bites only on a pathological call.
     *
     * And because those are different numbers, the budget can run out FASTER than the reads: `out` counts
     * links while the limit counts records, so a few link-dense seeds drive `remaining` to zero and return
     * before a whole later class is read. That is a truncation, and it was silent.
     */
    const remaining = limit === undefined ? undefined : Math.max(0, limit - out.length);
    if (remaining === 0) return { records: out, scanCapped: true };

    // ONE shape from 5.0: a space that never converted is refused rather than walked. See
    // `assertLinkRecords` — its pre-upgrade links were only ever in the arrays this release removed.
    assertLinkRecords(mid);
    {
      /*
       * ONE query on the `{from, fromKind, …}` index for the whole seed set, then one document read per
       * COLLECTION to apply the scope — a chunk is a filemeta record, so a chunk that names an entity would
       * otherwise be walked as if it were the file it came from.
       *
       * Per class it was six queries plus six scope reads. See `linksPointingAt` for what that measured.
       */
      const rows = await linksStartingFrom(mid, recordIds, remaining);
      if (remaining !== undefined && rows.length >= remaining) scanCapped = true;

      const byPair = new Map<string, LinkClass>();
      for (const c of wanted) byPair.set(`${c.kind}>${c.toKind}`, c);

      const idsPerCollection = new Map<LinkClass['collection'], Set<string>>();
      const claimed: Array<{ cls: LinkClass; row: LinkEnd }> = [];
      for (const r of rows) {
        const cls = byPair.get(`${r.fromKind}>${r.toKind}`);
        if (!cls) continue;
        let ids = idsPerCollection.get(cls.collection);
        if (!ids) { ids = new Set(); idsPerCollection.set(cls.collection, ids); }
        ids.add(r.from);
        claimed.push({ cls, row: r });
      }

      const admitted = new Set<string>();
      for (const [collection, ids] of idsPerCollection) {
        for (const d of await docsFromCollection<{ _id: string }>(mid, collection, [...ids])) {
          admitted.add(d._id);
        }
      }
      for (const { cls, row } of claimed) {
        if (admitted.has(row.from)) out.push({ from: row.from, to: row.to, label: cls.label, kind: cls.kind });
      }
    }
  }
  return { records: out, scanCapped };
}

/**
 * The display name for a non-entity record, by kind.
 *
 * A chrono has a `title`, a fact a `fact`, a file a `path` — three fields meaning one thing to a reader of
 * a graph, and the mapping was written out at each of the three emit sites.
 *
 * **Keyed on `(kind, doc)` rather than on a `LinkedRecord`, and that widening is the point.** A record
 * reached through an EXPLICIT edge is the same record reached through an implicit link, and it is not a
 * `LinkedRecord` — it has no `via` and no synthetic label. Taking the wrapper meant the explicit path could
 * not call this, which is how a second copy of the mapping gets written.
 */
export function recordDisplayName(kind: LinkClass['kind'], doc: ChronoEntry | FactDoc | FileMetaDoc): string {
  if (kind === 'chrono') return (doc as ChronoEntry).title;
  if (kind === 'fact') return (doc as FactDoc).fact;
  return (doc as FileMetaDoc).path;
}

/**
 * The `type` a non-entity record reports.
 *
 * Empty for a file, which has none — borrowing `kind` for it would invent data. Empty for an undeclared
 * fact type for the same reason.
 */
export function recordDisplayType(kind: LinkClass['kind'], doc: ChronoEntry | FactDoc | FileMetaDoc): string {
  if (kind === 'chrono') return (doc as ChronoEntry).type;
  if (kind === 'fact') return (doc as FactDoc).type ?? '';
  return '';
}
