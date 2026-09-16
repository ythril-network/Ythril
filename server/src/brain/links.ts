/**
 * Link records — the one place they are written, and the one place they are removed.
 *
 * ## What a link record is
 *
 * Six public array fields say that one record concerns others: `memory.entityIds`, `chrono.entityIds`,
 * `chrono.memoryIds`, and `file.entityIds`/`memoryIds`/`chronoIds`. `M-2` stores each entry as its own small
 * record in the space's `links` collection, so that the five adjacency readers — which each followed a
 * different subset of those six fields — have one place to look. Owner's design, 2026-08-29: *"make all
 * edges on 'index cards' and make everyone look there from now on"*.
 *
 * A link is a COLLECTION and not a knowledge type — ruled by the owner 2026-09-03 after the alternative was
 * priced. `todo/_REFERENCE.md` carries the argument and what the other design would have cost.
 *
 * ## ONE function, because the alternative is this repo's most expensive defect
 *
 * Nine write paths touch those six arrays, and every REST route and MCP tool delegates to one of three
 * writer functions rather than writing an array itself. So the hook is `reconcileLinks`, called from those
 * three, and nothing else in the codebase may write to a links collection. A per-writer copy of "work out
 * what changed and add or remove rows" is the shape `CLAUDE.md` names as the one this codebase produces
 * most — and here the weaker copy would not fail, it would leave a link record describing a connection its
 * own record no longer claims.
 *
 * ## Why it RECONCILES rather than adding and deleting
 *
 * A caller does not tell us what changed — the arrays are replaced wholesale on every write, on every one of
 * the six fields. So the only honest input is the desired end state, and the only honest operation is to make
 * the stored rows equal it. That also makes the function safe to call when nothing changed, which is what
 * lets the three writers call it unconditionally instead of each deciding whether it is needed.
 *
 * ## The two properties everything else depends on
 *
 * **The id is DERIVED.** `edgeIdFor` is a UUIDv5 over `(from, to, label, fromKind, toKind)`, so one
 * connection has exactly one id for ever. That is what makes a re-write a no-op instead of a duplicate, and
 * what lets the conversion script run twice over a space without recording whether it already has.
 *
 * **A removal writes a TOMBSTONE.** Without one, the next sync cycle pulls the link back from a peer that
 * still holds it — the delete would appear to work locally and undo itself within minutes. `TOMBSTONE_TYPES`
 * includes `link` for exactly this, and it is the reason that tuple exists rather than the knowledge one.
 */
import { col, asFilter, asDoc } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { nextSeq } from '../util/seq.js';
import { edgeIdFor } from './edge-id.js';
import { emitWebhookEvent, type WebhookActor } from '../webhooks/dispatcher.js';
import type { AuthorRef, LinkDoc, TombstoneDoc } from '../config/types.js';
// `RefKind` is re-exported by `types.ts` as a type only, so it comes from the leaf that DECLARES it —
// the same import every other `brain/` module that needs it uses.
import type { RefKind } from '../config/types-knowledge.js';

/**
 * The array field a link of this kind came from — `entity` → `entityIds`.
 *
 * Derived rather than mapped, because the three names are the same word plus `Ids` and a three-entry map
 * would be a second place to state a rule the vocabulary already implies.
 */
const fieldFor = (toKind: RefKind): string => `${toKind}Ids`;

/**
 * The label a link carries in a traverse result — DERIVED, never stored.
 *
 * `LINK_CLASSES` prints `memory.entityIds`, `chrono.entityIds` and `file.entityIds` today, and the three
 * classes with no reader yet extend the same pattern. Deriving it here means the label a reader shows and
 * the id a writer computes come from one expression: store it and the two can disagree, which is the defect
 * shape this migration exists to remove rather than to reproduce.
 */
export const linkLabel = (fromKind: RefKind, toKind: RefKind): string => `${fromKind}.${fieldFor(toKind)}`;

