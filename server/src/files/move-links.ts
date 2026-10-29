/**
 * The links of a file that moves — carried to the new path in an order that never leaves the file linkless.
 *
 * ## The question it answers
 *
 * *"A file's links hang off its path, and a link has no rename: how do they follow a move so that, whatever fails, the file is
 * linked at the old path or the new one (never at neither) and the new path is never linked to what its previous occupant was?"*
 * A link's id is derived from its `from`, so a move is a delete and a create. Done as remove-at-the-old-path then add-at-the-new-one,
 * after the record had moved, a failure between the two would lose the links with nothing to retry them.
 *
 * ## The order, and why each step is where it is
 *
 *  1. **{@link convergeLinks} BEFORE the rows move**: the new path's link set is made EQUAL to the old path's — non-additive, so a
 *     previous occupant's links go (a file never inherits the people, facts and chrono its predecessor at that path was linked to,
 *     which face auto-labelling reads), and an old path with no links leaves the new one linked to nothing. A target that no longer
 *     exists is dropped first, where the space is strict about linkage: the reconcile asks every target to exist there, and a
 *     dangling link must not fail a move or be carried across it. A link at the new path before its record is there is accepted.
 *  2. **The transaction that moves the rows** (the cascade's).
 *  3. **{@link retireLinks} AFTER it commits**: the old path's links are removed, with the tombstones that stop a peer restoring them.
 *
 * A failure at 1 or 2 leaves the links at the old path; at 3, at both. Every step is a reconcile to a stated end state, so a retry
 * of any of them is the same call.
 *
 * ## An abandoned move
 *
 * A move can be given up half-way: the bytes at the new path were replaced by an unrelated file before its remaining batches ran.
 * What step 1 put at the new path then describes a file that is not there. {@link removeConvergedLinks} takes exactly those links
 * back off, when the marker that would have finished the move is finally cleared.
 */
import { reconcileLinkRows } from '../brain/write-plan/commit.js';
import { linkClassesFrom, linksStartingFrom, type LinkEnd } from '../brain/link-adjacency.js';
import { removeLinksFromMany } from '../brain/links.js';
import { missingRefs } from '../brain/entity-refs.js';
import { isStrictLinkage } from '../spaces/space-lookup.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { admitSpaceWrite } from '../spaces/space-write-gate.js';
import { inChunks } from '../util/chunks.js';
import { authorRef } from '../config/author.js';
import type { RefKind } from '../config/types-knowledge.js';
import type { AuthorRef, LinkDoc } from '../config/types.js';

/** A file whose links move: its id now and the id it is to have. */
export interface LinkMove { from: string; to: string }

/** The classes a file's links name: what the link table says a file can hold (`linkClassesFrom`), never a list of ours. */
const CLASSES: readonly RefKind[] = linkClassesFrom('file').map(c => c.toKind);
type Targets = Partial<Record<RefKind, string[]>>;

const emptyTargets = (): Targets => Object.fromEntries(CLASSES.map(cls => [cls, [] as string[]]));

/** The link rows starting from `ids`, by file: the targets of each, by class. Chunked. */
async function targetsOf(spaceId: string, ids: readonly string[]): Promise<Map<string, Targets>> {
  const out = new Map<string, Targets>();
  for (const part of inChunks([...ids], READ_CHUNK)) {
    for (const row of await linksStartingFrom(spaceId, part) as LinkEnd[]) {
      if (row.fromKind !== 'file' || !CLASSES.includes(row.toKind)) continue;
      let t = out.get(row.from);
      if (!t) { t = emptyTargets(); out.set(row.from, t); }
      (t[row.toKind] ??= []).push(row.to);
    }
  }
  return out;
}

/**
 * Where the space insists every target exists, drop from each entry the targets that have gone, in place: one read per class for the whole set.
 * What a carry of links asks before it writes them, so neither a move nor a re-key carries a dangling link across.
 */
async function withoutGoneTargets(spaceId: string, have: ReadonlyMap<string, Targets>): Promise<void> {
  if (!isStrictLinkage(spaceId)) return;
  for (const cls of CLASSES) {
    const all = [...new Set([...have.values()].flatMap(t => t[cls] ?? []))];
    if (all.length === 0) continue;
    const gone = new Set(await missingRefs(spaceId, cls, all));
    if (gone.size > 0) for (const t of have.values()) t[cls] = (t[cls] ?? []).filter(id => !gone.has(id));
  }
}

/** Make each file's links at its NEW id equal its links at the old one. Non-additive; see the module docblock, step 1. */
export async function convergeLinks(spaceId: string, moves: readonly LinkMove[]): Promise<void> {
  for (const part of inChunks([...moves], READ_CHUNK)) {
    const have = await targetsOf(spaceId, part.map(m => m.from));
    await withoutGoneTargets(spaceId, have);
    const authors = await readStoredById<{ author?: AuthorRef }>(spaceCollection(spaceId, 'files'), part.map(m => m.from), { author: 1 });
    await reconcileLinkRows(spaceId, part.map(m => ({
      from: m.to, fromKind: 'file' as RefKind, desired: have.get(m.from) ?? emptyTargets(),
      author: authors.get(m.from)?.author ?? authorRef(), minted: false,
    })));
  }
}

