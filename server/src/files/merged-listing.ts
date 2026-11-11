import { toDocId } from '../util/paths.js';
import { type FileEntry } from './files.js';
import { fetchJobProgress } from './media/job-queue.js';
import { col, asFilter } from '../db/mongo.js';
import type { FileMetaDoc } from '../config/types.js';
import { LIVE_FILE_ROW } from './live-file-row.js';
import { spaceCollection } from '../db/space-collection.js';
import { metadataReadFailed, type MetadataReadFailure } from './metadata-read-failure.js';

// ── Merged file listing: join filesystem entries with their FileMeta records ──────────────────────
// Folders get a recursive content size; files get their embedding status + tags. Both come from ONE
// indexed prefix query per member over the `{space}_files` records (chunk/derived records carry a
// `parentFileId` and are excluded; soft-deleted records excluded). The roll-up is pure JS (unicode-safe,
// unlike Mongo `$substr` byte offsets). It left `api/files.ts` (a frozen god-file) when the listing began to report a
// failed read (Q-341): the listing's own concern, with its own failure words.

/** A file-level FileMeta row projected for the merged listing: path, raw size, and the bits the UI
 *  shows per file (embedding status, tags). */
interface FileMetaRow { _id?: string; path: string; sizeBytes?: number; embeddingStatus?: FileEntry['embeddingStatus']; tags?: string[] }

/**
 * What the roll-up records per file sitting directly in the listed directory.
 *
 * `id` and `memberId` are carried so the live-stage lookup can find the file's job afterwards: a media
 * job's `_id` IS the file record's `_id`, and jobs live in the MEMBER space's collection — a proxy
 * space's listing merges several members, so the id alone would not say which collection to ask.
 */
interface DirFileMeta {
  embeddingStatus?: FileEntry['embeddingStatus'];
  tags?: string[];
  id?: string;
  memberId?: string;
}

/** Statuses worth a progress lookup. Anything else is finished and has nothing left to draw. */
const IN_FLIGHT = new Set(['pending', 'processing']);

/**
 * Pure roll-up over the file-level records under a directory: sums each file's `sizeBytes` into the
 * IMMEDIATE sub-folder it lives under (nested files roll up), and — for files sitting DIRECTLY in the
 * listed directory — records their metadata (status, tags) keyed by name. A loose file belongs to no
 * sub-folder; a nested file's metadata belongs to a deeper listing, not this one. Exported for testing;
 * accumulates into the given maps so callers can merge across member spaces.
 */
export function rollUpDirRows(
  rows: FileMetaRow[], prefix: string,
  folderSizes = new Map<string, number>(),
  fileMeta = new Map<string, DirFileMeta>(),
  memberId?: string,
): { folderSizes: Map<string, number>; fileMeta: Map<string, DirFileMeta> } {
  for (const r of rows) {
    const rel = prefix ? r.path.slice(prefix.length) : r.path;
    const slash = rel.indexOf('/');
    if (slash > 0) {
      // Nested → contributes to the immediate sub-folder's size.
      const child = rel.slice(0, slash);
      folderSizes.set(child, (folderSizes.get(child) ?? 0) + (r.sizeBytes ?? 0));
    } else if (slash === -1 && rel) {
      // A file sitting directly in the listed directory → carry its metadata onto the row.
      if (!fileMeta.has(rel)) {
        fileMeta.set(rel, {
          embeddingStatus: r.embeddingStatus, tags: r.tags,
          ...(r._id ? { id: r._id } : {}), ...(memberId ? { memberId } : {}),
        });
      }
    }
  }
  return { folderSizes, fileMeta };
}

/**
 * The stored-path prefix for a directory listing — `''` for the root, `reports/` for a sub-folder.
 *
 * Pure and exported because getting it wrong fails SILENTLY and completely: file records store their path
 * with no leading slash (`notes.txt`), so a prefix of `/` makes the indexed range `['/', '/￿')` match
 * nothing at all. The listing still returns every file — the filesystem walk is a separate thing — they
 * just arrive with no status, no tags and no folder sizes, which reads as "nothing has been processed yet"
 * rather than as a bug.
 *
 * That is exactly what happened: the caller compared the RAW path against `'.'`, but the client asks for
 * the root as `/`. `toDocId('/')` is `''`, so the old expression produced `'' + '/'` — the broken prefix —
 * for every root listing, which is most listings. Normalise FIRST, then decide if it is the root.
 */
export function dirPrefix(dirPath: string): string {
  const docPath = toDocId(dirPath).replace(/\/+$/, '');
  return docPath === '' || docPath === '.' ? '' : docPath + '/';
}

/**
 * The roll-up over every member's records, and the reasons for the members whose records could not be read: a member that failed is listed
 * without its metadata and its reason (`metadataReadFailed`, logged once per window per space) is returned for the answer. A member with no
 * file records is no failure: a find on a missing collection answers nothing and does not throw, so a throw is always a real one.
 */