/** The id one connection always has. Exported so the conversion script derives it the same way. */
export const linkIdFor = (from: string, fromKind: RefKind, to: string, toKind: RefKind): string =>
  edgeIdFor(from, to, linkLabel(fromKind, toKind), fromKind, toKind);

/** What a record says it concerns, by the kind of thing concerned. Absent means "leave that class alone". */
export type DesiredLinks = Partial<Record<RefKind, readonly string[]>>;

/**
 * Make the link records for one record equal what its arrays now say.
 *
 * `desired` names only the classes the caller wrote. A class it omits is left alone entirely — which is the
 * distinction a `PATCH` needs, because omitting `memoryIds` means "leave the memory links" and not "remove
 * them". An empty array is the opposite and does mean remove: that is the caller having written `[]`.
 *
 * Returns how many rows were added and removed, so a caller can log it and the conversion script can report
 * progress without counting the collection twice.
 */
export async function reconcileLinks(
  spaceId: string,
  from: string,
  fromKind: RefKind,
  desired: DesiredLinks,
  author: AuthorRef,
): Promise<{ added: number; removed: number }> {
  const classes = Object.keys(desired) as RefKind[];
  if (classes.length === 0) return { added: 0, removed: 0 };

  const wanted = new Map<string, { to: string; toKind: RefKind }>();
  for (const toKind of classes) {
    for (const to of desired[toKind] ?? []) {
      // A record naming the same id twice in one array is one connection, not two — the Map dedupes it by
      // the derived id, so a caller's duplicate cannot produce a duplicate row.
      wanted.set(linkIdFor(from, fromKind, to, toKind), { to, toKind });
    }
  }

  // Only the classes this write TOUCHED. A `PATCH` that names `entityIds` alone must not disturb the memory
  // links, so the existing set is read per class rather than per `from`.
  const existing = await col<LinkDoc>(`${spaceId}_links`)
    .find(asFilter<LinkDoc>({ spaceId, from, fromKind, toKind: { $in: classes } }), { projection: { _id: 1 } })
    .toArray() as Array<{ _id: string }>;

  const now = new Date().toISOString();
  const instanceId = getConfig().instanceId;
  let added = 0;
  let removed = 0;

  for (const { _id } of existing) {
    if (wanted.has(_id)) continue;
    const seq = await nextSeq(spaceId);
    await col<LinkDoc>(`${spaceId}_links`).deleteOne(asFilter<LinkDoc>({ _id, spaceId }));
    // The tombstone is not optional. A link deleted without one comes back on the next pull from any peer
    // that still holds it, so the removal would undo itself and nothing would report that it had.
    const tombstone: TombstoneDoc = { _id, type: 'link', spaceId, deletedAt: now, instanceId, seq };
    await col<TombstoneDoc>(`${spaceId}_tombstones`).replaceOne(
      asFilter<TombstoneDoc>({ _id }), asDoc<TombstoneDoc>(tombstone), { upsert: true },
    );
    removed++;
  }

  const have = new Set(existing.map(e => e._id));
  for (const [_id, { to, toKind }] of wanted) {
    if (have.has(_id)) continue;
    const seq = await nextSeq(spaceId);
    // A seq PER RECORD, not one for the batch. `pageBySeq` continues from the last item's seq with
    // `seq > since`, so two rows sharing a seq at a page boundary would leave the rest of that group
    // unreachable — the cursor would step straight over them.
    const doc: LinkDoc = { _id, spaceId, from, fromKind, to, toKind, author, createdAt: now, updatedAt: now, seq };
    await col<LinkDoc>(`${spaceId}_links`).replaceOne(
      asFilter<LinkDoc>({ _id, spaceId }), asDoc<LinkDoc>(doc), { upsert: true },
    );
    // A re-created link clears the tombstone that retired it, or the next pull would delete it again on the
    // strength of a deletion the caller has since reversed.
    await col<TombstoneDoc>(`${spaceId}_tombstones`).deleteOne(asFilter<TombstoneDoc>({ _id }));
    added++;
  }

  return { added, removed };
}

