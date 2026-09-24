/**
 * The link classes, declared ONCE — and from 4.0 there are SIX of them.
 *
 * ## What a "link class" is
 *
 * An edge is a record that says HOW two things relate. A **link** says only that one record is ABOUT
 * another, and there are six ways a record can say it: a fact names entities, a chrono entry names
 * entities and facts, a file names entities, facts and chrono entries.
 *
 * A class is therefore a `(fromKind, toKind)` PAIR. It used to be keyed on the from kind alone, which was
 * exactly correct while `entityIds` was the only field anybody read and became wrong the moment a kind had
 * two — a chrono entry has two link fields and a file has three.
 *
 * ## The three that had no reader, and what that cost
 *
 * `chrono.memoryIds`, `file.memoryIds` and `file.chronoIds` have been accepted, resolvability-checked,
 * stored, replicated and documented since 3.x. **Nothing walked them.** A traverse from a fact did not
 * reach the chrono entry that named it; the scan that blocks a delete could not see them either, so deleting
 * a fact a chrono entry named was never refused, even under strict linkage.
 *
 * That was not a policy. It was three fields nobody had written a reader for, and every reader following a
 * different subset of the six is what `M-2` exists to end.
 *
 * ## ONE storage shape since 5.0, and the refusal is in this file
 *
 * A link lived in two places through 4.x: an array on the record, and a link record in the space's
 * `links` collection. 5.0 removed the arrays, so a link is one small document per connection, indexed
 * both ways — which is what makes "what points at this?" one indexed lookup instead of a collection scan
 * per class.
 *
 * What is left of the selector is a REFUSAL. `linkConversionRefusal` answers why a space cannot be read
 * for links: its walk failed, so the records that replace its arrays were never written. Reading it
 * anyway would answer "no links" for records that have plenty, and every reader would believe it.
 *
 * **All six classes are answered.** The three that never had a reader — `chrono.memoryIds`,
 * `file.memoryIds`, `file.chronoIds` — work on every converted space, which is every space that answers.
 * * ## Deliberately not a migration
 *
 * Nothing here changes what is stored, what is embedded, or what crosses a sync.
 */