/** Remove every link the files had at their OLD ids, with the tombstones that tell peers. After the rows have moved (step 3). */
export async function retireLinks(spaceId: string, froms: readonly string[]): Promise<void> {
  await removeLinksFromMany(spaceId, froms, 'file');
}

/**
 * The links of a row that is put at its key without a user's act (the re-key of a legacy file row, Q-413), carried to the key and nothing
 * else: every link of the old id is ADDED at the new one under the author that wrote it, and nothing the key already holds is removed.
 *
 * ## What it prevents
 *
 * A re-key reached for the move's {@link convergeLinks}, whose end state ("the new path's links are EQUAL to the old path's") removes what the
 * key held, with a tombstone per link, and which stamps every link with the FILE's author. A re-key is housekeeping that repairs where THIS
 * instance keeps a row, so it must not decide what a peer holds (a tombstone does, and it travels): it removes nothing, and a link another
 * instance wrote stays that instance's, so the delete that removes "the links this instance wrote" still tells the two apart. A link that
 * carries no author was written here before authorship was stamped, and is carried as this instance's (`fileLinksThisInstanceWrote`).
 * Where the space insists every target exists, a link whose target has gone is not carried ({@link withoutGoneTargets}).
 */
export async function carryLinksToKey(spaceId: string, moves: readonly LinkMove[]): Promise<void> {
  for (const part of inChunks([...moves], READ_CHUNK)) {
    const rows = await col<LinkDoc>(spaceCollection(spaceId, 'links')).find(
      asFilter<LinkDoc>({ spaceId, fromKind: 'file', from: { $in: part.map(m => m.from) } }),
      { projection: { from: 1, to: 1, toKind: 1, author: 1 } },
    ).toArray() as Array<Pick<LinkDoc, 'from' | 'to' | 'toKind' | 'author'>>;
    const byAuthor = new Map<string, { to: string; author: AuthorRef; targets: Targets }>();
    for (const row of rows) {
      if (!CLASSES.includes(row.toKind)) continue;
      const to = part.find(m => m.from === row.from)!.to;
      const author = row.author ?? authorRef();
      const k = `${to}\u0000${author.instanceId}\u0000${author.instanceLabel}`;
      const group = byAuthor.get(k) ?? { to, author, targets: emptyTargets() };
      (group.targets[row.toKind] ??= []).push(row.to);
      byAuthor.set(k, group);
    }
    await withoutGoneTargets(spaceId, new Map([...byAuthor].map(([k, g]) => [k, g.targets])));
    if (byAuthor.size === 0) continue;
    await reconcileLinkRows(spaceId, [...byAuthor.values()].map(g => ({
      from: g.to, fromKind: 'file' as RefKind, desired: g.targets, author: g.author, minted: false,
    })), { additive: true });
  }
}

/**
 * Remove the link rows of old file ids from THIS instance's collection, with NO tombstone: what a re-key does with the links of a legacy row
 * that was carried (they are at the key now) or that did not survive (it lost to the row at its key, or a held tombstone shadows it).
 *
 * ## What it prevents
 *
 * {@link retireLinks} writes a tombstone per link, and a tombstone is an instruction to every peer: a re-key that retired through it told the
 * network to delete links another instance wrote, from housekeeping nobody asked for ("My instance = my data": nothing this instance does
 * decides what another holds). The rows are only where this instance kept them under an id no door reads any more. Only the rows FROM
 * the given ids go, and only file-sourced ones.
 */
export async function dropLinkRowsLocally(spaceId: string, froms: readonly string[]): Promise<void> {
  const links = col<LinkDoc>(spaceCollection(spaceId, 'links'));
  await admitSpaceWrite(spaceId, 'links', async () => {
    for (const part of inChunks([...froms], READ_CHUNK)) await links.deleteMany(asFilter<LinkDoc>({ spaceId, fromKind: 'file', from: { $in: part } }));
  });
}

/**
 * Take back off the NEW ids the links that {@link convergeLinks} put there: of each file's links at its new id, those that are also
 * links of its old id. Links the new id holds beyond them are not this move's, and stay.
 */
export async function removeConvergedLinks(spaceId: string, moves: readonly LinkMove[]): Promise<void> {
  for (const part of inChunks([...moves], READ_CHUNK)) {
    const carried = await targetsOf(spaceId, part.map(m => m.from));
    const now = await targetsOf(spaceId, part.map(m => m.to));
    const changes = part.flatMap(m => {
      const were = carried.get(m.from);
      const holds = now.get(m.to);
      if (!were || !holds) return [];
      const keep = emptyTargets();
      for (const cls of CLASSES) keep[cls] = (holds[cls] ?? []).filter(id => !(were[cls] ?? []).includes(id));
      return [{ from: m.to, fromKind: 'file' as RefKind, desired: keep, author: authorRef(), minted: false }];
    });
    if (changes.length > 0) await reconcileLinkRows(spaceId, changes);
  }
}