/**
 * Remove every link record a deleted record was the FROM of.
 *
 * The other half of the cascade, and the one that is easy to forget: deleting a memory leaves its links to
 * entities describing a connection whose subject no longer exists. Links pointing AT the deleted record are
 * a different question and belong to the readers' slice — a dangling `to` is what `strictLinkage` already
 * refuses to create, and removing them here would silently delete another record's data.
 */
export async function removeLinksFrom(spaceId: string, from: string, fromKind: RefKind): Promise<number> {
  return (await reconcileLinks(spaceId, from, fromKind, allClassesEmpty(fromKind), NO_AUTHOR)).removed;
}

/** Every class a record of this kind can hold, each set to empty — "remove all of this record's links". */
function allClassesEmpty(fromKind: RefKind): DesiredLinks {
  const out: DesiredLinks = {};
  for (const toKind of CLASSES_BY_FROM[fromKind] ?? []) out[toKind] = [];
  return out;
}

/**
 * Which classes each record kind can hold — the six, keyed by the FROM side.
 *
 * Written out because it is a product fact rather than a derivable one: a memory names entities and nothing
 * else, a chrono entry names entities and memories, a file names all three. An entity is only ever a `to`.
 */
const CLASSES_BY_FROM: Partial<Record<RefKind, readonly RefKind[]>> = {
  fact: ['entity'],
  chrono: ['entity', 'fact'],
  file: ['entity', 'fact', 'chrono'],
};

/** A removal has no author to attribute; the tombstone carries the instance id instead. */
const NO_AUTHOR: AuthorRef = { instanceId: '', instanceLabel: '' };

/**
 * Which collections hold link arrays, and what kind their records are on the FROM side.
 *
 * Three and not five: an entity is only ever a `to`, and an edge names its endpoints through `from`/`to`
 * rather than through an array. Keyed by collection SUFFIX because the sync engine has only a collection
 * name in scope when it needs this.
 */
export const LINK_BEARING_COLLECTIONS: Record<string, RefKind | undefined> = {
  facts: 'fact',
  chrono: 'chrono',
  files: 'file',
};

/**
 * What one record's array for a class says RIGHT NOW — the input both halves of the door reconcile against.
 *
 * Read back rather than computed from what was just written, and shared by the two rather than written
 * twice. A record deleted between the update and this read leaves no array, and an empty class is then the
 * correct end state and not a guess: those links have no subject any more.
 */
async function sourceDoc(spaceId: string, suffix: string, id: string): Promise<Record<string, unknown> | null> {
  return await col(`${spaceId}_${suffix}`).findOne(asFilter({ _id: id, spaceId })) as Record<string, unknown> | null;
}

/** One class's array off a source document — absent or non-array reads as empty. */
const idsOn = (doc: Record<string, unknown> | null, toKind: RefKind): string[] => {
  const raw = doc?.[fieldFor(toKind)];
  return Array.isArray(raw) ? raw as string[] : [];
};

/**
 * Tell a subscriber the RECORD changed, because it did — its array gained or lost an id.
 *
 * The door writes the array with an `updateOne` rather than through `updateMemory` and its two counterparts,
 * so nothing below it fires the event those writers fire. Left out, a link added through this door would be
 * invisible to a subscriber that hears about every other way the same field is written — one change, two
 * paths, and only one of them reported.
 *
 * `memory`, `chrono` and `file` are exactly the three FROM kinds, and `<kind>.updated` is a real event name
 * for each. An entity is only ever a `to`, so there is no fourth case to miss.
 */
function emitRecordUpdated(spaceId: string, fromKind: RefKind, id: string, actor?: WebhookActor): void {
  if (!actor) return;
  emitWebhookEvent({ event: `${fromKind}.updated`, spaceId, entry: { _id: id }, ...actor });
}

/** The collection a record of this kind lives in — `LINK_BEARING_COLLECTIONS` read the other way round. */
const COLLECTION_OF = Object.fromEntries(
  Object.entries(LINK_BEARING_COLLECTIONS).map(([suffix, kind]) => [kind, suffix]),
) as Partial<Record<RefKind, string>>;

