/**
 * Which stored file row stands for this key under a spelling bundle-71 no longer writes, and put it at its key (Q-413).
 *
 * ## What it prevents
 *
 * Before bundle-71 a file row's id was the caller's text with its backslashes turned into slashes and its leading slashes cut: no Unicode
 * normalisation, no collapse of `//`, `.` and `..`. A file a macOS peer delivered, or one uploaded as `a//b` or `./a`, was stored under that
 * spelling. Since bundle-71 the id is the path's canonical key (`toDocId`), every lookup is made by it, and an upgraded peer refuses a row whose
 * `_id` is not the key of its path (`fileKeyRefusal`): the old row is invisible to every door here, refused for ever by every peer, and a
 * divergent leaf of the space hash. Nothing ever read it again, and nothing could repair it.
 *
 * ## The rule
 *
 * **Lazy, never at boot.** Synced data is not migrated at start. The first door that needs a file's row id for a space asks {@link fileRowIdFor}
 * (`files/file-meta.ts`), which adopts the row at its key: ONE read of the space's top-level file rows whose id is not canonical (built once per
 * process and space, empty when there are none, which costs nothing afterwards), then the row is re-keyed in one transaction. A networked space
 * converges on its first sync cycle (`adoptAllLegacyRows`, called where the cycle reads its rows) and an un-networked one on first touch.
 *
 * **My instance = my data.** A re-key writes NO tombstone, deletes nothing a peer holds and decides nothing for another instance: it moves THIS
 * instance's row onto its key, keeping its version, author, creation time and metadata, and takes a fresh landing position of this instance's own
 * stream, which is how the row reaches peers (as an arrival moves no counter). When a row already stands at the key the higher version wins (equal:
 * the one at the key); when a held tombstone shadows the legacy row's version it is removed here, as an arrival it would shadow is refused. Whatever
 * the row's old id derived (chunks, converted sidecar rows, jobs, links) is taken off it, and the file is queued for embedding again under the
 * receiver's own rules.
 *
 * A failure is said once per window (`reportSpaceFailure`) and leaves the row where it was: the next touch tries again. The index is forgotten when
 * a restore or an import can have brought old ids back (`forgetLegacyIndex`).
 */
import type { ClientSession } from 'mongodb';
import { col, asFilter } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { readStoredById, READ_CHUNK } from '../db/read-by-id.js';
import { withinWriteBound } from '../db/write-bound.js';
import { inHeldTransaction } from '../brain/held-transaction.js';
import { withLandingStamp, arrivalRow } from '../sync/record-position-stream.js';
import { assertSpaceTakesWrites, isActRefusal } from '../spaces/space-write-gate.js';
import { toDocId } from '../util/paths.js';
import { inChunks } from '../util/chunks.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { rekeyRows, StaleRekeyPlan } from './rekey-rows.js';
import { carryPathKeyedCache } from './path-keyed-cache.js';
import { decideArrivals } from './tombstones.js';
import { deleteRowsDerivedFrom, rowsOfFiles } from './derived-rows.js';
import { cancelJobsOwnedBy, cancelMediaJob } from './media/job-queue.js';
import { retireEmbedWorkOfRemovedRows } from './file-embed-work.js';
import { convergeLinks, retireLinks } from './move-links.js';
import { embedArrivedFiles } from '../sync/embed-arrived-files.js';
import type { FileMetaDoc } from '../config/types.js';

const REKEY_STEP = declareStep('Legacy file row re-key');
const INDEX_STEP = declareStep('Legacy file row index');

/**
 * The ids a pre-bundle-71 spelling can have, as one regular expression for the store to prefilter by: an empty segment, a `.` or `..` segment, a
 * leading slash, a backslash, a combining mark (what a decomposed name is made of) or a Hangul jamo (what a decomposed Hangul syllable is made of).
 * A hit is kept only when `toDocId` really changes it, so the prefilter may be wider than the answer; the characters are written as characters, not
 * as escapes, because the store's pattern language has no `\u`.
 */