import { col, asFilter } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import type { RefKind } from '../config/types-knowledge.js';
import type { LinkDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

/** One class of link: a record kind that names another record kind through one array field. */
export interface LinkClass {
  /** The record kind HOLDING the link. Matches `TraverseNode.kind`. */
  kind: 'chrono' | 'fact' | 'file';
  /** What it names. An entity is only ever a `to`; nothing hangs off an entity. */
  toKind: RefKind;
  /** Collection suffix of the FROM record: the collection is `${spaceId}_${collection}`. */
  collection: 'chrono' | 'facts' | 'files';
  /**
   * The label the synthetic edge for this link carries — `chrono.memoryIds` and its five siblings.
   *
   * DERIVED from the two kinds rather than stored, here and in `brain/links.ts` where a link record's id is
   * computed. Storing it would be a second place for the same string to live, and the label a reader shows
   * and the id a writer computes have to be the same expression or a link stops being findable by the name
   * it was created under.
   */
  label: string;
  /**
   * Extra predicate this class needs beyond the field match.
   *
   * Files carry one and the other two do not: chunk records share the file collection and are distinguished
   * only by `parentFileId`, so a scan without this counts a forty-passage document forty times.
   *
   * **It still applies when reading link RECORDS**, and that is the half that is easy to lose — a link row
   * has no `parentFileId`, so the exclusion has to happen where the file is resolved rather than in the link
   * query. See `scopedIds`.
   */
  scope: Record<string, unknown>;
  /**
   * What a STRUCTURAL read needs — never the record body.
   *
   * A traverse or an ER scan asks about shape, so it must not pay for a file's passage text or a fact's
   * full fact. Each class names the smallest projection that answers "what is this, and what does it link to".
   */
  projection: Record<string, 1>;
}

/** The 4.x array field a kind was named through — `entity` → `entityIds`. See `legacyField`. */
/*
 * THE STORED FIELD NAME IS NOT ALWAYS `${kind}Ids`, AND THE EXCEPTION IS DELIBERATE.
 *
 * This derived the field from the kind, which held while every kind's name matched its field. 5.0 renamed
 * the knowledge type `fact` to `fact` and the derivation silently followed: the code began reading and
 * writing `factIds` while every stored document carries `memoryIds`. Every existing link array would have
 * become invisible — no error, no migration, just empty arrays where the data still sits.
 *
 * It is NOT renamed to match, and that is the decision rather than an oversight. These six array fields
 * are deprecated: they are refused on write in a converted space, they REPLICATE, and they are HASHED by
 * `brain/merkle.ts`. Renaming one means migrating a hashed field on every peer — for a field whose
 * removal is already scheduled. The vocabulary is inconsistent for as long as the fields survive, and
 * that is the cheaper of the two wrongs.
 *
 * Found by `a-converted-space-refuses-an-array-write.test.js`, which derives the six from here. A grep
 * could not have found it: the name is built, not written.
 */
const STORED_FIELD: Partial<Record<RefKind, string>> = { fact: 'memoryIds' };

/**
 * The 4.x array name for a link class — a LEGACY NAME with exactly two jobs left.
 *
 * The fields are gone in 5.0. This survives because:
 *
 *  - **the link conversion still reads them off disk.** A space that never converted holds its pre-upgrade
 *    links in those arrays and nowhere else, so the migration has to know the old name. It is the one
 *    reader of stored data the types no longer declare, which is what a migration is;
 *  - **the class LABEL is built from it, and the label is an IDENTITY.** `linkIdFor` derives a link
 *    record's `_id` as a UUIDv5 over `(from, to, label, fromKind, toKind)`. Renaming `fact.entityIds` to
 *    something that does not name a dead field would re-key every link record on every instance, with
 *    tombstones and replication in between, for a cosmetic gain. **So the label is a frozen token that
 *    happens to look like a field name. Do not tidy it.**
 */
export const legacyField = (toKind: RefKind): string => STORED_FIELD[toKind] ?? `${toKind}Ids`;

/** The projection each FROM kind needs, whatever it links to. */
const PROJECTION: Record<LinkClass['kind'], Record<string, 1>> = {
  chrono: { title: 1, type: 1 },
  fact: { fact: 1, type: 1 },
  file: { path: 1, description: 1, tags: 1 },
};

/** The collection each FROM kind lives in. */
const COLLECTION: Record<LinkClass['kind'], LinkClass['collection']> = {
  chrono: 'chrono', fact: 'facts', file: 'files',
};

/** See `LinkClass.scope`: chunks share the file collection with the files they came from. */
const SCOPE: Record<LinkClass['kind'], Record<string, unknown>> = {
  chrono: {}, fact: {}, file: { parentFileId: { $exists: false } },
};

/**
 * What each record kind can name — the product fact this whole module is keyed on.
 *
 * Written out rather than derived, because it is not derivable: a fact names entities and nothing else, a
 * chrono entry names entities and facts, a file names all three. The same table drives the write door in
 * `brain/links.ts`, which reads it from there for the same reason.
 */
const NAMES: Record<LinkClass['kind'], readonly RefKind[]> = {
  chrono: ['entity', 'fact'],
  fact: ['entity'],
  file: ['entity', 'fact', 'chrono'],
};

/**
 * Every link class, ordered by FROM kind then by TO kind.
 *
 * Order matters to one caller: a traversal emits its classes in this sequence, and
 * `the-link-baseline-3x-answered-db.test.js` pins the label set it produces. `chrono` first keeps the 3.x
 * ordering of the three classes that already had readers.
 */
export const LINK_CLASSES: readonly LinkClass[] =
  (['chrono', 'fact', 'file'] as const).flatMap(kind =>
    NAMES[kind].map((toKind): LinkClass => ({
      kind,
      toKind,
      collection: COLLECTION[kind],
      label: `${kind}.${legacyField(toKind)}`,
      scope: SCOPE[kind],
      projection: PROJECTION[kind],
    })));

/**
 * The indexes a space's `links` collection needs — declared here, created in two places.
 *
 * ## Why one declaration and two callers
 *
 * `initSpace` creates them with the collection, and that only ever reaches a space NEW to the config. A
 * space upgraded from 4.x got its links collection from the CONVERSION's first insert, which creates a
 * collection and no indexes at all — so every link read on the spaces that have the most links would be
 * the one case with none. `ensureQueryIndexes` is the backfill, and it must ask for the same set or the
 * two drift in the direction nothing reports: an unindexed scan returns the right answer, slowly.
 *
 * ## What each is for
 *
 * Both directions are asked. From a record: what does this concern. From an entity: what concerns this —
 * the backlink scan that blocks a delete, once per candidate. `seq` is the sync page, exactly as every
 * other replicated collection has it: `pageBySeq` orders on it, and without the index every page a peer
 * asks for sorts the whole collection.
 *
 * The first is UNIQUE, and that is what lets the ingest path drop fork resolution: a link is
 * `(from, fromKind, to, toKind)` and nothing else, so two peers that notice the same connection have
 * written the same fact and the second write is a duplicate rather than a fork.
 */
export const LINK_INDEXES: readonly { keys: Record<string, 1>; unique?: boolean }[] = Object.freeze<
  { keys: Record<string, 1>; unique?: boolean }[]
>([
  { keys: { from: 1, fromKind: 1, to: 1, toKind: 1 }, unique: true },
  { keys: { to: 1, toKind: 1 } },
  { keys: { seq: 1 } },
]);

/**
 * The class for one `(fromKind, toKind)` pair, or `undefined` for a pair that is not a link.
 *
 * **BOTH kinds, since 4.0.** Keyed on the from kind alone it silently returned whichever class happened to be
 * declared first for that kind — the `entityIds` one — so a caller asking about `chrono.memoryIds` was
 * handed the filter for `chrono.entityIds` and scanned the wrong field with no error anywhere.
 */
export function linkClassFor(kind: RefKind | 'edge', toKind: RefKind): LinkClass | undefined {
  return LINK_CLASSES.find(c => c.kind === kind && c.toKind === toKind);
}

/** Every class a record of this kind holds — one for a fact, two for a chrono entry, three for a file. */
export function linkClassesFrom(kind: RefKind | 'edge'): readonly LinkClass[] {
  return LINK_CLASSES.filter(c => c.kind === kind);
}

/**
 * Why a space cannot be read for links, or `null` when it can.
 *
 * ## The failure it exists to make loud, and it arrives in 5.0
 *
 * With the six array fields removed there is ONE shape, so `completeLinkage` stops being a choice and
 * becomes an invariant: a space either has its links as records or it has not been converted. And a space
 * that has not been converted **still holds its pre-upgrade links in arrays that no longer exist**, so
 * reading its link records answers about what was written since the upgrade and silently drops the rest.
 *
 * The boot conversion runs for every unmarked space and deliberately **does not refuse the boot** when one
 * space's walk throws — correct, because one bad space must not stop an instance. What must not follow is
 * that space answering *"no links"* to every traversal, every backlink scan and every delete guard, which
 * is what an empty result means to each of them. So it is refused, by name, with the command that fixes it.
 *
 * ## Why it takes the space record rather than reading the config
 *
 * So the rule can be exercised. Everything else here resolves a space id through `getConfig()`, which a
 * unit test cannot drive — and the assertion that a refusal is a THROW rather than an empty array is
 * exactly the kind that gets written as a source grep and proves nothing.
 *
 * @param space the space's config record, or `undefined` when no such space is configured
 */
export function linkConversionRefusal(space: { id: string; completeLinkage?: boolean } | undefined): string | null {
  if (!space) return null;
  if (space.completeLinkage === true) return null;
  return `space '${space.id}' has no converted link records, so its connections cannot be read. The boot `
    + 'conversion runs for every space and does not stop the instance when one space fails, so this space '
    + 'was left behind by a failure that IS in the startup log. Answering with no links would be a lie '
    + 'every reader believes. Run `npm run links:convert` — a full run walks every space and marks the '
    + 'ones that finish cleanly — and read what it reports about this one.';
}

/**
 * Refuse a link read on a space whose links were never converted. See `linkConversionRefusal`.
 *
 * An unknown space is NOT this function's business — every caller has already resolved and authorised the
 * space, and turning "no such space" into a link error here would replace a clear 404 with a confusing one.
 */
export function assertLinkRecords(spaceId: string): void {
  const refusal = linkConversionRefusal(getConfig().spaces.find(s => s.id === spaceId));
  if (refusal) throw new Error(refusal);
}

/**
 * The links of one class, grouped by the record that holds them — the ER diagram's scan.
 *
 * It was `hasAnyLink`, a filter over the record's own array. With the arrays gone the question is asked of
 * the link rows, and the answer has the same shape: one entry per source record that has any link of this
 * class, each entry the ids it names.
 *
 * **The scope still applies, and it cannot be applied to a link row.** A link row has no `parentFileId`, so
 * a file link and a chunk link are indistinguishable in the links collection — the narrowing has to happen
 * against the records, which is why the ids are read back. Skipped entirely for a class with no scope, so
 * the two classes that do not need it do not pay a query.
 *
 * `limit` bounds the ROWS read, not the groups, and the caller is told whether it bit: a diagram built from
 * a truncated scan has to say so.
 */
export async function linkGroupsOfClass(
  spaceId: string, cls: LinkClass, limit: number,
): Promise<{ groups: string[][]; truncated: boolean }> {
  const rows = await col<LinkDoc>(spaceCollection(spaceId, 'links'))
    .find(asFilter<LinkDoc>({ spaceId, fromKind: cls.kind, toKind: cls.toKind }),
          { projection: { from: 1, to: 1 }, limit })
    .toArray() as Array<{ from: string; to: string }>;

  const byFrom = new Map<string, string[]>();
  for (const r of rows) {
    const ids = byFrom.get(r.from);
    if (ids) ids.push(r.to); else byFrom.set(r.from, [r.to]);
  }

  if (Object.keys(cls.scope).length > 0) {
    const admitted = new Set((await docsFromCollection<{ _id: string }>(
      spaceId, cls.collection, [...byFrom.keys()], { _id: 1 })).map(d => d._id));
    for (const from of [...byFrom.keys()]) if (!admitted.has(from)) byFrom.delete(from);
  }
  return { groups: [...byFrom.values()], truncated: rows.length >= limit };
}

/** One link row, as both batched readers below project it. */
export interface LinkEnd { from: string; fromKind: RefKind; to: string; toKind: RefKind }

/**
 * Every link row pointing AT any of `ids` — ONE query for the whole hop, not one per class.
 *
 * ## Why it is batched, measured rather than assumed
 *
 * The first version asked once per class and then fetched the named records once per class: six link
 * queries and up to six document fetches per hop, where the array walk does three collection reads. On a
 * corpus of 8 380 links a `traverse` at depth 2 measured **37.3 ms against the array path's 9.9 ms** —
 * 3.8× SLOWER, for the same answer, on the change whose whole argument was that one indexed lookup beats
 * three scans over arrays.
 *
 * The lookup was never the cost. The ROUND TRIPS were. One query on the `{to, toKind}` index returns the
 * whole hop and the classes are separated in memory, which is free by comparison.
 *
 * `Q-7` is why this was caught before release: *"a number from one version alone answers nothing"*, so the
 * pair was measured, and the pair said the opposite of what the design predicted.
 */
export async function linksPointingAt(
  spaceId: string, ids: readonly string[], limit?: number,
): Promise<LinkEnd[]> {
  const cursor = col<LinkDoc>(spaceCollection(spaceId, 'links'))
    .find(asFilter<LinkDoc>({ to: { $in: [...ids] } }),
          { projection: { from: 1, fromKind: 1, to: 1, toKind: 1 } });
  if (limit !== undefined) cursor.limit(limit);
  return await cursor.toArray() as LinkEnd[];
}

/** Every link row STARTING from any of `ids` — the mirror, on the `{from, fromKind, …}` index. */
export async function linksStartingFrom(
  spaceId: string, ids: readonly string[], limit?: number,
): Promise<LinkEnd[]> {
  const cursor = col<LinkDoc>(spaceCollection(spaceId, 'links'))
    .find(asFilter<LinkDoc>({ from: { $in: [...ids] } }),
          { projection: { from: 1, fromKind: 1, to: 1, toKind: 1 } });
  if (limit !== undefined) cursor.limit(limit);
  return await cursor.toArray() as LinkEnd[];
}

/**
 * The ids of records of one class that link to ANY of `ids` — the single-class form, for a caller with one
 * class in hand.
 *
 * Kept for the delete-blocking scan, which asks about ONE target and one class at a time and would gain
 * nothing from a batch. A traversal must use `linksPointingAt` instead: per class, per hop, this is the
 * round-trip count that made the link path 3.8× slower than the arrays it replaced.
 */
export async function linkedFromIds(
  spaceId: string, cls: LinkClass, ids: readonly string[], limit?: number,
): Promise<string[]> {
  const cursor = col<LinkDoc>(spaceCollection(spaceId, 'links'))
    .find(asFilter<LinkDoc>({ to: { $in: [...ids] }, toKind: cls.toKind, fromKind: cls.kind }),
          { projection: { from: 1 } });
  if (limit !== undefined) cursor.limit(limit);
  const rows = await cursor.toArray() as Array<{ from: string }>;
  return [...new Set(rows.map(r => r.from))];
}

/**
 * The projection one COLLECTION needs — the union of its classes' projections.
 *
 * A file has three classes and a chrono entry two, so fetching per class reads the same document twice or
 * three times. One fetch per collection needs every field any of its classes projects.
 */
export function projectionForCollection(collection: LinkClass['collection']): Record<string, 1> {
  const out: Record<string, 1> = {};
  for (const c of LINK_CLASSES) {
    if (c.collection !== collection) continue;
    for (const k of Object.keys(c.projection)) out[k] = 1;
  }
  return out;
}

/**
 * The records named by a set of ids, from ONE collection, with that collection's scope and union projection.
 *
 * The chunk exclusion lives here and not in the link query, because a link row has no `parentFileId` — a
 * file link and a chunk link are indistinguishable in the links collection.
 */
export async function docsFromCollection<T extends { _id: string }>(
  spaceId: string, collection: LinkClass['collection'], ids: readonly string[],
  /**
   * An override for a caller that only needs to know WHICH ids survived the scope.
   *
   * The delete-blocking scan is one: it reports ids and nothing else, and the union projection was sending
   * it every field of every class — a file's path, description and three arrays to answer a question about
   * membership. Measured, that alone was most of the gap between the link path and the arrays on that scan.
   */
  projection?: Record<string, 1>,
  /**
   * A further narrowing, merged into the query rather than applied to what comes back.
   *
   * Post-filtering would read every candidate and discard most of them, which spends the caller's scan
   * budget on records nobody asked for — the exact cost the narrowing exists to avoid. The one caller today
   * is the expansion admitting only ATTRIBUTED claims, and `attributed` is a declared property, so this is
   * an index pre-filter rather than a collection scan.
   */
  extra?: Record<string, unknown>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const scope = LINK_CLASSES.find(c => c.collection === collection)?.scope ?? {};
  return await col<T>(`${spaceId}_${collection}`)
    .find(asFilter<T>({ _id: { $in: [...ids] }, ...scope, ...(extra ?? {}) }),
          { projection: projection ?? projectionForCollection(collection) })
    .toArray() as T[];
}

/**
 * Narrow a set of FROM ids to the ones the class's `scope` admits, by reading the records themselves.
 *
 * This is the chunk exclusion after a link-record lookup, and it is the step that is easy to leave out: a
 * link row has no `parentFileId`, so a file link and a chunk link are indistinguishable in the links
 * collection. Without this a forty-passage document comes back as forty nodes carrying passage text — the
 * failure `LinkClass.scope` was written for, arriving through the new path instead of the old one.
 *
 * The read is not wasted: the caller wants the documents anyway, so this returns them with the class's
 * projection already applied.
 */
export async function scopedDocs<T extends { _id: string }>(
  spaceId: string, cls: LinkClass, ids: readonly string[],
): Promise<T[]> {
  if (ids.length === 0) return [];
  return await col<T>(`${spaceId}_${cls.collection}`)
    .find(asFilter<T>({ _id: { $in: [...ids] }, ...cls.scope }), { projection: cls.projection })
    .toArray() as T[];
}