/**
 * The six, as pairs. Same table as `CLASSES_BY_FROM`, flattened for a caller that has one pair in hand.
 *
 * Derived and not written out, because a door validating against its own copy of the six is the second
 * implementation of a rule this module already states — and the direction it would fail in is the quiet one:
 * a pair the door accepted and no array can hold produces a row that the next reconcile deletes.
 */
export const LINK_PAIRS: readonly (readonly [RefKind, RefKind])[] = Object.entries(CLASSES_BY_FROM)
  .flatMap(([from, tos]) => (tos ?? []).map(to => [from as RefKind, to] as const));

/**
 * Add ONE link — by writing the array entry, and letting the ordinary reconcile derive the row.
 *
 * ## Why it does not just insert the row
 *
 * Because the row would not survive. `reconcileLinks` makes the stored rows equal what the arrays say, so a
 * row the array never claimed is deleted by the next ordinary write to that record — an unrelated PATCH of a
 * memory's `fact`, hours later, by somebody who has never heard of this link. The insert succeeds, the edit
 * succeeds, and the link is gone with nothing in between reporting anything.
 *
 * So the array is written first and the row is derived from it, which also means this door cannot disagree
 * with the six writers about what a link record looks like. It is the caller most tempted to bypass
 * `reconcileLinks` — it knows exactly which row it wants — and therefore the one that must not.
 *
 * The arrays stay for the whole transition: a peer on an older build understands nothing else, which is why
 * the conversion script may not delete them either.
 */
export async function addLink(
  spaceId: string,
  from: string,
  fromKind: RefKind,
  to: string,
  toKind: RefKind,
  actor?: WebhookActor,
): Promise<LinkDoc> {
  const suffix = COLLECTION_OF[fromKind];
  if (!suffix || !(CLASSES_BY_FROM[fromKind] ?? []).includes(toKind)) {
    throw new Error(`${fromKind} records cannot link to ${toKind}: there is no ${linkLabel(fromKind, toKind)} field`);
  }

  const seq = await nextSeq(spaceId);
  const res = await col(`${spaceId}_${suffix}`).updateOne(
    asFilter({ _id: from, spaceId }),
    { $addToSet: { [fieldFor(toKind)]: to }, $set: { seq, updatedAt: new Date().toISOString() } },
  );
  // `matchedCount`, not `modifiedCount`: re-adding a link that is already there matches and modifies
  // nothing, and that is a successful idempotent call rather than a missing record.
  if (res.matchedCount === 0) throw new Error(`${fromKind} '${from}' not found`);

  const doc = await sourceDoc(spaceId, suffix, from);
  // The link's author is the SOURCE RECORD's, not the caller's — the same value the six writers pass. A
  // link belongs to the record that claims it, and a door that stamped itself instead would give one
  // connection two different authors depending on which way it happened to be created.
  await reconcileLinks(spaceId, from, fromKind, { [toKind]: idsOn(doc, toKind) }, (doc?.['author'] as AuthorRef) ?? NO_AUTHOR);
  emitRecordUpdated(spaceId, fromKind, from, actor);

  const link = await col<LinkDoc>(`${spaceId}_links`)
    .findOne(asFilter<LinkDoc>({ _id: linkIdFor(from, fromKind, to, toKind), spaceId }));
  if (!link) throw new Error(`link ${linkIdFor(from, fromKind, to, toKind)} was not created`);
  return link as LinkDoc;
}

/**
 * Remove ONE link by its id — the same way round, through the array.
 *
 * The id is enough on its own: it is derived from the connection, so the stored row is where the four parts
 * of it are read back from. `false` means no such link, which is the honest answer to a delete of something
 * that is not there and is what lets a caller answer 404 without a second read.
 */