const LEGACY_ID_CANDIDATE = '//|(^|/)\\.{1,2}(/|$)|^/|\\\\|['
  + [[0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f], [0x3099, 0x309a], [0x1100, 0x11ff]]
    .map(([a, b]) => `${String.fromCodePoint(a!)}-${String.fromCodePoint(b!)}`).join('')
  + ']';

/** Per space: the key of each stored top-level file row whose id is not its own key, and the ids stored under it. Built once, on the first need. */
const indexes = new Map<string, Promise<Map<string, string[]>>>();

/** The legacy ids of the space by the key they stand for: ONE read of the space's top-level rows whose id has a candidate shape, once per process. */
async function legacyIndexOf(spaceId: string): Promise<Map<string, string[]>> {
  let built = indexes.get(spaceId);
  if (built === undefined) {
    built = withinWriteBound(async () => {
      const rows = await col<{ _id: string }>(spaceCollection(spaceId, 'files')).find(
        asFilter<{ _id: string }>({ _id: { $regex: LEGACY_ID_CANDIDATE }, parentFileId: { $exists: false } } as never),
        { projection: { _id: 1 } },
      ).toArray();
      const index = new Map<string, string[]>();
      for (const { _id } of rows) {
        const id = String(_id);
        const key = toDocId(id);
        if (key === id || key === '') continue;
        const at = index.get(key);
        if (at) at.push(id); else index.set(key, [id]);
      }
      return index;
    });
    indexes.set(spaceId, built);
    // A read that failed is not cached: the next need asks again.
    built.catch((err: unknown) => { if (indexes.get(spaceId) === built) indexes.delete(spaceId); reportSpaceFailure(INDEX_STEP, spaceId, err, { when: 'next touch' }); });
  }
  return built.catch(() => new Map<string, string[]>());
}

/** Forget what was learned of a space's legacy ids: a restore or an import can bring old ids back (it does not refuse them as an arrival does), and a wipe removes them. */
export function forgetLegacyIndex(spaceId: string): void {
  indexes.delete(spaceId);
}

interface LegacyRow { seq?: number; author?: { instanceId?: string }; deliveredBy?: string }

/**
 * Put the row stored under a legacy spelling of `key` at `key` — see the module docblock. Resolves when done or when there is nothing to do; a
 * failure is said once per window and leaves the row where it is.
 */
export async function adoptLegacyRow(spaceId: string, key: string): Promise<void> {
  await adoptKeys(spaceId, (await legacyIndexOf(spaceId)).has(key) ? [key] : []);
}

/** {@link adoptLegacyRow} for every legacy row whose key is `dir` or under `dir/`. An empty `dir` is every row of the space. */
export async function adoptLegacyRowsUnder(spaceId: string, dir: string): Promise<void> {
  const norm = toDocId(dir).replace(/\/+$/, '');
  const index = await legacyIndexOf(spaceId);
  if (index.size === 0) return;
  await adoptKeys(spaceId, [...index.keys()].filter(k => norm === '' || k === norm || k.startsWith(`${norm}/`)));
}

/** {@link adoptLegacyRow} for every legacy row of the space: what the sync cycle does where it reads every top-level row. */
export async function adoptAllLegacyRows(spaceId: string): Promise<void> {
  await adoptLegacyRowsUnder(spaceId, '');
}

async function adoptKeys(spaceId: string, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const index = await legacyIndexOf(spaceId);
  for (const key of keys) {
    const ids = index.get(key);
    if (!ids || ids.length === 0) continue;
    try {
      await rekeyLegacy(spaceId, key, ids);
      index.delete(key);
    } catch (err) {
      // A space an act holds (a restore, a wipe) takes no write: the row waits, quietly, for the next touch.
      if (isActRefusal(err)) continue;
      reportSpaceFailure(REKEY_STEP, spaceId, err, { unit: key, when: 'next touch' });
    }
  }
}

/** The one legacy row of a key that is kept: the highest version, the smallest id on a tie. */
function bestLegacy(rows: ReadonlyMap<string, LegacyRow>, ids: readonly string[]): string | undefined {
  return [...ids].filter(id => rows.has(id)).sort((a, b) => (rows.get(b)!.seq ?? 0) - (rows.get(a)!.seq ?? 0) || (a < b ? -1 : 1))[0];
}

