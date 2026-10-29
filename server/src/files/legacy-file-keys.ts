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
 * **Lazy, never at boot.** Synced data is not migrated at start. The first WRITING door that needs a file's row id for a space asks `fileRowIdFor`
 * (`files/file-meta.ts`), which adopts the row at its key: ONE read of the space's live top-level file rows whose id is not canonical (built once per
 * process and space, empty when there are none, which costs nothing afterwards), then the row is re-keyed in one transaction. A networked space
 * converges on its first sync cycle (`adoptAllLegacyRows`, called where the cycle reads its rows) and an un-networked one on first touch. A door that
 * only READS a file's row asks {@link legacyIdsOf} and finds it where it is: a token holding only a read right never causes a write.
 *
 * **My instance = my data.** A re-key writes NO tombstone, deletes nothing a peer holds and decides nothing for another instance: it moves THIS
 * instance's row onto its key, keeping its version, author, creation time and metadata, and takes a fresh landing position of this instance's own
 * stream, which is how the row reaches peers (as an arrival moves no counter). When a row already stands at the key the higher version wins (equal:
 * the one at the key); when a held tombstone shadows the legacy row's version it is removed here, as an arrival it would shadow is refused. **The
 * links are this instance's rows too, and are handled the same way: no tombstone of any kind, links included.** A legacy row whose data survives has
 * every link carried to its key under the author that wrote it (`carryLinksToKey`), nothing the key held is removed, and one that loses or is shadowed
 * has its link rows removed from this instance's own collection (`dropLinkRowsLocally`) and nobody is told.
 *
 * **This module is the cheap half: the index and the entry points.** The re-key itself is `files/legacy-file-rekey.ts`, loaded on the first row that
 * needs it (a dynamic import, as `file-meta.ts` loads its own heavy neighbours): it reaches the tombstones, the derived rows, the jobs and the links, which
 * all read `file-meta.ts`, so a static import here would put every door of the file rows in one import cycle.
 *
 * A failure is said once per window (`reportSpaceFailure`) and leaves the row where it was: the next touch tries again. The index is forgotten when
 * a restore or an import can have brought old ids back (`forgetLegacyIndex`).
 */
import { eachIdPage } from '../db/id-keyset-page.js';
import { READ_CHUNK } from '../db/read-by-id.js';
import { spaceCollection } from '../db/space-collection.js';
import { boundOperationMs } from '../db/write-bound.js';
import { listReadMaxMs } from '../brain/tag-filter.js';
import { toDocId } from '../util/paths.js';
import { reportSpaceFailure } from '../util/space-failure.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { isActRefusal } from '../spaces/space-write-gate.js';
import { LIVE_FILE_ROW } from './live-file-row.js';

const REKEY_STEP = declareStep('Legacy file row re-key');
const INDEX_STEP = declareStep('Legacy file row index');

/**
 * The ids a pre-bundle-71 spelling can have, as one regular expression for the store to prefilter by: an empty segment, a `.` or `..` segment, a
 * leading slash, a backslash, a combining mark (what a decomposed name is made of) or a Hangul jamo (what a decomposed Hangul syllable is made of).
 * A hit is kept only when `toDocId` really changes it, so the prefilter may be wider than the answer; the characters are written as characters, not
 * as escapes, because the store's pattern language has no unicode escape.
 */
const LEGACY_ID_CANDIDATE = '//|(^|/)\\.\\.?(/|$)|^/|\\\\|['
  + [[0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f], [0x3099, 0x309a], [0x1100, 0x11ff]]
    .map(([a, b]) => `${String.fromCodePoint(a!)}-${String.fromCodePoint(b!)}`).join('')
  + ']';

/** Per space: the key of each live top-level file row whose id is not its own key, and the ids stored under it. Built once, on the first need. */
const indexes = new Map<string, Promise<Map<string, string[]>>>();

async function legacyIndexOf(spaceId: string): Promise<Map<string, string[]>> {
  let built = indexes.get(spaceId);
  if (built === undefined) {
    built = (async () => {
      const index = new Map<string, string[]>();
      // A page at a time (`eachIdPage`): the candidates are few, but the read is of every id of the space's rows and its answer is never unbounded.
      await eachIdPage<{ _id: string }>(
        { collection: spaceCollection(spaceId, 'files'), filter: { _id: { $regex: LEGACY_ID_CANDIDATE }, ...LIVE_FILE_ROW }, projection: { _id: 1 }, size: READ_CHUNK,
          // Inside a walk's scope (the sync cycle) the scope bounds each page; a request has none, so the page carries a SERVER deadline of its own. A scope opened
          // here instead puts the driver's `timeoutMS` on the read, which a store that fails fast is retried against for the whole bound: a request that takes
          // thirty seconds to answer 503 (`a-store-failure-answers-alike-on-every-door-db`).
          ...(boundOperationMs() === undefined ? { maxTimeMS: listReadMaxMs(false) } : {}) },
        async rows => {
          for (const { _id } of rows) {
            const id = String(_id);
            const key = toDocId(id);
            if (key === id || key === '') continue;
            const at = index.get(key);
            if (at) at.push(id); else index.set(key, [id]);
          }
        },
      );
      return index;
    })();
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

/** The ids a row of `key` is stored under while it is at a legacy spelling (empty when none): a READ, for a door that must never write. */
export async function legacyIdsOf(spaceId: string, key: string): Promise<readonly string[]> {
  return (await legacyIndexOf(spaceId)).get(key) ?? [];
}

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
  const { rekeyLegacy } = await import('./legacy-file-rekey.js');
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