export async function removeLink(spaceId: string, id: string, actor?: WebhookActor): Promise<boolean> {
  /*
   * The seq is claimed BEFORE the row is read, so nothing is awaited between learning which array this link
   * names and writing to it. Read first and the `nextSeq` round trip is a window a concurrent writer's
   * change lands in — `no-read-modify-write.test.js` is what asks for this, and it is right to: the values
   * taken off the row are what the write is aimed at, so a stale read aims it somewhere else.
   *
   * A seq spent on an id that turns out not to be a link is a gap in a monotonic counter and costs nothing;
   * sync compares seqs, it does not count them.
   */
  const seq = await nextSeq(spaceId);
  const link = await col<LinkDoc>(`${spaceId}_links`).findOne(asFilter<LinkDoc>({ _id: id, spaceId }));
  if (!link) return false;

  const suffix = COLLECTION_OF[link.fromKind];
  if (!suffix) return false;

  await col(`${spaceId}_${suffix}`).updateOne(
    asFilter({ _id: link.from, spaceId }),
    { $pull: { [fieldFor(link.toKind)]: link.to }, $set: { seq, updatedAt: new Date().toISOString() } },
  );

  const doc = await sourceDoc(spaceId, suffix, link.from);
  await reconcileLinks(spaceId, link.from, link.fromKind, { [link.toKind]: idsOn(doc, link.toKind) }, link.author);
  emitRecordUpdated(spaceId, link.fromKind, link.from, actor);
  return true;
}

/**
 * Reconcile one WHOLE DOCUMENT's links — for the paths that replace a record rather than update fields.
 *
 * Three callers, and they are the three that bypass the writer functions entirely: a record pushed by a
 * peer, a record pulled from one, and the admin importer. Each has a complete document in hand and no idea
 * which fields moved, so the arrays it carries ARE the desired state.
 *
 * Extracted because the first version of this was written twice — once in the ingest router and once in the
 * sync engine's pull applier — and the god-file ratchet on `engine.ts` is what caught it. Two copies of
 * 'read the three arrays off a document and reconcile' is the same defect this whole migration exists to
 * remove, arriving in the code that removes it.
 *
 * A class the document does not carry is left ALONE rather than emptied: a peer on an older build may send
 * a record with no `chronoIds` key at all, and reading that as 'remove the chrono links' would delete data
 * on the strength of a field the sender never had.
 */
export async function reconcileLinksForDocument(
  spaceId: string,
  docId: string,
  fromKind: RefKind,
  doc: Record<string, unknown>,
): Promise<void> {
  const ids = (k: string) => (Array.isArray(doc[k]) ? doc[k] as string[] : undefined);
  const desired: DesiredLinks = {
    ...(ids('entityIds') !== undefined ? { entity: ids('entityIds')! } : {}),
    ...(ids('memoryIds') !== undefined ? { fact: ids('memoryIds')! } : {}),
    ...(ids('chronoIds') !== undefined ? { chrono: ids('chronoIds')! } : {}),
  };
  if (Object.keys(desired).length === 0) return;
  const author = doc['author'] as AuthorRef | undefined;
  await reconcileLinks(spaceId, docId, fromKind, desired, author ?? NO_AUTHOR);
}

/**
 * Reconcile a whole PAGE of documents that arrived for one collection, or do nothing if it holds no links.
 *
 * The sync engine's pull applier is handed a collection NAME and a batch, and has no record kind in scope.
 * Deciding here rather than there keeps the collection-to-kind question in this module with everything else
 * about links — and keeps the caller to one line, which is what the god-file ratchet on that file asked for
 * when the first version of this put ten lines and a lookup table into it.
 */
export async function reconcileLinksForPage(
  spaceId: string,
  collectionSuffix: string,
  docs: readonly { _id: string }[],
): Promise<void> {
  const fromKind = LINK_BEARING_COLLECTIONS[collectionSuffix];
  if (!fromKind) return;
  for (const doc of docs) {
    await reconcileLinksForDocument(spaceId, doc._id, fromKind, doc as unknown as Record<string, unknown>);
  }
}