async function rekeyLegacy(spaceId: string, key: string, ids: readonly string[]): Promise<void> {
  assertSpaceTakesWrites(spaceId, 'files');
  const filesColl = spaceCollection(spaceId, 'files');
  const rows = await readStoredById<LegacyRow>(filesColl, [...ids, key], { seq: 1, author: 1, deliveredBy: 1 });
  const best = bestLegacy(rows, ids);
  const atKey = rows.get(key);
  if (best === undefined) return;   // gone since the index was read: another door adopted it
  const keep = rows.get(best)!;

  const shadowed = atKey !== undefined && (atKey.seq ?? 0) >= (keep.seq ?? 0) ? false : await isShadowed(spaceId, key, keep);
  const wins = !shadowed && (atKey === undefined || (keep.seq ?? 0) > (atKey.seq ?? 0));
  if (wins) {
    await inHeldTransaction(spaceId, 'file.rekey-legacy', async (session: ClientSession) => {
      await withLandingStamp(spaceId, [arrivalRow(keep.seq ?? 0)], async ([landing]) => {
        await rekeyRows<FileMetaDoc>(filesColl, session, {
          moves: [{ from: best, to: key }],
          rebuild: (row) => ({ ...row, _id: key, path: key, ...landing }),
          refuse: (to) => new StaleRekeyPlan(`a row appeared at '${to}' since the re-key was planned`),
          ...(atKey !== undefined ? { replacements: { replaced: [key] } } : {}),
        });
      }, 'file.rekey-legacy');
      await carryPathKeyedCache(spaceId, session, [{ from: best, to: key }]);
    });
  }
  // What the old ids still hold: a loser, a shadowed row, the rows the winner's old id derived. Taken off after the commit, so a failure leaves the row at its key.
  const leaving = wins ? ids.filter(id => id !== best) : [...ids];
  const gone = wins ? ids : [...ids];
  await removeWhatTheOldIdsHold(spaceId, gone, leaving, wins ? { from: best, to: key } : undefined);
  if (wins) await embedArrivedFiles(spaceId, [key]);
}

/** Whether a held file tombstone at `key` shadows a metadata arrival of this row's version: the question every arrival at the key is asked (`decideArrivals`). A path that cannot be looked at is thrown, and the row stays. */
async function isShadowed(spaceId: string, key: string, row: LegacyRow): Promise<boolean> {
  const verdict = await decideArrivals(spaceId, [{
    id: key, path: key, kind: 'meta', seq: row.seq ?? 0,
    ...(row.author?.instanceId !== undefined ? { author: row.author.instanceId } : {}),
    ...(row.deliveredBy !== undefined ? { deliveredBy: row.deliveredBy } : {}),
  }]);
  if (verdict.undecided.has(key)) throw verdict.cause ?? new Error(`a delete held for '${key}' cannot be looked at`);
  return verdict.shadowed.has(key);
}

/**
 * Take off the old ids what hung on them. `rows` are the old ids whose derived rows, jobs and links go; `remove` are the old ids whose own row is
 * removed (every one but the row that was re-keyed, which already left its id). Jobs first, as every remover revokes the claims before the rows.
 */
async function removeWhatTheOldIdsHold(spaceId: string, rows: readonly string[], remove: readonly string[], moved?: { from: string; to: string }): Promise<void> {
  for (const id of rows) {
    await cancelMediaJob(spaceId, id);
    await cancelJobsOwnedBy(spaceId, id, 'file');
  }
  const { ids, parents } = await rowsOfFiles(spaceId, rows, []);
  if (moved) await convergeLinks(spaceId, [moved]);
  await deleteRowsDerivedFrom(spaceId, parents);
  await retireEmbedWorkOfRemovedRows(spaceId, { ids: [...ids] });
  const coll = col<{ _id: string }>(spaceCollection(spaceId, 'files'));
  for (const part of inChunks([...remove], READ_CHUNK)) await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: part } }));
  await retireLinks(spaceId, rows);
}