async function dirAggregates(memberIds: string[], dirPath: string): Promise<ReturnType<typeof rollUpDirRows> & { metadataIncomplete: MetadataReadFailure[] }> {
  const prefix = dirPrefix(dirPath);
  const folderSizes = new Map<string, number>();
  const fileMeta = new Map<string, DirFileMeta>();
  const failed = new Set<MetadataReadFailure>();
  for (const mid of memberIds) {
    try {
      const rows = await col<FileMetaDoc>(spaceCollection(mid, 'files')).find(
        asFilter<FileMetaDoc>({
          ...LIVE_FILE_ROW,
          // Indexed prefix range over `path` — files under this directory only (all files when root).
          // '￿' is the highest BMP code unit, so `[prefix, prefix+￿)` covers every path with
          // this prefix without a regex.
          ...(prefix ? { path: { $gte: prefix, $lt: prefix + '￿' } } : {}),
        }),
        { projection: { _id: 1, path: 1, sizeBytes: 1, embeddingStatus: 1, tags: 1 } },
      ).toArray() as FileMetaRow[];
      rollUpDirRows(rows, prefix, folderSizes, fileMeta, mid);
    } catch (err) {
      failed.add(metadataReadFailed(mid, err));
    }
  }
  return { folderSizes, fileMeta, metadataIncomplete: [...failed] };
}

/**
 * Attach the live stage to the files that HAVE one.
 *
 * Only in-flight files are looked up, and only the member spaces that actually contain one are queried:
 * a listing of finished files — which is most listings — issues no query at all, and a proxy space with
 * five members does not pay five round trips to decorate two files. The lookup is grouped by member
 * because a media job lives in its own space's collection and its `_id` is the file record's `_id`.
 *
 * Best-effort, like the heartbeat that writes the data: a failed lookup simply leaves the rows
 * undecorated and the UI falls back to the status pill. A progress bar is not worth failing a listing over.
 *
 * `lookup` is injectable so a test can observe WHICH members were queried with WHICH ids — asserting on
 * the decorated rows alone cannot tell "skipped the query" from "queried and got nothing back", and
 * skipping it for finished files is the whole point.
 */
export async function attachLiveStage(
  entries: FileEntry[],
  fileMeta: Map<string, DirFileMeta>,
  lookup: typeof fetchJobProgress = fetchJobProgress,
): Promise<void> {
  const byMember = new Map<string, Array<{ entry: FileEntry; id: string }>>();
  for (const e of entries) {
    if (e.type === 'dir' || !IN_FLIGHT.has(String(e.embeddingStatus ?? ''))) continue;
    const m = fileMeta.get(e.name);
    if (!m?.id || !m.memberId) continue;
    const list = byMember.get(m.memberId) ?? [];
    list.push({ entry: e, id: m.id });
    byMember.set(m.memberId, list);
  }
  if (byMember.size === 0) return;

  await Promise.all([...byMember].map(async ([mid, items]) => {
    try {
      const progressById = await lookup(mid, items.map(i => i.id));
      for (const { entry, id } of items) {
        const view = progressById.get(id);
        // A claimed job that has not reported its first step yet adds nothing — leaving the field absent
        // keeps "we do not know yet" distinct from "the route has no steps".
        if (!view?.progress) continue;
        entry.progress = view.progress;
        entry.progressAt = view.progressAt;
      }
    } catch {
      // One member's jobs collection being unreachable must not lose the OTHER members' rows, and must
      // never fail the listing. `fetchJobProgress` already swallows its own errors; this covers the rest.
    }
  }));
}

/** A listing's entries with the metadata the member spaces' records add, and the reasons for the members whose records could not be read (empty: none failed). */
export interface EnrichedListing { entries: FileEntry[]; metadataIncomplete: MetadataReadFailure[] }

/**
 * Enrich a directory listing from the FileMeta records in one query per member: directories get their
 * recursive content `size`, files get their `embeddingStatus` + `tags` — the merged filesystem +
 * metadata rows the Files list renders — plus the live processing stage for anything still in flight.
 * A member whose records could not be read leaves its files bare and is named in `metadataIncomplete`.
 */
export async function enrichEntries(memberIds: string[], dirPath: string, entries: FileEntry[]): Promise<EnrichedListing> {
  if (entries.length === 0) return { entries, metadataIncomplete: [] };
  const { folderSizes, fileMeta, metadataIncomplete } = await dirAggregates(memberIds, dirPath);
  for (const e of entries) {
    if (e.type === 'dir') {
      e.size = folderSizes.get(e.name) ?? 0;
    } else {
      const m = fileMeta.get(e.name);
      if (m) { e.embeddingStatus = m.embeddingStatus; e.tags = m.tags; }
    }
  }
  await attachLiveStage(entries, fileMeta);
  return { entries, metadataIncomplete };
}

/**
 * The body of a directory listing: its path, its entries, and `metadataIncomplete` only when a member's records could not be read (absent
 * otherwise, as `usageIncomplete` is). The one place the body is built, so no listing branch can answer a failed read as a whole listing.
 */
export function listingBody(path: string, listing: EnrichedListing): { path: string; type: 'dir'; entries: FileEntry[]; metadataIncomplete?: MetadataReadFailure[] } {
  return {
    path, type: 'dir', entries: listing.entries,
    ...(listing.metadataIncomplete.length > 0 ? { metadataIncomplete: listing.metadataIncomplete } : {}),
  };
}
